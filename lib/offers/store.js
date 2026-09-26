'use strict';
const {randomUUID,randomBytes}=require('node:crypto');
const {BookingStore,scope}=require('../booking/store');
const {WorkspaceStore,present,hash,fail}=require('../workspace/store');
const TOKEN=/^[a-f0-9]{64}$/;
function clean(value,max,min=0){if(typeof value!=='string'||value.trim().length<min||value.length>max||/\u0000/.test(value))throw fail('invalid_request');return value.trim();}
function publicOffer(r,now){return {id:r.id,version:r.version,...r.data,state:r.state==='open'&&Date.parse(r.expires_at)<=now?'expired':r.state,
  expiresAt:r.expires_at,response:r.response||null,responseNote:r.response_note||'',respondedAt:r.responded_at||null};}
class OfferStore extends BookingStore{
  constructor(options){super(options);this.workspace=new WorkspaceStore(options);}
  async ready(){return this.workspace.ready();}
  async history(client,id){scope(client,id);const enquiry=await this.enquiry(client,id),r=await this.pool.query('SELECT * FROM jemlio_offers WHERE request_id=$1 ORDER BY version DESC LIMIT 30',[id]);return {items:r.rows.map(q=>publicOffer(['won','lost'].includes(enquiry.outcome)&&['open','responded'].includes(q.state)?{...q,state:'closed'}:q,this.now()))};}
  async event(db,row,action){await db.query('INSERT INTO jemlio_offer_events(id,offer_id,request_id,action,recorded_at) VALUES ($1,$2,$3,$4,$5)',[randomUUID(),row.id,row.request_id,action,new Date(this.now())]);}
  async followup(db,id,due){await db.query(`INSERT INTO jemlio_followups(request_id,action,due_at,updated_at) VALUES ($1,'review',$2,$3)
    ON CONFLICT(request_id) DO UPDATE SET action='review',due_at=EXCLUDED.due_at,updated_at=EXCLUDED.updated_at`,[id,due,new Date(this.now())]);}
  async issue(client,id,input){
    scope(client,id);
    if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['revision','title','description','totalOre','priceBasis','days','verified'].includes(k))||!TOKEN.test(input.revision||''))throw fail('invalid_request');
    if(input.verified!==true)throw fail('verification_required');
    const title=clean(input.title,120,3),description=clean(input.description,2000,10);
    if(!Number.isSafeInteger(input.totalOre)||input.totalOre<0||input.totalOre>10000000000)throw fail('invalid_amount');
    if(!['incl_vat','not_vat'].includes(input.priceBasis)||!Number.isInteger(input.days)||input.days<1||input.days>30)throw fail('invalid_request');
    return this.transaction(async db=>{
      const enquiry=await this.enquiry(client,id,db,true);if(['won','lost'].includes(enquiry.outcome))throw fail('request_closed');
      if(present(await this.workspace.row(client,id,db),this.now()).revision!==input.revision)throw fail('conflict');
      const previous=(await db.query('SELECT version FROM jemlio_offers WHERE request_id=$1 ORDER BY version DESC LIMIT 1',[id])).rows[0];
      const token=randomBytes(32).toString('hex'),offerId=randomUUID(),at=new Date(this.now()),expires=new Date(this.now()+input.days*86400000);
      // A new version revokes every earlier link, including a previously answered version.
      await db.query("UPDATE jemlio_offers SET state='superseded' WHERE request_id=$1 AND state IN ('open','responded')",[id]);
      const row=(await db.query(`INSERT INTO jemlio_offers(id,request_id,version,token_hash,data,state,created_at,expires_at)
        VALUES ($1,$2,$3,$4,$5,'open',$6,$7) RETURNING *`,[offerId,id,(previous?.version||0)+1,hash(token),{title,description,totalOre:input.totalOre,priceBasis:input.priceBasis},at,expires])).rows[0];
      await this.followup(db,id,new Date(Math.min(expires.getTime(),this.now()+3*86400000)));
      await this.event(db,row,'issued');
      return {offer:publicOffer(row,this.now()),token};
    });
  }
  async withdraw(client,id,input){
    scope(client,id);if(!input||Object.keys(input).some(k=>k!=='revision')||!TOKEN.test(input.revision||''))throw fail('invalid_request');
    return this.transaction(async db=>{await this.enquiry(client,id,db,true);
      if(present(await this.workspace.row(client,id,db),this.now()).revision!==input.revision)throw fail('conflict');
      const r=(await db.query("UPDATE jemlio_offers SET state='withdrawn' WHERE request_id=$1 AND state IN ('open','responded') RETURNING *",[id])).rows[0];
      if(!r)throw fail('offer_unavailable');await this.event(db,r,'withdrawn');return {ok:true};
    });
  }
  async locate(token,db=this.pool){
    if(typeof token!=='string'||!TOKEN.test(token))throw fail('offer_unavailable');
    const r=(await db.query(`SELECT q.*,r.client,COALESCE(o.outcome,'new') AS outcome FROM jemlio_offers q
      JOIN nova_capture_requests r ON r.id=q.request_id LEFT JOIN nova_capture_outcomes o ON o.request_id=r.id WHERE q.token_hash=$1`,[hash(token)])).rows[0];
    if(!r||!['open','responded'].includes(r.state)||Date.parse(r.expires_at)<=this.now()||['won','lost'].includes(r.outcome))throw fail('offer_unavailable');return r;
  }
  async readOffer(token,allowed){const r=await this.locate(token);if(!allowed(r.client))throw fail('offer_unavailable');return {client:r.client,offer:publicOffer(r,this.now())};}
  async respond(token,input,allowed){
    if(!input||Array.isArray(input)||Object.keys(input).some(k=>!['response','note'].includes(k))||!['interested','changes','declined'].includes(input.response))throw fail('invalid_request');
    const note=clean(input.note??'',800);if(input.response==='changes'&&!note)throw fail('invalid_request');
    const found=await this.locate(token);if(!allowed(found.client))throw fail('offer_unavailable');
    return this.transaction(async db=>{
      await this.enquiry(found.client,found.request_id,db,true);const r=await this.locate(token,db);if(!allowed(r.client))throw fail('offer_unavailable');
      if(r.state==='responded'){
        if(r.response===input.response&&(r.response_note||'')===note)return publicOffer(r,this.now());
        throw fail('response_conflict');
      }
      const row=(await db.query("UPDATE jemlio_offers SET state='responded',response=$2,response_note=$3,responded_at=$4 WHERE id=$1 RETURNING *",[r.id,input.response,note,new Date(this.now())])).rows[0];
      await this.followup(db,r.request_id,new Date(this.now()));await this.event(db,row,'response_'+input.response);
      // A response is an enquiry for follow-up. It never records a won sale or booking.
      return publicOffer(row,this.now());
    });
  }
}
module.exports={OfferStore,publicOffer,TOKEN};
