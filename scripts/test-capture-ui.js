"use strict";

// DOM integration checks execute the shipped browser script and HTML. All
// fetches are intercepted: no analytics, mail or customer system is contacted.
// These checks are intentionally not a claim of browser/visual verification.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "../public/demo/index.html"), "utf8");
const script = fs.readFileSync(path.join(__dirname, "../public/demo/app.js"), "utf8");
const romaHtml = fs.readFileSync(path.join(__dirname, "../public/roma/index.html"), "utf8");
const romaScript = fs.readFileSync(path.join(__dirname, "../public/roma/ui.js"), "utf8");
const baseConfig = {
  name: "Eksempel trafikkskole", description: "Eksempel", greeting: "Hva lurer du på?",
  suggestedQuestions: [], website: "https://school.example", theme: "nova",
  features: { conversation: true, capture: { enabled: true, mode: "preview", name: "Eksempel trafikkskole",
    services: [{ id: "b-auto", label: "Klasse B automat" }, { id: "grunnkurs", label: "Trafikalt grunnkurs" }, { id: "annet", label: "Et annet spørsmål" }] } }
};
const response = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const settle = () => new Promise(resolve => setImmediate(resolve));
async function until(test, label) {
  for (let attempt = 0; attempt < 30; attempt++) {
    if (test()) return;
    await settle();
  }
  assert.ok(test(), label);
}

async function harness({ url = "https://nova.example/previews/tiller", config = baseConfig, onCapture, onChat, roma = false } = {}) {
  const calls = [], errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", error => errors.push(error));
  const dom = new JSDOM(roma ? romaHtml : html, { url, runScripts: "outside-only", pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const document = window.document;
  window.matchMedia = () => ({ matches: false });
  window.confirm = () => true;
  window.fetch = async (url, options = {}) => {
    const payload = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url: String(url), method: options.method || "GET", payload });
    if (String(url).startsWith("/api/demo-config/")) return response(structuredClone(config));
    if (url === "/chat") {
      if (onChat) return onChat(payload);
      return response({ reply: "Her er informasjonen.", unsure: false, conversationId: `conversation-${calls.filter(call => call.url === "/chat").length}` });
    }
    if (url === "/api/capture/session") return response({ token: "test-signed-session", mode: config.features.capture.mode });
    if (url === "/api/capture/requests") {
      if (onCapture) return onCapture(payload);
      return response({ receipt: "test-receipt", status: config.features.capture.mode === "preview" ? "preview_saved" : "received", mode: config.features.capture.mode, message: "Forespørselen er registrert. Dette er ikke en bestilling." }, 201);
    }
    if (String(url).startsWith("https://eu.i.posthog.com/")) return response({});
    throw new Error(`Unexpected network request: ${url}`);
  };
  // Both shipped scripts share the same classic-script lexical scope in RoMa.
  window.eval(script + (roma ? `\n${romaScript}` : ""));
  await until(() => document.querySelector("#business-name").textContent === config.name, "configuration should render");
  const get = selector => document.querySelector(selector);
  const clickText = text => {
    const button = [...document.querySelectorAll("button")].find(button => button.textContent.trim() === text);
    assert.ok(button, `button exists: ${text}`);
    button.click();
  };
  const set = (name, value) => {
    const field = get(`#capture-${name}`);
    assert.ok(field, `contact field exists: ${name}`);
    if (field.type === "checkbox") field.checked = value;
    else field.value = value;
    field.dispatchEvent(new window.Event("input", { bubbles: true }));
    field.dispatchEvent(new window.Event("change", { bubbles: true }));
  };
  const ask = async question => {
    get("#message-input").value = question;
    get("#chat-form").requestSubmit();
    await until(() => !get("#send-button").disabled, "chat should finish");
  };
  const open = () => get("#capture-open").click();
  const review = () => {
    set("name", "Kari Eksempel");
    set("email", "kari.private@example.com");
    set("service", "b-auto");
    set("time", "Etter kl. 16");
    set("consent", true);
    get(".capture-form").requestSubmit();
    assert.ok(get(".capture-review"), "valid form reaches review");
  };
  const finish = () => {
    assert.deepEqual(errors, [], "browser script should not produce uncaught DOM errors");
    dom.window.close();
  };
  return { window, document, calls, get, clickText, set, ask, open, review, finish };
}

let checks = 0;
async function test(name, run) {
  await run();
  checks++;
  console.log(`ok ${checks} - ${name}`);
}

(async () => {
  await test("the actual RoMa page initializes, answers and resets without upgrade controls", async () => {
    const config = structuredClone(baseConfig);
    config.name = "RoMa Trafikkskole";
    config.theme = "roma";
    config.features = { conversation: false, capture: { enabled: false, mode: "off", services: [] } };
    const h = await harness({ url: "https://nova.example/demos/roma?test=1", config, roma: true });
    assert.equal(h.get("#capture-open"), null);
    assert.equal(h.get("#conversation-reset"), null);
    assert.equal(h.get("#preview-notice"), null);
    assert.equal(h.get("#business-name").textContent, "RoMa Trafikkskole");
    assert.equal(h.document.body.dataset.theme, "roma");
    assert.equal(h.get("#reset-chat").hidden, false);
    await h.ask("Hva koster A2 til A?");
    assert.equal(h.calls.filter(call => call.url === "/chat").length, 1);
    assert.match(h.get("#messages").textContent, /Her er informasjonen/);
    h.get("#reset-chat").click();
    assert.equal(h.document.querySelectorAll(".message").length, 1);
    assert.equal(h.get("#messages").textContent.includes(config.greeting), true);
    assert.equal(h.get("#message-input").value, "");
    assert.equal(h.document.activeElement, h.get("#message-input"));
    await h.ask("Hvor holder dere til?");
    assert.equal(h.calls.filter(call => call.url === "/chat").length, 2);
    assert.equal(h.calls.filter(call => call.url.startsWith("/api/capture/")).length, 0);
    h.finish();
  });

  await test("RoMa's existing reset also clears conversation context if it is explicitly enabled", async () => {
    const config = structuredClone(baseConfig);
    config.name = "RoMa Trafikkskole";
    config.theme = "roma";
    const h = await harness({ url: "https://nova.example/demos/roma?test=1", config, roma: true });
    await h.ask("Hva koster kjøretime?");
    await h.ask("A2");
    assert.equal(h.calls.filter(call => call.url === "/chat")[1].payload.conversationId, "conversation-1");
    h.get("#reset-chat").click();
    await h.ask("Hva koster grunnkurs?");
    assert.equal(h.calls.filter(call => call.url === "/chat")[2].payload.conversationId, undefined);
    assert.equal(h.get(".capture-offer"), null, "missing capture controls must fail closed");
    h.finish();
  });

  await test("legacy demos retain question answering with upgrade controls disabled", async () => {
    const config = structuredClone(baseConfig);
    config.features = { conversation: false, capture: { enabled: false, mode: "off", services: [] } };
    const h = await harness({ url: "https://nova.example/demos/tiller", config });
    assert.equal(h.get("#capture-open").hidden, true);
    assert.equal(h.get("#conversation-reset").hidden, true);
    assert.equal(h.get("#chat-tools").hidden, true);
    await h.ask("Hva koster en kjøretime?");
    assert.deepEqual(h.calls.find(call => call.url === "/chat").payload, { client: "tiller", message: "Hva koster en kjøretime?" });
    assert.equal(h.get(".capture-offer"), null);
    assert.equal(h.calls.filter(call => call.url.startsWith("/api/capture/")).length, 0);
    h.finish();
  });

  await test("capture is optional and a declined offer does not nag on later answers", async () => {
    const h = await harness();
    await h.ask("Jeg vil ta automat");
    assert.equal(h.document.querySelectorAll(".capture-offer").length, 1);
    h.clickText("Ikke nå");
    await h.ask("Hvor holder dere til?");
    assert.equal(h.get(".capture-offer"), null);
    assert.equal(h.calls.filter(call => call.url === "/chat").length, 2);
    assert.equal(h.calls.filter(call => call.url.startsWith("/api/capture/")).length, 0);
    h.open();
    h.set("name", "Kari Eksempel");
    h.clickText("Fortsett å chatte");
    assert.equal(h.get(".capture-panel").hidden, true);
    await h.ask("Hva er åpningstidene?");
    h.open();
    assert.equal(h.get("#capture-name").value, "Kari Eksempel");
    h.finish();
  });

  await test("conversation context passes between requests and reset starts fresh", async () => {
    const h = await harness();
    await h.ask("Hva koster kjøretime?");
    await h.ask("A2");
    const chats = h.calls.filter(call => call.url === "/chat");
    assert.equal(chats[0].payload.preview, true);
    assert.equal(chats[0].payload.conversationId, undefined);
    assert.equal(chats[1].payload.conversationId, "conversation-1");
    h.get("#conversation-reset").click();
    assert.equal(h.document.querySelectorAll(".message").length, 1);
    await h.ask("Hva koster grunnkurs?");
    assert.equal(h.calls.filter(call => call.url === "/chat")[2].payload.conversationId, undefined);
    h.finish();
  });

  await test("an explicit callback request reopens the form after declining without duplicating a saved request", async () => {
    const h = await harness({ onChat: payload => response({
      reply: payload.message.includes("ringe") ? "Du kan bruke skjemaet nedenfor." : "Her er informasjonen.",
      captureIntent: payload.message.includes("ringe"),
      conversationId: "callback-conversation"
    }) });
    await h.ask("Hva koster automatgir?");
    h.clickText("Ikke nå");
    assert.equal(h.get(".capture-offer"), null);
    await h.ask("Kan dere ringe meg?");
    assert.ok(h.get(".capture-form"), "explicit callback request must reveal the form despite prior opt-out");
    assert.equal(h.get(".capture-panel").hidden, false);
    assert.equal(h.get(".capture-offer"), null);
    h.set("name", "Kari Eksempel");
    h.clickText("Fortsett å chatte");
    await h.ask("Jeg vil at dere skal ringe meg");
    assert.equal(h.document.querySelectorAll(".capture-panel").length, 1);
    assert.equal(h.get("#capture-name").value, "Kari Eksempel", "reopening must preserve existing fields");
    h.review();
    h.clickText("Lagre testforespørsel");
    await until(() => h.get(".capture-panel").textContent.includes("test-receipt"), "callback request should save");
    await h.ask("Kan dere ringe meg?");
    assert.equal(h.get(".capture-form"), null, "a saved receipt must not become another form");
    assert.equal(h.document.querySelectorAll(".capture-panel").length, 1);
    assert.equal(h.calls.filter(call => call.url === "/api/capture/requests").length, 1);
    assert.match(h.get(".capture-panel").textContent, /test-receipt/);
    h.finish();
  });

  await test("preview review and consent precede saving and success uses server receipt", async () => {
    const h = await harness();
    assert.equal(h.get("#preview-notice").hidden, false);
    assert.ok(h.calls[0].url.endsWith("?preview=1"));
    await h.ask("Hva koster automatgir?");
    h.clickText("Ja, bli kontaktet");
    assert.equal(h.get("#capture-service").value, "b-auto");
    h.get(".capture-form").requestSubmit();
    assert.equal(h.get(".capture-review"), null, "empty form cannot reach review");
    h.review();
    assert.match(h.get(".capture-summary").textContent, /Kari Eksempel.*kari.private@example.com.*Klasse B automat.*Etter kl. 16/);
    assert.equal(h.calls.filter(call => call.url === "/api/capture/requests").length, 0, "review itself must not submit");
    h.clickText("Lagre testforespørsel");
    await until(() => h.get(".capture-panel").textContent.includes("test-receipt"), "receipt should appear");
    const call = h.calls.find(call => call.url === "/api/capture/requests");
    assert.equal(call.payload.consent, true);
    assert.equal(call.payload.email, "kari.private@example.com");
    assert.equal(call.payload.website, "");
    assert.equal(call.payload.service, "b-auto");
    assert.match(call.payload.submissionId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    assert.equal(call.payload.message, undefined, "raw chat is absent from capture request");
    assert.equal(h.calls.find(call => call.url === "/api/capture/session").payload.preview, true);
    assert.equal(h.get("#capture-open").hidden, true);
    assert.equal(h.get(".capture-form"), null);
    assert.equal(h.calls.filter(call => call.url.includes("posthog")).length, 0);
    h.finish();
  });

  await test("phone-only contact validates, while missing contact and malformed phone are blocked", async () => {
    const h = await harness();
    h.open();
    h.set("name", "Kari Eksempel");
    h.set("service", "annet");
    h.set("consent", true);
    h.get(".capture-form").requestSubmit();
    assert.equal(h.get(".capture-review"), null);
    h.set("phone", "123");
    h.get(".capture-form").requestSubmit();
    assert.equal(h.get(".capture-review"), null);
    h.set("phone", "+47 1234 5678");
    h.get(".capture-form").requestSubmit();
    assert.ok(h.get(".capture-review"));
    h.clickText("Lagre testforespørsel");
    await until(() => h.get(".capture-panel").textContent.includes("test-receipt"), "phone-only receipt should appear");
    assert.equal(h.calls.find(call => call.url === "/api/capture/requests").payload.email, "");
    h.finish();
  });

  await test("a lost save response preserves the submission ID and locks edits until retry confirms", async () => {
    const saved = new Map();
    let count = 0;
    const h = await harness({ onCapture: async payload => {
      count++;
      if (!saved.has(payload.submissionId)) saved.set(payload.submissionId, { receipt: "stable-receipt", status: "preview_saved", mode: "preview", message: "Testforespørselen er lagret. Ingenting er sendt." });
      if (count === 1) throw new TypeError("Connection lost after saving");
      return response(saved.get(payload.submissionId));
    } });
    h.open(); h.review(); h.clickText("Lagre testforespørsel");
    await until(() => h.get(".capture-status-error"), "uncertain save should be visible");
    assert.match(h.get(".capture-status-error").textContent, /kan være registrert/);
    const edit = [...h.document.querySelectorAll("button")].find(button => button.textContent === "Endre opplysninger");
    assert.equal(edit.disabled, true);
    assert.equal(h.get("#conversation-reset").disabled, true);
    await h.ask("Kan jeg fortsette å chatte?");
    assert.equal(h.get("#conversation-reset").disabled, true, "chat response must not clear uncertainty lock");
    h.clickText("Prøv igjen");
    await until(() => h.get(".capture-panel").textContent.includes("stable-receipt"), "retry should resolve original receipt");
    const posts = h.calls.filter(call => call.url === "/api/capture/requests");
    assert.equal(posts.length, 2);
    assert.deepEqual(posts[0].payload, posts[1].payload);
    assert.equal(saved.size, 1);
    assert.equal(h.get("#conversation-reset").disabled, false);
    h.finish();
  });

  await test("double click cannot submit twice while a request is pending", async () => {
    let resolveCapture;
    const h = await harness({ onCapture: () => new Promise(resolve => { resolveCapture = resolve; }) });
    h.open(); h.review(); h.clickText("Lagre testforespørsel");
    await until(() => resolveCapture, "save should be pending");
    h.clickText("Lagre testforespørsel");
    assert.equal(h.calls.filter(call => call.url === "/api/capture/requests").length, 1);
    resolveCapture(response({ receipt: "once", status: "preview_saved", mode: "preview", message: "Lagret som test." }));
    await until(() => h.get(".capture-panel").textContent.includes("Referanse: once"), "pending save should finish");
    h.finish();
  });

  await test("live form links privacy information and PII never enters analytics or storage", async () => {
    const config = structuredClone(baseConfig);
    config.features.capture.mode = "live";
    config.features.capture.privacyUrl = "https://school.example/privacy";
    const h = await harness({ config, url: "https://nova.example/demos/tiller" });
    await h.ask("Hva koster automat?");
    h.open(); h.review();
    assert.equal(h.get("#capture-consent-copy a").href, "https://school.example/privacy");
    h.clickText("Send forespørsel");
    await until(() => h.get(".capture-panel").textContent.includes("test-receipt"), "live receipt should appear");
    assert.match(h.get(".capture-panel").textContent, /ikke en bestilling/);
    const analytics = h.calls.filter(call => call.url.includes("posthog"));
    assert.ok(analytics.length > 0, "production usage still records non-contact analytics");
    const stored = JSON.stringify({ analytics, local: { ...h.window.localStorage }, session: { ...h.window.sessionStorage } });
    assert.doesNotMatch(stored, /Kari|kari.private|Etter kl\. 16|Hva koster automat/);
    const ids = new Set(analytics.map(call => call.payload.distinct_id));
    assert.equal(ids.size, 1);
    assert.equal(h.window.sessionStorage.getItem("nova-demo-analytics-session"), [...ids][0]);
    assert.equal(h.window.localStorage.length, 0);
    h.finish();
  });

  await test("test, owner, localhost and preview routes suppress all analytics", async () => {
    for (const url of ["https://nova.example/demos/tiller?test=1", "https://nova.example/demos/tiller?owner=1", "http://localhost:8788/demos/tiller", "https://nova.example/previews/tiller"]) {
      const h = await harness({ url });
      await h.ask("Hva koster kurset?");
      h.get("#website-link").dispatchEvent(new h.window.MouseEvent("click", { bubbles: true }));
      assert.equal(h.calls.filter(call => call.url.includes("posthog")).length, 0, url);
      h.finish();
    }
  });

  await test("service suggestions use explicit services and never infer from health symptoms", async () => {
    const config = structuredClone(baseConfig);
    config.features.capture.services = [
      { id: "synsundersokelse", label: "Synsundersøkelse" }, { id: "kontaktlinser", label: "Kontaktlinser" },
      { id: "briller", label: "Briller" }, { id: "annet", label: "Annet" }
    ];
    const h = await harness({ config });
    await h.ask("Jeg har vondt i øyet og ser uklart");
    h.open();
    assert.equal(h.get("#capture-service").value, "", "health symptom must not imply a service choice");
    h.get("#conversation-reset").click();
    await h.ask("Hva koster en synsundersøkelse?");
    h.open();
    assert.equal(h.get("#capture-service").value, "synsundersokelse");
    h.get("#conversation-reset").click();
    await h.ask("Kan dere hjelpe med briller og kontaktlinser?");
    h.open();
    assert.equal(h.get("#capture-service").value, "", "multiple services must not silently choose one");
    h.finish();
  });

  await test("live capture fails closed if its privacy URL is missing", async () => {
    const config = structuredClone(baseConfig);
    config.features.capture.mode = "live";
    const h = await harness({ config, url: "https://nova.example/demos/tiller" });
    assert.equal(h.get("#capture-open").hidden, true);
    await h.ask("Kan jeg bli kontaktet?");
    assert.equal(h.get(".capture-offer"), null);
    h.finish();
  });

  console.log(`${checks} DOM integration scenarios passed (network mocked; no visual verification).`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
