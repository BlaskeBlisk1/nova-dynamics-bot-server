'use strict';
// All provider calls are intercepted; synthetic contacts only.
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { PgStore, createCaptureRouter } = require('../lib/capture');
const { CaptureOperations } = require('../lib/capture/operations');
const { BookingStore, publicBooking, iso, scope } = require('../lib/booking/store');
const { createBookingRuntime } = require('../lib/booking/runtime');
const { createCalendly, managementUrl } = require('../lib/booking/calendly');
const { parse } = require('./booking-operations');
const eventType = 'https://api.calendly.com/event_types/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const event = 'https://api.calendly.com/scheduled_events/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const providerId = `${event}/invitees/11111111-2222-4333-8444-555555555555`;
const reply = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
let checks = 0;
async function check(name, fn) { await fn(); console.log(`ok ${++checks} - ${name}`); }
async function main() {
  await check('operator and date validation reject ambiguous input', async () => {
    assert.throws(() => iso('2026-02-30T10:00:00Z'), /invalid_date/);
    assert.throws(() => iso('2026-09-23'), /invalid_date/);
    assert.throws(() => scope(['example']), /invalid_scope/);
    assert.throws(() => parse(['result','--client','example','--receipt',randomUUID(),'--amount-ore','1.5']), /invalid_number/);
    assert.throws(() => parse(['due','--client','example','--apply']), /invalid_arguments/);
    assert.equal(parse(['result','--client','example','--receipt',randomUUID(),'--status','sale','--amount-ore','250000']).args.amountOre, 250000);
  });
  await check('management links cannot redirect to untrusted hosts or script URLs', async () => {
    for (const value of ['javascript:alert(1)','https://evil.invalid/cancellations/id','https://calendly.com@evil.invalid/cancellations/id','https://calendly.com/cancellations/id?next=evil']) assert.equal(managementUrl(value), null);
    assert.equal(managementUrl('https://calendly.com/reschedulings/test-id'), 'https://calendly.com/reschedulings/test-id');
  });
  await check('Calendly uses fixed endpoints and filters stale, duplicate and unavailable times', async () => {
    let sent;
    const adapter = createCalendly({ token: 'synthetic-key-only', fetchFn: async (url, options) => {
      sent = { url, options }; return reply({ collection: [
        { status: 'available', start_time: '2026-09-24T10:00:00Z' },
        { status: 'available', start_time: '2026-09-24T10:00:00Z' },
        { status: 'unavailable', start_time: '2026-09-24T11:00:00Z' },
        { status: 'available', start_time: '2026-09-01T10:00:00Z' },
        { status: 'available', start_time: 'broken' }
      ] });
    } });
    assert.deepEqual(await adapter.slots(eventType, '2026-09-23T10:00:00Z', '2026-09-30T10:00:00Z'), ['2026-09-24T10:00:00.000Z']);
    assert.equal(new URL(sent.url).origin, 'https://api.calendly.com');
    assert.equal(sent.options.redirect, 'error');
    await assert.rejects(adapter.slots('https://evil.invalid/event_types/12345678', '', ''), /invalid_event_type/);
  });
  await check('booking sends exactly one reviewed provider request and sanitizes management links', async () => {
    const calls = [];
    const adapter = createCalendly({ token: 'synthetic-key-only', fetchFn: async (url, options) => {
      calls.push({ url, options }); return reply({ resource: { uri: providerId, event, status: 'active', cancel_url: 'https://evil.invalid', reschedule_url: 'https://calendly.com/reschedulings/test-id' } });
    } });
    const attemptId=randomUUID();
    const result = await adapter.book({ service: { eventType }, slot: '2026-09-24T10:00:00.000Z', name: 'Example', email: 'nobody@example.invalid',attemptId });
    assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://api.calendly.com/invitees');
    assert.equal(JSON.parse(calls[0].options.body).invitee.timezone, 'Europe/Oslo');
    assert.equal(JSON.parse(calls[0].options.body).tracking.utm_content,'jemlio:'+attemptId);
    assert.equal(result.providerId, providerId); assert.equal(result.cancelUrl, null);
    assert.equal(JSON.stringify(result).includes('synthetic-key'), false);
  });
  await check('timeouts, 429, server errors and malformed success never trigger a second booking POST', async () => {
    for (const outcome of [null, 429, 500, 201, 400]) {
      let calls = 0;
      const adapter = createCalendly({ token: 'synthetic-key-only', fetchFn: async () => {
        calls++; if (outcome === null) throw new Error('timeout'); return reply({}, outcome);
      } });
      await assert.rejects(adapter.book({ service: { eventType }, slot: '2026-09-24T10:00:00.000Z', name: 'Example', email: 'nobody@example.invalid' }),
        new RegExp(outcome === 400 ? 'booking_rejected' : 'booking_uncertain'));
      assert.equal(calls, 1);
    }
  });
  await check('reconciliation is read only and must match contact, service and time', async () => {
    let wrong = false; const methods = [];
    const adapter = createCalendly({ token: 'synthetic-key-only', fetchFn: async (url, options) => {
      methods.push(options.method);
      return reply({ resource: url === providerId ? { uri: providerId, event, email: 'nobody@example.invalid', status: 'active' } :
        { event_type: eventType, start_time: wrong ? '2026-09-25T10:00:00Z' : '2026-09-24T10:00:00Z', status: 'active' } });
    } });
    const input = { providerId, eventType, slot: '2026-09-24T10:00:00.000Z', email: 'nobody@example.invalid' };
    assert.equal((await adapter.verify(input)).status, 'confirmed');
    wrong = true; await assert.rejects(adapter.verify(input), /provider_record_mismatch/);
    await assert.rejects(adapter.verify({ ...input, email: 'another@example.invalid' }), /provider_record_mismatch/);
    assert.ok(methods.every(m => m === 'GET'));
  });
  const db = new PGlite();
  // A real exclusive connection abstraction: pool queries cannot run inside a
  // transaction owned by another simulated connection.
  let tail = Promise.resolve();
  async function acquire() { let release; const prior = tail; tail = new Promise(r => { release = r; }); await prior; return release; }
  const query = (sql, args) => args === undefined ? db.exec(sql).then(r => r.at(-1)) : db.query(sql, args);
  const pool = { async query(sql, args) { const release = await acquire(); try { return await query(sql, args); } finally { release(); } },
    async connect() { const release = await acquire(); return { query, release }; } };
  let clock = Date.UTC(2026, 8, 23, 10);
  const now = () => clock;
  const capture = new PgStore({ pool }), store = new BookingStore({ pool, now }), ops = new CaptureOperations({ pool, now });
  const slot = new Date(clock + 2 * 3600000).toISOString();
  const origin = 'https://booking.example.invalid';
  const tenant = { mode: 'live', name: 'Synthetic business', allowedOrigins: [origin], recipient: 'owner@example.invalid', privacyUrl: `${origin}/privacy`, services: [{ id: 'visit', label: 'Visit' }, { id: 'quote', label: 'Quote' }] };
  const cfg = { enabled: true, credentialEnv: 'JEMLIO_CALENDLY_EXAMPLE', services: { visit: { mode: 'calendly', eventType, durationMinutes: 30 }, quote: { mode: 'request' } } };
  const env = { JEMLIO_BOOKING_ENABLED: 'true', NOVA_CAPTURE_SECRET: 'synthetic-secret-with-more-than-32-characters', JEMLIO_CALENDLY_EXAMPLE: 'synthetic-key-only', JEMLIO_BOOKING_CONFIG: JSON.stringify({ example: cfg, second: cfg }) };
  let providerCalls = 0, available = [slot], failure;
  const fake = { slots: async () => available, book: async () => { providerCalls++; if (failure) throw Object.assign(new Error(failure), { code: failure }); return { providerId: `${event}/invitees/${randomUUID()}` }; } };
  const runtime = createBookingRuntime({ env, pool, captureStore: capture, getTenant: async () => tenant, now, providerFactory: () => fake });
  const entry = async (client = 'example', more = {}) => {
    const row = { client, receipt: randomUUID(), submissionId: randomUUID(), payloadHash: randomUUID(), createdAt: clock - 48 * 3600000,
      data: { name: 'Synthetic person', email: 'nobody@example.invalid', service: 'visit', consent: true },
      notification: { to: ['owner@example.invalid'], subject: 'NOT SENT', text: 'Synthetic only' }, ...more };
    await capture.create(row); return row;
  };
  let server;
  try {
    await capture.initialize();
    await check('booking fails closed until the explicit migration exists', async () => {
      assert.equal((await runtime.publicConfig('example')).enabled, false);
    });
    await pool.query(readFileSync(join(__dirname, '../lib/booking/schema.sql'), 'utf8'));
    clock += 11000;
    await check('claims are tenant scoped, durable and idempotent with conflicts rejected', async () => {
      const row = await entry();
      await assert.rejects(store.claim({ client: 'second', receipt: row.receipt, eventType, slot }), /request_not_found/);
      const args = { client: row.client, receipt: row.receipt, eventType, slot };
      const results = await Promise.all(Array.from({ length: 6 }, () => store.claim(args)));
      assert.equal(results.filter(r => r.claimed).length, 1);
      await assert.rejects(store.claim({ ...args, slot: new Date(Date.parse(slot) + 60000).toISOString() }), /booking_conflict/);
      assert.equal(publicBooking(results[0].row, clock + 31000).status, 'needs_review');
      assert.equal(JSON.stringify(publicBooking(results[0].row)).includes('email'), false);
    });
    await check('closed leads cannot start a booking and future appointments cannot be completed', async () => {
      const row = await entry(); await ops.setOutcome({ client: row.client, receipt: row.receipt, outcome: 'won', apply: true });
      await assert.rejects(store.claim({ client: row.client, receipt: row.receipt, eventType, slot }), /request_closed/);
      const next = await entry(); const c = await store.claim({ client: next.client, receipt: next.receipt, eventType, slot });
      await store.finish(c.row, { status: 'confirmed', providerId });
      await assert.rejects(store.record({ client: next.client, receipt: next.receipt, status: 'completed', apply: true }), /appointment_not_started/);
    });
    await check('staff queue keeps uncertainty visible even if a lead is closed or marked done', async () => {
      const row = await entry('queue'); const c = await store.claim({ client: row.client, receipt: row.receipt, eventType, slot });
      await store.finish(c.row, { status: 'needs_review' });
      await ops.setOutcome({ client: row.client, receipt: row.receipt, outcome: 'lost', apply: true });
      await store.schedule({ client: row.client, receipt: row.receipt, action: 'done', apply: true });
      const q = await store.due({ client: 'queue' }); assert.equal(q.due.length, 1); assert.equal(q.due[0].action, 'reconcile');
      assert.equal(q.sendsMessages, false); assert.equal(JSON.stringify(q).includes('nobody@'), false);
      const other = await entry('queue');
      assert.equal((await store.due({ client: 'queue' })).due.length, 2);
      await store.schedule({ client: 'queue', receipt: other.receipt, due: slot, apply: true });
      assert.equal((await store.due({ client: 'queue' })).due.length, 1);
    });
    await check('sales require a verified win, default to dry run and remain separate from booking counts', async () => {
      const row = await entry('report');
      const args = { client: 'report', receipt: row.receipt, status: 'sale', amountOre: 250000 };
      await assert.rejects(store.record({ ...args, apply: true }), /verified_win_required/);
      await ops.setOutcome({ client: 'report', receipt: row.receipt, outcome: 'won', apply: true });
      await store.record(args); assert.equal((await store.report({ client: 'report' })).sales_ore, '0');
      await store.record({ ...args, apply: true });
      const r = await store.report({ client: 'report' }); assert.equal(r.sales_ore, '250000'); assert.equal(r.bookings_recorded, 0); assert.equal(r.valued_sales, 1);
      await ops.setOutcome({ client: 'report', receipt: row.receipt, outcome: 'lost', apply: true });
      assert.equal((await store.report({ client: 'report' })).sales_ore, '0');
      await assert.rejects(store.record({ ...args, amountOre: -1 }), /invalid_amount/);
      await assert.rejects(store.report({ client: 'report', since: slot, before: slot }), /invalid_date_range/);
    });
    await check('confirmed and uncertain bookings survive retention deletion', async () => {
      const row = await entry('retention'); const c = await store.claim({ client: row.client, receipt: row.receipt, eventType, slot });
      await pool.query("UPDATE nova_capture_outbox SET status='accepted',provider_id='synthetic' WHERE request_id=$1", [row.receipt]);
      assert.equal((await ops.deleteRequests({ client: row.client, receipt: row.receipt, apply: true })).deletedRequests, 0);
      await store.finish(c.row, { status: 'needs_review' });
      assert.equal((await ops.deleteRequests({ client: row.client, receipt: row.receipt, apply: true })).deletedRequests, 0);
      await store.reconcile({ client: row.client, receipt: row.receipt, provider: { verify: async () => ({ status: 'confirmed', providerId: `${event}/invitees/${randomUUID()}`, cancelUrl: null, rescheduleUrl: null }) }, apply: true });
      assert.equal((await ops.deleteRequests({ client: row.client, receipt: row.receipt, apply: true })).deletedRequests, 0);
      await store.record({ client: row.client, receipt: row.receipt, status: 'cancelled', apply: true });
      assert.equal((await ops.deleteRequests({ client: row.client, receipt: row.receipt, apply: true })).deletedRequests, 1);
    });
    const app = express(); app.use('/api/booking', runtime.router);
    app.use('/api/capture', createCaptureRouter({ liveStore: capture, getTenantConfig: async () => tenant, secret: env.NOVA_CAPTURE_SECRET,
      notificationFrom: 'jemlio@example.invalid', now, bookingAccess: input => runtime.issueAccess(input) }));
    server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
    const base = `http://127.0.0.1:${server.address().port}`;
    async function call(path, body, from = origin) {
      const res = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(from ? { Origin: from } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json() };
    }
    const auth = async row => ({ client: row.client, receipt: row.receipt, access: await runtime.issueAccess({ client: row.client, receipt: row.receipt, origin }) });
    const confirm = async row => ({ ...await auth(row), slot, confirmed: true });
    await check('public configuration omits provider credentials and all inactive configurations fail closed', async () => {
      const cfg = (await call('/api/booking/config/example')).body;
      assert.equal(cfg.enabled, true); assert.equal(cfg.services.length, 2);
      assert.ok(!/event_types|synthetic-key|owner@/.test(JSON.stringify(cfg)));
      for (const change of [{ JEMLIO_BOOKING_ENABLED: 'false' }, { JEMLIO_BOOKING_CONFIG: '{}' }, { NOVA_CAPTURE_SECRET: '' }, { JEMLIO_BOOKING_CONFIG: JSON.stringify({ example: { ...JSON.parse(env.JEMLIO_BOOKING_CONFIG).example, services: 'invalid' } }) }]) {
        const off = createBookingRuntime({ env: { ...env, ...change }, pool, captureStore: capture, getTenant: async () => tenant });
        assert.equal((await off.publicConfig('example')).enabled, false);
      }
    });
    await check('availability requires approved origin and server-selected service', async () => {
      assert.equal((await call('/api/booking/slots/example', { service: 'visit' }, null)).status, 403);
      assert.equal((await call('/api/booking/slots/example', { service: 'visit' }, 'https://evil.invalid')).status, 403);
      assert.equal((await call('/api/booking/slots/example', { service: 'quote' })).status, 400);
      assert.equal((await call('/api/booking/slots/example', { service: 'visit', eventType: 'evil' })).status, 400);
      assert.deepEqual((await call('/api/booking/slots/example', { service: 'visit' })).body.slots, [slot]);
    });
    await check('receipt access cannot cross tenants, origins, expiries or bypass confirmation', async () => {
      const row = await entry(); const body = await confirm(row);
      assert.equal((await call('/api/booking/confirm', { ...body, client: 'second' })).status, 403);
      assert.equal((await call('/api/booking/confirm', body, 'https://evil.invalid')).status, 403);
      assert.equal((await call('/api/booking/confirm', { ...body, confirmed: false })).status, 400);
      assert.equal((await call('/api/booking/confirm', { ...body, email: 'attacker@example.invalid' })).status, 400);
      const previous = clock; clock += 16 * 60000;
      assert.equal((await call('/api/booking/confirm', body)).status, 403); clock = previous;
      assert.equal(providerCalls, 0);
    });
    await pool.query('DELETE FROM nova_capture_rate_limits');
    await check('live capture hands off the same saved receipt and concurrent confirmation calls book once', async () => {
      const session = (await call('/api/capture/session', { client: 'example' })).body;
      const data = { client: 'example', token: session.token, submissionId: randomUUID(), name: 'Synthetic', email: 'nobody@example.invalid', service: 'visit', consent: true };
      const saved = (await call('/api/capture/requests', data)).body;
      assert.ok(saved.bookingAccess); assert.equal(saved.status, 'received');
      const again = (await call('/api/capture/requests', data)).body;
      assert.equal(again.receipt, saved.receipt);
      const body = { client: 'example', receipt: saved.receipt, access: saved.bookingAccess, slot, confirmed: true };
      const replies = await Promise.all(Array.from({ length: 5 }, () => call('/api/booking/confirm', body)));
      assert.ok(replies.every(r => r.status === 200)); assert.equal(providerCalls, 1);
      const status = await call('/api/booking/status', { client: body.client, receipt: body.receipt, access: body.access });
      assert.equal(status.body.status, 'confirmed'); assert.equal(status.body.providerId, undefined);
      assert.equal((await call('/api/booking/confirm', { ...body, slot: new Date(Date.parse(slot) + 60000).toISOString() })).status, 409);
    });
    await check('lost availability saves no booking and ambiguous provider response is never retried', async () => {
      const row = await entry(); const body = await confirm(row); available = [];
      const before = providerCalls;
      assert.equal((await call('/api/booking/confirm', body)).body.error, 'slot_unavailable'); assert.equal(providerCalls, before);
      available = [slot]; failure = 'booking_uncertain';
      assert.equal((await call('/api/booking/confirm', body)).body.status, 'needs_review');
      failure = undefined;
      assert.equal((await call('/api/booking/confirm', body)).body.status, 'needs_review'); assert.equal(providerCalls, before + 1);
    });
    await check('lost database acknowledgement preserves a durable attempt without rebooking', async () => {
      await pool.query('DELETE FROM nova_capture_rate_limits');
      const row = await entry(); const body = await confirm(row), before = providerCalls;
      const finish = runtime.store.finish.bind(runtime.store);
      runtime.store.finish = async () => { throw new Error('synthetic lost acknowledgement'); };
      assert.equal((await call('/api/booking/confirm', body)).status, 503);
      runtime.store.finish = finish;
      clock += 31000;
      assert.equal((await call('/api/booking/confirm', body)).body.status, 'needs_review');
      assert.equal(providerCalls, before + 1);
    });
    console.log(`Booking checks passed: ${checks}. No external booking or message sent.`);
  } finally { if (server) await new Promise(r => server.close(r)); await db.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
