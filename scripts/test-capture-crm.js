'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { PgStore, createMemoryStore, createCaptureRouter, flushNotifications } = require('../lib/capture');
const { createCrmPayload, validDestination, createAirtableWriter, CrmOutbox, flushCrm, RETRY_WINDOW_MS } = require('../lib/capture/crm');
const { CaptureOperations } = require('../lib/capture/operations');
const { createUpgradeConfig } = require('../lib/upgrade-config');

// Real HTTP is limited to this process's test server. Providers are injected.
const localFetch = global.fetch;
global.fetch = (url, options) => {
  if (new URL(url).hostname !== '127.0.0.1') throw new Error('External test HTTP is forbidden');
  return localFetch(url, options);
};
const destination = { baseId: 'app12345678901234', tableId: 'tbl12345678901234' };
const recordId = 'rec12345678901234';
const data = { name: 'Synthetic person', email: 'nobody@example.invalid', phone: '', service: 'bil', preferredTime: 'After 16', consent: true };
const notification = { from: 'sender@example.invalid', to: ['owner@example.invalid'], subject: 'NOT SENT', text: 'Synthetic only' };

async function main() {
  let passed = 0, clock = Date.parse('2026-09-22T12:00:00Z');
  const db = new PGlite();
  const query = (sql, params) => params === undefined ? db.exec(sql).then(r => r.at(-1)) : db.query(sql, params);
  let queue = Promise.resolve();
  const pool = { query, connect: async () => {
    let release; const previous = queue; queue = new Promise(resolve => { release = resolve; }); await previous;
    return { query, release };
  } };
  const store = new PgStore({ pool }), crmStore = new CrmOutbox({ pool });
  const operations = new CaptureOperations({ pool, now: () => clock });
  const input = () => {
    const receipt = randomUUID();
    return { receipt, client: 'example', submissionId: randomUUID(), payloadHash: 'synthetic-hash', data, notification, createdAt: clock,
      crm: createCrmPayload({ destination, receipt, name: 'Example school', service: 'Bil', data, createdAt: clock }) };
  };
  const options = { store: crmStore, isTenantEnabled: async () => true, now: () => clock };
  const test = async (name, run) => {
    await query('DELETE FROM nova_capture_requests');
    await run(); console.log(`ok ${++passed} - ${name}`);
  };
  let server;
  try {
    await store.initialize(); await store.initialize();
    await test('CRM is explicitly tenant-configured; previews and unrelated tenants do not inherit it', async () => {
      const tenant = { mode: 'live', enabled: true, crm: destination };
      const registry = () => ({ fram: { name: 'Fram' }, tiller: { name: 'Tiller' } });
      const config = createUpgradeConfig({ getRegistry: registry, env: {
        NOVA_CAPTURE_ENABLED: 'true', NOVA_PREVIEW_ENABLED: 'true', NOVA_CAPTURE_CONFIG: JSON.stringify({ fram: tenant })
      } });
      assert.equal(config.hasLiveCrm(), true);
      assert.equal(config.captureTenant('tiller'), null);
      assert.equal(config.captureTenant('fram', { preview: true }).crm, undefined);
      const off = createUpgradeConfig({ getRegistry: registry, env: { NOVA_CAPTURE_CONFIG: JSON.stringify({ fram: tenant }) } });
      assert.equal(off.hasLiveCrm(), false);
      for (const invalid of [null, {}, [], { ...destination, tableId: '../secret' }, { ...destination, url: 'https://elsewhere.invalid' }]) {
        assert.equal(validDestination(invalid), false);
      }
      await assert.rejects(createMemoryStore().create({ crm: input().crm }), /preview_crm_forbidden/);
    });
    await test('concurrent browser retries create one immutable request, email and CRM entry', async () => {
      const row = input();
      const retries = await Promise.all(Array.from({ length: 5 }, () => store.create(row)));
      assert.equal(retries.filter(r => !r.duplicate).length, 1);
      for (const table of ['nova_capture_requests', 'nova_capture_outbox', 'nova_capture_crm_outbox']) {
        assert.equal((await query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n, 1);
      }
      await store.create({ ...row, crm: { ...row.crm, destination: { ...destination, tableId: 'tbl98765432109876' } } });
      assert.deepEqual((await query('SELECT payload FROM nova_capture_crm_outbox')).rows[0].payload, row.crm);
    });
    await test('a failed CRM write rolls back the enquiry and email transaction', async () => {
      await query('ALTER TABLE nova_capture_crm_outbox ADD CONSTRAINT simulated_failure CHECK (false) NOT VALID');
      try { await assert.rejects(store.create(input())); }
      finally { await query('ALTER TABLE nova_capture_crm_outbox DROP CONSTRAINT simulated_failure'); }
      for (const table of ['nova_capture_requests', 'nova_capture_outbox', 'nova_capture_crm_outbox']) {
        assert.equal((await query(`SELECT count(*)::integer AS n FROM ${table}`)).rows[0].n, 0);
      }
      const row = input(); row.crm.fields.Status = 'New';
      await assert.rejects(store.create(row), /crm_payload_invalid/);
      assert.equal((await query('SELECT count(*)::integer AS n FROM nova_capture_requests')).rows[0].n, 0);
    });
    await test('the API saves only validated visitor fields and server-selected CRM destinations', async () => {
      const origin = 'https://example.invalid';
      const config = { name: 'Example school', recipient: 'owner@example.invalid', privacyUrl: 'https://example.invalid/privacy',
        services: [{ id: 'bil', label: 'Bil' }], allowedOrigins: [origin], crm: destination };
      const router = createCaptureRouter({ liveStore: store, secret: 'synthetic-secret-with-at-least-32-characters',
        notificationFrom: notification.from, now: () => clock,
        getTenantConfig: (client, { preview }) => ({ ...config, mode: preview ? 'preview' : 'live',
          ...(client === 'bad' ? { crm: { baseId: 'bad', tableId: 'bad' } } : {}) }) });
      const app = express(); app.use('/capture', router);
      server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
      const base = `http://127.0.0.1:${server.address().port}/capture`;
      const post = async (path, body) => {
        const res = await fetch(base + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        return { status: res.status, body: await res.json() };
      };
      assert.equal((await router.getPublicConfig('bad')).enabled, false);
      const publicConfig = await router.getPublicConfig('example');
      assert.equal(publicConfig.enabled, true); assert.equal(publicConfig.crm, undefined);
      const session = await post('/session', { client: 'example' });
      const body = { ...data, client: 'example', submissionId: randomUUID(), token: session.body.token, website: '' };
      assert.equal((await post('/requests', { ...body, crm: destination })).status, 400);
      const saved = await post('/requests', body);
      assert.equal(saved.status, 201); assert.equal(saved.body.status, 'received');
      const stored = (await query('SELECT payload FROM nova_capture_crm_outbox')).rows[0].payload;
      assert.equal(stored.fields.Receipt, saved.body.receipt); assert.equal(stored.fields.Service, 'Bil');
      assert.equal(stored.fields.Consent, true); assert.equal(stored.fields.Status, undefined);
      assert.equal(stored.fields.Notes, undefined); assert.deepEqual(stored.destination, destination);
      const preview = await post('/session', { client: 'example', preview: true });
      assert.equal((await post('/requests', { ...body, submissionId: randomUUID(), token: preview.body.token })).body.status, 'preview_saved');
      assert.equal((await query('SELECT count(*)::integer AS n FROM nova_capture_crm_outbox')).rows[0].n, 1);
      await new Promise(resolve => server.close(resolve)); server = null;
    });
    await test('Airtable adapter upserts by receipt, preserves sales fields and requires persisted field confirmation', async () => {
      const row = input(); let calls = 0;
      const write = createAirtableWriter({ apiKey: 'synthetic-not-a-token', fetchFn: async (url, request) => {
        calls++; assert.equal(url, `https://api.airtable.com/v0/${destination.baseId}/${destination.tableId}`);
        assert.equal(request.method, 'PATCH'); assert.equal(request.redirect, 'error');
        const body = JSON.parse(request.body);
        assert.deepEqual(body.performUpsert.fieldsToMergeOn, ['Receipt']); assert.equal(body.typecast, false);
        assert.equal(body.records[0].fields.Status, undefined); assert.equal(body.records[0].fields.Notes, undefined);
        return new Response(JSON.stringify({ records: [{ id: recordId, fields: { ...body.records[0].fields, Status: 'Won', Notes: 'Keep this' } }] }));
      } });
      assert.deepEqual(await write({ payload: row.crm }), { recordId });
      assert.equal(calls, 1);
      await assert.rejects(write({ payload: { ...row.crm, fields: { ...row.crm.fields, Notes: 'Unsafe' } } }), e => e.retryable === false);
      assert.equal(calls, 1);
      for (const result of [{}, { records: [{ id: recordId, fields: { ...row.crm.fields, Receipt: randomUUID() } }] }]) {
        const uncertain = createAirtableWriter({ apiKey: 'synthetic', fetchFn: async () => new Response(JSON.stringify(result)) });
        await assert.rejects(uncertain({ payload: row.crm }), e => e.code === 'crm_response_uncertain' && e.retryable);
      }
    });
    await test('lost confirmation retries the same upsert without another record or a sales-status reset', async () => {
      const row = input(); await store.create(row);
      const external = new Map(); let attempts = 0;
      const write = createAirtableWriter({ apiKey: 'synthetic', fetchFn: async (_url, request) => {
        attempts++; const fields = JSON.parse(request.body).records[0].fields;
        external.set(fields.Receipt, { ...external.get(fields.Receipt), ...fields });
        return new Response(JSON.stringify({ records: [{ id: recordId, fields: external.get(fields.Receipt) }] }));
      } });
      const failingStore = { durable: true, claimNext: (...args) => crmStore.claimNext(...args), finish: async () => { throw new Error('simulated DB outage'); } };
      await assert.rejects(flushCrm({ ...options, store: failingStore, writeCrm: write }), /simulated DB outage/);
      external.get(row.receipt).Status = 'Contacted'; external.get(row.receipt).Notes = 'Human follow-up';
      assert.equal((await flushCrm({ ...options, writeCrm: write })).length, 0);
      clock += 60_001;
      assert.equal((await flushCrm({ ...options, writeCrm: write }))[0].status, 'synced');
      assert.equal(attempts, 2); assert.equal(external.size, 1);
      assert.equal(external.get(row.receipt).Status, 'Contacted'); assert.equal(external.get(row.receipt).Notes, 'Human follow-up');
    });
    await test('provider rejection, throttling and timeouts have bounded, sanitized retry behavior', async () => {
      const row = input();
      for (const status of [400, 401, 403, 404, 408, 422, 429, 500, 503]) {
        const write = createAirtableWriter({ apiKey: 'synthetic', fetchFn: async () => new Response(JSON.stringify({ error: 'private contact or credentials' }),
          { status, headers: { 'Retry-After': '120' } }) });
        await assert.rejects(write({ payload: row.crm }), error => {
          assert.equal(error.retryable, status === 408 || status === 429 || status >= 500);
          assert.equal(error.code, `crm_provider_${status}`); assert.equal(error.retryAfterMs, 120_000);
          assert.doesNotMatch(error.message, /private|credentials|contact/); return true;
        });
      }
      const timed = createAirtableWriter({ apiKey: 'synthetic', timeoutMs: 5, fetchFn: async (_url, { signal }) =>
        new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('private network error')), { once: true })) });
      await assert.rejects(timed({ payload: row.crm }), error => error.code === 'crm_network_uncertain' && error.retryable);
    });
    await test('CRM failures leave saved enquiries and the independent email queue intact', async () => {
      const row = input(); await store.create(row);
      const failed = await flushCrm({ ...options, writeCrm: async () => { throw Object.assign(new Error('private provider text'), { code: 'crm_provider_429', retryable: true, retryAfterMs: 120_000 }); } });
      assert.equal(failed[0].status, 'pending');
      const saved = (await query('SELECT * FROM nova_capture_crm_outbox')).rows[0];
      assert.equal(new Date(saved.next_attempt_at).getTime(), clock + 120_000);
      assert.equal(saved.error_code, 'crm_provider_429');
      assert.equal((await flushNotifications({ store, now: () => clock, isTenantEnabled: async () => true,
        sendNotification: async () => ({ providerId: 'synthetic-email' }) }))[0].status, 'accepted');
      assert.equal((await operations.report({ client: 'example' })).crm.pending, 1);
    });
    await test('revoked destinations, permanent failures and expired retries stop without exposing provider text', async () => {
      for (const mode of ['revoked', 'permanent', 'expired']) {
        await query('DELETE FROM nova_capture_requests'); const row = input(); await store.create(row);
        if (mode === 'expired') await query('UPDATE nova_capture_crm_outbox SET first_attempt_at=$1', [new Date(clock - RETRY_WINDOW_MS)]);
        let sent = 0;
        const result = await flushCrm({ ...options, isTenantEnabled: async () => mode !== 'revoked', writeCrm: async () => {
          sent++; throw Object.assign(new Error('private contact and token'), { code: 'private contact and token', retryable: false });
        } });
        assert.equal(result[0].status, 'needs_review'); assert.equal(sent, mode === 'permanent' ? 1 : 0);
        assert.doesNotMatch(JSON.stringify((await query('SELECT error_code FROM nova_capture_crm_outbox')).rows), /private|token|contact/);
      }
    });
    await test('expired leases fence stale worker completion', async () => {
      await store.create(input());
      const old = await crmStore.claimNext(clock, 1000);
      assert.equal(await crmStore.claimNext(clock, 1000), null);
      const current = await crmStore.claimNext(clock + 1001, 1000);
      assert.equal(await crmStore.finish(old, { status: 'synced', recordId, at: clock + 1002 }), false);
      assert.equal(await crmStore.finish(current, { status: 'synced', recordId, at: clock + 1002 }), true);
    });
    await test('unresolved CRM copies block deletion; settled deletion tombstones prevent recreation', async () => {
      const row = input(); await store.create(row);
      await query("UPDATE nova_capture_outbox SET status='accepted',provider_id='synthetic-email'");
      for (const status of ['pending', 'sending', 'needs_review', 'synced']) {
        await query('UPDATE nova_capture_crm_outbox SET status=$1', [status]);
        assert.equal((await operations.deleteRequests({ client: row.client, receipt: row.receipt, apply: true })).deletedRequests, 0);
      }
      await query("UPDATE nova_capture_crm_outbox SET status='synced',record_id=$1", [recordId]);
      const report = await operations.report({ client: row.client });
      assert.equal(report.crm.synced, 1); assert.equal(report.notifications.accepted, 1);
      assert.doesNotMatch(JSON.stringify(report), /nobody@|Synthetic person|rec123/);
      assert.equal((await operations.deleteRequests({ client: 'other', receipt: row.receipt, apply: true })).deletedRequests, 0);
      assert.equal((await operations.deleteRequests({ client: row.client, receipt: row.receipt, apply: true })).deletedRequests, 1);
      assert.equal((await query('SELECT count(*)::integer AS n FROM nova_capture_crm_outbox')).rows[0].n, 0);
      await assert.rejects(store.create(row), e => e.code === 'submission_removed');
    });
    console.log(`CRM checks passed: ${passed}. No external provider calls.`);
  } finally {
    if (server) await new Promise(resolve => server.close(resolve));
    await db.close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
