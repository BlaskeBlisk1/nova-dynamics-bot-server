'use strict';
const express = require('express');
const { configuration, digest, sid, MOBILE, CLIENT } = require('./config');
const { RecoveryStore } = require('./store');
const { adapter, validate, forwardXml, fail } = require('./twilio');
const { PgStore } = require('../capture/store');
const { email } = require('../enquiry-conversations/delivery');
const VVS = require('../../public/marketing/vvs-profile');
const Q = require('../../public/marketing/quote-schema');
const { createCrmPayload } = require('../capture/crm');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const END = '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>';
const ACK = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
function createMissedCalls({ env=process.env, pool:injected, getTenant=async()=>null, now=Date.now, provider=adapter }={}) {
  const cfg=configuration(env);let pool=injected,owned=false;
  if(!pool && cfg && env.JEMLIO_MISSED_CALLS_ENABLED==='true' && env.NOVA_DATABASE_URL){
    pool=new(require('pg').Pool)({connectionString:env.NOVA_DATABASE_URL,max:2,connectionTimeoutMillis:5000,query_timeout:5000,idleTimeoutMillis:30000,allowExitOnIdle:true});
    pool.on('error',()=>console.error('Jemlio missed calls: database unavailable.'));owned=true;
  }
  const store=pool&&cfg?new RecoveryStore({pool,key:cfg.key,now}):null, capture=pool?new PgStore({pool}):null;
  const enabled=()=>env.JEMLIO_MISSED_CALLS_ENABLED==='true'&&Boolean(store&&cfg);
  const selected=client=>cfg&&Object.hasOwn(cfg.tenants,client)?cfg.tenants[client]:null;
  const sending=()=>enabled()&&env.JEMLIO_MISSED_CALL_SEND_ENABLED==='true';
  const endpoint=(client,kind)=>cfg.origin+'/api/missed-calls/'+client+'/'+kind;
  async function tenant(client) {
    const t=selected(client);if(!t||!t.enabled||!enabled())return null;
    const c=await getTenant(client);
    if(!c || c.mode!=='live' || !c.vvs || !email(c.recipient) || !c.allowedOrigins?.includes(cfg.origin) || !email(env.NOVA_CAPTURE_FROM))return null;
    try{VVS.configuration(c.vvs,c.form);Q.normalizeForm(c.form,c.services);}catch{return null;}
    return c;
  }
  async function ready(){try{return enabled()&&await store.ready();}catch{return false;}}
  const router=express.Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  router.use((req,res,next)=>{res.set({'Cache-Control':'no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});next();});
  router.use(express.urlencoded({extended:false,limit:'16kb',parameterLimit:100}));
  router.use(express.json({limit:'12kb',strict:true}));
  function signed(req,client,kind){
    const t=selected(client);
    if(!CLIENT.test(client)||!t||env.JEMLIO_MISSED_CALLS_ENABLED!=='true')throw fail('unavailable');
    if(Object.keys(req.query).length||!req.is('application/x-www-form-urlencoded')||req.body?.AccountSid!==t.accountSid||
       !validate(t.authToken,req.get('x-twilio-signature'),endpoint(client,kind),req.body))throw fail('forbidden');
    return t;
  }
  router.post('/:client/voice',wrap(async(req,res)=>{
    const t=signed(req,req.params.client,'voice');
    if(req.body.To!==t.voiceNumber || !sid('CA',req.body.CallSid))throw fail('forbidden');
    // This route only emits approved routing instructions. It buys/ports no number.
    res.type('text/xml').send(forwardXml(t,endpoint(req.params.client,'ended')));
  }));
  router.post('/:client/ended',wrap(async(req,res)=>{
    const client=req.params.client,t=signed(req,client,'ended'),b=req.body;
    if(b.To!==t.voiceNumber || !sid('CA',b.CallSid))throw fail('forbidden');
    if(!['no-answer','busy'].includes(b.DialCallStatus)||!MOBILE.test(b.From||'')||!sid('CA',b.DialCallSid))return res.type('text/xml').send(END);
    if(!await ready()||!await tenant(client))throw fail('unavailable');
    if(!await capture.consumeRateLimit('missed-events:'+client,300,3600000,now()))throw fail('rate_limited');
    await store.receive(client,t,{parentSid:b.CallSid,childSid:b.DialCallSid,from:b.From,status:b.DialCallStatus});
    res.type('text/xml').send(END);
  }));
  router.post('/:client/status/:id',wrap(async(req,res)=>{
    if(!UUID.test(req.params.id))throw fail('invalid_request');
    const t=signed(req,req.params.client,'status/'+req.params.id),b=req.body;
    if(!await ready())throw fail('unavailable');
    if(b.From!==t.smsFrom||!MOBILE.test(b.To||'')||!sid('SM',b.MessageSid))throw fail('forbidden');
    await store.delivery(req.params.client,req.params.id,b.MessageSid,b.MessageStatus,b.To);res.type('text/xml').send(ACK);
  }));
  router.post('/:client/inbound',wrap(async(req,res)=>{
    const t=signed(req,req.params.client,'inbound'),b=req.body;
    if(!await ready())throw fail('unavailable');
    if(b.To!==t.smsFrom||!MOBILE.test(b.From||'')||!sid('SM',b.MessageSid))throw fail('forbidden');
    if(b.OptOutType==='STOP'||/^(stop|stopp|stopall|unsubscribe|cancel|end|quit)$/i.test((b.Body||'').trim()))await store.suppress(req.params.client,b.From);
    // No conversational auto-reply, and START cannot silently remove a stored opt-out.
    res.type('text/xml').send(ACK);
  }));
  async function access(req) {
    if(!await ready())throw fail('unavailable');
    if(!req.is('application/json')||req.get('origin')!==cfg.origin||req.get('sec-fetch-site')==='cross-site')throw fail('forbidden');
    if(!await capture.consumeRateLimit('recovery-link:'+digest(req.ip||'unknown'),60,60000,now()))throw fail('rate_limited');
    const row=await store.resolve(req.body?.token),t=selected(row.client),c=await tenant(row.client);
    if(!t||!c||row.config_hash!==t.fingerprint)throw fail('link_unavailable');
    return {row,c,t};
  }
  router.post('/read',wrap(async(req,res)=>{
    if(!req.body||Object.keys(req.body).some(k=>k!=='token'))throw fail('invalid_request');
    const {row,c}=await access(req);
    res.json({business:c.name,privacyUrl:c.privacyUrl,services:c.services.map(s=>({id:s.id,label:s.label})),form:Q.normalizeForm(c.form,c.services),
      vvs:VVS.configuration(c.vvs),submitted:Boolean(row.request_id),receipt:row.request_id||null,expiresAt:row.expires_at});
  }));
  router.post('/submit',wrap(async(req,res)=>{
    const b=req.body;
    if(!b||Array.isArray(b)||Object.keys(b).some(k=>!['token','name','email','service','preferredTime','answers','consent','website'].includes(k)))throw fail('invalid_request');
    const {row,c}=await access(req);
    const clean=(v,max,required=false)=>{if(typeof v!=='string'||v.length>max||/[\u0000-\u001f\u007f]/.test(v)||required&&!v.trim())throw fail('invalid_fields');return v.trim();};
    const name=clean(b.name,100,true),mail=email(clean(b.email,254,true)),time=clean(b.preferredTime||'',120);
    const service=c.services.find(s=>s.id===b.service);
    if(name.length<2||!mail||!service||b.consent!==true||b.website)throw fail('invalid_fields');
    const form=Q.normalizeForm(c.form,c.services),details=Q.validateAnswers(form,service.id,b.answers),job=VVS.assess(b.answers,c.vvs);
    const phone=store.decode(row).from;
    const data={name,email:mail,phone,service:service.id,preferredTime:time,consent:true,requestKind:'quote',details,
      job:{...job,source:'missed_call',recoveryId:row.id}};
    const payloadHash=digest(JSON.stringify(data)),at=now();
    const notification={from:env.NOVA_CAPTURE_FROM,to:[c.recipient],reply_to:mail,
      subject:'Ny VVS-forespørsel etter ubesvart anrop – '+c.name,
      text:[`Kunden har fylt ut forespørselen etter et ubesvart anrop til ${c.name}.`,'',`Navn: ${name}`,`Telefon: ${phone}`,`E-post: ${mail}`,`Tjeneste: ${service.label}`,`Ønsket kontakt: ${time||'Ikke oppgitt'}`,
        ...details.map(d=>d.label+': '+d.value),'','Forespørsel, ikke en bekreftet time eller et salg.'].join('\n')};
    const crm=c.crm?createCrmPayload({destination:c.crm,receipt:row.receipt,name:c.name,service:service.label,data,createdAt:at}):null;
    const result=await store.transaction(async db=>{
      const current=(await db.query('SELECT * FROM jemlio_missed_calls WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(!current||current.revoked||Date.parse(current.expires_at)<=now()||current.submitted_hash&&!current.request_id)throw fail('link_unavailable');
      if(current.submitted_hash&&current.submitted_hash!==payloadHash)throw fail('submission_conflict');
      const saved=await capture.createInTransaction({receipt:row.receipt,client:row.client,submissionId:row.id,payloadHash,data,notification,crm,createdAt:at},db);
      await db.query('UPDATE jemlio_missed_calls SET request_id=$2,submitted_hash=$3 WHERE id=$1',[row.id,saved.receipt,payloadHash]);return saved;
    });
    res.status(result.duplicate?200:201).json({receipt:result.receipt,status:'received',message:'Forespørselen er lagret. Bedriften vurderer behovet og kontakter deg. Ingen time eller pris er bekreftet.'});
  }));
  router.use((e,_req,res,_next)=>{
    const codes={forbidden:403,invalid_request:400,invalid_fields:400,urgent_call_required:400,invalid_postcode:400,outside_service_area:400,
      link_unavailable:404,event_conflict:409,submission_conflict:409,submission_removed:410,rate_limited:429};
    const code=Object.hasOwn(codes,e.code)?e.code:(e.type==='entity.too.large'||e.type==='entity.parse.failed')?'invalid_request':'unavailable';
    if(code==='rate_limited')res.set('Retry-After','60');res.status(codes[code]||503).json({error:code});
  });
  async function tick() {
    if(!sending()||!await ready())return;
    const row=await store.claim();if(!row)return;
    const t=selected(row.client),c=await tenant(row.client);
    if(!t||!c||row.config_hash!==t.fingerprint)return store.stop(row,'configuration_changed');
    const event=store.decode(row);
    if(!t.liveRecipientsApproved&&!t.testRecipients.includes(event.from))return store.stop(row,'test_recipient_only');
    const p=provider(t);
    try{await p.verifyCall(event,now());}catch(e){return ['call_not_eligible','not_mobile'].includes(e.code)?store.stop(row,e.code):store.retryRead(row);}
    if(!sending()||!await tenant(row.client))return store.stop(row,'sending_disabled');
    if(!await store.reserve(row,t))return;
    if(!sending()||!await store.canDispatch(row))return store.finish(row,{state:'blocked',reason:'sending_cancelled'});
    const link=cfg.origin+'/job-request/#'+event.token;
    try{const r=await p.send({to:event.from,body:t.smsText.replace('{link}',link),statusCallback:endpoint(row.client,'status/'+row.id)});
      await store.finish(row,{state:'accepted',sid:r.sid});}
    catch(e){await store.finish(row,{state:e.code==='sms_rejected'?'failed':'uncertain',reason:e.code==='sms_rejected'?'provider_rejected':'provider_uncertain'});}
  }
  let timer,active,stopped=true;
  function startWorker(){if(!enabled()||!stopped)return;stopped=false;const run=()=>{if(stopped||active)return;active=tick().catch(()=>console.error('Jemlio missed calls: item needs review.')).finally(()=>{active=null;});};timer=setInterval(run,5000);timer.unref();run();}
  async function close(){stopped=true;clearInterval(timer);await active;if(owned)await pool.end();}
  async function reconcile(client,id) {
    if(!await ready())throw fail('unavailable');
    const row=await store.get(client,id),t=selected(client);
    if(!row||!t)throw fail('not_found');
    if(!row.provider_sid)return {checked:false,reason:'provider_id_unknown',resendAllowed:false};
    const m=await provider(t).message(row.provider_sid);
    if(m.accountSid!==t.accountSid||m.from!==t.smsFrom||m.sid!==row.provider_sid||store.phoneKey(client,m.to)!==row.phone_key)throw fail('unavailable');
    await store.delivery(client,id,m.sid,m.status,m.to);return {checked:true,resendAllowed:false};
  }
  return {router,store,tick,startWorker,close,ready,enabled,sending,reconcile,hasTenant:client=>Boolean(enabled()&&selected(client))};
}
module.exports={createMissedCalls};
