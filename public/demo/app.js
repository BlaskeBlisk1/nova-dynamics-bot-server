const pathParts = window.location.pathname.split("/").filter(Boolean);
const client = pathParts[0] === "demos" ? pathParts[1] : "";

const businessName = document.getElementById("business-name");
const businessDescription = document.getElementById("business-description");
const suggestions = document.getElementById("suggestions");
const websiteLink = document.getElementById("website-link");
const messages = document.getElementById("messages");
const form = document.getElementById("chat-form");
const input = document.getElementById("message-input");
const sendButton = document.getElementById("send-button");

let config;

function addMessage(text, type) {
  const message = document.createElement("div");
  message.className = `message ${type}`;
  message.textContent = text;
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

async function ask(question) {
  const text = String(question || "").trim();
  if (!text || sendButton.disabled) return;

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
      throw new Error(payload.reply || "Kunne ikke hente svar.");
    }

    typing.remove();
    addMessage(payload.reply || "Jeg fant dessverre ikke et svar akkurat nå.", "bot");
  } catch (error) {
    typing.remove();
    addMessage("Beklager – forbindelsen til demoen sviktet. Prøv igjen om et øyeblikk.", "bot");
    console.error(error);
  } finally {
    sendButton.disabled = false;
  }
}

function renderConfig(payload) {
  config = payload;
  document.title = `${config.name} | Nova Dynamics demo`;
  document.documentElement.style.setProperty("--accent", config.accent || "#4f7cff");
  businessName.textContent = config.name;
  businessDescription.textContent = config.description;
  addMessage(config.greeting, "bot");

  for (const question of config.suggestedQuestions || []) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "suggestion";
    button.textContent = question;
    button.addEventListener("click", () => ask(question));
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
    console.error(error);
  }
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  ask(input.value);
});

initialize();
