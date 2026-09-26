'use strict';
const {AlertStore}=require('./store');
const {createResendNotifier,flushNotifications}=require('../capture/notification');
const EMAIL=/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,}$/;
function config(env,workspace){
  if(env.JEMLIO_OWNER_ALERTS_ENABLED!=='true'||!workspace||env.JEMLIO_WORKSPACE_ENABLED!=='true'||!EMAIL.test(env.JEMLIO_OWNER_ALERTS_FROM||''))return null;
  try{
    const input=JSON.parse(env.JEMLIO_OWNER_ALERTS_CONFIG||'null');
    if(!input||Array.isArray(input)||typeof input!=='object'||!Object.keys(input).length||Object.keys(input).length>100)return null;
    const tenants={};
    for(const [client,c] of Object.entries(input)){
      if(!Object.hasOwn(workspace.tenants,client)||!c||c.enabled!==true||!EMAIL.test(c.to||'')||c.to.length>254||
        !Number.isInteger(c.digestHour)||c.digestHour<0||c.digestHour>23||typeof c.startAt!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(c.startAt)||!Number.isFinite(Date.parse(c.startAt)))return null;
      tenants[client]={...c,from:env.JEMLIO_OWNER_ALERTS_FROM,origin:workspace.origin,responses:env.JEMLIO_OFFERS_ENABLED==='true'&&workspace.tenants[client].offersEnabled===true};
    }
    return tenants;
  }catch{return null;}
}
function createOwnerAlerts({env=process.env,pool,workspace,now=Date.now,sendNotification}={}){
  const cfg=config(env,workspace),enabled=Boolean(cfg&&pool&&(sendNotification||env.RESEND_API_KEY));
  const store=enabled?new AlertStore({pool,now}):null;
  const send=enabled?(sendNotification||createResendNotifier({apiKey:env.RESEND_API_KEY})):null;
  let timer=null,running=null;
  async function tick(){
    if(!enabled)return;
    if(running)return running;
    running=(async()=>{
      if(!await store.ready())throw new Error('alerts_schema_missing');
      for(const [client,c] of Object.entries(cfg))if(now()>=Date.parse(c.startAt))await store.collect(client,c);
      return flushNotifications({store,now,sendNotification:send,idempotencyPrefix:'jemlio-owner-alert',isTenantEnabled:async(client,n,claim)=>{
        const c=cfg[client];
        if(!c||now()<Date.parse(c.startAt)||n.from!==c.from||n.to?.length!==1||n.to[0]!==c.to)return false;
        if(claim.kind==='response')return c.responses&&Boolean((await pool.query(`SELECT 1 FROM jemlio_offers q JOIN nova_capture_requests r ON r.id=q.request_id
          LEFT JOIN nova_capture_outcomes o ON o.request_id=r.id LEFT JOIN jemlio_followups f ON f.request_id=r.id
          WHERE q.id=$1 AND r.client=$2 AND q.state='responded' AND COALESCE(o.outcome,'new') NOT IN ('won','lost') AND COALESCE(f.action,'review')<>'done'`,[claim.offer_id,client])).rows.length);
        return claim.event_key==='digest:'+require('./store').osloDay(now()).date;
      }});
    })();
    try{return await running;}finally{running=null;}
  }
  return {store,tick,enabled:client=>Boolean(enabled&&Object.hasOwn(cfg,client)),
    async status(client){if(!enabled||!Object.hasOwn(cfg,client))return {enabled:false};if(!await store.ready())return {enabled:false,needsSetup:true};return {enabled:true,digestHour:cfg[client].digestHour,timezone:'Europe/Oslo',queue:await store.status(client)};},
    startWorker(){if(!enabled||timer)return;const run=()=>void tick().catch(()=>console.error('Jemlio owner alerts: worker needs attention.'));timer=setInterval(run,60000);timer.unref();run();},
    async close(){if(timer)clearInterval(timer);timer=null;if(running)await running.catch(()=>{});}
  };
}
module.exports={createOwnerAlerts,config};
