// ================== Nova Dynamics Bot Server (multi-tenant) ==================
const express = require("express");
const fs = require("fs");
const path = require("path");

// Use Node 18+ global fetch or lazy-load node-fetch if needed
const fetchFn = global.fetch || ((...args) =>
  import("node-fetch").then(({ default: f }) => f(...args)));

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((_, res, next) => {
  res.setHeader("Vary", "Origin");
  next();
});

// -------------------- Static site (optional) --------------------
const publicDir = path.join(__dirname, "public");

if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
  app.get("/", (req, res) => {
    res.sendFile(path.join(publicDir, "index.html"));
  });
}

// -------------------- Config --------------------
const OPENAI_KEY = process.env.OPENAI_API_KEY || "";
const MODEL = process.env.OPENAI_MODEL || "gpt-4o-mini";
const PORT = process.env.PORT || 8787;

const CLIENTS_DIR = path.join(__dirname, "clients");
const REGISTRY_FILE = path.join(CLIENTS_DIR, "clients.json");

const LOGS_DIR = path.join(__dirname, "logs");
fs.mkdirSync(LOGS_DIR, { recursive: true });

// -------------------- Client registry --------------------
let REGISTRY = {};

function loadRegistry() {
  try {
    REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_FILE, "utf8"));
  } catch {
    REGISTRY = {};
  }
}

loadRegistry();
fs.watchFile(REGISTRY_FILE, { interval: 1500, persistent: false }, loadRegistry);

function safeSlug(s) {
  return String(s || "").toLowerCase().replace(/[^a-z0-9\-]/g, "");
}

function clientHasKB(client) {
  const kbPath = path.join(CLIENTS_DIR, client, "kb.json");
  return fs.existsSync(kbPath);
}

function publicDemoConfig(client) {
  const cfg = REGISTRY[client] || {};
  const demo = cfg.demo || {};

  return {
    client,
    name: cfg.name || client,
    description: demo.description || "Spør assistenten om tjenester, priser og praktisk informasjon.",
    greeting: demo.greeting || `Hei! Jeg er den digitale assistenten for ${cfg.name || client}. Hva kan jeg hjelpe deg med?`,
    website: demo.website || "",
    accent: demo.accent || "#4f7cff",
    suggestedQuestions: Array.isArray(demo.suggestedQuestions)
      ? demo.suggestedQuestions.slice(0, 6)
      : []
  };
}

// ---- HOTFIX fallback allowlist ----
const FALLBACK_ALLOWED = new Set([
  "https://prismatic-taffy-e96ac7.netlify.app",
  "https://nova-dynamics.no",
  "https://www.nova-dynamics.no",
  "http://localhost:8888",
  "http://localhost:3000",
  "http://localhost:5173"
]);

function isAllowedOrigin(client, origin) {
  if (!origin) return true;
  if (FALLBACK_ALLOWED.has(origin)) return true;

  const cfg = REGISTRY[client];
  if (!cfg) return false;

  return (cfg.origins || []).includes(origin || "");
}

function isKnownOrigin(origin) {
  if (!origin) return true;
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

// ---- Dynamic CORS middleware ----
app.use((req, res, next) => {
  const origin = req.headers.origin || "";
  const rawClient = (req.body && req.body.client) || (req.query && req.query.client) || "";
  const client = safeSlug(rawClient);

  if (req.method === "OPTIONS") {
    if (isKnownOrigin(origin)) allowCORS(res, origin);
    return res.sendStatus(204);
  }

  if (origin && isAllowedOrigin(client, origin)) allowCORS(res, origin);

  return next();
});

// -------------------- Render-hosted demos --------------------
app.get(["/demos/:client", "/demos/:client/"], (req, res) => {
  const client = safeSlug(req.params.client);

  if (!client || (!REGISTRY[client] && !clientHasKB(client))) {
    return res.status(404).send("Demo not found.");
  }

  return res.sendFile(path.join(publicDir, "demo", "index.html"));
});

app.get("/api/demo-config/:client", (req, res) => {
  const client = safeSlug(req.params.client);

  if (!client || (!REGISTRY[client] && !clientHasKB(client))) {
    return res.status(404).json({ error: "Demo not found." });
  }

  res.setHeader("Cache-Control", "no-store");
  return res.json(publicDemoConfig(client));
});

// -------------------- KB cache & helpers --------------------
const kbCache = new Map(); // client -> { ts, kb }

function readJSON(filePath, fallback = []) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return fallback;
  }
}

function normalizeKB(raw) {
  return (raw || [])
    .map(item => {
      if (item && item.q && item.a) {
        return {
          q: String(item.q),
          a: String(item.a)
        };
      }

      if (item && item.title && item.text) {
        return {
          q: String(item.title),
          a: String(item.text)
        };
      }

      return null;
    })
    .filter(Boolean);
}

function getKB(client) {
  const now = Date.now();
  const hit = kbCache.get(client);

  if (hit && now - hit.ts < 60_000) return hit.kb;

  const kbPath = path.join(CLIENTS_DIR, client, "kb.json");
  const kb = normalizeKB(readJSON(kbPath, []));

  kbCache.set(client, { ts: now, kb });

  return kb;
}

// -------------------- Retrieval: TF-IDF + bigrams + synonyms/day roots -------
const STOP = new Set([
  // Norwegian
  "og", "i", "på", "for", "med", "til", "fra", "en", "ei", "et", "er", "som", "av",
  "vi", "du", "jeg", "meg", "dere", "deres", "de", "det", "den", "å", "har", "hva",
  "når", "hvor", "kan", "kunne", "min", "mitt", "mine", "din", "ditt", "dine", "oss", "om",

  // English
  "and", "or", "the", "a", "an", "of", "to", "in", "on", "for", "with", "is", "are",
  "we", "you", "it", "this", "that", "do", "does", "when", "what", "where"
]);

const ROOT_DAY = new Map([
  ["mandag", "mon"], ["man", "mon"], ["monday", "mon"],
  ["tirsdag", "tue"], ["tir", "tue"], ["tuesday", "tue"],
  ["onsdag", "wed"], ["ons", "wed"], ["wednesday", "wed"],
  ["torsdag", "thu"], ["tor", "thu"], ["thursday", "thu"],
  ["fredag", "fri"], ["fre", "fri"], ["friday", "fri"],
  ["lørdag", "sat"], ["lør", "sat"], ["lor", "sat"], ["saturday", "sat"],
  ["søndag", "sun"], ["søn", "sun"], ["son", "sun"], ["sunday", "sun"]
]);

const SYNONYMS = new Map([
  ["åpent", "åpningstider"],
  ["åpne", "åpningstider"],
  ["åpning", "åpningstider"],
  ["stengt", "åpningstider"],

  ["open", "hours"],
  ["opening", "hours"],
  ["hour", "hours"],
  ["hours", "hours"],
  ["closed", "hours"],

  ["adressen", "adresse"],
  ["addressen", "adresse"],
  ["addresse", "adresse"],
  ["addres", "adresse"],
  ["addr", "adresse"],
  ["butikken", "butikk"],

  ["vipps", "vipps"],
  ["vips", "vipps"],
  ["vippøs", "vipps"],
  ["betaler", "betale"],

  ["kjøretime", "kjøretime"],
  ["kjøretimer", "kjøretime"],
  ["kjoretime", "kjøretime"],
  ["kjoretimer", "kjøretime"],
  ["timepris", "kjøretime"],

  ["mørkekjøring", "mørkekjøring"],
  ["morkekjoring", "mørkekjøring"],
  ["mørkedemo", "mørkekjøring"],
  ["morkedemo", "mørkekjøring"],

  ["grunnkurs", "trafikalt grunnkurs"],
  ["tg", "trafikalt grunnkurs"]
]);

function norm(str) {
  return String(str || "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\w\sæøåäöü\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTerm(w) {
  if (ROOT_DAY.has(w)) return ROOT_DAY.get(w);
  if (SYNONYMS.has(w)) return SYNONYMS.get(w);
  return w;
}

function tokens(str) {
  const base = norm(str).split(" ").filter(Boolean);
  const uni = [];

  for (const raw of base) {
    if (STOP.has(raw)) continue;

    const w = normalizeTerm(raw);

    if (w && !STOP.has(w)) uni.push(w);
  }

  const bi = [];

  for (let i = 0; i < uni.length - 1; i++) {
    bi.push(uni[i] + " " + uni[i + 1]);
  }

  return uni.concat(bi);
}

function tf(arr) {
  const m = new Map();

  for (const w of arr) {
    m.set(w, (m.get(w) || 0) + 1);
  }

  return m;
}

function idf(docs) {
  const df = new Map();

  docs.forEach(d => {
    const seen = new Set(d);

    for (const w of seen) {
      df.set(w, (df.get(w) || 0) + 1);
    }
  });

  const N = docs.length;
  const out = new Map();

  for (const [w, c] of df) {
    out.set(w, Math.log(1 + N / (c || 1)));
  }

  return out;
}

function dot(a, b) {
  let s = 0;

  for (const [k, v] of a) {
    if (b.has(k)) s += v * b.get(k);
  }

  return s;
}

function vecLen(v) {
  let s = 0;

  for (const [, v2] of v) {
    s += v2 * v2;
  }

  return Math.sqrt(s);
}

function rankFAQ_TFIDF(question, kb) {
  const qToks = tokens(question);

  const docTokens = kb.map(e => {
    const tQ = tokens(e.q);
    const tA = tokens(e.a);

    return tQ.concat(tQ, tA); // weight Q twice
  });

  const IDF = idf(docTokens);

  const docVecs = docTokens.map(arr => {
    const TF = tf(arr);
    const v = new Map();

    for (const [w, f] of TF) {
      v.set(w, f * (IDF.get(w) || 0));
    }

    return v;
  });

  const qTF = tf(qToks);
  const qVec = new Map();

  for (const [w, f] of qTF) {
    qVec.set(w, f * (IDF.get(w) || 0));
  }

  const qLen = vecLen(qVec) || 1e-9;

  return kb
    .map((e, i) => {
      const v = docVecs[i];
      const score = dot(qVec, v) / (qLen * (vecLen(v) || 1e-9));

      return {
        ...e,
        _score: score
      };
    })
    .sort((a, b) => b._score - a._score);
}

const MIN_SIM = 0.16;

// -------------------- Logging --------------------
function logUsage(row) {
  fs.appendFile(
    path.join(LOGS_DIR, "chat.jsonl"),
    JSON.stringify(row) + "\n",
    () => {}
  );
}

// -------------------- Health / Debug --------------------
app.get("/ping", (req, res) => {
  res.json({
    ok: true,
    time: new Date().toISOString()
  });
});

app.get("/debug-kb", (req, res) => {
  const client = safeSlug(req.query.client || "demo");
  const kbPath = path.join(CLIENTS_DIR, client, "kb.json");

  let raw = [];
  let error = null;

  try {
    raw = JSON.parse(fs.readFileSync(kbPath, "utf8"));
  } catch (e) {
    error = String(e.message);
  }

  const kb = normalizeKB(raw);

  res.json({
    client,
    kbPath,
    exists: fs.existsSync(kbPath),
    rawCount: Array.isArray(raw) ? raw.length : -1,
    kbCount: kb.length,
    sample: kb.slice(0, 3),
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

app.get("/debug-intent", (req, res) => {
  const message = String(req.query.message || "");
  const intent = detectIntent(message);
  const emergency = isEmergencyAddressQuestion(message);

  res.json({
    message,
    intent,
    emergencyAddressOverride: emergency,
    query: intentQuery(intent)
  });
});

app.get("/debug-rank", (req, res) => {
  const client = safeSlug(req.query.client || "demo");
  const message = String(req.query.message || "");
  const kb = getKB(client);
  const intent = detectIntent(message);
  const queryForRanking = intent && intent !== "price"
    ? (intentQuery(intent) || message)
    : message;

  const ranked = rankFAQ_TFIDF(queryForRanking, kb).slice(0, 5);

  res.json({
    client,
    message,
    intent,
    queryForRanking,
    kbCount: kb.length,
    ranked
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

    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    return {
      ok: r.ok,
      status: r.status,
      data
    };
  } finally {
    clearTimeout(t);
  }
}

// -------------------- Intent detection layer --------------------
function detectIntent(message) {
  const m = String(message || "")
    .toLowerCase()
    .normalize("NFKD");

  if (/(åpent|aapent|åpningstid|apningstid|opening|hours|open|stengt|closed|lørdag|lordag|søndag|sondag|mandag|fredag|helg|weekend|saturday|sunday)/.test(m)) {
    return "opening_hours";
  }

  if (/(\b(adresse|adressen|addressen|addresse|addres|addr|lokasjon|location|address)\b|hvor\s+ligger|hvor\s+finner|hvor\s+er|hvor\s+holder|kor\s+er|where\s+are|where\s+is|find\s+you)/.test(m)) {
    return "address";
  }

  if (/(telefon|tlf|nummer|ringe|phone|call)/.test(m)) {
    return "phone";
  }

  if (/(epost|e-post|email|mail)/.test(m)) {
    return "email";
  }

  if (/(vipps|vips|vippøs|kort|bankkort|kontant|cash|card|betaling|betale|betaler|payment|invoice|faktura)/.test(m)) {
    return "payment";
  }

  if (/(lager dere|selger dere|produkter|produktene|hva lager|hva selger|hva har dere|what do you make|what do you sell|products|menu|meny)/.test(m)) {
    return "products";
  }

  if (/(bestille|bestilling|order|custom cake|spesialkake|kake|cake|påmelding|pamelding|melde seg på|booking|booke|bli elev)/.test(m)) {
    return "ordering";
  }

  if (/(allergen|allergi|gluten|glutenfri|laktose|nøtt|nott|nut|allergy)/.test(m)) {
    return "allergens";
  }

  if (/(levering|levere|delivery|deliver|henting|pickup)/.test(m)) {
    return "delivery";
  }

  if (/(pris|priser|koster|kostnad|price|cost)/.test(m)) {
    return "price";
  }

  return null;
}

function isEmergencyAddressQuestion(message) {
  const m = String(message || "")
    .toLowerCase()
    .normalize("NFKD");

  return /(\b(adresse|adressen|address|addressen|addresse|addres|addr|lokasjon|location)\b|hvor\s+er|hvor\s+ligger|hvor\s+finner|hvor\s+holder|kor\s+er|where\s+are|where\s+is|find\s+you)/.test(m);
}

function intentQuery(intent) {
  const queries = {
    opening_hours:
      "åpningstider åpningstid åpent åpen open opening hours lørdag saturday søndag sunday mandag fredag tirsdag onsdag torsdag kontortid",

    address:
      "adresse adressen addressen addresse addres addr address location hvor ligger dere hvor finner dere hvor er dere besøksadresse",

    phone:
      "telefon nummer phone call ringe kontakt",

    email:
      "e-post email mail kontakt bestilling spørsmål",

    payment:
      "betaling betale betaler payment vipps vips vippøs kort bankkort card kontant cash faktura invoice",

    products:
      "produkter tjenester tilbud førerkort klasser opplæring klasse b automat manuell mc tilhenger",

    ordering:
      "påmelding pamelding melde seg på bestille time booking kurs bli elev starte opplæring",

    allergens:
      "allergener allergi allergens glutenfri gluten free laktosefri lactose nøtter nuts nut free",

    delivery:
      "levering deliver delivery hente pickup henting"
  };

  return queries[intent] || null;
}

// -------------------- Direct demo answer helpers --------------------
function makeNorwegianSearchText(input) {
  const raw = String(input || "").toLowerCase();

  const ascii = raw
    .replaceAll("æ", "ae")
    .replaceAll("ø", "o")
    .replaceAll("å", "a");

  return {
    raw,
    ascii,
    both: `${raw} ${ascii}`
  };
}

function includesAny(textObj, phrases) {
  return phrases.some(phrase => {
    const p = String(phrase || "").toLowerCase();

    return textObj.raw.includes(p) || textObj.ascii.includes(p);
  });
}

function directFyllingsdalenAnswer(client, message) {
  const c = String(client || "").toLowerCase().trim();

  if (c !== "fyllingsdalen") return null;

  const t = makeNorwegianSearchText(message);

  const asksPrice = includesAny(t, ["pris", "priser", "koster", "kostnad", "price", "cost"]);

  // Normal kjøretime: this must run before package/startpakke logic.
  if (
    includesAny(t, [
      "kjøretime",
      "kjøretimer",
      "kjoretime",
      "kjoretimer",
      "timepris",
      "vanlig time",
      "klasse b time",
      "45 min"
    ]) ||
    (asksPrice && includesAny(t, ["time", "timer"]))
  ) {
    return "En vanlig kjøretime på 45 minutter for klasse B er oppført til 900 kr hos Fyllingsdalen Trafikkskole.";
  }

  if (
    includesAny(t, [
      "trafikalt grunnkurs",
      "grunnkurs",
      "tg"
    ])
  ) {
    return "Trafikalt grunnkurs hos Fyllingsdalen Trafikkskole er oppført til 1 400 kr.";
  }

  if (
    includesAny(t, [
      "trafikant i mørket",
      "trafikant i morket",
      "mørkekjøring",
      "morkekjoring",
      "mørkedemo",
      "morkedemo",
      "mørkedemonstrasjon",
      "morkedemonstrasjon"
    ])
  ) {
    return "Trafikant i mørket hos Fyllingsdalen Trafikkskole er oppført til 2 200 kr.";
  }

  if (
    includesAny(t, [
      "lørdag",
      "lordag",
      "helg",
      "weekend"
    ]) &&
    includesAny(t, [
      "kjøretime",
      "kjoretime",
      "time"
    ])
  ) {
    return "Kjøretime på lørdag er oppført til 1 700 kr hos Fyllingsdalen Trafikkskole.";
  }

  if (
    includesAny(t, [
      "etter kl 16",
      "etter 16",
      "kveld",
      "ettermiddag",
      "sen time",
      "kveldstime"
    ])
  ) {
    return "Kjøretime etter kl. 16 er oppført til 1 050 kr hos Fyllingsdalen Trafikkskole.";
  }

  if (
    includesAny(t, [
      "startpakke",
      "start pakke",
      "pakke",
      "pakketilbud",
      "16 kjøretimer",
      "16 kjoretimer",
      "20 kjøretimer",
      "20 kjoretimer"
    ])
  ) {
    return "Fyllingsdalen Trafikkskole har startpakker for klasse B. På prissiden er 16 kjøretimer med obligatorisk opplæring oppført til 35 175 kr, og 20 kjøretimer med obligatorisk opplæring oppført til 37 775 kr.";
  }

  if (
    includesAny(t, [
      "sikkerhetskurs bane",
      "glattkjøring",
      "glattkjoring",
      "øvingsbane",
      "ovingsbane"
    ])
  ) {
    return "Sikkerhetskurs på bane for klasse B er oppført til 5 600 kr hos Fyllingsdalen Trafikkskole.";
  }

  if (
    includesAny(t, [
      "sikkerhetskurs vei",
      "langkjøring",
      "langkjoring",
      "landevei"
    ])
  ) {
    return "Sikkerhetskurs på vei for klasse B er oppført til 10 110 kr hos Fyllingsdalen Trafikkskole.";
  }

  if (
    includesAny(t, [
      "førerprøve",
      "forerprove",
      "oppkjøring",
      "oppkjoring",
      "praktisk prøve",
      "praktisk prove"
    ])
  ) {
    return "Førerprøve for klasse B er oppført til 2 850 kr hos Fyllingsdalen Trafikkskole.";
  }

  if (
    includesAny(t, [
      "adresse",
      "hvor er",
      "hvor ligger",
      "location",
      "besøksadresse",
      "besoksadresse",
      "spectrum"
    ])
  ) {
    return "Fyllingsdalen Trafikkskole holder til i Folke Bernadottes vei 44, 5147 Fyllingsdalen, i Spectrum-bygget.";
  }

  if (
    includesAny(t, [
      "telefon",
      "nummer",
      "ringe",
      "kontakt",
      "tlf"
    ])
  ) {
    return "Du kan kontakte Fyllingsdalen Trafikkskole på telefon 920 12 800 eller e-post dintrafikkskole@gmail.com.";
  }

  if (
    includesAny(t, [
      "epost",
      "e-post",
      "email",
      "mail"
    ])
  ) {
    return "Du kan kontakte Fyllingsdalen Trafikkskole på e-post: dintrafikkskole@gmail.com.";
  }

  if (
    includesAny(t, [
      "åpningstid",
      "apningstid",
      "aapningstid",
      "åpent",
      "apent",
      "kontortid",
      "når er dere åpne",
      "nar er dere apne"
    ])
  ) {
    return "Fyllingsdalen Trafikkskole har oppført kontortider tirsdag 11:00–12:30, onsdag 11:00–12:30 og torsdag 16:00–17:30.";
  }

  if (
    includesAny(t, [
      "klasse",
      "klasser",
      "førerkort",
      "forerkort",
      "tilbyr",
      "hva tilbyr",
      "opplæring",
      "opplaering"
    ])
  ) {
    return "Fyllingsdalen Trafikkskole tilbyr opplæring for blant annet klasse B, klasse B automat, motorsykkelklassene A, A1 og A2, BE/B96 tilhenger og trafikalt grunnkurs.";
  }

  if (
    includesAny(t, [
      "påmelding",
      "pamelding",
      "melde seg på",
      "melde seg pa",
      "booking",
      "booke",
      "bli elev",
      "starte"
    ])
  ) {
    return "Du kan melde deg på eller ta kontakt via nettsiden til Fyllingsdalen Trafikkskole, eller kontakte dem direkte på telefon 920 12 800 eller e-post dintrafikkskole@gmail.com.";
  }

  return null;
}

// -------------------- Chat --------------------
app.post("/chat", async (req, res) => {
  const origin = req.headers.origin || "";
  const client = safeSlug(req.body?.client || "demo");
  const message = String(req.body?.message || "").slice(0, 2000);

  if (!REGISTRY[client] && !clientHasKB(client)) {
    return res.status(400).json({
      reply: "Unknown client.",
      unsure: true
    });
  }

  if (origin && !isAllowedOrigin(client, origin)) {
    return res.status(403).json({
      reply: "Origin not allowed for this client.",
      unsure: true
    });
  }

  // Direct Fyllingsdalen demo answers. This runs before KB ranking and before OpenAI.
  const fyllingsdalenReply = directFyllingsdalenAnswer(client, message);

  if (fyllingsdalenReply) {
    logUsage({
      ts: new Date().toISOString(),
      client,
      origin,
      kind: "direct_fyllingsdalen",
      in: message.length,
      out: fyllingsdalenReply.length
    });

    return res.json({
      reply: fyllingsdalenReply,
      unsure: false,
      suggestions: []
    });
  }

  const kb = getKB(client);

  // EMERGENCY ADDRESS OVERRIDE:
  // This catches address/location questions before the fuzzy search can confuse them.
  if (isEmergencyAddressQuestion(message)) {
    const addressEntry = kb.find(x => {
      const q = String(x.q || "").toLowerCase();
      const a = String(x.a || "").toLowerCase();

      return (
        q.includes("adresse") ||
        q.includes("address") ||
        q.includes("location") ||
        q.includes("lokasjon") ||
        a.includes("folke bernadottes") ||
        a.includes("5147 fyllingsdalen") ||
        a.includes("spectrum") ||
        a.includes("st. marie") ||
        a.includes("st marie") ||
        a.includes("1706 sarpsborg")
      );
    });

    const reply = addressEntry?.a ||
      "Jeg fant ikke adressen i kunnskapsgrunnlaget akkurat nå. Ta gjerne kontakt med bedriften direkte for å få riktig adresse.";

    logUsage({
      ts: new Date().toISOString(),
      client,
      origin,
      kind: "emergency_address",
      in: message.length,
      out: reply.length
    });

    return res.json({
      reply,
      unsure: false,
      suggestions: []
    });
  }

  const intent = detectIntent(message);

  // Important: for price questions, use the user's real wording.
  // Generic price queries can accidentally pick the wrong product/service.
  const queryForRanking = intent && intent !== "price"
    ? (intentQuery(intent) || message)
    : message;

  const ranked = rankFAQ_TFIDF(queryForRanking, kb);
  const top = ranked[0];

  const threshold = intent ? 0.08 : MIN_SIM;
  const confident = top && top._score >= threshold;

  if (confident) {
    const reply = top.a;

    logUsage({
      ts: new Date().toISOString(),
      client,
      origin,
      kind: "kb",
      intent: intent || null,
      in: message.length,
      out: reply.length,
      score: top._score
    });

    return res.json({
      reply,
      unsure: false,
      suggestions: ranked.slice(1, 3).map(x => x.q)
    });
  }

  if (!OPENAI_KEY) {
    return res.status(500).json({
      reply: "API-nøkkel mangler på serveren.",
      unsure: true
    });
  }

  const topK = ranked.slice(0, 3);
  const context = topK.length
    ? topK.map((it, i) =>
        `[${i + 1}] score=${(it._score || 0).toFixed(3)}\nQ: ${it.q}\nA: ${it.a}`
      ).join("\n\n")
    : "(no candidates)";

  const systemMsg = `
You are a concise, friendly customer-service assistant.
- Detect the user's language (Norwegian or English) and respond in that language.
- You are given up to 3 FAQ entries with similarity scores.
- ONLY answer if one entry clearly matches the user's question. If none match, say you’re not entirely sure and direct the user to the business's published contact details.
- Do not claim that you can collect, store or forward the user's contact information.
- Do NOT invent facts or merge unrelated entries.
`.trim();

  let resp = await fetchJSON("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENAI_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: MODEL,
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: systemMsg
        },
        {
          role: "system",
          content: `Knowledge Base Candidates:\n${context}`
        },
        {
          role: "user",
          content: message
        }
      ]
    })
  }, 15000);

  // One quick retry on 5xx/network
  if (!resp.ok || resp.status >= 500) {
    resp = await fetchJSON("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENAI_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content: systemMsg
          },
          {
            role: "system",
            content: `Knowledge Base Candidates:\n${context}`
          },
          {
            role: "user",
            content: message
          }
        ]
      })
    }, 15000);
  }

  if (!resp.ok) {
    console.error("OpenAI error:", resp.status, resp.data);

    return res.status(502).json({
      reply: "Beklager – det oppstod et midlertidig problem med svaret.",
      unsure: true
    });
  }

  const data = resp.data;
  const reply =
    data?.choices?.[0]?.message?.content?.trim() ||
    "Beklager – jeg fikk ikke generert et svar.";

  logUsage({
    ts: new Date().toISOString(),
    client,
    origin,
    kind: "llm",
    in: message.length,
    out: reply.length
  });

  return res.json({
    reply,
    unsure: true,
    suggestions: kb.slice(0, 3).map(x => x.q)
  });
});

// -------------------- Start --------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ Server live on port ${PORT}`);
  });
}

module.exports = {
  app,
  publicDemoConfig,
  safeSlug
};
