'use strict';
const assert=require('node:assert/strict'),{randomUUID,randomBytes}=require('node:crypto'),{readFileSync}=require('node:fs'),{join}=require('node:path');
const express=require('express'),{PGlite}=require('@electric-sql/pglite');
const S=require('../public/marketing/quote-schema');
const {PgStore}=require('../lib/capture/store'),{createCaptureRouter}=require('../lib/capture');
const {WorkspaceStore,hash}=require('../lib/workspace/store'),{OfferStore}=require('../lib/offers/store');
const {createConversations}=require('../lib/enquiry-conversations/runtime'),{decrypt}=require('../lib/enquiry-conversations/delivery');
const {OfferDeliveryFlow}=require('../lib/offers/delivery-flow');
let checks=0;async function check(name,fn){await fn();console.log(`ok ${++checks} - ${name}`);}
async function main(){
 const db=new PGlite();let tail=Promise.resolve(),server;
 async function acquire(){let release;const before=tail;tail=new Promise(r=>release=r);await before;return release;}
 const query=(sql,args)=>args===undefined?db.exec(sql).then(r=>r.at(-1)):db.query(sql,args);
 const pool={async query(sql,args){const release=await acquire();try{return await query(sql,args);}finally{release();}},async connect(){const release=await acquire();return {query,release};}};
 let clock=Date.UTC(2026,8,28,18),quoteEnabled=true;const now=()=>clock,origin='https://quotes.example.invalid';
 const form={kind:'quote',requireEmail:true,requirePhone:false,questions:[{id:'need',label:'Behov',type:'text',required:true},{id:'size',label:'Omfang',type:'select',required:true,options:['Lite','Stort'],services:['clean']}]};
 const tenant={mode:'live',name:'Synthetic Alpha',services:[{id:'visit',label:'Befaring'},{id:'clean',label:'Rengjøring'}],allowedOrigins:[origin],privacyUrl:origin+'/privacy',recipient:'owner@example.invalid',form};
 const cfg={origin,tenants:{alpha:{enabled:true,name:'Synthetic Alpha',conversationsEnabled:true,offersEnabled:true,quoteDeliveryEnabled:true},beta:{enabled:true,name:'Synthetic Beta',conversationsEnabled:true,offersEnabled:true,quoteDeliveryEnabled:true}}};
 const secret=randomBytes(32),env={JEMLIO_CONVERSATIONS_ENABLED:'true',JEMLIO_CONVERSATION_SEND_ENABLED:'true',JEMLIO_OFFERS_ENABLED:'true',JEMLIO_OFFER_SEND_ENABLED:'true',JEMLIO_CONVERSATION_ENCRYPTION_KEY:secret.toString('base64'),JEMLIO_CONVERSATION_SEND_CONFIG:JSON.stringify({alpha:{enabled:true,from:'sender@example.invalid'},beta:{enabled:true,from:'sender@example.invalid'}}),JEMLIO_CONVERSATION_WEBHOOK_SECRET:'whsec_'+randomBytes(32).toString('base64')};
 const sent=[],runtime=createConversations({env,pool,cfg,now,sendMessage:async({notification,idempotencyKey})=>{sent.push({payload:notification,key:idempotencyKey});return {providerId:'provider-'+sent.length};}});
 const capture=new PgStore({pool}),workspace=new WorkspaceStore({pool,now}),offers=new OfferStore({pool,now}),flow=new OfferDeliveryFlow({offers,conversations:runtime.store,enabled:c=>quoteEnabled&&c==='alpha',now});
 const app=express();app.use('/capture',createCaptureRouter({getTenantConfig:()=>tenant,liveStore:capture,secret:'x'.repeat(64),notificationFrom:'sender@example.invalid',now,rateLimit:{session:100,request:100,windowMs:60000}}));
 async function call(path,body){const r=await fetch('http://127.0.0.1:'+server.address().port+path,{method:body===undefined?'GET':'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,data:await r.json()};}
 const revision=async id=>(await workspace.list('alpha',{view:'all'})).items.find(r=>r.id===id).revision;
 const proposal=async id=>({operationId:randomUUID(),revision:await revision(id),recipient:'kari@example.invalid',title:'Synthetic service proposal',description:'Explicit service scope and timing agreed separately.',totalOre:250000,priceBasis:'incl_vat',days:7,verified:true,approved:true});
 async function entry(){const id=randomUUID();await capture.create({client:'alpha',receipt:id,submissionId:randomUUID(),payloadHash:randomUUID(),createdAt:clock,data:{name:'Kari Example',email:'kari@example.invalid',phone:'',service:'visit',consent:true},notification:{to:['owner@example.invalid'],subject:'Synthetic',text:'Never send'}});return id;}
 try{
  await capture.initialize();for(const file of ['booking/schema.sql','workspace/schema.sql','enquiry-conversations/schema.sql','offers/delivery-schema.sql'])await pool.query(readFileSync(join(__dirname,'../lib',file),'utf8'));
  server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  await check('shared schema validates required, conditional, unknown and bounded fields',async()=>{
    const normalized=S.normalizeForm(form,tenant.services);assert.equal(normalized.requireEmail,true);assert.deepEqual(S.validateAnswers(normalized,'visit',{need:' A request '}),[{id:'need',label:'Behov',value:'A request'}]);
    for(const values of [{},{need:'ok',evil:'x'},{need:'x'.repeat(501)},{need:'ok',size:'Lite'}])assert.throws(()=>S.validateAnswers(normalized,'visit',values));
    assert.throws(()=>S.validateAnswers(normalized,'clean',{need:'ok'}));assert.throws(()=>S.validateAnswers(normalized,'clean',{need:'ok',size:'Not allowed'}));
    assert.throws(()=>S.normalizeForm({...form,requireEmail:false},tenant.services));assert.throws(()=>S.normalizeForm({...form,questions:[{...form.questions[0],id:'constructor'}]},tenant.services));
    assert.equal(S.parseAmount('2 500,25'),250025);for(const v of ['NaN','-1','1e6','2.345'])assert.throws(()=>S.parseAmount(v));
  });
  let receipt;
  await check('live capture validates the configured fields and stores one notification with the request',async()=>{
    const config=await call('/capture/config/alpha');assert.equal(config.data.form.kind,'quote');assert.equal(JSON.stringify(config.data).includes('owner@example.invalid'),false);
    const session=await call('/capture/session',{client:'alpha'}),base={client:'alpha',name:'Kari Example',email:'kari@example.invalid',phone:'',service:'visit',consent:true,token:session.data.token,submissionId:randomUUID(),answers:{need:'Prepare an offer'}};
    assert.equal((await call('/capture/requests',{...base,answers:{}})).status,400);assert.equal((await call('/capture/requests',{...base,email:'',phone:'12345678'})).status,400);
    const r=await call('/capture/requests',base);assert.equal(r.status,201);receipt=r.data.receipt;
    const again=await call('/capture/requests',base);assert.equal(again.data.receipt,receipt);
    const row=(await workspace.list('alpha',{view:'all'})).items.find(r=>r.id===receipt);assert.equal(row.requestKind,'quote');assert.equal(row.details[0].value,'Prepare an offer');
    assert.equal((await pool.query('SELECT * FROM nova_capture_outbox WHERE request_id=$1',[receipt])).rows.length,1);
  });
  let input,queued,token;
  await check('owner approval creates the offer and encrypted dispatch in one transaction',async()=>{
    input=await proposal(receipt);await assert.rejects(flow.send('alpha',receipt,{...input,approved:false},'test'),/approval_required/);
    await assert.rejects(flow.send('alpha',receipt,{...input,recipient:'other@example.invalid'},'test'),/recipient_mismatch/);
    queued=await flow.send('alpha',receipt,input,'test');assert.equal(queued.delivery.state,'queued');assert.equal(sent.length,0);
    const message=(await pool.query('SELECT * FROM jemlio_conversation_messages WHERE id=$1',[queued.delivery.messageId])).rows[0];
    const payload=decrypt(message.encrypted_payload,secret,`alpha:${receipt}:${message.id}`);assert.deepEqual(payload.to,['kari@example.invalid']);token=payload.text.match(/#offer=([a-f0-9]{64})/)[1];
    assert.equal(message.body.includes(token),false);assert.equal(JSON.stringify((await pool.query('SELECT * FROM jemlio_offer_deliveries')).rows).includes(token),false);
    assert.equal((await offers.readOffer(token,c=>c==='alpha')).offer.totalOre,250000);
  });
  await check('lost acknowledgements and concurrent retries cannot create duplicate offers or email',async()=>{
    const replay=await Promise.all([flow.send('alpha',receipt,input,'test'),flow.send('alpha',receipt,input,'test')]);assert.ok(replay.every(r=>r.duplicate));
    assert.equal((await pool.query('SELECT * FROM jemlio_offers WHERE request_id=$1',[receipt])).rows.length,1);
    assert.equal((await pool.query("SELECT * FROM jemlio_conversation_messages WHERE request_id=$1 AND direction='outbound'",[receipt])).rows.length,1);
    await assert.rejects(flow.send('alpha',receipt,{...input,totalOre:999},'test'),/submission_conflict/);
    await assert.rejects(flow.send('beta',receipt,input,'test'),/send_unavailable/);
  });
  await check('existing worker sends the approved quote and customer response creates follow-up, not payment',async()=>{
    await runtime.tick();assert.equal(sent.length,1);assert.ok(sent[0].payload.text.includes('/demos/alpha#offer='));
    await offers.respond(token,{response:'changes',note:'Can we adjust the scope?'},c=>c==='alpha');
    const r=(await workspace.list('alpha',{view:'all'})).items.find(r=>r.id===receipt);assert.equal(r.offer.response,'changes');assert.equal(r.followup.overdue,true);assert.equal(r.outcome,'new');
    assert.equal((await pool.query('SELECT * FROM jemlio_bookings')).rows.length,0);assert.equal((await pool.query('SELECT * FROM jemlio_recorded_sales')).rows.length,0);
  });
  await check('new version revokes the previous token; sending-disabled gate does not create a quote',async()=>{
    quoteEnabled=false;await assert.rejects(flow.send('alpha',receipt,await proposal(receipt),'test'),/send_unavailable/);quoteEnabled=true;
    const next=await flow.send('alpha',receipt,await proposal(receipt),'test');assert.equal(next.offer.version,2);await assert.rejects(offers.readOffer(token,()=>true),/offer_unavailable/);
  });
  await check('withdrawn queued offers cannot be sent by a later worker run',async()=>{
    await offers.withdraw('alpha',receipt,{revision:await revision(receipt)});await runtime.tick();assert.equal(sent.length,1);
  });
  await check('send failure rolls back proposal issuance instead of stranding an offer',async()=>{
    const id=await entry(),before=await proposal(id);env.JEMLIO_CONVERSATION_SEND_ENABLED='false';await assert.rejects(flow.send('alpha',id,before,'test'),/send_unavailable/);
    assert.equal((await pool.query('SELECT * FROM jemlio_offers WHERE request_id=$1',[id])).rows.length,0);env.JEMLIO_CONVERSATION_SEND_ENABLED='true';
  });
  await check('quote send kill-switch is checked again before provider dispatch',async()=>{
    const id=await entry();await flow.send('alpha',id,await proposal(id),'test');env.JEMLIO_OFFER_SEND_ENABLED='false';await runtime.tick();assert.equal(sent.length,1);env.JEMLIO_OFFER_SEND_ENABLED='true';
  });
  await check('deleting an enquiry removes quote, delivery record and private access together',async()=>{
    await pool.query('DELETE FROM nova_capture_requests WHERE id=$1',[receipt]);assert.equal((await pool.query('SELECT * FROM jemlio_offer_deliveries WHERE request_id=$1',[receipt])).rows.length,0);await assert.rejects(offers.readOffer(token,()=>true));
  });
  console.log(`Quote flow: ${checks} grouped checks passed. Local synthetic database and fake email provider only.`);
 }finally{if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await runtime.close();await db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
