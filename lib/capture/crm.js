'use strict';

const { randomUUID } = require('node:crypto');

const RETRY_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FIELD_NAMES = new Set(['Enquiry', 'Source', 'Received', 'Name', 'Email', 'Phone', 'Business', 'Service', 'Preferred contact', 'Consent', 'Receipt']);
const WEBSITE_FIELDS = new Set([...FIELD_NAMES, 'Website', 'Industry', 'Visitor message']);

function validDestination(value) {
  return Boolean(value && !Array.isArray(value) && typeof value.baseId === 'string' && typeof value.tableId === 'string' &&
    /^app[a-zA-Z0-9]{14}$/.test(value.baseId) && /^tbl[a-zA-Z0-9]{14}$/.test(value.tableId) &&
    Object.keys(value).every(k => ['baseId', 'tableId'].includes(k)));
}

function createCrmPayload({ destination, receipt, name, service, data, createdAt }) {
  if (!validDestination(destination) || !UUID_RE.test(receipt) || data.consent !== true) throw new Error('crm_payload_invalid');
  return { destination: { ...destination }, fields: {
    Enquiry: `${name} – ${data.name}`, Source: 'Chatbot capture', Received: new Date(createdAt).toISOString(),
    Name: data.name, Business: name, Service: service, Consent: true, Receipt: receipt,
    ...(data.email ? { Email: data.email } : {}), ...(data.phone ? { Phone: data.phone } : {}),
    ...(data.preferredTime ? { 'Preferred contact': data.preferredTime } : {})
  } };
}

function validPayload(payload) {
  const fields = payload?.fields;
  const website = fields?.Source === 'Jemlio website';
  return validDestination(payload?.destination) && fields && !Array.isArray(fields) &&
    Object.keys(payload).every(k => ['destination', 'fields'].includes(k)) &&
    Object.keys(fields).every(k => (website ? WEBSITE_FIELDS : FIELD_NAMES).has(k)) && UUID_RE.test(fields.Receipt || '') &&
    fields.Consent === true && (website || fields.Source === 'Chatbot capture') &&
    ['Enquiry', 'Received', 'Name', 'Business', 'Service'].every(k => typeof fields[k] === 'string' && fields[k].length > 0) &&
    Object.entries(fields).every(([k, v]) => k === 'Consent' || typeof v === 'string' &&
      v.length <= (k === 'Visitor message' ? 1000 : k === 'Website' ? 4096 : 500));
}

// No provider access on import. Only a fixed HTTPS API and server-approved IDs
// are allowed. PATCH omits Status and Notes so retries preserve staff follow-up.
function createAirtableWriter({ apiKey, fetchFn = global.fetch, timeoutMs = 10_000 } = {}) {
  if (!apiKey || typeof fetchFn !== 'function') throw new Error('crm_not_configured');
  return async function writeCrm({ payload }) {
    if (!validPayload(payload)) throw Object.assign(new Error('crm_payload_invalid'), { code: 'crm_payload_invalid', retryable: false });
    const { baseId, tableId } = payload.destination;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchFn(`https://api.airtable.com/v0/${baseId}/${tableId}`, {
        method: 'PATCH', redirect: 'error', signal: controller.signal,
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ performUpsert: { fieldsToMergeOn: ['Receipt'] }, records: [{ fields: payload.fields }], typecast: false })
      });
      const body = await response.json().catch(() => ({}));
      const record = body?.records?.length === 1 ? body.records[0] : null;
      if (response.ok && /^rec[a-zA-Z0-9]{14}$/.test(record?.id || '') &&
          Object.entries(payload.fields).every(([k, v]) => record.fields?.[k] === v)) return { recordId: record.id };
      const error = new Error('crm_provider_error');
      error.code = response.ok ? 'crm_response_uncertain' : `crm_provider_${Number(response.status) || 'unknown'}`;
      error.retryable = response.ok || response.status === 408 || response.status === 429 || response.status >= 500;
      const retryAfter = Number(response.headers?.get('retry-after'));
      if (Number.isFinite(retryAfter) && retryAfter > 0) error.retryAfterMs = Math.min(retryAfter * 1000, 60 * 60 * 1000);
      throw error;
    } catch (error) {
      if (error.retryable !== undefined) throw error;
      throw Object.assign(new Error('crm_network_uncertain'), { code: 'crm_network_uncertain', retryable: true });
    } finally { clearTimeout(timeout); }
  };
}

class CrmOutbox {
  constructor({ pool, claimClient = null, excludeClient = null }) {
    for (const value of [claimClient, excludeClient]) {
      if (value !== null && (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value))) throw new Error('invalid_claim_scope');
    }
    this.pool = pool; this.durable = true;
    this.claimClient = claimClient; this.excludeClient = excludeClient;
  }
  async claimNext(at = Date.now(), leaseMs = 60_000) {
    const result = await this.pool.query(`WITH next AS (
      SELECT request_id FROM nova_capture_crm_outbox
      WHERE status IN ('pending','sending') AND next_attempt_at <= $1
        AND (locked_until IS NULL OR locked_until <= $1)
        AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM nova_capture_requests r WHERE r.id=request_id AND r.client=$4))
        AND ($5::text IS NULL OR NOT EXISTS (SELECT 1 FROM nova_capture_requests r WHERE r.id=request_id AND r.client=$5))
      ORDER BY next_attempt_at,request_id FOR UPDATE SKIP LOCKED LIMIT 1
    ) UPDATE nova_capture_crm_outbox o SET status='sending',lock_token=$2,locked_until=$3,
      first_attempt_at=COALESCE(first_attempt_at,$1),attempts=attempts+1,updated_at=$1
      FROM next WHERE o.request_id=next.request_id
      RETURNING o.*, (SELECT client FROM nova_capture_requests r WHERE r.id=o.request_id) AS client`,
    [new Date(at), randomUUID(), new Date(at + leaseMs), this.claimClient, this.excludeClient]);
    return result.rows[0] || null;
  }
  async finish(claim, { status, recordId = null, errorCode = null, nextAttemptAt, at = Date.now() }) {
    const result = await this.pool.query(`UPDATE nova_capture_crm_outbox SET status=$3,record_id=$4,error_code=$5,
      next_attempt_at=$6,locked_until=NULL,lock_token=NULL,updated_at=$7
      WHERE request_id=$1 AND lock_token=$2 RETURNING request_id`,
    [claim.request_id, claim.lock_token, status, recordId, errorCode, new Date(nextAttemptAt || at), new Date(at)]);
    return result.rows.length === 1;
  }
}

async function flushCrm({ store, writeCrm, isTenantEnabled, now = Date.now, limit = 1 } = {}) {
  if (!store?.durable || typeof writeCrm !== 'function' || typeof isTenantEnabled !== 'function') throw new Error('durable_crm_not_configured');
  const results = [];
  for (let n = 0; n < Math.min(Math.max(limit, 0), 10); n++) {
    const claim = await store.claimNext(now());
    if (!claim) break;
    const finish = async (details) => {
      const saved = await store.finish(claim, { ...details, at: now() });
      results.push({ receipt: claim.request_id, status: saved ? details.status : 'claim_lost' });
    };
    if (!validPayload(claim.payload) || claim.payload.fields.Receipt !== claim.request_id) {
      await finish({ status: 'needs_review', errorCode: 'crm_payload_invalid' }); continue;
    }
    if (!await isTenantEnabled(claim.client, claim.payload.destination)) {
      await finish({ status: 'needs_review', errorCode: 'tenant_disabled' }); continue;
    }
    const first = new Date(claim.first_attempt_at).getTime();
    if (!Number.isFinite(first) || now() - first >= RETRY_WINDOW_MS) {
      await finish({ status: 'needs_review', errorCode: 'retry_window_expired' }); continue;
    }
    let result;
    try {
      result = await writeCrm({ payload: claim.payload });
      if (!/^rec[a-zA-Z0-9]{14}$/.test(result?.recordId || '')) {
        throw Object.assign(new Error('crm_response_uncertain'), { code: 'crm_response_uncertain', retryable: true });
      }
    } catch (error) {
      const next = now() + Math.max(30_000, Math.min(60 * 60 * 1000,
        Math.max(30_000 * 2 ** Math.min(claim.attempts - 1, 7), Number(error.retryAfterMs) || 0)));
      // A permanent failure after an uncertain attempt still requires external
      // reconciliation; the earlier attempt may have created an Airtable copy.
      const status = error.retryable === false ? 'needs_review' : next - first >= RETRY_WINDOW_MS ? 'needs_review' : 'pending';
      const code = /^(crm_provider_\d{3}|crm_network_uncertain|crm_response_uncertain|crm_payload_invalid)$/.test(error.code || '')
        ? error.code : 'crm_delivery_uncertain';
      await finish({ status, errorCode: code, nextAttemptAt: next }); continue;
    }
    // If saving confirmation fails, a later attempt uses the same Receipt and
    // immutable fields. Never generate a replacement receipt or reset sales status.
    await finish({ status: 'synced', recordId: result.recordId });
  }
  return results;
}

module.exports = { createCrmPayload, validDestination, validPayload, createAirtableWriter, CrmOutbox, flushCrm, RETRY_WINDOW_MS };
