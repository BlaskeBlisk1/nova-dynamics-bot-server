'use strict';
// Production URLs are never accepted, including as a fallback.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const { PgStore } = require('../lib/capture/store');
const { CaptureOperations } = require('../lib/capture/operations');
const { BookingStore } = require('../lib/booking/store');
const raw = process.env.JEMLIO_TEST_DATABASE_URL;
if (!raw || process.env.JEMLIO_THROWAWAY_DATABASE !== 'true') throw new Error('Explicit disposable database configuration required');
const url = new URL(raw);
if (!['postgres:', 'postgresql:'].includes(url.protocol) || !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    url.pathname !== '/jemlio_capture_ci' || url.search) throw new Error('Only the named localhost CI database is permitted');
global.fetch = async () => { throw new Error('No external HTTP permitted in booking database tests'); };
const pool = new Pool({ connectionString: raw, max: 12, connectionTimeoutMillis: 5000, statement_timeout: 15000 });
const capture = new PgStore({ pool }), bookings = new BookingStore({ pool }), ops = new CaptureOperations({ pool });
const eventType = 'https://api.calendly.com/event_types/synthetic-event';
const slot = new Date(Date.now() + 3600000).toISOString();
const gate = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
let checks = 0;
async function check(name, fn) { await fn(); console.log(`ok ${++checks} - ${name}`); }
async function entry(client) {
  const row = { client, receipt: randomUUID(), submissionId: randomUUID(), payloadHash: randomUUID(), createdAt: Date.now(),
    data: { name: 'Synthetic only', email: 'nobody@example.invalid', service: 'visit', consent: true },
    notification: { to: ['owner@example.invalid'], subject: 'NOT SENT', text: 'Synthetic only' } };
  await capture.create(row);
  await pool.query("UPDATE nova_capture_outbox SET status='accepted',provider_id='synthetic' WHERE request_id=$1", [row.receipt]);
  return row;
}
const claim = row => ({ client: row.client, receipt: row.receipt, eventType, slot });
async function blocked(pattern) {
  for (let i = 0; i < 150; i++) {
    const { rows } = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE $1", [pattern]);
    if (rows[0].n > 0) return;
    await delay(20);
  }
  throw new Error('Expected a real PostgreSQL row-lock wait');
}
function hookedPool(prefix, held, release) {
  return { query: (...args) => pool.query(...args), async connect() {
    const db = await pool.connect();
    return { release: () => db.release(), async query(sql, args) {
      const result = await db.query(sql, args);
      if (sql.startsWith(prefix)) { held.resolve(); await release.promise; }
      return result;
    } };
  } };
}
async function main() {
  try {
    await capture.initialize(); await pool.query(readFileSync(join(__dirname, '../lib/booking/schema.sql'), 'utf8'));
    await check('eight simultaneous booking claims create exactly one durable provider attempt', async () => {
      const row = await entry('ci-booking-concurrent');
      const replies = await Promise.all(Array.from({ length: 8 }, () => bookings.claim(claim(row))));
      assert.equal(replies.filter(r => r.claimed).length, 1);
      assert.equal(new Set(replies.map(r => r.row.attempt_id)).size, 1);
      await bookings.finish(replies.find(r => r.claimed).row, { status: 'needs_review' });
      assert.equal((await bookings.claim(claim(row))).claimed, false);
    });
    await check('deletion waiting behind a booking claim rechecks the new booking after the lock clears', async () => {
      const row = await entry('ci-booking-delete-race'), held = gate(), release = gate();
      const hooked = new BookingStore({ pool: hookedPool('SELECT id FROM nova_capture_requests', held, release) });
      const booking = hooked.claim(claim(row)); let deletion;
      try {
        await held.promise;
        deletion = ops.deleteRequests({ client: row.client, receipt: row.receipt, apply: true });
        await blocked('SELECT r.id FROM nova_capture_requests%');
      } finally { release.resolve(); }
      assert.equal((await booking).claimed, true);
      assert.equal((await deletion).deletedRequests, 0);
      assert.equal((await bookings.read(row.client, row.receipt)).status, 'attempting');
    });
    await check('booking waiting behind deletion cannot create an orphaned provider attempt', async () => {
      const row = await entry('ci-booking-deleted-first'), held = gate(), release = gate();
      const deleting = new CaptureOperations({ pool: hookedPool('SELECT r.id FROM nova_capture_requests', held, release) }).deleteRequests({ client: row.client, receipt: row.receipt, apply: true });
      let booking;
      try {
        await held.promise;
        booking = bookings.claim(claim(row)).then(value => ({ value }), error => ({ error }));
        await blocked('SELECT id FROM nova_capture_requests%');
      } finally { release.resolve(); }
      assert.equal((await deleting).deletedRequests, 1);
      assert.equal((await booking).error.code, 'request_not_found');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM jemlio_bookings WHERE request_id=$1', [row.receipt])).rows[0].n, 0);
    });
    await check('booking waiting behind a new closed outcome sees the committed joined row', async () => {
      const row = await entry('ci-booking-closed-race'), db = await pool.connect(); let booking;
      try {
        await db.query('BEGIN'); await db.query('SELECT id FROM nova_capture_requests WHERE id=$1 FOR UPDATE', [row.receipt]);
        await db.query("INSERT INTO nova_capture_outcomes(request_id,outcome,updated_at) VALUES ($1,'won',now())", [row.receipt]);
        booking = bookings.claim(claim(row)).then(value => ({ value }), error => ({ error }));
        await blocked('SELECT id FROM nova_capture_requests%');
        await db.query('COMMIT');
      } finally { await db.query('ROLLBACK'); db.release(); }
      assert.equal((await booking).error.code, 'request_closed');
    });
    console.log(`Real PostgreSQL booking checks passed: ${checks}. No provider calls or production database access.`);
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
