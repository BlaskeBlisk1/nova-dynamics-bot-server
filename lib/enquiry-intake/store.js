'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { BookingStore, scope } = require('../booking/store');
const MODE = 'external_form_v1';
const fail = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(value).digest('hex');

function submissionIdFor(source, providerId) {
  const bytes = createHash('sha256').update(JSON.stringify(['jemlio-external-netlify-v1', source.siteId, source.formId, providerId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

class IntakeStore extends BookingStore {
  constructor(options) { super(options); this.durable = true; }
  async ready() {
    const result = await this.pool.query(`SELECT
      to_regclass('public.nova_capture_requests') IS NOT NULL AND
      to_regclass('public.nova_capture_submission_tombstones') IS NOT NULL AND
      to_regclass('public.jemlio_followups') IS NOT NULL AND
      to_regclass('public.jemlio_workspace_audit') IS NOT NULL AND
      to_regclass('public.jemlio_enquiry_intake_sources') IS NOT NULL AS ready`);
    return result.rows[0]?.ready === true;
  }
  async create(source, submission) {
    scope(source.client);
    const data = { entryMode: MODE, source: 'external_form', name: submission.name, email: submission.email,
      phone: submission.phone, service: submission.service, message: submission.message,
      intake: { provider: 'netlify', sourceId: source.id, formId: source.formId, siteId: source.siteId,
        providerId: submission.providerId, sourceCreatedAt: submission.sourceCreatedAt,
        reviewNeeded: submission.reviewReasons.length > 0, reviewReasons: [...submission.reviewReasons] } };
    const digest = hash(JSON.stringify(data)), submissionId = submissionIdFor(source, submission.providerId);
    const sourceHash = hash(source.id), providerHash = hash(JSON.stringify(['netlify', source.siteId, source.formId]));
    return this.transaction(async db => {
      const at = new Date(this.now());
      // Conflict waiting occurs before the separate read so concurrent first
      // submissions cannot bind one provider form to different workspaces.
      await db.query(`INSERT INTO jemlio_enquiry_intake_sources(source_hash,provider_hash,client,bound_at)
        VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`, [sourceHash, providerHash, source.client, at]);
      const binding = (await db.query('SELECT provider_hash,client FROM jemlio_enquiry_intake_sources WHERE source_hash=$1 FOR UPDATE', [sourceHash])).rows[0];
      if (!binding || binding.provider_hash !== providerHash || binding.client !== source.client) throw fail('source_binding_conflict');
      const receipt = randomUUID();
      const inserted = await db.query(`INSERT INTO nova_capture_requests(id,client,submission_id,payload_hash,data,created_at)
        VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(client,submission_id) DO NOTHING RETURNING id`,
      [receipt, source.client, submissionId, digest, JSON.stringify(data), at]);
      // A deletion tombstone wins even if this INSERT waited for a deleting
      // transaction. Roll back the attempted recreation and acknowledge replay.
      if ((await db.query('SELECT 1 FROM nova_capture_submission_tombstones WHERE client=$1 AND submission_id=$2', [source.client, submissionId])).rows.length) throw fail('submission_removed');
      if (!inserted.rows.length) {
        const existing = (await db.query('SELECT id,payload_hash,data FROM nova_capture_requests WHERE client=$1 AND submission_id=$2 FOR UPDATE', [source.client, submissionId])).rows[0];
        if (!existing || existing.payload_hash !== digest || existing.data.entryMode !== MODE) throw fail('submission_conflict');
        return { receipt: existing.id, duplicate: true, reviewNeeded: existing.data.intake.reviewNeeded, sendsMessages: false };
      }
      await db.query(`INSERT INTO jemlio_followups(request_id,due_at,action,updated_at) VALUES ($1,$2,$3,$4)`,
        [receipt, new Date(this.now() + 86400000), data.intake.reviewNeeded ? 'review' : 'callback', at]);
      await db.query('INSERT INTO jemlio_workspace_audit(id,request_id,actor,fields,recorded_at) VALUES ($1,$2,$3,$4,$5)',
        [randomUUID(), receipt, 'netlify:' + sourceHash.slice(0, 16), ['external_form_entry'], at]);
      // Contact consent and any eventual owner-approved reply are separate facts.
      // This transaction deliberately creates no email/CRM dispatch records.
      return { receipt, duplicate: false, reviewNeeded: data.intake.reviewNeeded, sendsMessages: false };
    });
  }
}
module.exports = { IntakeStore, MODE, submissionIdFor };
