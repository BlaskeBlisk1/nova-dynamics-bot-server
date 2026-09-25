'use strict';
const { createHash, randomUUID } = require('node:crypto');
const { BookingStore, scope, iso } = require('../booking/store');
const { OUTCOMES } = require('../capture/operations');
const fail = code => Object.assign(new Error(code), { code });
const hash = value => createHash('sha256').update(value).digest('hex');
const SELECT = `SELECT r.id, r.created_at, r.data,
  COALESCE(o.outcome,'new') AS outcome, o.updated_at AS outcome_updated,
  b.status AS booking_status,b.slot,b.updated_at AS booking_updated,b.created_at AS booking_created,
  f.action,f.due_at,f.updated_at AS followup_updated,
  s.amount_ore::text,s.recorded_at AS sale_updated,
  COALESCE(n.note,'') AS note,n.updated_at AS note_updated
  FROM nova_capture_requests r
  LEFT JOIN nova_capture_outcomes o ON o.request_id=r.id
  LEFT JOIN jemlio_bookings b ON b.request_id=r.id
  LEFT JOIN jemlio_followups f ON f.request_id=r.id
  LEFT JOIN jemlio_recorded_sales s ON s.request_id=r.id
  LEFT JOIN jemlio_workspace_notes n ON n.request_id=r.id`;
function present(r, now) {
  const status = r.booking_status === 'attempting' && now - new Date(r.booking_created).getTime() >= 30000 ? 'needs_review' : r.booking_status || 'not_booked';
  const review = status === 'needs_review';
  const closed = ['won','lost'].includes(r.outcome);
  const due = review ? r.booking_updated : !closed && !['confirmed','completed','attempting'].includes(status) && r.action !== 'done' && (r.action || r.outcome === 'new')
    ? r.due_at || new Date(new Date(r.created_at).getTime() + 86400000) : null;
  return { id:r.id, createdAt:r.created_at, revision:hash(JSON.stringify(r)), name:String(r.data?.name || ''),
    email:String(r.data?.email || ''), phone:String(r.data?.phone || ''), service:String(r.data?.service || ''),
    message:String(r.data?.message || ''), outcome:r.outcome, note:r.note,
    booking:{ status, slot:r.slot || null },
    followup:{ action:review ? 'reconcile' : r.action || 'callback', due:due || null, overdue:Boolean(due && new Date(due).getTime() <= now) },
    amountOre:r.outcome === 'won' && r.amount_ore !== null ? Number(r.amount_ore) : null };
}
class WorkspaceStore extends BookingStore {
  async ready() {
    const r = await this.pool.query(`SELECT to_regclass('public.nova_capture_requests') IS NOT NULL AND
      to_regclass('public.nova_capture_outcomes') IS NOT NULL AND to_regclass('public.nova_capture_outcome_events') IS NOT NULL AND
      to_regclass('public.nova_capture_rate_limits') IS NOT NULL AND to_regclass('public.jemlio_bookings') IS NOT NULL AND
      to_regclass('public.jemlio_followups') IS NOT NULL AND to_regclass('public.jemlio_recorded_sales') IS NOT NULL AND
      to_regclass('public.jemlio_workspace_sessions') IS NOT NULL AND to_regclass('public.jemlio_workspace_notes') IS NOT NULL AND
      to_regclass('public.jemlio_workspace_audit') IS NOT NULL AS ready`);
    return r.rows[0]?.ready === true;
  }
  async row(client, id, db=this.pool) {
    scope(client,id); const r = await db.query(`${SELECT} WHERE r.client=$1 AND r.id=$2`,[client,id]);
    if (!r.rows.length) throw fail('not_found'); return r.rows[0];
  }
  async list(client, { view='open', page=0 }={}) {
    scope(client);
    if (!['all','open','due','won','lost'].includes(view) || !Number.isInteger(page) || page<0 || page>200) throw fail('invalid_request');
    // Due filtering uses the same semantics as the staff queue, including unresolved bookings on closed leads.
    const due = `((b.status='needs_review' OR (b.status='attempting' AND b.created_at <= $2::timestamptz-interval '30 seconds')) OR
      (COALESCE(o.outcome,'new') NOT IN ('won','lost') AND COALESCE(b.status,'not_booked') NOT IN ('confirmed','completed','attempting') AND
      ((f.action IS NOT NULL AND f.action<>'done') OR (f.action IS NULL AND COALESCE(o.outcome,'new')='new')) AND
      COALESCE(f.due_at,r.created_at+interval '24 hours') <= $2))`;
    const filter = { all:'TRUE', open:"COALESCE(o.outcome,'new') NOT IN ('won','lost')", due, won:"o.outcome='won'", lost:"o.outcome='lost'" }[view];
    const r = await this.pool.query(`${SELECT} WHERE r.client=$1 AND ${filter} AND $2::timestamptz IS NOT NULL
      ORDER BY r.created_at DESC,r.id LIMIT 51 OFFSET $3`,[client,new Date(this.now()),page*50]);
    return { items:r.rows.slice(0,50).map(row=>present(row,this.now())), hasMore:r.rows.length>50, page };
  }
  async update(client,id,input,actor) {
    scope(client,id);
    if (!input || Array.isArray(input) || Object.keys(input).some(k=>!['revision','outcome','note','followup','amountOre','appointmentStatus','verified'].includes(k)) ||
      !/^[a-f0-9]{64}$/.test(input.revision || '')) throw fail('invalid_request');
    if (input.outcome !== undefined && !OUTCOMES.includes(input.outcome)) throw fail('invalid_request');
    if (input.note !== undefined && (typeof input.note !== 'string' || input.note.length>2000 || /\u0000/.test(input.note))) throw fail('invalid_request');
    if (input.amountOre !== undefined && (!Number.isSafeInteger(input.amountOre) || input.amountOre<0 || input.amountOre>10000000000)) throw fail('invalid_amount');
    if (input.appointmentStatus !== undefined && !['completed','cancelled','no_show'].includes(input.appointmentStatus)) throw fail('invalid_request');
    let followup=input.followup;
    if (followup !== undefined) {
      if (!followup || Array.isArray(followup) || Object.keys(followup).some(k=>!['action','due'].includes(k)) || !['callback','review','done'].includes(followup.action)) throw fail('invalid_request');
      if (followup.action !== 'done') { iso(followup.due); if (Date.parse(followup.due)>this.now()+366*86400000) throw fail('invalid_date'); }
    }
    if ((input.outcome === 'won' || input.amountOre !== undefined || input.appointmentStatus !== undefined) && input.verified !== true) throw fail('verification_required');
    return this.transaction(async db=>{
      await db.query('SELECT id FROM nova_capture_requests WHERE client=$1 AND id=$2 FOR UPDATE',[client,id]);
      const r=await this.row(client,id,db);
      if (present(r,this.now()).revision !== input.revision) throw fail('conflict');
      const outcome=input.outcome || r.outcome, at=new Date(this.now());
      if (input.amountOre !== undefined && outcome !== 'won') throw fail('verified_win_required');
      if (followup && followup.action !== 'done' && ['won','lost'].includes(outcome)) throw fail('request_closed');
      if (input.appointmentStatus !== undefined) {
        if (!['confirmed',input.appointmentStatus].includes(r.booking_status)) throw fail('confirmed_booking_required');
        if (input.appointmentStatus !== 'cancelled' && Date.parse(r.slot)>this.now()) throw fail('appointment_not_started');
        await db.query('UPDATE jemlio_bookings SET status=$2,updated_at=$3 WHERE request_id=$1',[id,input.appointmentStatus,at]);
      }
      if (input.outcome !== undefined && input.outcome !== r.outcome) {
        await db.query(`INSERT INTO nova_capture_outcomes(request_id,outcome,updated_at) VALUES ($1,$2,$3)
          ON CONFLICT(request_id) DO UPDATE SET outcome=EXCLUDED.outcome,updated_at=EXCLUDED.updated_at`,[id,outcome,at]);
        await db.query('INSERT INTO nova_capture_outcome_events(id,request_id,outcome,recorded_at) VALUES ($1,$2,$3,$4)',[randomUUID(),id,outcome,at]);
      }
      if (input.note !== undefined) await db.query(`INSERT INTO jemlio_workspace_notes(request_id,note,updated_at) VALUES ($1,$2,$3)
        ON CONFLICT(request_id) DO UPDATE SET note=EXCLUDED.note,updated_at=EXCLUDED.updated_at`,[id,input.note,at]);
      if (followup) await db.query(`INSERT INTO jemlio_followups(request_id,due_at,action,updated_at) VALUES ($1,$2,$3,$4)
        ON CONFLICT(request_id) DO UPDATE SET due_at=EXCLUDED.due_at,action=EXCLUDED.action,updated_at=EXCLUDED.updated_at`,[id,followup.action==='done'?null:followup.due,followup.action,at]);
      if (input.amountOre !== undefined) await db.query(`INSERT INTO jemlio_recorded_sales(request_id,amount_ore,recorded_at) VALUES ($1,$2,$3)
        ON CONFLICT(request_id) DO UPDATE SET amount_ore=EXCLUDED.amount_ore,recorded_at=EXCLUDED.recorded_at`,[id,input.amountOre,at]);
      const fields=Object.keys(input).filter(k=>!['revision','verified'].includes(k));
      if (!fields.length) throw fail('invalid_request');
      await db.query('INSERT INTO jemlio_workspace_audit(id,request_id,actor,fields,recorded_at) VALUES ($1,$2,$3,$4,$5)',[randomUUID(),id,actor,fields,at]);
      return present(await this.row(client,id,db),this.now());
    });
  }
}
module.exports={ WorkspaceStore, present, hash, fail };
