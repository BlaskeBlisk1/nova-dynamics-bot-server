'use strict';

const express = require('express');
const crypto = require('node:crypto');
const ALLOWED_ORIGINS = Object.freeze(['https://www.jemlio.com', 'https://jemlio.com']);
const CONSENT_TEXT = 'Jeg ber Jemlio kontakte meg om min gratis mini-demo';
const CONSENT_VALUES = new Set([true, 'true', 'on', '1', CONSENT_TEXT]);
const LIMITS = Object.freeze({ name: 120, email: 254, company: 300, industry: 100, message: 1000, 'bot-field': 200 });
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

function validateWebhookUrl(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:' || u.hostname !== 'hooks.airtable.com' || u.port ||
        u.username || u.password || u.search || u.hash ||
        !/^\/workflows\/v1\/genericWebhook\/app[A-Za-z0-9]{14}\/wfl[A-Za-z0-9]{14}\/wtr[A-Za-z0-9]+$/.test(u.pathname)) return null;
    return u.href;
  } catch { return null; }
}

function validateEnquiry(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const clean = {};
  for (const [field, max] of Object.entries(LIMITS)) {
    const value = body[field] === undefined ? '' : body[field];
    // Never convert objects/arrays into strings, or truncate a contact address.
    if (typeof value !== 'string' || value.length > max || CONTROL.test(value)) return null;
    clean[field] = field === 'email' ? value.trim().toLowerCase() : value.replace(/\s+/g, ' ').trim();
  }
  if (clean['bot-field']) return { spam: true };
  if (!clean.name || !clean.company || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean.email) ||
      !CONSENT_VALUES.has(body['contact-request'])) return null;
  let website = '';
  try {
    const u = new URL(clean.company);
    if (['http:', 'https:'].includes(u.protocol) && !u.username && !u.password) website = u.href;
  } catch { /* A company name is not necessarily a URL. */ }
  return { name: clean.name, email: clean.email, business: clean.company,
    website, industry: clean.industry, notes: clean.message };
}

async function acknowledged(response) {
  if (!response.ok || response.status === 204 || !response.body) return false;
  const reader = response.body.getReader();
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) { await reader.cancel(); return false; }
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8')).success === true;
  } catch { return false; }
  finally { reader.releaseLock(); }
}

function createMarketingEnquiryRouter({
  fetchImpl = global.fetch, now = Date.now, randomUUID = crypto.randomUUID,
  webhookUrl = process.env.JEMLIO_ENQUIRY_WEBHOOK_URL || '',
  enabled = process.env.JEMLIO_ENQUIRY_ENABLED === 'true',
  allowedOrigins = ALLOWED_ORIGINS
} = {}) {
  const router = express.Router();
  const target = validateWebhookUrl(webhookUrl);
  const ready = enabled === true && Boolean(target) && typeof fetchImpl === 'function';
  const allowed = new Set(allowedOrigins), buckets = new Map();
  const windowMs = 10 * 60 * 1000, maxRequests = 6, maxBuckets = 2000;

  router.use((req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  router.use(express.urlencoded({ extended: false, limit: '16kb', parameterLimit: 16 }));

  function originAllowed(req) {
    const origin = req.headers.origin;
    if (origin) return allowed.has(origin);
    try { return allowed.has(new URL(req.headers.referer || '').origin); }
    catch { return false; }
  }
  function rateLimit(req) {
    const at = now();
    for (const [key, bucket] of buckets) if (at - bucket.startedAt >= windowMs) buckets.delete(key);
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    let bucket = buckets.get(key);
    if (!bucket) {
      // Do not evict active limits or grow memory indefinitely under IP churn.
      if (buckets.size >= maxBuckets) return 600;
      bucket = { startedAt: at, count: 0 }; buckets.set(key, bucket);
      const cleanup = setTimeout(() => { if (buckets.get(key) === bucket) buckets.delete(key); }, windowMs);
      cleanup.unref?.();
    }
    bucket.count += 1;
    return bucket.count > maxRequests ? Math.max(1, Math.ceil((windowMs - (at - bucket.startedAt)) / 1000)) : 0;
  }
  function reply(req, res, status, code, data = {}) {
    if (req.is('application/json') || String(req.headers.accept || '').includes('application/json')) {
      return res.status(status).json(code ? { error: code } : data);
    }
    // Static text only: contact details and arbitrary upstream errors are never
    // reflected into an HTML error or logged. Back navigation preserves the form.
    const forwarded = status === 202 && data.accepted === true;
    const title = forwarded ? 'Forespørselen er videresendt' : 'Forespørselen er ikke bekreftet';
    const message = forwarded
      ? 'Behandlingssystemet har akseptert forespørselen, men dette bekrefter ikke at den er lagret eller at noen har mottatt e-post.'
      : 'Vi kunne ikke bekrefte forespørselen. Bruk tilbakeknappen for å se opplysningene dine. Ikke send samme forespørsel flere ganger dersom du er usikker på om den kom frem.';
    return res.status(status).type('html').send(`<!doctype html><html lang="nb"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${title} | Jemlio</title><main><h1>${title}</h1><p>${message}</p><p>Du kan kontakte <a href="mailto:hei@jemlio.com">hei@jemlio.com</a> og opplyse at du allerede har forsøkt skjemaet.</p><a href="https://www.jemlio.com/#contact">Tilbake til Jemlio</a></main></html>`);
  }

  router.get('/status', (_req, res) => res.json({ enabled: ready, capability: 'webhook-forwarding', storageVerified: false }));
  router.post('/', async (req, res) => {
    if (!originAllowed(req)) {
      res.removeHeader('Access-Control-Allow-Origin');
      return reply(req, res, 403, 'origin_not_allowed');
    }
    const retryAfter = rateLimit(req);
    if (retryAfter) { res.setHeader('Retry-After', String(retryAfter)); return reply(req, res, 429, 'too_many_requests'); }
    const input = validateEnquiry(req.body);
    if (!input) return reply(req, res, 400, 'invalid_enquiry');
    if (input.spam) return reply(req, res, 202, null, { accepted: true, persisted: false });
    if (!ready) return reply(req, res, 503, 'enquiry_unavailable');

    const requestId = randomUUID();
    const payload = { setupOnly: false, source: 'Jemlio website', received: new Date(now()).toISOString(),
      ...input, phone: '', service: 'gratis mini-demo', preferredContact: 'email', consent: true, receipt: requestId };
    try {
      const response = await fetchImpl(target, { method: 'POST', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(8000) });
      if (!await acknowledged(response)) return reply(req, res, 503, 'enquiry_unconfirmed');
    } catch { return reply(req, res, 503, 'enquiry_unconfirmed'); }
    // Airtable also acknowledges webhooks while an automation is OFF. This
    // request ID is a correlation identifier, NOT a durable saved-lead receipt.
    return reply(req, res, 202, null, { accepted: true, persisted: false, requestId });
  });
  router.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    return reply(req, res, error.status === 413 ? 413 : 400, 'invalid_enquiry');
  });
  return router;
}
module.exports = { createMarketingEnquiryRouter, validateWebhookUrl, validateEnquiry, CONSENT_TEXT };
