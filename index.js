// ====== Imports & App Setup ======
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");


const app = express();
app.use(cors());
app.use(express.json());

function normalizeKB(raw) {
  // Accept [{q,a}] or [{title,text}]
  return (raw || []).map(item => {
    if (item.q && item.a) return item;
    if (item.title && item.text) return { q: item.title, a: item.text };
    return null;
  }).filter(Boolean);
}


// Allow cross-origin requests (Netlify + Render demo)
app.use(cors({
  origin: [
    'https://nova-dynamics-bot-server.onrender.com',   // your Render site
    'https://chic-lollipop-d9274c.netlify.app'            // replace with your real Netlify site if used
  ],
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

const fs = require("fs");
const path = require("path");

// --- DEBUG: inspect which KB the server sees ---
app.get("/debug-kb", (req, res) => {
  const client = (req.query.client || "demo").toLowerCase();
  const kbPath = path.join(__dirname, "clients", client, "kb.json");

  let raw = [];
  let error = null;
  try {
    const txt = fs.readFileSync(kbPath, "utf8");
    raw = JSON.parse(txt);
  } catch (e) {
    error = String(e && e.message);
  }

  const count = Array.isArray(raw) ? raw.length : 0;
  const sample = Array.isArray(raw) ? raw.slice(0, 2) : [];
  res.json({ client, kbPath, exists: fs.existsSync(kbPath), count, sample, error });
});


// Explicitly handle preflight for /chat
app.options('/chat', cors());


// ====== Static Website (fixes "Cannot GET /") ======
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));
app.get("/", (req, res) => {
  res.sendFile(path.join(publicDir, "index.html"));
});

// ====== Config ======
// Toggle to test front↔back without hitting OpenAI
const USE_OPENAI = true;  // set to false to test "Echo" replies

// Prefer env var in production; fallback only for local testing
const OPENAI_KEY = process.env.OPENAI_API_KEY;

// ====== Health Route ======
app.get("/ping", (req, res) => {
  res.json({
    ok: true,
    publicDir,
    indexExists: fs.existsSync(path.join(publicDir, "index.html"))
  });
});

// ====== Tiny Helpers ======
function readJSON(filePath, fallback = []) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

// Very simple keyword scoring to pick relevant FAQs
function rankFAQ(question, kb) {
  const qWords = new Set(
    question.toLowerCase().split(/[^a-z0-9æøåäöü\-]+/).filter(Boolean)
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

// ====== Chat Route ======
app.post("/chat", async (req, res) => {
  try {
    const message = (req.body && req.body.message) || "";
    const client  = (req.body && req.body.client)  || "nordic-nibbles"; // default demo client

    console.log("⇒ /chat:", { client, message });

    // Load client KB if present
    const kbPath = path.join(__dirname, "clients", client, "kb.json");
    const kb = readJSON(kbPath, []);
    const ranked = rankFAQ(message, kb).slice(0, 4);
    const context = ranked.map((it, i) => `[${i+1}] Q: ${it.q}\nA: ${it.a}`).join("\n\n") || "(empty)";

    if (!USE_OPENAI) {
      return res.json({ reply: `Echo: ${message}`, unsure: false });
    }

    // --- OpenAI call (Node 18+ has global fetch) ---
    const systemMsg = `
Du er en vennlig og presis kundeservice-assistent for ${client.replace(/-/g,' ')}.
Svar på norsk når brukeren skriver norsk, ellers på samme språk som brukeren.
Bruk kun fakta fra "Knowledge Base" nedenfor. Hvis svaret ikke er tydelig der,
si: "Jeg er ikke helt sikker – kan jeg få navn og e-post, så følger teamet vårt opp?"
Telefon: 69 11 22 33. Adresse: St. Marie gate 42, 1706 Sarpsborg.
`.trim();

    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.2,
        messages: [
          { role: "system", content: systemMsg },
          { role: "system", content: `Knowledge Base:\n${context}` },
          { role: "user", content: message }
        ]
      }),
    });

    if (!r.ok) {
      const errText = await r.text();
      console.error("OpenAI API error:", r.status, errText);
      return res.status(500).json({
        reply: "Beklager – midlertidig problem med AI-svaret. Prøv igjen om litt.",
        unsure: true
      });
    }

    const data = await r.json();
    const reply = data.choices?.[0]?.message?.content?.trim()
                 || "Beklager – jeg fikk ikke generert et svar.";
    const unsure = ranked.length === 0 || ranked[0]._score === 0;

    res.json({ reply, unsure, suggestions: kb.slice(0,3).map(x => x.q) });

  } catch (e) {
    console.error("Server error:", e);
    res.status(500).json({
      reply: "Beklager – serverfeil. Prøv igjen senere.",
      unsure: true
    });
  }
});

// ====== Start Server ======
const PORT = process.env.PORT || 8787;
app.listen(PORT, () => {
  console.log(`✅ Live on http://localhost:${PORT}`);
});
