// ================== Nova Dynamics Bot Server (multi-tenant) ==================
// - clients/clients.json registry (per-client allowed origins)
// - CORS hotfix: fallback allowlist + dynamic per-client CORS
// - Loads clients/<slug>/kb.json with 60s cache
// - Better KB retrieval: TF-IDF cosine + bigrams + threshold
// - KB-first answers; LLM fallback with top-3 context only
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

// -------------------- Better retrieval: TF-IDF + bigrams + threshold ---------
const STOP = new Set([
  // Norwegian
  "og","i","på","for","med","til","fra","en","ei","et","er","som","av","vi","du","jeg","dere","de","det","den","å","har","hva","når","hvor",
  // English
  "and","or","the","a","an","of","to","in","on","for","with","is","are","we","you","it","this","that","do","does","when","what","where"
]);

function norm(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\sæøåäöü\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(str) {
  const t = norm(str).split(" ").filter(w => w && !STOP.has(w));
  // bigrams capture phrases like "åpent lørdag", "opening hours"
  const bigrams = [];
  for (let i = 0; i < t.length - 1; i++) bigrams.push(t[i] + " " + t[i+1]);
  return t.concat(bigrams);
}

function tf(arr) {
  const m = new Map();
  for (const w of arr) m.set(w, (m.get(w) || 0) + 1);
  return m;
}

function idf(docs) {
  const df = new Map();
  docs.forEach(d => {
    const seen = new Set(d);
    for (const w of seen) df.set(w, (df.get(w) || 0) + 1);
  });
  const N = docs.length;
  const out = new Map();
  for (const [w, c] of df) out.set(w, Math.log(1 + N / (c || 1)));
  return out;
}

function dot(a, b) {
  let s = 0;
  for (const [k, v] of a) if (b.has(k)) s += v * b.get(k);
  return s;
}

function vecLen(v) {
  let s = 0;
  for (const [, v2] of v) s += v2 * v2;
  return Math.sqrt(s);
}

/** Rank [{q,a}] by cosine similarity (question weighted 2x over answer). */
function rankFAQ_TFIDF(question, kb) {
  const qToks = tokens(question);
  const docTokens = kb.map(e => {
    const tQ = tokens(e.q);
    const tA = tokens(e.a);
    return tQ.concat(tQ, tA); // Q counted twice
  });

  const IDF = idf(docTokens);

  const docVecs = docTokens.map(arr => {
    const TF = tf(arr);
    const v = new Map();
    for (const [w, f] of TF) v.set(w, f * (IDF.get(w) || 0));
    return v;
  });

  const qTF = tf(qToks);
  const qVec = new Map();
  for (const [w, f] of qTF) qVec.set(w, f * (IDF.get(w) || 0));
  const qLen = vecLen(qVec) || 1e-9;

  return kb.map((e, i) => {
    const v = docVecs[i];
    const score = dot(qVec, v) / (qLen * (vecLen(v) || 1e-9));
    return { ...e, _score: score };
  }).sort((a,b) => b._score - a._score);
}

// Confidence floor: below this, we consider the match unreliable
const MIN_SIM = 0.18;

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
  const ranked = rankFAQ_TFIDF(message, kb);
  const top = ranked[0];
  const confident = top && top._score >= MIN_SIM;

  // Confident KB hit → answer directly (cheap + consistent)
  if (confident) {
    const reply = top.a;
    logUsage({ ts:new Date().toISOString(), client, origin, kind:"kb", in:message.length, out:reply.length, score:top._score });
    return res.json({ reply, unsure: false, suggestions: ranked.slice(1,3).map(x=>x.q) });
  }

  // LLM fallback
  if (!OPENAI_KEY) {
    return res.status(500).json({ reply: "API-nøkkel mangler på serveren.", unsure: true });
  }

  // Only send top-3 to the model; include scores so it can judge reliability
  const topK = ranked.slice(0, 3);
  const context = topK.map((it, i) =>
    `[${i+1}] score=${(it._score || 0).toFixed(3)}\nQ: ${it.q}\nA: ${it.a}`
  ).join("\n\n");

  const systemMsg = `
You are a concise, friendly customer-service assistant.
- Detect the user's language (Norwegian or English) and respond in that language.
- You are given up to 3 FAQ entries with similarity scores.
- ONLY answer if one entry clearly matches the user's question. If none match, say you’re not entirely sure and offer to collect name and email for follow-up.
- Do NOT invent facts or merge unrelated entries.
`.trim();

  let resp = await fetchJSON("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${OPENAI_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL, temperature: 0.2,
      messages: [
        { role: "system", content: systemMsg },
        { role: "system", content: context || "(no candidates)" },
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
          { role: "system", content: context || "(no candidates)" },
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

