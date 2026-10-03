'use strict';
const { randomUUID, randomBytes, createHmac } = require('node:crypto');
const { encrypt, decrypt } = require('../enquiry-conversations/delivery');
const { digest } = require('./config');
const { fail } = require('./twilio');
const DAY = 86400000;
class RecoveryStore {
  constructor({ pool, key, now = Date.now }) { this.pool=pool; this.key=key; this.now=now; }
  phoneKey(client, phone) { return createHmac('sha256',this.key).update(client+':'+phone).digest('hex'); }
  context(row) { return 'missed-call:'+row.client+':'+row.id; }
  decode(row) { return decrypt(row.encrypted_payload,this.key,this.context(row)); }
  async ready() {
    if(!this.pool || !this.key)return false;
    const r=await this.pool.query("SELECT to_regclass('public.jemlio_missed_calls') IS NOT NULL AND to_regclass('public.jemlio_missed_call_guards') IS NOT NULL AND to_regclass('public.jemlio_sms_suppressions') IS NOT NULL AND to_regclass('public.jemlio_missed_call_keyring') IS NOT NULL AS ready");
    if(r.rows[0]?.ready!==true)return false;
    const pinned=(await this.pool.query('SELECT fingerprint FROM jemlio_missed_call_keyring WHERE singleton=true')).rows[0];
    return pinned?.fingerprint===digest(this.key);
  }
  async transaction(fn) { const db=await this.pool.connect();try{await db.query('BEGIN');const r=await fn(db);await db.query('COMMIT');return r;}catch(e){await db.query('ROLLBACK').catch(()=>{});throw e;}finally{db.release();} }
  async receive(client,t,event) {
    const id=randomUUID(),token=randomBytes(32).toString('hex'),at=this.now();
    const row={id,client};const envelope=encrypt({...event,token},this.key,this.context(row));
    const eventHash=digest(JSON.stringify(event));
    const r=await this.pool.query(`INSERT INTO jemlio_missed_calls
      (id,client,account_sid,parent_sid,child_sid,event_hash,phone_key,config_hash,encrypted_payload,token_hash,available_at,created_at,expires_at,receipt)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$11,$12,$13)
      ON CONFLICT(account_sid,parent_sid) DO NOTHING RETURNING id`,
      [id,client,t.accountSid,event.parentSid,event.childSid,eventHash,this.phoneKey(client,event.from),t.fingerprint,envelope,digest(token),new Date(at),new Date(at+3*DAY),randomUUID()]);
    if(!r.rows.length){const previous=(await this.pool.query('SELECT client,event_hash FROM jemlio_missed_calls WHERE account_sid=$1 AND parent_sid=$2',[t.accountSid,event.parentSid])).rows[0];
      if(previous?.client!==client || previous.event_hash!==eventHash)throw fail('event_conflict');}
    return {duplicate:!r.rows.length};
  }
  async claim() {
    const at=this.now(),claim=randomUUID();
    // An expired send lease is NEVER a permission to issue another POST.
    await this.pool.query("UPDATE jemlio_missed_calls SET state='uncertain',reason='send_interrupted',claim=NULL,lease_until=NULL WHERE state='sending' AND lease_until<=$1",[new Date(at)]);
    return (await this.pool.query(`WITH next AS (SELECT id FROM jemlio_missed_calls WHERE
      (state='pending' OR state='verifying' AND lease_until<=$1) AND available_at<=$1 AND revoked=false
      ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE jemlio_missed_calls r SET state='verifying',claim=$2,lease_until=$3,attempts=attempts+1
      FROM next WHERE r.id=next.id RETURNING r.*`,[new Date(at),claim,new Date(at+60000)])).rows[0]||null;
  }
  async stop(row,reason) {
    await this.pool.query("UPDATE jemlio_missed_calls SET state='blocked',reason=$3,revoked=true,claim=NULL,lease_until=NULL WHERE id=$1 AND claim=$2 AND state='verifying'",[row.id,row.claim,reason]);
  }
  async retryRead(row) {
    if(row.attempts>=3 || this.now()-Date.parse(row.created_at)>10*60000)return this.stop(row,'verification_unavailable');
    await this.pool.query("UPDATE jemlio_missed_calls SET state='pending',reason='verification_retry',claim=NULL,lease_until=NULL,available_at=$3 WHERE id=$1 AND claim=$2 AND state='verifying'",[row.id,row.claim,new Date(this.now()+30000)]);
  }
  async reserve(row,t) {
    return this.transaction(async db=>{
      await db.query('INSERT INTO jemlio_missed_call_guards(client) VALUES($1) ON CONFLICT DO NOTHING',[row.client]);
      await db.query('SELECT client FROM jemlio_missed_call_guards WHERE client=$1 FOR UPDATE',[row.client]);
      const current=(await db.query('SELECT * FROM jemlio_missed_calls WHERE id=$1 FOR UPDATE',[row.id])).rows[0];
      if(!current || current.claim!==row.claim || current.state!=='verifying' || current.revoked || Date.parse(current.lease_until)<=this.now())return false;
      const at=this.now();let reason;
      if(current.config_hash!==t.fingerprint)reason='configuration_changed';
      else if(Date.parse(current.expires_at)<=at)reason='expired';
      else if((await db.query('SELECT 1 FROM jemlio_sms_suppressions WHERE client=$1 AND phone_key=$2',[row.client,row.phone_key])).rows.length)reason='opted_out';
      else if((await db.query('SELECT 1 FROM jemlio_missed_calls WHERE client=$1 AND phone_key=$2 AND attempted_at>$3 LIMIT 1',[row.client,row.phone_key,new Date(at-DAY)])).rows.length)reason='recipient_cooldown';
      else if(Number((await db.query('SELECT COUNT(*) AS count FROM jemlio_missed_calls WHERE client=$1 AND attempted_at>$2',[row.client,new Date(at-DAY)])).rows[0].count)>=t.dailyLimit)reason='daily_limit';
      if(reason){await db.query("UPDATE jemlio_missed_calls SET state='blocked',reason=$2,revoked=true,claim=NULL,lease_until=NULL WHERE id=$1",[row.id,reason]);return false;}
      await db.query("UPDATE jemlio_missed_calls SET state='sending',attempted_at=$2,lease_until=$3,reason=NULL WHERE id=$1",[row.id,new Date(at),new Date(at+30000)]);return true;
    });
  }
  async canDispatch(row) {
    return Boolean((await this.pool.query("SELECT 1 FROM jemlio_missed_calls WHERE id=$1 AND claim=$2 AND state='sending' AND revoked=false AND lease_until>$3",[row.id,row.claim,new Date(this.now())])).rows.length);
  }
  async get(client,id) {return (await this.pool.query('SELECT * FROM jemlio_missed_calls WHERE client=$1 AND id=$2',[client,id])).rows[0]||null;}
  async finish(row,result) {
    // A signed delivery callback may precede the REST response; never overwrite it.
    await this.pool.query(`UPDATE jemlio_missed_calls SET state=CASE WHEN delivery_rank>0 THEN state ELSE $3 END,
      provider_sid=COALESCE(provider_sid,$4),reason=CASE WHEN delivery_rank>0 THEN reason ELSE $5 END,
      claim=NULL,lease_until=NULL WHERE id=$1 AND claim=$2 AND (provider_sid IS NULL OR provider_sid=$4 OR $4 IS NULL)`,
      [row.id,row.claim,result.state,result.sid||null,result.reason||null]);
  }
  async delivery(client,id,sid,status,phone) {
    const ranks={accepted:1,queued:1,sending:2,sent:3,delivered:4,failed:5,undelivered:5};if(!Object.hasOwn(ranks,status))return;
    await this.transaction(async db=>{
      const r=(await db.query('SELECT * FROM jemlio_missed_calls WHERE id=$1 AND client=$2 FOR UPDATE',[id,client])).rows[0];
      if(!r || !r.attempted_at || r.phone_key!==this.phoneKey(client,phone) || r.provider_sid&&r.provider_sid!==sid || r.delivery_rank>=ranks[status])return;
      // Contradictory terminal events need review, not a false delivery confirmation.
      const conflict=r.state==='delivered'&&ranks[status]===5;
      const state=conflict?'uncertain':ranks[status]===5?'failed':status==='delivered'?'delivered':status==='sent'?'sent':'accepted';
      await db.query('UPDATE jemlio_missed_calls SET state=$2,provider_sid=$3,delivery_rank=$4,reason=$5 WHERE id=$1',[id,state,sid,ranks[status],conflict?'delivery_conflict':state==='failed'?'delivery_failed':null]);
    });
  }
  async suppress(client,phone) {
    await this.transaction(async db=>{
      await db.query('INSERT INTO jemlio_missed_call_guards(client) VALUES($1) ON CONFLICT DO NOTHING',[client]);
      await db.query('SELECT client FROM jemlio_missed_call_guards WHERE client=$1 FOR UPDATE',[client]);
      const key=this.phoneKey(client,phone);
      await db.query('INSERT INTO jemlio_sms_suppressions(client,phone_key,created_at) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',[client,key,new Date(this.now())]);
      await db.query("UPDATE jemlio_missed_calls SET revoked=true,state=CASE WHEN attempted_at IS NULL THEN 'blocked' ELSE state END,reason='opted_out' WHERE client=$1 AND phone_key=$2",[client,key]);
    });
  }
  async resolve(token) {
    if(!/^[a-f0-9]{64}$/.test(token||''))throw fail('link_unavailable');
    const row=(await this.pool.query('SELECT * FROM jemlio_missed_calls WHERE token_hash=$1',[digest(token)])).rows[0];
    if(!row || row.revoked || !row.attempted_at || !row.encrypted_payload || Date.parse(row.expires_at)<=this.now())throw fail('link_unavailable');
    if(row.submitted_hash && !row.request_id)throw fail('link_unavailable');
    if((await this.pool.query('SELECT 1 FROM jemlio_sms_suppressions WHERE client=$1 AND phone_key=$2',[row.client,row.phone_key])).rows.length)throw fail('link_unavailable');
    return row;
  }
  async list(client) {
    const rows=(await this.pool.query('SELECT * FROM jemlio_missed_calls WHERE client=$1 ORDER BY created_at DESC LIMIT 30',[client])).rows;
    return {items:rows.map(r=>({id:r.id,state:r.state==='sending'&&Date.parse(r.lease_until)<=this.now()?'uncertain':r.state,reason:r.state==='sending'&&Date.parse(r.lease_until)<=this.now()?'send_interrupted':r.reason,createdAt:r.created_at,requestId:r.request_id,revoked:r.revoked,
      phone:r.encrypted_payload?this.decode(r).from:null})),automaticRetry:false};
  }
  async cancel(client,id) {
    const r=await this.pool.query("UPDATE jemlio_missed_calls SET revoked=true,state=CASE WHEN attempted_at IS NULL THEN 'blocked' ELSE state END,reason='owner_closed' WHERE client=$1 AND id=$2 RETURNING attempted_at",[client,id]);
    if(!r.rows.length)throw fail('not_found');return {cancelled:true,mayAlreadyBeSent:Boolean(r.rows[0].attempted_at)};
  }
}
module.exports={RecoveryStore};
