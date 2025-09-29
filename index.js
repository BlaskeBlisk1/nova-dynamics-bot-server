// ====== Imports & App Setup ======
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const app = express();
app.use(express.json());

const cors = require("cors");

const ALLOWED = [
  "https://prismatic-taffy-e96ac7.netlify.app", // Netlify site
  "https://nova-dynamics.no",                   // custom domain
  "https://www.nova-dynamics.no"                // www version
];

// helpful for caches/proxies
app.use((req, res, next) => { res.setHeader("Vary", "Origin"); next(); });

app.use(cors({
  origin(origin, cb) {
    if (!origin) return cb(null, true);                 // allow server-to-server / curl
    if (ALLOWED.includes(origin)) return cb(null, true);
    return cb(new Error("Not allowed by CORS"));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

// make sure preflight gets CORS headers
app.options("*", cors());


// ====== Helpers ======
function readJSON(filePath, fallback = []) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

// Accept [{q,a}] OR [{title,text}] and coerce to strings
function normalizeKB(raw) {
  return (raw || []).map(item => {
    if (item && item.q && item.a) return { q: String(item.q), a: String(item.a) };
    if (item && item.title && item.text) return { q: String(item.title), a: String(item.text) };
    return null;
  }).filter(Boolean);
}

// Simple keyword ranker
function rankFAQ(question, kb) {
  const qWords = new Set(
    String(question).toLowerCase().split(/[^a-z0-9æøåäöü\-]+/).filter(Boolean)
  );
  return kb
    .map(item => {
      const text = (item.q + " " + item.a).toLowerCase();
      const tWords = new Set(text.split(/[^a-z0-9æøåäöü\-]+/).filter(Boolean));
      let hits = 0; for (const w of qWords) if (tWords.has(w)) hits++;
      return { ...item, _score: hits };
    })
    .sort((a,b) => b._score - a._score);
}

// ====== Static Website (optional; okay to keep) ======
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ====== Config ======
const USE_OPENAI = true;                              // set to false for echo testing
const OPENAI_KEY = process.env.OPENAI_API_KEY;        // set in Render > Settings > Environment
const MODEL = "gpt-4o-mini";

// ====== Health ======
app.get("/ping", (req, res) => {
  res.json({
    ok: true,
    indexExists: fs.existsSync(path.join(publicDir, "index.html")),
    time: new Date().toISOString()
  });
});

// ====== DEBUG: See what KB the server loads ======
app.get("/debug-kb", (req, res) => {
  const client = (req.query.client || "demo").toLowerCase();
  const kbPath = path.join(__dirname, "clients", client, "kb.json");

  let raw = []; let error = null;
  try { raw = JSON.parse(fs.readFileSync(kbPath, "utf8")); }
  catch (e) { error = String(e.message); }

  const kb = normalizeKB(raw);
  res.json({
    client, kbPath,
    exists: fs.existsSync(kbPath),
    rawCount: Array.isArray(raw) ? raw.length : -1,
    kbCount: kb.length,
    sample: kb.slice(0, 2),
    error
  });
});

// Handle preflight for /chat
app.options("/chat", cors());

// ====== Chat Route ======
app.post("/chat", async (req, res) => {
  try {
    const message = String(req.body?.message || "");
    const client  = String(req.body?.client || "demo").toLowerCase(); // <-- ensure this matches your folder

    // Load & normalize KB
    const kbPath = path.join(__dirname, "clients", client, "kb.json");
    const kb = normalizeKB(readJSON(kbPath, []));
    console.log("⇒ /chat", { client, msgLen: message.length, kbPath, kbCount: kb.length });

    const ranked = rankFAQ(message, kb).slice(0, 5);
    const context = ranked.map((it, i) => `[${i+1}] Q: ${it.q}\nA: ${it.a}`).join("\n\n") || "(empty)";

    // Echo mode to verify wiring
    if (!USE_OPENAI) {
      return res.json({ reply: `Echo: ${message}`, unsure: kb.length === 0 });
    }

    if (!OPENAI_KEY) {
      return res.status(500).json({ reply: "API-nøkkel mangler på serveren.", unsure: true });
    }

    const systemMsg = `
Du er en vennlig og presis kundeservice-assistent for ${client.replace(/-/g,' ')}.
Svar på norsk når brukeren skriver norsk. Bruk KUN fakta fra "Knowledge Base".
Hvis svaret ikke finnes der, si høflig at du ikke er helt sikker og tilby å ta navn og e-post for oppfølging.
Telefon: 69 11 22 33. Adresse: St. Marie gate 42, 1706 Sarpsborg.
`.trim();

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: "system", content: systemMsg },
          { role: "system", content: `Knowledge Base:\n${context}` },
          { role: "user", content: message }
        ]
      })
    });

    if (!r.ok) {
      const txt = await r.text();
      console.error("OpenAI API error:", r.status, txt);
      return res.status(502).json({ reply: "Beklager – midlertidig problem med AI-svaret.", unsure: true });
    }

    const data = await r.json();
    const reply = data?.choices?.[0]?.message?.content?.trim()
               || "Beklager – jeg fikk ikke generert et svar.";
    const unsure = ranked.length === 0 || ranked[0]?._score === 0;

    res.json({ reply, unsure, suggestions: kb.slice(0,3).map(x => x.q) });

  } catch (e) {
    console.error("Server error:", e);
    res.status(500).json({ reply: "Beklager – serverfeil.", unsure: true });
  }
});

// ====== Start Server ======
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✅ Server live on port ${PORT}`);
});

