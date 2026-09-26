'use strict';

// A narrow adapter: event types and credentials come only from server config.
// Booking POSTs are never retried: an uncertain response requires reconciliation.
const BASE = 'https://api.calendly.com';
const EVENT_TYPE = /^https:\/\/api\.calendly\.com\/event_types\/[a-zA-Z0-9-]{8,64}$/;
const INVITEE = /^https:\/\/api\.calendly\.com\/scheduled_events\/[a-zA-Z0-9-]{8,64}\/invitees\/[a-zA-Z0-9-]{8,64}$/;
const EVENT = /^https:\/\/api\.calendly\.com\/scheduled_events\/[a-zA-Z0-9-]{8,64}$/;
const problem = code => Object.assign(new Error(code), { code });
function managementUrl(value) {
  try {
    const u = new URL(value);
    return u.origin === 'https://calendly.com' && !u.username && !u.password &&
      /^\/(cancellations|reschedulings)\/[a-zA-Z0-9-]+$/.test(u.pathname) && !u.search && !u.hash ? u.href : null;
  } catch { return null; }
}
function createCalendly({ token, fetchFn = global.fetch, timeoutMs = 12000 }) {
  if (typeof token !== 'string' || token.length < 12 || /[\r\n]/.test(token)) throw problem('booking_credentials_missing');
  async function request(url, method = 'GET', body) {
    let response;
    try {
      response = await fetchFn(url, { method, redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw problem(method === 'POST' ? 'booking_uncertain' : 'availability_unavailable'); }
    if (!response.ok) {
      // These definite rejections mean no booking was accepted. Other responses
      // (including 429/5xx) remain uncertain; do not infer retry safety.
      throw problem(method === 'POST' ? ([400, 401, 403, 404, 422].includes(response.status)
        ? 'booking_rejected' : 'booking_uncertain') : 'availability_unavailable');
    }
    try { return await response.json(); }
    catch { throw problem(method === 'POST' ? 'booking_uncertain' : 'availability_unavailable'); }
  }
  return {
    async slots(eventType, start, end) {
      if (!EVENT_TYPE.test(eventType)) throw problem('invalid_event_type');
      const query = new URLSearchParams({ event_type: eventType, start_time: start, end_time: end });
      const data = await request(`${BASE}/event_type_available_times?${query}`);
      if (!Array.isArray(data.collection)) throw problem('availability_unavailable');
      return [...new Set(data.collection.filter(s => s.status === 'available' &&
        Number.isFinite(Date.parse(s.start_time)) && Date.parse(s.start_time) >= Date.parse(start) &&
        Date.parse(s.start_time) < Date.parse(end)).map(s => new Date(s.start_time).toISOString()))].sort().slice(0, 80);
    },
    async book({ service, slot, name, email, attemptId }) {
      if (!EVENT_TYPE.test(service.eventType)) throw problem('invalid_event_type');
      const data = await request(`${BASE}/invitees`, 'POST', {
        event_type: service.eventType, start_time: slot,
        invitee: { name, email, timezone: 'Europe/Oslo' },
        ...(service.location ? { location: service.location } : {}),
        tracking: { utm_source: 'jemlio', utm_medium: 'website', ...(attemptId ? { utm_content: 'jemlio:' + attemptId } : {}) }
      });
      const r = data.resource;
      if (!r || r.status !== 'active' || !INVITEE.test(r.uri) || !EVENT.test(r.event) ||
          !r.uri.startsWith(`${r.event}/invitees/`)) throw problem('booking_uncertain');
      return { providerId: r.uri, cancelUrl: managementUrl(r.cancel_url), rescheduleUrl: managementUrl(r.reschedule_url) };
    },
    async verify({ providerId, eventType, slot, email }) {
      if (!INVITEE.test(providerId) || !EVENT_TYPE.test(eventType)) throw problem('invalid_provider_reference');
      const { resource: invitee } = await request(providerId);
      if (!invitee || invitee.uri !== providerId || !EVENT.test(invitee.event) ||
          !providerId.startsWith(`${invitee.event}/invitees/`) || invitee.email?.toLowerCase() !== email.toLowerCase()) {
        throw problem('provider_record_mismatch');
      }
      const { resource: event } = await request(invitee.event);
      if (!event || event.event_type !== eventType || Date.parse(event.start_time) !== Date.parse(slot)) throw problem('provider_record_mismatch');
      const cancelled = invitee.status === 'canceled' || event.status === 'canceled';
      if (!cancelled && (invitee.status !== 'active' || event.status !== 'active')) throw problem('provider_record_mismatch');
      return { providerId, status: cancelled ? 'cancelled' : invitee.no_show ? 'no_show' : 'confirmed',
        cancelUrl: managementUrl(invitee.cancel_url), rescheduleUrl: managementUrl(invitee.reschedule_url) };
    }
  };
}
module.exports = { createCalendly, EVENT_TYPE, INVITEE, EVENT, managementUrl, problem };
