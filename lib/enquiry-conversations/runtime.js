'use strict';
const express=require('express');
const {ConversationStore,fail,object,TOKEN}=require('./store');
const {key,senderConfig,verifyWebhook,webhookKey,hash}=require('./delivery');
const {PgStore}=require('../capture/store');
const {createResendNotifier}=require('../capture/notification');
function createConversations({env=process.env,pool,cfg,now=Date.now,sendMessage}={}){
  const origin=(()=>{try{const u=new URL(cfg?.origin);return u.protocol==='https:'&&u.origin===cfg.origin?u.origin:null;}catch{return null;}})();
  const globalEnabled=()=>Boolean(pool&&origin&&env.JEMLIO_CONVERSATIONS_ENABLED==='true');
  const features=client=>Boolean(globalEnabled()&&cfg?.tenants?.[client]?.enabled===true&&cfg.tenants[client].conversationsEnabled===true);
  const secret=key(env.JEMLIO_CONVERSATION_ENCRYPTION_KEY),senders=senderConfig(env,cfg);
  const webhookSecret=env.JEMLIO_CONVERSATION_WEBHOOK_SECRET||'';
  const webhookConfigured=Boolean(webhookKey(webhookSecret));
  const send=sendMessage||(env.RESEND_API_KEY?createResendNotifier({apiKey:env.RESEND_API_KEY}):null);
  const sendSettings=client=>features(client)&&env.JEMLIO_CONVERSATION_SEND_ENABLED==='true'&&secret&&send&&webhookConfigured?senders[client]||null:null;
  const store=pool?new ConversationStore({pool,now,enabled:features,businessName:client=>cfg?.tenants?.[client]?.name||'Bedriften',sendSettings,secret,origin}):null;
  const rate=pool?new PgStore({pool}):null;
  const workspaceRouter=express.Router(),publicRouter=express.Router(),webhookRouter=express.Router();
  const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  const headers=(_req,res,next)=>{res.set({'Cache-Control':'no-store','Pragma':'no-cache','X-Robots-Tag':'noindex, nofollow','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});next();};
  const error=(err,_req,res,next)=>{
    if(res.headersSent)return next(err);
    const codes={unavailable:503,not_found:404,forbidden:403,invalid_request:400,conflict:409,request_closed:409,approval_required:400,
      recipient_mismatch:409,recipient_unavailable:409,recipient_suppressed:409,send_unavailable:503,reply_unavailable:404,rate_limited:429,submission_conflict:409,invalid_signature:401};
    const code=['entity.too.large','entity.parse.failed','encoding.unsupported'].includes(err.type)?'invalid_request':Object.hasOwn(codes,err.code)?err.code:'unavailable';
    res.status(codes[code]).json({error:code});
  };
  const workspaceReady=wrap(async(req,_res,next)=>{
    if(!req.workspace||!features(req.workspace.client)||!await store.ready())throw fail('unavailable');
    if(Object.keys(req.query).length)throw fail('invalid_request');next();
  });
  const base='/enquiries/:id/conversation';
  workspaceRouter.use(headers);
  workspaceRouter.get(base,workspaceReady,wrap(async(req,res)=>res.json(await store.read(req.workspace.client,req.params.id))));
  for(const action of ['draft','send','cancel'])workspaceRouter.post(`${base}/${action}`,workspaceReady,wrap(async(req,res)=>{
    if(!await rate.consumeRateLimit(`conversation-${action}:${req.workspace.client}`,action==='send'?30:120,3600000,now()))throw fail('rate_limited');
    res.json(await store[action](req.workspace.client,req.params.id,req.body,`key:${req.workspace.credential_hash.slice(0,16)}`));
  }));
  workspaceRouter.use(error);
  publicRouter.use(headers);
  publicRouter.use(wrap(async(req,_res,next)=>{
    if(!globalEnabled()||!await store.ready())throw fail('unavailable');
    if(req.method!=='POST'||req.get('origin')!==origin||req.get('sec-fetch-site')==='cross-site')throw fail('forbidden');
    if(!req.is('application/json')||Object.keys(req.query).length)throw fail('invalid_request');
    if(!await rate.consumeRateLimit('conversation-public-ip:'+hash(req.ip||'unknown'),90,60000,now()))throw fail('rate_limited');next();
  }));
  publicRouter.use(express.json({limit:'8kb',strict:true}));
  publicRouter.post('/read',wrap(async(req,res)=>{object(req.body,['token','client']);res.json(await store.publicRead(req.body.token,req.body.client));}));
  publicRouter.post('/respond',wrap(async(req,res)=>{
    if(typeof req.body?.token!=='string'||!TOKEN.test(req.body.token))throw fail('reply_unavailable');
    if(!await rate.consumeRateLimit('conversation-reply:'+hash(req.body.token),10,60000,now()))throw fail('rate_limited');
    res.json(await store.respond(req.body));
  }));
  publicRouter.use((_req,_res,next)=>next(fail('not_found')));publicRouter.use(error);
  webhookRouter.use(headers);
  webhookRouter.use(wrap(async(req,_res,next)=>{
    if(!store||!webhookConfigured||!await store.ready())throw fail('unavailable');
    if(req.method!=='POST'||!req.is('application/json'))throw fail('invalid_request');next();
  }));
  webhookRouter.use(express.raw({type:'application/json',limit:'32kb',inflate:false}));
  webhookRouter.post('/',wrap(async(req,res)=>{
    // Official Resend/Svix protocol signs id.timestamp.ORIGINAL body bytes.
    // The callback ledger commits before success; unknown provider IDs are
    // reconciled once send acceptance has been committed, including early events.
    if(!verifyWebhook(req.body,req.headers,webhookSecret,now))throw fail('invalid_signature');
    let event;try{event=JSON.parse(req.body.toString('utf8'));}catch{throw fail('invalid_request');}
    const kind={'email.delivered':'delivered','email.bounced':'bounced','email.complained':'complained'}[event?.type];
    if(!kind)return res.json({accepted:false,ignored:true});
    if(typeof event.data?.email_id!=='string'||!event.data.email_id||event.data.email_id.length>200||/[\s\u0000-\u001f]/.test(event.data.email_id))throw fail('invalid_request');
    const result=await store.deliveryEvent({eventId:req.get('svix-id'),providerId:event.data.email_id,kind});
    await store.reconcileEvents();res.json(result);
  }));
  webhookRouter.use((_req,_res,next)=>next(fail('not_found')));webhookRouter.use(error);
  let timer=null,active=null;
  async function tick(){
    if(!globalEnabled())return;
    if(active)return active;
    active=(async()=>{
      if(!await store.ready())throw fail('unavailable');
      // Apply complaints/bounces before claiming any new customer message.
      await store.reconcileEvents();
      for(let i=0;i<10;i++){const claim=await store.claimNext();if(!claim)break;await store.dispatch(claim,send);}
    })();
    try{return await active;}finally{active=null;}
  }
  return {workspaceRouter,publicRouter,webhookRouter,features,store,tick,
    startWorker(){if(!globalEnabled()||timer)return;const run=()=>void tick().catch(()=>console.error('Jemlio conversations: delivery requires operator review.'));timer=setInterval(run,10000);timer.unref();run();},
    async close(){if(timer)clearInterval(timer);timer=null;if(active)await active.catch(()=>{});}};
}
module.exports={createConversations};
