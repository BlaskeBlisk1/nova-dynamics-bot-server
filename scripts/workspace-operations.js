'use strict';
const {randomBytes}=require('node:crypto');
const {writeFileSync,readFileSync}=require('node:fs');
const {isAbsolute,join}=require('node:path');
const {Pool}=require('pg');
const {WorkspaceStore,hash}=require('../lib/workspace/store');
async function main(){
 const [command,...args]=process.argv.slice(2);
 if(command==='key'&&args.length===2&&args[0]==='--out'&&isAbsolute(args[1])){
  const key=randomBytes(32).toString('base64url');
  writeFileSync(args[1],JSON.stringify({key,keyHash:hash(key)},null,2)+'\n',{mode:0o600,flag:'wx'});
  console.log('New access key written to the specified private file. No account enabled.');return;
 }
 if(!['status','migrate'].includes(command)||args.some(a=>a!=='--apply')||args.length>1||(command==='status'&&args.length))throw new Error('usage');
 if(!process.env.NOVA_DATABASE_URL)throw new Error('database');
 const pool=new Pool({connectionString:process.env.NOVA_DATABASE_URL,max:1,connectionTimeoutMillis:5000,statement_timeout:15000});
 pool.on('error',()=>console.error('Workspace database unavailable.'));
 try{const store=new WorkspaceStore({pool});
  if(command==='migrate'){
   if(args[0]!=='--apply'){console.log('Migration not applied. Use --apply on the intended database after capture and booking migrations.');return;}
   await store.transaction(db=>db.query(readFileSync(join(__dirname,'../lib/workspace/schema.sql'),'utf8')));
   console.log('Workspace schema applied. No business enabled.');
  }else console.log(JSON.stringify({schemaReady:await store.ready()}));
 }finally{await pool.end();}
}
if(require.main===module)main().catch(()=>{console.error('Command failed. Use key --out ABSOLUTE_PRIVATE_FILE, status, or migrate --apply. Key output must not exist; database commands require NOVA_DATABASE_URL.');process.exitCode=1;});
