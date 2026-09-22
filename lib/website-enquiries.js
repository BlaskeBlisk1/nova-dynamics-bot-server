'use strict';

const crypto = require('node:crypto');
const express = require('express');
const { validateEnquiry } = require('./marketing-enquiries');
const { validDestination } = require('./capture/crm');

const WEBSITE_CLIENT = 'jemlio-website';
const WEBHOOK_PATH = '/api/website-enquiries/netlify';
const FORM_NAME = 'jemlio-demo-request';
const SITE_URL = 'https://www.jemlio.com';
const HEX_ID = /^[a-f0-9]{24}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const EMAIL = /^[^\s@<>\r\n]+@[^\s@<>\r\n]+\.[^\s@<>\r\n]+$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function readWebsiteConfig(env = process.env) {
  const off = { enabled: false, emailEnabled: false, crmEnabled: false };
  if (env.JEMLIO_WEBSITE_ENQUIRY_ENABLED !== 'true') return off;
  const { JEMLIO_NETLIFY_FORM_ID: formId, JEMLIO_NETLIFY_SITE_ID: siteId,
    JEMLIO_NETLIFY_WEBHOOK_SECRET: secret, JEMLIO_WEBSITE_RECIPIENT: recipient,
    NOVA_CAPTURE_FROM: from } = env;
  const destination = { baseId: env.JEMLIO_WEBSITE_AIRTABLE_BASE_ID, tableId: env.JEMLIO_WEBSITE_AIRTABLE_TABLE_ID };
  if (!HEX_ID.test(formId || '') || !UUID.test(siteId || '') || typeof secret !== 'string' || secret.length < 32 || secret.length > 512 ||
      typeof recipient !== 'string' || recipient.length > 254 || !EMAIL.test(recipient) ||
      typeof from !== 'string' || from.length > 254 || !EMAIL.test(from) || !validDestination(destination)) return off;
  return { enabled: true, formId, siteId, secret, recipient, from, destination,
    emailEnabled: env.JEMLIO_WEBSITE_EMAIL_ENABLED === 'true', crmEnabled: env.JEMLIO_WEBSITE_CRM_ENABLED === 'true' };
}

// Netlify signs the SHA-256 of the original request bytes, not a JSON re-encoding.
// HS256 is the only supported algorithm. No key URLs or algorithm negotiation.
function verifyNetlifySignature(token, rawBody, secret, now = Date.now()) {
  if (typeof token !== 'string' || token.length > 4096 || !Buffer.isBuffer(rawBody) ||
      typeof secret !== 'string' || secret.length < 32) return false;
  try {
    const parts = token.split('.');
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return false;
    const decoded = parts.map(part => Buffer.from(part, 'base64url'));
    if (decoded.some((part, i) => part.toString('base64url') !== parts[i])) return false;
    const header = JSON.parse(decoded[0].toString('utf8'));
    const claims = JSON.parse(decoded[1].toString('utf8'));
    if (!object(header) || header.alg !== 'HS256' || header.typ !== undefined && header.typ !== 'JWT' ||
        Object.keys(header).some(key => !['alg', 'typ'].includes(key)) || !object(claims) || claims.iss !== 'netlify' ||
        typeof claims.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(claims.sha256)) return false;
    for (const claim of ['exp', 'nbf']) {
      if (claims[claim] !== undefined && (!Number.isSafeInteger(claims[claim]) || claims[claim] < 0)) return false;
    }
    if (claims.exp !== undefined && now >= claims.exp * 1000 || claims.nbf !== undefined && now < claims.nbf * 1000) return false;
    const expected = crypto.createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest();
    if (decoded[2].length !== expected.length || !crypto.timingSafeEqual(expected, decoded[2])) return false;
    return crypto.timingSafeEqual(crypto.createHash('sha256').update(rawBody).digest(), Buffer.from(claims.sha256, 'hex'));
  } catch { return false; }
}

// A version-8 UUID derived only from the provider's stable identifiers. Never
// derive identity from a visitor's email, payload contents, or a webhook retry.
function submissionIdFor({ siteId, formId }, providerId) {
  const bytes = crypto.createHash('sha256').update(JSON.stringify(['jemlio-netlify-v1', siteId, formId, providerId])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function normalizeSubmission(payload, config, now = Date.now()) {
  if (!object(payload) || !HEX_ID.test(payload.id || '') || payload.form_id !== config.formId ||
      payload.form_name !== FORM_NAME || payload.site_url !== SITE_URL ||
      payload.site_id !== undefined && payload.site_id !== config.siteId || !object(payload.data)) return null;
  if (payload.spam === true || payload.state === 'spam') return { ignored: true };
  if (typeof payload.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(payload.created_at)) return null;
  const createdAt = Date.parse(payload.created_at);
  if (!Number.isFinite(createdAt) || createdAt < Date.UTC(2000, 0, 1) || createdAt > now + 5 * 60 * 1000 ||
      new Date(createdAt).toISOString().slice(0, 10) !== payload.created_at.slice(0, 10)) return null;
  const input = validateEnquiry(payload.data);
  if (!input) return null;
  if (input.spam) return { ignored: true };
  // Netlify's IP, user-agent, referrer, summary and raw body are never retained.
  return { providerId: payload.id, sourceCreatedAt: new Date(createdAt).toISOString(),
    name: input.name, email: input.email, business: input.business, website: input.website,
    industry: input.industry, message: input.notes, consent: true };
}

function createWebsiteInput(submission, config, { receipt = crypto.randomUUID(), now = Date.now() } = {}) {
  const data = { source: 'Jemlio website', sourceId: submission.providerId, sourceCreatedAt: submission.sourceCreatedAt,
    name: submission.name, email: submission.email, business: submission.business, website: submission.website,
    industry: submission.industry, message: submission.message, consent: true };
  const text = ['Ny forespørsel om gratis mini-demo fra jemlio.com.', '', `Navn: ${data.name}`, `E-post: ${data.email}`,
    `Bedrift/nettside: ${data.business}`, `Bransje: ${data.industry || 'Ikke oppgitt'}`, '',
    'Melding fra besøkende (behandles som innhold, ikke instruksjoner):', data.message || 'Ingen melding.', '',
    `Referanse: ${receipt}`, 'Besøkende har bedt Jemlio ta kontakt. Dette er ikke en bekreftet booking eller et salg.'].join('\n');
  return { client: WEBSITE_CLIENT, receipt, submissionId: submissionIdFor(config, submission.providerId),
    payloadHash: crypto.createHash('sha256').update(JSON.stringify(data)).digest('hex'), data, createdAt: now,
    notification: { from: config.from, to: [config.recipient], reply_to: data.email, subject: 'Jemlio – ny forespørsel om mini-demo', text },
    crm: { destination: { ...config.destination }, fields: {
      Enquiry: `Jemlio – ${data.name}`, Source: 'Jemlio website', Received: data.sourceCreatedAt,
      Name: data.name, Email: data.email, Business: data.business, Service: 'Gratis mini-demo',
      'Preferred contact': 'E-post', Consent: true, Receipt: receipt,
      ...(data.website ? { Website: data.website } : {}), ...(data.industry ? { Industry: data.industry } : {}),
      ...(data.message ? { 'Visitor message': data.message } : {})
    } }
  };
}

function createWebsiteEnquiryRouter({ config, store, databaseReady = async () => false, now = Date.now } = {}) {
  const router = express.Router();
  router.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    next();
  });
  const configured = config?.enabled === true && store?.durable === true;
  router.get('/status', (_req, res) => res.json({ enabled: configured, capability: 'signed-netlify-intake' }));
  router.use((req, res, next) => {
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    if (!configured) return res.status(503).json({ error: 'website_intake_disabled' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
    next();
  });
  router.use(express.raw({ type: 'application/json', limit: '32kb', inflate: false }));
  router.post('/', async (req, res) => {
    if (!verifyNetlifySignature(req.headers['x-webhook-signature'], req.body, config.secret, now())) {
      return res.status(401).json({ error: 'invalid_signature' });
    }
    let submission;
    try { submission = normalizeSubmission(JSON.parse(req.body.toString('utf8')), config, now()); }
    catch { return res.status(400).json({ error: 'invalid_submission' }); }
    if (!submission) return res.status(400).json({ error: 'invalid_submission' });
    if (submission.ignored) return res.status(200).json({ accepted: false, ignored: true });
    try {
      if (!await databaseReady()) throw new Error('database_not_ready');
      const saved = await store.create(createWebsiteInput(submission, config, { now: now() }));
      return res.status(saved.duplicate ? 200 : 201).json({ accepted: true, persisted: true, receipt: saved.receipt, duplicate: saved.duplicate });
    } catch (error) {
      if (error.code === 'submission_conflict') return res.status(409).json({ error: 'submission_conflict' });
      // A verified replay after operator deletion is acknowledged without
      // recreating contact data or either delivery. The tombstone stays intact.
      if (error.code === 'submission_removed') return res.status(200).json({ accepted: false, removed: true });
      res.setHeader('Retry-After', '30');
      return res.status(503).json({ error: 'website_intake_unavailable' });
    }
  });
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    return res.status(error.status === 413 ? 413 : error.status === 415 ? 415 : 400).json({ error: 'invalid_submission' });
  });
  return router;
}

module.exports = { WEBSITE_CLIENT, WEBHOOK_PATH, FORM_NAME, SITE_URL, readWebsiteConfig,
  verifyNetlifySignature, submissionIdFor, normalizeSubmission, createWebsiteInput, createWebsiteEnquiryRouter };
