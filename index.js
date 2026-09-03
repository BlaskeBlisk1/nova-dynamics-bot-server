// ================== Nova Dynamics Bot Server (multi-tenant) ==================
const express = require("express");
const fs = require("fs");
const path = require("path");

// Use Node 18+ global fetch or lazy-load node-fetch if needed
const fetchFn = global.fetch || ((...args) =>
  import("node-fetch").then(({ default: f }) => f(...args)));

const app = express();
app.set("trust proxy", 1);
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
const ENABLE_DEBUG_ROUTES = process.env.ENABLE_DEBUG_ROUTES === "true";

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
    accentSecondary: demo.accentSecondary || "#7c5cff",
    theme: demo.theme || "nova",
    eyebrow: demo.eyebrow || "NETTSIDEASSISTENT",
    contextTitle: demo.contextTitle || "Still et vanlig kundespørsmål",
    contextDescription: demo.contextDescription || "Prøv et forslag eller skriv spørsmålet slik en ekte kunde ville formulert det.",
    assistantLabel: demo.assistantLabel || "Digital assistent",
    assistantInitial: String(demo.assistantInitial || "N").slice(0, 2),
    statusLabel: demo.statusLabel || "Tilgjengelig nå",
    logo: demo.logo || "",
    locationLabel: demo.locationLabel || "",
    sourceTitle: demo.sourceTitle || "Bygget fra virksomhetens informasjon",
    sourceDescription: demo.sourceDescription || "Dette er en uforpliktende demonstrasjon.",
    highlights: Array.isArray(demo.highlights) ? demo.highlights.slice(0, 3) : [],
    suggestedQuestions: Array.isArray(demo.suggestedQuestions)
      ? demo.suggestedQuestions.slice(0, 6)
      : []
  };
}

// ---- HOTFIX fallback allowlist ----
const FALLBACK_ALLOWED = new Set([
  "https://nova-dynamics-bot-server.onrender.com",
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
  ["lørdag", "sat"], ["lordag", "sat"], ["lør", "sat"], ["lor", "sat"], ["saturday", "sat"],
  ["søndag", "sun"], ["sondag", "sun"], ["søn", "sun"], ["son", "sun"], ["sunday", "sun"]
]);

const SYNONYMS = new Map([
  ["åpent", "åpningstider"],
  ["åpne", "åpningstider"],
  ["åpning", "åpningstider"],
  ["apent", "åpningstider"],
  ["apne", "åpningstider"],
  ["apning", "åpningstider"],
  ["apningstid", "åpningstider"],
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

  ["døv", "tegnspråk"],
  ["døve", "tegnspråk"],
  ["dov", "tegnspråk"],
  ["dove", "tegnspråk"],
  ["hørselshemmet", "tegnspråk"],
  ["hørselshemmede", "tegnspråk"],
  ["horselshemmet", "tegnspråk"],
  ["horselshemmede", "tegnspråk"],
  ["tilrettelagt", "tegnspråk"],

  ["avbestille", "avbestilling"],
  ["avbestiller", "avbestilling"],
  ["avbestillingsfrist", "avbestilling"],
  ["avbestillingsfristen", "avbestilling"],
  ["kursoversikten", "kursoversikt"],
  ["elevsiden", "elevside"],
  ["oppkjøringen", "førerprøve"],
  ["oppkjoringen", "førerprøve"],

  ["grunnkurs", "trafikalt grunnkurs"],
  ["tg", "trafikalt grunnkurs"]
]);

function normalizeForMatching(str) {
  return String(str || "")
    .toLowerCase()
    .replaceAll("æ", "ae")
    .replaceAll("ø", "o")
    .replaceAll("å", "a")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function norm(str) {
  return normalizeForMatching(str)
    .replace(/[^\w\s\-]/g, " ")
    .replace(/-/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeTerm(w) {
  if (ROOT_DAY.has(w)) return ROOT_DAY.get(w);
  if (SYNONYMS.has(w)) return SYNONYMS.get(w);
  return w;
}

function tokens(str) {
  const normalized = norm(str);
  const base = normalized.split(" ").filter(Boolean);
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

  // English stop-word filtering normally removes the token "a". Preserve a
  // dedicated phrase token for motorcycle class A so it cannot rank as class
  // B or A1 simply because the class letter disappeared.
  const classTokens = /(?:^|\s)(?:klasse|class|mc)\s+a(?:\s|$)/.test(normalized)
    ? ["license_class_a"]
    : [];

  return uni.concat(bi, classTokens);
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

function requestedLicenseClass(input) {
  const raw = String(input || "").toLowerCase();
  const m = norm(input);

  if (/\b(lett\s+mc|lett\s+motorsykkel)\b/.test(raw)) return "a1";
  if (/(^|\s)a1(\s|$)/.test(m)) return "a1";
  if (/\b(mellomtung\s+mc|mellomtung\s+motorsykkel)\b/.test(raw)) return "a2";
  if (/(^|\s)a2(\s|$)/.test(m)) return "a2";
  if (/(^|\s)b96(\s|$)/.test(m)) return "b96";
  if (/(^|\s)be(\s|$)/.test(m)) return "be";
  if (
    /\b(tung\s+mc|tung\s+motorsykkel|klasse\s+a|a-klasse)\b/.test(raw) ||
    /\b(pris|koster|time|kjøretime|kjoretime|timer|kjøretimer|kjoretimer|pakke|sikkerhetskurs|førerprøve|forerprove|førerkort|forerkort|aldersgrense|ta)\s+(for\s+)?a\b/.test(raw) ||
    /\ba\s+(pris|time|kjøretime|kjoretime|pakke|sikkerhetskurs|førerprøve|forerprove|førerkort|forerkort|aldersgrense)\b/.test(raw) ||
    (/\b(pris|koster|time|kjøretime|kjoretime|timer|kjøretimer|kjoretimer|pakke|sikkerhetskurs|førerprøve|forerprove|førerkort|forerkort|alder|aldersgrense)\b/.test(raw) && /\ba\s*[?.!]*$/.test(raw)) ||
    /\bfor\s+a\b/.test(raw) ||
    /(^|\s)(klasse|class|mc)\s+a(\s|$)/.test(m) ||
    /(^|\s)a\s+(klasse\s+)?(time|kjoretime|forerkort|grunnkurs|trinn|sikkerhetskurs|pakke)(\s|$)/.test(m) ||
    /(^|\s)(time|kjoretime|forerkort|grunnkurs|trinn|sikkerhetskurs|pakke)\s+(for\s+)?a(\s|$)/.test(m) ||
    /(^|\s)trinn\s+[23]\s+(for\s+)?a(\s|$)/.test(m)
  ) return "a";
  if (
    /(^|\s)(klasse|class)\s+b(\s|$)/.test(m) ||
    /(^|\s)(bil|personbil|automat|manuell|biltime|automatkjoring)(\s|$)/.test(m) ||
    /(^|\s)b\s+(time|kjoretime|forerkort|pakke|trinn|sikkerhetskurs)(\s|$)/.test(m) ||
    /(^|\s)(time|kjoretime|forerkort|pakke|trinn|sikkerhetskurs)\s+(for\s+)?b(\s|$)/.test(m) ||
    /(^|\s)trinn\s+[23]\s+(for\s+)?b(\s|$)/.test(m)
  ) return "b";

  return null;
}

function entryMatchesLicenseClass(entry, requestedClass) {
  const m = norm(`${entry.q || ""} ${entry.a || ""}`);

  if (requestedClass === "a1") return /(^|\s)a1(\s|$)/.test(m);
  if (requestedClass === "a2") return /(^|\s)a2(\s|$)/.test(m);
  if (requestedClass === "b96") return /(^|\s)b96(\s|$)/.test(m);
  if (requestedClass === "be") return /(^|\s)be(\s|$)/.test(m);
  if (requestedClass === "a") return /(^|\s)(klasse|class)\s+a(\s|$)/.test(m);
  if (requestedClass === "b") return /(^|\s)(klasse|class)\s+b(\s|$)/.test(m);

  return true;
}

function rankFAQForQuestion(question, kb) {
  const ranked = rankFAQ_TFIDF(question, kb);
  const licenseClass = requestedLicenseClass(question);

  if (!licenseClass) return ranked;

  const matching = ranked.filter(entry => entryMatchesLicenseClass(entry, licenseClass));
  if (!matching.length) return ranked;

  const rest = ranked.filter(entry => !entryMatchesLicenseClass(entry, licenseClass));
  return matching.concat(rest);
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

function requireDebugRoutesEnabled(req, res, next) {
  if (!ENABLE_DEBUG_ROUTES) {
    return res.status(404).json({ error: "Not found." });
  }

  next();
}

app.get("/debug-kb", requireDebugRoutesEnabled, (req, res) => {
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

app.get("/debug-cors", requireDebugRoutesEnabled, (req, res) => {
  res.json({
    seenOrigin: req.headers.origin || null,
    fallbackAllowed: Array.from(FALLBACK_ALLOWED),
    registryClients: Object.keys(REGISTRY || {}),
    demoOrigins: (REGISTRY.demo && REGISTRY.demo.origins) || []
  });
});

app.get("/debug-intent", requireDebugRoutesEnabled, (req, res) => {
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

app.get("/debug-rank", requireDebugRoutesEnabled, (req, res) => {
  const client = safeSlug(req.query.client || "demo");
  const message = String(req.query.message || "");
  const kb = getKB(client);
  const intent = detectIntent(message);
  const queryForRanking = intent && intent !== "price"
    ? (intentQuery(intent) || message)
    : message;

  const ranked = rankFAQForQuestion(queryForRanking, kb).slice(0, 5);

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
  const m = normalizeForMatching(message);

  if (/\b(apent|apne|apen|aapent|apningstid|apningstider|opening|hours|open|stengt|closed|kontortid)\b/.test(m)) {
    return "opening_hours";
  }

  if (isEmergencyAddressQuestion(message)) {
    return "address";
  }

  if (/\b(telefon|tlf|telefonnummer|nummer|ringe|phone|call)\b/.test(m)) {
    return "phone";
  }

  if (/\b(epost|e-post|email|mail)\b/.test(m)) {
    return "email";
  }

  if (/\b(vipps|vips|vippos|kort|bankkort|kontant|cash|card|betaling|betale|betaler|payment|invoice|faktura)\b/.test(m)) {
    return "payment";
  }

  if (/(lager dere|selger dere|produkter|produktene|hva lager|hva selger|hva har dere|what do you make|what do you sell|products|menu|meny)/.test(m)) {
    return "products";
  }

  if (/(\bbestille\b|\bbestilling\b|\border\b|custom cake|spesialkake|\bkake\b|\bcake\b|\bpamelding\b|melde seg pa|\bbooking\b|\bbooke\b|bli elev)/.test(m)) {
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
  const m = normalizeForMatching(message);

  return /(\b(adresse|adressen|address|addressen|addresse|addres|addr|lokasjon|location)\b|hvor\s+ligger\s+(dere|skolen|trafikkskolen)|hvor\s+finner\s+(jeg\s+)?(dere|skolen|trafikkskolen)|hvor\s+er\s+(dere|skolen|trafikkskolen)|hvor\s+holder\s+(dere|skolen|trafikkskolen)\s+til|kor\s+er\s+(dokker|dere|skolen)|where\s+(are|is)\s+(you|the school)|where\s+can\s+i\s+find\s+you)/.test(m);
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
  const ascii = normalizeForMatching(raw);

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

function directOnsoyAnswer(client, message) {
  const c = String(client || "").toLowerCase().trim();

  if (c !== "onsoy") return null;

  const t = makeNorwegianSearchText(message);
  const normalizedMessage = norm(message);
  const rawMessage = String(message || "").toLowerCase();
  let licenseClass = requestedLicenseClass(message);
  if (/\b(?:ta|få|fa|skaffe)\s+(?:klasse\s+)?a\b/.test(rawMessage)) {
    licenseClass = "a";
  }
  const mentionsA1 = /(^|\s)a1(\s|$)/.test(normalizedMessage);
  const mentionsA2 = /(^|\s)a2(\s|$)/.test(normalizedMessage);
  const mentionsA = /(^|\s)(?:klasse\s+)?a(\s|$)/.test(normalizedMessage);
  const hasCalendarDate =
    /\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/.test(rawMessage) ||
    /\b\d{4}-\d{1,2}-\d{1,2}\b/.test(rawMessage);
  const hasNamedCourseDate =
    includesAny(t, ["kurs", "tgk", "mc-grunnkurs", "førstehjelp", "forstehjelp", "mørkekjøring", "morkekjoring"]) &&
    /\b\d{1,2}\.?\s+(januar|februar|mars|april|mai|juni|juli|august|september|oktober|november|desember)\b/.test(rawMessage);
  const statedAgeMatch = normalizedMessage.match(/\b(?:jeg er|alder)\s+(\d{1,2})(?:\s+ar)?\b/);
  const statedAge = statedAgeMatch ? Number(statedAgeMatch[1]) : null;
  const isAtLeast25 =
    includesAny(t, ["over 25", "fylt 25", "eldre enn 25"]) ||
    (Number.isInteger(statedAge) && statedAge >= 25);
  const asksA1ToA2 =
    includesAny(t, ["a1 til a2", "fra a1 til a2"]) ||
    /\ba1\s*(?:-|–|—|\/|->)\s*a2\b/.test(rawMessage);
  const asksA2ToA =
    includesAny(t, ["a2 til a", "fra a2 til a"]) ||
    /\ba2\s*(?:-|–|—|\/|->)\s*a\b/.test(rawMessage);
  const known = reply => ({ reply, unsure: false });
  const unknown = detail => ({
    reply: `Jeg finner ikke et sikkert svar på det i de verifiserte kildene demoen bruker.${detail ? ` ${detail}` : ""} Du kan kontakte Onsøy Trafikkskole på 92 98 99 98 eller post@onsoytrafikkskole.no.`,
    unsure: true
  });
  const asksPrice = includesAny(t, [
    "pris", "priser", "prisen", "prisene", "koster", "kostnad", "hvor mye", "betale", "price", "cost"
  ]);
  if (!licenseClass && asksPrice && /(^|\s)(b|baut)(\s|$)/.test(normalizedMessage)) {
    licenseClass = "b";
  }
  const asksTrafficBasicCourse = includesAny(t, ["trafikalt grunnkurs", "trafikalt grunnkurset", "tgk"]) ||
    /(^|\s)tg(\s|$)/.test(normalizedMessage);
  const asksDrivingTest = includesAny(t, [
    "førerprøve", "forerprove", "oppkjøring", "oppkjoring", "praktisk prøve", "praktisk prove"
  ]);
  const asksMotorcycle = ["a", "a1", "a2"].includes(licenseClass) || includesAny(t, [
    "mc", "motorsykkel", "motorsykkelen", "a1", "a2", "tung mc", "lett mc", "mellomtung"
  ]) || /(^|\s)klasse a(\s|$)/.test(normalizedMessage);
  const asksCar = licenseClass === "b" || includesAny(t, ["bil", "automat", "manuell", "baut"]);

  // The current demo only answers questions; it must never appear to capture a
  // lead or echo personal data that a visitor has entered into the chat.
  const enteredEmails = rawMessage.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || [];
  const enteredEmail = enteredEmails.some(email => email.toLowerCase() !== "post@onsoytrafikkskole.no");
  const phoneScanText = rawMessage
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ");
  const enteredNumberCandidates = phoneScanText.match(/(?:^|\D)(?:\+?\d[\s.-]*){8,11}(?!\d)/g) || [];
  const enteredLongNumber = enteredNumberCandidates.some(candidate => {
    const digits = candidate.replace(/\D/g, "");
    return digits !== "92989998" && digits !== "4792989998";
  });
  const asksToStoreOrContact = includesAny(t, [
    "lagre kontakt", "lagre navnet", "lagre e-post", "lagre epost", "lagre telefon",
    "kontakt meg", "ring meg", "ringe meg", "ring meg tilbake", "ringe meg tilbake",
    "kan dere ringe", "tilbakeringing", "navnet mitt", "jeg heter", "min e-post", "min epost",
    "mitt telefonnummer", "telefonnummeret mitt", "send svaret til", "fødselsnummer", "fodselsnummer",
    "personopplysning", "fylle inn e-post", "fylle inn epost", "skrive e-post", "skrive epost",
    "send henvendelsen", "sende henvendelsen", "videresend meldingen", "videresende meldingen",
    "videresend henvendelsen", "videresende henvendelsen", "min adresse", "adressen min"
  ]);

  if (includesAny(t, ["ip-adresse", "ip adresse", "ip-adressen", "dataene mine", "behandles data", "personvern"])) {
    return known("Demoen lagrer ikke selve spørsmålet i bruksloggen. En teknisk nettverksadresse behandles midlertidig for å begrense misbruk. Ikke skriv sensitive personopplysninger i chatten; kontakt Nova Dynamics dersom du trenger flere detaljer om behandlingen.");
  }

  if (enteredEmail || enteredLongNumber || asksToStoreOrContact) {
    return known("Denne demoen kan ikke lagre, videresende eller følge opp navn, telefonnummer, e-post eller andre personopplysninger. Ikke skriv sensitive opplysninger i chatten. Kontakt skolen direkte på 92 98 99 98 eller post@onsoytrafikkskole.no.");
  }

  // Questions about policies that are not published must not be guessed from
  // another school or allowed to fall through to the language model.
  if (includesAny(t, ["avbestill", "avlys", "kanseller", "kansellere", "endre kjøretime", "flytte kjøretime"])) {
    return unknown("Avbestillingsfristen er ikke tydelig oppgitt; kontroller vilkårene i TABS før du endrer en time.");
  }

  if (includesAny(t, ["vipps", "vips", "delbetaling", "betalingsmåte", "betalingsmate", "faktura", "kontant"])) {
    return unknown("Betalingsmåter og eventuelle ordninger for delbetaling er ikke tydelig oppgitt.");
  }

  if (
    includesAny(t, ["hvor lenge varer", "varighet", "lengde på", "lengden på"]) &&
    includesAny(t, ["kjøretime", "kjoretime", "time"])
  ) {
    return unknown("Varigheten på en vanlig kjøretime er ikke tydelig publisert.");
  }

  if (includesAny(t, ["henter dere", "hente meg", "henting", "hentetjeneste", "oppmøtested", "oppmotested"])) {
    return unknown("Nettsiden oppgir ikke en generell hentetjeneste eller faste oppmøtesteder.");
  }

  if (
    includesAny(t, ["engelsk", "english", "språk", "sprak"]) &&
    includesAny(t, ["opplæring", "opplaering", "undervisning", "tilbyr", "kurs"])
  ) {
    return unknown("Det er ikke tydelig publisert hvilke undervisningsspråk skolen tilbyr.");
  }

  if (
    includesAny(t, ["booke", "bestille", "melde meg på", "melde meg pa"]) &&
    includesAny(t, ["kan du", "kan chatten", "gjør det", "gjor det", "for meg"])
  ) {
    return known("Jeg kan ikke booke en kjøretime eller melde deg på. Send en forespørsel gjennom TABS, eller kontakt skolen på 92 98 99 98 eller post@onsoytrafikkskole.no.");
  }

  // The motorcycle department is listed at FMV, but no separate street
  // address is published. Handle this before the general address answer.
  if (
    includesAny(t, ["mc-avdeling", "mc avdeling", "motorsykkelavdeling", "motorsykkel avdeling", "fmv"]) &&
    includesAny(t, ["adresse", "gateadresse", "oppgitt", "hvor ligger", "hvor er"])
  ) {
    return known("MC-avdelingen er oppgitt å ligge på FMV-området i Fredrikstad, men en egen gateadresse er ikke publisert i kildene demoen bruker. Kontakt skolen før oppmøte.");
  }

  if (includesAny(t, ["mc-avdeling", "mc avdeling", "motorsykkelavdeling", "motorsykkel avdeling", "fmv-området", "fmv omradet"])) {
    return known("Onsøy Trafikkskoles MC-avdeling holder til på FMV-området i Fredrikstad.");
  }

  if (includesAny(t, ["hvilket bygg", "hva slags bygg", "family treningssenter", "family-bygget"])) {
    return known("Kontoret ligger i Freskoveien 16, i bygget til Family treningssenter i Fredrikstad.");
  }

  if (includesAny(t, ["nettsiden deres", "nettside", "hjemmeside", "webside", "website"])) {
    return known("Den offisielle nettsiden til Onsøy Trafikkskole er https://onsoytrafikkskole.no/.");
  }

  if (includesAny(t, ["e-postadresse", "epostadresse", "e-postadressen", "epostadressen", "e-post", "epost", "email", "mailadresse", "mailen", "mail"])) {
    return known("Skolens felles e-postadresse er post@onsoytrafikkskole.no.");
  }

  if (includesAny(t, ["telefonnummer", "telefon", "tlf", "ringe"])) {
    return known("Telefonnummeret til Onsøy Trafikkskole er 92 98 99 98.");
  }

  if (includesAny(t, ["hvordan kontakter", "ta kontakt", "kontaktinformasjon", "kontakte dere", "kontakte skolen"])) {
    return known("Du kan kontakte Onsøy Trafikkskole på telefon 92 98 99 98 eller e-post post@onsoytrafikkskole.no.");
  }

  if (
    includesAny(t, ["åpningstid", "apningstid", "kontortid", "åpent", "apent", "åpne", "apne", "stengt", "stenger"]) ||
    (/\b(mandag|tirsdag|onsdag|torsdag|fredag)\b/.test(t.raw) && includesAny(t, ["kontor", "åpen", "apen", "åpent", "apent"]))
  ) {
    return known("Kontoret er oppgitt å være åpent mandag–torsdag kl. 09.00–15.00. Fredag er ikke oppført som kontordag. Kontakt skolen før oppmøte dersom du vil kontrollere at noen er til stede.");
  }

  if (
    isEmergencyAddressQuestion(message) ||
    includesAny(t, ["besøksadresse", "besoksadresse", "freskoveien", "ligger skolen", "ligger trafikkskolen"])
  ) {
    return known("Onsøy Trafikkskole holder til i Freskoveien 16, 1605 Fredrikstad, i bygget til Family treningssenter.");
  }

  // Explicitly rule out classes that do not appear in the published offer.
  if (/(^|\s)(be|b96)(\s|$)/.test(normalizedMessage)) {
    return known("BE og B96 er ikke oppført blant førerkortklassene Onsøy Trafikkskole tilbyr på den publiserte nettsiden.");
  }

  if (includesAny(t, ["moped", "am146", "am 146"])) {
    return known("Mopedopplæring er ikke oppført blant tilbudene på Onsøy Trafikkskoles publiserte nettside.");
  }

  if (includesAny(t, ["lastebil", "tungbil", "buss", "traktor", "klasse c", "klasse d"])) {
    return known("Lastebil-, buss- og traktoropplæring er ikke oppført blant tilbudene på Onsøy Trafikkskoles publiserte nettside.");
  }

  const asksForLink = includesAny(t, ["lenke", "link"]);

  if (asksForLink && includesAny(t, ["pris", "prisene", "prisliste", "prislisten"])) {
    return known("Her er skolens oppdaterte prisliste i TABS: https://onsoytrafikkskole.tabs.no/. Velg førerkortklasse for å se de relevante prisene.");
  }

  if (asksForLink && includesAny(t, ["kurs", "kursene", "kursoversikt"])) {
    return known("Her er skolens oppdaterte kursoversikt i TABS: https://onsoytrafikkskole.tabs.no/kursoversikt.");
  }

  if (asksForLink && includesAny(t, ["booking", "bestilling", "bestille", "opplæring", "opplaering"])) {
    return known("Du kan sende en forespørsel om opplæring via TABS: https://onsoytrafikkskole.tabs.no/. Skolen følger opp forespørselen.");
  }

  // Dynamic course availability must always point at the live TABS view.
  if (
    includesAny(t, ["neste kurs", "neste trafikale grunnkurs", "kursdato", "kursoversikt", "ledige plasser", "ledig plass"]) ||
    (asksTrafficBasicCourse && includesAny(t, ["når er neste", "nar er neste", "når starter", "nar starter", "neste tg", "dato", "ledig"])) ||
    includesAny(t, ["neste mc-grunnkurs", "neste mc grunnkurs", "neste motorsykkelgrunnkurs", "neste mørkekjøring", "neste morkekjoring", "neste førstehjelp", "neste forstehjelp"]) ||
    (asksTrafficBasicCourse && includesAny(t, ["i morgen", "neste uke"])) ||
    ((hasCalendarDate || hasNamedCourseDate) && includesAny(t, ["kurs", "tgk", "førstehjelp", "forstehjelp", "mørkekjøring", "morkekjoring"])) ||
    (includesAny(t, ["melder jeg meg på kurs", "melde meg på kurs", "melde meg pa kurs", "påmelding til kurs", "pamelding til kurs"]))
  ) {
    return known("Kursdatoer og ledige plasser endres. Se den oppdaterte kursoversikten i TABS: https://onsoytrafikkskole.tabs.no/kursoversikt. Der kan du også gå videre med påmelding.");
  }

  if (includesAny(t, ["elevside", "elevsiden", "elev side", "logger", "logge inn", "innlogging"])) {
    return known("Eksisterende elever logger inn på TABS Elevside: https://tabs.no/start.");
  }

  if (
    !asksPrice &&
    isAtLeast25 &&
    (asksTrafficBasicCourse || includesAny(t, ["førstehjelp", "forstehjelp", "mørkekjøring", "morkekjoring"]))
  ) {
    return known("Har du fylt 25 år, er du fritatt fra selve trafikale grunnkurset, men må fortsatt gjennomføre førstehjelp og Trafikant i mørket. Kilde: Statens vegvesen.");
  }

  if (
    !asksPrice &&
    asksTrafficBasicCourse &&
    includesAny(t, ["hva er", "må jeg", "ma jeg", "trenger jeg", "første steg", "forste steg"])
  ) {
    return known("Trafikalt grunnkurs er første trinn i føreropplæringen. Før du kan øvelseskjøre, må du normalt ha gjennomført kurset og fått øvelseskjøringsbevis. Kilde: Statens vegvesen.");
  }

  if (
    !asksPrice &&
    includesAny(t, ["mørkekjøring", "morkekjoring", "trafikant i mørket", "trafikant i morket"]) &&
    includesAny(t, ["når kan", "nar kan", "sesong", "sommer", "vinter"])
  ) {
    return known("Statens vegvesen opplyser at det ikke er mørkt nok til Trafikant i mørket mellom 16. mars og 31. oktober. Se skolens oppdaterte kursoversikt for aktuelle datoer.");
  }

  const staffAnswers = [
    [/\beinar\b/, "Einar Oliver Udnæs Lie er oppført som trafikklærer hos Onsøy Trafikkskole."],
    [/\bmari\b/, "Mari Fernanda Thøgersen er oppført som trafikklærer hos Onsøy Trafikkskole."],
    [/\brenate\b/, "Renate Tomasli er oppført som kontoransvarlig hos Onsøy Trafikkskole."]
  ];
  const staffAnswer = staffAnswers.find(([namePattern]) => namePattern.test(normalizedMessage));

  if (staffAnswer) return known(staffAnswer[1]);

  if (includesAny(t, ["hvem jobber", "ansatte", "trafikklærere", "trafikklaerere", "lærere", "laerere", "teamet"])) {
    return known("Ansattoversikten oppgir Einar Oliver Udnæs Lie og Mari Fernanda Thøgersen som trafikklærere, og Renate Tomasli som kontoransvarlig.");
  }

  if (includesAny(t, ["hvaler tgk", "tgk hvaler", "hvaler grunnkurs", "grunnkurs hvaler"])) {
    return known("Onsøy Trafikkskoles nettside lenker til Hvaler TGK. Datoer, sted og ledige plasser kan endres, så kontroller den oppdaterte kursoversikten i TABS: https://onsoytrafikkskole.tabs.no/kursoversikt.");
  }

  // Prices below are unambiguous values from the school's open TABS list.
  if (
    asksPrice &&
    asksTrafficBasicCourse &&
    includesAny(t, ["uten mørkekjøring", "uten morkekjoring", "uten trafikant i mørket", "uten trafikant i morket"])
  ) {
    return unknown("En separat pris for trafikalt grunnkurs uten Trafikant i mørket er ikke tydelig publisert. Den generelle kombinasjonen med Trafikant i mørket står til 3 950 kr i TABS.");
  }

  if (asksPrice && asksTrafficBasicCourse && includesAny(t, ["mørkekjøring", "morkekjoring", "trafikant i mørket", "trafikant i morket"])) {
    return known("Trafikalt grunnkurs med mørkekjøring er oppført til 3 950 kr. Kontroller alltid den oppdaterte prisen i TABS før bestilling.");
  }

  if (asksPrice && asksTrafficBasicCourse) {
    return known("Trafikalt grunnkurs inkludert Trafikant i mørket er oppført til 3 950 kr i den generelle prislisten. En konkret kursdato kan ha en annen pris, så kontroller alltid den aktuelle oppføringen i TABS før påmelding.");
  }

  if (
    asksPrice &&
    includesAny(t, ["førstehjelp", "forstehjelp", "førstehjelpskurs", "forstehjelpskurs"]) &&
    includesAny(t, ["mørkekjøring", "morkekjoring", "trafikant i mørket", "trafikant i morket"])
  ) {
    return known("Førstehjelp er oppført til 875 kr, og Trafikant i mørket er oppført til 1 900 kr. Kontroller alltid de aktuelle prisene i TABS før påmelding.");
  }

  if (asksPrice && includesAny(t, ["førstehjelp", "forstehjelp", "førstehjelpskurs", "forstehjelpskurs"])) {
    return known("Førstehjelpskurset er oppført til 875 kr. Kontroller alltid den oppdaterte prisen i TABS før bestilling.");
  }

  if (asksPrice && includesAny(t, ["mørkekjøring", "morkekjoring", "trafikant i mørket", "trafikant i morket"])) {
    return known("Mørkekjøring, også kalt trafikant i mørket, er oppført til 1 900 kr. Kontroller alltid den oppdaterte prisen i TABS før bestilling.");
  }

  if (asksPrice && asksA1ToA2) {
    return unknown("Onsøy tilbyr overgang fra A1 til A2, men en egen pris for denne utvidelsen er ikke tydelig publisert i den åpne prislisten.");
  }

  if (asksPrice && asksA2ToA) {
    return known("Utvidelse fra klasse A2 til A er oppført til 7 500 kr. Kontroller hvilken opplæring som gjelder for deg og den oppdaterte prisen i TABS.");
  }

  if (
    asksPrice &&
    (
      includesAny(t, ["mc-grunnkurs", "mc grunnkurs", "motorsykkelgrunnkurs", "motorsykkel grunnkurs", "obligatorisk mc-kurs", "obligatorisk mc kurs"]) ||
      (["a", "a1", "a2"].includes(licenseClass) && includesAny(t, ["grunnkurs"]))
    )
  ) {
    return known("MC-grunnkurset er oppført til 1 400 kr. Kontroller alltid den oppdaterte prisen i TABS før bestilling.");
  }

  if (asksPrice && includesAny(t, ["trinnvurdering", "trinn vurdering"]) && includesAny(t, ["trinn 2", "trinnvurdering 2"])) {
    if (asksMotorcycle) {
      return known("Trinnvurdering på trinn 2 for MC er oppført til 1 160 kr. Kontroller alltid den valgte MC-klassen i TABS.");
    }

    if (licenseClass === "b") {
      return known("Trinnvurdering på trinn 2 for klasse B er oppført til 930 kr, både for manuelt gir og automat.");
    }

    return known("Trinnvurdering på trinn 2 er oppført til 930 kr for klasse B og 1 160 kr for MC. Oppgi B, A1, A2 eller A for et entydig svar.");
  }

  if (asksPrice && includesAny(t, ["trinnvurdering", "trinn vurdering"]) && includesAny(t, ["trinn 3", "trinnvurdering 3"])) {
    if (asksMotorcycle) {
      return known("Trinnvurdering på trinn 3 for MC er oppført til 1 540 kr. Kontroller alltid den valgte MC-klassen i TABS.");
    }

    if (licenseClass === "b") {
      return known("Trinnvurdering på trinn 3 for klasse B er oppført til 1 220 kr, både for manuelt gir og automat.");
    }

    return known("Trinnvurdering på trinn 3 er oppført til 1 220 kr for klasse B og 1 540 kr for MC. Oppgi B, A1, A2 eller A for et entydig svar.");
  }

  if (
    asksPrice &&
    includesAny(t, ["øvingsbane", "ovingsbane", "glattkjøring", "glattkjoring"]) &&
    !asksMotorcycle &&
    (licenseClass === "b" || includesAny(t, ["bil"]))
  ) {
    return known("Sikkerhetskurs på øvingsbane i klasse B, inkludert NAF-gebyr, er oppført til 6 650 kr.");
  }

  if (
    asksPrice &&
    includesAny(t, ["sikkerhetskurs på veg", "sikkerhetskurs pa veg", "sikkerhetskurs på vei", "sikkerhetskurs pa vei", "sikkerhetskurs vei"]) &&
    !asksMotorcycle &&
    licenseClass === "b"
  ) {
    return known("Sikkerhetskurs på veg i klasse B er oppført til 11 375 kr.");
  }

  if (asksPrice && includesAny(t, ["sikkerhetskurs i trafikk", "trafikksikkerhetskurs"]) && /(^|\s)a1(\s|$)/.test(normalizedMessage)) {
    return known("Sikkerhetskurs i trafikk for klasse A1 er oppført til 4 650 kr.");
  }

  if (asksPrice && includesAny(t, ["presis kjøreteknikk", "presis kjoreteknikk", "presisjonskjøring", "presisjonskjoring"])) {
    if (["a2", "a"].includes(licenseClass)) {
      return known("Sikkerhetskurs i presis kjøreteknikk for A2 og A, inkludert gebyr, er oppført til 7 250 kr. Kontroller valgt klasse i TABS før bestilling.");
    }

    return unknown("Prisen avhenger av MC-klassen; velg klasse i TABS for riktig kurs.");
  }

  if (asksPrice && includesAny(t, ["sikkerhetskurs på veg", "sikkerhetskurs pa veg", "sikkerhetskurs på vei", "sikkerhetskurs pa vei", "sikkerhetskurs vei"]) && asksMotorcycle) {
    if ([mentionsA1, mentionsA2, mentionsA].filter(Boolean).length > 1) {
      return known("Sikkerhetskurs på veg er oppført til 5 800 kr for A1 og A2, og 9 100 kr for A. Kontroller de valgte klassene i TABS før bestilling.");
    }

    if (licenseClass === "a") {
      return known("Sikkerhetskurs på veg for klasse A er oppført til 9 100 kr.");
    }
    if (licenseClass === "a1") return known("Sikkerhetskurs på veg for klasse A1 er oppført til 5 800 kr.");
    if (licenseClass === "a2") return known("Sikkerhetskurs på veg for klasse A2 er oppført til 5 800 kr.");
    return unknown("Prisen avhenger av om du mener A1, A2 eller A; velg klasse i TABS for riktig kurs.");
  }

  if (asksPrice && includesAny(t, ["sikkerhetskurs på veg", "sikkerhetskurs pa veg", "sikkerhetskurs på vei", "sikkerhetskurs pa vei", "sikkerhetskurs vei"])) {
    return known("Sikkerhetskurs på veg er oppført til 11 375 kr for klasse B, 5 800 kr for A1 og A2, og 9 100 kr for A. Oppgi klasse for et entydig svar.");
  }

  if (asksPrice && includesAny(t, ["øvingsbane", "ovingsbane", "glattkjøring", "glattkjoring"])) {
    return unknown("For klasse B er øvingsbanen inkludert NAF-gebyr oppført til 6 650 kr. MC bruker andre kursnavn, så oppgi klasse dersom du mener motorsykkel.");
  }

  if (
    asksPrice &&
    asksDrivingTest &&
    !asksMotorcycle &&
    (licenseClass === "b" || includesAny(t, ["bil"]))
  ) {
    return known("Førerprøve med 90 minutter oppvarming og leie av bil er oppført til 4 450 kr for klasse B og BAut. Offentlige prøvegebyrer kan komme i tillegg.");
  }

  if (asksPrice && includesAny(t, ["landeveismiljø", "landeveismiljo", "4.1.2", "landevei"])) {
    return known("Del 4.1.2, kjøring i landeveismiljø, er oppført til 4 725 kr for klasse B og BAut.");
  }

  if (asksPrice && includesAny(t, ["variert miljø", "variert miljo", "4.1.3", "planlegging og kjøring", "planlegging og kjoring"])) {
    return known("Del 4.1.3, planlegging og kjøring i variert miljø, er oppført til 3 750 kr for klasse B og BAut.");
  }

  if (asksPrice && includesAny(t, ["mc-kjøretime", "mc kjøretime", "mc-kjoretime", "mc kjoretime", "motorsykkeltime"])) {
    return known("En MC-kjøretime er oppført til 1 160 kr. Kontroller alltid den valgte klassen og oppdaterte prisen i TABS.");
  }

  if (
    asksPrice &&
    asksCar &&
    asksMotorcycle &&
    includesAny(t, ["kjøretime", "kjoretime", "timepris", "time pris", "vanlig time", "time på", "time pa", "b time", "a time"])
  ) {
    return known("En kjøretime er oppført til 930 kr for klasse B og 1 160 kr for A1, A2 og A.");
  }

  if (
    asksPrice &&
    asksMotorcycle &&
    includesAny(t, ["kjøretime", "kjoretime", "timepris", "time pris", "vanlig time", "time på", "time pa", "a time"])
  ) {
    return known("En kjøretime for A1, A2 eller A er oppført til 1 160 kr. Kontroller alltid den valgte klassen og oppdaterte prisen i TABS.");
  }

  if (
    asksPrice &&
    includesAny(t, ["kjøretime", "kjoretime", "automat-time", "automat time", "timepris", "time pris", "b time"]) &&
    !asksMotorcycle &&
    (licenseClass === "b" || includesAny(t, ["bil", "automat", "manuell"]))
  ) {
    return known("En kjøretime i klasse B er oppført til 930 kr, både for manuelt gir og automat.");
  }

  if (asksPrice && asksDrivingTest && asksMotorcycle) {
    return known("Førerprøve med 90 minutter oppvarming og leie av motorsykkel er oppført til 5 100 kr for A1 og 5 110 kr for A2/A. Offentlige prøvegebyrer kan komme i tillegg.");
  }

  if (asksPrice && includesAny(t, ["kjøretime", "kjoretime", "timepris", "time pris", "vanlig time", "b time", "a time"])) {
    return known("En kjøretime er oppført til 930 kr for klasse B og 1 160 kr for A1, A2 og A. Oppgi klasse for et entydig svar.");
  }

  if (asksPrice && asksDrivingTest) {
    return known("Skolens førerprøvepris med 90 minutter oppvarming og kjøretøy er oppført til 4 450 kr for klasse B, 5 100 kr for A1 og 5 110 kr for A2/A. Oppgi klasse for et entydig svar; offentlige gebyrer kan komme i tillegg.");
  }

  if (includesAny(t, ["prisene alltid", "pris alltid", "prisene faste", "kan prisen endres", "kan prisene endres", "oppdatert pris"])) {
    return known("Prisene er hentet fra skolens åpne TABS-prisliste, men de kan endres. Kontroller alltid den oppdaterte prisen i TABS før bestilling.");
  }

  if (includesAny(t, ["prisliste", "prislisten", "prisoversikt", "oppdaterte priser", "alle priser"])) {
    return known("Den oppdaterte prislisten finner du i TABS: https://onsoytrafikkskole.tabs.no/. Velg førerkortklasse for å se relevante priser.");
  }

  if (asksPrice && includesAny(t, ["totalpris", "totalt", "hele førerkortet", "hele forerkortet", "førerkortet", "forerkortet", "lappen"])) {
    return known("Jeg kan ikke oppgi en sikker totalpris for førerkortet. Totalprisen varierer fordi behovet for kjøretimer er individuelt. Bruk prislisten i TABS og be skolen vurdere opplæringsbehovet ditt.");
  }

  if (asksPrice && ["a", "a1", "a2", "b"].includes(licenseClass)) {
    return known(`Det finnes ikke én samlet pris for klasse ${licenseClass.toUpperCase()}; beløpet avhenger av hvilken time eller hvilket kurs du mener og hvor mye opplæring du trenger. Velg klassen i TABS-prislisten, eller skriv for eksempel «kjøretime ${licenseClass.toUpperCase()}».`);
  }

  if (asksPrice && includesAny(t, ["baut"])) {
    return known("Det finnes ikke én samlet pris for BAut; beløpet avhenger av hvilken time eller hvilket kurs du mener og hvor mye opplæring du trenger. Velg BAut i TABS-prislisten, eller spør for eksempel om prisen på en kjøretime.");
  }

  // Published motorcycle classes, transitions and age/vehicle definitions.
  if (asksA1ToA2) {
    return known("Ja. Onsøy Trafikkskole opplyser at de tilbyr overgang fra klasse A1 til A2.");
  }

  if (asksA2ToA) {
    return known("Ja. Onsøy Trafikkskole opplyser at de tilbyr overgang fra klasse A2 til A.");
  }

  if (
    includesAny(t, ["automat", "automatgir", "manuell", "manuelt gir", "kode 78"]) &&
    includesAny(t, ["forskjell", "kode 78", "kjøre manuell", "kjore manuell", "gjelder bare"])
  ) {
    return known("Kjører du opp med automatgir, får førerkortet kode 78 og kan bare kjøre automat. For å få rett til å kjøre manuelt gir må du senere bestå en ny førerprøve med manuelt gir. Kilde: Statens vegvesen.");
  }

  if (includesAny(t, ["hvor mange kjøretimer", "hvor mange kjoretimer", "antall kjøretimer", "antall kjoretimer"])) {
    return known("Antall kjøretimer vurderes individuelt ut fra ferdighetene dine og hvor mye du øvelseskjører privat. Det finnes ikke ett fast antall som passer alle.");
  }

  if (
    licenseClass === "a" &&
    Number.isInteger(statedAge) &&
    includesAny(t, ["har hatt a2 i to år", "har hatt a2 i 2 år", "har hatt a2 i to ar", "har hatt a2 i 2 ar"])
  ) {
    if (statedAge >= 20) {
      return known("Har du fylt 20 år og hatt klasse A2 i minst to år, kan du utvide til klasse A gjennom den obligatoriske overgangsopplæringen. Onsøy opplyser at de tilbyr A2–A; kontakt skolen for å planlegge løpet. Kilde: Statens vegvesen.");
    }

    return known("For å utvide fra A2 til A må du ha hatt A2 i minst to år og ha fylt 20 år. Kontakt skolen for å planlegge riktig løp. Kilde: Statens vegvesen.");
  }

  if (
    licenseClass === "a" &&
    Number.isInteger(statedAge) &&
    statedAge < 24 &&
    includesAny(t, ["uten a2", "har ikke a2", "direkte", "kan jeg ta"])
  ) {
    return known("Direkte minstealder for klasse A er normalt 24 år. Før det kan utvidelse være mulig etter minst to år med A2. Kilde: Statens vegvesen.");
  }

  if (includesAny(t, ["aldersgrense", "hvor gammel", "minstealder", "alder"]) && licenseClass === "a1") {
    return known("Minstealderen for førerkort klasse A1 er 16 år.");
  }

  if (includesAny(t, ["aldersgrense", "hvor gammel", "minstealder", "alder"]) && licenseClass === "a2") {
    return known("Minstealderen for førerkort klasse A2 er 18 år.");
  }

  if (
    includesAny(t, ["aldersgrense", "hvor gammel", "minstealder", "alder"]) &&
    licenseClass === "a"
  ) {
    return known("Onsøy Trafikkskole oppgir 24 år som aldersgrense for å ta klasse A direkte. Har du hatt A2 i minst to år, kan andre overgangsregler gjelde.");
  }

  if (/\b(a1|lett mc|lett motorsykkel)\b/.test(normalizedMessage) && includesAny(t, ["hva er", "hva kan", "størrelse", "stor", "effekt", "ccm", "betyr"])) {
    return known("Klasse A1 gjelder lett motorsykkel med høyst 125 ccm, effekt på høyst 11 kW og forhold mellom effekt og egenvekt på høyst 0,1 kW/kg.");
  }

  if (/\b(a2|mellomtung mc|mellomtung motorsykkel)\b/.test(normalizedMessage) && includesAny(t, ["hva betyr", "hva er", "effekt", "mellomtung"])) {
    return known("Klasse A2 gjelder mellomtung motorsykkel med effekt på høyst 35 kW og forhold mellom effekt og egenvekt på høyst 0,2 kW/kg.");
  }

  if (
    (/(^|\s)klasse a(\s|$)/.test(normalizedMessage) || includesAny(t, ["tung mc", "tung motorsykkel"])) &&
    includesAny(t, ["hva er", "hva betyr", "hva kan", "effektbegrensning"])
  ) {
    return known("Klasse A gjelder tung motorsykkel uten effektbegrensningen som gjelder for A1 og A2. Direkte minstealder er normalt 24 år. Kilde: Statens vegvesen.");
  }

  if (
    !asksPrice &&
    includesAny(t, ["mc-grunnkurs", "mc grunnkurs", "motorsykkelgrunnkurs", "motorsykkel grunnkurs"]) &&
    includesAny(t, ["hva er", "må jeg", "ma jeg", "obligatorisk", "samme kurs", "én gang", "en gang"])
  ) {
    return known("Før praktisk MC-opplæring må du gjennomføre et obligatorisk teoretisk MC-grunnkurs. Kurset er det samme for A1, A2 og A og tas bare én gang. Kilde: Statens vegvesen.");
  }

  if (includesAny(t, ["vegvesen-gebyr", "vegvesen gebyr", "offentlig gebyr", "offentlige gebyr", "teoriprøvegebyr", "teoriprovegebyr"])) {
    return known("Skolens oppførte førerprøvepris dekker oppvarming og leie av kjøretøy slik det står i TABS. Kontroller eventuelle offentlige prøve- og førerkortgebyrer separat hos Statens vegvesen.");
  }

  if (asksDrivingTest && /(^|\s)a2(\s|$)/.test(normalizedMessage)) {
    return known("For klasse A2 må du gjennomføre obligatorisk opplæring og bestå en praktisk førerprøve. Kontakt skolen for å planlegge løpet.");
  }

  if (
    (
      includesAny(t, ["mc-klasser", "mc klasser", "motorsykkel", "opplæring på mc", "opplaering pa mc"]) ||
      /(^|\s)mc(\s|$)/.test(normalizedMessage) ||
      (
        /(^|\s)(a1|a2)(\s|$)/.test(normalizedMessage) &&
        includesAny(t, ["har dere", "tar dere", "tilbyr", "kan jeg ta", "kan jeg få", "kan jeg fa", "opplæring", "opplaering"])
      )
    ) &&
    !asksPrice
  ) {
    return known("Onsøy Trafikkskole tilbyr motorsykkelklassene A1, A2 og A.");
  }

  if (
    !asksPrice &&
    includesAny(t, ["har dere", "tar dere", "tilbyr", "kan jeg ta", "kan jeg få", "kan jeg fa", "opplæring", "opplaering"]) &&
    (
      asksCar ||
      (licenseClass === "a" && includesAny(t, ["klasse a", "tung mc", "tung motorsykkel"]))
    )
  ) {
    if (licenseClass === "a") {
      return known("Ja. Onsøy Trafikkskole tilbyr klasse A for tung motorsykkel, i tillegg til A1 og A2.");
    }

    return known("Ja. Onsøy Trafikkskole tilbyr klasse B med både manuelt gir og automat.");
  }

  if (
    includesAny(t, ["forskjellen på b og baut", "forskjell på b og baut", "forskjell b og baut"]) ||
    (includesAny(t, ["forskjell"]) && /(^|\s)b(\s|$)/.test(normalizedMessage) && includesAny(t, ["baut"]))
  ) {
    return known("Klasse B med manuelt gir gir rett til å kjøre både manuell og automat. Tar du førerprøven med automatgir, får førerkortet kode 78 og kan bare kjøre automat inntil du eventuelt består en ny førerprøve med manuelt gir. Kilde: Statens vegvesen.");
  }

  if (
    includesAny(t, ["både manuell og automat", "bade manuell og automat", "manuell og automat", "automat og manuell", "b og baut", "forskjellen på b og baut", "forskjell på b og baut"]) ||
    (includesAny(t, ["klasse b", "bil"]) && includesAny(t, ["automat"]) && !asksPrice)
  ) {
    return known("Ja. Onsøy Trafikkskole tilbyr klasse B med både manuelt gir og automat.");
  }

  if (!asksPrice && includesAny(t, ["baut"])) {
    return known("Ja. Onsøy Trafikkskole tilbyr BAut, som er klasse B med automatgir. De tilbyr også klasse B med manuelt gir.");
  }

  if (
    includesAny(t, ["førerkortklasser", "forerkortklasser", "hvilke klasser", "hva slags sertifikat", "hva slags førerkort", "hva slags forerkort", "hva tilbyr", "opplæring tilbyr", "opplaering tilbyr"]) &&
    !asksPrice
  ) {
    return known("Onsøy Trafikkskole tilbyr klasse B med manuelt gir og automat, samt motorsykkelklassene A1, A2 og A.");
  }

  if (includesAny(t, ["hvordan bestiller", "hvordan booker", "bestiller jeg", "hvor bestiller", "booke time", "bestille opplæring", "bestille opplaering", "bli elev", "starte opplæring", "starte opplaering", "påmelding", "pamelding"])) {
    return known("Du kan sende en forespørsel om opplæring via TABS på https://onsoytrafikkskole.tabs.no/ eller kontakte skolen på 92 98 99 98 eller post@onsoytrafikkskole.no. Skolen følger opp forespørselen; dette er ikke en bekreftet time med én gang.");
  }

  if (includesAny(t, ["hva kan du hjelpe", "hva kan jeg spørre", "hva kan jeg sporre", "hva kan jeg spørre om", "hjelp meg", "hva vet du"])) {
    return known("Jeg kan hjelpe med spørsmål om Onsøy Trafikkskoles førerkortklasser, priser, kurs, ansatte, åpningstider, adresser og kontaktinformasjon. Prøv gjerne å spørre om klasse B, A1, A2, A eller neste kurs.");
  }

  if (includesAny(t, ["fortell om skolen", "hva er onsøy trafikkskole", "hva er onsoy trafikkskole", "om onsøy trafikkskole", "om onsoy trafikkskole"])) {
    return known("Onsøy Trafikkskole AS holder til i Freskoveien 16 i Fredrikstad og har en egen MC-avdeling på FMV-området. Skolen tilbyr klasse B med manuelt gir og automat samt MC-klassene A1, A2 og A.");
  }

  if (/^(takk|tusen takk|supert(?:,? takk)?|flott(?:,? takk)?)[!.?\s]*$/.test(rawMessage.trim())) {
    return known("Bare hyggelig! Spør gjerne hvis du lurer på noe mer om opplæringen hos Onsøy Trafikkskole.");
  }

  if (/^(ha det|hadet|ha det bra|farvel)[!.?\s]*$/.test(rawMessage.trim())) {
    return known("Ha det bra, og lykke til med opplæringen!");
  }

  if (/^(hei|heisann|hallo|hello)[!.?\s]*$/.test(rawMessage.trim())) {
    return known("Hei! Jeg kan hjelpe med spørsmål om Onsøy Trafikkskoles førerkortklasser, priser, kurs, kontaktinformasjon og praktiske opplysninger. Hva lurer du på?");
  }

  return null;
}

function directFyllingsdalenAnswer(client, message) {
  const c = String(client || "").toLowerCase().trim();

  if (c !== "fyllingsdalen") return null;

  const t = makeNorwegianSearchText(message);
  const asksPrice = includesAny(t, ["pris", "priser", "koster", "kostnad", "price", "cost", "hvor mye"]);
  let licenseClass = requestedLicenseClass(message);
  const asksOpeningHours = includesAny(t, [
    "åpningstid", "apningstid", "aapningstid", "åpent", "åpne", "apent", "apne",
    "kontortid", "når er dere åpne", "nar er dere apne"
  ]);
  const asksDrivingTest = includesAny(t, [
    "førerprøve", "forerprove", "oppkjøring", "oppkjoring", "praktisk prøve", "praktisk prove"
  ]);
  const asksDrivingTestScheduling = asksDrivingTest && includesAny(t, [
    "når", "nar", "dato", "ledig", "bestille", "bestiller", "booke", "booking", "time til",
    "flytte", "endre", "avbestille", "avlyse"
  ]);
  const normalizedMessage = norm(message);
  const rawMessage = String(message || "").toLowerCase();
  const targetLicensePatterns = [
    ["a1", /\b(?:ta|få|fa|skaffe|kjøre|kjore|øvelseskjøre|ovelseskjore|utvide(?:\s+meg)?\s+til|oppgradere(?:\s+meg)?\s+til|gå\s+opp(?:\s+meg)?\s+til|ga\s+opp(?:\s+meg)?\s+til)\s+(?:klasse\s+)?(?:a1|lett\s+(?:mc|motorsykkel))\b/],
    ["a2", /\b(?:ta|få|fa|skaffe|kjøre|kjore|øvelseskjøre|ovelseskjore|utvide(?:\s+meg)?\s+til|oppgradere(?:\s+meg)?\s+til|gå\s+opp(?:\s+meg)?\s+til|ga\s+opp(?:\s+meg)?\s+til)\s+(?:klasse\s+)?(?:a2|mellomtung\s+(?:mc|motorsykkel))\b/],
    ["a", /\b(?:ta|få|fa|skaffe|kjøre|kjore|øvelseskjøre|ovelseskjore|utvide(?:\s+meg)?\s+til|oppgradere(?:\s+meg)?\s+til|gå\s+opp(?:\s+meg)?\s+til|ga\s+opp(?:\s+meg)?\s+til)\s+(?:klasse\s+)?(?:a|tung\s+(?:mc|motorsykkel))\b/],
    ["b96", /\b(?:ta|få|fa|skaffe|kjøre|kjore|utvide(?:\s+meg)?\s+til)\s+(?:klasse\s+)?b96\b/],
    ["be", /\b(?:ta|få|fa|skaffe|kjøre|kjore|utvide(?:\s+meg)?\s+til)\s+(?:klasse\s+)?be\b/],
    ["b", /\b(?:ta|få|fa|skaffe|kjøre|kjore)\s+(?:klasse\s+)?b\b/]
  ];
  const targetLicenseClass = targetLicensePatterns.find(([, pattern]) =>
    pattern.test(rawMessage) || pattern.test(normalizedMessage)
  );

  if (targetLicenseClass) {
    licenseClass = targetLicenseClass[0];
  }
  const packageHoursMatch = normalizedMessage.match(/(^|\s)(10|15|16|20)\s+(kjoretimer|timer)(\s|$)/);
  const packageHourWords = [
    ["ti kjøretimer", 10], ["ti kjoretimer", 10], ["ti timer", 10],
    ["femten kjøretimer", 15], ["femten kjoretimer", 15], ["femten timer", 15],
    ["seksten kjøretimer", 16], ["seksten kjoretimer", 16], ["seksten timer", 16],
    ["tjue kjøretimer", 20], ["tjue kjoretimer", 20], ["tjue timer", 20]
  ];
  const packageHourWord = packageHourWords.find(([phrase]) => includesAny(t, [phrase]));
  const requestedPackageHours = packageHoursMatch
    ? Number(packageHoursMatch[2])
    : (packageHourWord ? packageHourWord[1] : null);
  const asksPackage = includesAny(t, [
    "pakke", "pakken", "pakker", "grunnpakke", "startpakke", "start pakke", "pakketilbud"
  ]) || requestedPackageHours !== null;
  const asksLesson = includesAny(t, [
    "kjøretime", "kjøretimer", "kjoretime", "kjoretimer", "timepris", "vanlig time",
    "biltime", "automatkjøring", "automatkjoring", "time med manuell", "time med automat",
    "klasse b time", "b-time", "a-time", "time klasse", "time for klasse", "45 min"
  ]) ||
    /(^|\s)(time|kjoretime)\s+(for\s+)?(klasse\s+)?(a1|a2|a|b|be|b96)(\s|$)/.test(normalizedMessage) ||
    /(^|\s)(a1|a2|a|b|be|b96)\s+(time|kjoretime)(\s|$)/.test(normalizedMessage);

  if (
    !licenseClass &&
    includesAny(t, ["alder", "aldersgrense", "hvor gammel"]) &&
    /\bfor\s+a\b/i.test(String(message || ""))
  ) {
    licenseClass = "a";
  }

  const contactEmails = rawMessage.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || [];
  const hasPrivateEmail = contactEmails.some(email => email.toLowerCase() !== "dintrafikkskole@gmail.com");
  const contactNumberCandidates = rawMessage.match(/(?:^|[^\d])((?:\+?\d[\s.-]*){8,11})(?!\d)/g) || [];
  const hasPrivateNumber = contactNumberCandidates.some(candidate => {
    const digits = candidate.replace(/\D/g, "");

    if (![8, 10, 11].includes(digits.length)) return false;
    return digits !== "92012800" && digits !== "4792012800";
  });
  const presentsContactValue = hasPrivateEmail || hasPrivateNumber;

  if (
    presentsContactValue ||
    includesAny(t, [
      "lagre kontakt", "lagre navnet", "lagre e-post", "lagre epost", "lagre telefon",
      "kontakt meg", "kan dere kontakte meg", "ring meg", "ringe meg", "ring meg tilbake",
      "ringe meg tilbake", "tilbakeringing", "kan dere ringe meg", "navnet mitt",
      "jeg heter", "min e-post", "min epost", "mitt telefonnummer", "telefonnummeret mitt",
      "send svaret til", "navn:", "e-post:", "epost:", "fødselsnummer", "fodselsnummer",
      "personopplysning"
    ])
  ) {
    return "Denne demoen kan ikke lagre, videresende eller følge opp navn, telefonnummer, e-post eller andre personopplysninger. Kontakt skolen direkte på 920 12 800 eller dintrafikkskole@gmail.com, og ikke skriv sensitive opplysninger i chatten.";
  }

  if (includesAny(t, ["organisasjonsnummer", "organisasjons nummer", "orgnummer", "org nr"])) {
    return "Organisasjonsnummeret er ikke oppgitt i kildene denne demoen bruker. Kontroller det i Brønnøysundregistrene eller kontakt skolen for riktig nummer.";
  }

  if (asksOpeningHours) {
    if (includesAny(t, ["hovednettsiden", "hoved nettsiden", "vanlige nettsiden", "ordinære nettsiden"])) {
      return "Hovednettsiden oppgir kontortid tirsdag og onsdag kl. 11–12.30 og torsdag kl. 16–17.30. TABS viser andre tider, så ring gjerne 920 12 800 før oppmøte.";
    }

    if (includesAny(t, ["tabs", "liveoversikt", "live oversikt"])) {
      return "Skolens liveoversikt i TABS oppgir kontortid tirsdag kl. 15–16, onsdag kl. 11–13 og torsdag kl. 16–18. Ring gjerne 920 12 800 før oppmøte.";
    }

    return "TABS oppgir kontortid tirsdag kl. 15–16, onsdag kl. 11–13 og torsdag kl. 16–18. Hovednettsiden oppgir tirsdag og onsdag kl. 11–12.30 og torsdag kl. 16–17.30. Siden tidene er ulike, bør du kontrollere den aktuelle oversikten eller ringe 920 12 800 før oppmøte.";
  }

  if (includesAny(t, ["kursoversikt", "kursoversikten", "kursdato", "ledige plasser"])) {
    return "Kursdatoer og ledige plasser endres. Du finner den oppdaterte kursoversikten via Fyllingsdalen Trafikkskoles nettside, der du også kan melde deg på.";
  }

  if (includesAny(t, ["elevside", "elevsiden", "elev side", "tabs-innlogging", "tabs innlogging"])) {
    return "Du finner lenken til elevsiden i hovedmenyen på Fyllingsdalen Trafikkskoles nettside.";
  }

  if (
    includesAny(t, ["kurs"]) &&
    includesAny(t, ["mandag", "tirsdag", "onsdag", "torsdag", "fredag", "lørdag", "lordag", "søndag", "sondag"]) &&
    !asksPrice
  ) {
    return "Kursdager og ledige plasser endres. Se den oppdaterte kursoversikten via skolens nettside for å kontrollere om kurset går den aktuelle dagen.";
  }

  if (includesAny(t, ["prisliste", "prislisten", "prisoversikt", "alle priser"])) {
    return "Du finner prisoversikten på skolens hovednettside og i liveoversikten i TABS. Ved ulike beløp bør du bruke prisen som vises for den konkrete bookingen eller bekrefte den med skolen.";
  }

  if (includesAny(t, [
    "hente", "henter", "henting", "bringe", "oppmøtested", "oppmotested", "pickup"
  ])) {
    const pickupAreas = [
      ["fyllingsdalen", "Fyllingsdalen"],
      ["bergen sentrum", "Bergen sentrum"],
      ["loddefjord", "Loddefjord"],
      ["fana", "Fana"],
      ["nesttun", "Nesttun"],
      ["askøy", "Askøy"],
      ["askoy", "Askøy"],
      ["sotra", "Sotra"],
      ["åsane", "Åsane"],
      ["asane", "Åsane"]
    ];
    const area = pickupAreas.find(([needle]) => includesAny(t, [needle]));

    if (area) {
      return `Ja. ${area[1]} er innenfor Stor-Bergen, der skolen opplyser at den henter elever. Avtal nøyaktig sted og tidspunkt direkte med trafikklæreren.`;
    }

    return "Skolen opplyser at den henter elever i hele Stor-Bergen. Avtal nøyaktig oppmøtested og tidspunkt direkte med trafikklæreren.";
  }

  if (includesAny(t, ["bomring", "bomringgebyr", "bompengegebyr"])) {
    return "TABS oppgir 750 kr i bomringgebyr, mens hovednettsiden oppgir 850 kr. Kontroller beløpet som gjelder for den konkrete opplæringen.";
  }

  if (includesAny(t, [
    "avbestill", "avlyse", "avlys", "kanseller", "kansellere", "endre en time", "endre kjøretime",
    "endre tidspunkt", "flytte kjøretime", "flytter jeg kjøretimen"
  ])) {
    if (asksDrivingTest) {
      return "Førerprøven bestilles, endres og avbestilles hos Statens vegvesen. Kontroller fristen og vilkårene i bestillingen din før du avbestiller; skolens 24-timersregel gjelder vanlige kjøretimer, ikke førerprøven.";
    }

    if (includesAny(t, [
      "kurs", "mørkekjøring", "morkekjoring", "mørkekurs", "morkekurs",
      "mørkedemo", "morkedemo", "trafikant i mørket", "trafikant i morket",
      "trafikalt grunnkurs", "tgk", "førstehjelp", "forstehjelp"
    ])) {
      return "Avbestillingsfristen for kurs er ikke bekreftet i kildene demoen bruker. Kontroller vilkårene i den konkrete bookingen eller kontakt skolen på 920 12 800 før du avbestiller.";
    }

    return "Skolens oppførte frist for å avbestille en vanlig kjøretime er 24 timer før timen, og senest én virkedag i forveien. Hvis ikke må timen betales.";
  }

  if (includesAny(t, ["moped"])) {
    return "Moped er ikke oppført blant førerkortklassene på skolens hovednettside. TABS viser et mopedgrunnkurs, så kontakt skolen for å få bekreftet om tilbudet er aktivt før påmelding.";
  }

  if (includesAny(t, [
    "tegnspråk", "tegnsprak", "tegnspråktolk", "tegnspraktolk", "døv", "dov",
    "hørselshemmet", "hørselshemmede", "horselshemmet", "horselshemmede",
    "tunghørt", "tunghørte", "tunghort", "tunghorte", "nedsatt hørsel", "nedsatt horsel",
    "høreapparat", "horeapparat", "hører dårlig", "horer darlig", "hørselshemming",
    "horselshemming", "døvelærer", "dovelaerer", "tilrettelagt"
  ])) {
    if (asksPrice || includesAny(t, ["ekstra", "tillegg"])) {
      return "Skolen opplyser at de kan tilby trafikkopplæring på tegnspråk, men en eventuell tilleggspris er ikke publisert i kildene demoen bruker. Kontakt skolen for å få dette bekreftet.";
    }

    return "Ja. Fyllingsdalen Trafikkskole opplyser at de kan tilby trafikkopplæring på tegnspråk. Kontakt skolen for å avtale hvilken tilrettelegging du trenger.";
  }

  const staffRoles = [
    ["eirik kråkevik", "Eirik Kråkevik er oppført som daglig leder og trafikklærer."],
    ["eirik krakevik", "Eirik Kråkevik er oppført som daglig leder og trafikklærer."],
    ["geir frode lunden", "Geir Frode Lunden er oppført som trafikklærer og med opplæring på tegnspråk."],
    ["john-magne øyulvstad", "John-Magne Øyulvstad er oppført som faglig leder og trafikklærer."],
    ["john-magne oyulvstad", "John-Magne Øyulvstad er oppført som faglig leder og trafikklærer."],
    ["gunn kråkevik", "Gunn Kråkevik er oppført som trafikklærer."],
    ["gunn krakevik", "Gunn Kråkevik er oppført som trafikklærer."],
    ["hein nils hansen", "Hein Nils Hansen er oppført som trafikklærer."],
    ["even kråkeskar", "Even Kråkeskar er oppført som trafikklærer."],
    ["even krakeskar", "Even Kråkeskar er oppført som trafikklærer."],
    ["ørjan berge", "Ørjan Berge er oppført som trafikklærer."],
    ["orjan berge", "Ørjan Berge er oppført som trafikklærer."],
    ["clarice mukula", "Clarice Mukula er oppført som trafikklærer."],
    ["sindre ruud pettersen", "Sindre Ruud Pettersen står i TABS-oversikten, men hovednettsiden viser en annen ansattliste. Kontakt skolen for å bekrefte nåværende status."],
    ["sindre", "Sindre Ruud Pettersen står i TABS-oversikten, men hovednettsiden viser en annen ansattliste. Kontakt skolen for å bekrefte nåværende status."]
  ];
  const staffMatch = staffRoles.find(([needle]) => includesAny(t, [needle]));

  if (staffMatch) {
    return `${staffMatch[1]} Skolens publiserte ansattoversikter er ikke helt like, så bruk fellesnummeret 920 12 800 for oppdatert status og kontakt.`;
  }

  if (includesAny(t, ["daglig leder", "dagligleder"])) {
    return "Eirik Kråkevik er oppført som daglig leder og trafikklærer. Skolens publiserte ansattoversikter er ikke helt like, så bruk fellesnummeret 920 12 800 for oppdatert status.";
  }

  if (includesAny(t, ["faglig leder", "fagligleder"])) {
    return "John-Magne Øyulvstad er oppført som faglig leder og trafikklærer. Skolens publiserte ansattoversikter er ikke helt like, så bruk fellesnummeret 920 12 800 for oppdatert status.";
  }

  if (includesAny(t, [
    "hvem jobber", "ansatte", "ansattoversikt", "trafikklærere", "trafikklaerere",
    "lærere", "laerere", "instruktører", "instruktorer", "teamet"
  ])) {
    return "TABS-oversikten viser Clarice Mukula, Eirik Kråkevik, Even Kråkeskar, Geir Frode Lunden, Gunn Kråkevik, Hein Nils Hansen, John-Magne Øyulvstad, Sindre Ruud Pettersen og Ørjan Berge. Hovednettsiden viser en annen ansattliste, så kontakt skolen for å bekrefte hvem som jobber der nå.";
  }

  if (
    includesAny(t, ["automat", "automatgir", "automatlappen"]) &&
    includesAny(t, ["manuell", "manuelt", "manuelt gir", "manuellgir"])
  ) {
    if (includesAny(t, ["automat med manuelt", "automatgir med manuelt", "automat med manuell", "manuelt førerkort", "manuelt forerkort"])) {
      return "Ja. Har du bestått førerprøven med manuelt gir, kan du kjøre både bil med manuelt gir og automat. Kilde: Statens vegvesen.";
    }

    if (asksPrice || includesAny(t, ["billigere", "dyrest", "dyrere"])) {
      return "En ordinær kjøretime på 45 minutter er oppført til 900 kr for både manuelt gir og automat. Består du førerprøven med automat, får førerkortet kode 78 og gjelder bare automat. Kilde: skolen og Statens vegvesen.";
    }

    if (includesAny(t, ["etter automat", "etter automatlappen", "fra automat", "bytte til manuell", "kjøre manuell", "kjore manuell"])) {
      return "Skolen tilbyr klasse B med både automat og manuelt gir. Statens vegvesen opplyser at førerkort tatt med automat får kode 78 og bare gjelder automat. For å fjerne begrensningen må du bestå en ny førerprøve med manuelt gir.";
    }

    return "Fyllingsdalen Trafikkskole tilbyr klasse B med både manuelt gir og automat. Består du førerprøven med automat, får førerkortet kode 78 og gjelder bare automat. Består du med manuelt gir, kan du kjøre begge deler. Kilde: Statens vegvesen.";
  }

  const targetsClassA =
    /\b(ta|få|fa|skaffe|kjøre|kjore)\s+(klasse\s+)?a\b/.test(rawMessage) ||
    /\b(utvide|gå|ga)\s+(meg\s+)?til\s+(klasse\s+)?a\b/.test(rawMessage) ||
    /\b(ta|få|fa|skaffe|kjøre|kjore)\s+tung\s+(mc|motorsykkel)\b/.test(rawMessage) ||
    /\b(oppgradere|gå opp|ga opp)\s+(meg\s+)?til\s+tung\s+(mc|motorsykkel)\b/.test(rawMessage);

  if (targetsClassA) {
    const ageFromContext = normalizedMessage.match(/\b(jeg er|er jeg|som er|fylt|fyller)\s+(\d{1,2})\b/);
    const statedAge = ageFromContext
      ? Number(ageFromContext[2])
      : ([...normalizedMessage.matchAll(/\b(\d{1,2})\s+(ar|aring)\b/g)]
          .map(match => Number(match[1]))
          .find(age => age >= 15) || null);
    const lacksA2 = includesAny(t, [
      "uten a2", "uten å ha a2", "uten a ha a2", "har ikke a2", "ikke har a2",
      "ikke ha a2", "ikke hatt a2", "aldri hatt a2", "uten mellomtung mc",
      "uten mellomtung motorsykkel", "aldri hatt mellomtung mc", "aldri hatt mellomtung motorsykkel"
    ]);
    const hasOneYearA2 = includesAny(t, [
      "ett år", "ett ar", "1 år", "1 ar", "ett halvt", "halvannet år", "halvannet ar"
    ]);
    const hasTwoYearsA2 = includesAny(t, [
      "to år", "to ar", "tre år", "tre ar", "fire år", "fire ar", "fem år", "fem ar",
      "seks år", "seks ar", "sju år", "sju ar", "åtte år", "atte ar", "ni år", "ni ar",
      "ti år", "ti ar", "2 år", "2 ar", "3 år", "3 ar", "4 år", "4 ar", "5 år", "5 ar",
      "6 år", "6 ar", "7 år", "7 ar", "8 år", "8 ar", "9 år", "9 ar", "10 år", "10 ar",
      "minst to", "minst 2"
    ]);

    if (statedAge !== null && statedAge >= 24) {
      return "Ja. Fra du er 24 år kan du ta klasse A direkte uten å ha hatt A2 først. Kilde: Statens vegvesen.";
    }

    if (hasOneYearA2) {
      return "Nei, ett år med A2 er ikke nok for tidlig utvidelse. Du må ha hatt klasse A2 i minst to år, eller vente til du er 24 år. Kilde: Statens vegvesen.";
    }

    if (lacksA2) {
      return "Nei, ikke før du er 24 år. Tidligere utvidelse til klasse A krever at du har hatt klasse A2 i minst to år. Kilde: Statens vegvesen.";
    }

    if (hasTwoYearsA2 && statedAge !== null && statedAge < 20) {
      return "Nei, ikke ennå. Klasse A2 kan tidligst tas fra 18 år, så to års sammenhengende innehav gjør 20 år til tidligste mulige alder for denne utvidelsen. Kilde: Statens vegvesen.";
    }

    if (hasTwoYearsA2) {
      return "Ja, du kan utvide til klasse A før du fyller 24 år når du har hatt klasse A2 i minst to år. Kilde: Statens vegvesen. Kontakt skolen for å planlegge utvidelsen.";
    }

    return "Du kan ta klasse A direkte fra 24 år, eller utvide tidligere når du har hatt klasse A2 i minst to år. Kilde: Statens vegvesen.";
  }

  if (
    includesAny(t, ["aldersgrense", "hvor gammel", "alder", "over 25", "fylt 25", "eldre enn 25"]) ||
    /\b\d{1,2}\s*[- ]?(år|ar)(ing)?\b/.test(t.both) ||
    /\b(jeg er|er jeg|som er|når jeg er|nar jeg er)\s+\d{1,2}\b/.test(t.both)
  ) {
    const ageFromContext = normalizedMessage.match(/\b(jeg er|er jeg|som er|fylt|fyller)\s+(\d{1,2})\b/);
    const statedAge = ageFromContext
      ? Number(ageFromContext[2])
      : ([...normalizedMessage.matchAll(/\b(\d{1,2})\s+(ar|aring)\b/g)]
          .map(match => Number(match[1]))
          .find(age => age >= 15) || null);
    const isAtLeast25 = statedAge !== null && statedAge >= 25;

    if (includesAny(t, ["ledsager", "ledsagere"])) {
      return "En ledsager må ha fylt 25 år og hatt førerkort i samme klasse sammenhengende i minst fem år. En 25-åring kan derfor være ledsager hvis kravet til førerkortet også er oppfylt. Kilde: Statens vegvesen.";
    }

    if (
      isAtLeast25 &&
      includesAny(t, [
        "mørkekjøring", "morkekjoring", "trafikant i mørket", "trafikant i morket",
        "førstehjelp", "forstehjelp", "plikter ved trafikkuhell"
      ])
    ) {
      return "Ja. Når du har fylt 25 år er du fritatt fra selve trafikalt grunnkurs, men du må fortsatt gjennomføre Trafikant i mørket og Plikter ved trafikkuhell og førstehjelp. Kilde: Statens vegvesen.";
    }

    if (includesAny(t, ["trafikalt grunnkurs", "grunnkurs", "tg", "over 25", "fylt 25"])) {
      if (isAtLeast25 || includesAny(t, ["over 25", "fylt 25", "25 år", "25 ar", "eldre enn 25"])) {
        return "Har du fylt 25 år, er du fritatt fra selve trafikalt grunnkurs. Du må fortsatt gjennomføre Trafikant i mørket og Plikter ved trafikkuhell og førstehjelp. Kilde: Statens vegvesen.";
      }

      return "Trafikalt grunnkurs er obligatorisk for personer under 25 år. Har du fylt 25 år, er du fritatt fra selve kurset, men må fortsatt gjennomføre Trafikant i mørket og Plikter ved trafikkuhell og førstehjelp. Kilde: Statens vegvesen.";
    }

    const asksPracticeDriving = includesAny(t, [
      "øvelseskjøre", "ovelseskjore", "øvelseskjøring", "ovelseskjoring"
    ]);

    if (asksPracticeDriving && licenseClass === "a1") {
      return "For klasse A1 kan du øvelseskjøre fra du er 15 år når kravene til motorsykkelopplæringen er oppfylt. Førerprøven kan tas fra 16 år. Kilde: Statens vegvesen.";
    }

    if (asksPracticeDriving && licenseClass === "a2") {
      return "For klasse A2 kan du øvelseskjøre fra du er 16 år når kravene til motorsykkelopplæringen er oppfylt. Førerprøven kan tas fra 18 år. Kilde: Statens vegvesen.";
    }

    if (asksPracticeDriving && licenseClass === "a") {
      const lacksA2 = includesAny(t, [
        "uten a2", "uten å ha a2", "uten a ha a2", "har ikke a2", "ikke har a2",
        "ikke ha a2", "ikke hatt a2", "aldri hatt a2", "uten mellomtung mc",
        "uten mellomtung motorsykkel"
      ]);
      const hasA2 = !lacksA2 && includesAny(t, [
        "har a2", "har klasse a2", "har førerkort a2", "har forerkort a2",
        "har mellomtung mc", "har mellomtung motorsykkel"
      ]);
      const asksBefore22 = /\bfør\s+(?:jeg\s+er\s+)?22\b/.test(rawMessage) ||
        /\bfor\s+(?:jeg\s+er\s+)?22\b/.test(normalizedMessage);

      if ((statedAge !== null && statedAge < 22) || asksBefore22) {
        if (hasA2) {
          return "Ja. Har du allerede klasse A2, kan du øvelseskjøre med klasse A før du er 22 år. Kontakt skolen for å kontrollere øvrige krav og planlegge opplæringen. Kilde: Statens vegvesen.";
        }

        return "Nei, ikke uten klasse A2. Uten A2 kan du øvelseskjøre med klasse A fra du er 22 år. Kilde: Statens vegvesen.";
      }

      return "For klasse A kan du normalt øvelseskjøre fra du er 22 år. Har du allerede klasse A2, kan du øvelseskjøre med klasse A også før du fyller 22. Klasse A kan tas direkte fra 24 år, eller ved utvidelse etter minst to år med A2. Kilde: Statens vegvesen.";
    }

    if (licenseClass === "b") {
      return "For klasse B kan du øvelseskjøre fra du er 16 år når kravene til trafikalt grunnkurs er oppfylt. Nedre aldersgrense for førerprøven er 18 år. Kilde: Statens vegvesen.";
    }

    if (licenseClass === "a1") {
      return "Nedre aldersgrense for førerprøven i klasse A1 er 16 år. Kilde: Statens vegvesen.";
    }

    if (licenseClass === "a2") {
      return "Nedre aldersgrense for førerprøven i klasse A2 er 18 år. Kilde: Statens vegvesen.";
    }

    if (licenseClass === "a") {
      return "Nedre aldersgrense for klasse A er normalt 24 år. Du kan utvide tidligere hvis du har hatt klasse A2 i minst to år. Kilde: Statens vegvesen.";
    }

    if (licenseClass === "be") {
      return "For klasse BE må du være minst 18 år og ha førerkort i klasse B. Kilde: Statens vegvesen.";
    }

    if (licenseClass === "b96") {
      return "For å få B96 må du ha klasse B, som har nedre aldersgrense 18 år for førerprøven. B96 krever minst sju timer obligatorisk opplæring, men ingen ny førerprøve. Kilde: Statens vegvesen.";
    }

    return "For klasse B kan du øvelseskjøre fra 16 år når kravene til trafikalt grunnkurs er oppfylt, mens førerprøven kan tas fra 18 år. For MC og tilhenger varierer alderskravet med klasse. Kilde: Statens vegvesen.";
  }

  if (
    licenseClass &&
    includesAny(t, [
      "hva må jeg ha", "hva ma jeg ha", "hva trenger jeg", "hva kreves", "kreves for",
      "forkunnskaper", "forutsetninger", "krav før", "kravene", "hvilke krav", "før a"
    ])
  ) {
    if (licenseClass === "be") {
      return "For å ta klasse BE må du være minst 18 år og ha førerkort i klasse B. Opplæringen omfatter minst sju timer, og BE avsluttes med førerprøve. Kilde: Statens vegvesen.";
    }

    if (licenseClass === "b96") {
      return "For klasse B96 må du ha klasse B og gjennomføre minst sju timer obligatorisk opplæring. Du trenger ikke ta en ny førerprøve. Kilde: Statens vegvesen.";
    }

    if (licenseClass === "b") {
      return "Veien til klasse B omfatter trafikalt grunnkurs, grunnleggende og trafikal opplæring, avsluttende obligatorisk opplæring, teoriprøve og førerprøve. Hvor mange kjøretimer du trenger, vurderes individuelt. Kilde: Statens vegvesen.";
    }

    return "Forutsetningene for den valgte førerkortklassen er ikke fullstendig spesifisert i kildene demoen bruker. Kontroller gjeldende krav hos Statens vegvesen eller spør skolen før du bestiller opplæring.";
  }

  if (
    includesAny(t, ["henger", "tilhenger", "hengerlappen"]) &&
    includesAny(t, ["hva må jeg ha", "hva ma jeg ha", "hva trenger jeg", "hva kreves", "krav", "forutsetning"])
  ) {
    return "Kravene avhenger av om du mener B96 eller BE. B96 krever klasse B og minst sju timer obligatorisk opplæring uten ny førerprøve. BE krever klasse B, minst sju timer opplæring og en ny førerprøve; du må være minst 18 år for BE. Kilde: Statens vegvesen.";
  }

  if (includesAny(t, ["epost", "e-post", "email", "mail"])) {
    return "Du kan kontakte Fyllingsdalen Trafikkskole på e-post: dintrafikkskole@gmail.com.";
  }

  if (
    (
      includesAny(t, ["trafikalt grunnkurs", "tg"]) ||
      (includesAny(t, ["grunnkurs"]) && !["a", "a1", "a2"].includes(licenseClass) && !includesAny(t, ["mc", "motorsykkel"]))
    ) &&
    !asksPrice
  ) {
    if (includesAny(t, [
      "neste", "når", "nar", "dato", "ledig", "påmelding", "pamelding", "melde meg på",
      "melde meg pa", "melder jeg meg på", "melder jeg meg pa", "booke", "booking", "bestille"
    ])) {
      return "Kursdatoer og ledige plasser endres. Se den oppdaterte kursoversikten via skolens nettside for neste trafikale grunnkurs og påmelding.";
    }

    return "Trafikalt grunnkurs er første steg mot førerkortet og er obligatorisk for personer under 25 år. Kurset gir grunnleggende forståelse for trafikk, ansvar og sikkerhet.";
  }

  if (includesAny(t, [
    "mørkekjøring", "morkekjoring", "mørkedemo", "morkedemo", "mørkekurs", "morkekurs",
    "mørkekjøringskurs", "morkekjoringskurs", "mørkedemonstrasjon", "morkedemonstrasjon",
    "trafikant i mørket", "trafikant i morket", "nattkjøring", "nattkjoring"
  ])) {
    if (asksPrice) {
      return "I skolens liveoversikt i TABS er Mørkedemo Jondal oppført til 1 500 kr. Hovednettsidens prisside viser også Trafikant i mørket til 2 200 kr, så kontroller riktig kurs i kursoversikten før påmelding.";
    }

    if (includesAny(t, [
      "neste", "når", "nar", "dato", "ledig", "påmelding", "pamelding", "melde meg på",
      "melde meg pa", "booke", "booking", "bestille"
    ])) {
      return "Se den oppdaterte kursoversikten via skolens nettside for neste mørkekjøring eller mørkedemo og ledige plasser.";
    }

    return "Mørkekjøring, også kalt Trafikant i mørket, handler om risiko og trafikantatferd ved kjøring i mørket. Kursnavn, sted og pris varierer, så bruk den oppdaterte kursoversikten for det konkrete tilbudet.";
  }

  const asksWeekendLesson =
    includesAny(t, ["lørdag", "lordag", "helg", "weekend"]) &&
    includesAny(t, ["kjøretime", "kjoretime", "time"]);

  if (asksWeekendLesson) {
    if (["a", "a1", "a2"].includes(licenseClass)) {
      return "Skolen publiserer ikke en egen lørdagspris for den valgte MC-klassen. Kontakt skolen for å få bekreftet om lørdagstime er tilgjengelig og hva den koster.";
    }

    return "Kjøretime på lørdag for klasse B er oppført til 1 700 kr.";
  }

  const asksEveningLesson = includesAny(t, [
    "etter kl 16", "etter klokken 16", "etter 16", "kveld", "ettermiddag", "sen time", "kveldstime"
  ]);

  if (asksEveningLesson) {
    if (["a", "a1", "a2"].includes(licenseClass)) {
      return "Kjøretime etter kl. 16 for MC-klassene er oppført til 1 150 kr på skolens hovednettside.";
    }

    return "Hovednettsiden oppgir 1 050 kr for klasse B etter kl. 16. TABS viser både 1 050 kr og en separat linje på 1 500 kr, så kontroller beløpet for den konkrete bookingen.";
  }

  if (asksDrivingTest && licenseClass === "b96") {
    return "B96 kan tas uten en ny førerprøve og har derfor ingen oppkjøringspris. Du må ha klasse B og gjennomføre minst sju timer obligatorisk opplæring. Kilde: Statens vegvesen.";
  }

  if (asksDrivingTest && licenseClass === "be" && !asksPrice && !asksDrivingTestScheduling) {
    return "Ja, klasse BE krever førerprøve. Du må ha klasse B, være minst 18 år og gjennomføre minst sju timer opplæring. Kilde: Statens vegvesen.";
  }

  if (asksDrivingTest && includesAny(t, ["hvor tidlig", "når bør jeg starte", "nar bor jeg starte", "før ønsket", "for onsket"])) {
    return "Skolen anbefaler å starte opplæringen omtrent fem måneder før ønsket førerprøve for å redusere problemer med fravær fra skolen.";
  }

  if (asksDrivingTest && includesAny(t, ["vegvesen", "gebyr", "inkludert", "kommer i tillegg", "separat"])) {
    return "Statens vegvesens prøvegebyr er separat og er ikke inkludert i skolens oppførte pris for kjøretøy og lærer ved førerprøven. Kontroller det gjeldende offentlige gebyret hos Statens vegvesen før betaling.";
  }

  if (asksDrivingTestScheduling) {
    return "Oppkjøring bestilles hos Statens vegvesen. Du kan bestille selv eller gi trafikkskolen fullmakt til å bestille for deg; ledige tider vises i Statens vegvesens timebestilling.";
  }

  if (asksDrivingTest) {
    if (asksPrice) {
      if (licenseClass === "b") {
        return "Skolens bil og lærer ved førerprøven for klasse B er oppført til 2 850 kr. Statens vegvesens prøvegebyr kommer separat.";
      }

      if (["a", "a1", "a2"].includes(licenseClass)) {
        return "Skolens motorsykkel og lærer ved førerprøven for den valgte MC-klassen er oppført til 2 900 kr. Statens vegvesens prøvegebyr kommer separat.";
      }

      if (licenseClass === "be") {
        return "Skolens bil og henger til førerprøven for BE er oppført til 2 900 kr. Statens vegvesens prøvegebyr kommer separat.";
      }

      return "Skolens kjøretøy og lærer ved førerprøven er oppført til 2 850 kr for klasse B og 2 900 kr for MC og BE. Statens vegvesens prøvegebyr kommer separat.";
    }

    return "Førerprøven er den praktiske avsluttende prøven hos Statens vegvesen. All obligatorisk opplæring må være fullført og registrert, og teoriprøven må være bestått for klassene der den kreves. Skolen oppgir 2 850 kr for bil og lærer ved klasse B-prøven og 2 900 kr for MC eller bil og henger ved BE; Statens vegvesens prøvegebyr kommer separat.";
  }

  if (
    licenseClass === "b" &&
    asksPackage &&
    requestedPackageHours === 20
  ) {
    return "For klasse B viser hovednettsiden en 20-timers grunnpakke til 37 775 kr, mens TABS fremhever 41 000 kr for 20 kjøretimer, all obligatorisk opplæring og gebyr. Kontroller hvilket innhold og beløp som gjelder før bestilling.";
  }

  if (
    licenseClass === "b" &&
    asksPackage &&
    requestedPackageHours === 16
  ) {
    return "For klasse B viser hovednettsiden og TABS en 16-timerspakke til 35 175 kr, mens TABS også fremhever 37 000 kr inkludert obligatorisk opplæring og gebyr. Kontroller innholdet og beløpet for den konkrete pakken.";
  }

  if (asksPackage && licenseClass === "a") {
    if (requestedPackageHours && requestedPackageHours !== 10) {
      return `Skolen publiserer ikke en egen ${requestedPackageHours}-timerspakke for klasse A i kildene demoen bruker. Den publiserte A-pakken har ti kjøretimer og er oppført til 28 450 kr; MC-grunnkurset er ikke inkludert.`;
    }

    return "Pakken for klasse A med ti kjøretimer og all obligatorisk opplæring er oppført til 28 450 kr. MC-grunnkurset er ikke inkludert.";
  }

  if (asksPackage && licenseClass === "a2") {
    if (requestedPackageHours && requestedPackageHours !== 10) {
      return `Skolen publiserer ikke en egen ${requestedPackageHours}-timerspakke for klasse A2 i kildene demoen bruker. Den publiserte A2-pakken har ti kjøretimer og er oppført til 27 850 kr; MC-grunnkurset er ikke inkludert.`;
    }

    return "Pakken for klasse A2 med ti kjøretimer og all obligatorisk opplæring er oppført til 27 850 kr. MC-grunnkurset er ikke inkludert.";
  }

  if (asksPackage && licenseClass === "a1") {
    if (requestedPackageHours === 20) {
      return "Pakken for klasse A1 med 20 kjøretimer og all obligatorisk opplæring er oppført til 36 359 kr. MC-grunnkurset er ikke inkludert.";
    }

    if (requestedPackageHours === 15) {
      return "Pakken for klasse A1 med 15 kjøretimer og all obligatorisk opplæring er oppført til 31 150 kr. MC-grunnkurset er ikke inkludert.";
    }

    if (requestedPackageHours && requestedPackageHours !== 10) {
      return `Skolen publiserer ikke en egen ${requestedPackageHours}-timerspakke for klasse A1. De publiserte pakkene har 10, 15 eller 20 kjøretimer og er oppført til henholdsvis 25 850 kr, 31 150 kr og 36 359 kr; MC-grunnkurset er ikke inkludert.`;
    }

    return "Pakken for klasse A1 med ti kjøretimer og all obligatorisk opplæring er oppført til 25 850 kr. MC-grunnkurset er ikke inkludert.";
  }

  if (asksPackage && licenseClass === "b" && requestedPackageHours && ![16, 20].includes(requestedPackageHours)) {
    return `Skolen publiserer ikke en egen ${requestedPackageHours}-timerspakke for klasse B i kildene demoen bruker. De publiserte B-pakkene har 16 eller 20 kjøretimer, med ulike beløp mellom hovednettsiden og TABS.`;
  }

  if (asksPackage && !licenseClass && includesAny(t, ["mc", "motorsykkel"])) {
    return "Skolen publiserer MC-pakker for A, A1 og A2. Klasse A er oppført til 28 450 kr med ti kjøretimer, A2 til 27 850 kr med ti timer, og A1 fra 25 850 kr med ti timer til 36 359 kr med 20 timer. MC-grunnkurset er ikke inkludert. Oppgi klasse for et mer presist svar.";
  }

  if (asksPackage && (!licenseClass || licenseClass === "b")) {
    return "For klasse B viser hovednettsiden grunnpakker til 35 175 kr med 16 kjøretimer og 37 775 kr med 20 kjøretimer. TABS viser også 35 175 kr for 16 timer og fremhever 37 000 kr for 16 timer og 41 000 kr for 20 timer, inkludert obligatorisk opplæring og gebyr. Dette er startpakker, ikke en garantert totalpris. Egne MC-pakker finnes også; oppgi klasse for detaljer, og kontroller innholdet før bestilling.";
  }

  if (includesAny(t, [
    "totalpris", "totalkostnad", "pris på lappen", "prisen på lappen", "hva koster lappen",
    "alt inkludert", "alt til sammen", "hele opplæringen", "hele opplaeringen", "hele lappen",
    "billigste løsning", "billigste losning", "billigste pakke"
  ])) {
    return "En pakke er en startpakke, ikke en garanti for totalprisen, fordi behovet for kjøretimer vurderes individuelt. For klasse B viser kildene 16-timersalternativer fra 35 175 kr og 20-timersalternativer fra 37 775 kr, med høyere fremhevede TABS-priser når obligatorisk opplæring og gebyr er inkludert. Kontroller innholdet før bestilling.";
  }

  if (includesAny(t, ["trinnvurdering", "trinn 2", "trinn 3"])) {
    const asksStepTwo = includesAny(t, ["trinn 2", "trinn to"]);
    const asksStepThree = includesAny(t, ["trinn 3", "trinn tre"]);

    if (licenseClass === "b") {
      if (asksStepTwo) {
        return "For klasse B oppgir TABS 850 kr for trinnvurdering på trinn 2, mens hovednettsiden oppgir 950 kr. Kontroller beløpet for den konkrete bookingen.";
      }

      if (asksStepThree) {
        return "Trinnvurdering på trinn 3 for klasse B er oppført til 1 265 kr for 60 minutter, både for manuelt gir og automat.";
      }
    }

    if (["a", "a1", "a2"].includes(licenseClass)) {
      if (asksStepTwo) return "Trinnvurdering på trinn 2 for den valgte MC-klassen er oppført til 1 050 kr for 45 minutter.";
      if (asksStepThree) return "Trinnvurdering på trinn 3 for den valgte MC-klassen er oppført til 1 400 kr for 60 minutter.";
    }

    if (["be", "b96"].includes(licenseClass)) {
      if (asksStepTwo) return "Trinnvurdering på trinn 2 for BE/B96 er oppført til 955 kr for 45 minutter.";
      if (asksStepThree) return "Trinnvurdering på trinn 3 for BE/B96 er oppført til 1 275 kr for 60 minutter.";
    }

    return "En trinnvurdering brukes ved slutten av et opplæringstrinn for å vurdere om eleven har grunnlag for å gå videre. Prisene avhenger av klasse og trinn: B er oppført til 850/950 kr på trinn 2 og 1 265 kr på trinn 3; A/A1/A2 til 1 050/1 400 kr; BE/B96 til 955/1 275 kr. Oppgi klasse og trinn for et presist svar.";
  }

  if (
    asksPrice &&
    includesAny(t, ["sikkerhetskurs på veg", "sikkerhetskurs pa veg", "sikkerhetskurs på vei", "sikkerhetskurs pa vei"])
  ) {
    if (!licenseClass && includesAny(t, ["mc", "motorsykkel"])) {
      return "Prisen avhenger av MC-klasse. Sikkerhetskurs på veg er oppført til 6 800 kr for A, 6 000 kr for A1 og 5 610 kr i TABS / 6 200 kr på hovednettsiden for A2. Oppgi A, A1 eller A2 for et presist svar.";
    }

    if (licenseClass === "a1") return "Sikkerhetskurs på veg for klasse A1 er oppført til 6 000 kr.";
    if (licenseClass === "a2") return "TABS oppgir 5 610 kr for sikkerhetskurs på veg i klasse A2, mens hovednettsiden oppgir 6 200 kr. Kontroller beløpet for den konkrete bookingen.";
    if (licenseClass === "a") return "Sikkerhetskurs på veg for klasse A er oppført til 6 800 kr.";
    if (!licenseClass || licenseClass === "b") return "Sikkerhetskurs på vei for klasse B er oppført til 10 110 kr og 360 minutter, både for manuelt gir og automat.";
  }

  if (asksPrice && includesAny(t, [
    "presis kjøreteknikk", "presis kjoreteknikk", "presisjonskjøring", "presisjonskjoring"
  ])) {
    if (["a", "a2"].includes(licenseClass)) {
      return "Sikkerhetskurs i presis kjøreteknikk for den valgte MC-klassen er oppført til 5 800 kr. Banegebyr kommer i tillegg etter skolens prisliste.";
    }

    return "Prisen på sikkerhetskurs i presis kjøreteknikk avhenger av MC-klasse. Oppgi A, A1 eller A2 for et sikkert svar.";
  }

  if (
    asksPrice &&
    includesAny(t, ["grunnkurs"]) &&
    (["a", "a1", "a2"].includes(licenseClass) || includesAny(t, ["mc", "motorsykkel"]))
  ) {
    return "MC-grunnkurset for A, A1 og A2 er oppført til 1 200 kr. Det er ikke inkludert i de publiserte MC-pakkene.";
  }

  if (
    ["be", "b96"].includes(licenseClass) &&
    includesAny(t, ["hvor mange timer", "minimum timer", "minimumstimer", "minst timer", "minstekrav", "omfatter minst"])
  ) {
    if (licenseClass === "b96") {
      return "B96 krever minst sju timer obligatorisk opplæring og ingen ny førerprøve. Kilde: Statens vegvesen.";
    }

    return "BE-opplæringen omfatter minst sju timer og avsluttes med førerprøve. Kilde: Statens vegvesen.";
  }

  if (
    asksPrice &&
    ["be", "b96"].includes(licenseClass) &&
    includesAny(t, ["landeveiskjøring", "landeveiskjoring", "landevei"])
  ) {
    return "Landeveiskjøring for BE/B96 er oppført til 3 200 kr.";
  }

  if (asksPrice && includesAny(t, ["lastsikringskurs", "lastsikring"])) {
    return "Lastsikringskurs for BE/B96 er oppført til 1 700 kr.";
  }

  if (
    includesAny(t, ["sikkerhetskurs på bane", "sikkerhetskurs pa bane", "glattkjøring", "glattkjoring", "øvingsbane", "ovingsbane"]) &&
    (!licenseClass || licenseClass === "b")
  ) {
    if (!licenseClass && includesAny(t, ["mc", "motorsykkel"])) {
      return "MC-kurs på bane varierer med klasse. Skolen oppfører sikkerhetskurs i presis kjøreteknikk til 5 800 kr for A og A2, med banegebyr i tillegg. Oppgi A, A1 eller A2 for riktig kurs.";
    }

    return "For klasse B oppgir TABS 7 150 kr for sikkerhetskurs på øvingsbane. Hovednettsiden oppgir 5 600 kr for manuelt gir og 5 400 kr for automat, så kontroller beløpet for den konkrete bookingen.";
  }

  if (asksLesson && includesAny(t, [
    "bestille", "bestiller", "booke", "booking", "melde meg på", "melde meg pa", "ledig time"
  ])) {
    return "Du kan bestille kjøretime via elevsiden på Fyllingsdalen Trafikkskoles nettside eller kontakte skolen på 920 12 800.";
  }

  if (
    asksLesson &&
    includesAny(t, ["hva trenger", "hva må jeg ta med", "hva ma jeg ta med", "ta med på første", "ta med pa forste"])
  ) {
    return "Skolen publiserer ikke en fullstendig huskeliste for første kjøretime i kildene demoen bruker. Kontroller oppmøtested og hva du skal ta med på elevsiden eller med trafikklæreren før timen.";
  }

  if (asksLesson && includesAny(t, ["hvor lenge", "hvor lang", "varighet", "minutter", "varer"])) {
    if (!licenseClass || licenseClass === "b") {
      return "En ordinær kjøretime for klasse B varer 45 minutter. Oppgi førerkortklasse dersom du mener en annen type time eller et kurs.";
    }

    return "Varigheten er ikke publisert like tydelig for alle time- og kurstyper i den valgte klassen. Kontroller varigheten i den konkrete bookingen eller spør skolen.";
  }

  if (asksLesson && includesAny(t, ["ledig", "første time", "forste time", "neste time", "når kan", "nar kan", "tilgjengelig"])) {
    return "Ledige kjøretimer endres fortløpende. Bruk elevsiden eller kontakt skolen på 920 12 800 for å se første ledige time.";
  }

  if (
    includesAny(t, ["hvor lang tid", "hvor lenge", "varighet", "tidsbruk"]) &&
    includesAny(t, ["førerkortet", "forerkortet", "ta lappen", "opplæringen", "opplaeringen"])
  ) {
    return "Tiden fram til førerkortet varierer med forkunnskaper, øvelseskjøring og behovet for kjøretimer. Skolen anbefaler oppstart omtrent fem måneder før ønsket førerprøve, men kan ikke love en fast tidsplan.";
  }

  if (includesAny(t, ["hva inngår", "hva inngar", "inneholder", "obligatorisk opplæring", "obligatorisk opplaering"])) {
    if (licenseClass === "be") {
      return "BE-opplæringen omfatter minst sju timer og avsluttes med førerprøve. Skolen publiserer egne priser for blant annet trinnvurderinger, landeveiskjøring og lastsikringskurs. Kilde: skolen og Statens vegvesen.";
    }

    if (licenseClass === "b96") {
      return "B96 krever minst sju timer obligatorisk opplæring og ingen ny førerprøve. Skolen publiserer egne priser for blant annet trinnvurderinger, landeveiskjøring og lastsikringskurs. Kilde: skolen og Statens vegvesen.";
    }

    if (["a", "a1", "a2"].includes(licenseClass)) {
      return "Den obligatoriske MC-opplæringen varierer mellom A, A1 og A2 og kan omfatte grunnkurs, trinnvurderinger og klassebestemte sikkerhetskurs. Oppgi hvilken MC-klasse du mener for de konkrete kursene og prisene.";
    }

    return "Innholdet i obligatorisk opplæring avhenger av førerkortklasse. For klasse B omfatter løpet blant annet trinnvurderinger, sikkerhetskurs på øvingsbane og sikkerhetskurs på vei, i tillegg til trafikalt grunnkurs når det kreves. Oppgi klasse for et mer presist svar.";
  }

  if (includesAny(t, ["øvelseskjøre privat", "ovelseskjore privat", "privat øvelseskjøring", "privat ovelseskjoring"])) {
    return "Ja. For klasse B kan du kombinere opplæring på trafikkskole med privat øvelseskjøring. Du må ha oppfylt kravene til trafikalt grunnkurs, og ledsageren må være minst 25 år og ha hatt førerkort i samme klasse sammenhengende i minst fem år. Kilde: Statens vegvesen.";
  }

  if (includesAny(t, ["kvinnelig lærer", "kvinnelig laerer", "mannlig lærer", "mannlig laerer", "velge lærer", "velge laerer", "ønsket lærer", "onsket laerer"])) {
    return "Skolen publiserer flere trafikklærere, men ikke hvilke lærerønsker eller tider som er tilgjengelige. Kontakt skolen på 920 12 800 for å spørre om ønsket lærer.";
  }

  if (asksLesson && !asksPackage) {
    if (licenseClass === "b") {
      return "En ordinær kjøretime på 45 minutter for klasse B, med manuelt gir eller automat, er oppført til 900 kr.";
    }

    if (["a", "a1", "a2"].includes(licenseClass)) {
      return "En kjøretime for den valgte MC-klassen er oppført til 1 050 kr.";
    }

    if (["be", "b96"].includes(licenseClass)) {
      return "En kjøretime for tilhengerklassene BE/B96 er oppført til 955 kr.";
    }

    return "En ordinær kjøretime er oppført til 900 kr for klasse B, 1 050 kr for A/A1/A2 og 955 kr for BE/B96. Hvilken klasse mener du?";
  }

  if (includesAny(t, [
    "påmelding", "pamelding", "melde seg på", "melde seg pa", "melde meg på", "melde meg pa",
    "melder jeg meg på", "melder jeg meg pa", "booking", "booke", "bli elev", "starte"
  ])) {
    return "Du kan melde deg på via kursoversikten eller elevsiden på Fyllingsdalen Trafikkskoles nettside. Du kan også kontakte skolen på 920 12 800 eller dintrafikkskole@gmail.com.";
  }

  if (
    !licenseClass &&
    includesAny(t, ["sikkerhetskurs på bane", "sikkerhetskurs pa bane", "glattkjøring", "glattkjoring", "øvingsbane", "ovingsbane"])
  ) {
    return "For klasse B oppgir TABS 7 150 kr for sikkerhetskurs på øvingsbane. Hovednettsiden oppgir 5 600 kr for manuelt gir og 5 400 kr for automat, så kontroller beløpet for den konkrete bookingen.";
  }

  if (
    asksPrice &&
    includesAny(t, ["pakke", "pakken", "grunnpakke", "startpakke"]) &&
    !licenseClass
  ) {
    return "Pakkeprisen avhenger av førerkortklasse og innhold. For klasse B fremhever TABS 37 000 kr for 16 kjøretimer og 41 000 kr for 20 kjøretimer, inkludert obligatorisk opplæring og gebyr. Oppgi klasse for andre pakker.";
  }

  if (
    includesAny(t, ["hvor lenge", "hvor lang tid", "varighet"]) &&
    includesAny(t, ["sikkerhetskurs på vei", "sikkerhetskurs pa vei", "sikkerhetskurs på veg", "sikkerhetskurs pa veg"])
  ) {
    if (!licenseClass && includesAny(t, ["mc", "motorsykkel"])) {
      return "Varigheten varierer mellom MC-klassene A, A1 og A2 og er ikke fullstendig spesifisert i kildene demoen bruker. Oppgi MC-klasse eller kontroller den konkrete kursoppføringen.";
    }

    if (!licenseClass || licenseClass === "b") {
      return "Sikkerhetskurs på vei for klasse B er oppført med en varighet på 360 minutter. For MC varierer kurset etter klasse; se kursoversikten eller kontakt skolen for riktig varighet.";
    }

    return "Varigheten for dette MC-kurset er ikke spesifisert i kildene demoen bruker. Se kursoversikten eller kontakt skolen for riktig tidsplan.";
  }

  const namesSpecificPriceItem = includesAny(t, [
    "kjøretime", "kjoretime", "timepris", "time", "grunnkurs", "trinn", "sikkerhetskurs",
    "glattkjøring", "glattkjoring", "øvingsbane", "ovingsbane",
    "førerprøve", "forerprove", "oppkjøring", "oppkjoring", "pakke", "utvidelse",
    "landevei", "lastsikring"
  ]);

  if (asksPrice && !namesSpecificPriceItem) {
    if (licenseClass === "a") {
      return "For klasse A er en kjøretime oppført til 1 050 kr, mens pakken med ti kjøretimer og obligatorisk opplæring er oppført til 28 450 kr. MC-grunnkurset er ikke inkludert i pakken.";
    }

    if (licenseClass === "a1") {
      return "For klasse A1 er en kjøretime oppført til 1 050 kr. Skolens hovednettside viser pakker fra 25 850 kr, avhengig av antall kjøretimer; MC-grunnkurset er ikke inkludert.";
    }

    if (licenseClass === "a2") {
      return "For klasse A2 er en kjøretime oppført til 1 050 kr, mens pakken med ti kjøretimer og obligatorisk opplæring er oppført til 27 850 kr. MC-grunnkurset er ikke inkludert.";
    }

    if (licenseClass === "b") {
      return "En ordinær kjøretime for klasse B er oppført til 900 kr. TABS fremhever pakker på 37 000 kr med 16 kjøretimer og 41 000 kr med 20 kjøretimer, inkludert obligatorisk opplæring og gebyr.";
    }
  }

  if (
    includesAny(t, ["forskjell", "forskjellen"]) &&
    includesAny(t, ["be"]) &&
    includesAny(t, ["b96"])
  ) {
    return "B96 gjelder når summen av bilens og tilhengerens tillatte totalvekt er mellom 3 500 og 4 250 kg. BE gir mulighet for tilhenger med tillatt totalvekt opptil 3 500 kg, innenfor reglene som ellers gjelder for bil og tilhenger.";
  }

  // The original demo used broad class-B shortcuts. Let the expanded KB handle
  // specialised questions so MC, trailer, pickup and accessibility queries
  // cannot be mistaken for a generic class-B question.
  const shouldUseExpandedKB =
    Boolean(licenseClass) ||
    includesAny(t, [
      "motorsykkel",
      "mc",
      "a1",
      "a2",
      "klasse a",
      " be",
      "b96",
      "tilhenger",
      "henger",
      "automat",
      "pakke",
      "sikkerhetskurs",
      "glattkjøring",
      "glattkjoring",
      "øvingsbane",
      "ovingsbane",
      "førerprøve",
      "forerprove",
      "oppkjøring",
      "oppkjoring",
      "tegnspråk",
      "tegnsprak",
      "døv",
      "dove",
      "dov",
      "hørselshemmet",
      "horselshemmet",
      "tilrettelagt",
      "hente",
      "henting",
      "bringe",
      "stor-bergen",
      "stor bergen",
      "loddefjord",
      "fana",
      "nesttun",
      "askøy",
      "askoy",
      "sotra",
      "åsane",
      "asane",
      "ansatt",
      "trafikklærer",
      "trafikklaerer",
      "elevside",
      "kursoversikt",
      "forskjell",
      "trinnvurdering",
      "trinn 2",
      "trinn 3",
      "gebyr",
      "naf",
      "bomring",
      "betaling",
      "avbestill",
      "endre kjøretime",
      "kursdato",
      "ledige plasser"
    ]);

  if (shouldUseExpandedKB) return null;

  // Course-price checks also precede the lesson fallback. Otherwise a query
  // such as "hva koster grunnkurset og hvor mange timer" can be misread as a
  // generic driving-lesson question.
  if (
    asksPrice &&
    includesAny(t, [
      "trafikalt grunnkurs",
      "grunnkurs",
      "tg"
    ])
  ) {
    return "Trafikalt grunnkurs hos Fyllingsdalen Trafikkskole er oppført til 1 400 kr.";
  }

  if (
    asksPrice &&
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
    return "I skolens liveoversikt i TABS er Mørkedemo Jondal oppført til 1 500 kr. Hovednettsidens prisside viser også Trafikant i mørket til 2 200 kr, så kontroller riktig kurs i kursoversikten før påmelding.";
  }

  // Ordinary class-B lesson. Require lesson wording rather than any mention
  // of "timer", which may describe a course duration instead of a lesson.
  if (
    asksPrice &&
    includesAny(t, [
      "kjøretime",
      "kjøretimer",
      "kjoretime",
      "kjoretimer",
      "timepris",
      "vanlig time",
      "klasse b time",
      "45 min"
    ])
  ) {
    return "En vanlig kjøretime på 45 minutter for klasse B er oppført til 900 kr hos Fyllingsdalen Trafikkskole.";
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
    return "For klasse B fremhever TABS 37 000 kr for 16 kjøretimer og 41 000 kr for 20 kjøretimer, inkludert obligatorisk opplæring og gebyr. Andre grunnpriser vises også i kildene, så kontroller innhold og beløp for den konkrete pakken.";
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
    return "TABS oppgir 7 150 kr for sikkerhetskurs på øvingsbane. Hovednettsiden oppgir 5 600 kr for manuelt gir og 5 400 kr for automat, så kontroller beløpet for den konkrete bookingen.";
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

  if (isEmergencyAddressQuestion(message)) {
    return "Fyllingsdalen Trafikkskole holder til i Folke Bernadottes vei 44, 5147 Fyllingsdalen, i Spectrum-bygget.";
  }

  if (
    includesAny(t, [
      "telefon",
      "telefonnummer",
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
      "åpne",
      "apent",
      "apne",
      "kontortid",
      "når er dere åpne",
      "nar er dere apne"
    ])
  ) {
    return "Skolens liveoversikt i TABS oppgir kontortid tirsdag kl. 15–16, onsdag kl. 11–13 og torsdag kl. 16–18. Sjekk gjerne oversikten eller ring 920 12 800 før du møter opp, siden hovednettsiden viser andre tider.";
  }

  if (
    !asksPrice &&
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

function directTillerAnswer(client, message) {
  const c = String(client || "").toLowerCase().trim();

  if (c !== "tiller") return null;

  const t = makeNorwegianSearchText(message);
  const normalizedMessage = norm(message);
  const rawMessage = String(message || "").toLowerCase();
  const known = reply => ({ reply, unsure: false });
  const uncertain = reply => ({ reply, unsure: true });
  const unknown = detail => ({
    reply: `Det står ikke spesifisert på Tiller Trafikkskoles nettside.${detail ? ` ${detail}` : ""} Kontakt skolen på 96 84 73 41, post@tillertrafikkskole.no eller via https://tillertrafikkskole.no/contact.`,
    unsure: true
  });
  const asksPrice = includesAny(t, [
    "pris", "priser", "prisen", "prisene", "koster", "koste", "kostnad", "hvor mye", "kor mye", "gebyr", "price", "cost"
  ]);
  const asksTrafficBasicCourse = includesAny(t, [
    "trafikalt grunnkurs", "trafikalt grunnkurset", "grunnkurs", "tgk"
  ]);
  const asksPackage = includesAny(t, [
    "pakke", "pakken", "pakker", "standardpakke", "standardpakken", "superpakke", "superpakken"
  ]);
  const asksStandardPackage = includesAny(t, ["standardpakke", "standardpakken", "standard pakke", "18 900", "18900"]) ||
    (asksPrice && /\bstandard\b/.test(normalizedMessage));
  const asksSuperPackage = includesAny(t, ["superpakke", "superpakken", "super pakke", "24 900", "24900"]) ||
    (asksPrice && /\bsuper\b/.test(normalizedMessage));
  const asksDrivingTest = includesAny(t, [
    "førerprøve", "forerprove", "oppkjøring", "oppkjoring", "praktisk prøve", "praktisk prove"
  ]);
  const asksForLink = includesAny(t, ["lenke", "link", "url"]);
  const asksCancellation = includesAny(t, [
    "avbestill", "avlys", "kanseller", "kansellere", "endre kjøretime", "flytte kjøretime", "no-show", "ikke møte", "ikke mote"
  ]);
  const asksBooking = !asksCancellation && (
    includesAny(t, [
      "booke", "booking", "bestille", "bestiller", "bestilling", "melde meg på", "melde meg pa",
      "melde mæ på", "melde mae pa", "melde seg på", "melde seg pa", "registrere meg", "påmelding", "pamelding"
    ]) || /\bbook\b/.test(normalizedMessage)
  );
  const statedAgeMatch = normalizedMessage.match(
    /\b(?:jeg er|jeg e|ae e|er jeg|fylt|alderen min er)\s*(\d{1,2})\b/
  ) || normalizedMessage.match(/\b(\d{1,2})\s*(?:aring|aringer|ar gammel)\b/);
  const statedAge = statedAgeMatch ? Number(statedAgeMatch[1]) : null;

  // The demo answers questions only. It must not appear to collect a lead or
  // echo personal information entered by a visitor.
  const enteredEmails = rawMessage.match(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi) || [];
  const enteredEmail = enteredEmails.some(email => email.toLowerCase() !== "post@tillertrafikkskole.no");
  const phoneScanText = rawMessage
    .replace(/\b\d{1,2}[./-]\d{1,2}[./-]\d{2,4}\b/g, " ")
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}\b/g, " ");
  const enteredNumberCandidates = phoneScanText.match(/(?:^|\D)(?:\+?\d[\s.-]*){8,11}(?!\d)/g) || [];
  const enteredLongNumber = enteredNumberCandidates.some(candidate => {
    const digits = candidate.replace(/\D/g, "");
    return digits !== "96847341" && digits !== "4796847341";
  });
  const asksToStoreOrContact = includesAny(t, [
    "lagre kontakt", "lagre navnet", "lagre e-post", "lagre epost", "lagre telefon",
    "kontakt meg", "ring meg", "ringe meg", "ring meg tilbake", "ringe meg tilbake",
    "kan dere ringe", "tilbakeringing", "navnet mitt", "jeg heter", "min e-post", "min epost",
    "mitt telefonnummer", "telefonnummeret mitt", "send svaret til", "fødselsnummer", "fodselsnummer",
    "personopplysning", "fylle inn e-post", "fylle inn epost", "send henvendelsen",
    "videresend meldingen", "videresende meldingen", "min adresse", "adressen min"
  ]);

  if (includesAny(t, [
    "ip-adresse", "ip adresse", "ip-adressen", "dataene mine", "behandles data", "personvern",
    "lagres chat", "lagrer chat", "lagrer dere chat", "chatloggen", "chatlogg", "samtalen lagret"
  ])) {
    return known("Demoen lagrer ikke selve spørsmålet i bruksloggen. En teknisk nettverksadresse behandles midlertidig for å begrense misbruk. Ikke skriv sensitive personopplysninger i chatten; kontakt Nova Dynamics dersom du trenger flere detaljer om behandlingen.");
  }

  if (enteredEmail || enteredLongNumber || asksToStoreOrContact) {
    return known("Denne demoen kan ikke lagre, videresende eller følge opp navn, telefonnummer, e-post eller andre personopplysninger. Ikke skriv sensitive opplysninger i chatten. Kontakt skolen direkte på 96 84 73 41 eller post@tillertrafikkskole.no.");
  }

  if (includesAny(t, [
    "kan du sende meg en e-post", "kan du sende meg en epost", "send meg en e-post", "send meg en epost",
    "kan chatten sende e-post", "kan chatten sende epost", "send e-post", "send epost", "sende e-post",
    "sende epost", "send svar", "sende svar"
  ])) {
    return known("Jeg kan ikke sende e-post eller følge opp henvendelser. Kontakt Tiller Trafikkskole direkte på post@tillertrafikkskole.no, 96 84 73 41 eller via https://tillertrafikkskole.no/contact.");
  }

  const directBookingRequest = asksBooking && (
    includesAny(t, [
      "kan du", "kan chatten", "gjør det", "gjor det", "for meg", "til meg", "her i chatten",
      "i denne chatten", "via chatten", "på nettsiden", "pa nettsiden"
    ]) ||
    (includesAny(t, ["kan jeg", "kan æ", "kan ae"]) && includesAny(t, ["her", "chatten", "nettsiden"])) ||
    /^(?:book|booke|bestill|bestille|meld|melde)\b/.test(normalizedMessage)
  );

  if (directBookingRequest) {
    return known("Denne demoen kan ikke bestille kjøretimer eller melde deg på kurs. Send en forespørsel via https://tillertrafikkskole.no/contact eller ring skolen på 96 84 73 41.");
  }

  if (asksCancellation) {
    return unknown("Avbestillingsfrist og regler for endring eller uteblivelse er ikke publisert; avklar dette før timen.");
  }

  if (
    asksPackage &&
    includesAny(t, ["forhåndsbetale", "forhandsbetale", "forhåndsbetales", "forhandsbetales", "betales på forhånd", "betales pa forhand", "betale før pakken", "betale for pakken på forhånd"])
  ) {
    return known("Ja. Tiller Trafikkskoles prisside sier at pakkene må betales på forhånd. Betalingsmåten er ikke oppgitt.");
  }

  if (
    includesAny(t, [
      "vipps", "vips", "bankkort", "kortbetaling", "betale med kort", "tar dere kort", "tar dokker kort", "faktura", "kontant", "delbetaling",
      "dele opp betalingen", "delt opp betalingen", "klarna", "betalingsmåte", "betalingsmate", "hvordan betale",
      "hvordan betaler", "betale etter", "betale senere", "etter timen", "etter kjøretimen", "etter kjoretimen",
      "må jeg betale før", "ma jeg betale for", "betalingstidspunkt"
    ])
  ) {
    return unknown("Nettsiden sier at pakkene skal forhåndsbetales, men oppgir ikke betalingsmåte eller vilkår for delbetaling.");
  }

  if (
    includesAny(t, ["hvor lenge varer", "varighet", "lengde på", "lengden på"]) &&
    includesAny(t, ["kjøretime", "kjoretime", "vanlig time"])
  ) {
    return unknown("Varigheten på en vanlig kjøretime er ikke publisert. Trinnvurdering 2 og 3 er derimot oppgitt til henholdsvis 45 og 60 minutter i pakkene.");
  }

  if (includesAny(t, ["henter dere", "hente meg", "henting", "hentetjeneste", "oppmøtested", "oppmotested", "skolen min", "jobben min"])) {
    return unknown("Skolen fremhever fleksible kjøretimer, men faste hentesteder er ikke publisert; avtal oppmøtested direkte med trafikklæreren.");
  }

  if (
    includesAny(t, [
      "åpningstid", "apningstid", "kontortid", "åpent", "apent", "åpne", "apne",
      "stengt", "stenger", "opening hours"
    ]) || /\bapen\b/.test(normalizedMessage)
  ) {
    return unknown("Faste åpningstider er ikke publisert; ring før oppmøte.");
  }

  if (
    (
      includesAny(t, ["ledig kjøretime", "ledig kjoretime", "ledige kjøretimer", "ledige kjoretimer", "ledig time", "time ledig", "tilgjengelig kjøretime", "tilgjengelig kjoretime"]) ||
      (includesAny(t, ["ledig", "ledige", "tilgjengelig"]) && includesAny(t, ["kjøretim", "kjoretim"]))
    ) &&
    !asksTrafficBasicCourse
  ) {
    return unknown("Ledige kjøretimer publiseres ikke på nettsiden. Kontakt skolen for å avklare tilgjengelighet.");
  }

  const asksAgeExemption = includesAny(t, [
    "fritatt", "fritak", "slippe grunnkurs", "slipper grunnkurs", "må jeg ta grunnkurs", "ma jeg ta grunnkurs",
    "må jeg ta trafikalt grunnkurs", "ma jeg ta trafikalt grunnkurs", "må jeg ta tgk", "ma jeg ta tgk"
  ]);

  if ((asksTrafficBasicCourse || asksAgeExemption) && statedAge !== null) {
    if (statedAge < 15) {
      return known(`Nei, ikke ennå. Tiller Trafikkskole opplyser at trafikalt grunnkurs kan tas fra fylte 15 år. Du oppgir at du er ${statedAge}.`);
    }

    if (statedAge > 25) {
      return known("Skolens nettside opplyser at kandidater over 25 år bare trenger deler av trafikalt grunnkurs før oppstart med klasse B. Kontakt skolen for å få bekreftet nøyaktig hvilke deler du må gjennomføre.");
    }

    if (statedAge === 25 && asksAgeExemption) {
      return unknown("Nettsiden bruker formuleringen «over 25 år». Be skolen bekrefte hvilke deler som gjelder akkurat når du er 25.");
    }

    return known("Tiller Trafikkskole opplyser at trafikalt grunnkurs kan tas fra fylte 15 år.");
  }

  if (asksTrafficBasicCourse && includesAny(t, ["over 25", "fylt 26", "eldre enn 25"])) {
    return known("Skolens nettside opplyser at kandidater over 25 år bare trenger deler av trafikalt grunnkurs før oppstart med klasse B. Kontakt skolen for å få bekreftet nøyaktig hvilke deler du må gjennomføre.");
  }

  if (asksTrafficBasicCourse && includesAny(t, ["alder", "aldersgrense", "hvor gammel", "15 år", "15 ar"])) {
    return known("Tiller Trafikkskole opplyser at trafikalt grunnkurs kan tas fra fylte 15 år.");
  }

  if (asksTrafficBasicCourse && includesAny(t, ["øvelseskjøre", "ovelseskjore", "øvelseskjøring", "ovelseskjoring"])) {
    return known("Trafikalt grunnkurs er første trinn før øvelseskjøring. Når de delene som gjelder for deg er fullført, må du følge Statens vegvesens regler og ha nødvendig dokumentasjon før du øvelseskjører. Kontakt skolen hvis du er usikker på hva som gjenstår.");
  }

  if (
    asksTrafficBasicCourse &&
    includesAny(t, ["uten mørkekjøring", "uten morkekjoring", "uten mørke", "uten morke", "ikke mørkekjøring", "ikke morkekjoring"])
  ) {
    return unknown("Nettsiden publiserer bare TGK-pakken til 2 900 kr, og den er oppgitt med teori, førstehjelp og mørkekjøring. En egen pris for grunnkurs uten mørkekjøring er ikke publisert.");
  }

  if (
    asksTrafficBasicCourse &&
    !asksPrice &&
    includesAny(t, ["påmelding", "pamelding", "melde meg på", "melde meg pa", "melde mæ på", "melde mae pa", "melder jeg meg på", "melder jeg meg pa", "bestille", "registrere"])
  ) {
    return known("For å melde interesse for trafikalt grunnkurs, send en forespørsel via https://tillertrafikkskole.no/contact eller ring skolen på 96 84 73 41. Bekreft dato og ledig plass direkte med skolen.");
  }

  if (
    !asksPrice && (asksBooking ||
    includesAny(t, [
      "hvordan kommer jeg i gang", "hvordan kommer æ i gang", "hvordan kommer ae i gang", "vil ta lappen",
      "ta lappen", "ka gjør æ", "ka gjor ae", "hva gjør jeg for å starte", "hva gjor jeg for a starte", "bli elev"
    ]))
  ) {
    return known("For å starte eller melde interesse, send en forespørsel via https://tillertrafikkskole.no/contact eller kontakt skolen på 96 84 73 41 eller post@tillertrafikkskole.no. Demoen kan ikke utføre bestillingen.");
  }

  if (includesAny(t, ["nettsiden deres", "nettside", "hjemmeside", "webside", "website"])) {
    return known("Den offisielle nettsiden til Tiller Trafikkskole er https://tillertrafikkskole.no/.");
  }

  if (includesAny(t, ["e-postadresse", "epostadresse", "e-postadressen", "epostadressen", "e-post", "epost", "email", "mailadresse", "mailen", "mail"])) {
    return known("Skolens publiserte e-postadresse er post@tillertrafikkskole.no.");
  }

  if (includesAny(t, ["telefonnummer", "telefon", "tlf", "phone number"]) || /\bringe\b/.test(normalizedMessage)) {
    return known("Telefonnummeret til Tiller Trafikkskole er 96 84 73 41.");
  }

  if (includesAny(t, ["hvordan kontakter", "ta kontakt", "kontaktinformasjon", "kontaktinfo", "kontakte dere", "kontakte skolen", "contact you"])) {
    return known("Du kan kontakte Tiller Trafikkskole på 96 84 73 41, post@tillertrafikkskole.no eller via https://tillertrafikkskole.no/contact.");
  }

  if (
    isEmergencyAddressQuestion(message) ||
    includesAny(t, [
      "besøksadresse", "besoksadresse", "adressa", "ka e adressa", "industriveien", "heimdal", "ligger skolen",
      "ligger trafikkskolen", "where are you", "kor e dokker", "hvor e dokker", "hvor e dokker hen", "kor holder dokker",
      "kor e skolen", "hvor e skolen"
    ])
  ) {
    return known("Tiller Trafikkskole oppgir besøksadressen Industriveien 3, 7080 Heimdal.");
  }

  if (includesAny(t, [
    "hvem driver", "daglig leder", "dagligleder", "mohammad", "mohammed", "trafikklærer", "trafikklaerer",
    "hvem jobber", "ansatte", "instruktør", "instruktor", "læreren", "laereren", "lærern", "laerern"
  ])) {
    return known("Tiller Trafikkskoles offisielle nettside presenterer Mohammad Alsayed som daglig leder og trafikklærer.");
  }

  if (includesAny(t, ["språk", "sprak", "engelsk", "english", "arabisk", "polsk", "flere språk", "undervisningsspråk", "undervisningssprak"])) {
    return known("Skolen opplyser at den tilbyr undervisning på flere språk, men nettsiden navngir ikke hvilke. Kontakt skolen for å bekrefte språket du ønsker.");
  }

  if (includesAny(t, ["hvilke klasser", "førerkortklasser", "forerkortklasser", "hva tilbyr", "tilbud har dere"])) {
    return known("Tiller Trafikkskoles offisielle nettside oppgir klasse B automat og trafikalt grunnkurs. Andre førerkortklasser er ikke oppført.");
  }

  // The official site markets class B automatic only. Explicitly rule out
  // other classes instead of allowing another client's knowledge to leak in.
  if (includesAny(t, ["manuell", "manuelt gir", "gire selv", "manual car"])) {
    return known("Tiller Trafikkskoles nettside beskriver tilbudet som klasse B automat. Opplæring med manuelt gir er ikke oppført.");
  }

  if (/(^|\s)(be|b96)(\s|$)/.test(normalizedMessage) || includesAny(t, ["tilhenger", "hengerlappen"])) {
    return known("BE og B96 er ikke oppført blant tilbudene på Tiller Trafikkskoles offisielle nettside.");
  }

  if (
    includesAny(t, ["motorsykkel", "a1", "a2", "tung mc", "lett mc", "mellomtung"]) ||
    /(^|\s)(?:mc|klasse a)(\s|$)/.test(normalizedMessage)
  ) {
    return known("Motorsykkelopplæring er ikke oppført blant tilbudene på Tiller Trafikkskoles offisielle nettside.");
  }

  if (includesAny(t, ["moped", "am146", "am 146", "traktor", "lastebil", "tungbil", "buss", "klasse c", "klasse d"])) {
    return known("Moped-, traktor-, lastebil- og bussopplæring er ikke oppført blant tilbudene på Tiller Trafikkskoles offisielle nettside.");
  }

  const mentionsPublishedSeptemberCourse =
    includesAny(t, ["grunnkurs", "tgk", "kurset", "kursdato"]) &&
    includesAny(t, [
      "18-21 september", "18.–21. september", "18. til 21. september", "18 til 21 september"
    ]);

  if (asksTrafficBasicCourse && asksPrice && mentionsPublishedSeptemberCourse) {
    return uncertain("Trafikalt grunnkurs er publisert til 2 900 kr og inkluderer teori, førstehjelp og mørkekjøring. Nettsiden viser teksten «grunnkurs 18.–21. september», men oppgir ikke år, klokkeslett eller ledige plasser. Bekreft dato og plass direkte med skolen.");
  }

  if (
    (asksTrafficBasicCourse && includesAny(t, ["kursdato", "dato for", "neste grunnkurs", "neste kurs", "ledig plass", "ledige plasser"])) ||
    mentionsPublishedSeptemberCourse
  ) {
    return uncertain("Nettsiden viser teksten «grunnkurs 18.–21. september», men oppgir ikke år, klokkeslett eller ledige plasser, så det kan ikke bekreftes at dette er neste kurs. Bekreft dato og plass direkte via https://tillertrafikkskole.no/contact eller på 96 84 73 41.");
  }

  if (
    includesAny(t, ["mørkekjøring", "morkekjoring", "trafikant i mørket", "trafikant i morket"]) &&
    includesAny(t, ["når", "nar", "sesong", "sommer", "vinter", "periode"])
  ) {
    return known("Statens vegvesen opplyser at Trafikant i mørket gjennomføres i mørkekjøringssesongen 1. november–15. mars. Mellom 16. mars og 31. oktober er det ikke mørkt nok. Dette avviker fra sesongteksten på skolens kursside, så bekreft aktuelle datoer med skolen.");
  }

  if (asksForLink && includesAny(t, ["pris", "prisene", "prisliste", "prislisten", "pakke", "pakker"])) {
    return known("Her er Tiller Trafikkskoles publiserte prisside: https://tillertrafikkskole.no/priser.");
  }

  if (asksForLink && includesAny(t, ["påmelding", "pamelding", "bestilling", "bestille", "kontakt", "kurs"])) {
    return known("Du kan sende en forespørsel til skolen her: https://tillertrafikkskole.no/contact.");
  }

  if (
    includesAny(t, ["hvor lenge", "varighet", "hvor mange timer"]) &&
    includesAny(t, ["sikkerhetskurs på bane", "sikkerhetskurs bane", "glattkjøring", "glattkjoring"])
  ) {
    return known("Sikkerhetskurs på bane er oppgitt til fire timer. Standardpakken beskriver i tillegg to timers kjøring tur-retur Lånke.");
  }

  if (
    includesAny(t, ["hvor lenge", "varighet", "hvor mange timer"]) &&
    includesAny(t, ["sikkerhetskurs på veg", "sikkerhetskurs på vei", "sikkerhetskurs veg", "sikkerhetskurs vei"])
  ) {
    return known("Sikkerhetskurs på veg er oppgitt til 13 undervisningstimer, fordelt på fire deler.");
  }

  if (
    includesAny(t, ["hvor lenge", "varighet", "hvor mange timer"]) &&
    includesAny(t, ["mørkekjøring", "morkekjoring", "trafikant i mørket", "trafikant i morket"])
  ) {
    return known("Mørkekjøringsdelen i trafikalt grunnkurs er oppgitt til tre undervisningstimer.");
  }

  if (
    includesAny(t, ["hvor lenge", "varighet", "hvor mange timer"]) &&
    includesAny(t, ["førstehjelp", "forstehjelp", "førstehjelpskurs", "forstehjelpskurs"])
  ) {
    return known("Førstehjelpsdelen i trafikalt grunnkurs er oppgitt til fire undervisningstimer.");
  }

  if (
    asksPackage &&
    (includesAny(t, ["forskjell", "sammenlign", "hvilken", "velge", "best"]) ||
      (asksStandardPackage && asksSuperPackage))
  ) {
    return known("Standardpakken koster 18 900 kr og Superpakken 24 900 kr. Den tydeligste forskjellen på prissiden er at Superpakken inkluderer ti vanlige kjøretimer. Begge pakkene har publiserte tillegg og må forhåndsbetales; se https://tillertrafikkskole.no/priser for hele oversikten.");
  }

  if (
    asksStandardPackage &&
    includesAny(t, ["kjøretim", "kjoretim"])
  ) {
    return known("Vanlige kjøretimer er ikke oppført som inkludert i Standardpakken. Superpakken oppgir derimot ti kjøretimer. Bekreft alltid pakkeinnholdet på https://tillertrafikkskole.no/priser før kjøp.");
  }

  if (
    asksStandardPackage &&
    includesAny(t, ["alle gebyr", "med gebyr", "totalpris", "totalt", "alt sammen", "komplett pris"])
  ) {
    return known("Det kan ikke oppgis én komplett totalsum fra prislisten. Standardpakken koster 18 900 kr, men vanlige kjøretimer er ikke oppført som inkludert. Førstehjelp, mørkekjøring, førerprøvegebyret på 1 490 kr og NAFs banegebyr på 1 550 kr er også listet som tillegg. Offentlige gebyrer kan endres.");
  }

  if (asksStandardPackage) {
    return known("Standardpakke 2026 koster 18 900 kr. Den inkluderer trinnvurdering 2 og 3, sikkerhetskurs på bane med to timers kjøring tur-retur Lånke, sikkerhetskurs på veg og leie av bil til førerprøven med oppvarmingstime. Førstehjelp, mørkekjøring, førerprøvegebyret på 1 490 kr og NAFs banegebyr på 1 550 kr er ikke inkludert. Pakken må forhåndsbetales.");
  }

  if (asksSuperPackage) {
    return known("Superpakke 2026 koster 24 900 kr. Den inkluderer ti kjøretimer, trinnvurdering 2 og 3, sikkerhetskurs på bane, sikkerhetskurs på veg og leie av bil til førerprøven med oppvarmingstime. Førstehjelp, mørkekjøring, førerprøvegebyret på 1 490 kr og NAFs banegebyr på 1 550 kr er ikke inkludert. Pakken må forhåndsbetales.");
  }

  if (asksPackage && includesAny(t, ["ikke inkludert", "utenom", "ekstra", "tillegg", "gebyr"])) {
    return known("Prislisten sier at førstehjelp, mørkekjøring, Statens vegvesens førerprøvegebyr på 1 490 kr og NAFs banegebyr på 1 550 kr ikke er inkludert i pakkene. Pakkene må forhåndsbetales.");
  }

  if (asksPackage || (asksPrice && includesAny(t, ["pakker", "pakkene"]))) {
    return known("Tiller Trafikkskole publiserer to klasse B-pakker for 2026: Standardpakke til 18 900 kr og Superpakke til 24 900 kr. Superpakken oppgir ti kjøretimer i tillegg. Se hele innholdet og tilleggene på https://tillertrafikkskole.no/priser.");
  }

  const compoundPublishedPrices = [];

  if (asksTrafficBasicCourse) {
    compoundPublishedPrices.push("Trafikalt grunnkurs er publisert til 2 900 kr og inkluderer teori, førstehjelp og mørkekjøring.");
  }

  if (includesAny(t, ["mørkekjøring", "morkekjoring", "trafikant i mørket", "trafikant i morket"])) {
    compoundPublishedPrices.push("Mørkekjøring koster 1 400 kr når den kjøpes separat.");
  }

  if (includesAny(t, ["førstehjelp", "forstehjelp", "førstehjelpskurs", "forstehjelpskurs"])) {
    compoundPublishedPrices.push("Førstehjelp koster 800 kr når det kjøpes separat.");
  }

  if (includesAny(t, ["kjøretime", "kjoretime", "kjøretima", "kjoretima", "kjøretimen", "kjoretimen"])) {
    compoundPublishedPrices.push("En kjøretime for klasse B er publisert til 800 kr; vanlig timevarighet er ikke oppgitt.");
  }

  if (asksPrice && compoundPublishedPrices.length >= 2) {
    return known(compoundPublishedPrices.join(" "));
  }

  if (asksPrice && asksTrafficBasicCourse) {
    return known("Trafikalt grunnkurs er publisert til 2 900 kr og inkluderer teori, førstehjelp og mørkekjøring. Skolen oppgir 17 undervisningstimer fordelt på fem samlinger.");
  }

  if (asksPrice && includesAny(t, ["mørkekjøring", "morkekjoring", "trafikant i mørket", "trafikant i morket"])) {
    return known("Mørkekjøring er publisert til 1 400 kr når den kjøpes separat. Den er inkludert i TGK-pakken til 2 900 kr.");
  }

  if (asksPrice && includesAny(t, ["førstehjelp", "forstehjelp", "førstehjelpskurs", "forstehjelpskurs"])) {
    return known("Førstehjelp er publisert til 800 kr når den kjøpes separat. Den er inkludert i TGK-pakken til 2 900 kr.");
  }

  if (asksPrice && includesAny(t, ["trinnvurdering 2", "trinnvurdering trinn 2", "trinnvurdering to"])) {
    return known("Trinnvurdering 2 koster 850 kr som enkeltpost. I pakkene er den oppgitt til 45 minutter.");
  }

  if (asksPrice && includesAny(t, ["trinnvurdering 3", "trinnvurdering trinn 3", "trinnvurdering tre"])) {
    return known("Trinnvurdering 3 koster 1 000 kr som enkeltpost og er oppgitt til 60 minutter.");
  }

  if (asksPrice && includesAny(t, ["trinnvurdering", "trinn vurdering"])) {
    return known("Trinnvurdering 2 koster 850 kr og er oppgitt til 45 minutter. Trinnvurdering 3 koster 1 000 kr og er oppgitt til 60 minutter.");
  }

  if (asksPrice && includesAny(t, ["trinn 2", "trinn to", "trinn 3", "trinn tre"])) {
    return unknown("En totalpris for hele opplæringstrinnet er ikke publisert. Bare trinnvurdering 2 til 850 kr og trinnvurdering 3 til 1 000 kr er oppført som egne poster; øvrig behov varierer.");
  }

  if (asksPrice && includesAny(t, ["sikkerhetskurs på bane", "sikkerhetskurs bane", "glattkjøring", "glattkjoring", "naf bane", "naf-gebyr", "naf gebyr", "naf-banegebyr"])) {
    return known("Sikkerhetskurs på bane koster 4 600 kr. NAFs banegebyr på 1 550 kr kommer i tillegg. Pakkebeskrivelsen oppgir fire timer på banen og, for Standardpakken, to timer kjøring tur-retur Lånke.");
  }

  if (asksPrice && includesAny(t, ["4.1.1", "bilkjøringens risiko", "bilkjoringens risiko"])) {
    return known("Del 4.1.1, Bilkjøringens risiko, er publisert til 890 kr.");
  }

  if (asksPrice && includesAny(t, ["4.1.2", "landeveg", "landevei", "landevegsmiljø", "landevegsmiljo"])) {
    return known("Del 4.1.2, Kjøring i landevegsmiljø, er publisert til 4 600 kr.");
  }

  if (asksPrice && includesAny(t, ["4.1.3", "planlegging", "variert trafikkmiljø", "variert trafikkmiljo"])) {
    return known("Del 4.1.3, Planlegging og kjøring i variert trafikkmiljø, er publisert til 3 600 kr.");
  }

  if (asksPrice && includesAny(t, ["4.1.4", "refleksjon", "oppsummering"])) {
    return known("Del 4.1.4, Refleksjon og oppsummering, er publisert til 890 kr.");
  }

  if (asksPrice && includesAny(t, [
    "sikkerhetskurs på veg", "sikkerhetskurs på vei", "sikkerhetskurs veg", "sikkerhetskurs vei",
    "kjøring på veg", "kjøring på vei", "kjoring pa veg", "kjoring pa vei"
  ])) {
    return known("Prislisten deler sikkerhetskurs på veg i fire deler: 4.1.1 til 890 kr, 4.1.2 til 4 600 kr, 4.1.3 til 3 600 kr og 4.1.4 til 890 kr.");
  }

  if (asksPrice && includesAny(t, ["sikkerhetskurs"])) {
    return known("Sikkerhetskurs på bane koster 4 600 kr, med NAFs banegebyr på 1 550 kr i tillegg. Sikkerhetskurs på veg er delt i fire publiserte deler: 890 kr, 4 600 kr, 3 600 kr og 890 kr.");
  }

  if (asksPrice && asksDrivingTest && includesAny(t, ["leie", "skolebil", "bil", "oppvarming"])) {
    return known("Leie av bil til førerprøven koster 2 900 kr og inkluderer en oppvarmingstime. Statens vegvesens gebyr for den praktiske prøven er oppført separat til 1 490 kr på skolens prisside.");
  }

  if (asksPrice && asksDrivingTest) {
    return known("Tiller Trafikkskoles prisside oppgir 1 490 kr i gebyr for den praktiske prøven. Leie av skolebil med oppvarmingstime koster 2 900 kr i tillegg når den kjøpes separat. Kontroller alltid dagens offentlige gebyr hos Statens vegvesen.");
  }

  if (asksPrice && includesAny(t, ["teoriprøve", "teoriprove", "teorieksamen"])) {
    return known("Skolens prisside oppgir 480 kr som gebyr for teoriprøven. Kontroller alltid dagens offentlige gebyr hos Statens vegvesen.");
  }

  if (asksPrice && includesAny(t, ["utstedelse", "utstede"]) && includesAny(t, ["gebyr", "pris", "koster"])) {
    return known("Skolens prisside oppgir 160 kr for utstedelse av førerkort. Kontroller alltid dagens offentlige gebyr hos Statens vegvesen.");
  }

  if (asksPrice && includesAny(t, [
    "kjøretime", "kjoretime", "kjøretima", "kjoretima", "kjøretimen", "kjoretimen", "timepris", "biltime",
    "vanlig time", "automat-time", "automat time"
  ])) {
    return known("En kjøretime for klasse B er publisert til 800 kr. Varigheten på en vanlig kjøretime er ikke spesifisert på prissiden.");
  }

  if (asksPrice && includesAny(t, ["totalpris", "totalt", "alt sammen", "hele førerkortet", "hele forerkortet"])) {
    return known("Totalprisen varierer med hvor mange kjøretimer du trenger og hvilket opplegg du velger. Standardpakken koster 18 900 kr og Superpakken 24 900 kr, men førstehjelp, mørkekjøring og enkelte offentlige eller eksterne gebyrer er oppført som tillegg.");
  }

  if (asksPrice && includesAny(t, ["skjult gebyr", "skjulte gebyr", "ekstra kostnad", "ekstra gebyr"])) {
    return known("Tiller Trafikkskole skriver at de ikke har skjulte gebyrer. Prissiden lister likevel førstehjelp, mørkekjøring, førerprøvegebyret og NAFs banegebyr som tillegg til pakkene, så kontroller alltid hele oversikten før kjøp.");
  }

  if (asksPrice) {
    return known("Prislisten oppgir blant annet kjøretime til 800 kr, Standardpakke 2026 til 18 900 kr, Superpakke 2026 til 24 900 kr og trafikalt grunnkurs til 2 900 kr. Se hele oversikten på https://tillertrafikkskole.no/priser.");
  }

  if (asksTrafficBasicCourse && includesAny(t, ["inneholder", "inkludert", "består", "bestar", "varighet", "hvor lenge", "timer", "samlinger"])) {
    return known("Skolen beskriver trafikalt grunnkurs som 17 undervisningstimer fordelt på fem samlinger: omtrent ti timer teori, fire timer førstehjelp og tre timer mørkekjøring.");
  }

  if (asksTrafficBasicCourse) {
    return known("Trafikalt grunnkurs er første trinn før øvelseskjøring. Tiller Trafikkskole oppgir 17 undervisningstimer over fem samlinger, og publiserer en pakke med teori, førstehjelp og mørkekjøring til 2 900 kr.");
  }

  if (includesAny(t, ["trinn 1", "første trinn", "forste trinn"])) {
    return known("Trinn 1 er trafikalt grunnkurs. Det dekker trafikkforståelse, førstehjelp, tiltak ved ulykke og mørkekjøring.");
  }

  if (includesAny(t, ["trinn 2", "andre trinn", "teknisk nivå"])) {
    return known("Trinn 2 handler om grunnleggende kjøretøy- og kjørekompetanse, som styring, bremsing og enkle trafikksituasjoner. Det avsluttes med trinnvurdering 2.");
  }

  if (includesAny(t, ["trinn 3", "tredje trinn", "trafikal del"])) {
    return known("Trinn 3 handler om variert trafikk, samhandling og risikoforståelse. Sikkerhetskurs på øvingsbane er obligatorisk, og trinnet avsluttes med trinnvurdering 3 på 60 minutter.");
  }

  if (includesAny(t, ["trinn 4", "fjerde trinn", "avsluttende opplæring"])) {
    return known("Trinn 4 er avsluttende opplæring med sikkerhetskurs på veg: bilkjøringens risiko, landevegskjøring, planlegging og kjøring i variert trafikkmiljø samt refleksjon og oppsummering.");
  }

  if (includesAny(t, ["fire trinn", "opplæringstrinn", "opplaeringstrinn", "prosessen", "opplæringsløp", "opplaeringslop"])) {
    return known("Klasse B-opplæringen er delt i fire trinn: trafikalt grunnkurs, grunnleggende kjøretøy- og kjørekompetanse, trafikal del og avsluttende opplæring.");
  }

  if (includesAny(t, ["automat", "automatgir", "klasse b", "personbil", "bilopplæring", "bilopplaering", "førerkort", "forerkort"])) {
    return known("Tiller Trafikkskole tilbyr opplæring i klasse B automat. Skolen fremhever moderne biler, fleksible kjøretimer og trygg veiledning.");
  }

  if (includesAny(t, [
    "moderne biler", "fleksible kjøretimer", "fleksible løsninger", "lavt stress", "trygg veiledning",
    "hvorfor velge", "koffer ska æ velge", "koffer ska ae velge", "koffer velge"
  ])) {
    return known("Skolen fremhever moderne biler, fleksible kjøretimer, trygg veiledning, lavt stress og et støttende læringsmiljø.");
  }

  if (includesAny(t, ["påmelding", "pamelding", "melde seg på", "melde seg pa", "melde mæ på", "melde ma på", "bestille", "booking", "booke", "bli elev", "starte", "komme i gang"])) {
    return known("For å starte eller melde interesse, send en forespørsel via https://tillertrafikkskole.no/contact eller kontakt skolen på 96 84 73 41 eller post@tillertrafikkskole.no.");
  }

  if (includesAny(t, ["hva kan du", "hva kan jeg spørre", "hva kan jeg sporre", "hjelpe med"])) {
    return known("Jeg kan svare på spørsmål om klasse B automat, trafikalt grunnkurs, Standardpakken, Superpakken, enkeltpriser, opplæringstrinn, kontakt og beliggenhet.");
  }

  if (includesAny(t, ["fortell om skolen", "om tiller", "hvem er tiller", "hva tilbyr dere", "tilbudet deres"])) {
    return known("Tiller Trafikkskole holder til i Industriveien 3 på Heimdal og tilbyr klasse B automat og trafikalt grunnkurs. Skolen fremhever moderne biler, fleksible løsninger, trygg veiledning og undervisning på flere språk.");
  }

  if (includesAny(t, ["takk", "tusen takk", "supert", "flott"])) {
    return known("Bare hyggelig! Spør gjerne hvis du lurer på noe mer om Tiller Trafikkskole.");
  }

  if (includesAny(t, ["ha det", "hadet", "adjø", "adjo", "snakkes"])) {
    return known("Ha det bra, og lykke til med veien mot førerkortet!");
  }

  if (includesAny(t, ["hei", "hallo", "god dag"])) {
    return known("Hei! Hva vil du vite om klasse B automat, trafikalt grunnkurs, priser eller oppstart hos Tiller Trafikkskole?");
  }

  return null;
}

// -------------------- Chat --------------------
const CHAT_RATE_WINDOW_MS = 60_000;
const CHAT_RATE_LIMIT = 120;
const chatRateBuckets = new Map();

function enforceChatRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket?.remoteAddress || "unknown";
  let bucket = chatRateBuckets.get(key);

  if (!bucket || now - bucket.startedAt >= CHAT_RATE_WINDOW_MS) {
    bucket = { startedAt: now, count: 0 };
    chatRateBuckets.set(key, bucket);

    const cleanupTimer = setTimeout(() => {
      const current = chatRateBuckets.get(key);
      if (current && current.startedAt === bucket.startedAt) chatRateBuckets.delete(key);
    }, CHAT_RATE_WINDOW_MS + 1000);
    cleanupTimer.unref?.();
  }

  bucket.count += 1;

  if (bucket.count > CHAT_RATE_LIMIT) {
    const retryAfterSeconds = Math.max(1, Math.ceil((CHAT_RATE_WINDOW_MS - (now - bucket.startedAt)) / 1000));
    res.setHeader("Retry-After", String(retryAfterSeconds));

    return res.status(429).json({
      reply: "Det kom mange spørsmål på kort tid. Vent litt og prøv igjen.",
      unsure: true
    });
  }

  if (chatRateBuckets.size > 1000) {
    for (const [ip, entry] of chatRateBuckets) {
      if (now - entry.startedAt >= CHAT_RATE_WINDOW_MS) chatRateBuckets.delete(ip);
    }
  }

  return next();
}

app.post("/chat", async (req, res) => {
  const origin = req.headers.origin || "";
  const client = safeSlug(req.body?.client || "demo");
  const message = String(req.body?.message || "").slice(0, 2000).trim();

  res.setHeader("Cache-Control", "no-store");

  if (!message) {
    return res.status(400).json({
      reply: "Skriv et spørsmål før du sender.",
      unsure: true
    });
  }

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

  let withinRateLimit = false;
  enforceChatRateLimit(req, res, () => {
    withinRateLimit = true;
  });

  if (!withinRateLimit) return;

  // Tiller's focused demo answers from the school's verified published
  // information. Any unanswered Tiller question receives a safe fallback
  // rather than leaking another client's data through fuzzy retrieval.
  const tillerAnswer = directTillerAnswer(client, message);

  if (tillerAnswer) {
    logUsage({
      ts: new Date().toISOString(),
      client,
      origin,
      kind: tillerAnswer.unsure ? "safe_tiller_answer" : "direct_tiller",
      in: message.length,
      out: tillerAnswer.reply.length
    });

    return res.json({
      reply: tillerAnswer.reply,
      unsure: tillerAnswer.unsure,
      suggestions: []
    });
  }

  if (client === "tiller") {
    const reply = "Jeg finner ikke et sikkert svar på det i de verifiserte kildene demoen bruker. Du kan kontakte Tiller Trafikkskole på 96 84 73 41, post@tillertrafikkskole.no eller via https://tillertrafikkskole.no/contact. Ikke skriv sensitive personopplysninger i chatten.";

    logUsage({
      ts: new Date().toISOString(),
      client,
      origin,
      kind: "safe_tiller_fallback",
      in: message.length,
      out: reply.length
    });

    return res.json({
      reply,
      unsure: true,
      suggestions: []
    });
  }

  // Deterministic Onsøy answers run before fuzzy KB ranking and before OpenAI.
  // The helper can explicitly mark an answer as uncertain when the requested
  // policy is not available in the school's published sources.
  const onsoyAnswer = directOnsoyAnswer(client, message);

  if (onsoyAnswer) {
    logUsage({
      ts: new Date().toISOString(),
      client,
      origin,
      kind: onsoyAnswer.unsure ? "safe_onsoy_answer" : "direct_onsoy",
      in: message.length,
      out: onsoyAnswer.reply.length
    });

    return res.json({
      reply: onsoyAnswer.reply,
      unsure: onsoyAnswer.unsure,
      suggestions: []
    });
  }

  if (client === "onsoy") {
    const reply = "Jeg finner ikke et sikkert svar på det i de verifiserte kildene demoen bruker. Du kan kontakte Onsøy Trafikkskole på 92 98 99 98 eller post@onsoytrafikkskole.no. Ikke skriv sensitive personopplysninger i chatten.";

    logUsage({
      ts: new Date().toISOString(),
      client,
      origin,
      kind: "safe_onsoy_fallback",
      in: message.length,
      out: reply.length
    });

    return res.json({
      reply,
      unsure: true,
      suggestions: []
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

  if (client === "fyllingsdalen") {
    const reply = "Jeg finner ikke et sikkert svar på det i de verifiserte kildene demoen bruker. Du kan kontakte Fyllingsdalen Trafikkskole på 920 12 800 eller dintrafikkskole@gmail.com. Ikke skriv sensitive personopplysninger i chatten.";

    logUsage({
      ts: new Date().toISOString(),
      client,
      origin,
      kind: "safe_fyllingsdalen_fallback",
      in: message.length,
      out: reply.length
    });

    return res.json({
      reply,
      unsure: true,
      suggestions: []
    });
  }

  const kb = getKB(client);

  // EMERGENCY ADDRESS OVERRIDE:
  // This catches address/location questions before the fuzzy search can confuse them.
  if (isEmergencyAddressQuestion(message)) {
    const addressEntry = kb.find(x => {
      const q = String(x.q || "").toLowerCase();

      return (
        q.includes("adresse") ||
        q.includes("address") ||
        q.includes("location") ||
        q.includes("lokasjon")
      );
    }) || kb.find(x => {
      const a = String(x.a || "").toLowerCase();

      return (
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

  const ranked = rankFAQForQuestion(queryForRanking, kb);
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
