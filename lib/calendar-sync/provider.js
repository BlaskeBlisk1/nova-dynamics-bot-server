'use strict';
const { INVITEE, EVENT, EVENT_TYPE, managementUrl, problem } = require('../booking/calendly');

// Read-only provider reconciliation. Never books, cancels, charges or sends.
function createCalendarReader({token, fetchFn=global.fetch, timeoutMs=5000}) {
  if(typeof token!=='string'||token.length<12||/[\r\n]/.test(token))throw problem('calendar_credentials_missing');
  async function get(uri){
    if(!INVITEE.test(uri)&&!EVENT.test(uri))throw problem('calendar_mismatch');
    let r;
    try{r=await fetchFn(uri,{method:'GET',redirect:'error',signal:AbortSignal.timeout(timeoutMs),headers:{Authorization:`Bearer ${token}`,Accept:'application/json'}});}catch{throw problem('calendar_unavailable');}
    if(!r.ok)throw problem('calendar_unavailable');
    try{return (await r.json()).resource;}catch{throw problem('calendar_unavailable');}
  }
  return {async read({providerId,eventType,slot,email}){
    if(!INVITEE.test(providerId)||!EVENT_TYPE.test(eventType)||typeof email!=='string')throw problem('calendar_mismatch');
    const aliases=[],seen=new Set();let uri=providerId,previous=null;
    for(let depth=0;depth<8;depth++){
      if(seen.has(uri))throw problem('calendar_mismatch');seen.add(uri);
      const invitee=await get(uri);
      if(!invitee||invitee.uri!==uri||!EVENT.test(invitee.event)||!uri.startsWith(invitee.event+'/invitees/')||
        typeof invitee.email!=='string'||invitee.email.toLowerCase()!==email.toLowerCase()||
        previous&&invitee.old_invitee!==previous||!['active','canceled'].includes(invitee.status))throw problem('calendar_mismatch');
      const event=await get(invitee.event),time=Date.parse(event?.start_time);
      if(!event||event.uri!==invitee.event||event.event_type!==eventType||!Number.isFinite(time)||
        !['active','canceled'].includes(event.status)||depth===0&&time!==Date.parse(slot))throw problem('calendar_mismatch');
      aliases.push(uri);
      if(invitee.rescheduled===true){
        if(invitee.status!=='canceled'||!INVITEE.test(invitee.new_invitee||''))throw problem('calendar_unavailable');
        previous=uri;uri=invitee.new_invitee;continue;
      }
      if(invitee.new_invitee)throw problem('calendar_mismatch');
      const cancelled=invitee.status==='canceled'||event.status==='canceled';
      if(invitee.no_show!==null&&invitee.no_show!==undefined&&(typeof invitee.no_show!=='object'||Array.isArray(invitee.no_show)))throw problem('calendar_mismatch');
      return {providerId:uri,slot:new Date(time).toISOString(),status:cancelled?'cancelled':invitee.no_show?'no_show':'confirmed',
        cancelUrl:managementUrl(invitee.cancel_url),rescheduleUrl:managementUrl(invitee.reschedule_url),aliases};
    }
    throw problem('calendar_mismatch');
  }};
}
module.exports={createCalendarReader};
