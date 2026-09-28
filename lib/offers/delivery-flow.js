'use strict';
const { hash, email, encrypt, decrypt } = require('../enquiry-conversations/delivery');
const { fail, object } = require('../enquiry-conversations/store');
const { UUID } = require('../booking/store');
const { publicOffer } = require('./store');

// Reuse the existing stores inside ONE caller-owned transaction. No nested
// BEGIN/COMMIT and no provider I/O while approving an offer.
const within = (store, db) => Object.assign(Object.create(store), { transaction: fn => fn(db) });
class OfferDeliveryFlow {
  constructor({ offers, conversations, enabled = () => false, now = Date.now }) {
    this.offers = offers; this.conversations = conversations; this.enabled = enabled; this.now = now;
  }
  async ready() {
    return Boolean(this.conversations && await this.conversations.ready() &&
      (await this.conversations.pool.query("SELECT to_regclass('public.jemlio_offer_deliveries') IS NOT NULL AS ready")).rows[0]?.ready);
  }
  async send(client, id, input, actor) {
    if (!this.enabled(client) || !await this.ready()) throw fail('send_unavailable');
    object(input, ['operationId','revision','recipient','title','description','totalOre','priceBasis','days','verified','approved']);
    if (input.approved !== true || input.verified !== true) throw fail('approval_required');
    if (!UUID.test(input.operationId || '') || !email(input.recipient)) throw fail('invalid_request');
    const quote = Object.fromEntries(['revision','title','description','totalOre','priceBasis','days','verified'].map(k => [k,input[k]]));
    const digest = hash(JSON.stringify({ quote, recipient:input.recipient }));
    const conversation = this.conversations;
    return conversation.transaction(async db => {
      const parent = await conversation.parent(db, client, id, { allowClosed:true });
      const prior = (await db.query(`SELECT d.*,m.state AS delivery_state,q.* FROM jemlio_offer_deliveries d
        JOIN jemlio_conversation_messages m ON m.id=d.message_id JOIN jemlio_offers q ON q.id=d.offer_id
        WHERE d.operation_id=$1`, [input.operationId])).rows[0];
      if (prior) {
        if (prior.client !== client || prior.request_id !== id || prior.payload_hash !== digest) throw fail('submission_conflict');
        return { offer:publicOffer(prior,this.now()), delivery:{ messageId:prior.message_id, state:prior.delivery_state }, duplicate:true, sendsMessages:true };
      }
      if (['won','lost'].includes(parent.outcome)) throw fail('request_closed');
      if (email(parent.data?.email) !== input.recipient) throw fail('recipient_mismatch');
      const thread = await conversation.thread(db,client,id);
      const snapshot = await conversation.snapshot(db,parent,thread);
      if (!snapshot.canSend) throw fail(snapshot.sendUnavailableReason || 'send_unavailable');
      const result = await within(this.offers,db).issue(client,id,quote);
      const total = new Intl.NumberFormat('nb-NO',{style:'currency',currency:'NOK'}).format(result.offer.totalOre/100);
      // No bearer token in plaintext message history. The entire quote and its
      // private link are in the encrypted dispatch envelope only.
      const body = `Hei!\n\nVi har laget et prisforslag: ${result.offer.title}.\nTotalpris: ${total}${result.offer.priceBasis==='incl_vat'?' inkl. mva.':' (mva. ikke beregnet)'}.\n\nÅpne den private lenken i e-posten for å lese omfanget og svare. Dette oppretter ikke en booking eller betaling.`;
      const scoped = within(conversation,db);
      const draft = await scoped.draft(client,id,{revision:String(thread.version),template:'followup',body},actor);
      await db.query("UPDATE jemlio_conversation_messages SET template='quote',subject=$2 WHERE id=$1",[draft.draftId,`Prisforslag fra ${conversation.businessName(client)}`]);
      await scoped.send(client,id,{revision:draft.revision,draftId:draft.draftId,recipient:input.recipient,body,approved:true},actor);
      const queued = (await db.query('SELECT * FROM jemlio_conversation_messages WHERE id=$1',[draft.draftId])).rows[0];
      const context = `${client}:${id}:${draft.draftId}`;
      const notification = decrypt(queued.encrypted_payload,conversation.secret,context);
      const url = `${conversation.origin}/demos/${encodeURIComponent(client)}#offer=${result.token}`;
      notification.text = `${body}\n\nLes prisforslaget og gi tilbakemelding:\n${url}\n\nPrivat lenke, gyldig i ${input.days} dager. Ikke del den med andre.`;
      await db.query('UPDATE jemlio_conversation_messages SET encrypted_payload=$2 WHERE id=$1',[draft.draftId,encrypt(notification,conversation.secret,context)]);
      await db.query(`INSERT INTO jemlio_offer_deliveries(operation_id,client,request_id,offer_id,message_id,payload_hash,created_at)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,[input.operationId,client,id,result.offer.id,draft.draftId,digest,new Date(this.now())]);
      return { offer:result.offer, delivery:{ messageId:draft.draftId,state:'queued' }, duplicate:false,sendsMessages:true };
    });
  }
}
module.exports = { OfferDeliveryFlow };
