'use strict';

const { randomUUID } = require('node:crypto');

const OUTCOMES = Object.freeze(['new', 'contacted', 'qualified', 'won', 'lost']);
const DELIVERY_STATUSES = Object.freeze(['pending', 'sending', 'accepted', 'needs_review', 'failed', 'missing', 'not_requested']);
const CRM_STATUSES = Object.freeze(['pending', 'sending', 'synced', 'needs_review', 'not_requested']);
const CLIENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
// Only definitive provider acceptance or a definite permanent rejection may be
// pruned. In-flight, revoked, expired/uncertain and payload-conflict records need
// reconciliation. This tool never resets a provider key or queues a new email.
const DELETABLE = `(o.locked_until IS NULL AND o.lock_token IS NULL AND (
  (o.status='accepted' AND o.provider_id IS NOT NULL AND o.provider_id<>'') OR
  (o.status='failed' AND o.error_code ~ '^provider_(400|401|403|404|405|406|413|415|422)$')
)) AND NOT EXISTS (
  SELECT 1 FROM nova_capture_crm_outbox c WHERE c.request_id=r.id AND
    (c.status<>'synced' OR c.record_id IS NULL OR c.record_id !~ '^rec[a-zA-Z0-9]{14}$'
      OR c.locked_until IS NOT NULL OR c.lock_token IS NOT NULL)
)`;
// This marker is written only by authenticated workspace intake, never visitor input.
// No dispatch row is created for a manual enquiry; unknown missing rows stay protected.
const MANUAL_DELETABLE = `(r.data->>'entryMode'='workspace_manual_v1'
  AND NOT EXISTS(SELECT 1 FROM nova_capture_outbox mo WHERE mo.request_id=r.id)
  AND NOT EXISTS(SELECT 1 FROM nova_capture_crm_outbox mc WHERE mc.request_id=r.id))`;

function invalid(code) { return Object.assign(new Error(code), { code }); }
function validateClient(client) {
  if (typeof client !== 'string' || !CLIENT_RE.test(client)) throw invalid('invalid_client');
}
function validateReceipt(receipt) {
  if (typeof receipt !== 'string' || !UUID_RE.test(receipt)) throw invalid('invalid_receipt');
}
function parseDate(value, name) {
  if (value === undefined) return undefined;
  // UTC dates or timestamps with an explicit timezone prevent local ambiguity.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value)) {
    throw invalid(`invalid_${name}`);
  }
  const result = new Date(value);
  const calendarDay = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(result.getTime()) || !Number.isFinite(calendarDay.getTime()) ||
      calendarDay.toISOString().slice(0, 10) !== value.slice(0, 10) ||
      value.length > 10 && (Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59)) {
    throw invalid(`invalid_${name}`);
  }
  return result;
}
const counts = values => Object.fromEntries(values.map(value => [value, 0]));

class CaptureOperations {
  constructor({ pool, now = Date.now } = {}) {
    if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') throw invalid('operator_database_required');
    this.pool = pool;
    this.now = now;
  }

  async setOutcome({ client, receipt, outcome, apply = false }) {
    validateClient(client); validateReceipt(receipt);
    if (!OUTCOMES.includes(outcome)) throw invalid('invalid_outcome');
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const found = await db.query(`SELECT r.id, COALESCE(s.outcome,'new') AS outcome
        FROM nova_capture_requests r LEFT JOIN nova_capture_outcomes s ON s.request_id=r.id
        WHERE r.client=$1 AND r.id=$2 FOR UPDATE OF r`, [client, receipt]);
      if (!found.rows.length) throw invalid('request_not_found');
      const previous = found.rows[0].outcome;
      const changed = previous !== outcome;
      if (apply === true && changed) {
        const at = new Date(this.now());
        await db.query(`INSERT INTO nova_capture_outcomes (request_id,outcome,updated_at) VALUES ($1,$2,$3)
          ON CONFLICT (request_id) DO UPDATE SET outcome=EXCLUDED.outcome,updated_at=EXCLUDED.updated_at`, [receipt, outcome, at]);
        await db.query(`INSERT INTO nova_capture_outcome_events (id,request_id,outcome,recorded_at) VALUES ($1,$2,$3,$4)`,
          [randomUUID(), receipt, outcome, at]);
      }
      await db.query('COMMIT');
      return { client, receipt, previous, outcome, wouldChange: changed, changed: apply === true && changed, dryRun: apply !== true };
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { db.release(); }
  }

  async report({ client, since, before } = {}) {
    validateClient(client);
    const start = parseDate(since, 'since');
    const end = parseDate(before, 'before');
    if (start && end && start >= end) throw invalid('invalid_date_range');
    // A single query gives all counts the same database snapshot. Date filters
    // define the enquiry-created cohort; historical outcomes are not inferred.
    const result = await this.pool.query(`WITH cohort AS (
      SELECT r.id, COALESCE(s.outcome,'new') AS outcome, COALESCE(o.status,CASE WHEN r.data->>'entryMode'='workspace_manual_v1' THEN 'not_requested' ELSE 'missing' END) AS delivery,
        COALESCE(c.status,'not_requested') AS crm
      FROM nova_capture_requests r LEFT JOIN nova_capture_outcomes s ON s.request_id=r.id
      LEFT JOIN nova_capture_outbox o ON o.request_id=r.id
      LEFT JOIN nova_capture_crm_outbox c ON c.request_id=r.id
      WHERE r.client=$1 AND ($2::timestamptz IS NULL OR r.created_at >= $2)
        AND ($3::timestamptz IS NULL OR r.created_at < $3)
    )
    SELECT 'current' AS kind, outcome AS status, count(*)::integer AS count FROM cohort GROUP BY outcome
    UNION ALL SELECT 'notification', delivery, count(*)::integer FROM cohort GROUP BY delivery
    UNION ALL SELECT 'crm', crm, count(*)::integer FROM cohort GROUP BY crm
    UNION ALL SELECT 'recorded', e.outcome, count(DISTINCT e.request_id)::integer
      FROM nova_capture_outcome_events e JOIN cohort c ON c.id=e.request_id GROUP BY e.outcome`,
    [client, start || null, end || null]);
    const currentOutcomes = counts(OUTCOMES);
    const recordedOutcomes = counts(OUTCOMES);
    const notifications = counts(DELIVERY_STATUSES);
    const crm = counts(CRM_STATUSES);
    for (const row of result.rows) {
      const group = { current: currentOutcomes, recorded: recordedOutcomes, notification: notifications, crm }[row.kind];
      if (Object.hasOwn(group, row.status)) group[row.status] = Number(row.count);
    }
    return { client, cohort: { since: start?.toISOString() || null, before: end?.toISOString() || null },
      requests: Object.values(currentOutcomes).reduce((sum, n) => sum + n, 0), currentOutcomes, recordedOutcomes, notifications, crm,
      note: 'Outcomes are operator-recorded. Recorded counts can overlap and do not imply skipped stages. Accepted means provider acceptance, not delivery. Deleted enquiries are absent.' };
  }

  async deleteRequests({ client, receipt, before, limit = 100, apply = false } = {}) {
    validateClient(client);
    if (receipt !== undefined) validateReceipt(receipt);
    const end = parseDate(before, 'before');
    if (!receipt && !end) throw invalid('deletion_scope_required');
    if (end && end.getTime() > this.now()) throw invalid('future_deletion_cutoff');
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw invalid('invalid_limit');
    const args = [client, receipt || null, end || null];
    const scoped = `r.client=$1 AND ($2::uuid IS NULL OR r.id=$2)
      AND ($3::timestamptz IS NULL OR r.created_at < $3)`;
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      // Booking migration is optional. Active/uncertain appointments are protected.
      const bookingSchema = (await db.query("SELECT to_regclass('public.jemlio_bookings') IS NOT NULL AS present")).rows[0].present;
      const bookingGuard = bookingSchema ? ` AND NOT EXISTS (
        SELECT 1 FROM jemlio_bookings b WHERE b.request_id=r.id AND b.status IN ('attempting','needs_review','confirmed')
      )` : '';
      const deletable = `(${DELETABLE} OR ${MANUAL_DELETABLE})` + bookingGuard;
      const summary = (await db.query(`SELECT count(*)::integer AS matched,
        count(*) FILTER (WHERE ${deletable})::integer AS eligible
        FROM nova_capture_requests r LEFT JOIN nova_capture_outbox o ON o.request_id=r.id WHERE ${scoped}`, args)).rows[0];
      let deleted = 0;
      if (apply === true) {
        // Lock both records before deleting. A worker cannot change a selected
        // dispatch row between this guard and the cascading request deletion.
        let selected = await db.query(`SELECT r.id FROM nova_capture_requests r
          JOIN nova_capture_outbox o ON o.request_id=r.id WHERE ${scoped} AND ${deletable}
          ORDER BY r.created_at,r.id LIMIT $4 FOR UPDATE OF r,o`, [...args, limit]);
        if(selected.rows.length<limit){
          const manual=await db.query(`SELECT r.id FROM nova_capture_requests r WHERE ${scoped} AND ${MANUAL_DELETABLE}${bookingGuard}
            ORDER BY r.created_at,r.id LIMIT $4 FOR UPDATE OF r`,[...args,limit-selected.rows.length]);
          selected.rows.push(...manual.rows);
        }
        // A booking claim may have held the parent lock when the SELECT began.
        // Recheck in a fresh statement after acquiring it; joined-table inserts
        // committed during a lock wait are absent from the earlier snapshot.
        if (bookingSchema && selected.rows.length) selected = await db.query(`SELECT r.id FROM nova_capture_requests r
          LEFT JOIN nova_capture_outbox o ON o.request_id=r.id WHERE r.client=$1 AND r.id=ANY($2::uuid[]) AND ${deletable}`,
        [client, selected.rows.map(row => row.id)]);
        if (selected.rows.length) {
          await db.query(`INSERT INTO nova_capture_submission_tombstones (client,submission_id,deleted_at)
            SELECT client,submission_id,$3 FROM nova_capture_requests WHERE client=$1 AND id=ANY($2::uuid[])
            ON CONFLICT (client,submission_id) DO NOTHING`,
            [client, selected.rows.map(row => row.id), new Date(this.now())]);
          const removed = await db.query('DELETE FROM nova_capture_requests WHERE client=$1 AND id=ANY($2::uuid[]) RETURNING id',
            [client, selected.rows.map(row => row.id)]);
          deleted = removed.rows.length;
        }
      }
      await db.query('COMMIT');
      return { client, receipt: receipt || null, before: end?.toISOString() || null, limit, dryRun: apply !== true,
        matchedRequests: Number(summary.matched), eligibleRequests: Number(summary.eligible),
        protectedRequests: Number(summary.matched) - Number(summary.eligible),
        wouldDelete: Math.min(Number(summary.eligible), limit), deletedRequests: deleted,
        note: 'Pending, in-flight, missing and uncertain email or CRM records, and active or uncertain bookings, remain protected. Authenticated manual enquiries with no dispatch records are eligible. Deletion removes stored contact details, outbox payloads, booking details and outcome history, while retaining an opaque submission ID to block duplicate retries. External provider and mailbox copies need separate handling.' };
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { db.release(); }
  }
}

module.exports = { CaptureOperations, OUTCOMES, DELIVERY_STATUSES, CRM_STATUSES };
