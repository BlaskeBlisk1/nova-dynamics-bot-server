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
const { WorkspaceStore } = require('../lib/workspace/store');
const { CalendarStore } = require('../lib/calendar-sync/store');
const { OfferStore } = require('../lib/offers/store');
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
    await pool.query(readFileSync(join(__dirname, '../lib/workspace/schema.sql'), 'utf8'));
    await check('concurrent workspace edits allow one commit and reject stale updates', async () => {
      const row = await entry('ci-workspace-race'), store = new WorkspaceStore({ pool });
      const before = (await store.list(row.client)).items[0];
      const results = await Promise.allSettled(Array.from({length:8}, (_,i) => store.update(row.client,row.receipt,{revision:before.revision,note:'Synthetic note '+i},'test')));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);
      assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='conflict'));
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM jemlio_workspace_audit WHERE request_id=$1',[row.receipt])).rows[0].n,1);
    });
    await pool.query(readFileSync(join(__dirname, '../lib/calendar-sync/schema.sql'), 'utf8'));
    const calendar=new CalendarStore({pool});
    const providerId=id=>'https://api.calendly.com/scheduled_events/'+id+'/invitees/synthetic-guest';
    async function booked(client){const row=await entry(client),c=await bookings.claim(claim(row));await bookings.finish(c.row,{status:'confirmed',providerId:providerId(row.receipt)});return row;}
    const notice=(row,digest=randomUUID())=>({references:[providerId(row.receipt)],attempt:null,hint:providerId(row.receipt),digest});
    const answer=(row,extra={})=>({providerId:providerId(row.receipt),slot,status:'confirmed',cancelUrl:null,rescheduleUrl:null,aliases:[providerId(row.receipt)],...extra});
    await check('concurrent duplicate notifications and worker claims produce one durable job and one lease',async()=>{
      const row=await booked('ci-calendar-duplicates'),event=notice(row);
      const results=await Promise.all(Array.from({length:8},()=>calendar.enqueue(row.client,event,[eventType])));
      assert.equal(results.filter(r=>!r.duplicate).length,1);
      const jobs=await Promise.all(Array.from({length:8},()=>calendar.claim([row.client])));assert.equal(jobs.filter(Boolean).length,1);
      await calendar.process(jobs.find(Boolean),{read:async()=>answer(row)},[eventType]);
      assert.equal((await bookings.read(row.client,row.receipt)).calendar_state,'synced');
    });
    await check('new webhook during provider read invalidates the old lease result without losing the notification',async()=>{
      const row=await booked('ci-calendar-generation'),held=gate(),release=gate();await calendar.enqueue(row.client,notice(row),[eventType]);const job=await calendar.claim([row.client]);
      const work=calendar.process(job,{read:async()=>{held.resolve();await release.promise;return answer(row,{status:'cancelled'});}},[eventType]);
      try{await held.promise;await calendar.enqueue(row.client,notice(row),[eventType]);}finally{release.resolve();}await work;
      const b=await bookings.read(row.client,row.receipt);assert.equal(b.status,'confirmed');assert.equal(b.calendar_state,'pending');
      const q=(await pool.query('SELECT * FROM jemlio_calendar_jobs WHERE request_id=$1',[row.receipt])).rows[0];assert.equal(String(q.generation),'2');assert.equal(q.lease_id,null);assert.ok(q.available_at);
    });
    await check('manual reconciliation cannot overwrite a reschedule completed during its provider read',async()=>{
      const row=await booked('ci-calendar-manual-race'),held=gate(),release=gate();
      const manual=bookings.reconcile({client:row.client,receipt:row.receipt,apply:true,provider:{verify:async()=>{held.resolve();await release.promise;return answer(row);}}}).then(value=>({value}),error=>({error}));
      const movedId=providerId(randomUUID()),movedSlot=new Date(Date.parse(slot)+3600000).toISOString();
      try{await held.promise;await calendar.enqueue(row.client,notice(row),[eventType]);const job=await calendar.claim([row.client]);await calendar.process(job,{read:async()=>answer(row,{providerId:movedId,slot:movedSlot,aliases:[providerId(row.receipt),movedId]})},[eventType]);}finally{release.resolve();}
      assert.equal((await manual).error.code,'booking_state_changed');const b=await bookings.read(row.client,row.receipt);assert.equal(b.provider_id,movedId);assert.equal(new Date(b.slot).toISOString(),movedSlot);
    });
    await check('deletion during calendar read cascades queued jobs and cannot recreate private records',async()=>{
      const row=await booked('ci-calendar-delete'),held=gate(),release=gate();await pool.query("UPDATE jemlio_bookings SET status='cancelled' WHERE request_id=$1",[row.receipt]);await calendar.enqueue(row.client,notice(row),[eventType]);const job=await calendar.claim([row.client]);
      const work=calendar.process(job,{read:async()=>{held.resolve();await release.promise;return answer(row,{status:'cancelled'});}},[eventType]);
      try{await held.promise;assert.equal((await ops.deleteRequests({client:row.client,receipt:row.receipt,apply:true})).deletedRequests,1);}finally{release.resolve();}await work;
      for(const table of ['jemlio_bookings','jemlio_calendar_jobs','jemlio_calendar_receipts','jemlio_calendar_aliases'])assert.equal((await pool.query('SELECT * FROM '+table+' WHERE request_id=$1',[row.receipt])).rows.length,0);
    });
    const offers=new OfferStore({pool}),ws=new WorkspaceStore({pool});
    const proposal=async row=>({revision:(await ws.list(row.client,{view:'all'})).items[0].revision,title:'Synthetic proposal',description:'Synthetic service details only.',totalOre:100000,priceBasis:'incl_vat',days:7,verified:true});
    await check('eight concurrent proposal creates commit one version and reject stale duplicates',async()=>{
      const row=await entry('ci-offer-create'),input=await proposal(row),results=await Promise.allSettled(Array.from({length:8},()=>offers.issue(row.client,row.receipt,input)));
      assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.ok(results.filter(r=>r.status==='rejected').every(r=>r.reason.code==='conflict'));
    });
    await check('eight duplicate customer responses commit one response and follow-up, never a won sale',async()=>{
      const row=await entry('ci-offer-responses'),q=await offers.issue(row.client,row.receipt,await proposal(row));
      const results=await Promise.all(Array.from({length:8},()=>offers.respond(q.token,{response:'interested',note:'Synthetic'},()=>true)));
      assert.ok(results.every(r=>r.response==='interested'));assert.equal((await pool.query("SELECT count(*)::int AS n FROM jemlio_offer_events WHERE request_id=$1 AND action='response_interested'",[row.receipt])).rows[0].n,1);assert.equal((await ws.report({client:row.client})).won,0);
    });
    await check('a response waiting behind a new version cannot approve the replaced proposal',async()=>{
      const row=await entry('ci-offer-replace'),first=await offers.issue(row.client,row.receipt,await proposal(row)),held=gate(),release=gate();
      const hooked=new OfferStore({pool:hookedPool('SELECT id FROM nova_capture_requests',held,release)});
      const replacing=hooked.issue(row.client,row.receipt,await proposal(row));let response;
      try{await held.promise;response=offers.respond(first.token,{response:'interested'},()=>true).then(value=>({value}),error=>({error}));await blocked('SELECT id FROM nova_capture_requests%');}finally{release.resolve();}
      assert.equal((await replacing).offer.version,2);assert.equal((await response).error.code,'offer_unavailable');assert.equal((await pool.query("SELECT * FROM jemlio_offer_events WHERE request_id=$1 AND action LIKE 'response_%'",[row.receipt])).rows.length,0);
    });
    await check('a response waiting behind deletion cannot recreate an offer or customer task',async()=>{
      const row=await entry('ci-offer-delete'),q=await offers.issue(row.client,row.receipt,await proposal(row)),held=gate(),release=gate();
      const deleting=new CaptureOperations({pool:hookedPool('SELECT r.id FROM nova_capture_requests',held,release)}).deleteRequests({client:row.client,receipt:row.receipt,apply:true});let response;
      try{await held.promise;response=offers.respond(q.token,{response:'interested'},()=>true).then(value=>({value}),error=>({error}));await blocked('SELECT id FROM nova_capture_requests%');}finally{release.resolve();}
      assert.equal((await deleting).deletedRequests,1);assert.equal((await response).error.code,'request_not_found');for(const table of ['jemlio_offers','jemlio_offer_events','jemlio_followups'])assert.equal((await pool.query('SELECT * FROM '+table+' WHERE request_id=$1',[row.receipt])).rows.length,0);
    });
    const manual={submissionId:randomUUID(),source:'email',name:'Synthetic manual',email:'nobody@example.invalid',service:'Synthetic service',due:new Date(Date.now()+3600000).toISOString(),verified:true};
    await check('eight concurrent manual retries produce one enquiry, one task and no outgoing notification',async()=>{
      const results=await Promise.all(Array.from({length:8},()=>ws.create('ci-manual',manual,'test')));assert.equal(new Set(results.map(r=>r.id)).size,1);assert.equal(results.filter(r=>!r.duplicate).length,1);
      const id=results[0].id;assert.equal((await pool.query('SELECT * FROM jemlio_followups WHERE request_id=$1',[id])).rows.length,1);assert.equal((await pool.query('SELECT * FROM nova_capture_outbox WHERE request_id=$1',[id])).rows.length,0);
    });
    await check('manual retry waiting behind deletion is blocked by the retained submission guard',async()=>{
      const input={...manual,submissionId:randomUUID()},row=await ws.create('ci-manual-delete',input,'test'),held=gate(),release=gate();
      const deleting=new CaptureOperations({pool:hookedPool('SELECT r.id FROM nova_capture_requests r WHERE',held,release)}).deleteRequests({client:'ci-manual-delete',receipt:row.id,apply:true});let retry;
      try{await held.promise;retry=ws.create('ci-manual-delete',input,'test').then(value=>({value}),error=>({error}));await blocked('%nova_capture_requests%');}finally{release.resolve();}
      assert.equal((await deleting).deletedRequests,1);assert.ok(['submission_removed','conflict'].includes((await retry).error.code));assert.equal((await pool.query('SELECT * FROM nova_capture_requests WHERE id=$1',[row.id])).rows.length,0);
      await assert.rejects(ws.create('ci-manual-delete',input,'test'),/submission_removed/);
    });
    console.log(`Real PostgreSQL booking checks passed: ${checks}. No provider calls or production database access.`);
  } finally { await pool.end(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
