'use strict';
const { randomUUID, createHash } = require('node:crypto');
const { UUID, scope, iso } = require('../booking/store');
const fail = code => Object.assign(new Error(code), { code });
const MODE = 'workspace_manual_v1';
const SOURCES = ['phone','email','social','referral','other'];
function validate(input, now) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k=>!['submissionId','name','email','phone','service','message','source','due','verified'].includes(k)) ||
      typeof input.submissionId !== 'string' || !UUID.test(input.submissionId) || !SOURCES.includes(input.source)) throw fail('invalid_request');
  if (input.verified !== true) throw fail('verification_required');
  const data = {entryMode:MODE,source:input.source};
  for (const [key,max,required] of [['name',100,true],['email',254,false],['phone',30,false],['service',160,true],['message',1000,false]]) {
    if (input[key] !== undefined && typeof input[key] !== 'string') throw fail('invalid_request');
    const value=(input[key]||'').trim();
    if (value.length>max || required&&!value || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || key!=='message'&&/[\r\n]/.test(value)) throw fail('invalid_request');
    data[key]=key==='email'?value.toLowerCase():value;
  }
  if (!data.email&&!data.phone || data.email&&!/^[^\s@?]+@[^\s@?]+\.[^\s@?]+$/.test(data.email) || data.phone&&!/^\+?[\d ()-]{3,30}$/.test(data.phone)) throw fail('invalid_request');
  iso(input.due);
  if (Date.parse(input.due)>now+366*86400000 || Date.parse(input.due)<now-366*86400000) throw fail('invalid_date');
  return {data,due:new Date(input.due).toISOString()};
}
async function createManual(store,client,input,actor) {
  scope(client);
  const clean=validate(input,store.now()), digest=createHash('sha256').update(JSON.stringify(clean)).digest('hex');
  return store.transaction(async db=>{
    const id=randomUUID(),at=new Date(store.now());
    const inserted=await db.query(`INSERT INTO nova_capture_requests(id,client,submission_id,payload_hash,data,created_at)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT(client,submission_id) DO NOTHING RETURNING id`,[id,client,input.submissionId,digest,JSON.stringify(clean.data),at]);
    // Check after the INSERT conflict wait so a retry cannot recreate a deleted enquiry.
    if ((await db.query('SELECT 1 FROM nova_capture_submission_tombstones WHERE client=$1 AND submission_id=$2',[client,input.submissionId])).rows.length) throw fail('submission_removed');
    if (!inserted.rows.length) {
      const existing=(await db.query('SELECT id,payload_hash,data FROM nova_capture_requests WHERE client=$1 AND submission_id=$2 FOR UPDATE',[client,input.submissionId])).rows[0];
      if (!existing || existing.payload_hash!==digest || existing.data.entryMode!==MODE) throw fail('conflict');
      return {id:existing.id,duplicate:true,sendsMessages:false};
    }
    await db.query("INSERT INTO jemlio_followups(request_id,due_at,action,updated_at) VALUES ($1,$2,'callback',$3)",[id,clean.due,at]);
    await db.query('INSERT INTO jemlio_workspace_audit(id,request_id,actor,fields,recorded_at) VALUES ($1,$2,$3,$4,$5)',[randomUUID(),id,actor,['manual_entry'],at]);
    // Manual entry intentionally has no email/CRM outbox and no visitor-consent claim.
    return {id,duplicate:false,sendsMessages:false};
  });
}
module.exports={createManual,validate,MODE,SOURCES};
