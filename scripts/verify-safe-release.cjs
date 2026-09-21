'use strict';
// Public synthetic checks only. No contact-form POST, email, analytics SDK,
// credentials, customer data or feature-flag changes are involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const backend = 'https://nova-dynamics-bot-server.onrender.com';
const website = 'https://www.jemlio.com';
const clients = ['fram', 'fyllingsdalen', 'onsoy', 'tiller', 'trafikk1', 'frankolsen', 'roma'];
const results = [];
const request = (url, options = {}) => fetch(url, { ...options, signal: AbortSignal.timeout(20000) });
async function check(name, run) {
  try { await run(); results.push({ name, passed: true }); console.log(`PASS ${name}`); }
  catch { results.push({ name, passed: false }); console.log(`FAIL ${name}`); }
}
async function ask(base, client, message, conversationId) {
  const response = await request(`${base}/chat`, { method: 'POST',
    headers: { Origin: base, 'Content-Type': 'application/json' },
    body: JSON.stringify({ client, message, ...(conversationId ? { conversationId } : {}) }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.equal(typeof data.reply, 'string'); assert.ok(data.reply.length > 20);
  assert.notEqual(data.captureIntent, true);
  return data;
}
async function main() {
  if (process.argv[2] !== '--live') throw new Error('Explicit live opt-in required');
  for (const client of clients) {
    await check(`${client}: shared URL and capture-off configuration`, async () => {
      const page = await request(`${backend}/demos/${client}?owner=1`);
      assert.equal(page.status, 200); assert.match(page.headers.get('content-type') || '', /text\/html/);
      const response = await request(`${backend}/api/demo-config/${client}`);
      assert.equal(response.status, 200);
      const config = await response.json();
      assert.equal(config.client, client); assert.equal(config.features.capture.enabled, false);
      assert.equal(config.features.conversation, ['tiller', 'frankolsen'].includes(client));
    });
    await check(`${client}: synthetic answer`, () => ask(backend, client, 'Hva tilbyr dere?'));
  }
  for (const client of ['tiller', 'frankolsen']) {
    await check(`${client}: follow-up context`, async () => {
      const first = await ask(backend, client, client === 'tiller' ? 'Hva koster en kjøretime?' : 'Hva koster en synsundersøkelse?');
      assert.equal(typeof first.conversationId, 'string');
      const second = await ask(backend, client, 'Hva koster det?', first.conversationId);
      assert.equal(second.contextApplied, true); assert.equal(second.unsure, false);
    });
  }
  for (const [client, message] of [['jemlio', 'Hvordan får jeg en gratis demo?'],
    ['jemlio-driving-demo', 'Hva koster en kjøretime?'], ['jemlio-optician-demo', 'Hva koster en synstest?']]) {
    await check(`${client}: website chat proxy`, () => ask(website, client, message));
  }
  await check('Marketing collection remains explicitly disabled', async () => {
    const response = await request(`${backend}/api/marketing-enquiry/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: false, capability: 'webhook-forwarding', storageVerified: false });
  });
  await check('Unrelated chat origin remains refused', async () => {
    const response = await request(`${backend}/chat`, { method: 'POST',
      headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'jemlio', message: 'Hei' }) });
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
  const report = { checkedAt: new Date().toISOString(), verificationCommit: process.env.GITHUB_SHA || null,
    results, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length,
    limits: ['No marketing or capture submission was made.', 'Does not verify saved enquiries, Airtable action execution or email delivery.',
      'Does not prove the deployed backend commit; compare Render deployment metadata separately.', 'No visual/browser review.'] };
  fs.mkdirSync('release-verification', { recursive: true });
  fs.writeFileSync('release-verification/safe-live.json', JSON.stringify(report, null, 2));
  console.log(`RESULT ${report.passed} passed; ${report.failed} failed.`);
  if (report.failed) process.exitCode = 1;
}
main().catch(() => { console.error('Verification could not complete. No request bodies or identifiers logged.'); process.exitCode = 1; });
