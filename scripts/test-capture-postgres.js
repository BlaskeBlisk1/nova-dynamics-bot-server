'use strict';

// Uses only a throwaway localhost database. Never falls back to NOVA_DATABASE_URL.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const { PgStore } = require('../lib/capture/store');
const { CaptureOperations } = require('../lib/capture/operations');
const { CrmOutbox, createCrmPayload } = require('../lib/capture/crm');
const raw = process.env.JEMLIO_TEST_DATABASE_URL;
if (!raw || process.env.JEMLIO_THROWAWAY_DATABASE !== 'true') throw new Error('Explicit disposable database configuration required');
const url = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/jemlio_capture_ci' || url.search) throw new Error('Only the named localhost CI database is permitted');
global.fetch = async () => { throw new Error('External HTTP is forbidden in capture database tests'); };
const options = { connectionString: raw, max: 10, connectionTimeoutMillis: 5000, statement_timeout: 10000 };
const pool = new Pool(options);
const store = new PgStore({ pool });
const ops = new CaptureOperations({ pool });
const crmStore = new CrmOutbox({ pool });
const input = (client, overrides = {}) => ({ client, receipt: randomUUID(), submissionId: randomUUID(),
  payloadHash: 'synthetic-payload', createdAt: Date.now(),
  data: { name: 'Synthetic test only', email: 'nobody@example.invalid' },
  notification: { to: 'nobody@example.invalid', subject: 'NOT SENT', text: 'Synthetic test only' }, ...overrides });
const withCrm = row => ({ ...row, crm: createCrmPayload({ receipt: row.receipt,
  destination: { baseId: 'app12345678901234', tableId: 'tbl12345678901234' }, name: 'Synthetic business',
  service: 'Synthetic service', data: { ...row.data, consent: true }, createdAt: row.createdAt }) });
let checks = 0;
async function check(name, run) { await run(); console.log(`ok ${++checks} - ${name}`); }
const accepted = id => pool.query("UPDATE nova_capture_outbox SET status='accepted',provider_id='synthetic-only',locked_until=NULL,lock_token=NULL WHERE request_id=$1", [id]);
function gate() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
async function main() {
  await store.initialize();
  await store.initialize();
  try {
    await check('missing outbox payload rolls back the entire request', async () => {
      const row = input('ci-atomic', { notification: null });
      await assert.rejects(store.create(row), /live_notification_required/);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM nova_capture_requests WHERE id=$1', [row.receipt])).rows[0].n, 0);
    });
    await check('eight concurrent identical submissions create one receipt and one outbox row', async () => {
      const row = input('ci-duplicate');
      const replies = await Promise.all(Array.from({ length: 8 }, () => store.create({ ...row, receipt: randomUUID() })));
      assert.equal(new Set(replies.map(r => r.receipt)).size, 1);
      assert.equal(replies.filter(r => !r.duplicate).length, 1);
      const counts = (await pool.query('SELECT count(*)::int AS n FROM nova_capture_outbox o JOIN nova_capture_requests r ON r.id=o.request_id WHERE r.client=$1', [row.client])).rows[0];
      assert.equal(counts.n, 1);
    });
    await check('concurrent different payloads cannot overwrite the winning submission', async () => {
      const row = input('ci-conflict');
      const results = await Promise.allSettled([store.create(row), store.create({ ...row, receipt: randomUUID(), payloadHash: 'different' })]);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
      assert.equal(results.find(r => r.status === 'rejected').reason.code, 'submission_conflict');
    });
    await check('the same submission ID stays independent across tenants', async () => {
      const row = input('ci-tenant-a');
      const replies = await Promise.all([store.create(row), store.create({ ...row, client: 'ci-tenant-b', receipt: randomUUID() })]);
      assert.notEqual(replies[0].receipt, replies[1].receipt);
    });
    await check('concurrent CRM submissions keep one frozen export; failure rolls back both delivery queues', async () => {
      const row = input('ci-crm-atomic');
      const replies = await Promise.all(Array.from({ length: 8 }, () => store.create(withCrm({ ...row, receipt: randomUUID() }))));
      assert.equal(replies.filter(r => !r.duplicate).length, 1);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM nova_capture_crm_outbox')).rows[0].n, 1);
      const receipt = replies[0].receipt;
      assert.equal((await pool.query('SELECT payload FROM nova_capture_crm_outbox WHERE request_id=$1', [receipt])).rows[0].payload.fields.Receipt, receipt);
      await pool.query('ALTER TABLE nova_capture_crm_outbox ADD CONSTRAINT simulated_failure CHECK (false) NOT VALID');
      const failed = withCrm(input('ci-crm-rollback'));
      try { await assert.rejects(store.create(failed)); }
      finally { await pool.query('ALTER TABLE nova_capture_crm_outbox DROP CONSTRAINT simulated_failure'); }
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM nova_capture_requests WHERE id=$1', [failed.receipt])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM nova_capture_outbox WHERE request_id=$1', [failed.receipt])).rows[0].n, 0);
      await pool.query("UPDATE nova_capture_crm_outbox SET status='synced',record_id='rec12345678901234'");
    });
    await check('real concurrent CRM claims are exclusive and fence stale workers', async () => {
      const rows = Array.from({ length: 3 }, () => withCrm(input('ci-crm-leases')));
      await Promise.all(rows.map(row => store.create(row)));
      const at = Date.now() + 100;
      const claims = await Promise.all(Array.from({ length: 3 }, () => crmStore.claimNext(at, 1000)));
      assert.equal(new Set(claims.map(c => c.request_id)).size, 3);
      assert.equal(await crmStore.claimNext(at, 1000), null);
      const current = await crmStore.claimNext(at + 1001, 1000);
      const old = claims.find(c => c.request_id === current.request_id);
      assert.equal(await crmStore.finish(old, { status: 'synced', recordId: 'rec12345678901234', at: at + 1002 }), false);
      assert.equal(await crmStore.finish(current, { status: 'synced', recordId: 'rec12345678901234', at: at + 1002 }), true);
      await pool.query("UPDATE nova_capture_crm_outbox SET status='synced',record_id='rec12345678901234',lock_token=NULL,locked_until=NULL");
    });
    // Settle earlier synthetic rows so the next claim tests have an exact cohort.
    await pool.query("UPDATE nova_capture_outbox SET status='accepted',provider_id='synthetic-only'");
    await check('website and school workers claim only their own queues under real concurrency', async () => {
      const website = withCrm(input('jemlio-website'));
      const school = withCrm(input('ci-school-scope'));
      await Promise.all([store.create(website), store.create(school)]);
      const at = Date.now() + 100;
      const websiteMail = new PgStore({ pool, claimClient: 'jemlio-website' });
      const schoolMail = new PgStore({ pool, excludeClient: 'jemlio-website' });
      const websiteCrm = new CrmOutbox({ pool, claimClient: 'jemlio-website' });
      const schoolCrm = new CrmOutbox({ pool, excludeClient: 'jemlio-website' });
      const [wm, sm, wc, sc] = await Promise.all([
        websiteMail.claimNext(at), schoolMail.claimNext(at), websiteCrm.claimNext(at), schoolCrm.claimNext(at)
      ]);
      assert.equal(wm.request_id, website.receipt); assert.equal(wc.request_id, website.receipt);
      assert.equal(sm.request_id, school.receipt); assert.equal(sc.request_id, school.receipt);
      assert.equal(await websiteMail.claimNext(at), null); assert.equal(await schoolMail.claimNext(at), null);
      assert.equal(await websiteCrm.claimNext(at), null); assert.equal(await schoolCrm.claimNext(at), null);
      await pool.query("UPDATE nova_capture_outbox SET status='accepted',provider_id='synthetic-only',lock_token=NULL,locked_until=NULL");
      await pool.query("UPDATE nova_capture_crm_outbox SET status='synced',record_id='rec12345678901234',lock_token=NULL,locked_until=NULL");
    });
    await check('concurrent worker claims are exclusive and expired leases fence stale completion', async () => {
      const rows = Array.from({ length: 3 }, () => input('ci-leases'));
      await Promise.all(rows.map(row => store.create(row)));
      const at = Date.now() + 100;
      const claims = await Promise.all([store.claimNext(at, 1000), store.claimNext(at, 1000), store.claimNext(at, 1000)]);
      assert.equal(new Set(claims.map(c => c.request_id)).size, 3);
      assert.equal(await store.claimNext(at, 1000), null);
      const renewed = await store.claimNext(at + 1001, 1000);
      const old = claims.find(c => c.request_id === renewed.request_id);
      assert.notEqual(old.lock_token, renewed.lock_token);
      assert.equal(await store.finish(old, { status: 'accepted', providerId: 'stale', at: at + 1002 }), false);
      assert.equal(await store.finish(renewed, { status: 'accepted', providerId: 'synthetic-current', at: at + 1002 }), true);
      for (const row of rows) await accepted(row.receipt);
    });
    await check('operator deletion protects pending mail and blocks retries after settled deletion', async () => {
      const row = input('ci-delete');
      await store.create(row);
      assert.equal((await ops.deleteRequests({ client: row.client, receipt: row.receipt, apply: true })).deletedRequests, 0);
      await accepted(row.receipt);
      assert.equal((await ops.deleteRequests({ client: row.client, receipt: row.receipt, apply: true })).deletedRequests, 1);
      await assert.rejects(store.create({ ...row, receipt: randomUUID() }), e => e.code === 'submission_removed');
    });
    await check('a retry waiting on uncommitted deletion cannot recreate a request or notification', async () => {
      const row = withCrm(input('ci-delete-race'));
      await store.create(row); await accepted(row.receipt);
      assert.equal((await ops.deleteRequests({ client: row.client, receipt: row.receipt, apply: true })).deletedRequests, 0);
      await pool.query("UPDATE nova_capture_crm_outbox SET status='synced',record_id='rec12345678901234' WHERE request_id=$1", [row.receipt]);
      const deleted = gate(), release = gate();
      const hookedPool = {
        query: (...args) => pool.query(...args),
        async connect() {
          const db = await pool.connect();
          return { release: () => db.release(), async query(sql, args) {
            const result = await db.query(sql, args);
            if (typeof sql === 'string' && sql.startsWith('DELETE FROM nova_capture_requests')) { deleted.resolve(); await release.promise; }
            return result;
          } };
        }
      };
      const deleting = new CaptureOperations({ pool: hookedPool }).deleteRequests({ client: row.client, receipt: row.receipt, apply: true });
      let retry;
      try {
        await Promise.race([deleted.promise, delay(5000).then(() => { throw new Error('Deletion checkpoint timeout'); })]);
        retry = store.create({ ...row, receipt: randomUUID() }).then(value => ({ value }), error => ({ error }));
        let observed = false;
        for (let attempt = 0; attempt < 100; attempt++) {
          const waiting = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'INSERT INTO nova_capture_requests%'");
          if (waiting.rows[0].n > 0) { observed = true; break; }
          await delay(25);
        }
        assert.equal(observed, true, 'A real database lock wait must be observed');
      } finally { release.resolve(); }
      assert.equal((await deleting).deletedRequests, 1);
      assert.equal((await retry).error.code, 'submission_removed');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM nova_capture_requests WHERE client=$1', [row.client])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM nova_capture_crm_outbox WHERE request_id=$1', [row.receipt])).rows[0].n, 0);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM nova_capture_submission_tombstones WHERE client=$1', [row.client])).rows[0].n, 1);
    });
    await check('saved requests survive closing and reopening the client connection pool', async () => {
      const temporary = new Pool(options), original = new PgStore({ pool: temporary });
      const row = input('ci-reconnect');
      await original.create(row); await temporary.end();
      const replacement = new Pool(options);
      try { assert.equal((await new PgStore({ pool: replacement }).create({ ...row, receipt: randomUUID() })).receipt, row.receipt); }
      finally { await replacement.end(); }
    });
    console.log(`Real PostgreSQL checks passed: ${checks}. No provider calls or production database access.`);
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error.code || error.message); process.exitCode = 1; });
