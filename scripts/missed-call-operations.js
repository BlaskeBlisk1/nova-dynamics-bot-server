'use strict';
// Operator-only. Never buys a number, forwards a call, sends SMS or enables a tenant.
const {readFileSync}=require('node:fs'),{join}=require('node:path');
const {configuration,digest}=require('../lib/missed-calls/config');
const {RecoveryStore}=require('../lib/missed-calls/store');
async function main(){
 const args=process.argv.slice(2),cmd=args[0];
 if(!['status','migrate','prune'].includes(cmd)||args.length!==(cmd==='status'?1:2)||cmd!=='status'&&args[1]!=='--apply')throw Error('usage');
 const cfg=configuration(process.env);
 const summary={configured:Boolean(cfg),receiverEnabled:process.env.JEMLIO_MISSED_CALLS_ENABLED==='true',sendingEnabled:process.env.JEMLIO_MISSED_CALL_SEND_ENABLED==='true',databaseConfigured:Boolean(process.env.NOVA_DATABASE_URL),schemaReady:false};
 if(cmd==='status'&&(!cfg||!summary.databaseConfigured)){console.log(JSON.stringify(summary));return;}
 if(!cfg||!summary.databaseConfigured)throw Error('configuration');
 const pool=new(require('pg').Pool)({connectionString:process.env.NOVA_DATABASE_URL,max:1,connectionTimeoutMillis:5000,query_timeout:10000});pool.on('error',()=>{});
 try{
  if(cmd==='migrate'){
   const db=await pool.connect();try{await db.query('BEGIN');
    const base=await db.query("SELECT to_regclass('public.nova_capture_requests') IS NOT NULL AS ready");if(!base.rows[0]?.ready)throw Error('capture_required');
    await db.query(readFileSync(join(__dirname,'../lib/missed-calls/schema.sql'),'utf8'));
    await db.query('INSERT INTO jemlio_missed_call_keyring(singleton,fingerprint) VALUES(true,$1) ON CONFLICT DO NOTHING',[digest(cfg.key)]);
    const pinned=(await db.query('SELECT fingerprint FROM jemlio_missed_call_keyring WHERE singleton=true')).rows[0];if(pinned.fingerprint!==digest(cfg.key))throw Error('key_rotation_required');
    await db.query('COMMIT');console.log('Additive missed-call schema applied. No activation or provider call performed.');
   }catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}
  }else if(cmd==='prune'){
   const store=new RecoveryStore({pool,key:cfg.key});if(!await store.ready())throw Error('schema_required');
   const r=await pool.query("UPDATE jemlio_missed_calls SET encrypted_payload=NULL,token_hash=NULL,revoked=true WHERE expires_at<=NOW() AND encrypted_payload IS NOT NULL AND state<>'sending' RETURNING id");
   console.log(JSON.stringify({expiredPrivatePayloadsRemoved:r.rows.length,providerDataUnchanged:true}));
  }else{summary.schemaReady=await new RecoveryStore({pool,key:cfg.key}).ready();console.log(JSON.stringify(summary));}
 }finally{await pool.end();}
}
main().catch(()=>{console.error('No activation performed. Use status | migrate --apply | prune --apply with the approved database, unchanged key and reviewed configuration.');process.exitCode=1;});
