'use strict';
const {randomUUID}=require('node:crypto');
const {BookingStore,scope}=require('../booking/store');
const {problem}=require('../booking/calendly');
const snapshot=b=>JSON.stringify([b.status,b.provider_id,b.slot,b.updated_at,b.calendar_state]);
class CalendarStore extends BookingStore{
  async ready(){
    return (await this.pool.query(`SELECT to_regclass('public.jemlio_calendar_jobs') IS NOT NULL AND
      to_regclass('public.jemlio_calendar_receipts') IS NOT NULL AND to_regclass('public.jemlio_calendar_aliases') IS NOT NULL AND
      to_regclass('public.jemlio_workflow_events') IS NOT NULL AND to_regclass('public.nova_capture_rate_limits') IS NOT NULL AND
      EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='jemlio_bookings' AND column_name='calendar_state') AS ready`)).rows[0]?.ready===true;
  }
  async enqueue(client,event,eventTypes){
    scope(client);
    return this.transaction(async db=>{
      const matches=await db.query(`SELECT r.id FROM nova_capture_requests r JOIN jemlio_bookings b ON b.request_id=r.id
        WHERE r.client=$1 AND b.event_type=ANY($2::text[]) AND
        (b.provider_id=ANY($3::text[]) OR b.attempt_id=$4::uuid OR EXISTS(SELECT 1 FROM jemlio_calendar_aliases a WHERE a.request_id=r.id AND a.provider_id=ANY($3::text[]))) LIMIT 2`,
      [client,eventTypes,event.references,event.attempt]);
      if(matches.rows.length!==1)return {accepted:false};
      const id=matches.rows[0].id;
      await this.enquiry(client,id,db,true);
      const b=(await db.query('SELECT * FROM jemlio_bookings WHERE request_id=$1',[id])).rows[0];
      if(!b)return {accepted:false};
      const inserted=await db.query('INSERT INTO jemlio_calendar_receipts(digest,request_id,recorded_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING RETURNING digest',[event.digest,id,new Date(this.now())]);
      if(!inserted.rows.length)return {accepted:true,duplicate:true};
      const available=new Date(this.now()+(b.status==='attempting'?30000:0));
      await db.query(`INSERT INTO jemlio_calendar_jobs(request_id,provider_hint,available_at,updated_at) VALUES ($1,$2,$3,$4)
        ON CONFLICT(request_id) DO UPDATE SET generation=jemlio_calendar_jobs.generation+1,available_at=EXCLUDED.available_at,
        attempts=0,last_error=NULL,updated_at=EXCLUDED.updated_at`,[id,event.hint,available,new Date(this.now())]);
      await db.query("UPDATE jemlio_bookings SET calendar_state='pending',updated_at=$2 WHERE request_id=$1",[id,new Date(this.now())]);
      return {accepted:true};
    });
  }
  async claim(clients){
    const lease=randomUUID(),at=new Date(this.now());
    return this.transaction(async db=>{
      const result=await db.query(`SELECT j.request_id,r.client FROM jemlio_calendar_jobs j JOIN nova_capture_requests r ON r.id=j.request_id
        WHERE r.client=ANY($1::text[]) AND j.available_at<=$2 AND (j.lease_until IS NULL OR j.lease_until<=$2)
        ORDER BY j.available_at,j.request_id LIMIT 1 FOR UPDATE OF j SKIP LOCKED`,[clients,at]);
      if(!result.rows.length)return null;
      const r=result.rows[0],job=(await db.query(`UPDATE jemlio_calendar_jobs SET lease_id=$2,lease_until=$3,attempts=attempts+1 WHERE request_id=$1 RETURNING *`,[r.request_id,lease,new Date(this.now()+180000)])).rows[0];
      return {...job,client:r.client};
    });
  }
  async process(job,provider,eventTypes){
    let b;
    try{
      b=await this.read(job.client,job.request_id);if(!b)return;
      if(!eventTypes.includes(b.event_type))throw problem('calendar_mismatch');
      const enquiry=await this.enquiry(job.client,job.request_id);
      const result=await provider.read({providerId:b.provider_id||job.provider_hint,eventType:b.event_type,slot:new Date(b.slot).toISOString(),email:enquiry.data.email});
      await this.transaction(async db=>{
        await this.enquiry(job.client,job.request_id,db,true);
        const current=(await db.query('SELECT * FROM jemlio_bookings WHERE request_id=$1',[job.request_id])).rows[0];
        const q=(await db.query('SELECT * FROM jemlio_calendar_jobs WHERE request_id=$1 FOR UPDATE',[job.request_id])).rows[0];
        if(!q||q.lease_id!==job.lease_id)return;
        if(q.generation!==job.generation||snapshot(current)!==snapshot(b))throw problem('calendar_changed');
        // A provider's active appointment does not prove attendance or undo a staff result.
        if(['completed','no_show'].includes(current.status)&&result.status==='confirmed'&&result.providerId===current.provider_id&&Date.parse(result.slot)===Date.parse(current.slot))result.status=current.status;
        else if(current.status==='completed'&&result.status!=='completed')throw problem('calendar_conflict');
        for(const uri of result.aliases){
          const alias=(await db.query(`INSERT INTO jemlio_calendar_aliases(provider_id,request_id) VALUES ($1,$2)
            ON CONFLICT(provider_id) DO UPDATE SET request_id=jemlio_calendar_aliases.request_id RETURNING request_id`,[uri,job.request_id])).rows[0];
          if(alias.request_id!==job.request_id)throw problem('calendar_mismatch');
        }
        await db.query(`UPDATE jemlio_bookings SET provider_id=$2,slot=$3,status=$4,cancel_url=$5,reschedule_url=$6,
          calendar_state='synced',calendar_checked_at=$7,error_code=NULL,updated_at=$7 WHERE request_id=$1`,
        [job.request_id,result.providerId,result.slot,result.status,result.cancelUrl,result.rescheduleUrl,new Date(this.now())]);
        await this.audit(db,job.request_id,Date.parse(current.slot)!==Date.parse(result.slot)?'calendar_rescheduled':'calendar_'+result.status);
        await db.query('DELETE FROM jemlio_calendar_jobs WHERE request_id=$1 AND lease_id=$2',[job.request_id,job.lease_id]);
      });
    }catch(error){await this.retry(job,error.code);}
  }
  async retry(job,code){
    await this.transaction(async db=>{
      const exists=await db.query('SELECT id FROM nova_capture_requests WHERE client=$1 AND id=$2 FOR UPDATE',[job.client,job.request_id]);
      if(!exists.rows.length)return;
      const q=(await db.query('SELECT * FROM jemlio_calendar_jobs WHERE request_id=$1 FOR UPDATE',[job.request_id])).rows[0];
      if(!q||q.lease_id!==job.lease_id)return;
      const newer=q.generation!==job.generation;
      const blocked=!newer&&(['calendar_mismatch','calendar_conflict'].includes(code)||q.attempts>=6);
      const safe=['calendar_mismatch','calendar_conflict','calendar_changed'].includes(code)?code:'calendar_unavailable';
      await db.query(`UPDATE jemlio_calendar_jobs SET lease_id=NULL,lease_until=NULL,available_at=$2,last_error=$3 WHERE request_id=$1`,
      [job.request_id,blocked?null:new Date(this.now()+(newer?1000:Math.min(3600000,30000*2**Math.min(q.attempts,7)))),safe]);
      await db.query('UPDATE jemlio_bookings SET calendar_state=$2,updated_at=$3 WHERE request_id=$1',[job.request_id,blocked?'attention':'pending',new Date(this.now())]);
      if(blocked)await this.audit(db,job.request_id,'calendar_attention');
    });
  }
  async retryManually(client,id,{apply=false}={}){
    scope(client,id);
    return this.transaction(async db=>{
      await this.enquiry(client,id,db,true);
      const q=(await db.query('SELECT request_id FROM jemlio_calendar_jobs WHERE request_id=$1',[id])).rows[0];
      if(!q)throw problem('calendar_job_missing');
      if(apply){await db.query('UPDATE jemlio_calendar_jobs SET generation=generation+1,available_at=$2,attempts=0,last_error=NULL WHERE request_id=$1',[id,new Date(this.now())]);
        await db.query("UPDATE jemlio_bookings SET calendar_state='pending',updated_at=$2 WHERE request_id=$1",[id,new Date(this.now())]);}
      return {client,receipt:id,dryRun:!apply,sendsMessages:false};
    });
  }
}
module.exports={CalendarStore};
