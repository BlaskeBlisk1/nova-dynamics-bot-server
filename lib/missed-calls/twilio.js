'use strict';
// Official SDK validation; never derive signed URLs from Host/X-Forwarded-*.
const twilio = require('twilio');
const { sid, MOBILE } = require('./config');
const fail = code => Object.assign(new Error(code), { code });
function validate(token, signature, url, params) {
  if (typeof signature !== 'string' || signature.length > 100 || !params || Array.isArray(params) ||
      Object.entries(params).some(([k,v]) => k.length > 100 || typeof v !== 'string' || v.length > 8000)) return false;
  try { return twilio.validateRequest(token, signature, url, params); } catch { return false; }
}
function adapter(tenant, { client } = {}) {
  // Disabling automatic retries is crucial: SMS creation has no assumed idempotency guarantee.
  const api = client || twilio(tenant.accountSid, tenant.authToken, { autoRetry: false, timeout: 8000, maxRetries: 0 });
  return {
    async verifyCall(event, at) {
      const [parent, child] = await Promise.all([api.calls(event.parentSid).fetch(), api.calls(event.childSid).fetch()]);
      const end = new Date(child.endTime).getTime();
      if (parent.sid !== event.parentSid || child.sid !== event.childSid || parent.accountSid !== tenant.accountSid ||
          child.accountSid !== tenant.accountSid || parent.direction !== 'inbound' || child.parentCallSid !== parent.sid ||
          parent.to !== tenant.voiceNumber || parent.from !== event.from || child.to !== tenant.forwardTo ||
          !['no-answer','busy'].includes(child.status) || child.status !== event.status ||
          !Number.isFinite(end) || end < Date.parse(tenant.activatedAt) || end > at + 60000 || at - end > 20 * 60000 ||
          !MOBILE.test(parent.from)) throw fail('call_not_eligible');
      // A number prefix alone is not proof that the number is a mobile line.
      const line = await api.lookups.v2.phoneNumbers(event.from).fetch({ fields: 'line_type_intelligence' });
      if (line.phoneNumber !== event.from || line.valid !== true || line.countryCode !== 'NO' ||
          line.lineTypeIntelligence?.type !== 'mobile' || (line.lineTypeIntelligence?.errorCode || line.lineTypeIntelligence?.error_code)) throw fail('not_mobile');
      return { endedAt: end };
    },
    async send({ to, body, statusCallback }) {
      try {
        const message = await api.messages.create({ from: tenant.smsFrom, to, body, statusCallback, validityPeriod: 600 });
        if (!sid('SM', message.sid) || message.accountSid !== tenant.accountSid || message.to !== to || message.from !== tenant.smsFrom) throw fail('sms_uncertain');
        return { sid: message.sid, status: message.status };
      } catch (e) {
        // A timeout/server error may follow an accepted request. Do not send another SMS.
        if (Number.isInteger(e.status) && e.status >= 400 && e.status < 500 && e.status !== 408) throw fail('sms_rejected');
        throw fail('sms_uncertain');
      }
    },
    async message(id) {
      if (!sid('SM', id)) throw fail('invalid_message');
      return api.messages(id).fetch();
    }
  };
}
function forwardXml(tenant, action) {
  const response = new twilio.twiml.VoiceResponse();
  response.dial({ action, method: 'POST', timeout: 20, timeLimit: 3600, answerOnBridge: true }, tenant.forwardTo);
  return response.toString();
}
module.exports = { adapter, validate, forwardXml, fail };
