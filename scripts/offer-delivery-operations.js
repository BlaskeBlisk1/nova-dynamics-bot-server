'use strict';
// Operator-only additive migration. Never sends messages or enables a tenant.
const {readFileSync}=require('node:fs'),{join}=require('node:path'),{Pool}=require('pg');
async function main(){
 const args=process.argv.slice(2);if(!['status','migrate'].includes(args[0])||args.length>(args[0]==='migrate'?2:1)||args[0]==='migrate'&&args[1]!=='--apply')throw Error('usage');
 if(!process.env.NOVA_DATABASE_URL)throw Error('configuration');
 const pool=new Pool({connectionString:process.env.NOVA_DATABASE_URL,max:1,connectionTimeoutMillis:5000,query_timeout:15000});pool.on('error',()=>{});
 try{if(args[0]==='migrate'){const db=await pool.connect();try{await db.query('BEGIN');await db.query(readFileSync(join(__dirname,'../lib/offers/delivery-schema.sql'),'utf8'));await db.query('COMMIT');console.log('Offer delivery schema applied. All activation switches remain unchanged.');}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();}}
 else{const r=await pool.query("SELECT to_regclass('public.jemlio_offer_deliveries') IS NOT NULL AS ready");console.log(JSON.stringify({schemaReady:r.rows[0]?.ready===true,activationRequired:true}));}}finally{await pool.end();}
}
main().catch(()=>{console.error('No activation performed. Usage: node scripts/offer-delivery-operations.js status | migrate --apply. Check the intended database and existing schemas.');process.exitCode=1;});
