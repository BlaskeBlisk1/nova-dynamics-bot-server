const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

class CaptureConflict extends Error {
  constructor() { super('submission_conflict'); this.code = 'submission_conflict'; }
}

function createMemoryStore({ now = Date.now, maxEntries = 1000, ttlMs = 24 * 60 * 60 * 1000 } = {}) {
  const rows = new Map();
  const rates = new Map();
  function cleanup() {
    for (const [key, row] of rows) if (now() - row.createdAt >= ttlMs) rows.delete(key);
  }
  return {
    durable: false,
    async create(input) {
      if (input.notification) throw new Error('preview_notification_forbidden');
      cleanup();
      const key = `${input.client}:${input.submissionId}`;
      const existing = rows.get(key);
      if (existing) {
        if (existing.payloadHash !== input.payloadHash) throw new CaptureConflict();
        return { receipt: existing.receipt, duplicate: true };
      }
      if (rows.size >= maxEntries) throw new Error('preview_store_full');
      rows.set(key, structuredClone(input));
      return { receipt: input.receipt, duplicate: false };
    },
    async consumeRateLimit(key, limit, windowMs, at = now()) {
      const bucket = Math.floor(at / windowMs);
      for (const [k, value] of rates) if (value.bucket !== bucket) rates.delete(k);
      const value = rates.get(key) || { bucket, count: 0 };
      value.count++;
      rates.set(key, value);
      return value.count <= limit;
    },
    async close() { rows.clear(); rates.clear(); }
  };
}

class PgStore {
  constructor({ pool, connectionString, ssl, max = 5 } = {}) {
    this.durable = true;
    this.ownsPool = !pool;
    this.pool = pool || new (require('pg').Pool)({ connectionString, ssl, max });
  }
  async initialize() {
    await this.pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  }
  async create(input) {
    const db = await this.pool.connect();
    try {
      await db.query('BEGIN');
      const result = await db.query(
        `INSERT INTO nova_capture_requests (id,client,submission_id,payload_hash,data,created_at)
         VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (client,submission_id) DO NOTHING RETURNING id`,
        [input.receipt, input.client, input.submissionId, input.payloadHash, JSON.stringify(input.data), new Date(input.createdAt)]
      );
      if (!result.rows.length) {
        const existing = (await db.query(
          'SELECT id,payload_hash FROM nova_capture_requests WHERE client=$1 AND submission_id=$2',
          [input.client, input.submissionId]
        )).rows[0];
        if (!existing || existing.payload_hash !== input.payloadHash) throw new CaptureConflict();
        await db.query('COMMIT');
        return { receipt: existing.id, duplicate: true };
      }
      if (!input.notification) throw new Error('live_notification_required');
      await db.query(
        `INSERT INTO nova_capture_outbox (request_id,notification,next_attempt_at,updated_at) VALUES ($1,$2,$3,$3)`,
        [input.receipt, JSON.stringify(input.notification), new Date(input.createdAt)]
      );
      await db.query('COMMIT');
      return { receipt: input.receipt, duplicate: false };
    } catch (error) {
      await db.query('ROLLBACK').catch(() => {});
      throw error;
    } finally { db.release(); }
  }
  async consumeRateLimit(key, limit, windowMs, at = Date.now()) {
    const bucket = Math.floor(at / windowMs);
    const result = await this.pool.query(
      `INSERT INTO nova_capture_rate_limits (key,bucket,count) VALUES ($1,$2,1)
       ON CONFLICT (key) DO UPDATE SET bucket=EXCLUDED.bucket,
         count=CASE WHEN nova_capture_rate_limits.bucket=EXCLUDED.bucket THEN nova_capture_rate_limits.count+1 ELSE 1 END
       RETURNING count`, [key, bucket]
    );
    return result.rows[0].count <= limit;
  }
  async claimNext(at = Date.now(), leaseMs = 60_000) {
    const token = crypto.randomUUID();
    const result = await this.pool.query(
      `WITH next AS (
        SELECT request_id FROM nova_capture_outbox
        WHERE status IN ('pending','sending') AND next_attempt_at <= $1
          AND (locked_until IS NULL OR locked_until <= $1)
        ORDER BY next_attempt_at FOR UPDATE SKIP LOCKED LIMIT 1
       )
       UPDATE nova_capture_outbox o SET status='sending',lock_token=$2,locked_until=$3,
         first_attempt_at=COALESCE(first_attempt_at,$1),attempts=attempts+1,updated_at=$1
       FROM next WHERE o.request_id=next.request_id
       RETURNING o.*, (SELECT client FROM nova_capture_requests r WHERE r.id=o.request_id) AS client`, [new Date(at), token, new Date(at + leaseMs)]
    );
    return result.rows[0] || null;
  }
  async finish(claim, { status, providerId = null, errorCode = null, nextAttemptAt, at = Date.now() }) {
    const result = await this.pool.query(
      `UPDATE nova_capture_outbox SET status=$3,provider_id=$4,error_code=$5,
        next_attempt_at=$6,locked_until=NULL,lock_token=NULL,updated_at=$7
       WHERE request_id=$1 AND lock_token=$2 RETURNING request_id`,
      [claim.request_id, claim.lock_token, status, providerId, errorCode, new Date(nextAttemptAt || at), new Date(at)]
    );
    return result.rows.length === 1;
  }
  async close() { if (this.ownsPool) await this.pool.end(); }
}

module.exports = { createMemoryStore, PgStore, CaptureConflict };
