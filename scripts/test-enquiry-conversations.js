'use strict';
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {randomUUID,randomBytes,createHmac}=require('node:crypto');
const express=require('express');
const {createConversations}=require('../lib/enquiry-conversations/runtime');
const {verifyWebhook,key,encrypt,decrypt,hash,webhookKey}=require('../lib/enquiry-conversations/delivery');
const {WorkspaceStore}=require('../lib/workspace/store');
const {BookingStore}=require('../lib/booking/store');
const {CaptureOperations}=require('../lib/capture/operations');
const {createWorkspaceRuntime}=require('../lib/workspace/runtime');
async function runTests({pool,realPostgres=false}){
  let checks=0;const check=async(name,fn)=>{await fn();console.log(`ok ${++checks} - ${name}`);};
  for(const part of ['capture','booking','workspace','enquiry-conversations','enquiry-conversations'])await pool.query(readFileSync(join(__dirname,'../lib',part,'schema.sql'),'utf8'));
  const suffix=randomBytes(5).toString('hex'),alpha='conv-alpha-'+suffix,beta='conv-beta-'+suffix;
  let clock=Date.UTC(2026,8,27,12),calls=[],sendMode='success';const now=()=>clock;
  const origin='https://workspace.example.invalid',ownerKey=randomBytes(32).toString('base64url'),betaKey=randomBytes(32).toString('base64url');
  const cfg={origin,tenants:{[alpha]:{enabled:true,name:'Alpha bedrift',keyHash:hash(ownerKey),conversationsEnabled:true},[beta]:{enabled:true,name:'Beta bedrift',keyHash:hash(betaKey),conversationsEnabled:true}}};
  const env={JEMLIO_WORKSPACE_ENABLED:'true',JEMLIO_WORKSPACE_ORIGIN:origin,JEMLIO_WORKSPACE_CONFIG:JSON.stringify(cfg.tenants),
    JEMLIO_CONVERSATIONS_ENABLED:'true',JEMLIO_CONVERSATION_SEND_ENABLED:'true',
    JEMLIO_CONVERSATION_SEND_CONFIG:JSON.stringify({[alpha]:{enabled:true,from:'alpha@example.invalid',replyTo:'owner@example.invalid'},[beta]:{enabled:true,from:'beta@example.invalid'}}),
    JEMLIO_CONVERSATION_ENCRYPTION_KEY:randomBytes(32).toString('base64'),JEMLIO_CONVERSATION_WEBHOOK_SECRET:'whsec_'+randomBytes(32).toString('base64'),RESEND_API_KEY:'synthetic-only'};
  const ids=new Map();
  const send=async input=>{calls.push(structuredClone(input));if(sendMode!=='success')throw Object.assign(Error('synthetic'),sendMode==='uncertain'?{retryable:true,code:'network_uncertain'}:sendMode==='conflict'?{retryable:false,code:'payload_conflict'}:{retryable:false,code:'provider_422'});
    if(!ids.has(input.idempotencyKey))ids.set(input.idempotencyKey,randomUUID());return {providerId:ids.get(input.idempotencyKey)};};
  const runtime=createConversations({env,pool,cfg,now,sendMessage:send}),store=runtime.store,ws=new WorkspaceStore({pool,now}),ops=new CaptureOperations({pool,now}),booking=new BookingStore({pool,now});
  async function entry({client=alpha,recipient=`customer-${randomBytes(4).toString('hex')}@example.invalid`,booked=false}={}){
    const submissionId=randomUUID();const input={submissionId,name:'Synthetic customer',email:recipient,service:'Rengjøring',message:'Min opprinnelige henvendelse',source:'email',due:new Date(clock+86400000).toISOString(),verified:true};
    const row=await ws.create(client,input,'test-owner');
    if(booked)await pool.query(`INSERT INTO jemlio_bookings(request_id,attempt_id,payload_hash,event_type,slot,status,provider_id,created_at,updated_at)
      VALUES($1,$2,'synthetic','synthetic-event',$3,'confirmed',$4,$5,$5)`,[row.id,randomUUID(),new Date(clock+86400000),randomUUID(),new Date(clock)]);
    return {...row,client,input};
  }
  async function draft(row,body='Hei, kan du beskrive ønsket tidspunkt?'){
    const current=await store.read(row.client,row.id);return store.draft(row.client,row.id,{revision:current.revision,template:'question',body},'test-owner');
  }
  function approval(snapshot){const message=snapshot.messages.find(m=>m.id===snapshot.draftId);return {revision:snapshot.revision,draftId:message.id,recipient:snapshot.recipient,body:message.body,approved:true};}
  async function queue(row,body){const d=await draft(row,body);const input=approval(d);return {draft:d,input,snapshot:await store.send(row.client,row.id,input,'test-owner')};}
  function tokenFor(messageId){const call=calls.find(c=>c.idempotencyKey===`jemlio-conversation/${messageId}`);return call?.notification.text.match(/\/reply\/#([A-Za-z0-9_-]{43})/)?.[1];}
  function signature(body,id='msg_'+randomBytes(8).toString('hex'),at=clock,secret=env.JEMLIO_CONVERSATION_WEBHOOK_SECRET){const timestamp=String(Math.floor(at/1000));return {'svix-id':id,'svix-timestamp':timestamp,'svix-signature':'v1,'+createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${timestamp}.`).update(body).digest('base64')};}
  const denied=(fn,code)=>assert.rejects(fn,e=>e.code===code);
  let server,workspace;
  try{
    await check('disabled and malformed sender configuration never reads storage or sends',async()=>{
      const off=createConversations({env:{},pool:{query(){throw Error('unexpected query');}},cfg,sendMessage:send});assert.equal(off.features(alpha),false);await off.tick();off.startWorker();await off.close();assert.equal(calls.length,0);
      const row=await entry();for(const changes of [{JEMLIO_CONVERSATION_SEND_ENABLED:'false'},{JEMLIO_CONVERSATION_ENCRYPTION_KEY:'invalid'},{JEMLIO_CONVERSATION_WEBHOOK_SECRET:'whsec_invalid'},
        {JEMLIO_CONVERSATION_SEND_CONFIG:JSON.stringify({[alpha]:{enabled:true,from:'a@example.invalid\r\nBcc: victim@example.invalid'}})}]){
        const stopped=createConversations({env:{...env,...changes},pool,cfg,now,sendMessage:send});assert.equal((await stopped.store.read(alpha,row.id)).canSend,false);await stopped.close();}
    });
    await check('raw-byte Svix verification covers official reference, default clock, stale/tampered/multiple signatures',async()=>{
      const payload=Buffer.from('{"event_type":"ping","data":{"success":true}}');
      assert.equal(verifyWebhook(payload,{'svix-id':'msg_loFOjxBNrRLzqYUf','svix-timestamp':'1731705121','svix-signature':'v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0='},'whsec_plJ3nmyCDGBKInavdOK15jsl',()=>1731705121000),true);
      const body=Buffer.from('{ "type": "email.delivered" }'),headers=signature(body);
      assert.equal(verifyWebhook(body,headers,env.JEMLIO_CONVERSATION_WEBHOOK_SECRET,now),true);
      assert.equal(verifyWebhook(Buffer.from(body.toString().replace(' ','')),headers,env.JEMLIO_CONVERSATION_WEBHOOK_SECRET,now),false);
      assert.equal(verifyWebhook(body,{...headers,'svix-timestamp':String(Math.floor(clock/1000)-301)},env.JEMLIO_CONVERSATION_WEBHOOK_SECRET,now),false);
      assert.equal(verifyWebhook(body,{...headers,'svix-signature':'v2,irrelevant '+headers['svix-signature']},env.JEMLIO_CONVERSATION_WEBHOOK_SECRET,now),true);
      const realTime=signature(body,'msg_default_clock',Date.now());assert.equal(verifyWebhook(body,realTime,env.JEMLIO_CONVERSATION_WEBHOOK_SECRET),true);
      assert.equal(webhookKey('whsec_invalid'),null);assert.equal(key('invalid'),null);
      const encrypted=encrypt({secret:'synthetic'},key(env.JEMLIO_CONVERSATION_ENCRYPTION_KEY),'alpha');assert.deepEqual(decrypt(encrypted,key(env.JEMLIO_CONVERSATION_ENCRYPTION_KEY),'alpha'),{secret:'synthetic'});
      assert.throws(()=>decrypt(encrypted,key(env.JEMLIO_CONVERSATION_ENCRYPTION_KEY),'beta'));
    });
    const first=await entry();let approved;
    await check('drafts are tenant scoped, template only, revision guarded and cannot send without exact explicit approval',async()=>{
      await denied(()=>store.read(beta,first.id),'not_found');const current=await store.read(alpha,first.id);assert.equal(typeof current.revision,'string');assert.equal(current.templates.length,3);
      const d=await draft(first);approved=approval(d);assert.equal(calls.length,0);
      await denied(()=>store.send(alpha,first.id,{...approved,approved:false},'owner'),'approval_required');
      await denied(()=>store.send(alpha,first.id,{...approved,recipient:'other@example.invalid'},'owner'),'recipient_mismatch');
      await denied(()=>store.send(alpha,first.id,{...approved,body:'changed after approval'},'owner'),'conflict');
      await denied(()=>store.send(alpha,first.id,{...approved,revision:'999'},'owner'),'conflict');
      await denied(()=>store.draft(alpha,first.id,{revision:d.revision,template:'arbitrary-ai-action',body:'Do something'},'owner'),'invalid_request');
    });
    await check('concurrent approval double-clicks create one immutable queued message and no synchronous send',async()=>{
      const results=await Promise.all(Array.from({length:8},()=>store.send(alpha,first.id,approved,'test-owner')));assert.equal(results.filter(r=>r.duplicate===false).length,1);assert.equal(calls.length,0);
      const record=(await pool.query('SELECT * FROM jemlio_conversation_messages WHERE id=$1',[approved.draftId])).rows[0];assert.equal(record.state,'queued');assert.ok(record.encrypted_payload);assert.equal(record.encrypted_payload.includes('/reply/#'),false);
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM jemlio_conversation_tokens WHERE request_id=$1',[first.id])).rows[0].n,1);
      await denied(()=>draft(first),'conflict');
    });
    await check('concurrent workers use one lease and one stable provider key; public view never leaks draft/recipient/token',async()=>{
      const secondRuntime=createConversations({env,pool,cfg,now,sendMessage:send});await Promise.all([runtime.tick(),secondRuntime.tick()]);await secondRuntime.close();assert.equal(calls.length,1);
      const snapshot=await store.read(alpha,first.id);assert.equal(snapshot.messages.find(m=>m.id===approved.draftId).state,'accepted');
      const token=tokenFor(approved.draftId);assert.ok(token);const publicData=await store.publicRead(token);assert.equal(typeof publicData.revision,'string');assert.equal(publicData.messages.length,2);
      const serialized=JSON.stringify(publicData);assert.equal(serialized.includes(first.input.email),false);assert.equal(serialized.includes(token),false);assert.equal(serialized.includes('approved_by'),false);
      const d=await draft(first,'INTERNAL UNSENT DRAFT');assert.equal(JSON.stringify(await store.publicRead(token)).includes('INTERNAL UNSENT DRAFT'),false);
      await store.cancel(alpha,first.id,{revision:d.revision,messageId:d.draftId},'owner');await runtime.tick();assert.equal(calls.length,1);
    });
    await check('customer reply retries persist once, invalidate stale draft and workspace revision, and mark due review',async()=>{
      const token=tokenFor(approved.draftId),pending=await draft(first),before=await ws.row(alpha,first.id);const oldRevision=require('../lib/workspace/store').present(before,clock).revision;
      const publicData=await store.publicRead(token),input={token,submissionId:randomUUID(),message:'Ja, det passer. <script>untrusted</script>',revision:publicData.revision};
      const replies=await Promise.all(Array.from({length:6},()=>store.respond(input)));assert.equal(replies.filter(r=>!r.duplicate).length,1);assert.ok(replies.every(r=>typeof r.conversation.revision==='string'));
      await denied(()=>store.respond({...input,message:'different same ID'}),'submission_conflict');
      await denied(()=>store.send(alpha,first.id,approval(pending),'owner'),'conflict');
      const after=require('../lib/workspace/store').present(await ws.row(alpha,first.id),clock);assert.notEqual(after.revision,oldRevision);assert.equal(after.followup.action,'review');
      assert.ok((await ws.list(alpha,{view:'due'})).items.some(r=>r.id===first.id));
      assert.equal((await pool.query("SELECT state FROM jemlio_conversation_messages WHERE id=$1",[pending.draftId])).rows[0].state,'stale');
    });
    await check('reply on an already booked enquiry enters due queue and results without implying a new booking or sale',async()=>{
      const row=await entry({booked:true}),q=await queue(row);await runtime.tick();const token=tokenFor(q.input.draftId),view=await store.publicRead(token);
      await store.respond({token,submissionId:randomUUID(),message:'Kan vi avklare en detalj?',revision:view.revision});
      assert.ok((await ws.list(alpha,{view:'due'})).items.some(r=>r.id===row.id));assert.ok((await booking.due({client:alpha})).due.some(r=>r.receipt===row.id));
      assert.ok((await ws.results({client:alpha})).totals.due>=2);assert.equal((await ws.row(alpha,row.id)).outcome,'new');
    });
    await check('an incoming reply invalidates unattempted queued follow-up before provider I/O',async()=>{
      const q=await queue(first),token=tokenFor(approved.draftId),view=await store.publicRead(token),before=calls.length;
      await store.respond({token,submissionId:randomUUID(),message:'Jeg har et nytt spørsmål.',revision:view.revision});await runtime.tick();assert.equal(calls.length,before);
      assert.equal((await store.read(alpha,first.id)).messages.find(m=>m.id===q.input.draftId).state,'stale');
    });
    await check('workspace and operator closure revoke old drafts, queues and tokens permanently across reopening',async()=>{
      const row=await entry(),q=await queue(row),before=calls.length;const item=require('../lib/workspace/store').present(await ws.row(alpha,row.id),clock);
      await ws.update(alpha,row.id,{revision:item.revision,outcome:'lost'},'owner');await runtime.tick();assert.equal(calls.length,before);
      assert.equal((await store.read(alpha,row.id)).messages.find(m=>m.id===q.input.draftId).state,'stale');
      const saved=await draft(first);await ops.setOutcome({client:alpha,receipt:first.id,outcome:'lost',apply:true});await denied(()=>store.publicRead(tokenFor(approved.draftId)),'reply_unavailable');
      await ops.setOutcome({client:alpha,receipt:first.id,outcome:'new',apply:true});await denied(()=>store.send(alpha,first.id,approval(saved),'owner'),'conflict');
      await denied(()=>store.publicRead(tokenFor(approved.draftId)),'reply_unavailable');
    });
    await check('uncertain attempts retry identical ciphertext payload and key; subsequent permanent error remains protected',async()=>{
      const row=await entry(),q=await queue(row),before=calls.length;sendMode='uncertain';await runtime.tick();assert.equal(calls.length,before+1);clock+=60000;sendMode='success';await runtime.tick();assert.deepEqual(calls[before],calls[before+1]);
      const uncertain=await entry(),u=await queue(uncertain);sendMode='uncertain';await runtime.tick();clock+=60000;sendMode='permanent';await runtime.tick();sendMode='success';
      assert.equal((await store.read(alpha,uncertain.id)).messages.find(m=>m.id===u.input.draftId).state,'needs_review');await denied(()=>draft(uncertain),'conflict');
      assert.equal((await ops.deleteRequests({client:alpha,receipt:uncertain.id,apply:true})).deletedRequests,0);
      assert.equal((await store.read(alpha,row.id)).messages.find(m=>m.id===q.input.draftId).state,'accepted');
    });
    await check('idempotency conflicts and expired uncertain retry windows require manual review without a new send',async()=>{
      const a=await entry(),qa=await queue(a);sendMode='conflict';await runtime.tick();sendMode='success';assert.equal((await store.read(alpha,a.id)).messages.find(m=>m.id===qa.input.draftId).state,'needs_review');
      const b=await entry(),qb=await queue(b);sendMode='uncertain';await runtime.tick();clock+=24*3600000;const before=calls.length;sendMode='success';await runtime.tick();assert.equal(calls.length,before);
      assert.equal((await store.read(alpha,b.id)).messages.find(m=>m.id===qb.input.draftId).state,'needs_review');
    });
    await check('sender rotation and revoked tenant never dispatch frozen queued customer mail',async()=>{
      const row=await entry(),q=await queue(row),before=calls.length;
      const rotated=createConversations({env:{...env,JEMLIO_CONVERSATION_SEND_CONFIG:JSON.stringify({[alpha]:{enabled:true,from:'new@example.invalid'}})},pool,cfg,now,sendMessage:send});await rotated.tick();await rotated.close();assert.equal(calls.length,before);
      assert.equal((await store.read(alpha,row.id)).messages.find(m=>m.id===q.input.draftId).state,'needs_review');
      const disabled=await entry({client:beta});await queue(disabled);cfg.tenants[beta].conversationsEnabled=false;await runtime.tick();assert.equal(calls.length,before);cfg.tenants[beta].conversationsEnabled=true;
    });
    await check('out-of-order callback ledger is monotonic and suppresses the saved recipient only in its tenant',async()=>{
      const row=await entry(),q=await queue(row),providerId=randomUUID();
      await store.deliveryEvent({eventId:'msg_early_'+suffix,providerId,kind:'bounced'});
      const early=createConversations({env,pool,cfg,now,sendMessage:async input=>{calls.push(structuredClone(input));return {providerId};}});await early.tick();await early.close();
      assert.equal((await store.read(alpha,row.id)).messages.find(m=>m.id===q.input.draftId).state,'bounced');
      await store.deliveryEvent({eventId:'msg_late_delivered_'+suffix,providerId,kind:'delivered'});await store.reconcileEvents();assert.equal((await store.read(alpha,row.id)).messages.find(m=>m.id===q.input.draftId).state,'bounced');
      const duplicate=await store.deliveryEvent({eventId:'msg_early_'+suffix,providerId,kind:'bounced'});assert.equal(duplicate.duplicate,true);
      await denied(()=>store.deliveryEvent({eventId:'msg_early_'+suffix,providerId,kind:'delivered'}),'submission_conflict');
      const same=await entry({recipient:row.input.email});assert.equal((await store.read(alpha,same.id)).sendUnavailableReason,'recipient_suppressed');await denied(()=>draft(same),'recipient_suppressed');
      const other=await entry({client:beta,recipient:row.input.email});assert.equal((await store.read(beta,other.id)).canSend,true);
      await store.deliveryEvent({eventId:'msg_complained_'+suffix,providerId,kind:'complained'});await store.reconcileEvents();assert.equal((await store.read(alpha,row.id)).messages.find(m=>m.id===q.input.draftId).state,'complained');
    });
    await check('committed bounce ledger blocks next message even before reconciliation batch',async()=>{
      const row=await entry(),q=await queue(row);await runtime.tick();const message=(await pool.query('SELECT * FROM jemlio_conversation_messages WHERE id=$1',[q.input.draftId])).rows[0];
      const next=await queue(row);await store.deliveryEvent({eventId:'msg_unapplied_'+suffix,providerId:message.provider_id,kind:'bounced'});const before=calls.length;
      const claim=await store.claimNext();assert.equal(claim.id,next.input.draftId);await store.dispatch(claim,send);assert.equal(calls.length,before);
      // Repeated delivered callbacks on already-delivered rows cannot occupy the
      // worker's first batch forever. Only rows needing a higher rank are chosen.
      await store.reconcileEvents();assert.equal((await store.read(alpha,row.id)).messages.find(m=>m.id===q.input.draftId).state,'bounced');
    });
    await check('retention protects queued/uncertain mail, cancels safely, cascades accepted history and tombstones the enquiry',async()=>{
      const row=await entry(),q=await queue(row);assert.equal((await ops.deleteRequests({client:alpha,receipt:row.id,apply:true})).deletedRequests,0);
      const view=await store.read(alpha,row.id);await store.cancel(alpha,row.id,{revision:view.revision,messageId:q.input.draftId},'owner');assert.equal((await ops.deleteRequests({client:alpha,receipt:row.id,apply:true})).deletedRequests,1);
      await denied(()=>ws.create(alpha,row.input,'owner'),'submission_removed');
      const accepted=await entry(),a=await queue(accepted);await runtime.tick();const token=tokenFor(a.input.draftId);assert.ok(token);
      assert.equal((await ops.deleteRequests({client:alpha,receipt:accepted.id,apply:true})).deletedRequests,1);await denied(()=>store.publicRead(token),'reply_unavailable');
      assert.equal((await pool.query('SELECT count(*)::int AS n FROM jemlio_conversation_messages WHERE request_id=$1',[accepted.id])).rows[0].n,0);
    });
    await check('HTTP APIs enforce owner auth/CSRF/tenant and private-link origin; callbacks verify raw bytes before durable receipt',async()=>{
      workspace=createWorkspaceRuntime({env,pool,now});const app=express();app.use('/api/conversation-events',runtime.webhookRouter);app.use('/api/replies',runtime.publicRouter);app.use('/api/workspace',workspace.router);
      server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const url=`http://127.0.0.1:${server.address().port}`;
      const request=async(path,{body,headers={},method=body?'POST':'GET'}={})=>{const response=await fetch(url+path,{method,headers:{...(body?{'Content-Type':'application/json',Origin:origin}:{}),...headers},...(body?{body:typeof body==='string'?body:JSON.stringify(body)}:{})});const data=await response.json();return {response,data};};
      const row=await entry();assert.equal((await request(`/api/workspace/enquiries/${row.id}/conversation`)).response.status,401);
      const login=await request('/api/workspace/login',{body:{key:ownerKey}});assert.equal(login.response.status,200);assert.equal(login.data.features.conversations,true);
      const cookie=login.response.headers.get('set-cookie').split(';')[0],headers={Cookie:cookie,Origin:origin,'x-jemlio-csrf':login.data.csrf};
      const view=await request(`/api/workspace/enquiries/${row.id}/conversation`,{headers});assert.equal(typeof view.data.revision,'string');
      assert.equal((await request(`/api/workspace/enquiries/${row.id}/conversation/draft`,{headers:{Cookie:cookie},body:{revision:view.data.revision,template:'question'}})).response.status,403);
      const d=await request(`/api/workspace/enquiries/${row.id}/conversation/draft`,{headers,body:{revision:view.data.revision,template:'question',body:'Exact saved draft'}});assert.equal(d.response.status,200);
      const accepted=await request(`/api/workspace/enquiries/${row.id}/conversation/send`,{headers,body:approval(d.data)});assert.equal(accepted.response.status,200);await runtime.tick();
      const token=tokenFor(d.data.draftId);assert.equal((await request('/api/replies/read',{body:{token},headers:{Origin:'https://attacker.invalid'}})).response.status,403);
      const read=await request('/api/replies/read',{body:{token}});assert.equal(read.response.status,200);assert.equal(typeof read.data.revision,'string');assert.equal(read.response.headers.get('cache-control'),'no-store');
      const reply={token,submissionId:randomUUID(),message:'Et svar fra kundesiden',revision:read.data.revision};assert.equal((await request('/api/replies/respond',{body:reply})).data.accepted,true);assert.equal((await request('/api/replies/respond',{body:reply})).data.duplicate,true);
      const providerId=ids.get('jemlio-conversation/'+d.data.draftId),body=JSON.stringify({type:'email.delivered',data:{email_id:providerId}}),signed=signature(Buffer.from(body));
      assert.equal((await request('/api/conversation-events',{body,headers:signed})).response.status,200);
      assert.equal((await request('/api/conversation-events',{body:body+' ',headers:signed})).response.status,401);
      assert.equal((await store.read(alpha,row.id)).messages.find(m=>m.id===d.data.draftId).state,'delivered');
      const failedStore=store.deliveryEvent;store.deliveryEvent=async()=>{throw Error('synthetic storage down');};
      const body2=JSON.stringify({type:'email.bounced',data:{email_id:providerId}});assert.equal((await request('/api/conversation-events',{body:body2,headers:signature(Buffer.from(body2))})).response.status,503);store.deliveryEvent=failedStore;
    });
    await check('expired token and tenant revocation fail closed without exposing record metadata',async()=>{
      const row=await entry(),q=await queue(row);await runtime.tick();const token=tokenFor(q.input.draftId);assert.ok(await store.publicRead(token));
      cfg.tenants[alpha].conversationsEnabled=false;await denied(()=>store.publicRead(token),'reply_unavailable');cfg.tenants[alpha].conversationsEnabled=true;
      assert.ok(await store.publicRead(token));clock+=15*86400000;await denied(()=>store.publicRead(token),'reply_unavailable');
    });
    if(realPostgres)await check('real PostgreSQL parent lock serializes provider dispatch with closure and stale approval races',async()=>{
      const row=await entry(),q=await queue(row),claim=await store.claimNext();assert.equal(claim.id,q.input.draftId);
      let entered,release;const enteredPromise=new Promise(r=>entered=r),releasePromise=new Promise(r=>release=r);
      const dispatch=store.dispatch(claim,async input=>{entered();await releasePromise;return send(input);});let closing;
      try{
        await Promise.race([enteredPromise,dispatch.then(()=>{throw Error('dispatch ended before the synthetic provider was entered');})]);
        const before=require('../lib/workspace/store').present(await ws.row(alpha,row.id),clock);let finished=false;
        closing=ws.update(alpha,row.id,{revision:before.revision,outcome:'lost'},'owner').then(value=>{finished=true;return value;});closing.catch(()=>{});
        let blocked=false;for(let i=0;i<100;i++){const result=await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT id FROM nova_capture_requests%'");if(result.rows[0].n){blocked=true;break;}await new Promise(r=>setTimeout(r,10));}
        assert.equal(blocked,true);assert.equal(finished,false);
      }finally{release();await Promise.allSettled([dispatch,...(closing?[closing]:[])]);}
      await dispatch;await closing;
      await denied(()=>store.publicRead(tokenFor(q.input.draftId)),'reply_unavailable');
    });
    console.log(`Enquiry conversations: ${checks} grouped checks passed (${realPostgres?'real PostgreSQL':'PGlite'}). Only synthetic provider functions used.`);
  }finally{await runtime.close();if(workspace)await workspace.close();if(server)await new Promise(resolve=>server.close(resolve));
    await pool.query('DELETE FROM nova_capture_requests WHERE client=ANY($1::text[])',[[alpha,beta]]);
    await pool.query('DELETE FROM jemlio_conversation_suppressions WHERE client=ANY($1::text[])',[[alpha,beta]]);
  }
}
async function main(){
  const {PGlite}=require('@electric-sql/pglite'),db=new PGlite();let tail=Promise.resolve();
  async function acquire(){let release;const previous=tail;tail=new Promise(r=>release=r);await previous;return release;}
  const query=(sql,args)=>args===undefined?db.exec(sql).then(rows=>rows.at(-1)):db.query(sql,args);
  const pool={async query(sql,args){const release=await acquire();try{return await query(sql,args);}finally{release();}},async connect(){const release=await acquire();return {query,release};}};
  try{await runTests({pool});}finally{await db.close();}
}
module.exports={runTests};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
