const crypto = require('crypto');
const express = require('express');
const { createMemoryStore, PgStore, CaptureConflict } = require('./store');
const { createResendNotifier, flushNotifications } = require('./notification');
const { createCrmPayload, validDestination } = require('./crm');

const CLIENT_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL_RE = /^[^\s<>@,;]+@[^\s<>@,;]+\.[^\s<>@,;]+$/;
const TOKEN_TTL = 15 * 60 * 1000;
const FIELDS = new Set(['name', 'email', 'phone', 'service', 'preferredTime', 'consent', 'submissionId', 'token', 'client', 'website']);
const text = (value, max) => typeof value === 'string' && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value) ? value.trim() : null;
const emailValid = value => typeof value === 'string' && value.length <= 254 && EMAIL_RE.test(value) && !/[\r\n]/.test(value);
function originValid(value) {
  try { const u = new URL(value); return ['http:', 'https:'].includes(u.protocol) && u.origin === value && !u.username && !u.password; }
  catch { return false; }
}
function privacyValid(value) {
  try { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password; }
  catch { return false; }
}
function configValid(config, mode) {
  return config && config.mode === mode && text(config.name, 100) &&
    Array.isArray(config.allowedOrigins) && config.allowedOrigins.length > 0 && config.allowedOrigins.every(originValid) &&
    Array.isArray(config.services) && config.services.length > 0 && config.services.length <= 30 &&
    config.services.every(s => s && CLIENT_RE.test(s.id) && text(s.label, 100)) &&
    new Set(config.services.map(s => s.id)).size === config.services.length;
}

function createCaptureRouter({ getTenantConfig, store, liveStore = store, previewStore = createMemoryStore(),
  secret, notificationFrom, now = Date.now, rateLimit = { session: 20, request: 5, windowMs: 60_000 } } = {}) {
  if (typeof getTenantConfig !== 'function') throw new Error('capture_config_required');
  const router = express.Router();
  const key = typeof secret === 'string' && secret.length >= 32 ? secret : crypto.randomBytes(32).toString('hex');
  const hasLiveSecret = typeof secret === 'string' && secret.length >= 32;
  const sign = value => crypto.createHmac('sha256', key).update(value).digest('base64url');
  function issueToken(client, origin, mode) {
    const expiresAt = now() + TOKEN_TTL;
    const content = Buffer.from(JSON.stringify({ v: 1, client, origin, mode, exp: expiresAt })).toString('base64url');
    return { token: `${content}.${sign(content)}`, expiresAt };
  }
  function readToken(token, client, origin) {
    if (typeof token !== 'string' || token.length > 2048) return null;
    const bits = token.split('.');
    if (bits.length !== 2) return null;
    const expected = Buffer.from(sign(bits[0]));
    const received = Buffer.from(bits[1]);
    if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
    try {
      const info = JSON.parse(Buffer.from(bits[0], 'base64url').toString('utf8'));
      return info.v === 1 && info.client === client && info.origin === origin &&
        ['preview', 'live'].includes(info.mode) && Number.isFinite(info.exp) &&
        info.exp > now() && info.exp <= now() + TOKEN_TTL ? info : null;
    } catch { return null; }
  }
  async function tenant(client, preview, origin, req) {
    if (!CLIENT_RE.test(client || '')) return null;
    const config = await getTenantConfig(client, { preview, origin, req });
    const mode = preview ? 'preview' : 'live';
    if (!configValid(config, mode)) return null;
    if (mode === 'live' && (!hasLiveSecret || !liveStore || liveStore.durable !== true ||
      !emailValid(config.recipient) || !emailValid(notificationFrom) || !privacyValid(config.privacyUrl) ||
      (Object.hasOwn(config, 'crm') && !validDestination(config.crm)))) return null;
    return config;
  }
  function cors(req, res, config) {
    const origin = req.get('origin');
    if (!origin || !config.allowedOrigins.includes(origin)) return false;
    res.set('Access-Control-Allow-Origin', origin);
    res.vary('Origin');
    return true;
  }
  async function allowedRate(req, config, action, selectedStore) {
    const host = req.ip || req.socket.remoteAddress || 'unknown';
    const id = crypto.createHmac('sha256', key).update(`${action}:${config.mode}:${req.body.client}:${host}`).digest('hex');
    return selectedStore.consumeRateLimit(id, rateLimit[action] || 5, rateLimit.windowMs || 60_000, now());
  }
  function wrap(fn) { return (req, res, next) => Promise.resolve(fn(req, res)).catch(next); }
  router.getPublicConfig = async (client, { preview = false, origin, req } = {}) => {
    const config = await tenant(client, preview, origin, req);
    return config ? { enabled: true, mode: config.mode, name: config.name,
      services: config.services.map(s => ({ id: s.id, label: s.label })), privacyUrl: config.privacyUrl || null }
      : { enabled: false, mode: 'off', services: [] };
  };
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.set('X-Content-Type-Options', 'nosniff');
    next();
  });
  router.use(express.json({ limit: '8kb', strict: true }));
  router.options('*', (req, res) => {
    // Preflight never grants credentials. Actual POST still requires exact tenant origin + token.
    const origin = req.get('origin');
    if (!originValid(origin)) return res.sendStatus(403);
    res.set('Access-Control-Allow-Origin', origin).vary('Origin');
    res.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.set('Access-Control-Allow-Headers', 'Content-Type');
    return res.sendStatus(204);
  });
  router.get('/config/:client', wrap(async (req, res) => {
    const config = await tenant(req.params.client, req.query.preview === '1', req.get('origin'), req);
    if (!config) return res.json({ enabled: false, mode: 'off', services: [] });
    if (req.get('origin') && !cors(req, res, config)) return res.status(403).json({ error: 'origin_not_allowed' });
    return res.json({ enabled: true, mode: config.mode, name: config.name,
      services: config.services.map(s => ({ id: s.id, label: s.label })), privacyUrl: config.privacyUrl || null });
  }));
  router.post('/session', wrap(async (req, res) => {
    const body = req.body;
    if (!body || Array.isArray(body) || Object.keys(body).some(k => !['client', 'preview'].includes(k)) ||
      (body.preview !== undefined && typeof body.preview !== 'boolean')) return res.status(400).json({ error: 'invalid_request' });
    const config = await tenant(body.client, body.preview === true, req.get('origin'), req);
    if (!config) return res.status(503).json({ error: 'capture_unavailable' });
    if (!cors(req, res, config)) return res.status(403).json({ error: 'origin_not_allowed' });
    const selectedStore = config.mode === 'preview' ? previewStore : liveStore;
    if (!await allowedRate(req, config, 'session', selectedStore)) return res.status(429).json({ error: 'rate_limited' });
    return res.json({ ...issueToken(body.client, req.get('origin'), config.mode), mode: config.mode });
  }));
  router.post('/requests', wrap(async (req, res) => {
    const body = req.body;
    if (!body || Array.isArray(body) || Buffer.byteLength(JSON.stringify(body)) > 8192 || Object.keys(body).some(k => !FIELDS.has(k))) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    const info = readToken(body.token, body.client, req.get('origin'));
    if (!info) return res.status(403).json({ error: 'invalid_session' });
    const config = await tenant(body.client, info.mode === 'preview', req.get('origin'), req);
    if (!config) return res.status(503).json({ error: 'capture_unavailable' });
    if (!cors(req, res, config)) return res.status(403).json({ error: 'origin_not_allowed' });
    const name = text(body.name, 100);
    const email = text(body.email === undefined ? '' : body.email, 254);
    const phone = text(body.phone === undefined ? '' : body.phone, 30);
    const preferredTime = text(body.preferredTime === undefined ? '' : body.preferredTime, 120);
    const service = config.services.find(s => s.id === body.service);
    if (!name || name.length < 2 || email === null || phone === null || preferredTime === null ||
      (!email && !phone) || (email && !emailValid(email)) ||
      (phone && (!/^[+\d ()-]{6,30}$/.test(phone) || phone.replace(/\D/g, '').length < 6 || phone.replace(/\D/g, '').length > 15)) ||
      !service || body.consent !== true || !UUID_RE.test(body.submissionId || '') ||
      (body.website !== undefined && body.website !== '')) return res.status(400).json({ error: 'invalid_fields' });
    const selectedStore = info.mode === 'preview' ? previewStore : liveStore;
    if (!await allowedRate(req, config, 'request', selectedStore)) return res.status(429).json({ error: 'rate_limited' });
    const data = { name, email: email.toLowerCase(), phone, service: service.id, preferredTime, consent: true };
    const payloadHash = crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex');
    const notification = info.mode === 'live' ? {
      from: notificationFrom, to: [config.recipient],
      ...(data.email ? { reply_to: data.email } : {}),
      subject: `Ny kontaktforespørsel – ${config.name}`,
      text: [`Ny kontaktforespørsel til ${config.name}`, '', `Navn: ${data.name}`, `E-post: ${data.email || 'Ikke oppgitt'}`,
        `Telefon: ${data.phone || 'Ikke oppgitt'}`, `Tjeneste: ${service.label}`, `Ønsket tidspunkt: ${data.preferredTime || 'Ikke oppgitt'}`,
        '', 'Besøkeren har bedt om å bli kontaktet. Dette er en forespørsel, ikke en bekreftet bestilling.'].join('\n')
    } : null;
    const receipt = crypto.randomUUID();
    const createdAt = now();
    const crm = info.mode === 'live' && config.crm ? createCrmPayload({ destination: config.crm, receipt,
      name: config.name, service: service.label, data, createdAt }) : null;
    const result = await selectedStore.create({ receipt, client: body.client, submissionId: body.submissionId,
      payloadHash, data, notification, crm, createdAt });
    return res.status(result.duplicate ? 200 : 201).json({ receipt: result.receipt, mode: info.mode,
      status: info.mode === 'preview' ? 'preview_saved' : 'received',
      message: info.mode === 'preview'
        ? 'Testforespørselen er registrert midlertidig i forhåndsvisningen. Ingen e-post er sendt, og virksomheten blir ikke kontaktet.'
        : 'Forespørselen er lagret. Dette er en kontaktforespørsel, ikke en bekreftet time.' });
  }));
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const conflict = error instanceof CaptureConflict || error.code === 'submission_conflict';
    const removed = error.code === 'submission_removed';
    const invalid = error.type === 'entity.too.large' || error.type === 'entity.parse.failed';
    return res.status(conflict ? 409 : removed ? 410 : invalid ? 400 : 503).json({ error: conflict ? 'submission_conflict' : removed ? 'submission_removed' : invalid ? 'invalid_request' : 'capture_unavailable' });
  });
  return router;
}

module.exports = { createCaptureRouter, createMemoryStore, PgStore, createResendNotifier, flushNotifications };
