'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { problem } = require('./calendly');
const CLIENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function scope(client, receipt) {
  if (typeof client !== 'string' || !CLIENT.test(client) ||
      (receipt !== undefined && (typeof receipt !== 'string' || !UUID.test(receipt)))) throw problem('invalid_scope');
}
function iso(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(value) ||
      !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 19) !== value.slice(0, 19)) throw problem('invalid_date');
  return new Date(value).toISOString();
}
function publicBooking(row, now = Date.now()) {
  if (!row) return { status: 'not_booked' };
  const status = row.status === 'attempting' && now - new Date(row.created_at).getTime() >= 30000 ? 'needs_review' : row.status;
  return { status, slot: new Date(row.slot).toISOString(),
    ...(['confirmed', 'completed'].includes(status) ? { cancelUrl: row.cancel_url || null, rescheduleUrl: row.reschedule_url || null } : {}) };
}
class BookingStore {
  constructor({ pool, now = Date.now }) { this.pool = pool; this.now = now; }
  async transaction(fn) {
    const db = await this.pool.connect();
    try { await db.query('BEGIN'); const result = await fn(db); await db.query('COMMIT'); return result; }
    catch (error) { await db.query('ROLLBACK').catch(() => {}); throw error; }
    finally { db.release(); }
  }
  async enquiry(client, receipt, db = this.pool, lock = false) {
    scope(client, receipt);
    // Acquire the parent lock before reading joined outcome rows. A statement
    // snapshot taken while waiting on this lock could otherwise miss a new win.
    if (lock) await db.query('SELECT id FROM nova_capture_requests WHERE client=$1 AND id=$2 FOR UPDATE', [client, receipt]);
    const row = (await db.query(`SELECT r.*, COALESCE(o.outcome,'new') AS outcome FROM nova_capture_requests r
      LEFT JOIN nova_capture_outcomes o ON o.request_id=r.id WHERE r.client=$1 AND r.id=$2`,
    [client, receipt])).rows[0];
    if (!row) throw problem('request_not_found');
    return row;
  }
  async read(client, receipt) {
    scope(client, receipt);
    return (await this.pool.query(`SELECT b.* FROM jemlio_bookings b JOIN nova_capture_requests r ON r.id=b.request_id
      WHERE r.client=$1 AND r.id=$2`, [client, receipt])).rows[0] || null;
  }
  async claim({ client, receipt, eventType, slot }) {
    scope(client, receipt); slot = iso(slot);
    const hash = createHash('sha256').update(JSON.stringify({ eventType, slot })).digest('hex');
    return this.transaction(async db => {
      const request = await this.enquiry(client, receipt, db, true);
      if (['won', 'lost'].includes(request.outcome)) throw problem('request_closed');
      const existing = (await db.query('SELECT * FROM jemlio_bookings WHERE request_id=$1', [receipt])).rows[0];
      if (existing) {
        if (existing.payload_hash !== hash) throw problem('booking_conflict');
        return { claimed: false, row: existing };
      }
      const row = (await db.query(`INSERT INTO jemlio_bookings
        (request_id,attempt_id,payload_hash,event_type,slot,status,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,'attempting',$6,$6) RETURNING *`,
      [receipt, randomUUID(), hash, eventType, slot, new Date(this.now())])).rows[0];
      return { claimed: true, row, data: request.data };
    });
  }
  async finish(claim, result) {
    if (!['confirmed', 'rejected', 'needs_review'].includes(result.status)) throw problem('invalid_booking_status');
    const r = await this.pool.query(`UPDATE jemlio_bookings SET status=$3,provider_id=$4,cancel_url=$5,
      reschedule_url=$6,error_code=$7,updated_at=$8 WHERE request_id=$1 AND attempt_id=$2 AND status='attempting' RETURNING *`,
    [claim.request_id, claim.attempt_id, result.status, result.providerId || null, result.cancelUrl || null,
      result.rescheduleUrl || null, result.errorCode || null, new Date(this.now())]);
    if (!r.rows.length) throw problem('booking_state_changed');
    return r.rows[0];
  }
  async schedule({ client, receipt, due, action = 'callback', apply = false }) {
    scope(client, receipt);
    if (!['callback', 'review', 'reconcile', 'done'].includes(action)) throw problem('invalid_action');
    if (action !== 'done') due = iso(due);
    return this.transaction(async db => {
      const r = await this.enquiry(client, receipt, db, true);
      if (action !== 'done' && ['won', 'lost'].includes(r.outcome)) throw problem('request_closed');
      if (apply) {
        await db.query(`INSERT INTO jemlio_followups(request_id,due_at,action,updated_at) VALUES ($1,$2,$3,$4)
          ON CONFLICT(request_id) DO UPDATE SET due_at=EXCLUDED.due_at,action=EXCLUDED.action,updated_at=EXCLUDED.updated_at`,
        [receipt, action === 'done' ? null : due, action, new Date(this.now())]);
        await this.audit(db, receipt, `followup_${action}`);
      }
      return { client, receipt, due: action === 'done' ? null : due, action, dryRun: !apply, sendsMessages: false };
    });
  }
  async audit(db, receipt, action) {
    await db.query('INSERT INTO jemlio_workflow_events(id,request_id,action,recorded_at) VALUES ($1,$2,$3,$4)',
      [randomUUID(), receipt, action, new Date(this.now())]);
  }
  async record({ client, receipt, status, amountOre, apply = false }) {
    scope(client, receipt);
    if (!['completed', 'cancelled', 'no_show', 'sale'].includes(status)) throw problem('invalid_result');
    if (status === 'sale' && (!Number.isSafeInteger(amountOre) || amountOre < 0 || amountOre > 10000000000)) throw problem('invalid_amount');
    return this.transaction(async db => {
      const enquiry = await this.enquiry(client, receipt, db, true);
      const row = (await db.query('SELECT * FROM jemlio_bookings WHERE request_id=$1', [receipt])).rows[0];
      if (status === 'sale') {
        if (enquiry.outcome !== 'won') throw problem('verified_win_required');
        if (apply) await db.query(`INSERT INTO jemlio_recorded_sales(request_id,amount_ore,recorded_at) VALUES ($1,$2,$3)
          ON CONFLICT(request_id) DO UPDATE SET amount_ore=EXCLUDED.amount_ore,recorded_at=EXCLUDED.recorded_at`,
        [receipt, amountOre, new Date(this.now())]);
      } else {
        if (!row || !['confirmed', status].includes(row.status)) throw problem('confirmed_booking_required');
        if (status !== 'cancelled' && Date.parse(row.slot) > this.now()) throw problem('appointment_not_started');
        if (apply) await db.query('UPDATE jemlio_bookings SET status=$2,updated_at=$3 WHERE request_id=$1',
          [receipt, status, new Date(this.now())]);
      }
      if (apply) await this.audit(db, receipt, status);
      return { client, receipt, status, ...(status === 'sale' ? { amountOre, currency: 'NOK' } : {}), dryRun: !apply,
        note: 'Records an independently verified fact. Does not cancel a provider appointment, charge money or send messages.' };
    });
  }
  async reconcile({ client, receipt, providerId, provider, apply = false }) {
    const row = await this.read(client, receipt);
    if (!row || !['attempting', 'needs_review', 'confirmed'].includes(row.status)) throw problem('reconciliation_not_allowed');
    const enquiry = await this.enquiry(client, receipt);
    const result = await provider.verify({ providerId: providerId || row.provider_id,
      eventType: row.event_type, slot: new Date(row.slot).toISOString(), email: enquiry.data.email });
    return this.transaction(async db => {
      await this.enquiry(client, receipt, db, true);
      if (apply) {
        const changed = await db.query(`UPDATE jemlio_bookings SET status=$3,provider_id=$4,cancel_url=$5,reschedule_url=$6,
          error_code=NULL,updated_at=$7 WHERE request_id=$1 AND attempt_id=$2 AND status=$8 AND updated_at=$9 AND provider_id IS NOT DISTINCT FROM $10 AND slot=$11 RETURNING request_id`,
        [receipt, row.attempt_id, result.status, result.providerId, result.cancelUrl, result.rescheduleUrl,
          new Date(this.now()), row.status, row.updated_at, row.provider_id, row.slot]);
        if (!changed.rows.length) throw problem('booking_state_changed');
        await this.audit(db, receipt, `reconciled_${result.status}`);
      }
      return { client, receipt, status: result.status, dryRun: !apply };
    });
  }
  async due({ client, hours = 24, limit = 100 }) {
    scope(client);
    if (!Number.isInteger(hours) || hours < 1 || hours > 168 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw problem('invalid_queue_scope');
    const r = await this.pool.query(`WITH queue AS (
      SELECT r.id AS receipt, r.data->>'service' AS service, COALESCE(o.outcome,'new') AS outcome,
        CASE WHEN b.status='needs_review' OR (b.status='attempting' AND b.created_at <= $2::timestamptz - interval '30 seconds')
          THEN 'reconcile' ELSE COALESCE(f.action,'callback') END AS action,
        CASE WHEN b.status='needs_review' OR (b.status='attempting' AND b.created_at <= $2::timestamptz - interval '30 seconds')
          THEN b.updated_at ELSE COALESCE(f.due_at,r.created_at + ($3::integer * interval '1 hour')) END AS due_at
      FROM nova_capture_requests r LEFT JOIN nova_capture_outcomes o ON o.request_id=r.id
      LEFT JOIN jemlio_bookings b ON b.request_id=r.id LEFT JOIN jemlio_followups f ON f.request_id=r.id
      WHERE r.client=$1 AND (
        b.status='needs_review' OR (b.status='attempting' AND b.created_at <= $2::timestamptz - interval '30 seconds') OR
        (COALESCE(o.outcome,'new') NOT IN ('won','lost') AND COALESCE(b.status,'not_booked') NOT IN ('confirmed','completed','attempting') AND
        ((f.action IS NOT NULL AND f.action <> 'done') OR (f.action IS NULL AND COALESCE(o.outcome,'new')='new'))))
    ) SELECT * FROM queue WHERE due_at <= $2 ORDER BY due_at,receipt LIMIT $4`,
    [client, new Date(this.now()), hours, limit]);
    return { client, due: r.rows, limit, sendsMessages: false,
      note: 'Staff work queue. Uncertain bookings always need reconciliation, even for a closed lead. No contact details are included.' };
  }
  async report({ client, since, before }) {
    scope(client);
    if (since !== undefined) since = iso(since);
    if (before !== undefined) before = iso(before);
    if (since && before && since >= before) throw problem('invalid_date_range');
    const { rows } = await this.pool.query(`SELECT count(*)::int AS enquiries,
      count(*) FILTER (WHERE o.outcome='qualified')::int AS qualified,
      count(*) FILTER (WHERE b.provider_id IS NOT NULL AND b.status IN ('confirmed','completed','cancelled','no_show'))::int AS bookings_recorded,
      count(*) FILTER (WHERE b.status='confirmed')::int AS confirmed,
      count(*) FILTER (WHERE b.status='confirmed' AND b.slot >= $4::timestamptz)::int AS upcoming,
      count(*) FILTER (WHERE b.calendar_state IN ('pending','attention'))::int AS calendar_attention,
      count(*) FILTER (WHERE b.status='completed')::int AS completed,
      count(*) FILTER (WHERE b.status='cancelled')::int AS cancelled,
      count(*) FILTER (WHERE b.status='no_show')::int AS no_show,
      count(*) FILTER (WHERE b.status='needs_review' OR (b.status='attempting' AND b.created_at <= $4::timestamptz - interval '30 seconds'))::int AS needs_review,
      count(*) FILTER (WHERE o.outcome='won')::int AS won,
      count(*) FILTER (WHERE o.outcome='won' AND s.request_id IS NOT NULL)::int AS valued_sales,
      COALESCE(sum(s.amount_ore) FILTER (WHERE o.outcome='won'),0)::text AS sales_ore
      FROM nova_capture_requests r LEFT JOIN nova_capture_outcomes o ON o.request_id=r.id
      LEFT JOIN jemlio_bookings b ON b.request_id=r.id LEFT JOIN jemlio_recorded_sales s ON s.request_id=r.id
      WHERE r.client=$1 AND ($2::timestamptz IS NULL OR r.created_at >= $2) AND ($3::timestamptz IS NULL OR r.created_at < $3)`,
    [client, since || null, before || null, new Date(this.now())]);
    return { client, cohort: { since: since || null, before: before || null }, ...rows[0], currency: 'NOK',
      note: 'Enquiry-created cohort. Booking states are last verified; sales are operator-recorded values, not payments, profit or proven incremental revenue. Qualified is a current stage. Deleted records are excluded.' };
  }
}
module.exports = { BookingStore, publicBooking, scope, iso, CLIENT, UUID };
