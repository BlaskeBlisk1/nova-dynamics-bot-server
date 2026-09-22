"use strict";

// Feature activation is deliberately independent of clients.json: publishing
// this code must not turn a previously sent demo into a data-collection form.
const PREVIEW_SERVICES = {
  tiller: [
    { id: "b-auto", label: "Klasse B automat" },
    { id: "grunnkurs", label: "Trafikalt grunnkurs" },
    { id: "annet", label: "Et annet spørsmål" }
  ],
  fram: [
    { id: "bil", label: "Kjøreopplæring for bil" },
    { id: "grunnkurs", label: "Trafikalt grunnkurs" },
    { id: "annet", label: "Et annet spørsmål" }
  ],
  fyllingsdalen: [
    { id: "bil", label: "Kjøreopplæring for bil" },
    { id: "grunnkurs", label: "Trafikalt grunnkurs" },
    { id: "annet", label: "Et annet spørsmål" }
  ],
  onsoy: [
    { id: "bil", label: "Kjøreopplæring for bil" },
    { id: "grunnkurs", label: "Trafikalt grunnkurs" },
    { id: "annet", label: "Et annet spørsmål" }
  ],
  frankolsen: [
    { id: "synsundersokelse", label: "Synsundersøkelse" },
    { id: "kontaktlinser", label: "Kontaktlinser" },
    { id: "briller", label: "Briller eller reparasjon" },
    { id: "annet", label: "Et annet spørsmål" }
  ]
};

// Only the shared demo template exposes reset and reviewed-contact controls.
// A registry entry alone is not sufficient to promise a form on that page.
const UPGRADE_UI_CLIENTS = new Set([
  "fram", "fyllingsdalen", "onsoy", "tiller", "trafikk1", "frankolsen"
]);

function parseObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    // Bad feature configuration fails closed without affecting the FAQ demos.
    return {};
  }
}

function splitList(value) {
  return String(value || "").split(",").map(x => x.trim()).filter(Boolean);
}

function createUpgradeConfig({ env = process.env, getRegistry }) {
  const previewEnabled = env.NOVA_PREVIEW_ENABLED === "true";
  const captureEnabled = env.NOVA_CAPTURE_ENABLED === "true";
  const liveClients = parseObject(env.NOVA_CAPTURE_CONFIG);
  const conversationClients = new Set(splitList(env.NOVA_CONVERSATION_CLIENTS));
  const previewOrigins = splitList(env.NOVA_PREVIEW_ORIGINS || "http://localhost:8788,http://127.0.0.1:8788");

  function known(client) {
    return typeof client === "string" && /^[a-z0-9-]{1,64}$/.test(client) &&
      Object.hasOwn(getRegistry(), client);
  }

  function canPreview(client) {
    return previewEnabled && known(client) && Object.hasOwn(PREVIEW_SERVICES, client);
  }

  function captureTenant(client, { preview = false } = {}) {
    if (!known(client) || !UPGRADE_UI_CLIENTS.has(client)) return null;
    if (preview) {
      if (!canPreview(client)) return null;
      return {
        mode: "preview",
        name: getRegistry()[client].name,
        services: PREVIEW_SERVICES[client].map(service => ({ ...service })),
        allowedOrigins: [...previewOrigins]
      };
    }
    if (!captureEnabled || !Object.hasOwn(liveClients, client)) return null;
    const candidate = liveClients[client];
    if (!candidate || candidate.mode !== "live" || candidate.enabled !== true) return null;
    return { ...candidate, mode: "live", name: getRegistry()[client].name };
  }

  function conversationEnabled(client, { preview = false, origin = "" } = {}) {
    if (!known(client) || !UPGRADE_UI_CLIENTS.has(client)) return false;
    if (preview) return canPreview(client) && previewOrigins.includes(origin);
    return conversationClients.has(client);
  }

  function hasLiveCapture() {
    return captureEnabled && Object.keys(liveClients).some(client => captureTenant(client));
  }

  function hasLiveCrm() {
    return captureEnabled && Object.keys(liveClients).some(client => {
      const selected = captureTenant(client);
      return selected && Object.hasOwn(selected, 'crm');
    });
  }

  return { canPreview, captureTenant, conversationEnabled, hasLiveCapture, hasLiveCrm, previewOrigins };
}

module.exports = { createUpgradeConfig };
