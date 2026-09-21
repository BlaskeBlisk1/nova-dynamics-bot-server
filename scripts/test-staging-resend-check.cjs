'use strict';
const assert = require('node:assert/strict');
const { runResendCheck, configuration } = require('./staging-resend-check.cjs');
const at = Date.parse('2026-09-21T22:00:00Z');
const marker = '11111111-1111-4111-8111-111111111111';
const domainId = '22222222-2222-4222-8222-222222222222';
const emailId = '33333333-3333-4333-8333-333333333333';
const env = { JEMLIO_RESEND_CHECK: 'true', JEMLIO_STAGING_ONLY: 'true',
  RENDER_SERVICE_ID: 'srv-daopc4tg1s2s7383pokg', NOVA_CAPTURE_ENABLED: 'false', NOVA_CAPTURE_WORKER_ENABLED: 'false',
  JEMLIO_SETUP_SCHEMA: 'false', JEMLIO_SITE_TASK: 'off', JEMLIO_RESEND_CHECK_COMMIT: 'a'.repeat(40),
  RENDER_GIT_COMMIT: 'a'.repeat(40), JEMLIO_RESEND_CHECK_UNTIL: new Date(at + 600000).toISOString(),
  JEMLIO_RESEND_CHECK_ID: marker, RESEND_API_KEY: 're_synthetic_not_a_real_key' };
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });
let checks = 0;
async function test(name, fn) { await fn(); console.log(`ok ${++checks} - ${name}`); }
async function run(fetchImpl, options = {}) { return runResendCheck({ env, now: () => at, pause: async () => {}, fetchImpl, ...options }); }
(async () => {
  await test('default off and exact service/revision/time/flags guard all requests', async () => {
    assert.equal(configuration({}, at), null);
    assert.deepEqual(await run(() => { throw new Error('should not run'); }, { env: {} }), { state: 'disabled' });
    for (const [key, value] of [['RENDER_SERVICE_ID', 'production'], ['NOVA_CAPTURE_ENABLED', 'true'],
      ['NOVA_CAPTURE_WORKER_ENABLED', 'true'], ['JEMLIO_SITE_TASK', 'publish-marketing'], ['JEMLIO_SETUP_SCHEMA', 'true'],
      ['RENDER_GIT_COMMIT', 'b'.repeat(40)], ['JEMLIO_RESEND_CHECK_UNTIL', new Date(at - 1).toISOString()],
      ['JEMLIO_RESEND_CHECK_UNTIL', new Date(at + 31 * 60000).toISOString()], ['JEMLIO_RESEND_CHECK_ID', 'invalid']]) {
      assert.throws(() => configuration({ ...env, [key]: value }, at));
    }
  });
  await test('restricted key still gets exactly one idempotent owner test and no private errors escape', async () => {
    const calls = [];
    const report = await run(async (url, init) => {
      calls.push({ url, init }); assert.equal(init.redirect, 'error');
      assert.equal(new URL(url).origin, 'https://api.resend.com');
      if (url.includes('/domains')) return json({ message: env.RESEND_API_KEY }, 403);
      if (init.method === 'POST') return json({ id: emailId });
      return json({ id: emailId, last_event: 'delivered' });
    });
    const sends = calls.filter(c => c.init.method === 'POST'); assert.equal(sends.length, 1);
    const body = JSON.parse(sends[0].init.body); assert.deepEqual(body.to, ['hei@jemlio.com']);
    assert.equal(body.from, 'onboarding@resend.dev'); assert.equal(body.cc, undefined); assert.equal(body.bcc, undefined);
    assert.equal(sends[0].init.headers['Idempotency-Key'], 'jemlio-owner-verification/' + marker);
    assert.equal(report.state, 'provider_accepted'); assert.equal(report.deliveryVerified, true);
    assert.doesNotMatch(JSON.stringify(report), /re_synthetic/);
  });
  await test('only verified owned domains can become senders and unrelated domain metadata stays out of reports', async () => {
    const report = await run(async (url, init) => {
      if (url.includes('?')) return json({ data: [{ id: domainId, name: 'jemlio.com', status: 'verified' },
        { id: domainId, name: 'private-other.example', status: 'verified' }], has_more: false });
      if (url.includes('/domains/')) return json({ name: 'jemlio.com', records: [] });
      if (init.method === 'POST') { assert.equal(JSON.parse(init.body).from, 'hei@jemlio.com'); return json({ id: emailId }); }
      return json({ id: emailId, last_event: 'sent' });
    });
    assert.equal(report.deliveryVerified, false); assert.equal(report.lastEvent, 'sent');
    assert.deepEqual(report.domains, [{ name: 'jemlio.com', status: 'verified', records: [] }]);
    assert.doesNotMatch(JSON.stringify(report), /private-other/);
  });
  await test('test-sender restriction is not described as an invalid API key or delivered mail', async () => {
    const report = await run(async (url) => url.includes('/domains') ? json({ data: [], has_more: false }) :
      json({ message: 'You can only send testing emails to your own email address (private@example.invalid).' }, 403));
    assert.equal(report.state, 'test_sender_recipient_restriction'); assert.equal(report.deliveryVerified, false);
    assert.doesNotMatch(JSON.stringify(report), /private@example/);
  });
  await test('invalid key is correctly distinguished from a sender/domain failure', async () => {
    const report = await run(async () => json({ message: 'API key is invalid' }, 401));
    assert.equal(report.state, 'invalid_or_revoked_key'); assert.equal(report.sendStatus, 401);
  });
  await test('ambiguous send failures are never automatically retried or reported as delivered', async () => {
    let sends = 0;
    const report = await run(async (url, init) => {
      if (init.method === 'POST') { sends++; throw new Error(env.RESEND_API_KEY); }
      return json({ data: [], has_more: false });
    });
    assert.equal(sends, 1); assert.equal(report.state, 'send_outcome_unknown');
    assert.equal(report.deliveryVerified, false); assert.doesNotMatch(JSON.stringify(report), /re_synthetic/);
  });
  console.log(`Resend verification safety: ${checks} checks passed; all HTTP mocked, no mail sent.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
