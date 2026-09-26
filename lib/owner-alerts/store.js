'use strict';
const {randomUUID}=require('node:crypto');
const {WorkspaceStore}=require('../workspace/store');
function osloDay(at){
  const p=Object.fromEntries(new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/Oslo',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',hourCycle:'h23'}).formatToParts(new Date(at)).map(x=>[x.type,x.value]));
  return {date:`${p.year}-${p.month}-${p.day}`,hour:Number(p.hour)};
}
class AlertStore {
  constructor({pool,now=Date.now}){this.pool=pool;this.now=now;this.durable=true;this.workspace=new WorkspaceStore({pool,now});}
  async ready(){return (await this.pool.query("SELECT to_regclass('public.jemlio_owner_alerts') IS NOT NULL AS ready")).rows[0]?.ready===true;}
  async enqueue(client,key,kind,offerId,notification){
    const at=new Date(this.now());
    await this.pool.query(`INSERT INTO jemlio_owner_alerts(id,client,event_key,kind,offer_id,notification,next_attempt_at,created_at,updated_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$7,$7) ON CONFLICT(client,event_key) DO NOTHING`,[randomUUID(),client,key,kind,offerId,notification,at]);
  }
  async collect(client,cfg){
    // Poll durable source records: a crash between receiving a reply and queuing
    // its alert cannot lose the reply. Unique event keys survive concurrent workers.
    const replies=await this.pool.query(`SELECT q.id FROM jemlio_offers q JOIN nova_capture_requests r ON r.id=q.request_id
      LEFT JOIN nova_capture_outcomes o ON o.request_id=r.id LEFT JOIN jemlio_followups f ON f.request_id=r.id
      WHERE r.client=$1 AND q.state='responded' AND q.responded_at >= $2 AND COALESCE(o.outcome,'new') NOT IN ('won','lost')
      AND COALESCE(f.action,'review')<>'done' AND NOT EXISTS(SELECT 1 FROM jemlio_owner_alerts a WHERE a.client=$1 AND a.event_key='response:'||q.id::text)
      ORDER BY q.responded_at LIMIT 100`,[client,cfg.startAt]);
    const base={from:cfg.from,to:[cfg.to]};
    for(const row of cfg.responses?replies.rows:[])await this.enqueue(client,'response:'+row.id,'response',row.id,{...base,
      subject:'Jemlio: nytt svar på et prisforslag',text:`Et nytt kundesvar trenger personlig oppfølging. Åpne arbeidsoversikten og velg Prisforslag → Kundesvar.\n\n${cfg.origin}/workspace\n\nDette er et varsel, ikke en bekreftelse på salg eller bestilling.`});
    const day=osloDay(this.now());
    if(this.now()<Date.parse(cfg.startAt)||day.hour<cfg.digestHour)return;
    const key='digest:'+day.date;
    if((await this.pool.query('SELECT 1 FROM jemlio_owner_alerts WHERE client=$1 AND event_key=$2',[client,key])).rows.length)return;
    // Use the same queue semantics as the owner's result report, including
    // unresolved calendar/booking checks. No customer details in the email.
    const count=(await this.workspace.results({client})).totals.due;
    if(!count)return; // Empty mornings do not send mail; check again next tick.
    await this.enqueue(client,key,'digest',null,{...base,subject:`Jemlio: ${count} henvendelser trenger oppfølging`,
      text:`Dagens oversikt (${day.date}, norsk tid): ${count} henvendelser trenger oppfølging eller kontroll. Dette er et øyeblikksbilde; arbeidslisten viser gjeldende status.\n\nÅpne Oppfølging i arbeidsoversikten:\n${cfg.origin}/workspace\n\nIngen meldinger er sendt til kundene.`});
  }
  async claimNext(at=this.now()){
    const token=randomUUID();
    const r=await this.pool.query(`WITH next AS (SELECT id FROM jemlio_owner_alerts WHERE status IN ('pending','sending') AND next_attempt_at<=$1
      AND (locked_until IS NULL OR locked_until<=$1) ORDER BY next_attempt_at,id FOR UPDATE SKIP LOCKED LIMIT 1)
      UPDATE jemlio_owner_alerts a SET status='sending',lock_token=$2,locked_until=$3,first_attempt_at=COALESCE(first_attempt_at,$1),attempts=attempts+1,updated_at=$1
      FROM next WHERE a.id=next.id RETURNING a.*,a.id AS request_id`,[new Date(at),token,new Date(at+60000)]);
    return r.rows[0]||null;
  }
  async finish(claim,{status,providerId=null,errorCode=null,nextAttemptAt,at=this.now()}){
    const r=await this.pool.query(`UPDATE jemlio_owner_alerts SET status=$3,provider_id=$4,error_code=$5,next_attempt_at=$6,locked_until=NULL,lock_token=NULL,updated_at=$7
      WHERE id=$1 AND lock_token=$2 RETURNING id`,[claim.request_id,claim.lock_token,status,providerId,errorCode,new Date(nextAttemptAt||at),new Date(at)]);return r.rows.length===1;
  }
  async status(client){
    const r=await this.pool.query('SELECT status,count(*)::int AS count FROM jemlio_owner_alerts WHERE client=$1 GROUP BY status',[client]);
    return Object.fromEntries(r.rows.map(x=>[x.status,x.count]));
  }
}
module.exports={AlertStore,osloDay};
