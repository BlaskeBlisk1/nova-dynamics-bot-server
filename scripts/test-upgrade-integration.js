"use strict";

const assert = require("node:assert/strict");
const { fork } = require("node:child_process");
const { randomUUID } = require("node:crypto");

if (process.env.NOVA_TEST_CHILD === "true") {
  const { app, upgrades } = require("../index");
  const server = app.listen(0, "127.0.0.1", () => process.send({ port: server.address().port }));
  process.on("message", message => {
    if (message === "close") server.close(() => upgrades.close().then(() => process.exit(0)));
  });
} else {
  let checks = 0;
  const origin = "http://localhost:8788";
  async function withServer(extra, run) {
    const child = fork(__filename, [], { env: {
      ...process.env, NOVA_TEST_CHILD: "true", OPENAI_API_KEY: "",
      NOVA_PREVIEW_ENABLED: "false", NOVA_PREVIEW_ORIGINS: origin,
      NOVA_CAPTURE_ENABLED: "false", NOVA_CAPTURE_WORKER_ENABLED: "false",
      NOVA_CAPTURE_CONFIG: "", NOVA_DATABASE_URL: "", RESEND_API_KEY: "",
      NOVA_CAPTURE_SECRET: "", NOVA_CAPTURE_FROM: "", NOVA_CONVERSATION_CLIENTS: "", ...extra
    }, stdio: ["ignore", "pipe", "pipe", "ipc"] });
    const ready = new Promise((resolve, reject) => {
      child.once("message", resolve);
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`test server exited ${code}`)));
    });
    try {
      const { port } = await ready;
      const base = `http://127.0.0.1:${port}`;
      const request = async (path, body, selectedOrigin = origin, method = body ? "POST" : "GET") => {
        const response = await fetch(base + path, { method,
          headers: { Origin: selectedOrigin, ...(body ? { "Content-Type": "application/json" } : {}),
            ...(method === "OPTIONS" ? { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "content-type" } : {}) },
          ...(body ? { body: JSON.stringify(body) } : {}) });
        const data = (response.headers.get("content-type") || "").includes("application/json")
          ? await response.json() : await response.text();
        return { status: response.status, data, headers: response.headers };
      };
      await run(request);
    } finally {
      if (child.connected) child.send("close");
      const force = setTimeout(() => child.kill("SIGTERM"), 2000);
      await new Promise(resolve => child.exitCode !== null ? resolve() : child.once("exit", resolve));
      clearTimeout(force);
    }
  }
  function check(name, run) { run(); console.log(`ok ${++checks} - ${name}`); }
  (async () => {
    await withServer({}, async request => {
      for (const client of ["fram", "fyllingsdalen", "onsoy", "tiller", "trafikk1", "frankolsen", "roma"]) {
        const page = await request(`/demos/${client}`);
        const config = await request(`/api/demo-config/${client}`);
        check(`${client}: existing link preserved and new features off`, () => {
          assert.equal(page.status, 200);
          assert.equal(config.status, 200);
          assert.equal(config.data.features.conversation, false);
          assert.equal(config.data.features.capture.enabled, false);
          assert.doesNotMatch(JSON.stringify(config.data.features), /recipient|secret|database|apiKey/i);
        });
      }
      assert.equal((await request("/previews/tiller")).status, 404);
      assert.equal((await request("/api/demo-config/tiller?preview=1")).status, 404);
      assert.equal((await request("/api/capture/session", { client: "tiller", preview: true })).status, 503);
      const preflight = await request("/chat", undefined, origin, "OPTIONS");
      check("preview route and preview chat CORS unavailable by default", () => {
        assert.equal(preflight.headers.get("access-control-allow-origin"), null);
      });
      const legacy = await request("/chat", { client: "tiller", message: "Hva koster en kjøretime?" }, "https://nova-dynamics-bot-server.onrender.com");
      check("legacy chat retains its answer and does not allocate context", () => {
        assert.equal(legacy.status, 200);
        assert.match(legacy.data.reply, /800 kr/);
        assert.equal(legacy.data.conversationId, undefined);
      });
    });
    await withServer({ NOVA_PREVIEW_ENABLED: "true" }, async request => {
      const chatPreflight = await request("/chat", undefined, origin, "OPTIONS");
      const capturePreflight = await request("/api/capture/session", undefined, origin, "OPTIONS");
      const wrongPreflight = await request("/chat", undefined, "https://unapproved.example", "OPTIONS");
      check("preview JSON preflights reach the correct CORS policy", () => {
        assert.equal(chatPreflight.status, 204);
        assert.equal(chatPreflight.headers.get("access-control-allow-origin"), origin);
        assert.equal(capturePreflight.status, 204);
        assert.equal(capturePreflight.headers.get("access-control-allow-origin"), origin);
        assert.equal(wrongPreflight.headers.get("access-control-allow-origin"), null);
      });
      const preview = await request("/previews/tiller");
      const config = await request("/api/demo-config/tiller?preview=1");
      const legacyConfig = await request("/api/demo-config/tiller");
      check("preview features do not activate the ordinary demo", () => {
        assert.equal(preview.status, 200);
        assert.equal(config.data.features.conversation, true);
        assert.equal(config.data.features.capture.mode, "preview");
        assert.equal(legacyConfig.data.features.capture.enabled, false);
        assert.equal(legacyConfig.data.features.conversation, false);
      });
      assert.equal((await request("/previews/roma")).status, 404);
      assert.equal((await request("/api/demo-config/roma?preview=1")).status, 404);
      const first = await request("/chat", { client: "tiller", message: "Hva koster en kjøretime?", preview: true });
      const second = await request("/chat", { client: "tiller", message: "automat", preview: true, conversationId: first.data.conversationId });
      check("preview chat accepts only configured origin and resolves followups", () => {
        assert.equal(first.status, 200);
        assert.equal(first.headers.get("access-control-allow-origin"), origin);
        assert.equal(second.status, 200);
        assert.match(second.data.reply, /800 kr/);
        assert.equal(second.data.contextApplied, true);
        assert.equal(first.data.conversationId, second.data.conversationId);
      });
      const wrongOrigin = await request("/chat", { client: "tiller", message: "automat", preview: true }, "https://unapproved.example");
      assert.equal(wrongOrigin.status, 403);
      const contact = await request("/chat", { client: "tiller", message: "Kan dere ringe meg?", preview: true });
      const noContact = await request("/chat", { client: "tiller", message: "Ikke ring meg", preview: true });
      check("contact intent offers a truthful form and respects negation", () => {
        assert.equal(contact.data.captureIntent, true);
        assert.match(contact.data.reply, /ingen forespørsel sendes/i);
        assert.notEqual(noContact.data.captureIntent, true);
      });
      const session = await request("/api/capture/session", { client: "tiller", preview: true });
      assert.equal(session.status, 200);
      const payload = { client: "tiller", token: session.data.token, submissionId: randomUUID(),
        name: "Kari Eksempel", email: "kari@example.com", phone: "", service: "b-auto",
        preferredTime: "Etter klokken 16", consent: true, website: "" };
      const saved = await request("/api/capture/requests", payload);
      const retry = await request("/api/capture/requests", payload);
      check("reviewed enquiry retries return one truthful test receipt", () => {
        assert.equal(saved.status, 201);
        assert.equal(retry.status, 200);
        assert.equal(saved.data.receipt, retry.data.receipt);
        assert.equal(saved.data.status, "preview_saved");
        assert.match(saved.data.message, /Ingen e-post er sendt/);
        assert.doesNotMatch(JSON.stringify(saved.data), /kari@example\.com|Kari Eksempel/);
      });
      assert.equal((await request("/api/capture/requests", { ...payload, email: "changed@example.com" })).status, 409);
      assert.equal((await request("/api/capture/session", { client: "tiller" })).status, 503);
      assert.equal((await request("/api/capture/session", { client: "tiller", preview: true }, "https://unapproved.example")).status, 403);
    });
    await withServer({ NOVA_CAPTURE_ENABLED: "true", NOVA_CAPTURE_WORKER_ENABLED: "true",
      NOVA_CAPTURE_CONFIG: JSON.stringify({ tiller: { enabled: true, mode: "live", recipient: "office@example.com",
        privacyUrl: "https://example.com/privacy", allowedOrigins: [origin], services: [{ id: "bil", label: "Bil" }] } })
    }, async request => {
      const config = await request("/api/demo-config/tiller");
      const capture = await request("/api/capture/session", { client: "tiller" });
      check("live capture refuses activation without database and delivery configuration", () => {
        assert.equal(config.status, 200);
        assert.equal(config.data.features.capture.enabled, false);
        assert.equal(capture.status, 503);
      });
    });
    console.log(`Upgrade integration: ${checks} grouped checks passed.`);
  })().catch(error => { console.error(error); process.exitCode = 1; });
}
