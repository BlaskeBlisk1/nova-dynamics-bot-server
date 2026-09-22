"use strict";

const { randomBytes } = require("node:crypto");
const { withoutRequestVerbBe, assessmentStages } = require("./norwegian-intents");

// This is deliberately a small, deterministic context resolver, not a chat
// transcript. Only the enum values declared below survive between requests.
const COURSE_LABELS = Object.freeze({
  A1: "klasse A1", A2: "klasse A2", A: "klasse A", B: "klasse B",
  B_AUTO: "klasse B med automatgir", B_MANUAL: "klasse B med manuelt gir",
  BE: "klasse BE", B96: "klasse B96", AM146: "moped AM146", MC: "MC"
});
const SERVICE_LABELS = Object.freeze({
  package: "pakke", lesson: "kjøretime", basic: "grunnkurs",
  traffic_basic: "trafikalt grunnkurs", road: "sikkerhetskurs på veg",
  track: "sikkerhetskurs på bane", traffic: "sikkerhetskurs i trafikk",
  safety: "sikkerhetskurs", dark: "mørkekjøring", firstaid: "førstehjelpskurs",
  eye_exam: "synsundersøkelse", lenses: "kontaktlinser", glasses: "briller",
  repair: "brillereparasjon", standard_package: "Standardpakken",
  super_package: "Superpakken", stage_2: "trinnvurdering 2", stage_3: "trinnvurdering 3"
});
const EYE_SERVICES = new Set(["eye_exam", "lenses", "glasses", "repair"]);
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const normalize = value => value.normalize("NFKC").toLowerCase()
  .replace(/æ/g, "ae").replace(/ø/g, "o").replace(/å/g, "a")
  .replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();

function courseIn(text) {
  // Mopedbil is a distinct class that this first resolver does not model.
  // Discard the whole candidate state instead of reducing it to AM146 or
  // retaining only its service and accidentally applying the wrong class later.
  if (/mopedbil|\bam\s*147\b/.test(text)) return { ambiguous: true, course: null };
  // Norwegian "be om" is a request, not the trailer licence BE. Keep a
  // genuinely bare "BE" (or "klasse BE") available as a class selection.
  text = withoutRequestVerbBe(text);
  const choices = [];
  if (/\ba\s*1\b|lett\s*(mc|motorsykkel)/.test(text)) choices.push("A1");
  if (/\ba\s*2\b|mellomtung/.test(text)) choices.push("A2");
  if (/\bklasse a\b(?!\s*[12])|\btung (mc|motorsykkel)|^(?:(?:hva med|og|for) )?a[?!. ]*$/.test(text)) choices.push("A");
  if (/\bbe\b/.test(text)) choices.push("BE");
  if (/\bb\s*(?:kode\s*)?96\b/.test(text)) choices.push("B96");
  if (/\bmoped(?:en|er|pakke(?:n|r)?)?\b|\bam\s*146\b/.test(text)) choices.push("AM146");
  const auto = /\bautomat(?:gir)?\b|\bbaut\b/.test(text);
  const manual = /\bmanuell?\b|\bmanuelt\b/.test(text);
  if (auto && manual) return { ambiguous: true, course: null };
  if (auto || manual || /\bb\b(?!\s*(?:kode\s*)?96\b)|\bbil\b|bilpakke/.test(text)) choices.push(auto ? "B_AUTO" : manual ? "B_MANUAL" : "B");
  if (/\bmc\b|motorsykkel/.test(text) && !choices.some(c => /^A[12]?$/.test(c))) choices.push("MC");
  return { ambiguous: choices.length > 1, course: choices.length === 1 ? choices[0] : null };
}

function serviceIn(text, client) {
  const choices = [];
  const add = (id, re) => { if (re.test(text)) choices.push(id); };
  // Named products belong to this tenant only. Keep both matches ambiguous
  // when a visitor compares packages instead of silently choosing one.
  if (client === "tiller") {
    add("standard_package", /\bstandard\s*pakke/);
    add("super_package", /\bsuper\s*pakke/);
    for (const stage of assessmentStages(text)) choices.push(`stage_${stage}`);
  }
  if (!choices.some(id => id.endsWith("_package"))) add("package", /pakke|pakketilbud/);
  // A package mentioning its included lessons is still a package; a question
  // explicitly comparing services stays ambiguous and is never carried over.
  add("lesson", /kjoretime|driving lesson/);
  add("traffic_basic", /trafikal[te]* grunnkurs|\btgk?\b|^trafikalt$/);
  if (/grunnkurs/.test(text) && !choices.includes("traffic_basic")) choices.push("basic");
  add("road", /sikkerhetskurs.*(?:vei|veg)|\bpa (?:vei|veg)\b|langkjor/);
  add("track", /glattkjor|ovingsbane|presis kjoreteknikk|\b(?:pa )?bane\b/);
  add("traffic", /sikkerhetskurs i trafikk|\bi trafikk\b/);
  if (/sikkerhetskurs/.test(text) && !choices.some(s => ["road", "track", "traffic"].includes(s))) choices.push("safety");
  add("dark", /morkekjor|trafikant i morket/);
  add("firstaid", /forstehjelp/);
  add("eye_exam", /synsundersok|synstest|synsprove/);
  add("lenses", /kontaktlinse/);
  add("repair", /brillereparasjon|repar.*brille/);
  // "Reparerer dere briller?" names one service; briller is its object.
  if (!choices.includes("repair")) add("glasses", /\bbriller\b/);
  return { ambiguous: choices.length > 1, service: choices.length === 1 ? choices[0] : null };
}

function intentIn(text) {
  if (/pris|kost|hvor mye|kor mye|how much|price/.test(text)) return "price";
  if (/hvor lenge varer|hvor lang tid tar|varighet/.test(text)) return "duration";
  if (/hva (?:inngar|inneholder|inkluderer)|hva er inkludert/.test(text)) return "contents";
  if (/book|bestill|pameld|melde.*pa/.test(text)) return "booking";
  return "info";
}

function isUnsafeToRemember(raw, text) {
  return /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(raw)
    || /(?:\d[\s()+-]*){8}/.test(raw)
    || /jeg heter|mitt navn|navnet mitt|min adresse|adressen min|personnummer|fodsel|ring meg|kontakt meg|epilepsi|diagnos|medisin|adhd|symptom/.test(text)
    || /personvern|lagr(?:e|er|ing)|videresend|send(?:e)? (?:svar|melding)/.test(text)
    // Medical context cannot be represented by a service enum. In particular,
    // a later "what does it cost?" must not turn acute eye symptoms into a
    // routine examination recommendation or price.
    || /synstap|dobbeltsyn|lysblink|floater|smerte|vondt|akutt|plutselig|rode? oy(?:e|ne)|rodt oye|svie|synsfelt|takete|uklart syn|helsekrav|sykdom|diabetes/.test(text)
    || /skad(?:e|et).*oy(?:e|ne)|kjemikal.*oy(?:e|ne)|(?:gronn|gra) staer|mistenk.*(?:syn|oy(?:e|ne))/.test(text)
    || /brillestyrke|hvilken styrke|anbefal.*styrke|resept.*(?:meg|min)|(?:mitt syn|synet mitt|mine oyne)|(?:kan|bor|ma|trenger).*jeg.*(?:bruke|velge|ha|ta).*(?:brill|linse|undersokelse)/.test(text)
    || /(?:jeg har|jeg plages|jeg sliter|jeg opplever).*(?:torr[e]? oy(?:e|ne)|oyeplag|klor|svie)/.test(text)
    || /ignore|ignorer|system.?prompt|api.?key|api.?nokkel|hemmelig|passord|password|lat som|pretend|override|instructions|instruks|<\/?(?:script|system)/.test(text);
}

function isExplicitReset(text) {
  return /^(?:nytt (?:tema|sporsmal)|glem (?:det|forrige)|start pa nytt|bytt tema|new topic|reset)\b/.test(text)
    || /^(?:hei|heisann|hallo|takk|tusen takk|ha det)[!. ]*$/.test(text);
}

function hasUnrepresentedIntent(text) {
  // Do not reduce availability, cancellation, legal/health conditions, or
  // contact/location questions to a generic product/service enquiry. Doing so
  // could turn a follow-up into a confident answer to a different question.
  return /avbestill|avmeld|avlys|kanseller|cancel|ledig|ventetid|neste|i morgen|idag|i dag|\bnar\b/.test(text)
    || /attest|\b\d{1,3}\s*[- ]?\s*min(?:utt(?:er|ers)?)?\b|dobbeltime/.test(text)
    || /fritak|fritatt|aldersgrense|forerrett|ovelseskjor|epilepsi|diagnos|helsekrav/.test(text)
    || /\bbarn(?:et|ets|a|s)?\b|\bbarnesyn\b|\b\d{1,2}\s*ar(?:ing|inger)?\b/.test(text)
    || /apningstid|kontortid|adresse|telefon|e-post|epost|hvor.*(?:ligg|holder)|\bkontakt(?:e|er)?\b/.test(text)
    || /(?:\b(?:etter|for) kl\b|\b(?:helg|kveld)(?:en)?\b)/.test(text);
}

function fragmentOf(text, client) {
  // Complete questions are not rewritten. Only this closed set of elliptical
  // replies is permitted to inherit information from the previous turn.
  const bare = text.replace(/^(?:hva med|og for|og|for|jeg mener|jeg tenkte pa)\s+/, "")
    .replace(/[?!.]+$/g, "").trim();
  if (/^(?:klasse\s+)?(?:a\s*[12]?|b(?:aut|\s*(?:kode\s*)?96|e)?|am\s*146|bil|mc|moped|automat(?:gir)?|manuell|manuelt gir|lett mc|mellomtung mc|tung mc)$/.test(bare)) return "course";
  if (/^(?:pakke(?:r|n)?|pakketilbud|kjoretime(?:r|n)?|grunnkurs(?:et)?|trafikalt(?: grunnkurs)?|tgk?|sikkerhetskurs|pa (?:vei|veg|bane)|sikkerhetskurs pa (?:vei|veg|bane)|i trafikk|morkekjoring|forstehjelp|synsundersokelse|synstest|kontaktlinser|briller|brillereparasjon)$/.test(bare)) return "service";
  if (client === "tiller" && /^(?:(?:standard|super)\s*pakke(?:n)?|trinnvurdering\s+(?:trinn\s+)?(?:2|3|to|tre))$/.test(bare)) return "service";
  const reference = text.replace(/^og\s+/, "");
  if (/^(?:hva|hvor mye|kor mye) koster (?:det|den|dette|denne)\??$|^(?:pris|prisen|hva er prisen)\??$/.test(reference)) return "price";
  if (/^(?:hvordan (?:bestiller|booker|melder) jeg (?:det|den|meg pa)|hvor (?:bestiller|booker) jeg (?:det|den))\??$/.test(reference)) return "booking";
  if (/^(?:hvor lenge varer|hvor lang tid tar) (?:det|den|dette|denne)\??$/.test(reference)) return "duration";
  if (/^(?:hva (?:er inkludert|inngar)(?: i (?:det|den|dette|denne))?|hva (?:inneholder|inkluderer) (?:det|den|dette|denne))\??$/.test(reference)) return "contents";
  if (/^(?:ja|nei|den|det|denne|det samme|hva med det)\??$/.test(reference)) return "ambiguous";
  return null;
}

function canonical(state) {
  const subject = [SERVICE_LABELS[state.service], COURSE_LABELS[state.course]].filter(Boolean).join(" for ");
  if (state.intent === "price") return `Hva koster ${subject}?`;
  if (state.intent === "booking") return `Hvordan bestiller jeg ${subject}?`;
  if (state.intent === "duration") return `Hvor lenge varer ${subject}?`;
  if (state.intent === "contents") return `Hva inngår i ${subject}?`;
  if (state.service === "package") return `Hvilke pakker har dere${state.course ? ` for ${COURSE_LABELS[state.course]}` : ""}?`;
  return `Jeg vil vite mer om ${subject}.`;
}

// Offer only questions that the two reviewed pilot handlers can answer.
// Each question is complete, so clicking after context expiry still names the
// intended service. Labels and questions are built from enums, never user text.
function followUpsFor(client, state) {
  if (!state) return [];
  let intents = [];
  if (client === "tiller" && (!state.course || ["B", "B_AUTO"].includes(state.course))) {
    if (["standard_package", "super_package", "traffic_basic"].includes(state.service)) {
      intents = ["price", "contents", "booking"];
    } else if (["lesson", "stage_2", "stage_3", "dark", "firstaid", "road", "track"].includes(state.service)) {
      intents = ["price", "booking"];
    }
  } else if (client === "frankolsen" && !state.course) {
    if (state.service === "eye_exam") intents = ["price", "contents", "booking"];
    if (state.service === "lenses") intents = ["contents", "booking"];
    if (["glasses", "repair"].includes(state.service)) intents = ["contact"];
  }
  const labels = { price: "Hva koster det?", contents: "Hva inngår?", booking: "Hvordan bestiller jeg?", contact: "Hvordan tar jeg kontakt?" };
  return intents.filter(intent => intent !== state.intent).map(intent => ({
    id: intent,
    label: labels[intent],
    message: intent === "contact" ? "Hvordan kontakter jeg Frank Olsen?"
      : client === "frankolsen" && state.service === "lenses"
        ? (intent === "contents" ? "Hva inngår i kontaktlinsetilpasning?" : "Hvordan bestiller jeg kontaktlinsetilpasning?")
        : canonical({ ...state, intent })
  }));
}

function clarificationFor(course, contextExpired, client) {
  const prefix = contextExpired ? "Jeg har ikke lenger konteksten fra forrige spørsmål. " : "";
  if (client === "frankolsen") return `${prefix}Hvilken tjeneste mener du: synsundersøkelse, kontaktlinser, briller eller reparasjon?`;
  if (course) return `${prefix}Hva vil du vite om ${COURSE_LABELS[course]}: kjøretime, pakke, kurs eller påmelding?`;
  return `${prefix}Hvilken tjeneste eller førerkortklasse mener du, og hva vil du vite om den?`;
}

/**
 * Stores bounded ephemeral enum-only context. The caller must authenticate the
 * tenant/origin and enable this per tenant before preparing a request. Use the
 * clarification as the reply when present; otherwise send message to the
 * existing answer function. Never expose or persist rewritten messages in
 * analytics: they are only inputs to the normal answer path.
 */
function createConversationManager({ ttlMs = 15 * 60 * 1000, maxSessions = 500, now = Date.now } = {}) {
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new TypeError("ttlMs must be positive");
  if (!Number.isInteger(maxSessions) || maxSessions < 1) throw new TypeError("maxSessions must be a positive integer");
  if (typeof now !== "function") throw new TypeError("now must be a function");
  const sessions = new Map();

  function prepare({ client, origin = "", message, conversationId } = {}) {
    if (typeof client !== "string" || !client || client.length > 128) throw new TypeError("Invalid client");
    if (typeof origin !== "string" || origin.length > 2048) throw new TypeError("Invalid origin");
    if (typeof message !== "string" || message.length > 10000) throw new TypeError("Invalid message");
    const timestamp = now();
    if (!Number.isFinite(timestamp)) throw new TypeError("Invalid clock");
    for (const [id, session] of sessions) if (session.expiresAt <= timestamp) sessions.delete(id);

    const candidate = typeof conversationId === "string" && TOKEN.test(conversationId) ? sessions.get(conversationId) : null;
    const existing = candidate && candidate.client === client && candidate.origin === origin ? candidate : null;
    const text = normalize(message);
    const fragment = fragmentOf(text, client);
    const contextExpired = !existing && (conversationId != null || Boolean(fragment));
    const id = existing ? conversationId : randomBytes(32).toString("base64url");
    const previous = existing ? existing.state : null;
    let state = null;
    const result = { message, conversationId: id, contextExpired, contextApplied: false };

    // Negations may qualify the user's choice in ways our enum-only state
    // cannot represent. Keep the original question, clear the old state.
    if (!isExplicitReset(text) && !isUnsafeToRemember(message, text) && !hasUnrepresentedIntent(text) && !/\b(?:ikke|not)\b/.test(text)) {
      // A previous licence in a separate sentence is background, not the
      // requested course. This mirrors the Roma answer path without importing
      // any tenant-specific knowledge into this shared resolver.
      const tail = text.split(/[.!?]\s+/).at(-1);
      const requestedCourse = courseIn(tail);
      const requestedService = serviceIn(text, client);
      const intent = intentIn(text);
      if (fragment) {
        if (fragment === "course" && requestedCourse.course && previous && (previous.service || previous.intent === "price")) {
          state = { course: requestedCourse.course, service: previous.service, intent: previous.intent };
          // A licence class cannot sensibly qualify an optician's service.
          if (EYE_SERVICES.has(state.service)) state = null;
        } else if (fragment === "service" && requestedService.service) {
          const inheritCourse = previous && !EYE_SERVICES.has(requestedService.service) ? previous.course : null;
          state = { course: inheritCourse, service: requestedService.service, intent: previous ? previous.intent : "info" };
        } else if (["price", "booking", "duration", "contents"].includes(fragment) && previous && (previous.course || previous.service)) {
          state = { course: previous.course, service: previous.service, intent: fragment };
        }
        if (state) {
          result.message = canonical(state);
          result.contextApplied = Boolean(previous);
        } else {
          result.clarification = clarificationFor(requestedCourse.course, contextExpired, client);
          // A fresh class is useful for the user's next explicit service reply,
          // but no unknown previous intent is inferred.
          if (requestedCourse.course) state = { course: requestedCourse.course, service: null, intent: "info" };
        }
      } else if (!requestedCourse.ambiguous && !requestedService.ambiguous && (requestedCourse.course || requestedService.service)) {
        state = { course: requestedCourse.course, service: requestedService.service, intent };
      }
    }

    // Updating order makes capacity eviction LRU. Retain no original messages,
    // answers, names, addresses, user-agent details, or caller-supplied objects.
    sessions.delete(id);
    while (sessions.size >= maxSessions) sessions.delete(sessions.keys().next().value);
    const session = { client, origin, expiresAt: timestamp + ttlMs, state };
    sessions.set(id, session);
    // Preparing a question cannot establish that its qualified service exists.
    // The answer handler may still refuse medical advice or report an unknown
    // service. Let the caller discard that candidate after seeing the answer.
    // A late response may discard only its own turn, never a newer turn's state.
    result.discardContext = () => {
      if (sessions.get(id) === session) session.state = null;
    };
    result.getFollowUps = () => {
      // A discarded, expired or superseded turn cannot revive old choices.
      if (sessions.get(id) !== session || session.expiresAt <= now()) return [];
      return followUpsFor(client, session.state);
    };
    return result;
  }

  return { prepare, clear: () => sessions.clear(), get size() { return sessions.size; } };
}

module.exports = { createConversationManager };
