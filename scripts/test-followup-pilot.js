'use strict';
// Actual application routes, disposable database, fake email transport only.
const assert = require('node:assert/strict');
const { randomUUID, randomBytes, createHmac } = require('node:crypto');
const { readFileSync } = require('node:fs'), { join } = require('node:path');
const express = require('express');
const { PgStore, createCaptureRouter } = require('../lib/capture');
const { flushNotifications } = require('../lib/capture/notification');
const { createWorkspaceRuntime, config, COOKIE } = require('../lib/workspace/runtime');
const { hash } = require('../lib/workspace/store');
const { createConversations } = require('../lib/enquiry-conversations/runtime');
const { createOwnerAlerts } = require('../lib/owner-alerts/runtime');
let checks = 0;
async function test(name, fn) { await fn(); console.log(`ok ${++checks} - ${name}`); }
async function database() {
  if (process.argv.includes('--postgres')) {
    const url = new URL(process.env.JEMLIO_TEST_DATABASE_URL || '');
    if (process.env.JEMLIO_THROWAWAY_DATABASE !== 'true' || !['localhost', '127.0.0.1'].includes(url.hostname) || !url.pathname.includes('_ci')) throw Error('Only an explicitly disposable localhost CI database is allowed');
    const { Pool } = require('pg'), pool = new Pool({ connectionString: url.href, max: 6 });
    return { pool, close: () => pool.end() };
  }
  const { PGlite } = require('@electric-sql/pglite'), db = new PGlite();
  let tail = Promise.resolve();
  const acquire = async () => { let release; const previous = tail; tail = new Promise(r => release = r); await previous; return release; };
  const query = (sql, args) => args === undefined ? db.exec(sql).then(items => items.at(-1)) : db.query(sql, args);
  const pool = { async query(sql, args) { const release = await acquire(); try { return await query(sql, args); } finally { release(); } }, async connect() { const release = await acquire(); return { query, release }; } };
  return { pool, close: () => db.close() };
}
async function main() {
  const vvs = process.argv.includes("--vvs");
  const needs = vvs ? "Replace kitchen tap. No active leak." : "Move-out cleaning, 75 square metres.";
  const { pool, close } = await database();
  const origin = 'https://pilot.example.invalid';
  let clock = Date.UTC(2026, 9, 1, 8, 0); const now = () => clock;
  const keyA = randomBytes(32).toString('base64url'), keyB = randomBytes(32).toString('base64url');
  const signing = randomBytes(32);
  const env = {
    JEMLIO_WORKSPACE_ENABLED: 'true', JEMLIO_WORKSPACE_ORIGIN: origin,
    JEMLIO_WORKSPACE_CONFIG: JSON.stringify({ alpha: { enabled: true, name: 'Synthetic Alpha', keyHash: hash(keyA), offersEnabled: true, conversationsEnabled: true, quoteDeliveryEnabled: true }, beta: { enabled: true, name: 'Synthetic Beta', keyHash: hash(keyB), offersEnabled: true, conversationsEnabled: true, quoteDeliveryEnabled: true } }),
    JEMLIO_OFFERS_ENABLED: 'true', JEMLIO_OFFER_SEND_ENABLED: 'true', JEMLIO_CONVERSATIONS_ENABLED: 'true', JEMLIO_CONVERSATION_SEND_ENABLED: 'true',
    JEMLIO_CONVERSATION_ENCRYPTION_KEY: randomBytes(32).toString('base64'), JEMLIO_CONVERSATION_WEBHOOK_SECRET: 'whsec_' + signing.toString('base64'),
    JEMLIO_CONVERSATION_SEND_CONFIG: JSON.stringify({ alpha: { enabled: true, from: 'sender@example.invalid' }, beta: { enabled: true, from: 'sender@example.invalid' } }),
    JEMLIO_OWNER_ALERTS_ENABLED: 'true', JEMLIO_OWNER_ALERTS_FROM: 'alerts@example.invalid',
    JEMLIO_OWNER_ALERTS_CONFIG: JSON.stringify({ alpha: { enabled: true, to: 'owner@example.invalid', digestHour: 23, startAt: new Date(clock - 1000).toISOString() } })
  };
  const tenant = { mode: 'live', name: 'Synthetic Alpha', allowedOrigins: [origin], recipient: 'owner@example.invalid', privacyUrl: origin + '/privacy', services: [{ id: 'cleaning', label: 'Flyttevask' }], form: { kind: 'quote', requireEmail: true, requirePhone: false, questions: [{ id: 'need', label: 'Behov', type: 'text', required: true }] } };
  if (vvs) {
    const profile=require('../public/marketing/vvs-profile');
    tenant.vvs={postcodes:['0150','0160']};tenant.form=profile.form();tenant.services=profile.SERVICES;
  }
  const sent = [], ownerMail = [], replyMail = [];
  const fakeSend = async ({ notification, idempotencyKey }) => { sent.push({ notification, idempotencyKey }); return { providerId: 'fake-provider-' + sent.length }; };
  const capture = new PgStore({ pool });
  const workspace = createWorkspaceRuntime({ env, pool, now, sendMessage: fakeSend });
  const worker = createConversations({ env, pool, cfg: config(env), now, sendMessage: fakeSend });
  const alerts = createOwnerAlerts({ env, pool, workspace: config(env), now, sendNotification: async item => { replyMail.push(item); return { providerId: 'owner-response-' + replyMail.length }; } });
  const app = express();
  app.use('/capture', createCaptureRouter({ getTenantConfig: client => client === 'alpha' ? tenant : null, liveStore: capture, secret: 'x'.repeat(64), notificationFrom: 'sender@example.invalid', now, rateLimit:{session:100,request:100,windowMs:60000} }));
  app.use('/workspace', workspace.router); app.use('/offers', workspace.offerRouter); app.use('/replies', workspace.replyRouter); app.use('/events', workspace.conversationEventsRouter);
  let server, owner, other, receipt, token, proposal, replyToken;
  async function request(path, body, session, extra = {}) {
    const response = await fetch('http://127.0.0.1:' + server.address().port + path, { method: body === undefined ? 'GET' : 'POST', headers: { Origin: origin, 'Content-Type': 'application/json', ...(session ? { Cookie: session.cookie, 'x-jemlio-csrf': session.csrf } : {}), ...extra }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function login(key) { const r = await request('/workspace/login', { key }); assert.equal(r.status, 200); return { cookie: r.cookie, csrf: r.data.csrf }; }
  async function record() { const r = await request('/workspace/enquiries?view=all', undefined, owner); assert.equal(r.status, 200); return r.data.items.find(item => item.id === receipt); }
  async function conversation() { return (await request('/workspace/enquiries/' + receipt + '/conversation', undefined, owner)).data; }
  try {
    await capture.initialize();
    for (const file of ['booking/schema.sql', 'workspace/schema.sql', 'enquiry-conversations/schema.sql', 'offers/delivery-schema.sql', 'owner-alerts/schema.sql']) await pool.query(readFileSync(join(__dirname, '../lib', file), 'utf8'));
    // Only a disposable localhost CI database reaches this statement.
    if (process.argv.includes('--postgres')) await pool.query('TRUNCATE nova_capture_requests, nova_capture_rate_limits, jemlio_workspace_sessions, jemlio_owner_alerts, jemlio_conversation_delivery_events, jemlio_conversation_suppressions CASCADE');
    server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
    if (vvs) await test('VVS rejects urgency, unserved areas, invalid config and source spoofing before a job is saved', async()=>{
      const session=await request('/capture/session',{client:'alpha'});
      const base={client:'alpha',token:session.data.token,submissionId:randomUUID(),name:'Kari Example',phone:'99999999',email:'kari@example.invalid',service:'reparasjon',consent:true,answers:{problem:needs,urgency:'Planlagt arbeid',postcode:'0150',address:'Eksempelveien 12'}};
      for(const [change,code] of [[{urgency:'Akutt problem nå'},'urgent_call_required'],[{postcode:'9999'},'outside_service_area'],[{postcode:'abc'},'invalid_postcode']]){
        const response=await request('/capture/requests',{...base,answers:{...base.answers,...change}});assert.equal(response.status,400);assert.equal(response.data.error,code);
      }
      assert.equal((await request('/capture/requests',{...base,source:'missed_call'})).status,400);
      assert.equal((await request('/capture/requests',{...base,phone:''})).status,400);
      const original=tenant.form;tenant.form=null;assert.equal((await request('/capture/session',{client:'alpha'})).status,503);tenant.form=original;
      assert.equal((await pool.query('SELECT * FROM nova_capture_requests')).rows.length,0);
      assert.equal((await pool.query('SELECT * FROM nova_capture_outbox')).rows.length,0);
    });
    await test('reviewed customer request is durable and duplicate submission returns the same record', async () => {
      assert.equal((await request('/workspace/enquiries')).status, 401);
      const session = await request('/capture/session', { client: 'alpha' });
      const input = { client: 'alpha', token: session.data.token, submissionId: randomUUID(), name: 'Kari Example', email: 'kari@example.invalid', service: 'cleaning', consent: true, answers: { need: needs } };
      if(vvs){input.phone='99999999';input.service='reparasjon';input.answers={problem:needs,urgency:'Planlagt arbeid',postcode:'0150',address:'Eksempelveien 12'};}
      const r = await request('/capture/requests', input); assert.equal(r.status, 201); receipt = r.data.receipt;
      assert.equal((await request('/capture/requests', input)).data.receipt, receipt);
      assert.equal((await pool.query('SELECT * FROM nova_capture_outbox WHERE request_id=$1', [receipt])).rows.length, 1);
      await flushNotifications({ store: capture, now, isTenantEnabled: async (client, n) => client === 'alpha' && n.to?.[0] === 'owner@example.invalid', sendNotification: async item => { ownerMail.push(item); return { providerId: 'owner-received' }; } });
      assert.equal(ownerMail.length, 1); assert.ok(ownerMail[0].notification.text.includes(needs));
    });
    await test('owner login, tenant isolation and CSRF protect the actual workspace routes', async () => {
      owner = await login(keyA); other = await login(keyB); const r = await record(); assert.equal(r.details[0].value, needs);if(vvs){assert.equal(r.job.industry,'vvs');assert.equal(r.job.source,'website');assert.equal(r.job.postcode,'0150');}
      assert.equal((await request('/workspace/enquiries?view=all', undefined, other)).data.items.length, 0);
      assert.equal((await request('/workspace/enquiries/' + receipt, { revision: r.revision, note: 'Not allowed' }, other)).status, 404);
      assert.equal((await request('/workspace/enquiries/' + receipt, { revision: r.revision, note: 'Not allowed' }, owner, { 'x-jemlio-csrf': 'wrong' })).status, 403);
    });
    await test('approved clarification travels through the real reply routes into the same enquiry', async () => {
      let thread = await conversation(); assert.equal(thread.canSend, true);
      const draft = (await request('/workspace/enquiries/' + receipt + '/conversation/draft', { revision: thread.revision, template: 'question', body: 'When is a suitable time to discuss the job?' }, owner)).data;
      const body = { revision: draft.revision, draftId: draft.draftId, recipient: 'kari@example.invalid', body: 'When is a suitable time to discuss the job?', approved: true };
      assert.equal((await request('/workspace/enquiries/' + receipt + '/conversation/send', body, owner)).status, 200);
      await worker.tick(); assert.equal(sent.length, 1); replyToken = sent[0].notification.text.match(/\/reply\/#([A-Za-z0-9_-]{43})/)[1];
      thread = (await request('/replies/read', { token: replyToken })).data;
      assert.equal((await request('/replies/respond', { token: replyToken, submissionId: randomUUID(), revision: thread.revision, message: 'Friday works best.' })).status, 200);
      assert.ok((await conversation()).messages.some(m => m.body === 'Friday works best.'));
    });
    await test('owner-approved quote is atomic and concurrent HTTP retries cannot send it twice', async () => {
      const r = await record(); proposal = { operationId: randomUUID(), revision: r.revision, recipient: 'kari@example.invalid', title: vvs ? 'Kitchen tap replacement' : 'Move-out cleaning', description: 'Owner-approved scope. Timing agreed separately.', totalOre: 450000, priceBasis: 'incl_vat', days: 7, verified: true, approved: true };
      assert.equal((await request('/workspace/enquiries/' + receipt + '/offer/send', { ...proposal, approved: false }, owner)).status, 400);
      const results = await Promise.all([request('/workspace/enquiries/' + receipt + '/offer/send', proposal, owner), request('/workspace/enquiries/' + receipt + '/offer/send', proposal, owner)]);
      assert.ok(results.every(r => r.status === 200)); assert.equal(results[0].data.offer.id, results[1].data.offer.id);
      assert.equal((await request('/workspace/enquiries/' + receipt + '/offer/send', { ...proposal, totalOre: 460000 }, owner)).status, 409);
      await worker.tick(); assert.equal(sent.length, 2); token = sent[1].notification.text.match(/#offer=([a-f0-9]{64})/)[1];
      assert.equal((await request('/offers/read', { token })).data.offer.totalOre, 450000);
    });
    await test('signed delivery events, not a queued send, establish confirmed provider delivery', async () => {
      const event = { type: 'email.delivered', data: { email_id: 'fake-provider-2' } };
      assert.equal((await request('/events', event)).status, 401);
      const id = 'event-' + randomUUID(), timestamp = String(Math.floor(clock / 1000));
      const signature = createHmac('sha256', signing).update(id + '.' + timestamp + '.' + JSON.stringify(event)).digest('base64');
      assert.equal((await request('/events', event, null, { 'svix-id': id, 'svix-timestamp': timestamp, 'svix-signature': 'v1,' + signature })).status, 200);
      assert.ok((await conversation()).messages.some(m => m.state === 'delivered'));
    });
    await test('customer quote response generates one owner alert, without a sale or booking', async () => {
      assert.equal((await request('/offers/respond', { token, response: 'interested', note: 'Friday is suitable.' })).status, 200);
      assert.equal((await request('/offers/respond', { token, response: 'interested', note: 'Friday is suitable.' })).status, 200);
      const r = await record(); assert.equal(r.outcome, 'new'); assert.equal(r.followup.overdue, true);
      await alerts.tick(); await alerts.tick(); assert.equal(replyMail.length, 1);
      assert.equal((await pool.query('SELECT * FROM jemlio_recorded_sales')).rows.length, 0);
      assert.equal((await pool.query('SELECT * FROM jemlio_bookings')).rows.length, 0);
    });
    await test('follow-up date and internal note survive logout; no customer reminder is silently sent', async () => {
      const r = await record(), due = new Date(clock + 86400000).toISOString();
      assert.equal((await request('/workspace/enquiries/' + receipt, { revision: r.revision, note: 'Call to confirm final scope.', followup: { action: 'callback', due } }, owner)).status, 200);
      await request('/workspace/logout', {}, owner); owner = await login(keyA);
      const stored = await record(); assert.equal(stored.note, 'Call to confirm final scope.'); assert.equal(new Date(stored.followup.due).toISOString(), due); assert.equal(stored.followup.action, 'callback');
      await worker.tick(); assert.equal(sent.length, 2);
    });
    await test('owner verifies the outcome, revokes private links and leaves payment and booking distinct', async () => {
      const r = await record(); assert.equal((await request('/workspace/enquiries/' + receipt, { revision: r.revision, outcome: 'won', amountOre: 450000 }, owner)).status, 400);
      assert.equal((await request('/workspace/enquiries/' + receipt, { revision: r.revision, outcome: 'won', amountOre: 450000, verified: true }, owner)).status, 200);
      assert.equal((await request('/offers/read', { token })).status, 404); assert.equal((await request('/replies/read', { token: replyToken })).status, 404);
      const done = await record(); assert.equal(done.amountOre, 450000); assert.equal(done.booking.status, 'not_booked');
      assert.equal((await pool.query('SELECT * FROM jemlio_bookings')).rows.length, 0);
    });
    console.log(`Follow-up pilot rehearsal: ${checks} HTTP groups passed on ${process.argv.includes('--postgres') ? 'PostgreSQL' : 'PGlite'}. All email transport was fake.`);
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await Promise.all([workspace.close(), worker.close(), alerts.close()]); await close();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
