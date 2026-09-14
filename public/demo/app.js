const pathParts = window.location.pathname.split("/").filter(Boolean);
const client = pathParts[0] === "demos" ? pathParts[1] : "";

const POSTHOG_CAPTURE_URL = "https://us.i.posthog.com/i/v0/e/";
const POSTHOG_PROJECT_TOKEN = "phc_pYeGcMEga5PbjhCqKHThphPCi4mdXFmnZMNov2NiZiRa";
const analyticsDistinctId = `nova-demo-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

function captureAnalytics(event, properties = {}) {
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

let config;

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
  const typing = addTypingIndicator();

  try {
    const response = await fetch("/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ client, message: text })
    });
    const payload = await response.json();

    if (!response.ok) {
      const requestError = new Error(payload.reply || "Kunne ikke hente svar.");
      requestError.httpStatus = response.status;
      throw requestError;
    }

    typing.remove();
    addMessage(payload.reply || "Jeg fant dessverre ikke et svar akkurat nå.", "bot");

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

    console.error(error);
  } finally {
    sendButton.disabled = false;
  }
}

function renderConfig(payload) {
  config = payload;
  captureAnalytics("demo_opened", { business_name: config.name || client });
  document.title = `${config.name} | Nova Dynamics demo`;
  document.documentElement.style.setProperty("--accent", config.accent || "#4f7cff");
  document.documentElement.style.setProperty("--accent-secondary", config.accentSecondary || "#7c5cff");
  document.body.dataset.theme = config.theme || "nova";
  businessName.textContent = config.name;
  businessDescription.textContent = config.description;
  eyebrow.textContent = config.eyebrow || "NETTSIDEASSISTENT";
  contextTitle.textContent = config.contextTitle || "Still et vanlig kundespørsmål";
  contextDescription.textContent = config.contextDescription || "Prøv et forslag eller skriv spørsmålet slik en ekte kunde ville formulert det.";
  assistantLabel.textContent = config.assistantLabel || "Digital assistent";
  assistantAvatar.textContent = config.assistantInitial || "N";
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
    const response = await fetch(`/api/demo-config/${encodeURIComponent(client)}`);
    if (!response.ok) throw new Error("Demo not found.");
    renderConfig(await response.json());
  } catch (error) {
    businessName.textContent = "Demoen ble ikke funnet";
    businessDescription.textContent = "Kontroller lenken eller be Nova Dynamics om en ny demo-adresse.";
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
  if (!link) return;

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

initialize();
