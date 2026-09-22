'use strict';
// Public synthetic checks only. No contact-form POST, email, analytics SDK,
// credentials, customer data or feature-flag changes are involved.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
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
  const expectedRevision = process.env.JEMLIO_EXPECTED_COMMIT;
  if (expectedRevision && !/^[a-f0-9]{40}$/.test(expectedRevision)) throw new Error('Invalid expected revision');
  let deployedRevision = null;
  await check('The intended backend release is live', async () => {
    for (let attempt = 0; attempt < (expectedRevision ? 30 : 1); attempt++) {
      try {
        const response = await request(`${backend}/api/release`);
        assert.equal(response.status, 200);
        const release = await response.json();
        assert.equal(release.service, 'jemlio');
        assert.match(release.revision, /^[a-f0-9]{40}$/);
        if (expectedRevision) assert.equal(release.revision, expectedRevision);
        deployedRevision = release.revision; return;
      } catch (error) {
        if (!expectedRevision || attempt === 29) throw error;
      }
      await delay(10000);
    }
  });
  // Fail before running chat checks against an old or unidentified deployment.
  if (!deployedRevision) { writeReport(null); return; }
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
      assert.ok(Array.isArray(second.followUps) && second.followUps.length > 0);
      const choice = second.followUps.find(choice => choice.id === 'booking');
      assert.ok(choice);
      const next = await ask(backend, client, choice.message);
      assert.equal(next.unsure, false);
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
  await check('The signed website enquiry receiver remains enabled', async () => {
    const response = await request(`${backend}/api/website-enquiries/netlify/status`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { enabled: true, capability: 'signed-netlify-intake' });
  });
  await check('The public website retains its native form and privacy page', async () => {
    const page = await request(website);
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(html, /name="jemlio-demo-request"/);
    assert.match(html, /data-netlify="true"/);
    assert.match(html, /action="https:\/\/www\.jemlio\.com\/demo-requested"/);
    const privacy = await request(`${website}/privacy`);
    assert.equal(privacy.status, 200);
    assert.match(await privacy.text(), /hei@jemlio\.com/);
  });
  await check('Unrelated chat origin remains refused', async () => {
    const response = await request(`${backend}/chat`, { method: 'POST',
      headers: { Origin: 'https://unrelated.example', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client: 'jemlio', message: 'Hei' }) });
    assert.equal(response.status, 403); assert.equal(response.headers.get('access-control-allow-origin'), null);
  });
  writeReport(deployedRevision);
}
function writeReport(deployedRevision) {
  const report = { checkedAt: new Date().toISOString(), verificationCommit: process.env.GITHUB_SHA || null, deployedRevision,
    results, passed: results.filter(x => x.passed).length, failed: results.filter(x => !x.passed).length,
    limits: ['No marketing or capture submission was made.', 'Does not verify saved enquiries, Airtable action execution or email delivery.',
      'Configuration checks do not prove worker execution or provider delivery.', 'No visual/browser review.'] };
  fs.mkdirSync('release-verification', { recursive: true });
  fs.writeFileSync('release-verification/safe-live.json', JSON.stringify(report, null, 2));
  console.log(`RESULT ${report.passed} passed; ${report.failed} failed.`);
  if (report.failed) process.exitCode = 1;
}
main().catch(() => { console.error('Verification could not complete. No request bodies or identifiers logged.'); process.exitCode = 1; });
