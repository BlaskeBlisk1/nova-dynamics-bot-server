'use strict';
const { createHash } = require('node:crypto');
const CLIENT = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PHONE = /^\+[1-9]\d{7,14}$/;
const MOBILE = /^\+47[49]\d{7}$/;
const sid = (prefix, value) => typeof value === 'string' && new RegExp('^' + prefix + '[a-fA-F0-9]{32}$').test(value);
const digest = value => createHash('sha256').update(Buffer.isBuffer(value)?value:String(value)).digest('hex');
function secret(raw) {
  try { const value = Buffer.from(raw || '', 'base64'); return value.length === 32 && value.toString('base64') === raw ? value : null; } catch { return null; }
}
function configuration(env = process.env) {
  try {
    const origin = new URL(env.JEMLIO_MISSED_CALL_ORIGIN);
    if (origin.protocol !== 'https:' || origin.origin !== env.JEMLIO_MISSED_CALL_ORIGIN || origin.username || origin.password) return null;
    const key = secret(env.JEMLIO_MISSED_CALL_KEY);
    const tenants = JSON.parse(env.JEMLIO_MISSED_CALL_CONFIG || '{}');
    if (!key || !tenants || Array.isArray(tenants) || !Object.keys(tenants).length || Object.keys(tenants).length > 100) return null;
    const voiceBindings = new Set(), smsBindings = new Set();
    for (const [client, t] of Object.entries(tenants)) {
      if (!CLIENT.test(client) || !t || t.enabled !== true || t.routingApproved !== true || t.smsApproved !== true ||
          !sid('AC', t.accountSid) || !/^[a-fA-F0-9]{32}$/.test(t.authToken || '') ||
          !PHONE.test(t.voiceNumber || '') || !PHONE.test(t.smsFrom || '') || !/^\+47[2-9]\d{7}$/.test(t.forwardTo || '') ||
          t.forwardTo === t.voiceNumber || !Number.isInteger(t.dailyLimit) || t.dailyLimit < 1 || t.dailyLimit > 100 ||
          !Number.isFinite(Date.parse(t.activatedAt)) || typeof t.smsText !== 'string' || t.smsText.length > 220 ||
          /[\u0000-\u001f\u007f]/.test(t.smsText) || (t.smsText.match(/\{link\}/g) || []).length !== 1 ||
          !/\bSTOP\b/i.test(t.smsText) || /https?:|www\./i.test(t.smsText) ||
          !Array.isArray(t.testRecipients) || t.testRecipients.length > 10 || t.testRecipients.some(p => !MOBILE.test(p)) ||
          typeof t.liveRecipientsApproved !== 'boolean' || (!t.liveRecipientsApproved && !t.testRecipients.length)) return null;
      for (const [set, number] of [[voiceBindings, t.voiceNumber], [smsBindings, t.smsFrom]]) {
        const binding = t.accountSid + ':' + number; if (set.has(binding)) return null; set.add(binding);
      }
      t.fingerprint = digest(JSON.stringify({ account: t.accountSid, token: digest(t.authToken), voice: t.voiceNumber,
        forward: t.forwardTo, smsFrom: t.smsFrom, text: t.smsText, key: digest(key), origin: origin.origin, activatedAt: t.activatedAt }));
    }
    return { origin: origin.origin, key, tenants };
  } catch { return null; }
}
module.exports = { configuration, CLIENT, PHONE, MOBILE, sid, digest, secret };
