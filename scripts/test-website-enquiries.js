'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { PgStore } = require('../lib/capture/store');
const { CaptureOperations } = require('../lib/capture/operations');
const { CrmOutbox, createAirtableWriter, flushCrm } = require('../lib/capture/crm');
const { flushNotifications } = require('../lib/capture/notification');
const { CONSENT_TEXT } = require('../lib/marketing-enquiries');
const { WEBSITE_CLIENT, WEBHOOK_PATH, readWebsiteConfig, verifyNetlifySignature,
  createWebsiteEnquiryRouter, normalizeSubmission, createWebsiteInput } = require('../lib/website-enquiries');
const { createWebsiteEnquiryRuntime } = require('../lib/website-enquiry-runtime');

const clock = Date.parse('2026-09-22T12:00:00Z');
const env = { JEMLIO_WEBSITE_ENQUIRY_ENABLED: 'true', JEMLIO_NETLIFY_FORM_ID: '123456789012345678901234',
  JEMLIO_NETLIFY_SITE_ID: 'a1a1a1a1-b2b2-43c3-84d4-e5e5e5e5e5e5', JEMLIO_NETLIFY_WEBHOOK_SECRET: 'synthetic-secret-not-a-production-credential',
  JEMLIO_WEBSITE_RECIPIENT: 'owner@example.invalid', NOVA_CAPTURE_FROM: 'sender@example.invalid',
  JEMLIO_WEBSITE_AIRTABLE_BASE_ID: 'app12345678901234', JEMLIO_WEBSITE_AIRTABLE_TABLE_ID: 'tbl12345678901234' };
const config = readWebsiteConfig(env);
const payload = () => ({ id: crypto.randomBytes(12).toString('hex'), form_id: config.formId, form_name: 'jemlio-demo-request',
  site_url: 'https://www.jemlio.com', created_at: new Date(clock).toISOString(),
  data: { name: 'Synthetic visitor', email: 'nobody@example.invalid', company: 'https://example.invalid',
    industry: 'Annen tjenestebedrift', message: 'Synthetic message, never sent', 'contact-request': CONSENT_TEXT,
    ip: '192.0.2.55', user_agent: 'PRIVATE-USER-AGENT', referrer: 'PRIVATE-REFERRER' } });
function sign(raw, { secret = config.secret, header = { alg: 'HS256', typ: 'JWT' }, claims = {} } = {}) {
  const content = [header, { iss: 'netlify', sha256: crypto.createHash('sha256').update(raw).digest('hex'), ...claims }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return content + '.' + crypto.createHmac('sha256', secret).update(content).digest('base64url');
}
const localFetch = global.fetch;
global.fetch = (url, options) => {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('External provider access is forbidden');
  return localFetch(url, options);
};

async function main() {
  const db = new PGlite();
  const query = (sql, params) => params === undefined ? db.exec(sql).then(results => results.at(-1)) : db.query(sql, params);
  let serial = Promise.resolve();
  const pool = { query, connect: async () => {
    let release; const previous = serial; serial = new Promise(resolve => { release = resolve; }); await previous;
    return { query, release };
  } };
  const store = new PgStore({ pool, claimClient: WEBSITE_CLIENT });
  const crmStore = new CrmOutbox({ pool, claimClient: WEBSITE_CLIENT });
  const ops = new CaptureOperations({ pool, now: () => clock });
  await store.initialize();
  let ready = true, checks = 0;
  const app = express();
  app.use(WEBHOOK_PATH, createWebsiteEnquiryRouter({ config, store, databaseReady: async () => ready, now: () => clock }));
  app.use(express.json());
  const server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  const base = `http://127.0.0.1:${server.address().port}${WEBHOOK_PATH}`;
  async function post(value, options = {}) {
    const raw = options.raw ?? JSON.stringify(value);
    const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json',
      'X-Webhook-Signature': options.signature ?? sign(raw), ...options.headers }, body: raw });
    return { status: response.status, headers: response.headers, body: await response.json() };
  }
  const count = async table => (await query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n;
  const test = async (name, run) => {
    await query('DELETE FROM nova_capture_requests'); await query('DELETE FROM nova_capture_submission_tombstones');
    ready = true; await run(); console.log(`ok ${++checks} - ${name}`);
  };
  try {
    await test('configuration stays off without explicit source, destination, secret and recipient', async () => {
      assert.equal(readWebsiteConfig({}).enabled, false);
      assert.equal(config.enabled, true); assert.equal(config.emailEnabled, false); assert.equal(config.crmEnabled, false);
      for (const key of Object.keys(env)) assert.equal(readWebsiteConfig({ ...env, [key]: '' }).enabled, false, key);
      for (const recipient of ['two@example.invalid,other@example.invalid', 'Name <owner@example.invalid>', 'owner@example.invalid\r\nBcc: x']) {
        assert.equal(readWebsiteConfig({ ...env, JEMLIO_WEBSITE_RECIPIENT: recipient }).enabled, false);
      }
      const disabled = createWebsiteEnquiryRuntime({ env: {} }); disabled.startWorker(); await disabled.close();
      for (const Constructor of [PgStore, CrmOutbox]) assert.throws(() => new Constructor({ pool, claimClient: '*' }), /invalid_claim_scope/);
    });
    await test('authentication binds the original bytes and permits only the documented signing algorithm', async () => {
      const raw = Buffer.from(JSON.stringify(payload(), null, 2));
      assert.equal(verifyNetlifySignature(sign(raw), raw, config.secret, clock), true);
      assert.equal(verifyNetlifySignature(sign(raw), Buffer.from(raw.toString().trim() + ' '), config.secret, clock), false);
      for (const settings of [{ secret: 'a-different-synthetic-secret-with-enough-length' }, { header: { alg: 'none' } },
        { header: { alg: 'HS384' } }, { header: { alg: 'HS256', jku: 'https://example.invalid/key' } },
        { header: { alg: 'HS256', crit: ['b64'], b64: false } }, { claims: { iss: 'another-source' } },
        { claims: { sha256: '0'.repeat(64) } }, { claims: { exp: clock / 1000 } },
        { claims: { exp: 'never' } }, { claims: { nbf: clock / 1000 + 60 } }]) {
        assert.equal(verifyNetlifySignature(sign(raw, settings), raw, config.secret, clock), false);
      }
      for (const token of ['', 'abc', 'a.b.c', sign(raw) + '=', sign(raw) + '.extra']) {
        assert.equal(verifyNetlifySignature(token, raw, config.secret, clock), false);
      }
      assert.equal((await post(payload(), { signature: '' })).status, 401);
      assert.equal(await count('nova_capture_requests'), 0);
    });
    await test('only the registered form and consented, bounded data can enter the durable queue', async () => {
      const valid = payload();
      for (const change of [{ form_id: 'f'.repeat(24) }, { form_name: 'different-form' }, { site_url: 'https://other.invalid' },
        { site_id: crypto.randomUUID() }, { id: '../another' }, { created_at: 'yesterday' }, { data: [] },
        { created_at: new Date(clock + 3600000).toISOString() }, { data: { ...valid.data, 'contact-request': false } },
        { data: { ...valid.data, email: 'bad\naddress@example.invalid' } }, { data: { ...valid.data, message: 'a'.repeat(1001) } }]) {
        assert.equal((await post({ ...valid, ...change })).status, 400);
      }
      assert.equal((await post({ ...valid, spam: true })).body.ignored, true);
      assert.equal((await post({ ...valid, data: { ...valid.data, 'bot-field': 'spam' } })).body.ignored, true);
      assert.equal(await count('nova_capture_requests'), 0);
      assert.equal((await post(valid, { raw: JSON.stringify({ ...valid, oversized: 'a'.repeat(33 * 1024) }) })).status, 413);
      assert.equal((await post(valid, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
    });
    await test('signed intake atomically freezes both deliveries and excludes provider metadata and destinations', async () => {
      const value = payload(); value.data.to = 'attacker@example.invalid'; value.data.Notes = 'Overwrite staff notes';
      const saved = await post(value, { raw: JSON.stringify(value, null, 2), headers: { Origin: 'https://www.jemlio.com' } });
      assert.equal(saved.status, 201); assert.equal(saved.body.persisted, true);
      assert.equal(saved.headers.get('access-control-allow-origin'), null);
      assert.equal(saved.headers.get('cache-control'), 'no-store');
      for (const table of ['nova_capture_requests', 'nova_capture_outbox', 'nova_capture_crm_outbox']) assert.equal(await count(table), 1);
      const request = (await query('SELECT * FROM nova_capture_requests')).rows[0];
      const email = (await query('SELECT notification FROM nova_capture_outbox')).rows[0].notification;
      const crm = (await query('SELECT payload FROM nova_capture_crm_outbox')).rows[0].payload;
      assert.equal(request.client, WEBSITE_CLIENT); assert.equal(request.data.sourceId, value.id);
      assert.doesNotMatch(JSON.stringify(request.data), /192\.0\.2|PRIVATE-|attacker|Overwrite/);
      assert.deepEqual(email.to, [env.JEMLIO_WEBSITE_RECIPIENT]); assert.equal(email.reply_to, value.data.email);
      assert.equal(crm.fields.Source, 'Jemlio website'); assert.equal(crm.fields['Visitor message'], value.data.message);
      assert.equal(crm.fields.Website, 'https://example.invalid/'); assert.equal(crm.fields.Notes, undefined); assert.equal(crm.fields.Status, undefined);
      assert.doesNotMatch(JSON.stringify(saved.body), /Synthetic|nobody@|owner@/);
      const unicode = payload(); unicode.data.company = 'https://example.invalid/' + 'ø'.repeat(200);
      assert.equal((await post(unicode)).status, 201, 'URL encoding must not reject a valid bounded website field');
    });
    await test('simultaneous retries and restart reuse one receipt while changed input cannot overwrite it', async () => {
      const value = payload(); const results = await Promise.all(Array.from({ length: 6 }, () => post(value)));
      assert.equal(results.filter(result => result.status === 201).length, 1);
      assert.equal(new Set(results.map(result => result.body.receipt)).size, 1);
      assert.equal((await post({ ...value, summary: 'Different provider rendering', data: { ...value.data, ip: '198.51.100.1' } })).status, 200);
      const reopened = new PgStore({ pool, claimClient: WEBSITE_CLIENT });
      const retry = await reopened.create(createWebsiteInput(normalizeSubmission(value, config, clock), { ...config, recipient: 'changed@example.invalid' }, { now: clock + 60000 }));
      assert.equal(retry.receipt, results[0].body.receipt); assert.equal(retry.duplicate, true);
      assert.equal((await post({ ...value, data: { ...value.data, message: 'A changed enquiry' } })).status, 409);
      for (const table of ['nova_capture_requests', 'nova_capture_outbox', 'nova_capture_crm_outbox']) assert.equal(await count(table), 1);
      assert.deepEqual((await query('SELECT notification FROM nova_capture_outbox')).rows[0].notification.to, [config.recipient]);
    });
    await test('database or CRM-queue failures acknowledge no storage and are safe to retry', async () => {
      const value = payload(); ready = false;
      const unavailable = await post(value); assert.equal(unavailable.status, 503); assert.equal(unavailable.headers.get('retry-after'), '30');
      assert.equal(await count('nova_capture_requests'), 0); ready = true;
      await query('ALTER TABLE nova_capture_crm_outbox ADD CONSTRAINT synthetic_failure CHECK (false) NOT VALID');
      try { assert.equal((await post(value)).status, 503); }
      finally { await query('ALTER TABLE nova_capture_crm_outbox DROP CONSTRAINT synthetic_failure'); }
      assert.equal(await count('nova_capture_requests'), 0); assert.equal(await count('nova_capture_outbox'), 0);
      assert.equal((await post(value)).status, 201);
    });
    await test('website and business workers cannot claim or suspend each other\'s pending items', async () => {
      const website = createWebsiteInput(normalizeSubmission(payload(), config, clock), config, { now: clock });
      const school = { ...createWebsiteInput(normalizeSubmission(payload(), config, clock), config, { now: clock }), client: 'synthetic-school' };
      await store.create(website); await store.create(school);
      const schoolMail = new PgStore({ pool, excludeClient: WEBSITE_CLIENT });
      const schoolCrm = new CrmOutbox({ pool, excludeClient: WEBSITE_CLIENT });
      assert.equal((await schoolMail.claimNext(clock)).client, school.client); assert.equal(await schoolMail.claimNext(clock), null);
      assert.equal((await schoolCrm.claimNext(clock)).client, school.client); assert.equal(await schoolCrm.claimNext(clock), null);
      assert.equal((await store.claimNext(clock)).client, WEBSITE_CLIENT); assert.equal(await store.claimNext(clock), null);
      assert.equal((await crmStore.claimNext(clock)).client, WEBSITE_CLIENT); assert.equal(await crmStore.claimNext(clock), null);
    });
    await test('email and CRM delivery stay independent and preserve staff-owned fields', async () => {
      const saved = await post(payload()); let sent = 0;
      const crmResult = await flushCrm({ store: crmStore, now: () => clock, isTenantEnabled: async () => true,
        writeCrm: createAirtableWriter({ apiKey: 'synthetic', fetchFn: async (_url, request) => {
          const body = JSON.parse(request.body); const fields = body.records[0].fields;
          assert.deepEqual(body.performUpsert.fieldsToMergeOn, ['Receipt']); assert.equal(fields.Notes, undefined); assert.equal(fields.Status, undefined);
          return new Response(JSON.stringify({ records: [{ id: 'rec12345678901234', fields: { ...fields, Notes: 'Staff note', Status: 'Won' } }] }));
        } }) });
      assert.equal(crmResult[0].status, 'synced');
      const mailResult = await flushNotifications({ store, now: () => clock, isTenantEnabled: async () => true, sendNotification: async request => {
        sent++; assert.equal(request.idempotencyKey, `nova-capture/${saved.body.receipt}`);
        throw Object.assign(new Error('PRIVATE-ERROR'), { retryable: true, code: 'network_uncertain' });
      } });
      assert.equal(mailResult[0].status, 'pending'); assert.equal(sent, 1);
      const report = await ops.report({ client: WEBSITE_CLIENT });
      assert.equal(report.crm.synced, 1); assert.equal(report.notifications.pending, 1);
      assert.doesNotMatch(JSON.stringify(report), /Synthetic|nobody@|PRIVATE/);
    });
    await test('an authenticated webhook replay after deletion never recreates contact data or deliveries', async () => {
      const value = payload(); const saved = await post(value);
      await query("UPDATE nova_capture_outbox SET status='accepted',provider_id='synthetic-only'");
      await query("UPDATE nova_capture_crm_outbox SET status='synced',record_id='rec12345678901234'");
      assert.equal((await ops.deleteRequests({ client: WEBSITE_CLIENT, receipt: saved.body.receipt, apply: true })).deletedRequests, 1);
      const replay = await post(value); assert.equal(replay.status, 200); assert.equal(replay.body.removed, true);
      for (const table of ['nova_capture_requests', 'nova_capture_outbox', 'nova_capture_crm_outbox']) assert.equal(await count(table), 0);
    });
    console.log(`Website enquiry checks passed: ${checks}. All contacts and providers were synthetic.`);
  } finally { await new Promise(resolve => server.close(resolve)); await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
