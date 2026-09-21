const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { PGlite } = require('@electric-sql/pglite');
const { createCaptureRouter, createMemoryStore, PgStore, createResendNotifier, flushNotifications } = require('../lib/capture');
const { CaptureOperations } = require('../lib/capture/operations');

async function main() {
  let passed = 0;
  const test = async (name, run) => { await run(); passed++; console.log(`ok ${passed} - ${name}`); };
  let clock = Date.UTC(2026, 8, 19, 12);
  const origin = 'https://preview.example.no';
  const secret = 'capture-test-secret-with-adequate-length';
  const config = { mode: 'preview', name: 'Example school', services: [{ id: 'class-b', label: 'Klasse B' }], allowedOrigins: [origin] };
  const getTenantConfig = (client, {preview}) => ['example', 'second'].includes(client) ? { ...config, mode: preview ? 'preview' : 'live', recipient: 'office@example.no', privacyUrl: 'https://example.no/privacy' } : null;
  const memory = createMemoryStore({now: () => clock});
  const router = createCaptureRouter({ getTenantConfig, previewStore: memory, secret, now: () => clock,
    rateLimit: { session: 100, request: 100, windowMs: 60000 } });
  const app = express(); app.use('/api/capture', router);
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/capture`;
  async function request(path, body, requestOrigin = origin) {
    const headers = { 'Content-Type': 'application/json' };
    if (requestOrigin !== null) headers.Origin = requestOrigin;
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST', headers,
      body: body === undefined ? undefined : JSON.stringify(body) });
    return {status: response.status, body: await response.json()};
  }
  let token;
  const fields = () => ({client: 'example', token, submissionId: crypto.randomUUID(), name: 'Test person', email: 'visitor@example.no', phone: '', service: 'class-b', preferredTime: 'Etter 16', consent: true, website: ''});
  try {
    await test('live config is off without durable storage and sender', async () => {
      assert.equal((await request('/config/example')).body.enabled, false);
      assert.equal((await router.getPublicConfig('example')).enabled, false);
    });
    await test('public preview config is sanitized', async () => {
      const r = await request('/config/example?preview=1');
      assert.equal(r.body.mode, 'preview'); assert.equal(r.body.recipient, undefined); assert.equal(r.body.allowedOrigins, undefined);
    });
    await test('missing and cross-site Origin cannot issue sessions', async () => {
      assert.equal((await request('/session', {client:'example',preview:true}, null)).status, 403);
      assert.equal((await request('/session', {client:'example',preview:true}, 'https://attacker.example')).status, 403);
    });
    await test('preview sessions are explicitly requested and signed', async () => {
      const r = await request('/session', {client:'example',preview:true});
      assert.equal(r.status, 200); assert.equal(r.body.mode,'preview'); token=r.body.token;
      assert.equal((await request('/session', {client:'example'})).status, 503);
    });
    await test('session cannot be replayed across tenants or origins', async () => {
      assert.equal((await request('/requests', {...fields(),client:'second'})).status,403);
      assert.equal((await request('/requests', fields(), 'https://attacker.example')).status,403);
    });
    await test('unknown fields cannot spoof destination, transcript or mode', async () => {
      for(const extra of [{recipient:'attacker@example.no'},{transcript:'secret'},{preview:false}]) {
        assert.equal((await request('/requests',{...fields(),...extra})).status,400);
      }
    });
    await test('consent, service, contact data and honeypot are validated', async () => {
      for(const extra of [{consent:false},{service:'unknown'},{email:'x\nBcc: y@example.no'},{email:'',phone:''},{name:'A'},{website:'bot'},{preferredTime:'x'.repeat(121)}]) {
        assert.equal((await request('/requests',{...fields(),...extra})).status,400);
      }
    });
    await test('preview receipts never claim email delivery; exact retries reuse receipt', async () => {
      const body = fields(); const first = await request('/requests',body); const second=await request('/requests',body);
      assert.equal(first.status,201); assert.equal(first.body.status,'preview_saved');
      assert.match(first.body.message,/Ingen e-post er sendt/); assert.equal(second.status,200); assert.equal(first.body.receipt,second.body.receipt);
      assert.equal((await request('/requests',{...body,name:'Different person'})).status,409);
    });
    await test('expired token is rejected without storing a new request', async () => {
      clock += 16*60000; assert.equal((await request('/requests',fields())).status,403);
    });
    await test('preview store refuses notification payloads', async () => {
      await assert.rejects(memory.create({notification:{to:['x@example.no']}}),/preview_notification_forbidden/);
    });

    const db = new PGlite();
    // PGlite has one connection. Serialize explicit transactions to model a pool;
    // each SQL claim is still atomic, so concurrent workers exercise independent claims.
    let queue=Promise.resolve();
    const query = (sql,params) => params === undefined ? db.exec(sql).then(results=>results.at(-1)) : db.query(sql,params);
    const pool = {query,connect:async()=>{
      let release; const prior=queue; queue=new Promise(resolve=>{release=resolve;}); await prior;
      return {query,release};
    }};
    const store = new PgStore({pool});
    try {
      await store.initialize();
      const notification={from:'nova@example.no',to:['office@example.no'],subject:'Ny forespørsel',text:'Synthetic test'};
      const entry=()=>({receipt:crypto.randomUUID(),client:'example',submissionId:crypto.randomUUID(),payloadHash:'hash-a',data:{name:'Synthetic'},notification,createdAt:clock});
      let saved;
      await test('PostgreSQL creates enquiry and outbox atomically and deduplicates concurrent writes',async()=>{
        saved=entry();
        const rows=await Promise.all(Array.from({length:5},()=>store.create(saved)));
        assert.equal(rows.filter(r=>!r.duplicate).length,1);
        assert.equal((await db.query('SELECT count(*) AS n FROM nova_capture_requests')).rows[0].n,1);
        assert.equal((await db.query('SELECT count(*) AS n FROM nova_capture_outbox')).rows[0].n,1);
        await assert.rejects(store.create({...saved,payloadHash:'changed'}),/submission_conflict/);
      });
      await test('transaction rolls back request when its outbox cannot be written',async()=>{
        await assert.rejects(store.create({...entry(),notification:null}),/live_notification_required/);
        assert.equal((await db.query('SELECT count(*) AS n FROM nova_capture_requests')).rows[0].n,1);
      });
      await test('production rate limiter shares counters atomically',async()=>{
        const rates=await Promise.all(Array.from({length:4},()=>store.consumeRateLimit('test-key',2,60000,clock)));
        assert.equal(rates.filter(Boolean).length,2);
      });
      let calls=0;
      const acceptedKeys=new Set();
      const notifier=async({idempotencyKey})=>{calls++;acceptedKeys.add(idempotencyKey);return{providerId:'email-1'};};
      const enabled=async()=>true;
      await test('concurrent delivery workers claim a request once',async()=>{
        await Promise.all(Array.from({length:3},()=>flushNotifications({store,sendNotification:notifier,isTenantEnabled:enabled,now:()=>clock})));
        assert.equal(calls,1);assert.equal(acceptedKeys.size,1);
        assert.equal((await db.query('SELECT status FROM nova_capture_outbox')).rows[0].status,'accepted');
      });
      await test('uncertain provider response retries immutable payload with same idempotency key',async()=>{
        const item=entry();await store.create(item);const seen=[];let attempt=0;
        const send=async args=>{seen.push(structuredClone(args));if(!attempt++)throw Object.assign(new Error('timeout'),{retryable:true,code:'network_uncertain'});return{providerId:'email-2'};};
        await flushNotifications({store,sendNotification:send,isTenantEnabled:enabled,now:()=>clock});
        clock+=31000;await flushNotifications({store,sendNotification:send,isTenantEnabled:enabled,now:()=>clock});
        assert.equal(seen.length,2);assert.deepEqual(seen[0],seen[1]);
      });
      await test('revoked tenant routes stop queued mail without calling provider',async()=>{
        const item=entry();await store.create(item);const before=calls;
        await flushNotifications({store,sendNotification:notifier,isTenantEnabled:async(client,message)=>{assert.equal(client,'example');assert.deepEqual(message,notification);return false;},now:()=>clock});
        assert.equal(calls,before);assert.equal((await db.query('SELECT status FROM nova_capture_outbox WHERE request_id=$1',[item.receipt])).rows[0].status,'needs_review');
      });
      await test('retry expiry and missing tenant guard fail closed',async()=>{
        const item=entry();await store.create(item);
        await db.query('UPDATE nova_capture_outbox SET first_attempt_at=$2 WHERE request_id=$1',[item.receipt,new Date(clock-23*3600000)]);
        const before=calls;await flushNotifications({store,sendNotification:notifier,isTenantEnabled:enabled,now:()=>clock});assert.equal(calls,before);
        await assert.rejects(flushNotifications({store,sendNotification:notifier}),/durable_delivery_not_configured/);
      });
      await test('loss of acknowledgement keeps same provider key after lease expires',async()=>{
        const item=entry();await store.create(item);const first=await store.claimNext(clock);
        await notifier({idempotencyKey:`nova-capture/${first.request_id}`});
        // Simulate process crash between provider acceptance and DB finish.
        clock+=61000;const keys=[];
        await flushNotifications({store,sendNotification:async args=>{keys.push(args.idempotencyKey);return{providerId:'same-email'};},isTenantEnabled:enabled,now:()=>clock});
        assert.deepEqual(keys,[`nova-capture/${item.receipt}`]);
        assert.equal(await store.finish(first,{status:'failed',at:clock}),false);
      });
      await test('storage failure returns 503 without a receipt or notification',async()=>{
        const unavailable={durable:true,consumeRateLimit:async()=>true,create:async()=>{throw new Error('database down');}};
        const failApp=express();failApp.use(createCaptureRouter({getTenantConfig,liveStore:unavailable,secret,notificationFrom:'nova@example.no'}));
        const s=await new Promise(resolve=>{const value=failApp.listen(0,'127.0.0.1',()=>resolve(value));});
        try {
          const url=`http://127.0.0.1:${s.address().port}`;
          const call=async(path,body)=>{const r=await fetch(url+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
          const session=await call('/session',{client:'example'});
          const response=await call('/requests',{...fields(),token:session.body.token});
          assert.equal(response.status,503);assert.equal(response.body.receipt,undefined);
        }finally{await new Promise(resolve=>s.close(resolve));}
      });
      await test('Resend adapter uses fixed endpoint, one recipient and supplied idempotency key',async()=>{
        let captured;
        const send=createResendNotifier({apiKey:'not-a-real-key',fetchFn:async(url,options)=>{captured={url,options};return{ok:true,status:200,json:async()=>({id:'provider-test'})};}});
        assert.deepEqual(await send({notification,idempotencyKey:'nova-capture/test'}),{providerId:'provider-test'});
        assert.equal(captured.url,'https://api.resend.com/emails');assert.equal(captured.options.redirect,'error');
        assert.equal(captured.options.headers['Idempotency-Key'],'nova-capture/test');assert.deepEqual(JSON.parse(captured.options.body).to,['office@example.no']);
      });
      await test('live HTTP submission durably freezes the approved notification and returns a saved-only receipt',async()=>{
        const liveApp=express();
        liveApp.use(createCaptureRouter({getTenantConfig,liveStore:store,secret,notificationFrom:'nova@example.no',now:()=>clock}));
        const s=await new Promise(resolve=>{const value=liveApp.listen(0,'127.0.0.1',()=>resolve(value));});
        try {
          const url=`http://127.0.0.1:${s.address().port}`;
          const call=async(path,body)=>{const r=await fetch(url+path,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:r.status,body:await r.json()};};
          const session=await call('/session',{client:'example'});assert.equal(session.body.mode,'live');
          const submission={...fields(),token:session.body.token};
          const response=await call('/requests',submission);assert.equal(response.status,201);assert.equal(response.body.status,'received');assert.match(response.body.message,/lagret/);
          const row=(await db.query('SELECT r.data,o.notification,o.status FROM nova_capture_requests r JOIN nova_capture_outbox o ON o.request_id=r.id WHERE r.id=$1',[response.body.receipt])).rows[0];
          assert.deepEqual(row.notification.to,['office@example.no']);assert.equal(row.notification.from,'nova@example.no');assert.equal(row.status,'pending');assert.equal(row.data.consent,true);
          assert.equal(row.notification.reply_to, submission.email.toLowerCase());
          assert.ok(!JSON.stringify(response.body).includes(submission.email));
          const retry=await call('/requests',submission);assert.equal(retry.status,200);assert.equal(retry.body.receipt,response.body.receipt);
          const phoneOnly=await call('/requests',{...submission,submissionId:crypto.randomUUID(),email:'',phone:'+47 999 99 999'});
          assert.equal(phoneOnly.status,201);
          const phoneMessage=(await db.query('SELECT notification FROM nova_capture_outbox WHERE request_id=$1',[phoneOnly.body.receipt])).rows[0].notification;
          assert.equal(Object.hasOwn(phoneMessage,'reply_to'),false);
          for (const injected of ['visitor@example.no\r\nBcc:attacker@example.no','visitor@example.no,attacker@example.no']) {
            assert.equal((await call('/requests',{...submission,submissionId:crypto.randomUUID(),email:injected})).status,400);
          }
          await db.query("UPDATE nova_capture_outbox SET status='accepted',provider_id='synthetic' WHERE request_id=$1",[response.body.receipt]);
          await new CaptureOperations({pool,now:()=>clock}).deleteRequests({client:'example',receipt:response.body.receipt,apply:true});
          const removedRetry=await call('/requests',submission);
          assert.equal(removedRetry.status,410);assert.equal(removedRetry.body.error,'submission_removed');
          assert.equal(removedRetry.body.receipt,undefined);
        }finally{await new Promise(resolve=>s.close(resolve));}
      });
    } finally {await db.close();}
  } finally {await new Promise(resolve=>server.close(resolve));}
  console.log(`Capture checks passed: ${passed}. No emails were sent.`);
}
main().catch(error=>{console.error(error);process.exitCode=1;});
