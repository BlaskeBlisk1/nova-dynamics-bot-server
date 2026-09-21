'use strict';

// Explicit opt-in public checks. Never submit contact details, dispatch mail,
// activate capture, or load analytics. Run separately from the offline suite.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
const backend = 'https://nova-dynamics-bot-server.onrender.com';
const marketing = 'https://www.jemlio.com';
const clients = ['fram', 'fyllingsdalen', 'onsoy', 'tiller', 'trafikk1', 'frankolsen', 'roma'];
const results = [];

async function check(name, run) {
  try {
    await run();
    results.push({ name, status: 'passed' });
    console.log(`PASS ${name}`);
  } catch (error) {
    // Do not print bodies, conversation IDs, request headers or arbitrary errors.
    results.push({ name, status: 'failed', category: error.code === 'ERR_ASSERTION' ? 'assertion' : 'network_or_runtime' });
    console.log(`FAIL ${name}`);
  }
}
async function request(url, options = {}) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(20000),
    headers: { 'User-Agent': 'Jemlio-Release-Verification/1.0', ...options.headers } });
}
async function ask(base, client, message, conversationId) {
  const response = await request(`${base}/chat`, {
    method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, message, ...(conversationId ? { conversationId } : {}) })
  });
  assert.equal(response.status, 200);
  const answer = await response.json();
  assert.equal(typeof answer.reply, 'string');
  assert.ok(answer.reply.length > 20);
  assert.notEqual(answer.captureIntent, true);
  return answer;
}

async function main() {
  if (process.argv[2] !== '--live') throw new Error('Explicit --live is required');
  for (const client of clients) {
    await check(`${client}: unchanged demo URL and safe feature configuration`, async () => {
      const page = await request(`${backend}/demos/${client}?owner=1`);
      assert.equal(page.status, 200);
      assert.match(page.headers.get('content-type') || '', /text\/html/);
      const response = await request(`${backend}/api/demo-config/${client}`);
      assert.equal(response.status, 200);
      const config = await response.json();
      assert.equal(config.client, client);
      assert.equal(config.features.capture.enabled, false);
      assert.equal(config.features.conversation, ['tiller', 'frankolsen'].includes(client));
      assert.doesNotMatch(JSON.stringify(config.features), /recipient|secret|database|apiKey/i);
    });
    await check(`${client}: live answer`, () => ask(backend, client, 'Hva tilbyr dere?'));
  }
  for (const client of ['tiller', 'frankolsen']) {
    await check(`${client}: bounded conversational follow-up`, async () => {
      const first = await ask(backend, client, client === 'tiller' ? 'Hva koster en kjøretime?' : 'Hva koster en synsundersøkelse?');
      assert.equal(typeof first.conversationId, 'string');
      const next = await ask(backend, client, 'Hva koster det?', first.conversationId);
      assert.equal(next.contextApplied, true);
      assert.equal(next.unsure, false);
    });
  }
  await check('Public synthetic capture preview remains off', async () => {
    assert.equal((await request(`${backend}/previews/tiller`, { redirect: 'manual' })).status, 404);
  });
  await check('Unrelated origin is refused', async () => {
    const response = await request(`${backend}/chat`, { method: 'POST',
      headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'jemlio', message: 'Hei' }) });
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
  for (const [client, message] of [
    ['jemlio', 'Hvordan får jeg en gratis demo?'],
    ['jemlio-driving-demo', 'Hva koster en kjøretime?'],
    ['jemlio-optician-demo', 'Hva koster en synstest?']
  ]) await check(`${client}: canonical website chat proxy`, () => ask(marketing, client, message));
  for (const route of ['/', '/privacy', '/demo-requested', '/site.js', '/styles.css', '/assets/jemlio-orbit.webp']) {
    await check(`Marketing asset ${route}`, async () => {
      assert.equal((await request(marketing + route)).status, 200);
    });
  }
  for (const host of ['https://jemlio.com', 'https://nova-dynamics.no', 'https://www.nova-dynamics.no']) {
    await check(`Legacy/canonical redirect: ${new URL(host).hostname}`, async () => {
      const response = await request(`${host}/`);
      assert.equal(response.status, 200);
      assert.equal(new URL(response.url).origin, marketing);
    });
  }
  await check('Marketing form has passed Netlify HTML processing', async () => {
    const response = await request(marketing);
    assert.equal(response.status, 200);
    const dom = new JSDOM(await response.text());
    try {
      const form = dom.window.document.querySelector('form[name="jemlio-demo-request"]');
      assert.ok(form);
      assert.equal(form.getAttribute('method').toUpperCase(), 'POST');
      assert.equal(form.hasAttribute('data-netlify'), false, 'Unprocessed form is not proof of collection');
      assert.equal(form.hasAttribute('netlify'), false);
      assert.equal(form.querySelector('input[name="form-name"]').value, 'jemlio-demo-request');
      for (const field of ['name', 'email', 'company', 'industry', 'bot-field']) assert.ok(form.elements.namedItem(field));
    } finally { dom.window.close(); }
  });
  const report = {
    checkedAt: new Date().toISOString(), sourceCommit: process.env.GITHUB_SHA || null,
    results, passed: results.filter(r => r.status === 'passed').length,
    failed: results.filter(r => r.status === 'failed').length,
    notVerified: ['Netlify submission storage', 'Email notification delivery', 'Production capture database', 'Pilot recipient approval', 'Visual/mobile browser review'],
    effects: 'Public pages/configurations and synthetic chat requests only. No contact submissions, emails, analytics execution or production mutations.'
  };
  fs.mkdirSync('release-verification', { recursive: true });
  fs.writeFileSync('release-verification/live.json', JSON.stringify(report, null, 2));
  console.log(`RESULT ${report.passed} passed; ${report.failed} failed. Form processing is not proof of saved enquiries or email delivery.`);
  if (report.failed) process.exitCode = 1;
}
main().catch(() => { console.error('Live release verification could not complete'); process.exitCode = 1; });
