'use strict';
const assert=require('node:assert/strict');
const {randomUUID,createHmac}=require('node:crypto');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const express=require('express');
const {PGlite}=require('@electric-sql/pglite');
const {PgStore}=require('../lib/capture/store');
const {CalendarStore}=require('../lib/calendar-sync/store');
const {WorkspaceStore}=require('../lib/workspace/store');
const {createCalendarReader}=require('../lib/calendar-sync/provider');
const {createCalendarSyncRuntime,configuration,verify,eventFrom}=require('../lib/calendar-sync/runtime');
const eventType='https://api.calendly.com/event_types/synthetic';
const event=id=>'https://api.calendly.com/scheduled_events/synthetic-'+id;
const invitee=id=>event(id)+'/invitees/guest0001';
let clock=Date.UTC(2026,8,25,10),checks=0;
const now=()=>clock,slot=()=>new Date(clock+86400000).toISOString();
const secret='synthetic-signing-key-'.repeat(3);
const tenant={enabled:true,credentialEnv:'JEMLIO_CALENDLY_ALPHA',signingKeyEnv:'JEMLIO_CALENDLY_WEBHOOK_ALPHA',eventTypes:[eventType]};
const env={JEMLIO_CALENDAR_SYNC_ENABLED:'true',JEMLIO_CALENDAR_SYNC_CONFIG:JSON.stringify({alpha:tenant}),JEMLIO_CALENDLY_ALPHA:'synthetic-only-token',JEMLIO_CALENDLY_WEBHOOK_ALPHA:secret};
const signed=(raw,t=Math.floor(clock/1000),key=secret)=>'t='+t+',v1='+createHmac('sha256',key).update(t+'.').update(raw).digest('hex');
const body=(id,extra={})=>Buffer.from(JSON.stringify({event:'invitee.canceled',payload:{uri:invitee(id),...extra}}));
const result=(id,time,status='confirmed')=>({providerId:invitee(id),slot:time,status,cancelUrl:null,rescheduleUrl:null,aliases:[invitee(id)]});
async function check(name,fn){await fn();console.log(`ok ${++checks} - ${name}`);}
async function main(){
 const db=new PGlite();let tail=Promise.resolve(),server,runtime;
 async function acquire(){let release;const previous=tail;tail=new Promise(r=>release=r);await previous;return release;}
 const query=(sql,args)=>args===undefined?db.exec(sql).then(r=>r.at(-1)):db.query(sql,args);
 const pool={async query(sql,args){const release=await acquire();try{return await query(sql,args);}finally{release();}},async connect(){const release=await acquire();return {query,release};}};
 const store=new CalendarStore({pool,now}),workspace=new WorkspaceStore({pool,now}),capture=new PgStore({pool});
 async function entry(client='alpha',status='confirmed'){
  const id=randomUUID();await capture.create({client,receipt:id,submissionId:randomUUID(),payloadHash:randomUUID(),createdAt:clock,data:{name:'Synthetic private name',email:'nobody@example.invalid',service:'visit',consent:true},notification:{to:['owner@example.invalid'],subject:'Never sent',text:'Synthetic'}});
  const claim=await store.claimBooking({client,receipt:id,eventType,slot:slot()});
  if(status!=='attempting')await store.finish(claim.row,{status,providerId:status==='confirmed'?invitee(id):null});
  return {id,client,slot:slot(),attempt:claim.row.attempt_id};
 }
 // CalendarStore.claim is a worker claim; booking creation uses the inherited implementation.
 store.claimBooking=require('../lib/booking/store').BookingStore.prototype.claim.bind(store);
 const enqueue=(r,extra={})=>store.enqueue(r.client,eventFrom(body(r.id,extra),r.client),[eventType]);
 const work=async(r,status='confirmed')=>{const job=await store.claim([r.client]);assert.equal(job.request_id,r.id);await store.process(job,{read:async()=>result(r.id,r.slot,status)},[eventType]);};
 try{
  await check('signed raw bytes reject tampering, old/future timestamps and duplicated headers',async()=>{const raw=body('test');assert.equal(verify(raw,signed(raw),secret,clock),true);for(const header of [signed(raw,Math.floor(clock/1000)-181),signed(raw,Math.floor(clock/1000)+31),signed(raw)+' ,t=1234567890',signed(raw).replace('v1=','v2=')])assert.equal(verify(raw,header,secret,clock),false);assert.equal(verify(Buffer.concat([raw,Buffer.from(' ')]),signed(raw),secret,clock),false);});
  await check('configuration requires separate tenant signing keys and event allowlists',async()=>{assert.ok(configuration(env));for(const cfg of [{alpha:{...tenant,eventTypes:[]}},{alpha:tenant,beta:tenant},{alpha:{...tenant,enabled:false}}])assert.equal(configuration({...env,JEMLIO_CALENDAR_SYNC_CONFIG:JSON.stringify(cfg)}),null);});
  await check('explicit schema is idempotent and no startup DDL runs',async()=>{assert.equal(await store.ready(),false);await capture.initialize();for(const kind of ['booking','workspace','calendar-sync','calendar-sync'])await pool.query(readFileSync(join(__dirname,'../lib',kind,'schema.sql'),'utf8'));assert.equal(await store.ready(),true);});
  await check('unknown meetings and other businesses cannot enqueue or import contacts',async()=>{const b=await entry('beta');assert.equal((await store.enqueue('alpha',eventFrom(body(b.id),'alpha'),[eventType])).accepted,false);assert.equal((await store.enqueue('alpha',eventFrom(body('unknown'),'alpha'),[eventType])).accepted,false);assert.equal((await pool.query('SELECT * FROM jemlio_calendar_jobs')).rows.length,0);});
  await check('duplicate notifications are durable, coalesced and contain no contact data',async()=>{const r=await entry();assert.equal((await enqueue(r)).accepted,true);assert.equal((await enqueue(r)).duplicate,true);const q=(await pool.query('SELECT * FROM jemlio_calendar_jobs')).rows;assert.equal(q.length,1);assert.equal(String(q[0].generation),'1');assert.equal(JSON.stringify(q).includes('nobody@'),false);assert.equal((await workspace.list('alpha',{view:'calendar'})).items[0].id,r.id);await work(r,'cancelled');assert.equal((await store.read('alpha',r.id)).calendar_state,'synced');assert.equal((await workspace.list('alpha',{view:'cancelled'})).items[0].id,r.id);assert.equal((await store.report({client:'alpha'})).upcoming,0);});
  await check('opaque attempt tracking recovers an uncertain booking without another create',async()=>{const r=await entry('alpha','needs_review');await enqueue(r,{tracking:{utm_content:'jemlio:'+r.attempt}});await work(r);assert.equal((await store.read('alpha',r.id)).status,'confirmed');});
  await check('early webhook waits for the booking response and survives process restart',async()=>{const r=await entry('alpha','attempting');await enqueue(r,{tracking:{utm_content:'jemlio:'+r.attempt}});assert.equal(await store.claim(['alpha']),null);clock+=31000;await store.finish(await store.read('alpha',r.id),{status:'needs_review'});const restarted=new CalendarStore({pool,now}),job=await restarted.claim(['alpha']);assert.equal(job.request_id,r.id);await restarted.process(job,{read:async()=>result(r.id,r.slot)},[eventType]);assert.equal((await store.read('alpha',r.id)).status,'confirmed');});
  await check('new event during a provider read prevents stale results from being committed',async()=>{const r=await entry();await enqueue(r);const job=await store.claim(['alpha']);await store.process(job,{read:async()=>{await enqueue(r,{rescheduled:true});return result(r.id,r.slot,'cancelled');}},[eventType]);assert.equal((await store.read('alpha',r.id)).status,'confirmed');assert.equal((await store.read('alpha',r.id)).calendar_state,'pending');clock+=1100;await work(r,'cancelled');});
  await check('unavailable reads retry then park visibly; scoped manual retry is explicit',async()=>{const r=await entry();await enqueue(r);for(let i=0;i<6;i++){const j=await store.claim(['alpha']);assert.equal(j.request_id,r.id);await store.process(j,{read:async()=>{throw new Error('Do not persist sensitive provider text');}},[eventType]);clock+=3600001;}assert.equal((await store.read('alpha',r.id)).calendar_state,'attention');const q=(await pool.query('SELECT * FROM jemlio_calendar_jobs WHERE request_id=$1',[r.id])).rows[0];assert.equal(q.available_at,null);assert.equal(q.last_error,'calendar_unavailable');await assert.rejects(store.retryManually('beta',r.id,{apply:true}),/request_not_found/);await store.retryManually('alpha',r.id);assert.equal(await store.claim(['alpha']),null);await store.retryManually('alpha',r.id,{apply:true});await work(r);});
  await check('historical aliases keep delayed reschedule notifications attached to the same enquiry',async()=>{const r=await entry();await enqueue(r);let j=await store.claim(['alpha']);const moved=result(r.id+'-new',new Date(Date.parse(r.slot)+3600000).toISOString());moved.aliases.unshift(invitee(r.id));await store.process(j,{read:async()=>moved},[eventType]);await enqueue(r,{rescheduled:true});j=await store.claim(['alpha']);await store.process(j,{read:async input=>{assert.equal(input.providerId,moved.providerId);assert.equal(input.slot,moved.slot);return moved;}},[eventType]);assert.equal((await store.read('alpha',r.id)).provider_id,moved.providerId);assert.equal((await pool.query('SELECT * FROM jemlio_bookings WHERE request_id=$1',[r.id])).rows.length,1);});
  await check('completed attendance is preserved and contradictory cancellation needs review',async()=>{const r=await entry();await pool.query("UPDATE jemlio_bookings SET status='completed' WHERE request_id=$1",[r.id]);await enqueue(r);await work(r);assert.equal((await store.read('alpha',r.id)).status,'completed');await enqueue(r,{cancelled:true});await work(r,'cancelled');assert.equal((await store.read('alpha',r.id)).status,'completed');assert.equal((await store.read('alpha',r.id)).calendar_state,'attention');await pool.query('DELETE FROM nova_capture_requests WHERE id=$1',[r.id]);for(const table of ['jemlio_calendar_jobs','jemlio_calendar_receipts','jemlio_calendar_aliases'])assert.equal((await pool.query('SELECT * FROM '+table+' WHERE request_id=$1',[r.id])).rows.length,0);});
  await check('upcoming and past views sort by appointment time and remain tenant scoped',async()=>{const rows=(await workspace.list('alpha',{view:'upcoming'})).items;assert.ok(rows.length>=2);assert.ok(rows.every(r=>r.booking.status==='confirmed'&&Date.parse(r.booking.slot)>=clock));assert.deepEqual(rows.map(r=>Date.parse(r.booking.slot)),rows.map(r=>Date.parse(r.booking.slot)).sort((a,b)=>a-b));assert.equal((await workspace.list('beta',{view:'upcoming'})).items.length,1);clock+=3*86400000;assert.equal((await workspace.list('alpha',{view:'upcoming'})).items.length,0);assert.ok((await workspace.list('alpha',{view:'past'})).items.length>=2);});
  await check('provider follows verified reschedule chain with only GETs and safe management URLs',async()=>{
   const time=slot(),later=new Date(Date.parse(time)+3600000).toISOString(),map={};
   map[invitee('old')]={uri:invitee('old'),event:event('old'),email:'nobody@example.invalid',status:'canceled',rescheduled:true,new_invitee:invitee('new')};
   map[event('old')]={uri:event('old'),event_type:eventType,start_time:time,status:'canceled'};
   map[invitee('new')]={uri:invitee('new'),event:event('new'),email:'nobody@example.invalid',status:'active',old_invitee:invitee('old'),cancel_url:'https://evil.invalid'};
   map[event('new')]={uri:event('new'),event_type:eventType,start_time:later,status:'active'};
   const calls=[],reader=createCalendarReader({token:'synthetic-token',fetchFn:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({resource:map[url]})};}});
   const input={providerId:invitee('old'),eventType,slot:time,email:'NOBODY@example.invalid'};
   const r=await reader.read(input);assert.equal(r.providerId,invitee('new'));assert.equal(r.slot,later);assert.equal(r.cancelUrl,null);assert.deepEqual(r.aliases,[invitee('old'),invitee('new')]);assert.ok(calls.every(c=>c.options.method==='GET'&&c.options.redirect==='error'));
   for(const [uri,key,value]of[[invitee('new'),'old_invitee',invitee('other')],[invitee('new'),'email','other@example.invalid'],[event('new'),'event_type',eventType+'-other'],[event('old'),'start_time',later],[invitee('new'),'no_show',[]]]){const old=map[uri][key];map[uri][key]=value;await assert.rejects(reader.read(input),/calendar_mismatch/);map[uri][key]=old;}
   map[invitee('new')].status='canceled';assert.equal((await reader.read(input)).status,'cancelled');map[invitee('new')].rescheduled=true;map[invitee('new')].new_invitee=invitee('old');await assert.rejects(reader.read(input),/calendar_mismatch/);
  });
  await check('HTTP acknowledges a durable job before provider work; disabled and spoofed requests fail closed',async()=>{
   let reads=0;const r=await entry();runtime=createCalendarSyncRuntime({env,pool,now,providerFactory:()=>({read:async()=>{reads++;return result(r.id,r.slot);}})});
   const app=express();app.use('/api/calendar-sync',runtime.router);app.use('/disabled',createCalendarSyncRuntime({env:{}}).router);server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
   const raw=body(r.id),post=async(path,signature=signed(raw),data=raw)=>fetch('http://127.0.0.1:'+server.address().port+path,{method:'POST',headers:{'content-type':'application/json','Calendly-Webhook-Signature':signature},body:data});
   const path='/api/calendar-sync/calendly/alpha';assert.equal((await post('/disabled/calendly/alpha')).status,503);assert.equal((await post(path,'invalid')).status,401);assert.equal((await post('/api/calendar-sync/calendly/beta')).status,503);
   assert.equal((await post(path)).status,204);assert.equal(reads,0);assert.equal((await store.read('alpha',r.id)).calendar_state,'pending');await runtime.flush();assert.equal(reads,1);assert.equal((await store.read('alpha',r.id)).calendar_state,'synced');assert.equal((await post(path)).status,204);await runtime.flush();assert.equal(reads,1);
   const malformed=Buffer.from('{');assert.equal((await post(path,signed(malformed),malformed)).status,400);
  });
  console.log(`Calendar synchronization checks passed: ${checks}. Synthetic local data only; no external calls.`);
 }finally{if(runtime)await runtime.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}await db.close();}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
