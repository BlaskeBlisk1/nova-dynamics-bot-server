'use strict';
const express=require('express');
const {createHmac,createHash,timingSafeEqual}=require('node:crypto');
const {CLIENT,UUID}=require('../booking/store');
const {INVITEE,EVENT_TYPE,problem}=require('../booking/calendly');
const {PgStore}=require('../capture/store');
const {CalendarStore}=require('./store');
const {createCalendarReader}=require('./provider');
function configuration(env){
  try{
    const tenants=JSON.parse(env.JEMLIO_CALENDAR_SYNC_CONFIG||'{}'),secrets=new Set();
    if(!tenants||Array.isArray(tenants)||typeof tenants!=='object'||!Object.keys(tenants).length||Object.keys(tenants).length>100)return null;
    for(const [id,t]of Object.entries(tenants)){
      if(!CLIENT.test(id)||!t||t.enabled!==true||!/^JEMLIO_CALENDLY_[A-Z0-9_]+$/.test(t.credentialEnv||'')||
        !/^JEMLIO_CALENDLY_WEBHOOK_[A-Z0-9_]+$/.test(t.signingKeyEnv||'')||!Array.isArray(t.eventTypes)||!t.eventTypes.length||t.eventTypes.length>30||
        t.eventTypes.some(e=>typeof e!=='string'||!EVENT_TYPE.test(e)))return null;
      const key=env[t.signingKeyEnv],token=env[t.credentialEnv];
      if(typeof key!=='string'||key.length<32||key.length>256||/[\r\n]/.test(key)||secrets.has(key)||typeof token!=='string'||token.length<12||/[\r\n]/.test(token))return null;
      secrets.add(key);
    }
    return tenants;
  }catch{return null;}
}
function verify(raw,header,key,now){
  if(!Buffer.isBuffer(raw)||typeof header!=='string'||header.length>1024)return false;
  const parts=header.split(',').map(s=>s.trim().split('='));
  const times=parts.filter(([k])=>k==='t'),signatures=parts.filter(([k])=>k==='v1');
  if(times.length!==1||!/^\d{10}$/.test(times[0][1]||'')||!signatures.length||signatures.length>3||parts.some(p=>p.length!==2||!['t','v1'].includes(p[0])))return false;
  const at=Number(times[0][1])*1000;
  if(now-at>180000||at-now>30000)return false;
  const expected=createHmac('sha256',key).update(times[0][1]+'.').update(raw).digest();
  return signatures.some(([,s])=>/^[a-f0-9]{64}$/.test(s||'')&&timingSafeEqual(Buffer.from(s,'hex'),expected));
}
function eventFrom(raw,client){
  let body;try{body=JSON.parse(raw.toString('utf8'));}catch{throw problem('invalid_event');}
  if(!body||!['invitee.created','invitee.canceled'].includes(body.event))return null;
  const p=body.payload;
  if(!p||!INVITEE.test(p.uri||'')||[p.old_invitee,p.new_invitee].some(u=>u!==undefined&&u!==null&&!INVITEE.test(u)))throw problem('invalid_event');
  const content=p.tracking?.utm_content;
  const attempt=typeof content==='string'&&content.startsWith('jemlio:')&&UUID.test(content.slice(7))?content.slice(7):null;
  return {references:[p.uri,p.old_invitee,p.new_invitee].filter(Boolean),hint:p.old_invitee||p.uri,attempt,
    digest:createHash('sha256').update(client+'\n').update(raw).digest('hex')};
}
function createCalendarSyncRuntime({env=process.env,pool:injected,now=Date.now,providerFactory=createCalendarReader}={}){
  const cfg=configuration(env),enabled=env.JEMLIO_CALENDAR_SYNC_ENABLED==='true'&&cfg&&(injected||env.NOVA_DATABASE_URL);
  let pool=enabled?injected:null,owned=false;
  if(enabled&&!pool){pool=new(require('pg').Pool)({connectionString:env.NOVA_DATABASE_URL,max:2,connectionTimeoutMillis:5000,query_timeout:5000,idleTimeoutMillis:30000,allowExitOnIdle:true});pool.on('error',()=>console.error('Jemlio calendar: database unavailable.'));owned=true;}
  const store=pool?new CalendarStore({pool,now}):null,rate=pool?new PgStore({pool}):null,router=express.Router();
  const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  router.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});next();});
  router.post('/calendly/:client',express.raw({type:'application/json',limit:'64kb',inflate:false}),wrap(async(req,res)=>{
    if(!enabled||!Object.hasOwn(cfg,req.params.client))throw problem('sync_unavailable');
    const t=cfg[req.params.client];
    if(!verify(req.body,req.get('calendly-webhook-signature'),env[t.signingKeyEnv],now()))throw problem('invalid_signature');
    if(!await store.ready())throw problem('sync_unavailable');
    if(!await rate.consumeRateLimit('calendar:'+req.params.client,120,60000,now()))throw problem('rate_limited');
    const event=eventFrom(req.body,req.params.client);
    if(event)await store.enqueue(req.params.client,event,t.eventTypes);
    // Acknowledge only after the queue transaction commits. No provider call here.
    res.sendStatus(204);
  }));
  router.use((_req,res)=>res.status(enabled?404:503).json({error:enabled?'not_found':'sync_unavailable'}));
  router.use((error,_req,res,_next)=>{const status={invalid_signature:401,invalid_event:400,rate_limited:429};const code=['entity.too.large','entity.parse.failed','encoding.unsupported'].includes(error.type)?'invalid_event':Object.hasOwn(status,error.code)?error.code:'sync_unavailable';res.status(status[code]||503).json({error:code});});
  let stopped=true,timer,active;
  async function flush(){
    if(!enabled||!await store.ready())return;
    const job=await store.claim(Object.keys(cfg));if(!job)return;
    const t=cfg[job.client];let provider;
    try{provider=providerFactory({token:env[t.credentialEnv]});}catch{await store.retry(job,'calendar_unavailable');return;}
    await store.process(job,provider,t.eventTypes);
  }
  function startWorker(){
    if(!enabled||!stopped)return;stopped=false;
    const tick=()=>{if(stopped)return;active=flush().catch(()=>console.error('Jemlio calendar: sync pass unavailable.')).finally(()=>{active=null;if(!stopped){timer=setTimeout(tick,5000);timer.unref();}});};tick();
  }
  async function close(){stopped=true;clearTimeout(timer);if(active)await active;if(owned)await pool.end();}
  return {router,store,startWorker,close,flush};
}
module.exports={createCalendarSyncRuntime,configuration,verify,eventFrom};
