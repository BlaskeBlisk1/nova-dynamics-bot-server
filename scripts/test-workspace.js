'use strict';
const assert=require('node:assert/strict');
const {randomUUID,randomBytes}=require('node:crypto');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const express=require('express');
const {PGlite}=require('@electric-sql/pglite');
const {PgStore}=require('../lib/capture/store');
const {WorkspaceStore,hash}=require('../lib/workspace/store');
const {createWorkspaceRuntime,config,COOKIE,TTL,IDLE}=require('../lib/workspace/runtime');
let checks=0;
async function check(name,fn){await fn();console.log(`ok ${++checks} - ${name}`);}
async function main(){
 const db=new PGlite();let tail=Promise.resolve(),server;
 async function acquire(){let release;const prior=tail;tail=new Promise(r=>release=r);await prior;return release;}
 const query=(sql,args)=>args===undefined?db.exec(sql).then(r=>r.at(-1)):db.query(sql,args);
 const pool={async query(sql,args){const release=await acquire();try{return await query(sql,args);}finally{release();}},async connect(){const release=await acquire();return {query,release};}};
 let clock=Date.UTC(2026,8,25,10);const now=()=>clock;
 const store=new WorkspaceStore({pool,now}),capture=new PgStore({pool});
 const origin='https://workspace.example.invalid',key=randomBytes(32).toString('base64url'),secondKey=randomBytes(32).toString('base64url');
 const tenants={alpha:{enabled:true,name:'Synthetic Alpha',keyHash:hash(key)},beta:{enabled:true,name:'Synthetic Beta',keyHash:hash(secondKey)}};
 const env={JEMLIO_WORKSPACE_ENABLED:'true',JEMLIO_WORKSPACE_ORIGIN:origin,JEMLIO_WORKSPACE_CONFIG:JSON.stringify(tenants)};
 let cookie='',csrf='';
 async function entry(client){const receipt=randomUUID();await capture.create({client,receipt,submissionId:randomUUID(),payloadHash:randomUUID(),createdAt:clock-2*86400000,data:{name:'Synthetic '+client,email:client+'@example.invalid',service:'visit',consent:true},notification:{to:['owner@example.invalid'],subject:'Not sent',text:'Synthetic'}});return receipt;}
 async function call(path,body,extra={}){const r=await fetch(`http://127.0.0.1:${server.address().port}/api/workspace${path}`,{method:body===undefined?'GET':'POST',headers:{Origin:origin,...(cookie?{Cookie:cookie}:{}),...(body===undefined?{}:{'Content-Type':'application/json','X-Jemlio-CSRF':csrf}),...extra},body:body===undefined?undefined:JSON.stringify(body)});return {status:r.status,headers:r.headers,data:await r.json()};}
 async function login(k=key){const r=await call('/login',{key:k});assert.equal(r.status,200);cookie=r.headers.get('set-cookie').split(';')[0];csrf=r.data.csrf;return r;}
 try{
  await check('configuration fails closed for duplicate keys, insecure origin and disabled tenants',async()=>{assert.ok(config(env));for(const changes of [{JEMLIO_WORKSPACE_ORIGIN:'http://example.invalid'},{JEMLIO_WORKSPACE_CONFIG:JSON.stringify({...tenants,beta:tenants.alpha})},{JEMLIO_WORKSPACE_CONFIG:JSON.stringify({alpha:{...tenants.alpha,enabled:false}})}])assert.equal(config({...env,...changes}),null);});
  await check('schema is explicit and idempotent',async()=>{assert.equal(await store.ready(),false);await capture.initialize();for(const file of ['booking','workspace','workspace'])await pool.query(readFileSync(join(__dirname,`../lib/${file}/schema.sql`),'utf8'));assert.equal(await store.ready(),true);});
  const a=await entry('alpha'),b=await entry('beta');
  const app=express();app.use('/api/workspace',createWorkspaceRuntime({env,pool,now}).router);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
  await check('unauthenticated reads disclose no contacts and cannot choose a tenant',async()=>{for(const path of ['/session','/enquiries','/report','/results']){const r=await call(path);assert.equal(r.status,401);assert.equal(r.headers.get('cache-control'),'no-store');assert.deepEqual(r.data,{error:'unauthorized'});}});
  await check('login rejects foreign origins and bad keys; secure opaque session is stored only hashed',async()=>{assert.equal((await call('/login',{key},{Origin:'https://evil.invalid'})).status,403);assert.equal((await call('/login',{key:'incorrect'})).status,401);const r=await login();assert.match(r.headers.get('set-cookie'),/Secure; HttpOnly; SameSite=Strict/);assert.match(cookie,new RegExp('^'+COOKIE+'=[a-f0-9]{64}$'));const rows=(await pool.query('SELECT * FROM jemlio_workspace_sessions')).rows;assert.equal(rows.length,1);assert.notEqual(rows[0].token_hash,cookie.split('=')[1]);assert.equal(JSON.stringify(rows).includes(key),false);});
  await check('tenant list and report stay scoped; other-business mutation is denied',async()=>{const r=await call('/enquiries?view=all');assert.equal(r.status,200);assert.deepEqual(r.data.items.map(r=>r.id),[a]);assert.equal((await call('/report')).data.enquiries,1);assert.equal((await call('/enquiries?client=beta')).status,400);const other=(await store.list('beta')).items[0];assert.equal((await call('/enquiries/'+b,{revision:other.revision,note:'No access'})).status,404);assert.equal((await store.row('beta',b)).note,'');});
  await check('mutations require origin and session CSRF; unknown endpoints never escape private router',async()=>{const r=(await store.list('alpha')).items[0];for(const headers of [{'X-Jemlio-CSRF':''},{Origin:''},{'Sec-Fetch-Site':'cross-site'}])assert.equal((await call('/enquiries/'+a,{revision:r.revision,note:'No change'},headers)).status,403);assert.equal((await call('/unknown')).status,404);assert.equal((await store.row('alpha',a)).note,'');});
  await check('notes and follow-up persist, stale revision conflicts and audit excludes note contents',async()=>{const before=(await store.list('alpha')).items[0];const r=await call('/enquiries/'+a,{revision:before.revision,note:'Synthetic note',outcome:'contacted',followup:{action:'callback',due:new Date(clock+3600000).toISOString()}});assert.equal(r.status,200);assert.equal(r.data.note,'Synthetic note');assert.equal(r.data.followup.overdue,false);assert.equal((await call('/enquiries/'+a,{revision:before.revision,note:'Stale'})).status,409);assert.equal((await store.row('alpha',a)).note,'Synthetic note');assert.equal((await store.list('alpha',{view:'due'})).items.length,0);const audit=(await pool.query('SELECT * FROM jemlio_workspace_audit')).rows;assert.equal(audit.length,1);assert.equal(JSON.stringify(audit).includes('Synthetic note'),false);});
  await check('sale value requires verified win and appointment alone never creates sales',async()=>{let r=(await store.list('alpha')).items[0];assert.equal((await call('/enquiries/'+a,{revision:r.revision,outcome:'won'})).status,400);assert.equal((await call('/enquiries/'+a,{revision:r.revision,amountOre:12500,verified:true})).status,409);const win=await call('/enquiries/'+a,{revision:r.revision,outcome:'won',amountOre:12500,verified:true});assert.equal(win.status,200);assert.equal(win.data.amountOre,12500);const report=(await call('/report')).data;assert.equal(report.won,1);assert.equal(report.sales_ore,'12500');assert.equal(report.confirmed,0);});
  await check('unresolved booking stays in due queue even when enquiry is closed',async()=>{const id=await entry('alpha');const claim=await store.claim({client:'alpha',receipt:id,eventType:'https://api.calendly.com/event_types/example',slot:new Date(clock+3600000).toISOString()});await store.finish(claim.row,{status:'needs_review'});let row=(await store.list('alpha',{view:'all'})).items.find(r=>r.id===id);await store.update('alpha',id,{revision:row.revision,outcome:'lost',followup:{action:'done'}},'test');row=(await store.list('alpha',{view:'due'})).items.find(r=>r.id===id);assert.equal(row.booking.status,'needs_review');assert.equal(row.followup.overdue,true);await assert.rejects(store.update('alpha',id,{revision:row.revision,appointmentStatus:'completed',verified:true},'test'),/confirmed_booking_required/);});
  const manualInput={submissionId:randomUUID(),source:'phone',name:'Synthetic Phone',email:'person@example.invalid',phone:'',service:'Reviewed service',message:'Synthetic request',due:new Date(clock+3600000).toISOString(),verified:true};let manualId;
  await check('manual intake validates reviewed contact details and requires CSRF and tenant scope',async()=>{
    for(const body of [{...manualInput,verified:false},{...manualInput,email:'',phone:''},{...manualInput,source:'submitted'},{...manualInput,client:'beta'},{...manualInput,name:'bad\nname'},{...manualInput,due:'2026-02-30T12:00:00Z'}])assert.equal((await call('/enquiries',body)).status,400);
    assert.equal((await call('/enquiries',manualInput,{'X-Jemlio-CSRF':''})).status,403);
    const r=await call('/enquiries',manualInput);assert.equal(r.status,200);manualId=r.data.id;assert.equal(r.data.sendsMessages,false);assert.equal(r.data.duplicate,false);
    assert.equal((await store.row('alpha',manualId)).data.consent,undefined);
    for(const table of ['nova_capture_outbox','nova_capture_crm_outbox','jemlio_bookings','jemlio_recorded_sales'])assert.equal((await pool.query('SELECT * FROM '+table+' WHERE request_id=$1',[manualId])).rows.length,0);
    const audit=(await pool.query('SELECT * FROM jemlio_workspace_audit WHERE request_id=$1',[manualId])).rows;assert.equal(audit.length,1);assert.equal(JSON.stringify(audit).includes('person@example.invalid'),false);
  });
  await check('manual retries return the same enquiry and conflicting payloads never overwrite it',async()=>{
    const repeat=await call('/enquiries',manualInput);assert.equal(repeat.status,200);assert.equal(repeat.data.id,manualId);assert.equal(repeat.data.duplicate,true);
    assert.equal((await call('/enquiries',{...manualInput,name:'Changed'})).status,409);assert.equal((await pool.query('SELECT * FROM jemlio_followups WHERE request_id=$1',[manualId])).rows.length,1);
  });
  await check('search is literal, private, paginated and tenant scoped',async()=>{
    const r=await call('/enquiries/search',{view:'all',search:'phone',page:0});assert.equal(r.status,200);assert.deepEqual(r.data.items.map(r=>r.id),[manualId]);assert.equal(r.data.items[0].source,'phone');
    assert.equal((await call('/enquiries/search',{view:'all',search:'%'})).data.items.length,0);
    assert.equal((await call('/enquiries/search',{search:'beta'})).data.items.length,0);
    for(const body of [{client:'beta'},{search:[]},{search:'x'.repeat(101)},{page:-1}])assert.equal((await call('/enquiries/search',body)).status,400);
  });
  await check('pilot results use registered-date cohorts and current verified outcomes, with no contact content',async()=>{
    const range='?since='+encodeURIComponent(new Date(clock-1).toISOString())+'&before='+encodeURIComponent(new Date(clock+1).toISOString());
    let r=await call('/results'+range);assert.equal(r.status,200);assert.equal(r.data.totals.enquiries,1);assert.equal(r.data.totals.won,0);assert.equal(r.data.totals.sales_ore,'0');assert.equal(r.data.sources[0].source,'phone');assert.equal(JSON.stringify(r.data).includes('person@example.invalid'),false);
    const row=(await store.list('alpha',{view:'all',search:'phone'})).items[0];await store.update('alpha',manualId,{revision:row.revision,outcome:'won',amountOre:123450,verified:true},'test');
    r=await call('/results'+range);assert.equal(r.data.totals.won,1);assert.equal(r.data.totals.valued_sales,1);assert.equal(r.data.totals.sales_ore,'123450');assert.equal(r.data.totals.due,0);assert.equal(r.data.sources[0].won,1);
    assert.equal((await call('/results?since='+encodeURIComponent(new Date(clock+1).toISOString()))).data.totals.enquiries,0);
    assert.equal((await call('/results?client=beta')).status,400);assert.equal((await call('/results?since=bad')).status,400);
  });
  await check('manual retention cascades private details and a delayed retry cannot recreate them',async()=>{
    const {CaptureOperations}=require('../lib/capture/operations'),ops=new CaptureOperations({pool,now});
    const dry=await ops.deleteRequests({client:'alpha',receipt:manualId});assert.equal((await ops.report({client:'alpha'})).notifications.not_requested,1);assert.equal(dry.eligibleRequests,1);assert.equal(dry.deletedRequests,0);
    const removed=await ops.deleteRequests({client:'alpha',receipt:manualId,apply:true});assert.equal(removed.deletedRequests,1);
    assert.equal((await call('/enquiries',manualInput)).status,410);
    for(const table of ['jemlio_followups','jemlio_recorded_sales','jemlio_workspace_audit'])assert.equal((await pool.query('SELECT * FROM '+table+' WHERE request_id=$1',[manualId])).rows.length,0);
  });
  await check('logout invalidates server session; session idle expiry and absolute expiry are enforced',async()=>{assert.equal((await call('/logout',{})).status,200);assert.equal((await call('/session')).status,401);await login();clock+=IDLE+1;assert.equal((await call('/session')).status,401);await login();await pool.query('UPDATE jemlio_workspace_sessions SET expires_at=$1',[new Date(clock-1)]);assert.equal((await call('/session')).status,401);assert.ok(TTL>IDLE);});
  await check('session credential rotation immediately revokes an existing session',async()=>{await login();await pool.query('UPDATE jemlio_workspace_sessions SET credential_hash=$1',[hash('old-key')]);assert.equal((await call('/session')).status,401);});
  await check('durable login rate limit applies to invalid attempts',async()=>{cookie='';await pool.query('DELETE FROM nova_capture_rate_limits');for(let i=0;i<10;i++)assert.equal((await call('/login',{key:'invalid'})).status,401);assert.equal((await call('/login',{key})).status,429);});
  console.log(`Workspace security and persistence checks passed: ${checks}. Synthetic data only.`);
 }finally{if(server)await new Promise(r=>server.close(r));await db.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
