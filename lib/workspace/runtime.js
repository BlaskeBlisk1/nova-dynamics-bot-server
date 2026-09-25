'use strict';
const express=require('express');
const { randomBytes,timingSafeEqual }=require('node:crypto');
const { WorkspaceStore,hash,fail }=require('./store');
const { PgStore }=require('../capture/store');
const { CLIENT }=require('../booking/store');
const COOKIE='__Host-jemlio_workspace', TTL=8*3600000, IDLE=30*60000;
function config(env) {
  try {
    const origin=new URL(env.JEMLIO_WORKSPACE_ORIGIN);
    if (origin.protocol!=='https:' || origin.origin!==env.JEMLIO_WORKSPACE_ORIGIN) return null;
    const tenants=JSON.parse(env.JEMLIO_WORKSPACE_CONFIG || '{}');
    if (!tenants || Array.isArray(tenants) || typeof tenants!=='object' || !Object.keys(tenants).length || Object.keys(tenants).length>100) return null;
    const keys=new Set();
    for (const [client,t] of Object.entries(tenants)) {
      if (!CLIENT.test(client) || !t || t.enabled!==true || typeof t.name!=='string' || !t.name.trim() || t.name.length>100 ||
        !/^[a-f0-9]{64}$/.test(t.keyHash || '') || keys.has(t.keyHash)) return null;
      keys.add(t.keyHash);
    }
    return { origin:origin.origin,tenants };
  } catch { return null; }
}
function cookieToken(req) {
  const values=(req.get('cookie') || '').split(';').map(s=>s.trim()).filter(s=>s.startsWith(COOKIE+'='));
  if (values.length!==1) return null;
  const value=values[0].slice(COOKIE.length+1); return /^[a-f0-9]{64}$/.test(value)?value:null;
}
function createWorkspaceRuntime({env=process.env,pool:injected,now=Date.now}={}) {
  const cfg=config(env), enabled=env.JEMLIO_WORKSPACE_ENABLED==='true' && cfg && (injected || env.NOVA_DATABASE_URL);
  let pool=enabled?injected:null,owned=false;
  if (enabled && !pool) {
    pool=new(require('pg').Pool)({connectionString:env.NOVA_DATABASE_URL,max:3,connectionTimeoutMillis:5000,query_timeout:5000,idleTimeoutMillis:30000,allowExitOnIdle:true});
    pool.on('error',()=>console.error('Jemlio workspace: database unavailable.'));owned=true;
  }
  const store=pool?new WorkspaceStore({pool,now}):null, rateStore=pool?new PgStore({pool}):null;
  const router=express.Router(),wrap=fn=>(req,res,next)=>Promise.resolve(fn(req,res,next)).catch(next);
  const setCookie=(res,value,age)=>res.set('Set-Cookie',`${COOKIE}=${value}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${age}`);
  router.use((_req,res,next)=>{res.set({'Cache-Control':'no-store','Pragma':'no-cache','X-Content-Type-Options':'nosniff','Referrer-Policy':'no-referrer'});next();});
  router.use(express.json({limit:'6kb',strict:true}));
  router.use(wrap(async(req,res,next)=>{
    if (!enabled || !await store.ready()) throw fail('unavailable');
    const origin=req.get('origin');
    if ((origin && origin!==cfg.origin) || (req.method!=='GET' && origin!==cfg.origin) || req.get('sec-fetch-site')==='cross-site') throw fail('forbidden');
    if (req.method!=='GET' && !req.is('application/json')) throw fail('invalid_request');
    next();
  }));
  router.post('/login',wrap(async(req,res)=>{
    // Durable per-IP limit survives deploys. No user-supplied credential is logged or put in a URL.
    if (!await rateStore.consumeRateLimit('workspace-login:'+hash(req.ip || 'unknown'),10,15*60000,now())) throw fail('rate_limited');
    const key=req.body?.key;
    if (Object.keys(req.body || {}).some(k=>k!=='key') || typeof key!=='string' || !/^[A-Za-z0-9_-]{43}$/.test(key)) throw fail('invalid_login');
    const digest=hash(key); let client;
    for (const [id,t] of Object.entries(cfg.tenants)) if (timingSafeEqual(Buffer.from(digest,'hex'),Buffer.from(t.keyHash,'hex'))) client=id;
    if (!client) throw fail('invalid_login');
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(24).toString('hex');
    await pool.query('DELETE FROM jemlio_workspace_sessions WHERE expires_at<=$1 OR last_seen<=$2',[new Date(now()),new Date(now()-IDLE)]);
    // Rotate this browser's prior session rather than extending or adopting it.
    const old=cookieToken(req);if(old)await pool.query('DELETE FROM jemlio_workspace_sessions WHERE token_hash=$1',[hash(old)]);
    await pool.query(`INSERT INTO jemlio_workspace_sessions(token_hash,client,credential_hash,csrf,expires_at,last_seen) VALUES ($1,$2,$3,$4,$5,$6)`,
      [hash(token),client,digest,csrf,new Date(now()+TTL),new Date(now())]);
    setCookie(res,token,TTL/1000);res.json({name:cfg.tenants[client].name,csrf,expiresAt:new Date(now()+TTL).toISOString()});
  }));
  router.use(wrap(async(req,res,next)=>{
    const token=cookieToken(req);if(!token)throw fail('unauthorized');
    const s=(await pool.query('SELECT * FROM jemlio_workspace_sessions WHERE token_hash=$1 AND expires_at>$2 AND last_seen>$3',[hash(token),new Date(now()),new Date(now()-IDLE)])).rows[0];
    if (!s || !Object.hasOwn(cfg.tenants,s.client) || cfg.tenants[s.client].keyHash!==s.credential_hash) {setCookie(res,'',0);throw fail('unauthorized');}
    if (req.method!=='GET' && req.get('x-jemlio-csrf')!==s.csrf) throw fail('forbidden');
    if (!await rateStore.consumeRateLimit('workspace-session:'+hash(token),120,60000,now())) throw fail('rate_limited');
    await pool.query('UPDATE jemlio_workspace_sessions SET last_seen=$2 WHERE token_hash=$1',[hash(token),new Date(now())]);
    req.workspace=s;next();
  }));
  router.get('/session',wrap(async(req,res)=>res.json({name:cfg.tenants[req.workspace.client].name,csrf:req.workspace.csrf,expiresAt:req.workspace.expires_at})));
  router.post('/logout',wrap(async(req,res)=>{await pool.query('DELETE FROM jemlio_workspace_sessions WHERE token_hash=$1',[req.workspace.token_hash]);setCookie(res,'',0);res.json({ok:true});}));
  router.get('/enquiries',wrap(async(req,res)=>{
    if (Object.keys(req.query).some(k=>!['view','page'].includes(k)) || req.query.page!==undefined && !/^\d{1,3}$/.test(req.query.page)) throw fail('invalid_request');
    res.json(await store.list(req.workspace.client,{view:req.query.view || 'open',page:Number(req.query.page || 0)}));
  }));
  router.get('/report',wrap(async(req,res)=>{
    if (Object.keys(req.query).some(k=>!['since','before'].includes(k))) throw fail('invalid_request');
    res.json(await store.report({client:req.workspace.client,since:req.query.since,before:req.query.before}));
  }));
  router.post('/enquiries/:id',wrap(async(req,res)=>res.json(await store.update(req.workspace.client,req.params.id,req.body,'key:'+req.workspace.credential_hash.slice(0,16)))));
  router.use((_req,_res,next)=>next(fail('not_found')));
  router.use((error,_req,res,next)=>{
    if(res.headersSent)return next(error);
    const statuses={unauthorized:401,invalid_login:401,forbidden:403,rate_limited:429,not_found:404,request_not_found:404,conflict:409,
      invalid_request:400,invalid_scope:400,invalid_date:400,invalid_date_range:400,invalid_amount:400,verification_required:400,verified_win_required:409,
      request_closed:409,confirmed_booking_required:409,appointment_not_started:409};
    const code=['entity.parse.failed','entity.too.large'].includes(error.type)?'invalid_request':Object.hasOwn(statuses,error.code)?error.code:'unavailable';
    res.status(statuses[code] || 503).json({error:code});
  });
  return {router,store,close:async()=>{if(owned)await pool.end();}};
}
module.exports={createWorkspaceRuntime,config,COOKIE,TTL,IDLE};
