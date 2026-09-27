'use strict';
// No external provider calls. Optional real concurrency uses only the same
// explicitly named disposable localhost database as the capture CI suite.
const assert = require('node:assert/strict');
const { randomBytes, createHash, createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { createEnquiryIntakeRuntime, readIntakeConfig, normalizeSubmission } = require('../lib/enquiry-intake/runtime');
const { IntakeStore, submissionIdFor } = require('../lib/enquiry-intake/store');
const { WorkspaceStore } = require('../lib/workspace/store');
const { CaptureOperations } = require('../lib/capture/operations');
const clock = Date.UTC(2026, 8, 27, 12), now = () => clock;
const sourceId = 'synthetic_netlify_alpha_123456', secondSourceId = 'synthetic_netlify_beta_1234567';
const secret = 'synthetic-intake-secret-not-a-production-credential';
const source = { enabled: true, client: 'intake-ci-alpha', formName: 'contact', formId: '123456789012345678901234',
  siteId: 'a1a1a1a1-b2b2-43c3-84d4-e5e5e5e5e5e5', siteUrl: 'https://synthetic.example.invalid', signingKeyEnv: 'JEMLIO_ENQUIRY_INTAKE_KEY_ALPHA' };
const tenants = { 'intake-ci-alpha': { enabled: true, name: 'Synthetic Alpha', keyHash: 'a'.repeat(64) },
  'intake-ci-beta': { enabled: true, name: 'Synthetic Beta', keyHash: 'b'.repeat(64) } };
const env = { JEMLIO_ENQUIRY_INTAKE_ENABLED: 'true', JEMLIO_WORKSPACE_ENABLED: 'true',
  JEMLIO_WORKSPACE_ORIGIN: 'https://workspace.example.invalid',
  JEMLIO_WORKSPACE_CONFIG: JSON.stringify(tenants), JEMLIO_ENQUIRY_INTAKE_KEY_ALPHA: secret,
  JEMLIO_ENQUIRY_INTAKE_SOURCES: JSON.stringify({ [sourceId]: source }) };
const config = readIntakeConfig(env), configuredSource = config.sources[sourceId];
const payload = () => ({ id: randomBytes(12).toString('hex'), form_id: source.formId, form_name: source.formName,
  site_url: source.siteUrl, site_id: source.siteId, created_at: new Date(clock).toISOString(),
  data: { name: 'Synthetic visitor', email: 'visitor@example.invalid', phone: '', service: 'Synthetic quote',
    message: 'Synthetic information, never sent', 'bot-field': '', ip: '192.0.2.10', user_agent: 'PRIVATE-USER-AGENT',
    client: 'intake-ci-beta', consent: true } });
function sign(raw, { key = secret, header = { alg: 'HS256', typ: 'JWT' }, claims = {} } = {}) {
  const content = [header, { iss: 'netlify', sha256: createHash('sha256').update(raw).digest('hex'), ...claims }]
    .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
  return content + '.' + createHmac('sha256', key).update(content).digest('base64url');
}
const localFetch = global.fetch;
global.fetch = (url, options) => {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('External HTTP forbidden in enquiry intake tests');
  return localFetch(url, options);
};
async function database() {
  if (process.argv.includes('--postgres')) {
    const raw = process.env.JEMLIO_TEST_DATABASE_URL;
    if (!raw || process.env.JEMLIO_THROWAWAY_DATABASE !== 'true') throw new Error('Explicit disposable database configuration required');
    const url = new URL(raw);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['localhost', '127.0.0.1'].includes(url.hostname) ||
        url.pathname !== '/jemlio_capture_ci' || url.search) throw new Error('Only the named localhost CI database is permitted');
    const pool = new (require('pg').Pool)({ connectionString: raw, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000 });
    return { pool, close: () => pool.end(), real: true };
  }
  const db = new PGlite();
  let tail = Promise.resolve();
  async function acquire() { let release; const prior = tail; tail = new Promise(resolve => { release = resolve; }); await prior; return release; }
  const query = (sql, args) => args === undefined ? db.exec(sql).then(results => results.at(-1)) : db.query(sql, args);
  const pool = { async query(sql, args) { const release = await acquire(); try { return await query(sql, args); } finally { release(); } },
    async connect() { const release = await acquire(); return { query, release }; } };
  return { pool, close: () => db.close(), real: false };
}
async function main() {
  const db = await database(), { pool } = db;
  const runtime = createEnquiryIntakeRuntime({ env, pool, now }), store = new IntakeStore({ pool, now });
  let server, checks = 0;
  const check = async (name, run) => { await run(); console.log(`ok ${++checks} - ${name}`); };
  const count = async table => (await pool.query('SELECT count(*)::int AS n FROM ' + table)).rows[0].n;
  let routeRuntime = runtime;
  async function post(value, options = {}) {
    const raw = options.raw ?? JSON.stringify(value);
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/enquiry-intake/netlify/${options.source || sourceId}${options.query || ''}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Webhook-Signature': options.signature ?? sign(raw), ...options.headers }, body: raw });
    return { status: response.status, headers: response.headers, data: await response.json() };
  }
  try {
    await check('configuration fails closed unless both features, approved tenant, binding and dedicated signing key are configured', async () => {
      assert.equal(config.enabled, true);
      assert.equal(readIntakeConfig(env, null).enabled, false);
      assert.equal(readIntakeConfig(env, { origin: 'http://workspace.example.invalid', tenants }).enabled, false);
      for (const changes of [{ JEMLIO_ENQUIRY_INTAKE_ENABLED: '' }, { JEMLIO_WORKSPACE_ENABLED: '' }, { JEMLIO_WORKSPACE_CONFIG: '{}' },
        { JEMLIO_WORKSPACE_ORIGIN: 'http://workspace.example.invalid' },
        { JEMLIO_ENQUIRY_INTAKE_KEY_ALPHA: 'short' }, { JEMLIO_ENQUIRY_INTAKE_SOURCES: '[]' }, { JEMLIO_ENQUIRY_INTAKE_SOURCES: '{}' }]) assert.equal(readIntakeConfig({ ...env, ...changes }).enabled, false);
      for (const changes of [{ client: 'unknown' }, { formId: ['1'.repeat(24)] }, { siteId: [source.siteId] }, { siteUrl: 'http://synthetic.example.invalid' },
        { siteUrl: source.siteUrl + '/contact' }, { signingKeyEnv: 'RESEND_API_KEY' }, { fields: { email: 'name' } }, { honeypotField: 'email' }, { fields: { unexpected: 'any' } }]) {
        assert.equal(readIntakeConfig({ ...env, JEMLIO_ENQUIRY_INTAKE_SOURCES: JSON.stringify({ [sourceId]: { ...source, ...changes } }) }).enabled, false);
      }
      assert.equal(readIntakeConfig({ ...env, JEMLIO_WORKSPACE_CONFIG: JSON.stringify({ 'intake-ci-alpha': { ...tenants['intake-ci-alpha'], enabled: false } }) }).enabled, false);
      assert.equal(readIntakeConfig({ ...env, JEMLIO_WORKSPACE_CONFIG: JSON.stringify({ 'intake-ci-alpha': { ...tenants['intake-ci-alpha'], name: '' } }) }).enabled, false);
      assert.equal(readIntakeConfig({ ...env, JEMLIO_ENQUIRY_INTAKE_SOURCES: JSON.stringify({ [sourceId]: source, [secondSourceId]: { ...source, client: 'intake-ci-beta', siteId: source.siteId.toUpperCase() } }) }).enabled, false);
      const disabled = createEnquiryIntakeRuntime({ env: {}, pool });
      assert.equal(disabled.enabled, false); assert.equal(disabled.store, null); assert.equal(await disabled.ready(), false); await disabled.close();
    });
    const app = express();
    app.use('/api/enquiry-intake', (req, res, next) => routeRuntime.router(req, res, next));
    app.use(express.json());
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    await check('schemas are explicit, missing schema refuses intake, and migrations are idempotent', async () => {
      if (!db.real) { assert.equal(await store.ready(), false); assert.equal((await post(payload())).status, 503); }
      for (const file of ['capture', 'booking', 'workspace', 'enquiry-intake', 'enquiry-intake']) await pool.query(readFileSync(join(__dirname, `../lib/${file}/schema.sql`), 'utf8'));
      assert.equal(await runtime.ready(), true);
    });
    // Delete only synthetic namespaces from this named disposable database.
    await pool.query("DELETE FROM nova_capture_requests WHERE client IN ('intake-ci-alpha','intake-ci-beta')");
    await pool.query("DELETE FROM nova_capture_submission_tombstones WHERE client IN ('intake-ci-alpha','intake-ci-beta')");
    await pool.query("DELETE FROM jemlio_enquiry_intake_sources WHERE client IN ('intake-ci-alpha','intake-ci-beta')");
    await check('original bytes and source signature are required; foreign forms/sites and malformed payloads are rejected', async () => {
      const value = payload(), raw = JSON.stringify(value);
      for (const options of [{ signature: '' }, { signature: sign(raw, { key: 'different-secret-with-more-than-thirty-two-characters' }) },
        { signature: sign(raw, { header: { alg: 'none' } }) }, { signature: sign(raw, { claims: { exp: clock / 1000 } }) }, { raw: raw + ' ', signature: sign(raw) }]) assert.equal((await post(value, options)).status, 401);
      assert.equal((await post(value, { source: secondSourceId })).status, 404);
      assert.equal((await post(value, { query: '?client=intake-ci-beta' })).status, 400);
      assert.equal((await post(value, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
      assert.equal((await post(value, { raw: '{bad json}' })).status, 400);
      assert.equal((await post(value, { raw: 'x'.repeat(32769) })).status, 413);
      for (const changes of [{ form_id: 'f'.repeat(24) }, { form_name: 'other' }, { site_url: 'https://other.invalid' },
        { site_id: '00000000-0000-4000-8000-000000000001' }, { id: [value.id] }, { created_at: '2026-02-30T12:00:00Z' },
        { created_at: new Date(clock + 300001).toISOString() }, { data: [] }]) assert.equal((await post({ ...value, ...changes })).status, 400);
      assert.equal((await pool.query("SELECT count(*)::int AS n FROM nova_capture_requests WHERE client LIKE 'intake-ci-%'")).rows[0].n, 0);
    });
    let first, firstPayload;
    await check('valid form intake freezes tenant/provenance, creates due task/audit and claims neither consent nor outgoing delivery', async () => {
      firstPayload = payload(); firstPayload.client = 'intake-ci-beta'; firstPayload.data.to = 'attacker@example.invalid';
      first = await post(firstPayload); assert.equal(first.status, 201); assert.equal(first.data.persisted, true); assert.equal(first.data.sendsMessages, false);
      assert.equal(first.data.reviewNeeded, false); assert.equal(first.headers.get('cache-control'), 'no-store');
      const row = (await pool.query('SELECT * FROM nova_capture_requests WHERE id=$1', [first.data.receipt])).rows[0];
      assert.equal(row.client, 'intake-ci-alpha'); assert.equal(row.data.entryMode, 'external_form_v1'); assert.equal(row.data.source, 'external_form');
      assert.equal(row.data.consent, undefined); assert.equal(row.data.to, undefined); assert.equal(row.data.intake.providerId, firstPayload.id);
      assert.equal(row.submission_id, submissionIdFor(configuredSource, firstPayload.id));
      for (const marker of ['PRIVATE-USER-AGENT', '192.0.2.10', 'attacker@example.invalid', 'intake-ci-beta']) assert.equal(JSON.stringify(row.data).includes(marker), false);
      const followup = (await pool.query('SELECT * FROM jemlio_followups WHERE request_id=$1', [row.id])).rows[0];
      assert.equal(followup.action, 'callback'); assert.equal(new Date(followup.due_at).getTime(), clock + 86400000);
      const audit = (await pool.query('SELECT * FROM jemlio_workspace_audit WHERE request_id=$1', [row.id])).rows;
      assert.equal(audit.length, 1); assert.equal(JSON.stringify(audit).includes('visitor@example.invalid'), false);
      for (const table of ['nova_capture_outbox', 'nova_capture_crm_outbox', 'jemlio_bookings', 'jemlio_recorded_sales']) assert.equal((await pool.query('SELECT 1 FROM ' + table + ' WHERE request_id=$1', [row.id])).rows.length, 0);
    });
    await check('retry is idempotent and changed payload conflicts without overwriting the original', async () => {
      const replay = await post(firstPayload); assert.equal(replay.status, 200); assert.equal(replay.data.duplicate, true); assert.equal(replay.data.receipt, first.data.receipt);
      assert.equal((await post({ ...firstPayload, data: { ...firstPayload.data, message: 'Changed content' } })).status, 409);
      assert.equal((await pool.query('SELECT data FROM nova_capture_requests WHERE id=$1', [first.data.receipt])).rows[0].data.message, firstPayload.data.message);
      assert.equal((await pool.query('SELECT * FROM jemlio_workspace_audit WHERE request_id=$1', [first.data.receipt])).rows.length, 1);
    });
    await check('provider spam and honeypot bots are ignored without saving, while missing contact and unbounded/ambiguous fields fail', async () => {
      const before = await count('nova_capture_requests'), value = payload();
      for (const changes of [{ spam: true }, { is_spam: true }, { state: 'spam' }, { data: { ...value.data, 'bot-field': 'bot' } }]) {
        const response = await post({ ...value, ...changes }); assert.equal(response.status, 200); assert.equal(response.data.ignored, true); assert.equal(response.data.accepted, false);
      }
      for (const changes of [{ email: '', phone: '' }, { email: 'no-contact', phone: '---' }, { email: ['one@example.invalid', 'two@example.invalid'] },
        { name: 'x'.repeat(101) }, { service: 'x'.repeat(161) }, { message: 'x'.repeat(2001) }, { name: 'bad\nname' },
        { email: 'valid@example.invalid\r\nBcc: other@example.invalid' }, { message: 'bad\u0000message' }]) assert.equal((await post({ ...value, data: { ...value.data, ...changes } })).status, 400);
      assert.equal(await count('nova_capture_requests'), before);
    });
    await check('incomplete but contactable enquiries are marked for review; malformed email never becomes an email recipient', async () => {
      const value = payload(); value.data = { name: '', service: '', email: 'invalid', phone: '+47 400 00 001', message: 'Review needed' };
      const result = await post(value); assert.equal(result.status, 201); assert.equal(result.data.reviewNeeded, true);
      const row = (await pool.query('SELECT data FROM nova_capture_requests WHERE id=$1', [result.data.receipt])).rows[0];
      assert.equal(row.data.email, ''); assert.equal(row.data.consent, undefined);
      assert.deepEqual(row.data.intake.reviewReasons, ['invalid_email', 'missing_name', 'missing_service']);
      assert.equal((await pool.query('SELECT action FROM jemlio_followups WHERE request_id=$1', [result.data.receipt])).rows[0].action, 'review');
    });
    await check('explicit field mapping uses only approved fields and accepts a normal trailing slash on the site origin', async () => {
      const mapped = readIntakeConfig({ ...env, JEMLIO_ENQUIRY_INTAKE_SOURCES: JSON.stringify({ [sourceId]: { ...source, fields: { name: 'full-name', email: 'contact-email', service: 'request-type' } } }) }).sources[sourceId];
      const value = payload(); value.site_url += '/'; value.data = { 'full-name': 'Synthetic mapped', 'contact-email': 'Mapped@Example.Invalid', 'request-type': 'Quote', client: 'intake-ci-beta' };
      const normalized = normalizeSubmission(value, mapped, clock); assert.equal(normalized.email, 'mapped@example.invalid'); assert.equal(normalized.name, 'Synthetic mapped');
      assert.deepEqual(normalized.reviewReasons, []); assert.equal(normalized.client, undefined);
    });
    await check('workspace and reports expose the external source and bounded review reasons only inside the owning tenant', async () => {
      const workspace = new WorkspaceStore({ pool, now }), ops = new CaptureOperations({ pool, now });
      const rows = (await workspace.list('intake-ci-alpha', { view: 'all' })).items;
      const original = rows.find(row => row.id === first.data.receipt);
      assert.equal(original.source, 'external_form'); assert.equal(original.intakeReviewNeeded, false); assert.deepEqual(original.intakeReviewReasons, []);
      const review = rows.find(row => row.intakeReviewNeeded);
      assert.equal(review.source, 'external_form'); assert.equal(review.followup.action, 'review'); assert.equal(review.email, '');
      assert.deepEqual(review.intakeReviewReasons, ['invalid_email', 'missing_name', 'missing_service']);
      assert.equal((await workspace.list('intake-ci-beta', { view: 'all' })).items.length, 0);
      const results = await workspace.results({ client: 'intake-ci-alpha' });
      assert.equal(results.sources.length, 1); assert.equal(results.sources[0].source, 'external_form'); assert.equal(results.sources[0].enquiries, 2);
      assert.equal((await ops.report({ client: 'intake-ci-alpha' })).notifications.not_requested, 2);
      assert.equal(JSON.stringify(results).includes('visitor@example.invalid'), false);
    });
    await check('source and provider form bindings cannot be reassigned or copied to another tenant', async () => {
      const clean = normalizeSubmission(payload(), configuredSource, clock);
      await assert.rejects(store.create({ ...configuredSource, client: 'intake-ci-beta' }, clean), /source_binding_conflict/);
      await assert.rejects(store.create({ ...configuredSource, id: secondSourceId, client: 'intake-ci-beta' }, clean), /source_binding_conflict/);
      await assert.rejects(store.create({ ...configuredSource, formId: 'f'.repeat(24) }, clean), /source_binding_conflict/);
      assert.equal((await pool.query("SELECT 1 FROM nova_capture_requests WHERE client='intake-ci-beta'")).rows.length, 0);
    });
    await check('parallel identical submissions create one receipt; parallel conflicts preserve exactly one winner', async () => {
      const value = normalizeSubmission(payload(), configuredSource, clock);
      const copies = await Promise.all(Array.from({ length: 8 }, () => store.create(configuredSource, value)));
      assert.equal(new Set(copies.map(row => row.receipt)).size, 1); assert.equal(copies.filter(row => !row.duplicate).length, 1);
      const conflict = normalizeSubmission(payload(), configuredSource, clock);
      const outcomes = await Promise.allSettled([store.create(configuredSource, conflict), store.create(configuredSource, { ...conflict, message: 'Conflicting message' })]);
      assert.equal(outcomes.filter(result => result.status === 'fulfilled').length, 1); assert.equal(outcomes.find(result => result.status === 'rejected').reason.code, 'submission_conflict');
    });
    await check('failure to persist the follow-up rolls back the enquiry and audit atomically', async () => {
      const value = normalizeSubmission(payload(), configuredSource, clock);
      await pool.query('ALTER TABLE jemlio_followups ADD CONSTRAINT intake_synthetic_failure CHECK(false) NOT VALID');
      try { await assert.rejects(store.create(configuredSource, value)); }
      finally { await pool.query('ALTER TABLE jemlio_followups DROP CONSTRAINT intake_synthetic_failure'); }
      assert.equal((await pool.query('SELECT 1 FROM nova_capture_requests WHERE client=$1 AND submission_id=$2', [configuredSource.client, submissionIdFor(configuredSource, value.providerId)])).rows.length, 0);
    });
    await check('deletion cascades contact details and a delayed signed replay cannot recreate them', async () => {
      const ops = new CaptureOperations({ pool, now });
      const preview = await ops.deleteRequests({ client: configuredSource.client, receipt: first.data.receipt });
      assert.equal(preview.eligibleRequests, 1); assert.equal(preview.deletedRequests, 0);
      const deletion = await ops.deleteRequests({ client: configuredSource.client, receipt: first.data.receipt, apply: true });
      assert.equal(deletion.deletedRequests, 1);
      const replay = await post(firstPayload); assert.equal(replay.status, 200); assert.deepEqual(replay.data, { accepted: false, removed: true, sendsMessages: false });
      for (const table of ['nova_capture_requests', 'jemlio_followups', 'jemlio_workspace_audit']) assert.equal((await pool.query('SELECT 1 FROM ' + table + ' WHERE ' + (table === 'nova_capture_requests' ? 'id' : 'request_id') + '=$1', [first.data.receipt])).rows.length, 0);
      assert.equal((await pool.query('SELECT 1 FROM nova_capture_requests WHERE client=$1 AND submission_id=$2', [configuredSource.client, submissionIdFor(configuredSource, firstPayload.id)])).rows.length, 0);
    });
    if (db.real) await check('signed replay blocked behind an in-flight operator deletion observes the committed tombstone', async () => {
      const value = payload(), created = await post(value), submissionId = submissionIdFor(configuredSource, value.id);
      assert.equal(created.status, 201);
      function gate() { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; }
      function bounded(promise, label) {
        let timer;
        return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Timed out: ' + label)), 5000); })])
          .finally(() => clearTimeout(timer));
      }
      const deletionPrepared = gate(), allowCommit = gate(), insertIssued = gate();
      // Pause the actual operator deletion only after its parent lock,
      // tombstone and cascading DELETE have completed within one transaction.
      const deletingPool = { query: (sql, args) => pool.query(sql, args), async connect() {
        const connection = await pool.connect();
        return { release: () => connection.release(), async query(sql, args) {
          if (sql === 'COMMIT') { deletionPrepared.resolve(); await allowCommit.promise; }
          return connection.query(sql, args);
        } };
      } };
      const replayPool = { query: (sql, args) => pool.query(sql, args), async connect() {
        const connection = await pool.connect();
        const pid = (await connection.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
        return { release: () => connection.release(), query(sql, args) {
          const result = connection.query(sql, args);
          if (sql.startsWith('INSERT INTO nova_capture_requests(') && args?.[2] === submissionId) insertIssued.resolve(pid);
          return result;
        } };
      } };
      const ops = new CaptureOperations({ pool: deletingPool, now });
      const deletion = ops.deleteRequests({ client: configuredSource.client, receipt: created.data.receipt, apply: true });
      deletion.catch(() => {});
      let replay;
      try {
        await bounded(deletionPrepared.promise, 'operator deletion prepared');
        routeRuntime = createEnquiryIntakeRuntime({ env, pool: replayPool, now });
        replay = post(value); replay.catch(() => {});
        const pid = await bounded(insertIssued.promise, 'signed replay insert issued');
        // Observe the database lock, not a presumed delay: the unique INSERT
        // must actually be waiting behind the uncommitted deletion before it
        // is allowed to finish. Poll briefly only while that condition is false.
        const deadline = Date.now() + 5000;
        let blocked = false;
        while (Date.now() < deadline) {
          blocked = (await pool.query('SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked', [pid])).rows[0].blocked;
          if (blocked) break;
          await delay(10);
        }
        assert.equal(blocked, true, 'signed replay INSERT must wait on the deleting transaction');
        allowCommit.resolve();
        assert.equal((await deletion).deletedRequests, 1);
        const result = await replay;
        assert.equal(result.status, 200); assert.deepEqual(result.data, { accepted: false, removed: true, sendsMessages: false });
        assert.equal((await pool.query('SELECT 1 FROM nova_capture_requests WHERE client=$1 AND submission_id=$2', [configuredSource.client, submissionId])).rows.length, 0);
        assert.equal((await pool.query('SELECT 1 FROM nova_capture_submission_tombstones WHERE client=$1 AND submission_id=$2', [configuredSource.client, submissionId])).rows.length, 1);
        for (const table of ['jemlio_followups', 'jemlio_workspace_audit']) assert.equal((await pool.query('SELECT 1 FROM ' + table + ' WHERE request_id=$1', [created.data.receipt])).rows.length, 0);
      } finally {
        allowCommit.resolve();
        await Promise.allSettled([deletion, replay].filter(Boolean));
        routeRuntime = runtime;
      }
    });
    await check('disabled intake and unavailable database fail closed without returning contacts or secrets', async () => {
      routeRuntime = createEnquiryIntakeRuntime({ env: {}, pool, now });
      assert.deepEqual((await post(payload())).data, { error: 'enquiry_intake_disabled' });
      routeRuntime = createEnquiryIntakeRuntime({ env, pool: { async query() { throw new Error('PRIVATE-DB-DETAIL'); }, async connect() { throw new Error('PRIVATE-DB-DETAIL'); } }, now });
      const result = await post(payload()); assert.equal(result.status, 503); assert.equal(result.headers.get('retry-after'), '30');
      assert.deepEqual(result.data, { error: 'enquiry_intake_unavailable' }); routeRuntime = runtime;
    });
    console.log(`Enquiry intake checks passed: ${checks}. ${db.real ? 'Real PostgreSQL concurrency' : 'PGlite persistence'}. Synthetic data only; no messages sent.`);
  } finally { if (server) await new Promise(resolve => server.close(resolve)); await runtime.close(); await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
