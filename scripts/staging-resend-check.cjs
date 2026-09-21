'use strict';
// Opt-in only on the existing isolated staging service. One idempotent email to
// the owner's fixed mailbox; no leads, production flags or DNS are changed.
const { setTimeout: delay } = require('node:timers/promises');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const DOMAIN = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)*jemlio\.com$/;
const STATES = new Set(['not_started', 'pending', 'verified', 'failed', 'temporary_failure']);
function configuration(env, at) {
  if (env.JEMLIO_RESEND_CHECK !== 'true') return null;
  if (env.JEMLIO_STAGING_ONLY !== 'true' || env.RENDER_SERVICE_ID !== 'srv-daopc4tg1s2s7383pokg' ||
      env.NOVA_CAPTURE_ENABLED !== 'false' || env.NOVA_CAPTURE_WORKER_ENABLED !== 'false' ||
      env.JEMLIO_SETUP_SCHEMA !== 'false' || env.JEMLIO_SITE_TASK !== 'off') throw new Error('wrong_environment');
  if (!/^[a-f0-9]{40}$/.test(env.JEMLIO_RESEND_CHECK_COMMIT || '') ||
      env.RENDER_GIT_COMMIT !== env.JEMLIO_RESEND_CHECK_COMMIT) throw new Error('wrong_revision');
  const until = Date.parse(env.JEMLIO_RESEND_CHECK_UNTIL || '');
  if (!Number.isFinite(until) || until <= at || until - at > 30 * 60000) throw new Error('invalid_window');
  if (!UUID.test(env.JEMLIO_RESEND_CHECK_ID || '') || !/^re_[A-Za-z0-9_-]{10,200}$/.test(env.RESEND_API_KEY || '')) throw new Error('invalid_configuration');
  return { key: env.RESEND_API_KEY, marker: env.JEMLIO_RESEND_CHECK_ID };
}
async function boundedJson(response) {
  if (!response.body) return null;
  const reader = response.body.getReader(), chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength;
      if (size > 65536) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { return null; }
  finally { reader.releaseLock(); }
}
function failure(status, body) {
  if (status === 401) return 'invalid_or_revoked_key';
  const message = typeof body?.message === 'string' ? body.message : '';
  if (status === 403 && /only send testing emails|own email address/i.test(message)) return 'test_sender_recipient_restriction';
  if (status === 403 && /domain.*not verified|verify.*domain/i.test(message)) return 'sender_domain_not_verified';
  if (status === 403) return 'permission_denied';
  if (status === 429) return 'rate_limited';
  if (status === 409) return 'idempotency_conflict';
  return 'provider_rejected_or_unconfirmed';
}
async function runResendCheck({ env = process.env, fetchImpl = fetch, now = Date.now, pause = delay } = {}) {
  const config = configuration(env, now());
  if (!config) return { state: 'disabled' };
  const report = { checkedAt: new Date(now()).toISOString(), marker: config.marker,
    recipient: 'hei@jemlio.com', domains: [], deliveryVerified: false };
  async function request(route, options = {}) {
    if (now() >= Date.parse(env.JEMLIO_RESEND_CHECK_UNTIL)) throw new Error('expired');
    return fetchImpl('https://api.resend.com' + route, { ...options, redirect: 'error',
      headers: { Authorization: 'Bearer ' + config.key, 'Content-Type': 'application/json', ...options.headers },
      signal: AbortSignal.timeout(15000) });
  }
  let sender = 'onboarding@resend.dev';
  try {
    const response = await request('/domains?limit=100'); const body = await boundedJson(response);
    report.domainReadStatus = response.status;
    if (response.ok && Array.isArray(body?.data)) {
      const domains = body.data.filter(d => typeof d.name === 'string' && DOMAIN.test(d.name) && UUID.test(d.id));
      report.domains = domains.map(d => ({ name: d.name, status: STATES.has(d.status) ? d.status : 'unknown' }));
      report.domainListComplete = body.has_more !== true;
      const verified = domains.find(d => d.name === 'jemlio.com' && d.status === 'verified') || domains.find(d => d.status === 'verified');
      if (verified) sender = verified.name === 'jemlio.com' ? 'hei@jemlio.com' : 'notifications@' + verified.name;
      // Public DNS values only for the user's own domain, never unrelated domains.
      for (const domain of domains.slice(0, 3)) {
        await pause(1100);
        const detailResponse = await request('/domains/' + domain.id); const detail = await boundedJson(detailResponse);
        if (!detailResponse.ok || detail?.name !== domain.name || !Array.isArray(detail.records)) continue;
        const output = report.domains.find(d => d.name === domain.name);
        output.records = detail.records.filter(r => ['TXT', 'MX', 'CNAME'].includes(r.type)).slice(0, 12).map(r => ({
          type: r.type, name: String(r.name || '').slice(0, 300), value: String(r.value || '').slice(0, 2048),
          priority: typeof r.priority === 'number' ? r.priority : null, status: STATES.has(r.status) ? r.status : 'unknown'
        }));
      }
    } else { report.domainReadError = failure(response.status, body); }
  } catch { report.domainReadError = 'network_or_response_unconfirmed'; }
  await pause(1100);
  report.sender = sender;
  report.subject = 'Jemlio Resend verification ' + config.marker;
  try {
    const response = await request('/emails', { method: 'POST',
      headers: { 'Idempotency-Key': 'jemlio-owner-verification/' + config.marker },
      body: JSON.stringify({ from: sender, to: ['hei@jemlio.com'], subject: report.subject,
        text: 'Jemlio systemtest: This is the single owner-requested Resend delivery test. No customer was contacted. Receiving this message verifies this test email only, not live customer capture or CRM storage. Marker: ' + config.marker }) });
    const body = await boundedJson(response); report.sendStatus = response.status;
    if (!response.ok || !UUID.test(body?.id || '')) { report.state = failure(response.status, body); return report; }
    report.state = 'provider_accepted'; report.emailId = body.id;
    await pause(2200);
    const received = await request('/emails/' + body.id); const detail = await boundedJson(received);
    report.emailReadStatus = received.status;
    if (received.ok && detail?.id === body.id) {
      const events = new Set(['sent', 'delivered', 'delivery_delayed', 'bounced', 'failed', 'complained', 'opened', 'clicked']);
      report.lastEvent = events.has(detail.last_event) ? detail.last_event : 'unknown';
      report.deliveryVerified = detail.last_event === 'delivered';
    }
  } catch { report.state = report.emailId ? 'provider_accepted_readback_unconfirmed' : 'send_outcome_unknown'; }
  return report;
}
module.exports = { runResendCheck, configuration, failure };
