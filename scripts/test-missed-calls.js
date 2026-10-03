'use strict';
const assert=require('node:assert/strict'),{randomBytes,randomUUID}=require('node:crypto'),{readFileSync}=require('node:fs'),{join}=require('node:path');
const express=require('express'),twilio=require('twilio'),{PGlite}=require('@electric-sql/pglite');
const {createMissedCalls}=require('../lib/missed-calls/runtime'),{PgStore}=require('../lib/capture/store');
const {createWorkspaceRuntime}=require('../lib/workspace/runtime');
const {configuration,digest}=require('../lib/missed-calls/config');
const {adapter,validate}=require('../lib/missed-calls/twilio');
const VVS=require('../public/marketing/vvs-profile');
let tests=0;async function test(name,fn){await fn();console.log(`ok ${++tests} - ${name}`);}
async function main(){
 const real=process.argv.includes('--postgres');
 let db;
 if(real){const url=new URL(process.env.JEMLIO_TEST_DATABASE_URL||'');if(process.env.JEMLIO_THROWAWAY_DATABASE!=='true'||!['localhost','127.0.0.1'].includes(url.hostname)||!url.pathname.endsWith('_ci'))throw Error('Explicit disposable localhost CI database required');db=new(require('pg').Pool)({connectionString:url.href,max:6});}
 else db=new PGlite();
 let tail=Promise.resolve();async function acquire(){let release;const prior=tail;tail=new Promise(r=>release=r);await prior;return release;}
 const query=(sql,args)=>args===undefined?db.exec(sql).then(r=>r.at(-1)):db.query(sql,args);
 const pool=real?db:{async query(sql,args){const release=await acquire();try{return await query(sql,args);}finally{release();}},async connect(){const release=await acquire();return {query,release};}};
 let clock=Date.UTC(2026,9,3,16),calls=0,messageState='queued',verificationFails=false,providerUnknown=false;
 const origin='https://pilot.example.invalid',account='AC'+'a'.repeat(32),auth='a'.repeat(32),phone='+4799999999';
 const tenant={enabled:true,routingApproved:true,smsApproved:true,accountSid:account,authToken:auth,voiceNumber:'+4722222222',forwardTo:'+4733333333',smsFrom:'+15005550006',dailyLimit:5,activatedAt:new Date(clock-60000).toISOString(),smsText:'Hei fra Eksempel. Vi fikk ikke svart. Beskriv jobben: {link} Ved akutt behov, ring direkte. Svar STOP for å stoppe.',testRecipients:[phone,'+4799999998'],liveRecipientsApproved:false};
 const env={JEMLIO_MISSED_CALLS_ENABLED:'true',JEMLIO_MISSED_CALL_SEND_ENABLED:'true',JEMLIO_MISSED_CALL_ORIGIN:origin,JEMLIO_MISSED_CALL_KEY:randomBytes(32).toString('base64'),JEMLIO_MISSED_CALL_CONFIG:JSON.stringify({alpha:tenant}),NOVA_CAPTURE_FROM:'sender@example.invalid'};
 const captureTenant={mode:'live',name:'Example plumber',vvs:{postcodes:['0150']},form:VVS.form(),services:VVS.SERVICES,recipient:'owner@example.invalid',privacyUrl:origin+'/privacy',allowedOrigins:[origin]};
 const outbound=[],id=(prefix,n)=>prefix+n.toString(16).padStart(32,'0');let current=1;
 const events=new Map();function event(number=current++,from=phone,status='no-answer') {const v={AccountSid:account,CallSid:id('CA',number),DialCallSid:id('CA',number+1000),From:from,To:tenant.voiceNumber,DialCallStatus:status};events.set(v.CallSid,{...v,at:clock});return v;}
 const sdk={calls(sid){return {async fetch(){if(verificationFails)throw Error('provider down');const row=[...events.values()].find(e=>e.CallSid===sid||e.DialCallSid===sid);return row.CallSid===sid?{sid,accountSid:account,to:row.To,from:row.From,direction:'inbound'}:{sid,accountSid:account,to:tenant.forwardTo,parentCallSid:row.CallSid,status:row.DialCallStatus,endTime:new Date(row.at)};}};},
   lookups:{v2:{phoneNumbers(number){return {async fetch(){return {valid:true,countryCode:'NO',phoneNumber:number,lineTypeIntelligence:{type:number.endsWith('7')?'landline':'mobile',error_code:null}};}};}}},
   messages:Object.assign(sid=>({async fetch(){const row=outbound.find(x=>x.sid===sid);return {sid,accountSid:account,from:tenant.smsFrom,to:row.to,status:messageState};}}),{async create(input){calls++;const sid=id('SM',calls);outbound.push({...input,sid});if(providerUnknown)throw Error('lost response');return {sid,accountSid:account,from:tenant.smsFrom,to:input.to,status:'queued'};}})};
 const capture=new PgStore({pool}),runtime=createMissedCalls({env,pool,getTenant:async client=>client==='alpha'?captureTenant:null,now:()=>clock,provider:t=>adapter(t,{client:sdk})});
 const ownerKey=randomBytes(32).toString('base64url'),otherKey=randomBytes(32).toString('base64url');
 const workspace=createWorkspaceRuntime({env:{...env,JEMLIO_WORKSPACE_ENABLED:'true',JEMLIO_WORKSPACE_ORIGIN:origin,JEMLIO_WORKSPACE_CONFIG:JSON.stringify({alpha:{enabled:true,name:'Alpha',keyHash:digest(ownerKey)},beta:{enabled:true,name:'Beta',keyHash:digest(otherKey)}})},pool,now:()=>clock});workspace.attachRecovery(runtime);
 const app=express();app.use('/api/workspace',workspace.router);app.use('/api/missed-calls',runtime.router);let server;
 async function post(path,body,{signed=true,json=false,originHeader=origin}={}){const headers={'Content-Type':json?'application/json':'application/x-www-form-urlencoded',Origin:originHeader};if(!json&&signed)headers['X-Twilio-Signature']=twilio.getExpectedTwilioSignature(auth,origin+'/api/missed-calls/'+path,body);const r=await fetch('http://127.0.0.1:'+server.address().port+'/api/missed-calls/'+path,{method:'POST',headers,body:json?JSON.stringify(body):new URLSearchParams(body).toString()});const text=await r.text();return {status:r.status,data:r.headers.get('content-type')?.includes('json')?JSON.parse(text):text};}
 let primary,row,token;
 try{
  await capture.initialize();await pool.query(readFileSync(join(__dirname,'../lib/missed-calls/schema.sql'),'utf8'));
  for(const file of ['booking/schema.sql','workspace/schema.sql'])await pool.query(readFileSync(join(__dirname,'../lib',file),'utf8'));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  await test('SDK signatures match official fixture and bind all parameters to the configured URL',async()=>{
   const fields={CallSid:'CA1234567890ABCDE',Caller:'+14158675310',Digits:'1234',From:'+14158675310',To:'+18005551212'};
   assert.equal(validate('12345','L/OH5YylLD5NRKLltdqwSvS0BnU=','https://example.com/myapp.php?foo=1&bar=2',fields),true);
   assert.equal(validate('12345','L/OH5YylLD5NRKLltdqwSvS0BnU=','https://evil.example/myapp.php?foo=1&bar=2',fields),false);
   assert.equal(validate(auth,'bad',origin,fields),false);assert.equal(configuration({...env,JEMLIO_MISSED_CALL_CONFIG:JSON.stringify({alpha:{...tenant,forwardTo:tenant.voiceNumber}})}),null);
  });
  await test('schema and pinned key are explicit; wrong key cannot silently discard opt-outs',async()=>{
   assert.equal(await runtime.ready(),false);await pool.query('INSERT INTO jemlio_missed_call_keyring(singleton,fingerprint) VALUES(true,$1)',[digest(Buffer.from(env.JEMLIO_MISSED_CALL_KEY,'base64'))]);assert.equal(await runtime.ready(),true);
   const wrong=createMissedCalls({env:{...env,JEMLIO_MISSED_CALL_KEY:randomBytes(32).toString('base64')},pool});assert.equal(await wrong.ready(),false);await wrong.close();
  });
  await test('unsigned, mismatched and answered calls create no recovery; voice emits only approved target',async()=>{
   const e=event();assert.equal((await post('alpha/ended',e,{signed:false})).status,403);
   assert.equal((await post('alpha/ended',{...e,To:'+4744444444'})).status,403);
   for(const s of ['completed','canceled','failed'])assert.equal((await post('alpha/ended',event(undefined,phone,s))).status,200);
   assert.equal((await post('alpha/ended',event(undefined,'anonymous'))).status,200);
   assert.equal(Number((await pool.query('SELECT COUNT(*) AS n FROM jemlio_missed_calls')).rows[0].n),0);
   const v=await post('alpha/voice',e);assert.equal(v.status,200);assert.ok(v.data.includes(tenant.forwardTo));assert.ok(v.data.includes('answerOnBridge="true"'));assert.equal(calls,0);
  });
  await test('one signed call is stored once, encrypted, then verified before one SMS',async()=>{
   primary=event();const responses=await Promise.all([post('alpha/ended',primary),post('alpha/ended',primary)]);assert.ok(responses.every(r=>r.status===200));
   assert.equal(calls,0);assert.equal((await post('alpha/ended',{...primary,From:'+4799999998'})).status,409);
   row=(await pool.query('SELECT * FROM jemlio_missed_calls WHERE parent_sid=$1',[primary.CallSid])).rows[0];token=runtime.store.decode(row).token;
   assert.equal(row.encrypted_payload.includes(phone),false);assert.equal(JSON.stringify(row).includes(token),false);
   assert.equal((await post('read',{token},{json:true})).status,404);
   await Promise.all([runtime.tick(),runtime.tick()]);assert.equal(calls,1);assert.ok(outbound[0].body.includes('/job-request/#'+token));
   assert.equal((await post('read',{token},{json:true,originHeader:'https://evil.example'})).status,403);
   const read=await post('read',{token},{json:true});assert.equal(read.status,200);assert.equal(JSON.stringify(read.data).includes(phone),false);
  });
  await test('delivery callbacks are authenticated and monotonic; sent is not delivered',async()=>{
   const status={AccountSid:account,MessageSid:outbound[0].sid,From:tenant.smsFrom,To:phone,MessageStatus:'delivered'};
   assert.equal((await post('alpha/status/'+row.id,status,{signed:false})).status,403);assert.equal((await post('alpha/status/'+row.id,status)).status,200);
   await post('alpha/status/'+row.id,{...status,MessageStatus:'queued'});
   assert.equal((await runtime.store.get('alpha',row.id)).state,'delivered');
   assert.equal(await runtime.store.get('beta',row.id),null);
  });
  let request;
  await test('reviewed submission creates one enquiry and owner outbox with trustworthy missed-call source',async()=>{
   request={token,name:'Kari Example',email:'kari@example.invalid',service:'reparasjon',consent:true,answers:{problem:'Replace the kitchen tap.',urgency:'Planlagt arbeid',postcode:'0150',address:'Eksempelveien 12'}};
   assert.equal((await post('submit',{...request,phone:'+4744444444'},{json:true})).status,400);
   assert.equal((await post('submit',{...request,answers:{...request.answers,urgency:'Akutt problem nå'}},{json:true})).data.error,'urgent_call_required');
   const saved=await Promise.all([post('submit',request,{json:true}),post('submit',request,{json:true})]);assert.ok(saved.every(x=>[200,201].includes(x.status)));assert.equal(saved[0].data.receipt,saved[1].data.receipt);
   const record=(await pool.query('SELECT * FROM nova_capture_requests WHERE id=$1',[row.receipt])).rows[0];assert.equal(record.data.job.source,'missed_call');assert.equal(record.data.phone,phone);assert.equal(record.data.job.recoveryId,row.id);
   assert.equal((await pool.query('SELECT * FROM nova_capture_outbox WHERE request_id=$1',[row.receipt])).rows.length,1);
   assert.equal((await post('submit',{...request,name:'Changed name'},{json:true})).status,409);
  });
  await test('opt-out is durable; future calls and existing private links are stopped',async()=>{
   const stop={AccountSid:account,MessageSid:id('SM',600),From:phone,To:tenant.smsFrom,Body:'STOP'};assert.equal((await post('alpha/inbound',stop)).status,200);
   assert.equal((await post('read',{token},{json:true})).status,404);
   await post('alpha/ended',event());await runtime.tick();assert.equal(calls,1);
   assert.ok((await runtime.store.list('alpha')).items.some(x=>x.reason==='opted_out'));
  });
  await test('ambiguous send is never retried; an authenticated late callback can resolve it',async()=>{
   providerUnknown=true;const e=event(undefined,'+4799999998');await post('alpha/ended',e);await runtime.tick();assert.equal(calls,2);await runtime.tick();assert.equal(calls,2);
   const r=(await pool.query('SELECT * FROM jemlio_missed_calls WHERE parent_sid=$1',[e.CallSid])).rows[0];assert.equal(r.state,'uncertain');assert.equal((await runtime.reconcile('alpha',r.id)).reason,'provider_id_unknown');
   await post('alpha/status/'+r.id,{AccountSid:account,MessageSid:outbound[1].sid,From:tenant.smsFrom,To:'+4799999998',MessageStatus:'sent'});
   messageState='delivered';await runtime.reconcile('alpha',r.id);assert.equal((await runtime.store.get('alpha',r.id)).state,'delivered');providerUnknown=false;
  });
  await test('cooldown, test-recipient gate, stale events and verification outages make no extra sends',async()=>{
   await post('alpha/ended',event(undefined,'+4799999998'));await runtime.tick();assert.equal(calls,2);
   await post('alpha/ended',event(undefined,'+4799999996'));await runtime.tick();assert.equal(calls,2);
   clock+=25*3600000;const old=event(undefined,'+4799999998');events.get(old.CallSid).at=clock-30*60000;await post('alpha/ended',old);await runtime.tick();assert.equal(calls,2);
   verificationFails=true;await post('alpha/ended',event(undefined,'+4799999998'));await runtime.tick();clock+=31000;await runtime.tick();clock+=31000;await runtime.tick();assert.equal(calls,2);verificationFails=false;
   env.JEMLIO_MISSED_CALL_SEND_ENABLED='false';await post('alpha/ended',event(undefined,'+4799999998'));await runtime.tick();assert.equal(calls,2);
  });
  await test('daily quota is atomic and an expired send lease never authorizes a second SMS',async()=>{
   const cfg=configuration(env),t={...cfg.tenants.alpha,dailyLimit:1};
   const events=[{parentSid:id('CA',9000),childSid:id('CA',9001),from:'+4799999995',status:'no-answer'},
                 {parentSid:id('CA',9002),childSid:id('CA',9003),from:'+4799999994',status:'no-answer'}];
   const rows=[];
   for(const e of events){await runtime.store.receive('quota',t,e);let r=(await pool.query('SELECT * FROM jemlio_missed_calls WHERE parent_sid=$1',[e.parentSid])).rows[0];r.claim=randomUUID();await pool.query("UPDATE jemlio_missed_calls SET state='verifying',claim=$2,lease_until=$3 WHERE id=$1",[r.id,r.claim,new Date(clock+60000)]);rows.push(r);}
   const claims=await Promise.all(rows.map(r=>runtime.store.reserve(r,t)));assert.equal(claims.filter(Boolean).length,1);
   clock+=31000;assert.ok((await runtime.store.list('quota')).items.some(r=>r.state==='uncertain'));
   await runtime.store.claim();assert.ok((await runtime.store.list('quota')).items.some(r=>r.reason==='send_interrupted'));assert.equal(calls,2);
  });
  await test('provider verification rejects landlines and non-matching call records',async()=>{
   const e=event(undefined,'+4799999997');const p=adapter(configuration(env).tenants.alpha,{client:sdk});
   await assert.rejects(p.verifyCall({parentSid:e.CallSid,childSid:e.DialCallSid,from:e.From,status:e.DialCallStatus},clock),/not_mobile/);
   await assert.rejects(p.verifyCall({parentSid:e.CallSid,childSid:e.DialCallSid,from:'+4799999999',status:e.DialCallStatus},clock),/call_not_eligible/);
   assert.equal(calls,2);
  });
  await test('owner recovery queue requires authentication, CSRF and correct tenant; cancel is not resend',async()=>{
   async function req(path,body,session){const response=await fetch('http://127.0.0.1:'+server.address().port+'/api/workspace'+path,{method:body?'POST':'GET',headers:{Origin:origin,'Content-Type':'application/json',...(session?{Cookie:session.cookie,'x-jemlio-csrf':session.csrf}:{})},body:body?JSON.stringify(body):undefined});return {status:response.status,data:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};}
   assert.equal((await req('/missed-calls')).status,401);
   const login=await req('/login',{key:ownerKey}),session={cookie:login.cookie,csrf:login.data.csrf};
   assert.equal(login.status,200);assert.equal((await workspace.readiness()).reason,'ready');assert.equal((await req('/missed-calls',null,session)).status,200);
   const other=await req('/login',{key:otherKey}),bad={cookie:other.cookie,csrf:other.data.csrf};
   assert.equal((await req('/missed-calls/'+row.id+'/cancel',{},bad)).status,404);
   assert.equal((await req('/missed-calls/'+row.id+'/cancel',{}, {...session,csrf:'wrong'})).status,403);
   assert.equal((await req('/missed-calls/'+row.id+'/cancel',{},session)).status,200);assert.equal(calls,2);
  });
  await test('deletion revokes a consumed link and cannot recreate the original contact',async()=>{
   await pool.query('DELETE FROM nova_capture_requests WHERE id=$1',[row.receipt]);assert.equal((await post('read',{token},{json:true})).status,404);
   assert.equal((await post('submit',request,{json:true})).status,404);assert.equal((await pool.query('SELECT * FROM nova_capture_outbox WHERE request_id=$1',[row.receipt])).rows.length,0);
  });
  console.log(`Missed calls: ${tests} grouped checks passed. Only synthetic calls, numbers, database and provider functions. Database: ${real?'PostgreSQL':'PGlite'}.`);
 }finally{server?.closeAllConnections();if(server)await new Promise(r=>server.close(r));await runtime.close();await workspace.close();if(real)await db.end();else await db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
