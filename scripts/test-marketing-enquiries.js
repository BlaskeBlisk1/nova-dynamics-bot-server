"use strict";

const assert = require("node:assert/strict");
const express = require("express");
const { createMarketingEnquiryRouter, validateWebhookUrl } = require("../lib/marketing-enquiries");

async function withServer(options, run) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/marketing-enquiry", createMarketingEnquiryRouter(options));
  const server = app.listen(0, "127.0.0.1");
  await new Promise(resolve => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await run(base); }
  finally { await new Promise(resolve => server.close(resolve)); }
}

const origin = "https://www.jemlio.com";
const target = "https://hooks.airtable.com/workflows/v1/genericWebhook/appExample0000000/wflExample0000000/wtrExample";
const good = {
  name: " Kari Nordmann ",
  email: " KARI@EXAMPLE.NO ",
  company: "example.no",
  industry: "Trafikkskole",
  message: " Vanlige spørsmål om priser. ",
  "contact-request": "Jeg ber Jemlio kontakte meg om min gratis mini-demo"
};

async function post(base, body, headers = {}) {
  return fetch(`${base}/api/marketing-enquiry`, {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json", Accept: "application/json", ...headers },
    body: JSON.stringify(body)
  });
}

(async () => {
  assert.equal(validateWebhookUrl(target), target);
  assert.equal(validateWebhookUrl("http://hooks.airtable.com/workflows/v1/genericWebhook/x"), null);
  assert.equal(validateWebhookUrl("https://evil.example/workflows/v1/genericWebhook/x"), null);
  assert.equal(validateWebhookUrl("https://hooks.airtable.com/other/path"), null);

  let forwarded = [];
  await withServer({
    webhookUrl: target,
    now: () => Date.parse("2026-09-21T18:20:00Z"),
    randomUUID: () => "11111111-1111-4111-8111-111111111111",
    fetchImpl: async (url, init) => {
      forwarded.push({ url, init });
      return { ok: true };
    }
  }, async base => {
    let response = await post(base, good);
    assert.equal(response.status, 201);
    assert.deepEqual(await response.json(), { accepted: true, receipt: "11111111-1111-4111-8111-111111111111" });
    assert.equal(forwarded.length, 1);
    const payload = JSON.parse(forwarded[0].init.body);
    assert.equal(payload.source, "Jemlio website");
    assert.equal(payload.name, "Kari Nordmann");
    assert.equal(payload.email, "kari@example.no");
    assert.equal(payload.business, "example.no");
    assert.equal(payload.website, "");
    assert.equal(payload.consent, true);
    assert.equal(payload.notes, "Vanlige spørsmål om priser.");
    assert.equal(Object.hasOwn(payload, "transcript"), false);

    response = await post(base, { ...good, email: "bad" });
    assert.equal(response.status, 400);

    response = await post(base, { ...good, "contact-request": "" });
    assert.equal(response.status, 400);

    response = await fetch(`${base}/api/marketing-enquiry`, {
      method: "POST",
      headers: { Origin: "https://attacker.example", "Content-Type": "application/json" },
      body: JSON.stringify(good)
    });
    assert.equal(response.status, 403);

    const beforeSpam = forwarded.length;
    response = await post(base, { ...good, "bot-field": "spam" });
    assert.equal(response.status, 202);
    assert.equal(forwarded.length, beforeSpam);
  });

  await withServer({ webhookUrl: "", fetchImpl: async () => ({ ok: true }) }, async base => {
    const response = await post(base, good);
    assert.equal(response.status, 503);
  });

  await withServer({ webhookUrl: target, fetchImpl: async () => ({ ok: false }) }, async base => {
    const response = await post(base, good);
    assert.equal(response.status, 503);
  });

  await withServer({ webhookUrl: target, fetchImpl: async () => ({ ok: true }) }, async base => {
    for (let i = 0; i < 6; i++) assert.equal((await post(base, good)).status, 201);
    const limited = await post(base, good);
    assert.equal(limited.status, 429);
    assert.equal(limited.headers.get("retry-after"), "600");
  });

  await withServer({ webhookUrl: target, fetchImpl: async () => ({ ok: true }) }, async base => {
    const params = new URLSearchParams({
      name: "Ola",
      email: "ola@example.no",
      company: "https://bedrift.example",
      industry: "Optiker",
      message: "",
      "contact-request": "on"
    });
    const response = await fetch(`${base}/api/marketing-enquiry`, {
      method: "POST",
      redirect: "manual",
      headers: { Origin: origin, "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString()
    });
    assert.equal(response.status, 303);
    assert.equal(response.headers.get("location"), "https://www.jemlio.com/demo-requested");
  });

  console.log("Marketing enquiry gateway checks passed.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
