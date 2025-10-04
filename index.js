// ================== Nova Dynamics Bot Server (multi-tenant) ==================
// - clients/clients.json registry (per-client allowed origins)
// - CORS hotfix: fallback allowlist + dynamic per-client CORS
// - Loads clients/<slug>/kb.json with 60s cache
// - Simple KB matcher first; falls back to OpenAI if no good hit
// - Usage logging: logs/chat.jsonl
// - Health (/ping), KB debug (/debug-kb), CORS debug (/debug-cors)
// ============================================================================

const express = require("express");
const fs = require("fs");
const path = require("path");

// Use Node 18+ global fetch or lazy-load node-fetch if needed
const fetchFn = global.fetch || ((...args) =>
  import("node-fetch").then(({ default: f }) => f(...args)));

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((req, res, next) => { res.setHeader("Vary", "Origin"); next(); });

// -------------------- Static site (optional) --------------------
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("/", (req, res) => res.sendFile(path.join(publicDir, "index.html")));
}

// -------------------- Config --------------------
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const MODEL      = process.env.OPENAI_MODEL || "gpt-4o-mini";
const PORT       = process.env.PORT || 8787;

const CLIENTS_DIR   = path.join(__dirname, "clients");
const REGISTRY_FILE = path.join(CLIENTS_DIR, "clients.json");

const LOGS_DIR = path.join(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

// -------------------- Client registry --------------------
let REGISTRY = {};
function loadRegistry() {
  try { REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8")); }
  catch { REGISTRY = {}; }
}
loadRegistry();
fs.watchFile(REGISTRY_FILE, { interval: 1500 }, loadRegistry);

function safeSlug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\-]/g, "");
}

// ---- HOTFIX fallback allowlist (keeps you unblocked during setup) ----
const FALLBACK_ALLOWED = new Set([
  "https://prismatic-taffy-e96ac7.netlify.app",
  "https://nova-dynamics.no",
  "https://www.nova-dynamics.no",
  "http://localhost:8888"
]);

function isAllowedOrigin(client, origin) {
  if (FALLBACK_ALLOWED.has(origin)) return true;
  const cfg = REGISTRY[client];
  if (!cfg) return false;
  return (cfg.origins || []).includes(origin || "");
}
function isKnownOrigin(origin) {
  if (FALLBACK_ALLOWED.has(origin)) return true;
  for (const c in REGISTRY) {
    if ((REGISTRY[c].origins || []).includes(origin)) return true;
  }
  return false;
}
function allowCORS(res, origin) {
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
}

// ---- Dynamic CORS middleware (handles preflight & requests) ----
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const rawClient = (req.body && req.body.client) || (req.query && req.query.client) || "";
  const client = safeSlug(rawClient);

  // Preflight: OPTIONS has no body; allow if origin is known anywhere
  if (req.method === "OPTIONS") {
    if (isKnownOrigin(origin)) allowCORS(res, origin);
    return res.sendStatus(204);
  }

  // Normal requests: allow only if origin is allowed for this client (or fallback)
  if (origin && isAllowedOrigin(client, origin)) allowCORS(res, origin);
  return next();
});

// -------------------- KB cache & helpers --------------------
const kbCache = new Map(); // client -> { ts, kb }

function readJSON(filePath, fallback = []) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); }
  catch { return fallback; }
}

function normalizeKB(raw) {
  return (raw || []).map(item => {
    if (item && item.q && item.a) return { q: String(item.q), a: String(item.a) };
    if (item && item.title && item.text) return { q: String(item.title), a: String(item.text) };
    return null;
  }).filter(Boolean);
}

function getKB(client) {
  const now = Date.now();
  const hit = kbCache.get(client);
  if (hit && (now - hit.ts) < 60_000) return hit.kb;
  const kbPath = path.join(CLIENTS_DIR, client, "kb.json");
  const kb = normalizeKB(readJSON(kbPath, []));
  kbCache.set(client, { ts: now, kb });
  return kb;
}

// -------------------- Simple matcher (boost Q words) --------------------
const STOP = new Set(["og","er","en","et","to","and","the","i","vi","som","for","med","på","til","du","jeg","we","you","of","a","an","det","de","så","at"]);
function tok(s) {
  return String(s||"").toLowerCase().normalize("NFKD")
    .replace(/[^\w\sæøåäöü\-]/g, " ")
    .split(/\s+/).filter(w => w && !STOP.has(w));
}
function scoreEntry(entry, qTokens) {
  const tq = tok(entry.q), ta = tok(entry.a);
  let s = 0; for (const t of qTokens) { if (tq.includes(t)) s += 2; if (ta.includes(t)) s += 1; }
  return s;
}
function rankFAQ(question, kb) {
  const qTok = tok(question);
  return kb.map(e => ({ ...e, _score: scoreEntry(e, qTok) }))
           .sort((a,b) => b._score - a._score);
}

// -------------------- Logging --------------------
function logUsage(row) {
  fs.appendFile(path.join(LOGS_DIR, "chat.jsonl"), JSON.stringify(row) + "\n", () => {});
}

// -------------------- Health / Debug --------------------
app.get("/ping", (req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});
app.get("/debug-kb", (req, res) => {
  const client = safeSlug(req.query.client || "demo");
  const kbPath = path.join(CLIENTS_DIR, client, "kb.json");
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
app.get("/debug-cors", (req, res) => {
  res.json({
    seenOrigin: req.headers.origin || null,
    fallbackAllowed: Array.from(FALLBACK_ALLOWED),
    registryClients: Object.keys(REGISTRY || {}),
    demoOrigins: (REGISTRY.demo && REGISTRY.demo.origins) || []
  });
});

// -------------------- OpenAI helper (timeout + retry) --------------------
async function fetchJSON(url, opts, timeoutMs = 15000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const r = await fetchFn(url, { ...opts, signal: c.signal });
    const text = await r.text();
    let data = {};
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return { ok: r.ok, status: r.status, data };
  } finally { clearTimeout(t); }
}

// -------------------- Chat --------------------
app.post("/chat", async (req, res) => {
  const origin  = req.headers.origin || "";
  const client  = safeSlug(req.body?.client || "demo");
  const message = String(req.body?.message || "").slice(0, 2000);

  if (!REGISTRY[client]) {
    return res.status(400).json({ reply: "Unknown client.", unsure: true });
  }
  if (origin && !isAllowedOrigin(client, origin)) {
    return res.status(403).json({ reply: "Origin not allowed for this client.", unsure: true });
  }

  const kb = getKB(client);
  const ranked = rankFAQ(message, kb);
  const top = ranked[0];
  const hasHit = top && top._score > 0;

  if (hasHit) {
    const reply = top.a;
    logUsage({ ts:new Date().toISOString(), client, origin, kind:"kb", in:message.length, out:reply.length });
    return res.json({ reply, unsure: false, suggestions: ranked.slice(1,4).map(x=>x.q) });
  }

  if (!OPENAI_KEY) {
    return res.status(500).json({ reply: "API-nøkkel mangler på serveren.", unsure: true });
  }

  const systemMsg = `
You are a concise, friendly customer-service assistant for ${client.replace(/-/g," ")}.
Answer in the user's language (Norwegian or English). Prefer facts from the Knowledge Base below.
If the answer is not present, say you're not entirely sure and offer to collect name and email for follow-up.
`.trim();

  const context = `Knowledge Base:\n${
    kb.map((it,i)=>`[${i+1}] Q: ${it.q}\nA: ${it.a}`).join("\n\n")
  }`.slice(0, 8000);

  let resp = await fetchJSON("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, temperature: 0.2,
      messages: [
        { role: "system", content: systemMsg },
        { role: "system", content: context || "(empty KB)" },
        { role: "user", content: message }
      ]
    })
  }, 15000);

  // quick retry on 5xx/network
  if (!resp.ok || resp.status >= 500) {
    resp = await fetchJSON("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: MODEL, temperature: 0.2,
        messages: [
          { role: "system", content: systemMsg },
          { role: "system", content: context || "(empty KB)" },
          { role: "user", content: message }
        ]
      })
    }, 15000);
  }

  if (!resp.ok) {
    console.error("OpenAI error:", resp.status, resp.data);
    return res.status(502).json({ reply: "Beklager – midlertidig problem med AI-svaret.", unsure: true });
  }

  const data = resp.data;
  const reply = data?.choices?.[0]?.message?.content?.trim()
             || "Beklager – jeg fikk ikke generert et svar.";
  logUsage({ ts:new Date().toISOString(), client, origin, kind:"llm", in:message.length, out:reply.length });
  res.json({ reply, unsure: true, suggestions: kb.slice(0,3).map(x=>x.q) });
});

// -------------------- Start --------------------
app.listen(PORT, () => {
  console.log(`✅ Server live on port ${PORT}`);
});
