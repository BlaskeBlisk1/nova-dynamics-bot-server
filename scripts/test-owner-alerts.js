'use strict';
const assert=require('node:assert/strict'),{readFileSync}=require('node:fs'),{join}=require('node:path'),{randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {AlertStore,osloDay}=require('../lib/owner-alerts/store');
const {createOwnerAlerts,config}=require('../lib/owner-alerts/runtime');
const {flushNotifications}=require('../lib/capture/notification');
const {WorkspaceStore}=require('../lib/workspace/store');
let checks=0;async function check(name,fn){await fn();console.log(`ok ${++checks} - ${name}`);}
async function main(){
 let db,pool;
 if(process.argv.includes('--postgres')){
   assert.equal(process.env.JEMLIO_THROWAWAY_DATABASE,'true');
   const url=new URL(process.env.JEMLIO_TEST_DATABASE_URL);assert.ok(['127.0.0.1','localhost'].includes(url.hostname));
   pool=new(require('pg').Pool)({connectionString:url.href,max:5});
 }else{
   db=new PGlite();let tail=Promise.resolve();async function acquire(){let release;const before=tail;tail=new Promise(r=>release=r);await before;return release;}
   const query=(sql,args)=>args===undefined?db.exec(sql).then(r=>r.at(-1)):db.query(sql,args);
   pool={async query(sql,args){const release=await acquire();try{return await query(sql,args);}finally{release();}},async connect(){const release=await acquire();return {query,release};}};
 }
 let clock=Date.UTC(2026,8,26,7),calls=[];const now=()=>clock;
 const workspace={origin:'https://workspace.example.invalid',tenants:{alpha:{enabled:true,offersEnabled:true},beta:{enabled:true,offersEnabled:true}}};
 const settings={alpha:{enabled:true,to:'owner-alpha@example.invalid',digestHour:9,startAt:new Date(clock).toISOString()}};
 const env={JEMLIO_WORKSPACE_ENABLED:'true',JEMLIO_OFFERS_ENABLED:'true',JEMLIO_OWNER_ALERTS_ENABLED:'true',JEMLIO_OWNER_ALERTS_FROM:'alerts@example.invalid',JEMLIO_OWNER_ALERTS_CONFIG:JSON.stringify(settings)};
 const send=async msg=>{calls.push(msg);return {providerId:'synthetic-'+calls.length};};
 const store=new AlertStore({pool,now}),ws=new WorkspaceStore({pool,now});
 const runtime=()=>createOwnerAlerts({env,pool,workspace,now,sendNotification:send});
 async function entry(client='alpha',responded=true,at=clock){const id=randomUUID(),offerId=randomUUID();await pool.query(`INSERT INTO nova_capture_requests(id,client,submission_id,payload_hash,data,created_at) VALUES($1,$2,$3,$4,$5,$6)`,[id,client,randomUUID(),'synthetic',{name:'Secret customer',email:'secret@example.invalid',message:'Private message'},new Date(clock-2*86400000)]);
   if(responded)await pool.query(`INSERT INTO jemlio_offers(id,request_id,version,token_hash,data,state,created_at,expires_at,responded_at,response) VALUES($1,$2,1,$3,$4,'responded',$5,$6,$5,'interested')`,[offerId,id,randomUUID(),{title:'Secret proposal',description:'Private scope',totalOre:12300},new Date(at),new Date(clock+86400000)]);
   await pool.query("INSERT INTO jemlio_followups(request_id,action,due_at,updated_at) VALUES($1,'review',$2,$2)",[id,new Date(clock-1000)]);return {id,offerId};}
 try{
   for(const part of ['capture','booking','workspace','owner-alerts','owner-alerts'])await pool.query(readFileSync(join(__dirname,'../lib',part,'schema.sql'),'utf8'));
   if(process.argv.includes('--postgres'))await pool.query('TRUNCATE nova_capture_requests CASCADE; TRUNCATE jemlio_owner_alerts');
   await check('disabled or invalid configuration performs no queries or sends',async()=>{
     const disabled=createOwnerAlerts({env:{},pool:{query(){throw Error('must not query');}},workspace,sendNotification:send});await disabled.tick();assert.deepEqual(await disabled.status('alpha'),{enabled:false});
     for(const changes of [{to:'bad\r\n@example.invalid'},{digestHour:24},{startAt:'yesterday'},{enabled:false}])assert.equal(config({...env,JEMLIO_OWNER_ALERTS_CONFIG:JSON.stringify({alpha:{...settings.alpha,...changes}})},workspace),null);
     assert.equal(config({...env,JEMLIO_OWNER_ALERTS_CONFIG:JSON.stringify({unknown:settings.alpha})},workspace),null);assert.equal(calls.length,0);
   });
   await check('Oslo digest keys handle winter, summer and repeated DST hours',async()=>{assert.equal(osloDay(Date.UTC(2026,0,1,8)).hour,9);assert.equal(osloDay(Date.UTC(2026,6,1,7)).hour,9);assert.deepEqual(osloDay(Date.UTC(2026,9,25,0,30)),osloDay(Date.UTC(2026,9,25,1,30)));});
   const a=await entry(),b=await entry('beta');await entry('alpha',true,clock-86400000);
   await check('concurrent collectors enqueue one event and one daily digest only for approved tenant',async()=>{
     const cfg=config(env,workspace).alpha;await Promise.all([store.collect('alpha',cfg),store.collect('alpha',cfg)]);
     const rows=(await pool.query('SELECT * FROM jemlio_owner_alerts')).rows;assert.equal(rows.length,2);assert.ok(rows.every(r=>r.client==='alpha'));assert.equal(rows.find(r=>r.kind==='response').offer_id,a.offerId);
     const body=JSON.stringify(rows.map(r=>r.notification));for(const secret of ['Secret customer','secret@example.invalid','Private message','Secret proposal','Private scope'])assert.equal(body.includes(secret),false);
     assert.match(body,/2 henvendelser/);assert.equal((await ws.results({client:'alpha'})).totals.due,2); // beta excluded; two alpha enquiries
   });
   await check('concurrent claimers lease different jobs; stale acknowledgements cannot overwrite',async()=>{
     const claims=await Promise.all([store.claimNext(),store.claimNext()]);assert.ok(claims.every(Boolean));assert.notEqual(claims[0].id,claims[1].id);assert.equal(await store.claimNext(),null);
     assert.equal(await store.finish({...claims[0],lock_token:randomUUID()},{status:'accepted'}),false);
     for(const c of claims)await store.finish(c,{status:'pending'});
   });
   await check('worker restart and repeated ticks do not duplicate provider submissions',async()=>{await runtime().tick();assert.equal(calls.length,2);await runtime().tick();assert.equal(calls.length,2);assert.ok(calls.every(c=>c.idempotencyKey.startsWith('jemlio-owner-alert/')));assert.equal((await runtime().status('alpha')).queue.accepted,2);assert.deepEqual(await runtime().status('beta'),{enabled:false});});
   await check('daily summary uses current queue and stays silent before scheduled time',async()=>{
     clock+=86400000;clock-=3600000;await runtime().tick();assert.equal(calls.length,2);clock+=3600000;await runtime().tick();assert.equal(calls.length,3);await runtime().tick();assert.equal(calls.length,3);
   });
   await check('recipient rotation holds frozen queued messages for review',async()=>{const c=await entry();await store.collect('alpha',config(env,workspace).alpha);const changed={...env,JEMLIO_OWNER_ALERTS_CONFIG:JSON.stringify({alpha:{...settings.alpha,to:'replacement@example.invalid'}})};await createOwnerAlerts({env:changed,pool,workspace,now,sendNotification:send}).tick();assert.equal(calls.length,3);assert.equal((await pool.query('SELECT status FROM jemlio_owner_alerts WHERE offer_id=$1',[c.offerId])).rows[0].status,'needs_review');});
   await check('closed tasks and removed enquiries do not dispatch queued reply alerts',async()=>{const c=await entry(),d=await entry();await store.collect('alpha',config(env,workspace).alpha);await pool.query("UPDATE jemlio_followups SET action='done' WHERE request_id=$1",[c.id]);await pool.query('DELETE FROM nova_capture_requests WHERE id=$1',[d.id]);await runtime().tick();assert.equal(calls.length,3);assert.equal((await pool.query('SELECT * FROM jemlio_owner_alerts WHERE offer_id=$1',[d.offerId])).rows.length,0);});
   await check('uncertain delivery reuses identical payload/key inside bounded retry window',async()=>{
     const c=await entry();await store.collect('alpha',config(env,workspace).alpha);const attempts=[];let fail=true;
     const flush=()=>flushNotifications({store,now,idempotencyPrefix:'jemlio-owner-alert',isTenantEnabled:()=>true,sendNotification:async x=>{attempts.push(x);if(fail)throw Object.assign(Error('uncertain'),{code:'network_uncertain',retryable:true});return {providerId:'synthetic-recovered'};}});
     await flush();assert.equal(attempts.length,1);clock+=60000;fail=false;await flush();assert.deepEqual(attempts[0],attempts[1]);assert.equal((await pool.query('SELECT status FROM jemlio_owner_alerts WHERE offer_id=$1',[c.offerId])).rows[0].status,'accepted');
     const d=await entry();await store.collect('alpha',config(env,workspace).alpha);fail=true;await flush();clock+=24*3600000;const before=attempts.length;await flush();assert.equal(attempts.length,before);assert.equal((await pool.query('SELECT status FROM jemlio_owner_alerts WHERE offer_id=$1',[d.offerId])).rows[0].status,'needs_review');
   });
   console.log(`Owner alert checks passed: ${checks}. Synthetic notifications only.`);
 }finally{if(db)await db.close();else await pool.end();}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
