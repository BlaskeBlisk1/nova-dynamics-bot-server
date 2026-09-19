const pathParts = window.location.pathname.split("/").filter(Boolean);
const previewRoute = pathParts[0] === "previews";
const client = ["demos", "previews"].includes(pathParts[0]) ? pathParts[1] : "";
const query = new URLSearchParams(window.location.search);
const analyticsSuppressed = previewRoute || query.get("test") === "1" || query.get("owner") === "1" || ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);

const POSTHOG_CAPTURE_URL = "https://eu.i.posthog.com/i/v0/e/";
const POSTHOG_PROJECT_TOKEN = "phc_pYeGcMEga5PbjhCqKHThphPCi4mdXFmnZMNov2NiZiRa";
function newId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, digit => {
    const byte = globalThis.crypto?.getRandomValues ? globalThis.crypto.getRandomValues(new Uint8Array(1))[0] : Math.floor(Math.random() * 256);
    return (Number(digit) ^ byte & 15 >> Number(digit) / 4).toString(16);
  });
}

function analyticsSessionId() {
  const fallback = `nova-demo-${newId()}`;
  try {
    const key = "nova-demo-analytics-session";
    const existing = sessionStorage.getItem(key);
    if (existing) return existing;
    sessionStorage.setItem(key, fallback);
  } catch { /* Restricted storage must not break the chat. */ }
  return fallback;
}
const analyticsDistinctId = analyticsSessionId();

function captureAnalytics(event, properties = {}) {
  if (analyticsSuppressed) return;
  const payload = {
    api_key: POSTHOG_PROJECT_TOKEN,
    event,
    distinct_id: analyticsDistinctId,
    properties: {
      $process_person_profile: false,
      product: "nova-demo",
      schema_version: 1,
      client: client || "unknown",
      ...properties
    }
  };

  void fetch(POSTHOG_CAPTURE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    keepalive: true
  }).catch(() => {
    // Analytics must never interrupt or alter the customer-facing demo.
  });
}

function classifyQuestion(value) {
  const text = String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");

  if (/\b(koster|pris|priser|tilbud|pakke|rabatt|betale|betaling)\b/.test(text)) return "pricing";
  if (/\b(apent|apningstid|stengt|nar har|opening|hours)\b/.test(text)) return "opening_hours";
  if (/\b(hvor|adresse|lokasjon|location|parkering|finner jeg)\b/.test(text)) return "location";
  if (/\b(bestill|booking|booke|timebestilling|melde meg pa|pamelding)\b/.test(text)) return "booking";
  if (/\b(kontakt|telefon|epost|e-post|ringe|mail)\b/.test(text)) return "contact";
  if (/\b(alder|gammel|krav|forerkort|klasse|kurs|automat|manuell)\b/.test(text)) return "eligibility_or_training";
  if (/\b(syn|brille|kontaktlinse|linse|oye|torr|undersokelse|tjeneste)\b/.test(text)) return "eye_care_or_service";
  return "other";
}

const businessName = document.getElementById("business-name");
const businessDescription = document.getElementById("business-description");
const eyebrow = document.getElementById("eyebrow");
const locationLabel = document.getElementById("location-label");
const highlights = document.getElementById("highlights");
const contextTitle = document.getElementById("context-title");
const contextDescription = document.getElementById("context-description");
const assistantLabel = document.getElementById("assistant-label");
const assistantAvatar = document.getElementById("assistant-avatar");
const statusLabel = document.getElementById("status-label");
const clientLogoWrap = document.getElementById("client-logo-wrap");
const clientLogo = document.getElementById("client-logo");
const sourceTitle = document.getElementById("source-title");
const sourceDescription = document.getElementById("source-description");
const suggestions = document.getElementById("suggestions");
const websiteLink = document.getElementById("website-link");
const messages = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");
const chatTools = document.getElementById("chat-tools");
const captureOpen = document.getElementById("capture-open");
const conversationReset = document.getElementById("conversation-reset");
const previewNotice = document.getElementById("preview-notice");

let config;
let conversationId;
let capturePanel;
let captureForm;
let captureBusy = false;
let offeredCapture = false;
let captureToken;
let reviewedPayload;
let submissionId;
let submissionUncertain = false;
let suggestedService = "";

function captureEnabled() {
  // Tenant-specific legacy pages can reuse this script without upgrade controls.
  if (!captureOpen || !chatTools) return false;
  const capture = config?.features?.capture;
  if (capture?.enabled !== true) return false;
  if (capture.mode === "preview") return true;
  try { return capture.mode === "live" && new URL(capture.privacyUrl).protocol === "https:"; }
  catch { return false; }
}

function isPreviewCapture() {
  return config?.features?.capture?.mode === "preview";
}

function scrollMessages() {
  messages.scrollTop = messages.scrollHeight;
}

function appendLinkedText(container, text) {
  const value = String(text || "");
  const urlPattern = /https?:\/\/[^\s<>"']+/g;
  let cursor = 0;

  for (const match of value.matchAll(urlPattern)) {
    let url = match[0];
    let trailing = "";

    while (/[),.;!?]$/.test(url)) {
      trailing = url.slice(-1) + trailing;
      url = url.slice(0, -1);
    }

    container.append(document.createTextNode(value.slice(cursor, match.index)));

    const link = document.createElement("a");
    link.href = url;
    link.textContent = url;
    link.target = "_blank";
    link.rel = "noreferrer";
    container.append(link);

    if (trailing) container.append(document.createTextNode(trailing));
    cursor = match.index + match[0].length;
  }

  container.append(document.createTextNode(value.slice(cursor)));
}

function addMessage(text, type) {
  const message = document.createElement("div");
  message.className = `message ${type}`;
  const sender = document.createElement("span");
  sender.className = "sr-only";
  sender.textContent = `${type === "user" ? "Du" : (config?.assistantLabel || "Digital assistent")}: `;
  message.append(sender);

  if (type === "bot") {
    appendLinkedText(message, text);
  } else {
    message.append(document.createTextNode(text));
  }
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;
  return message;
}

function addTypingIndicator() {
  const message = document.createElement("div");
  message.className = "message bot";
  message.setAttribute("aria-label", "Assistenten skriver");
  message.innerHTML = '<span class="typing"><span></span><span></span><span></span></span>';
  messages.appendChild(message);
  messages.scrollTop = messages.scrollHeight;
  return message;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

// Only match known service IDs against short class/service words. Never copy
// questions, transcripts or inferred personal details into contact requests.
function suggestCaptureService(question) {
  if (!captureEnabled()) return;
  const text = String(question).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/ø/g, "o").replace(/æ/g, "ae");
  const services = config.features.capture.services || [];
  const aliases = {
    "b-auto": /\bautomat(?:gir)?\b/,
    bil: /\bbil(?:en)?\b|\bklasse\s+b\b/,
    grunnkurs: /\btrafikalt grunnkurs\b|\btgk\b|^grunnkurs[\s?!.]*$/,
    synsundersokelse: /\bsynsundersokelse(?:n|r)?\b|\bsynstest(?:en)?\b/,
    kontaktlinser: /\bkontaktlinse(?:r|ne)?\b/,
    briller: /\bbrille(?:r|ne|reparasjon)?\b/
  };
  const allowed = new Set(["a", "a1", "a2", "b", "be", "b96", "am", "automat", "manuell"]);
  const matches = services.filter(service => {
    const id = String(service.id).toLowerCase();
    if (Object.hasOwn(aliases, id)) return aliases[id].test(text);
    return allowed.has(id) && new RegExp(`(?:^|\\bklasse\\s+)${id}(?:$|[\\s?!.])`).test(text);
  });
  if (matches.length === 1) suggestedService = String(matches[0].id);
  if (matches.length > 1) suggestedService = "";
}

function offerCapture() {
  if (!captureEnabled() || offeredCapture || capturePanel) return;
  offeredCapture = true;
  const offer = element("div", "message bot capture-offer");
  offer.append(element("p", "", "Vil du be om å bli kontaktet? Du kan også fortsette å stille spørsmål her."));
  const actions = element("div", "capture-actions");
  const yes = element("button", "capture-primary", "Ja, bli kontaktet");
  const no = element("button", "capture-secondary", "Ikke nå");
  yes.type = no.type = "button";
  yes.addEventListener("click", () => { offer.remove(); openCapture(); });
  no.addEventListener("click", () => { offer.remove(); input.focus(); });
  actions.append(yes, no);
  offer.append(actions);
  messages.append(offer);
  scrollMessages();
}

function openCapture() {
  if (!captureEnabled() || captureBusy) return;
  for (const offer of messages.querySelectorAll(".capture-offer")) offer.remove();
  if (capturePanel) {
    capturePanel.hidden = false;
    messages.append(capturePanel);
    capturePanel.querySelector("input, button")?.focus({ preventScroll: true });
    scrollMessages();
    return;
  }
  offeredCapture = true;
  capturePanel = element("section", "capture-panel");
  capturePanel.setAttribute("aria-labelledby", "capture-title");
  // Form editing is not a live announcement of the visitor's private details.
  capturePanel.setAttribute("aria-live", "off");
  const heading = element("h3", "", isPreviewCapture() ? "Prøv en kontaktforespørsel" : "Be om å bli kontaktet");
  heading.id = "capture-title";
  const description = element("p", "capture-description", isPreviewCapture()
    ? "Bare en test: Bruk oppdiktet navn og eksempeladresse. Ingenting sendes til virksomheten."
    : `Send en kort forespørsel til ${config.features.capture.name || config.name}. Dette bestiller ikke en time.`);
  captureForm = element("form", "capture-form");
  captureForm.innerHTML = `
    <label for="capture-name">Navn <span aria-hidden="true">*</span></label>
    <input id="capture-name" name="name" autocomplete="name" maxlength="100" placeholder="Kari Eksempel" required>
    <fieldset class="capture-contact"><legend>E-post eller telefon <span aria-hidden="true">*</span></legend>
      <p id="capture-contact-help" class="capture-help">Fyll inn minst én måte å kontakte deg på.</p>
      <div class="capture-field-pair"><div><label for="capture-email">E-post</label>
        <input id="capture-email" name="email" type="email" autocomplete="email" maxlength="254" placeholder="kari@example.com" aria-describedby="capture-contact-help"></div>
      <div><label for="capture-phone">Telefon</label>
        <input id="capture-phone" name="phone" type="tel" autocomplete="tel" maxlength="30" placeholder="Telefonnummer" aria-describedby="capture-contact-help"></div></div>
    </fieldset>
    <label for="capture-service">Hva gjelder det? <span aria-hidden="true">*</span></label>
    <select id="capture-service" name="service" required><option value="">Velg tjeneste</option></select>
    <label for="capture-time">Når passer det å bli kontaktet? <span class="capture-optional">(valgfritt)</span></label>
    <input id="capture-time" name="preferredTime" maxlength="120" placeholder="For eksempel hverdager etter kl. 16">
    <div class="capture-honeypot" aria-hidden="true"><label for="capture-website">Nettside</label><input id="capture-website" name="website" tabindex="-1" autocomplete="off"></div>
    <label class="capture-consent" for="capture-consent"><input id="capture-consent" name="consent" type="checkbox" required><span id="capture-consent-copy"></span></label>
    <p class="capture-help">Ikke oppgi helseopplysninger eller andre sensitive opplysninger.</p>
    <div class="capture-actions"><button class="capture-primary" type="submit">Se over forespørselen</button><button id="capture-cancel" class="capture-secondary" type="button">Fortsett å chatte</button></div>`;
  const serviceSelect = captureForm.elements.service;
  for (const service of config.features.capture.services || []) {
    const option = element("option", "", service.label);
    option.value = service.id;
    serviceSelect.append(option);
  }
  serviceSelect.value = suggestedService;
  const consentCopy = captureForm.querySelector("#capture-consent-copy");
  consentCopy.textContent = isPreviewCapture()
    ? "Jeg bruker bare oppdiktede opplysninger og vil lagre denne testforespørselen."
    : `Jeg ønsker at ${config.features.capture.name || config.name} kontakter meg om forespørselen.`;
  if (!isPreviewCapture() && config.features.capture.privacyUrl) {
    try {
      const privacyUrl = new URL(config.features.capture.privacyUrl);
      if (privacyUrl.protocol === "https:") {
        const privacyLink = element("a", "", "Les om personvern");
        privacyLink.href = privacyUrl.href;
        privacyLink.target = "_blank";
        privacyLink.rel = "noreferrer";
        consentCopy.append(document.createTextNode(" "), privacyLink);
      }
    } catch { /* An invalid URL must never become a clickable link. */ }
  }
  const email = captureForm.elements.email;
  const phone = captureForm.elements.phone;
  const name = captureForm.elements.name;
  const validateContact = () => {
    email.setCustomValidity(email.value.trim() || phone.value.trim() ? "" : "Fyll inn e-post eller telefon.");
    const number = phone.value.trim();
    const digits = number.replace(/\D/g, "").length;
    phone.setCustomValidity(number && (!/^[+\d ()-]{6,30}$/.test(number) || digits < 6 || digits > 15) ? "Oppgi et gyldig telefonnummer med 6–15 sifre." : "");
    name.setCustomValidity(name.value && name.value.trim().length < 2 ? "Oppgi et navn med minst to tegn." : "");
  };
  email.addEventListener("input", validateContact);
  phone.addEventListener("input", validateContact);
  name.addEventListener("input", validateContact);
  validateContact();
  captureForm.querySelector("#capture-cancel").addEventListener("click", () => {
    capturePanel.hidden = true;
    input.focus();
  });
  captureForm.addEventListener("submit", event => {
    event.preventDefault();
    validateContact();
    if (!captureForm.reportValidity()) return;
    const values = new FormData(captureForm);
    const payload = {
      client,
      name: String(values.get("name") || "").trim(),
      email: String(values.get("email") || "").trim(),
      phone: String(values.get("phone") || "").trim(),
      service: String(values.get("service") || ""),
      preferredTime: String(values.get("preferredTime") || "").trim(),
      consent: values.get("consent") === "on",
      website: String(values.get("website") || "")
    };
    if (JSON.stringify(payload) !== JSON.stringify(reviewedPayload)) submissionId = newId();
    reviewedPayload = payload;
    renderCaptureReview();
  });
  capturePanel.append(heading, description, captureForm);
  messages.append(capturePanel);
  captureForm.elements.name.focus({ preventScroll: true });
  scrollMessages();
}

function renderCaptureReview() {
  captureForm.hidden = true;
  capturePanel.querySelector(".capture-review")?.remove();
  const review = element("div", "capture-review");
  const reviewTitle = element("h4", "", "Er dette riktig?");
  reviewTitle.tabIndex = -1;
  review.append(reviewTitle);
  const summary = element("dl", "capture-summary");
  const service = (config.features.capture.services || []).find(item => item.id === reviewedPayload.service);
  const fields = [["Navn", reviewedPayload.name], ["E-post", reviewedPayload.email], ["Telefon", reviewedPayload.phone], ["Tjeneste", service?.label], ["Ønsket tidspunkt", reviewedPayload.preferredTime]];
  for (const [label, value] of fields) {
    if (!value) continue;
    summary.append(element("dt", "", label), element("dd", "", value));
  }
  review.append(summary, element("p", "capture-help", isPreviewCapture()
    ? "Testforespørselen sendes ikke til virksomheten."
    : "Du ber om å bli kontaktet. Tidspunktet er et ønske, ikke en bekreftet avtale."));
  const status = element("p", "capture-status");
  status.setAttribute("role", "status");
  const actions = element("div", "capture-actions");
  const submit = element("button", "capture-primary", isPreviewCapture() ? "Lagre testforespørsel" : "Send forespørsel");
  const edit = element("button", "capture-secondary", "Endre opplysninger");
  submit.type = edit.type = "button";
  edit.addEventListener("click", () => {
    if (captureBusy) return;
    review.remove();
    captureForm.hidden = false;
    captureForm.elements.name.focus({ preventScroll: true });
    scrollMessages();
  });
  submit.addEventListener("click", () => submitCapture(submit, edit, status));
  actions.append(submit, edit);
  review.append(status, actions);
  capturePanel.append(review);
  reviewTitle.focus({ preventScroll: true });
  scrollMessages();
}

async function captureRequest(path, payload) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) {
      const error = new Error("Capture request failed");
      error.httpStatus = response.status;
      throw error;
    }
    return result;
  } finally { clearTimeout(timer); }
}

async function obtainCaptureToken() {
  const session = await captureRequest("/api/capture/session", { client, ...(previewRoute ? { preview: true } : {}) });
  if (typeof session.token !== "string" || !session.token) throw new Error("Missing capture session");
  captureToken = session.token;
}

async function submitCapture(submit, edit, status) {
  if (captureBusy || !reviewedPayload || !submissionId) return;
  let requestAttempted = false;
  captureBusy = true;
  submit.disabled = edit.disabled = true;
  if (conversationReset) conversationReset.disabled = true;
  status.textContent = isPreviewCapture() ? "Lagrer testforespørselen…" : "Registrerer forespørselen…";
  status.classList.remove("capture-status-error");
  try {
    if (!captureToken) await obtainCaptureToken();
    let result;
    const request = () => {
      requestAttempted = true;
      return captureRequest("/api/capture/requests", { ...reviewedPayload, token: captureToken, submissionId });
    };
    try { result = await request(); }
    catch (error) {
      if (![401, 403].includes(error.httpStatus)) throw error;
      await obtainCaptureToken();
      result = await request();
    }
    if (!["preview_saved", "received"].includes(result.status) || !result.receipt || typeof result.message !== "string") throw new Error("Unconfirmed receipt");
    submissionUncertain = false;
    const heading = element("h3", "", result.mode === "preview" ? "Testforespørselen er lagret" : "Forespørselen er registrert");
    heading.id = "capture-title";
    heading.tabIndex = -1;
    const message = element("p", "capture-description", result.message);
    message.setAttribute("role", "status");
    const receipt = element("p", "capture-help", `Referanse: ${result.receipt}`);
    const done = element("button", "capture-secondary", "Fortsett å chatte");
    done.type = "button";
    done.addEventListener("click", () => input.focus());
    capturePanel.replaceChildren(heading, message, receipt, done);
    captureForm.reset();
    captureForm = undefined;
    reviewedPayload = undefined;
    submissionId = undefined;
    if (captureOpen) captureOpen.hidden = true;
    heading.focus({ preventScroll: true });
    scrollMessages();
  } catch (error) {
    // An interrupted response may still have saved the request. Keep the same
    // reviewed payload and submission ID so retrying cannot create a duplicate.
    submissionUncertain ||= requestAttempted && (!error.httpStatus || error.httpStatus >= 500);
    status.textContent = submissionUncertain
      ? "Forespørselen kan være registrert, men vi mangler bekreftelsen. Prøv igjen for å sjekke registreringen før du endrer opplysningene."
      : error.httpStatus === 400
      ? "Kontroller opplysningene ved å velge «Endre opplysninger», og prøv igjen."
      : error.httpStatus === 429
        ? "Det er mange forespørsler akkurat nå. Vent litt og prøv igjen. Opplysningene dine er beholdt."
        : "Vi kunne ikke bekrefte registreringen. Prøv igjen med samme opplysninger, så unngår vi en dobbelt forespørsel.";
    status.classList.add("capture-status-error");
    submit.textContent = "Prøv igjen";
  } finally {
    captureBusy = false;
    submit.disabled = false;
    edit.disabled = submissionUncertain;
    if (conversationReset) conversationReset.disabled = sendButton.disabled || submissionUncertain;
  }
}

async function ask(question, source = "typed") {
  const text = String(question || "").trim();
  if (!text || sendButton.disabled) return;

  const questionCategory = classifyQuestion(text);
  const startedAt = performance.now();

  captureAnalytics("question_submitted", {
    source,
    question_category: questionCategory,
    question_length: text.length
  });

  addMessage(text, "user");
  input.value = "";
  input.focus();
  sendButton.disabled = true;
  if (conversationReset) conversationReset.disabled = true;
  const typing = addTypingIndicator();

  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client, message: text,
        ...(config?.features?.conversation && conversationId ? { conversationId } : {}),
        ...(previewRoute ? { preview: true } : {}) })
    });
    const payload = await response.json();

    if (!response.ok) {
      const requestError = new Error(payload.reply || "Kunne ikke hente svar.");
      requestError.httpStatus = response.status;
      throw requestError;
    }

    typing.remove();
    if (config?.features?.conversation && typeof payload.conversationId === "string") conversationId = payload.conversationId;
    addMessage(payload.reply || "Jeg fant dessverre ikke et svar akkurat nå.", "bot");
    suggestCaptureService(text);
    if (payload.captureIntent === true && captureEnabled()) openCapture();
    else offerCapture();

    captureAnalytics(payload.unsure ? "answer_fallback" : "answer_success", {
      source,
      question_category: questionCategory,
      question_length: text.length,
      response_ms: Math.round(performance.now() - startedAt),
      http_status: response.status
    });
  } catch (error) {
    typing.remove();
    addMessage("Beklager – forbindelsen til demoen sviktet. Prøv igjen om et øyeblikk.", "bot");

    captureAnalytics("answer_error", {
      source,
      question_category: questionCategory,
      question_length: text.length,
      response_ms: Math.round(performance.now() - startedAt),
      http_status: Number(error?.httpStatus) || 0
    });

  } finally {
    sendButton.disabled = false;
    if (conversationReset) conversationReset.disabled = captureBusy || submissionUncertain;
  }
}

function renderConfig(payload) {
  config = payload;
  document.body.dataset.capture = captureEnabled() ? "enabled" : "disabled";
  if (previewNotice) previewNotice.hidden = !previewRoute;
  if (conversationReset) conversationReset.hidden = config.features?.conversation !== true;
  if (captureOpen) captureOpen.hidden = !captureEnabled();
  if (chatTools) chatTools.hidden = (!conversationReset || conversationReset.hidden) && (!captureOpen || captureOpen.hidden);
  if (config.fictional === true) {
    const pill = document.querySelector(".demo-pill");
    const label = document.querySelector(".context-label");
    if (pill) pill.textContent = "FIKTIVT EKSEMPEL";
    if (label) label.textContent = "EKSEMPELDEMO";
  }
  captureAnalytics("demo_opened", { business_name: config.name || client });
  document.title = `${config.name} | Jemlio demo`;
  document.documentElement.style.setProperty("--accent", config.accent || "#4f7cff");
  document.documentElement.style.setProperty("--accent-secondary", config.accentSecondary || "#7c5cff");
  document.body.dataset.theme = config.theme || "nova";
  businessName.textContent = config.name;
  businessDescription.textContent = config.description;
  eyebrow.textContent = config.eyebrow || "NETTSIDEASSISTENT";
  contextTitle.textContent = config.contextTitle || "Still et vanlig kundespørsmål";
  contextDescription.textContent = config.contextDescription || "Prøv et forslag eller skriv spørsmålet slik en ekte kunde ville formulert det.";
  assistantLabel.textContent = config.assistantLabel || "Digital assistent";
  assistantAvatar.textContent = config.assistantInitial || "J";
  statusLabel.textContent = config.statusLabel || "Tilgjengelig nå";
  sourceTitle.textContent = config.sourceTitle || "Bygget fra virksomhetens informasjon";
  sourceDescription.textContent = config.sourceDescription || "Dette er en uforpliktende demonstrasjon.";

  if (config.locationLabel) {
    locationLabel.textContent = config.locationLabel;
    locationLabel.hidden = false;
  }

  for (const highlight of config.highlights || []) {
    const item = document.createElement("span");
    item.textContent = highlight;
    highlights.appendChild(item);
  }

  if (config.logo) {
    clientLogo.src = config.logo;
    clientLogo.alt = `${config.name} logo`;
    clientLogoWrap.hidden = false;
    clientLogo.addEventListener("error", () => {
      clientLogoWrap.hidden = true;
    }, { once: true });
  }

  addMessage(config.greeting, "bot");

  for (const question of config.suggestedQuestions || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion";
    button.textContent = question;
    button.addEventListener("click", () => {
      captureAnalytics("suggested_question_clicked", {
        suggestion_position: (config.suggestedQuestions || []).indexOf(question) + 1
      });
      ask(question, "suggestion");

      if (window.matchMedia("(max-width: 900px)").matches) {
        const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        document.querySelector(".chat-card")?.scrollIntoView({
          behavior: reducedMotion ? "auto" : "smooth",
          block: "start"
        });
      }
    });
    suggestions.appendChild(button);
  }

  if (config.website) {
    websiteLink.href = config.website;
    websiteLink.hidden = false;
  }
}

async function initialize() {
  if (!client) {
    businessName.textContent = "Ugyldig demo";
    businessDescription.textContent = "Demo-adressen mangler et kundenavn.";
    form.hidden = true;
    return;
  }

  try {
    const response = await fetch(`/api/demo-config/${encodeURIComponent(client)}${previewRoute ? "?preview=1" : ""}`);
    if (!response.ok) throw new Error("Demo not found.");
    renderConfig(await response.json());
  } catch (error) {
    businessName.textContent = "Demoen ble ikke funnet";
    businessDescription.textContent = "Kontroller lenken eller be Jemlio om en ny demo-adresse.";
    form.hidden = true;
    captureAnalytics("demo_config_error");
    console.error(error);
  }
}

websiteLink.addEventListener("click", () => {
  captureAnalytics("business_website_clicked");
});

messages.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link || link.closest(".capture-panel")) return;

  let destinationHost = "unknown";
  try {
    destinationHost = new URL(link.href).hostname || "unknown";
  } catch {}

  captureAnalytics("answer_link_clicked", { destination_host: destinationHost });
});

form.addEventListener("submit", (event) => {
  event.preventDefault();
  ask(input.value, "typed");
});

captureOpen?.addEventListener("click", openCapture);

conversationReset?.addEventListener("click", () => {
  if (sendButton.disabled || captureBusy || submissionUncertain) return;
  const hasUnsavedContact = captureForm && ["name", "email", "phone", "preferredTime"].some(name => captureForm.elements[name].value.trim());
  if (hasUnsavedContact && !window.confirm("Starte en ny samtale? Usendte kontaktopplysninger blir tømt.")) return;
  conversationId = undefined;
  capturePanel = undefined;
  captureForm = undefined;
  captureToken = undefined;
  reviewedPayload = undefined;
  submissionId = undefined;
  submissionUncertain = false;
  suggestedService = "";
  offeredCapture = false;
  messages.replaceChildren();
  addMessage(config.greeting, "bot");
  if (captureOpen) captureOpen.hidden = !captureEnabled();
  input.focus();
});

// RoMa has its own existing reset control and presentation script. Clear the
// shared conversational context alongside that script's visual reset.
document.getElementById("reset-chat")?.addEventListener("click", () => {
  if (!sendButton.disabled && config) conversationId = undefined;
});

initialize();
