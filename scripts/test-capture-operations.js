'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { PGlite } = require('@electric-sql/pglite');
const { PgStore } = require('../lib/capture/store');
const { CaptureOperations } = require('../lib/capture/operations');
const { parseArgs } = require('./capture-operations');

async function main() {
  let passed = 0;
  const test = async (name, run) => { await run(); console.log(`ok ${++passed} - ${name}`); };
  const now = Date.parse('2026-09-20T12:00:00Z');
  const db = new PGlite();
  let queue = Promise.resolve();
  const query = (sql, params) => params === undefined ? db.exec(sql).then(results => results.at(-1)) : db.query(sql, params);
  const pool = { query, connect: async () => {
    let release; const prior = queue; queue = new Promise(resolve => { release = resolve; }); await prior;
    return { query, release };
  } };
  const store = new PgStore({ pool });
  const operations = new CaptureOperations({ pool, now: () => now });
  const notification = { from: 'sender@example.com', to: ['office@example.com'], subject: 'Test', text: 'Synthetic only' };
  async function seed(client = 'example', status = 'pending', extra = {}) {
    const receipt = randomUUID();
    await store.create({ receipt, client, submissionId: randomUUID(), payloadHash: 'synthetic',
      data: { name: 'Private synthetic person', email: 'private@example.com' }, notification,
      createdAt: Date.parse(extra.createdAt || '2026-09-01T12:00:00Z') });
    await db.query(`UPDATE nova_capture_outbox SET status=$2,provider_id=$3,error_code=$4,locked_until=$5,lock_token=$6 WHERE request_id=$1`,
      [receipt, status, status === 'accepted' ? extra.providerId === null ? null : 'synthetic-provider-id' : null,
        extra.errorCode || null, extra.locked ? new Date(now + 60000) : null, extra.locked ? randomUUID() : null]);
    return receipt;
  }
  try {
    await store.initialize();
    await store.initialize();
    let first;
    await test('outcome preview does not mutate and exact retries do not duplicate history', async () => {
      first = await seed();
      const preview = await operations.setOutcome({ client: 'example', receipt: first, outcome: 'contacted' });
      assert.equal(preview.dryRun, true); assert.equal(preview.changed, false); assert.equal(preview.wouldChange, true);
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM nova_capture_outcomes')).rows[0].n, 0);
      await operations.setOutcome({ client: 'example', receipt: first, outcome: 'contacted', apply: true });
      const retried = await operations.setOutcome({ client: 'example', receipt: first, outcome: 'contacted', apply: true });
      assert.equal(retried.changed, false);
      assert.equal((await db.query('SELECT count(*)::integer AS n FROM nova_capture_outcome_events')).rows[0].n, 1);
    });
    await test('outcomes are tenant-scoped and never change notification state', async () => {
      await assert.rejects(operations.setOutcome({ client: 'other', receipt: first, outcome: 'won', apply: true }), /request_not_found/);
      await assert.rejects(operations.setOutcome({ client: 'example', receipt: first, outcome: 'delivered', apply: true }), /invalid_outcome/);
      await operations.setOutcome({ client: 'example', receipt: first, outcome: 'qualified', apply: true });
      await operations.setOutcome({ client: 'example', receipt: first, outcome: 'won', apply: true });
      assert.equal((await db.query('SELECT status FROM nova_capture_outbox WHERE request_id=$1', [first])).rows[0].status, 'pending');
    });
    await test('conversion report counts real recorded outcomes and never includes contact details', async () => {
      await seed('other', 'accepted');
      await seed('example', 'accepted', { createdAt: '2026-09-19T12:00:00Z' });
      const all = await operations.report({ client: 'example' });
      assert.equal(all.requests, 2); assert.equal(all.currentOutcomes.won, 1); assert.equal(all.currentOutcomes.new, 1);
      assert.equal(all.recordedOutcomes.contacted, 1); assert.equal(all.recordedOutcomes.qualified, 1); assert.equal(all.recordedOutcomes.won, 1);
      assert.equal(all.notifications.accepted, 1); assert.equal(all.notifications.pending, 1);
      assert.doesNotMatch(JSON.stringify(all), /private@example|Private synthetic|office@example|synthetic-provider/);
      const cohort = await operations.report({ client: 'example', before: '2026-09-10' });
      assert.equal(cohort.requests, 1);
      assert.equal((await operations.report({ client: 'absent' })).requests, 0);
    });
    await test('direct wins do not invent contacted or qualified outcomes', async () => {
      const receipt = await seed('direct');
      await operations.setOutcome({ client: 'direct', receipt, outcome: 'won', apply: true });
      const report = await operations.report({ client: 'direct' });
      assert.equal(report.recordedOutcomes.won, 1); assert.equal(report.recordedOutcomes.contacted, 0); assert.equal(report.recordedOutcomes.qualified, 0);
    });
    let accepted, rejected, uncertain, sending, pending, revoked, conflicting, unconfirmed, locked, recent, other;
    await test('retention previews protect pending, in-flight and uncertain dispatches', async () => {
      accepted = await seed('retention', 'accepted');
      rejected = await seed('retention', 'failed', { errorCode: 'provider_422' });
      uncertain = await seed('retention', 'failed', { errorCode: 'delivery_uncertain' });
      sending = await seed('retention', 'sending');
      pending = await seed('retention', 'pending');
      revoked = await seed('retention', 'needs_review');
      conflicting = await seed('retention', 'failed', { errorCode: 'payload_conflict' });
      unconfirmed = await seed('retention', 'accepted', { providerId: null });
      locked = await seed('retention', 'accepted', { locked: true });
      recent = await seed('retention', 'accepted', { createdAt: '2026-09-19T12:00:00Z' });
      other = await seed('other-retention', 'accepted');
      await operations.setOutcome({ client: 'retention', receipt: accepted, outcome: 'won', apply: true });
      const preview = await operations.deleteRequests({ client: 'retention', before: '2026-09-10' });
      assert.equal(preview.matchedRequests, 9); assert.equal(preview.eligibleRequests, 2); assert.equal(preview.protectedRequests, 7);
      assert.equal(preview.wouldDelete, 2); assert.equal(preview.deletedRequests, 0); assert.equal(preview.dryRun, true);
      assert.equal((await operations.report({ client: 'retention' })).requests, 10);
    });
    await test('applied retention is bounded, exact-tenant and cascades PII plus outcome history', async () => {
      const deleted = await operations.deleteRequests({ client: 'retention', before: '2026-09-10', limit: 1, apply: true });
      assert.equal(deleted.deletedRequests, 1);
      const rest = await operations.deleteRequests({ client: 'retention', before: '2026-09-10', apply: true });
      assert.equal(rest.deletedRequests, 1);
      assert.equal((await operations.report({ client: 'retention' })).requests, 8);
      const removed = await db.query('SELECT request_id FROM nova_capture_outcome_events WHERE request_id=$1', [accepted]);
      assert.equal(removed.rows.length, 0);
      for (const receipt of [uncertain, sending, pending, revoked, conflicting, unconfirmed, locked, recent, other]) {
        assert.equal((await db.query('SELECT id FROM nova_capture_requests WHERE id=$1', [receipt])).rows.length, 1);
      }
    });
    await test('exact deletion cannot delete a different tenant or bypass uncertain-dispatch protection', async () => {
      const wrong = await operations.deleteRequests({ client: 'retention', receipt: other, apply: true });
      assert.equal(wrong.deletedRequests, 0); assert.equal(wrong.matchedRequests, 0);
      const blocked = await operations.deleteRequests({ client: 'retention', receipt: pending, apply: true });
      assert.equal(blocked.protectedRequests, 1); assert.equal(blocked.deletedRequests, 0);
    });
    await test('deletion keeps only an opaque tenant-scoped guard against duplicate browser retries', async () => {
      const input = { receipt: randomUUID(), client: 'replay', submissionId: randomUUID(), payloadHash: 'synthetic',
        data: { name: 'Private synthetic person', email: 'private@example.com' }, notification,
        createdAt: Date.parse('2026-09-01T12:00:00Z') };
      await store.create(input);
      await db.query("UPDATE nova_capture_outbox SET status='accepted',provider_id='synthetic' WHERE request_id=$1", [input.receipt]);
      assert.equal((await operations.deleteRequests({ client: 'replay', receipt: input.receipt, apply: true })).deletedRequests, 1);
      await assert.rejects(store.create(input), /submission_removed/);
      await assert.rejects(store.create({ ...input, receipt: randomUUID() }), /submission_removed/);
      assert.equal((await operations.report({ client: 'replay' })).requests, 0);
      const guard = (await db.query('SELECT * FROM nova_capture_submission_tombstones WHERE client=$1', ['replay'])).rows[0];
      assert.deepEqual(Object.keys(guard).sort(), ['client', 'deleted_at', 'submission_id']);
      assert.doesNotMatch(JSON.stringify(guard), /private@example|Private synthetic/);
      assert.equal((await store.create({ ...input, client: 'different-replay', receipt: randomUUID() })).duplicate, false);
    });
    await test('scope, impossible dates and future deletion cutoffs fail closed', async () => {
      await assert.rejects(operations.deleteRequests({ client: 'retention', apply: true }), /deletion_scope_required/);
      await assert.rejects(operations.deleteRequests({ client: 'retention', before: '2026-09-21' }), /future_deletion_cutoff/);
      await assert.rejects(operations.deleteRequests({ client: 'retention', before: '2026-02-30' }), /invalid_before/);
      await assert.rejects(operations.deleteRequests({ client: 'retention', before: '2026-02-30T12:00:00Z' }), /invalid_before/);
      await assert.rejects(operations.deleteRequests({ client: 'retention', before: '2026-09-10T24:00:00Z' }), /invalid_before/);
      await assert.rejects(operations.deleteRequests({ client: 'retention', before: '2026-09-10', limit: 0 }), /invalid_limit/);
      await assert.rejects(operations.report({ client: "x' OR TRUE --" }), /invalid_client/);
      await assert.rejects(operations.report({ client: 'retention', since: '2026-09-20', before: '2026-09-10' }), /invalid_date_range/);
    });
    await test('CLI parser requires exact commands and never applies by default', async () => {
      const parsed = parseArgs(['outcome', '--client', 'example', '--receipt', first, '--status', 'qualified']);
      assert.equal(parsed.options.apply, undefined); assert.equal(parsed.options.outcome, 'qualified');
      assert.equal(parseArgs(['delete', '--client', 'example', '--receipt', first, '--apply']).options.apply, true);
      for (const args of [['delete'], ['report', '--client', 'a', '--apply'], ['delete', '--client', 'a', '--client', 'b'], ['delete', '--client', 'a', '--limit', '-1'], ['outcome', '--client', 'a']]) {
        assert.throws(() => parseArgs(args));
      }
    });
    console.log(`Capture operations checks passed: ${passed}. Synthetic local data only; no notifications sent.`);
  } finally { await db.close(); }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
