'use strict';
const { UPGRADE_UI_CLIENTS } = require('../upgrade-config');
const {randomUUID,randomBytes}=require('node:crypto');
const {hash,email,encrypt,decrypt}=require('./delivery');
const {UUID,scope}=require('../booking/store');
const {RETRY_WINDOW_MS}=require('../capture/notification');
const fail=code=>Object.assign(new Error(code),{code});
const TOKEN=/^[A-Za-z0-9_-]{43}$/;
const TOKEN_TTL=14*86400000;
const PUBLIC_STATES=new Set(['accepted','delivered','bounced','complained']);
const TERMINAL_RANK={accepted:0,delivered:1,bounced:2,complained:3};
function object(input,keys){if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(k=>!keys.includes(k)))throw fail('invalid_request');}
function text(value,max=2000){if(typeof value!=='string'||!value.trim()||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value))throw fail('invalid_request');return value.trim();}
function checkRevision(input,thread){if(typeof input!=='string'||input!==String(thread.version))throw fail('conflict');}
function templates(name){
  const ending=`\n\nVennlig hilsen\n${name}`;
  return [
    {id:'acknowledgement',label:'Bekreft mottatt henvendelse',subject:'Svar på henvendelsen din',body:'Hei!\n\nTakk for henvendelsen. Vi har mottatt spørsmålet ditt og følger det opp.'+ending},
    {id:'question',label:'Be om mer informasjon',subject:'Et spørsmål om henvendelsen din',body:'Hei!\n\nTakk for henvendelsen. Kan du fortelle litt mer om hva du trenger hjelp med?'+ending},
    {id:'followup',label:'Følg opp henvendelsen',subject:'Oppfølging av henvendelsen din',body:'Hei!\n\nVi følger opp henvendelsen din. Ønsker du at vi tar den videre?'+ending}
  ];
}
async function invalidateForClose(db,client,id,at=new Date()){
  if(!(await db.query("SELECT to_regclass('public.jemlio_conversation_threads') IS NOT NULL AS ready")).rows[0]?.ready)return;
  await db.query(`UPDATE jemlio_conversation_threads SET version=version+1,context_version=context_version+1,updated_at=$3 WHERE request_id=$1 AND client=$2`,[id,client,at]);
  await db.query(`UPDATE jemlio_conversation_messages SET state=CASE WHEN first_attempt_at IS NULL THEN 'stale' ELSE 'needs_review' END,
    error_code='request_closed',locked_until=NULL,lock_token=NULL,updated_at=$3 WHERE request_id=$1 AND client=$2 AND state IN ('draft','queued','sending')`,[id,client,at]);
  // A reopened enquiry needs a newly approved message and private link. Closing
  // permanently revokes every older link, including already delivered messages.
  await db.query('DELETE FROM jemlio_conversation_tokens WHERE request_id=$1 AND client=$2',[id,client]);
}
class ConversationStore{
  constructor({pool,now=Date.now,enabled=()=>false,businessName=()=>'',sendSettings=()=>null,secret=null,origin=''}){
    this.pool=pool;this.now=now;this.enabled=enabled;this.businessName=businessName;this.sendSettings=sendSettings;this.secret=secret;this.origin=origin;
  }
  async ready(){return (await this.pool.query(`SELECT to_regclass('public.jemlio_conversation_threads') IS NOT NULL AND
    to_regclass('public.jemlio_conversation_messages') IS NOT NULL AND to_regclass('public.jemlio_conversation_tokens') IS NOT NULL AND
    to_regclass('public.jemlio_conversation_delivery_events') IS NOT NULL AND to_regclass('public.jemlio_conversation_suppressions') IS NOT NULL AS ready`)).rows[0]?.ready===true;}
  async transaction(fn){const db=await this.pool.connect();try{await db.query('BEGIN');const result=await fn(db);await db.query('COMMIT');return result;}catch(error){await db.query('ROLLBACK').catch(()=>{});throw error;}finally{db.release();}}
  async parent(db,client,id,{allowClosed=false}={}){
    scope(client,id);if(!this.enabled(client))throw fail('unavailable');
    await db.query('SELECT id FROM nova_capture_requests WHERE client=$1 AND id=$2 FOR UPDATE',[client,id]);
    const row=(await db.query(`SELECT r.*,COALESCE(o.outcome,'new') AS outcome FROM nova_capture_requests r
      LEFT JOIN nova_capture_outcomes o ON o.request_id=r.id WHERE r.client=$1 AND r.id=$2`,[client,id])).rows[0];
    if(!row)throw fail('not_found');if(!allowClosed&&['won','lost'].includes(row.outcome))throw fail('request_closed');return row;
  }
  async thread(db,client,id){
    await db.query('INSERT INTO jemlio_conversation_threads(request_id,client,updated_at) VALUES($1,$2,$3) ON CONFLICT(request_id) DO NOTHING',[id,client,new Date(this.now())]);
    const row=(await db.query('SELECT * FROM jemlio_conversation_threads WHERE request_id=$1 AND client=$2',[id,client])).rows[0];
    if(!row)throw fail('not_found');return row;
  }
  async bump(db,id,context=false){return (await db.query(`UPDATE jemlio_conversation_threads SET version=version+1,
    context_version=context_version+$2,updated_at=$3 WHERE request_id=$1 RETURNING *`,[id,context?1:0,new Date(this.now())])).rows[0];}
  async suppressed(db,client,recipient){return Boolean((await db.query(`SELECT 1 WHERE
    EXISTS(SELECT 1 FROM jemlio_conversation_suppressions WHERE client=$1 AND recipient_hash=$2) OR
    EXISTS(SELECT 1 FROM jemlio_conversation_messages m JOIN jemlio_conversation_delivery_events e ON e.provider_id=m.provider_id
      WHERE m.client=$1 AND m.recipient=$3 AND e.kind IN ('bounced','complained'))`,[client,hash(recipient),recipient])).rows.length);}
  async audit(db,id,actor,field){await db.query('INSERT INTO jemlio_workspace_audit(id,request_id,actor,fields,recorded_at) VALUES($1,$2,$3,$4,$5)',[randomUUID(),id,actor,[field],new Date(this.now())]);}
  initial(row){return {id:'enquiry',kind:'enquiry',direction:'inbound',state:'received',subject:'Mottatt henvendelse',body:String(row.data?.message||''),createdAt:row.created_at,updatedAt:row.created_at};}
  present(row,publicView=false){return {id:row.id,kind:row.direction==='inbound'?'reply':'message',direction:row.direction,state:row.state,
    subject:row.subject,body:row.body,createdAt:row.created_at,updatedAt:row.updated_at,...(!publicView?{
      recipient:row.recipient||null,approvedAt:row.approved_at||null,errorCode:row.error_code||null,
      canCancel:['draft','queued'].includes(row.state)&&!row.first_attempt_at}: {})};}
  async snapshot(db,row,thread){
    const recipient=email(row.data?.email),closed=['won','lost'].includes(row.outcome);
    const reason=closed?'request_closed':!recipient?'recipient_unavailable':await this.suppressed(db,row.client,recipient)?'recipient_suppressed':!this.sendSettings(row.client)?'send_unavailable':null;
    const messages=(await db.query('SELECT * FROM jemlio_conversation_messages WHERE request_id=$1 AND client=$2 ORDER BY created_at,id',[row.id,row.client])).rows;
    return {enabled:true,revision:String(thread.version),recipient:recipient||'',canSend:!reason,sendUnavailableReason:reason,
      messages:[this.initial(row),...messages.map(m=>this.present(m))],templates:templates(this.businessName(row.client))};
  }
  async read(client,id){return this.transaction(async db=>{const row=await this.parent(db,client,id,{allowClosed:true});return this.snapshot(db,row,await this.thread(db,client,id));});}
  async draft(client,id,input,actor){
    object(input,['revision','template','body']);
    return this.transaction(async db=>{
      const row=await this.parent(db,client,id),thread=await this.thread(db,client,id);checkRevision(input.revision,thread);
      const selected=templates(this.businessName(client)).find(t=>t.id===input.template);if(!selected)throw fail('invalid_request');
      const recipient=email(row.data?.email);if(!recipient)throw fail('recipient_unavailable');
      if(await this.suppressed(db,client,recipient))throw fail('recipient_suppressed');
      if((await db.query("SELECT 1 FROM jemlio_conversation_messages WHERE request_id=$1 AND state IN ('queued','sending','needs_review')",[id])).rows.length)throw fail('conflict');
      const body=input.body===undefined?selected.body:text(input.body);const at=new Date(this.now());
      await db.query("UPDATE jemlio_conversation_messages SET state='superseded',updated_at=$2 WHERE request_id=$1 AND state='draft'",[id,at]);
      const draftId=randomUUID();await db.query(`INSERT INTO jemlio_conversation_messages(id,request_id,client,direction,state,template,subject,body,recipient,context_version,created_at,updated_at)
        VALUES($1,$2,$3,'outbound','draft',$4,$5,$6,$7,$8,$9,$9)`,[draftId,id,client,selected.id,selected.subject,body,recipient,thread.context_version,at]);
      const changed=await this.bump(db,id);await this.audit(db,id,actor,'conversation_draft');
      return {...await this.snapshot(db,row,changed),draftId};
    });
  }
  async send(client,id,input,actor){
    object(input,['revision','draftId','recipient','body','approved']);if(input.approved!==true)throw fail('approval_required');
    if(!UUID.test(input.draftId||'')||typeof input.recipient!=='string')throw fail('invalid_request');
    return this.transaction(async db=>{
      const row=await this.parent(db,client,id),thread=await this.thread(db,client,id);
      const message=(await db.query('SELECT * FROM jemlio_conversation_messages WHERE id=$1 AND request_id=$2 AND client=$3',[input.draftId,id,client])).rows[0];
      if(!message||message.direction!=='outbound')throw fail('not_found');
      const recipient=email(row.data?.email);if(!recipient||input.recipient!==recipient||message.recipient!==recipient)throw fail('recipient_mismatch');
      if(input.body!==message.body)throw fail('conflict');
      // A lost approval response may be retried verbatim, never requeued.
      if(message.approved_at)return {...await this.snapshot(db,row,thread),duplicate:true};
      checkRevision(input.revision,thread);if(message.state!=='draft'||String(message.context_version)!==String(thread.context_version))throw fail('conflict');
      if(await this.suppressed(db,client,recipient))throw fail('recipient_suppressed');
      const sender=this.sendSettings(client);if(!sender||!this.secret)throw fail('send_unavailable');
      const token=randomBytes(32).toString('base64url'),expires=new Date(this.now()+TOKEN_TTL),at=new Date(this.now());
      const replyUrl=UPGRADE_UI_CLIENTS.has(client) ? `${this.origin}/demos/${client}?reply=1#reply=${token}` : `${this.origin}/reply/#${token}`;
      const notification={...sender,to:[recipient],subject:message.subject,
        text:`${message.body}\n\nSvar trygt på denne henvendelsen:\n${replyUrl}\n\nLenken er privat og gjelder i 14 dager. Ikke del den med andre.`,
        tags:[{name:'jemlio_message',value:message.id}]};
      const encrypted=encrypt(notification,this.secret,`${client}:${id}:${message.id}`);
      await db.query(`INSERT INTO jemlio_conversation_tokens(token_hash,request_id,message_id,client,recipient,expires_at) VALUES($1,$2,$3,$4,$5,$6)`,[hash(token),id,message.id,client,recipient,expires]);
      await db.query(`UPDATE jemlio_conversation_messages SET state='queued',approved_at=$2,approved_by=$3,encrypted_payload=$4,sender_hash=$5,
        next_attempt_at=$2,updated_at=$2 WHERE id=$1`,[message.id,at,actor,encrypted,hash(JSON.stringify(sender))]);
      const changed=await this.bump(db,id);await this.audit(db,id,actor,'conversation_approved');
      return {...await this.snapshot(db,row,changed),duplicate:false};
    });
  }
  async cancel(client,id,input,actor){
    object(input,['revision','messageId']);if(!UUID.test(input.messageId||''))throw fail('invalid_request');
    return this.transaction(async db=>{const row=await this.parent(db,client,id),thread=await this.thread(db,client,id);checkRevision(input.revision,thread);
      const result=await db.query(`UPDATE jemlio_conversation_messages SET state='cancelled',updated_at=$4 WHERE id=$1 AND request_id=$2 AND client=$3
        AND state IN ('draft','queued') AND first_attempt_at IS NULL RETURNING id`,[input.messageId,id,client,new Date(this.now())]);
      if(!result.rows.length)throw fail('conflict');await db.query('DELETE FROM jemlio_conversation_tokens WHERE message_id=$1',[input.messageId]);
      const changed=await this.bump(db,id);await this.audit(db,id,actor,'conversation_cancelled');return this.snapshot(db,row,changed);
    });
  }
  async tokenParent(db,token,expectedClient){
    if(expectedClient !== undefined && (typeof expectedClient !== 'string' || !/^[a-z0-9-]{1,64}$/.test(expectedClient)))throw fail('invalid_request');
    if(typeof token!=='string'||!TOKEN.test(token))throw fail('reply_unavailable');
    const before=(await db.query('SELECT * FROM jemlio_conversation_tokens WHERE token_hash=$1',[hash(token)])).rows[0];
    if(!before||!this.enabled(before.client)||(expectedClient !== undefined && expectedClient !== before.client))throw fail('reply_unavailable');
    let row;try{row=await this.parent(db,before.client,before.request_id);}catch{throw fail('reply_unavailable');}
    const link=(await db.query(`SELECT t.*,m.first_attempt_at,m.subject FROM jemlio_conversation_tokens t JOIN jemlio_conversation_messages m ON m.id=t.message_id
      WHERE t.token_hash=$1 AND t.client=$2 AND t.request_id=$3`,[hash(token),row.client,row.id])).rows[0];
    if(!link||!link.first_attempt_at||Date.parse(link.expires_at)<=this.now()||email(row.data?.email)!==link.recipient)throw fail('reply_unavailable');
    return {row,link,thread:await this.thread(db,row.client,row.id)};
  }
  async publicSnapshot(db,{row,link,thread}){
    const messages=(await db.query('SELECT * FROM jemlio_conversation_messages WHERE request_id=$1 AND client=$2 ORDER BY created_at,id',[row.id,row.client])).rows;
    return {businessName:this.businessName(row.client),subject:link.subject,expiresAt:link.expires_at,revision:String(thread.version),
      messages:[this.initial(row),...messages.filter(m=>m.direction==='inbound'||PUBLIC_STATES.has(m.state)).map(m=>this.present(m,true))]};
  }
  async publicRead(token,client){return this.transaction(async db=>this.publicSnapshot(db,await this.tokenParent(db,token,client)));}
  async respond(input){
    object(input,['token','submissionId','message','revision','client']);if(!UUID.test(input.submissionId||''))throw fail('invalid_request');const body=text(input.message),digest=hash(body);
    return this.transaction(async db=>{
      const context=await this.tokenParent(db,input.token,input.client),{row,thread}=context;
      const previous=(await db.query('SELECT * FROM jemlio_conversation_messages WHERE request_id=$1 AND submission_id=$2',[row.id,input.submissionId])).rows[0];
      if(previous){if(previous.direction!=='inbound'||previous.payload_hash!==digest)throw fail('submission_conflict');return {accepted:true,duplicate:true,conversation:await this.publicSnapshot(db,context)};}
      checkRevision(input.revision,thread);const at=new Date(this.now());
      await db.query(`INSERT INTO jemlio_conversation_messages(id,request_id,client,direction,state,subject,body,context_version,submission_id,payload_hash,created_at,updated_at)
        VALUES($1,$2,$3,'inbound','received','Kundens svar',$4,$5,$6,$7,$8,$8)`,[randomUUID(),row.id,row.client,body,thread.context_version,input.submissionId,digest,at]);
      await db.query(`UPDATE jemlio_conversation_messages SET state=CASE WHEN first_attempt_at IS NULL THEN 'stale' ELSE 'needs_review' END,
        error_code='new_customer_reply',locked_until=NULL,lock_token=NULL,updated_at=$2 WHERE request_id=$1 AND state IN ('draft','queued','sending')`,[row.id,at]);
      await db.query(`INSERT INTO jemlio_followups(request_id,due_at,action,updated_at) VALUES($1,$2,'review',$2)
        ON CONFLICT(request_id) DO UPDATE SET due_at=EXCLUDED.due_at,action='review',updated_at=GREATEST(EXCLUDED.updated_at,jemlio_followups.updated_at+interval '1 millisecond')`,[row.id,at]);
      context.thread=await this.bump(db,row.id,true);await this.audit(db,row.id,'private-reply-link','conversation_reply');
      return {accepted:true,duplicate:false,conversation:await this.publicSnapshot(db,context)};
    });
  }
  async invalidateForClose(db,client,id){return invalidateForClose(db,client,id,new Date(this.now()));}
  async claimNext(){
    const candidates=(await this.pool.query(`SELECT id,request_id,client FROM jemlio_conversation_messages WHERE state IN ('queued','sending')
      AND next_attempt_at<=$1 AND (locked_until IS NULL OR locked_until<=$1) ORDER BY next_attempt_at,id LIMIT 20`,[new Date(this.now())])).rows;
    for(const candidate of candidates){const claim=await this.transaction(async db=>{
      await db.query('SELECT id FROM nova_capture_requests WHERE client=$1 AND id=$2 FOR UPDATE',[candidate.client,candidate.request_id]);
      const message=(await db.query(`SELECT * FROM jemlio_conversation_messages WHERE id=$1 AND state IN ('queued','sending')
        AND next_attempt_at<=$2 AND (locked_until IS NULL OR locked_until<=$2) FOR UPDATE`,[candidate.id,new Date(this.now())])).rows[0];
      if(!message)return null;
      const token=randomUUID(),at=new Date(this.now());
      return (await db.query(`UPDATE jemlio_conversation_messages SET state='sending',attempts=attempts+1,first_attempt_at=COALESCE(first_attempt_at,$2),
        locked_until=$3,lock_token=$4,updated_at=$2 WHERE id=$1 RETURNING *`,[message.id,at,new Date(this.now()+60000),token])).rows[0];
    });if(claim)return claim;}return null;
  }
  async dispatch(claim,sendMessage){
    // The attempt is committed before provider I/O. A second transaction holds
    // the parent lock through dispatch, serializing close/reply/delete with send.
    return this.transaction(async db=>{
      await db.query('SELECT id FROM nova_capture_requests WHERE client=$1 AND id=$2 FOR UPDATE',[claim.client,claim.request_id]);
      let message=(await db.query('SELECT * FROM jemlio_conversation_messages WHERE id=$1 AND lock_token=$2 FOR UPDATE',[claim.id,claim.lock_token])).rows[0];
      if(!message||message.state!=='sending')return {state:'claim_lost'};
      const stop=async(code)=>{await db.query("UPDATE jemlio_conversation_messages SET state='needs_review',error_code=$2,lock_token=NULL,locked_until=NULL,updated_at=$3 WHERE id=$1",[message.id,code,new Date(this.now())]);return {state:'needs_review'};};
      let row;try{row=await this.parent(db,claim.client,claim.request_id);}catch(error){return stop(error.code==='request_closed'?'request_closed':'tenant_disabled');}
      const thread=await this.thread(db,row.client,row.id),sender=this.sendSettings(row.client);
      if(String(thread.context_version)!==String(message.context_version))return stop('stale_context');
      if(!sender||hash(JSON.stringify(sender))!==message.sender_hash)return stop('sender_changed');
      if(email(row.data?.email)!==message.recipient)return stop('recipient_changed');
      if(await this.suppressed(db,row.client,message.recipient))return stop('recipient_suppressed');
      if(this.now()-Date.parse(message.first_attempt_at)>=RETRY_WINDOW_MS)return stop('retry_window_expired');
      let notification;try{notification=decrypt(message.encrypted_payload,this.secret,`${row.client}:${row.id}:${message.id}`);}catch{return stop('payload_unavailable');}
      if(notification.to?.length!==1||notification.to[0]!==message.recipient||notification.from!==sender.from)return stop('payload_mismatch');
      try{
        const result=await sendMessage({notification,idempotencyKey:`jemlio-conversation/${message.id}`});
        if(!result||typeof result.providerId!=='string'||!result.providerId||result.providerId.length>200)throw Object.assign(Error('uncertain'),{retryable:true,code:'provider_response_uncertain'});
        await db.query(`UPDATE jemlio_conversation_messages SET state='accepted',provider_id=$2,error_code=NULL,lock_token=NULL,locked_until=NULL,updated_at=$3 WHERE id=$1`,[message.id,result.providerId,new Date(this.now())]);
        message={...message,provider_id:result.providerId,state:'accepted'};await this.applyEvents(db,message);
        return {state:(await db.query('SELECT state FROM jemlio_conversation_messages WHERE id=$1',[message.id])).rows[0].state};
      }catch(error){
        // Transaction/storage failure after acceptance must roll back to durable
        // sending; do not turn a provider success into a new payload or key.
        if(error.code&&!/^(network_uncertain|payload_conflict|provider_response_uncertain|provider_\d{3})$/.test(error.code))throw error;
        const next=this.now()+Math.min(3600000,30000*2**Math.min(message.attempts-1,7));
        const state=error.code==='payload_conflict'||error.retryable===false&&message.attempts>1?'needs_review':error.retryable===false?'failed':next-Date.parse(message.first_attempt_at)>=RETRY_WINDOW_MS?'needs_review':'queued';
        const code=/^(network_uncertain|payload_conflict|provider_response_uncertain|provider_\d{3})$/.test(error.code||'')?error.code:'delivery_uncertain';
        await db.query('UPDATE jemlio_conversation_messages SET state=$2,error_code=$3,next_attempt_at=$4,lock_token=NULL,locked_until=NULL,updated_at=$5 WHERE id=$1',[message.id,state,code,new Date(next),new Date(this.now())]);return {state};
      }
    });
  }
  async applyEvents(db,message){
    if(!message.provider_id)return;
    const events=(await db.query('SELECT kind FROM jemlio_conversation_delivery_events WHERE provider_id=$1',[message.provider_id])).rows;
    let next=message.state,rank=TERMINAL_RANK[next]??-1;
    for(const event of events)if(TERMINAL_RANK[event.kind]>rank){next=event.kind;rank=TERMINAL_RANK[next];}
    if(next!==message.state)await db.query('UPDATE jemlio_conversation_messages SET state=$2,updated_at=$3 WHERE id=$1',[message.id,next,new Date(this.now())]);
    if(next==='bounced'||next==='complained'){
      await db.query(`INSERT INTO jemlio_conversation_suppressions(client,recipient_hash,reason,created_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(client,recipient_hash) DO UPDATE SET reason=CASE WHEN jemlio_conversation_suppressions.reason='complained' THEN 'complained' ELSE EXCLUDED.reason END`,[message.client,hash(message.recipient),next,new Date(this.now())]);
      // Queued messages for other enquiries to this recipient will also fail
      // their mandatory suppression check immediately before provider dispatch.
    }
  }
  async deliveryEvent({eventId,providerId,kind}){
    return this.transaction(async db=>{
      const result=await db.query(`INSERT INTO jemlio_conversation_delivery_events(event_id,provider_id,kind,received_at) VALUES($1,$2,$3,$4)
        ON CONFLICT(event_id) DO NOTHING RETURNING event_id`,[eventId,providerId,kind,new Date(this.now())]);
      if(!result.rows.length){const old=(await db.query('SELECT provider_id,kind FROM jemlio_conversation_delivery_events WHERE event_id=$1',[eventId])).rows[0];if(old.provider_id!==providerId||old.kind!==kind)throw fail('submission_conflict');}
      return {accepted:true,duplicate:!result.rows.length};
    });
  }
  async reconcileEvents(){
    const pending=(await this.pool.query(`SELECT DISTINCT m.id,m.request_id,m.client FROM jemlio_conversation_messages m
      JOIN jemlio_conversation_delivery_events e ON e.provider_id=m.provider_id WHERE
      (e.kind='complained' AND m.state<>'complained') OR
      (e.kind='bounced' AND m.state NOT IN ('bounced','complained')) OR
      (e.kind='delivered' AND m.state NOT IN ('delivered','bounced','complained')) LIMIT 100`)).rows;
    for(const row of pending)await this.transaction(async db=>{
      await db.query('SELECT id FROM nova_capture_requests WHERE client=$1 AND id=$2 FOR UPDATE',[row.client,row.request_id]);
      const message=(await db.query('SELECT * FROM jemlio_conversation_messages WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(message)await this.applyEvents(db,message);
    });
  }
}
module.exports={ConversationStore,invalidateForClose,templates,fail,TOKEN,TOKEN_TTL,object,text};
