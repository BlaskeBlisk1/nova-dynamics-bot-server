'use strict';
const express=require('express');
const {OfferStore}=require('./store');
const {hash,fail}=require('../workspace/store');
const {PgStore}=require('../capture/store');
function createOfferRouter({pool,cfg,enabled,now=Date.now}){
  const router=express.Router(),store=pool?new OfferStore({pool,now}):null,rate=pool?new PgStore({pool}):null;
  const wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  const allowed=client=>Object.hasOwn(cfg.tenants,client)&&cfg.tenants[client].offersEnabled===true;
  router.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','Pragma':'no-cache','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff'});next();});
  router.use(express.json({limit:'4kb',strict:true}));
  router.use(wrap(async(req,_res,next)=>{
    if(!enabled||!await store.ready())throw fail('unavailable');
    if(req.get('origin')!==cfg.origin||req.get('sec-fetch-site')==='cross-site')throw fail('forbidden');
    if(!req.is('application/json')||Object.keys(req.query).length)throw fail('invalid_request');
    if(!await rate.consumeRateLimit('offer-ip:'+hash(req.ip||'unknown'),60,60000,now()))throw fail('rate_limited');
    next();
  }));
  router.post('/read',wrap(async(req,res)=>{
    if(!req.body||Object.keys(req.body).some(k=>k!=='token'))throw fail('invalid_request');
    const found=await store.readOffer(req.body.token,allowed);
    res.json({business:cfg.tenants[found.client].name,offer:found.offer});
  }));
  router.post('/respond',wrap(async(req,res)=>{
    if(!req.body||Object.keys(req.body).some(k=>!['token','response','note'].includes(k)))throw fail('invalid_request');
    const offer=await store.respond(req.body.token,{response:req.body.response,note:req.body.note},allowed);res.json({offer});
  }));
  router.use((_req,_res,next)=>next(fail('offer_unavailable')));
  router.use((error,_req,res,_next)=>{const statuses={forbidden:403,invalid_request:400,offer_unavailable:404,request_not_found:404,response_conflict:409,rate_limited:429};
    const code=['entity.parse.failed','entity.too.large'].includes(error.type)?'invalid_request':Object.hasOwn(statuses,error.code)?error.code:'unavailable';res.status(statuses[code]||503).json({error:code});});
  return {router,store};
}
module.exports={createOfferRouter};
