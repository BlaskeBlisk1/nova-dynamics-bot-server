'use strict';
const express = require('express');
const { createHmac, timingSafeEqual } = require('node:crypto');
const { createCalendly, EVENT_TYPE, problem } = require('./calendly');
const { BookingStore, publicBooking, CLIENT, UUID, iso } = require('./store');
const TTL = 15 * 60 * 1000;
function createBookingRuntime({ env = process.env, pool, captureStore, getTenant, now = Date.now, providerFactory = createCalendly }) {
  const router = express.Router();
  let configured = {};
  try { configured = JSON.parse(env.JEMLIO_BOOKING_CONFIG || '{}'); } catch {}
  const secret = env.NOVA_CAPTURE_SECRET;
  const active = env.JEMLIO_BOOKING_ENABLED === 'true' && typeof secret === 'string' && secret.length >= 32 &&
    pool && captureStore?.durable === true && configured && !Array.isArray(configured) && typeof configured === 'object';
  const store = pool ? new BookingStore({ pool, now }) : null;
  let readiness = { at: -Infinity, ready: false };
  async function tenant(client) {
    if (!active || typeof client !== 'string' || !CLIENT.test(client) || !Object.hasOwn(configured, client)) return null;
    const cfg = configured[client];
    if (!cfg || cfg.enabled !== true || !cfg.services || typeof cfg.services !== 'object' || Array.isArray(cfg.services)) return null;
    const capture = await getTenant(client);
    if (!capture || capture.mode !== 'live') return null;
    const services = [];
    for (const s of capture.services) {
      const item = Object.hasOwn(cfg.services, s.id) ? cfg.services[s.id] : null;
      if (!item) continue;
      if (!['request', 'calendly'].includes(item.mode)) return null;
      if (item.mode === 'calendly' && (!EVENT_TYPE.test(item.eventType || '') ||
          !/^JEMLIO_CALENDLY_[A-Z0-9_]+$/.test(cfg.credentialEnv || '') || !env[cfg.credentialEnv] ||
          !Number.isInteger(item.durationMinutes) || item.durationMinutes < 5 || item.durationMinutes > 480)) return null;
      // Fixed locations only. Dynamic phone/location questions and payments need
      // separate event-type onboarding and are not silently guessed here.
      if (item.location && (item.location.kind !== 'physical' || typeof item.location.location !== 'string' ||
          item.location.location.length < 1 || item.location.location.length > 200 ||
          Object.keys(item.location).some(k => !['kind', 'location'].includes(k)))) return null;
      services.push({ ...item, id: s.id, label: s.label });
    }
    if (!services.length) return null;
    if (now() - readiness.at > 10000) {
      let ready = false;
      try {
        ready = (await pool.query(`SELECT to_regclass('public.jemlio_bookings') IS NOT NULL AND
          to_regclass('public.jemlio_followups') IS NOT NULL AND to_regclass('public.jemlio_recorded_sales') IS NOT NULL AND
          to_regclass('public.jemlio_workflow_events') IS NOT NULL AS ready`)).rows[0]?.ready === true;
      } catch {}
      readiness = { at: now(), ready };
    }
    return readiness.ready ? { ...capture, services, credentialEnv: cfg.credentialEnv } : null;
  }
  function sign(value) { return createHmac('sha256', secret).update(`jemlio-booking-v1:${value}`).digest('base64url'); }
  async function issueAccess({ client, receipt, origin }) {
    const cfg = await tenant(client);
    if (!cfg || !cfg.allowedOrigins.includes(origin)) return null;
    const value = Buffer.from(JSON.stringify({ client, receipt, origin, exp: now() + TTL })).toString('base64url');
    return `${value}.${sign(value)}`;
  }
  function verifyAccess(body, origin) {
    if (!active || typeof body.access !== 'string' || body.access.length > 2000 || typeof body.receipt !== 'string' || !UUID.test(body.receipt)) return false;
    const [value, signature, extra] = body.access.split('.');
    if (!value || !signature || extra) return false;
    const a = Buffer.from(signature), b = Buffer.from(sign(value));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
    try {
      const token = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
      return token.client === body.client && token.receipt === body.receipt && token.origin === origin &&
        token.exp > now() && token.exp <= now() + TTL;
    } catch { return false; }
  }
  function cors(req, res, cfg) {
    const origin = req.get('origin');
    if (!cfg.allowedOrigins.includes(origin)) throw problem('origin_not_allowed');
    res.set('Access-Control-Allow-Origin', origin).vary('Origin');
  }
  async function rate(req, client) {
    const key = createHmac('sha256', secret).update(`booking:${client}:${req.ip || 'unknown'}`).digest('hex');
    if (!await captureStore.consumeRateLimit(key, 20, 60000, now())) throw problem('rate_limited');
  }
  function provider(cfg) { return providerFactory({ token: env[cfg.credentialEnv] }); }
  const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res)).catch(next);
  async function publicConfig(client) {
    const cfg = await tenant(client);
    return cfg ? { enabled: true, name: cfg.name, privacyUrl: cfg.privacyUrl, timezone: 'Europe/Oslo',
      services: cfg.services.map(s => ({ id: s.id, label: s.label, mode: s.mode, durationMinutes: s.durationMinutes || null })) }
      : { enabled: false, services: [] };
  }
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('X-Content-Type-Options', 'nosniff'); next(); });
  router.use(express.json({ limit: '4kb', strict: true }));
  router.options('*', wrap(async (req, res) => {
    // Origin must belong to at least one explicitly enabled tenant. POSTs also
    // require that exact tenant and a receipt-bound access token.
    for (const client of Object.keys(configured || {})) {
      const cfg = await tenant(client);
      if (cfg?.allowedOrigins.includes(req.get('origin'))) {
        cors(req, res, cfg); res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.set('Access-Control-Allow-Headers', 'Content-Type'); return res.sendStatus(204);
      }
    }
    return res.sendStatus(403);
  }));
  router.get('/config/:client', wrap(async (req, res) => {
    const cfg = await tenant(req.params.client);
    if (cfg && req.get('origin')) cors(req, res, cfg);
    res.json(await publicConfig(req.params.client));
  }));
  router.post('/slots/:client', wrap(async (req, res) => {
    const cfg = await tenant(req.params.client);
    if (!cfg) throw problem('booking_unavailable');
    cors(req, res, cfg); await rate(req, req.params.client);
    if (!req.body || Array.isArray(req.body) || Object.keys(req.body).some(k => k !== 'service')) throw problem('invalid_request');
    const service = cfg.services.find(s => s.id === req.body.service);
    if (!service || service.mode !== 'calendly') throw problem('invalid_service');
    const start = new Date(now() + 60000).toISOString(), end = new Date(now() + 7 * 86400000).toISOString();
    res.json({ slots: await provider(cfg).slots(service.eventType, start, end), timezone: 'Europe/Oslo' });
  }));
  async function authorized(req, res, keys) {
    const body = req.body;
    if (!body || Array.isArray(body) || Object.keys(body).some(k => !keys.includes(k))) throw problem('invalid_request');
    if (!verifyAccess(body, req.get('origin'))) throw problem('invalid_session');
    const cfg = await tenant(body.client);
    if (!cfg) throw problem('booking_unavailable');
    cors(req, res, cfg); await rate(req, body.client);
    return cfg;
  }
  router.post('/status', wrap(async (req, res) => {
    await authorized(req, res, ['client', 'receipt', 'access']);
    await store.enquiry(req.body.client, req.body.receipt);
    res.json(publicBooking(await store.read(req.body.client, req.body.receipt), now()));
  }));
  router.post('/confirm', wrap(async (req, res) => {
    const cfg = await authorized(req, res, ['client', 'receipt', 'access', 'slot', 'confirmed']);
    const { client, receipt, confirmed } = req.body;
    if (confirmed !== true) throw problem('confirmation_required');
    const slot = iso(req.body.slot);
    const enquiry = await store.enquiry(client, receipt);
    const service = cfg.services.find(s => s.id === enquiry.data.service);
    if (!service || service.mode !== 'calendly' || !enquiry.data.email || enquiry.data.consent !== true) throw problem('invalid_service');
    const existing = await store.read(client, receipt);
    if (existing) {
      if (new Date(existing.slot).toISOString() !== slot || existing.event_type !== service.eventType) throw problem('booking_conflict');
      return res.json(publicBooking(existing, now()));
    }
    if (Date.parse(slot) < now() + 60000 || Date.parse(slot) > now() + 7 * 86400000) throw problem('slot_unavailable');
    const api = provider(cfg);
    const available = await api.slots(service.eventType, new Date(now() + 60000).toISOString(), new Date(now() + 7 * 86400000).toISOString());
    if (!available.includes(slot)) throw problem('slot_unavailable');
    const claim = await store.claim({ client, receipt, eventType: service.eventType, slot });
    if (!claim.claimed) return res.json(publicBooking(claim.row, now()));
    let result;
    try {
      result = { status: 'confirmed', ...await api.book({ service, slot, name: claim.data.name, email: claim.data.email, attemptId: claim.row.attempt_id }) };
    } catch (error) {
      result = { status: error.code === 'booking_rejected' ? 'rejected' : 'needs_review',
        errorCode: error.code === 'booking_rejected' ? 'booking_rejected' : 'booking_uncertain' };
    }
    // A database failure here leaves the durable attempt in place. A retry reads
    // its state, never sends another POST. Operators reconcile with the provider.
    return res.json(publicBooking(await store.finish(claim.row, result), now()));
  }));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    const codes = { invalid_session: 403, origin_not_allowed: 403, rate_limited: 429, invalid_request: 400,
      invalid_date: 400, confirmation_required: 400, invalid_service: 400, slot_unavailable: 409,
      booking_conflict: 409, request_closed: 409, request_not_found: 404 };
    const code = Object.hasOwn(codes, error.code) ? error.code : 'booking_unavailable';
    res.status(codes[code] || 503).json({ error: code });
  });
  return { router, publicConfig, issueAccess, store };
}
module.exports = { createBookingRuntime };
