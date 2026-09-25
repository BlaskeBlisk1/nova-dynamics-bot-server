'use strict';
const {Pool}=require('pg');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {CalendarStore}=require('../lib/calendar-sync/store');
async function main(){
  const [command,...argv]=process.argv.slice(2),args={};
  const allowed={migrate:['apply'],status:[],retry:['client','receipt','apply']}[command];
  if(!allowed)throw new Error('usage');
  for(let i=0;i<argv.length;i++){const k=argv[i].slice(2);if(!argv[i].startsWith('--')||!allowed.includes(k)||Object.hasOwn(args,k))throw new Error('usage');args[k]=k==='apply'?true:argv[++i];}
  if(!process.env.NOVA_DATABASE_URL)throw new Error('database');
  const pool=new Pool({connectionString:process.env.NOVA_DATABASE_URL,max:1,connectionTimeoutMillis:5000,statement_timeout:15000});pool.on('error',()=>console.error('Calendar database unavailable.'));
  try{const store=new CalendarStore({pool});
    if(command==='migrate'){
      if(!args.apply){console.log('Migration not applied. Run booking migration first, then use --apply for this migration.');return;}
      await store.transaction(db=>db.query(readFileSync(join(__dirname,'../lib/calendar-sync/schema.sql'),'utf8')));console.log('Calendar queue schema applied. No integration enabled.');
    }else if(command==='status'){
      const ready=await store.ready();const summary=ready?(await pool.query(`SELECT count(*)::int AS queued,count(*) FILTER(WHERE available_at IS NULL)::int AS attention FROM jemlio_calendar_jobs`)).rows[0]:null;
      console.log(JSON.stringify({schemaReady:ready,summary}));
    }else console.log(JSON.stringify(await store.retryManually(args.client,args.receipt,{apply:args.apply===true})));
  }finally{await pool.end();}
}
if(require.main===module)main().catch(()=>{console.error('Operation unavailable. Usage: migrate [--apply], status, retry --client SLUG --receipt UUID [--apply]. No provider write or message sent.');process.exitCode=1;});
