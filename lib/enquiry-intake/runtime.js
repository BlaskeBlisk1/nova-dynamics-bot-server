'use strict';
const express = require('express');
const { CLIENT, UUID } = require('../booking/store');
const { verifyNetlifySignature } = require('../website-enquiries');
const { IntakeStore } = require('./store');
const SOURCE = /^[A-Za-z0-9_-]{24,64}$/;
const HEX_ID = /^[a-f0-9]{24}$/;
const FIELD = /^[A-Za-z][A-Za-z0-9 _-]{0,63}$/;
const EMAIL = /^[^\s@<>?,;:"\\\r\n]+@[^\s@<>?,;:"\\\r\n]+\.[^\s@<>?,;:"\\\r\n]+$/;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const KEYS = ['name', 'email', 'phone', 'service', 'message'];
const DEFAULT_FIELDS = Object.freeze(Object.fromEntries(KEYS.map(key => [key, key])));
function siteOrigin(value) {
  if (typeof value !== 'string' || value.length > 2048) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/' ? url.origin : null; }
  catch { return null; }
}
function readIntakeConfig(env = process.env, cfg) {
  const off = { enabled: false, sources: {} };
  if (env.JEMLIO_ENQUIRY_INTAKE_ENABLED !== 'true' || env.JEMLIO_WORKSPACE_ENABLED !== 'true') return off;
  try {
    // An explicitly invalid workspace config must never be repaired by falling
    // back to raw environment JSON. Standalone callers receive the same checks.
    const workspace = cfg === undefined ? { origin: env.JEMLIO_WORKSPACE_ORIGIN, tenants: JSON.parse(env.JEMLIO_WORKSPACE_CONFIG || '{}') } : cfg;
    if (!object(workspace) || !workspace.origin || siteOrigin(workspace.origin) !== workspace.origin || !object(workspace.tenants)) return off;
    const tenants = workspace.tenants, credentials = new Set();
    if (!Object.keys(tenants).length || Object.keys(tenants).length > 100) return off;
    for (const [client, tenant] of Object.entries(tenants)) {
      if (!CLIENT.test(client) || !object(tenant) || tenant.enabled !== true || typeof tenant.name !== 'string' || !tenant.name.trim() || tenant.name.length > 100 ||
          !/^[a-f0-9]{64}$/.test(tenant.keyHash || '') || credentials.has(tenant.keyHash) ||
          tenant.offersEnabled !== undefined && typeof tenant.offersEnabled !== 'boolean' ||
          tenant.conversationsEnabled !== undefined && typeof tenant.conversationsEnabled !== 'boolean') return off;
      credentials.add(tenant.keyHash);
    }
    const input = JSON.parse(env.JEMLIO_ENQUIRY_INTAKE_SOURCES || '{}');
    if (!object(tenants) || !object(input) || Object.keys(input).length > 100) return off;
    const sources = {}, providers = new Set();
    for (const [id, source] of Object.entries(input)) {
      if (!SOURCE.test(id) || !object(source) || typeof source.enabled !== 'boolean') return off;
      if (!source.enabled) continue;
      const fields = { ...DEFAULT_FIELDS, ...source.fields };
      if (Object.keys(source).some(key => !['enabled', 'client', 'formId', 'siteId', 'formName', 'siteUrl', 'signingKeyEnv', 'fields', 'honeypotField'].includes(key)) ||
          typeof source.client !== 'string' || !CLIENT.test(source.client) || !Object.hasOwn(tenants, source.client) || tenants[source.client]?.enabled !== true ||
          !/^[a-f0-9]{64}$/.test(tenants[source.client].keyHash || '') ||
          typeof source.formId !== 'string' || !HEX_ID.test(source.formId) || typeof source.siteId !== 'string' || !UUID.test(source.siteId) ||
          typeof source.formName !== 'string' || !source.formName.trim() || source.formName.length > 100 || /[\u0000-\u001f\u007f]/.test(source.formName) ||
          !siteOrigin(source.siteUrl) || typeof source.signingKeyEnv !== 'string' || !/^JEMLIO_ENQUIRY_INTAKE_KEY_[A-Z0-9_]{1,80}$/.test(source.signingKeyEnv) ||
          source.fields !== undefined && (!object(source.fields) || Object.keys(source.fields).some(key => !KEYS.includes(key))) ||
          Object.values(fields).some(value => typeof value !== 'string' || !FIELD.test(value)) || new Set(Object.values(fields)).size !== KEYS.length ||
          source.honeypotField !== undefined && (typeof source.honeypotField !== 'string' || !FIELD.test(source.honeypotField))) return off;
      const honeypotField = source.honeypotField || 'bot-field';
      if (Object.values(fields).includes(honeypotField)) return off;
      const secret = env[source.signingKeyEnv];
      if (typeof secret !== 'string' || secret.length < 32 || secret.length > 512) return off;
      const siteId = source.siteId.toLowerCase(), provider = siteId + ':' + source.formId;
      if (providers.has(provider)) return off;
      providers.add(provider);
      sources[id] = { id, client: source.client, siteId, formId: source.formId,
        formName: source.formName, siteUrl: siteOrigin(source.siteUrl), secret, fields, honeypotField };
    }
    return Object.keys(sources).length ? { enabled: true, sources } : off;
  } catch { return off; }
}
function normalizeSubmission(payload, source, now = Date.now()) {
  if (!object(payload) || typeof payload.id !== 'string' || !HEX_ID.test(payload.id) || payload.form_id !== source.formId || payload.form_name !== source.formName ||
      siteOrigin(payload.site_url) !== source.siteUrl || payload.site_id !== undefined && (typeof payload.site_id !== 'string' || payload.site_id.toLowerCase() !== source.siteId) || !object(payload.data)) return null;
  const input = payload.data;
  if (payload.spam === true || payload.is_spam === true || payload.state === 'spam') return { ignored: true };
  if (Object.hasOwn(input, source.honeypotField)) {
    if (typeof input[source.honeypotField] !== 'string') return null;
    if (input[source.honeypotField].trim()) return { ignored: true };
  }
  if (typeof payload.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/.test(payload.created_at)) return null;
  const createdAt = Date.parse(payload.created_at);
  if (!Number.isFinite(createdAt) || createdAt < Date.UTC(2000, 0, 1) || createdAt > now + 300000 ||
      new Date(createdAt).toISOString().slice(0, 19) !== payload.created_at.slice(0, 19)) return null;
  const clean = { providerId: payload.id, sourceCreatedAt: new Date(createdAt).toISOString() };
  for (const [key, max] of [['name', 100], ['email', 254], ['phone', 30], ['service', 160], ['message', 2000]]) {
    const value = Object.hasOwn(input, source.fields[key]) ? input[source.fields[key]] : '';
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) || key !== 'message' && /[\r\n\t]/.test(value)) return null;
    clean[key] = key === 'email' ? value.trim().toLowerCase() : value.trim();
  }
  const reviewReasons = [];
  if (clean.email && !EMAIL.test(clean.email)) { clean.email = ''; reviewReasons.push('invalid_email'); }
  if (clean.phone && (!/^\+?[\d ()-]{3,30}$/.test(clean.phone) || clean.phone.replace(/\D/g, '').length < 3)) { clean.phone = ''; reviewReasons.push('invalid_phone'); }
  if (!clean.email && !clean.phone) return null;
  if (!clean.name) reviewReasons.push('missing_name');
  if (!clean.service) reviewReasons.push('missing_service');
  if (!clean.email && !reviewReasons.includes('invalid_email')) reviewReasons.push('missing_email');
  clean.reviewReasons = reviewReasons;
  return clean;
}
function createEnquiryIntakeRuntime({ env = process.env, pool: injected, cfg, now = Date.now } = {}) {
  const config = readIntakeConfig(env, cfg);
  const enabled = Boolean(config.enabled && (injected || env.NOVA_DATABASE_URL));
  let pool = enabled ? injected : null, owned = false;
  if (enabled && !pool) {
    pool = new (require('pg').Pool)({ connectionString: env.NOVA_DATABASE_URL, max: 3, connectionTimeoutMillis: 5000,
      query_timeout: 5000, idleTimeoutMillis: 30000, allowExitOnIdle: true });
    pool.on('error', () => console.error('Jemlio enquiry intake: database unavailable.'));
    owned = true;
  }
  const store = pool ? new IntakeStore({ pool, now }) : null;
  const ready = async () => { try { return Boolean(enabled && await store.ready()); } catch { return false; } };
  const router = express.Router();
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow', 'X-Content-Type-Options': 'nosniff' }); next(); });
  router.use((req, res, next) => {
    if (!enabled) return res.status(503).json({ error: 'enquiry_intake_disabled' });
    if (req.method !== 'POST') return res.status(405).json({ error: 'method_not_allowed' });
    next();
  });
  router.post('/netlify/:source', (req, res, next) => {
    if (!SOURCE.test(req.params.source) || !Object.hasOwn(config.sources, req.params.source)) return res.status(404).json({ error: 'source_not_found' });
    if (Object.keys(req.query).length) return res.status(400).json({ error: 'invalid_submission' });
    if (!req.is('application/json')) return res.status(415).json({ error: 'json_required' });
    next();
  }, express.raw({ type: 'application/json', limit: '32kb', inflate: false }), async (req, res) => {
    const source = config.sources[req.params.source];
    if (!verifyNetlifySignature(req.get('x-webhook-signature'), req.body, source.secret, now())) return res.status(401).json({ error: 'invalid_signature' });
    let submission;
    try { submission = normalizeSubmission(JSON.parse(req.body.toString('utf8')), source, now()); }
    catch { return res.status(400).json({ error: 'invalid_submission' }); }
    if (!submission) return res.status(400).json({ error: 'invalid_submission' });
    if (submission.ignored) return res.json({ accepted: false, ignored: true, sendsMessages: false });
    try {
      if (!await ready()) throw new Error('database_not_ready');
      const saved = await store.create(source, submission);
      return res.status(saved.duplicate ? 200 : 201).json({ accepted: true, persisted: true, ...saved });
    } catch (error) {
      if (error.code === 'submission_conflict') return res.status(409).json({ error: 'submission_conflict' });
      if (error.code === 'submission_removed') return res.json({ accepted: false, removed: true, sendsMessages: false });
      res.set('Retry-After', '30');
      return res.status(503).json({ error: 'enquiry_intake_unavailable' });
    }
  });
  router.use((_req, res) => res.status(404).json({ error: 'source_not_found' }));
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    res.status(error.status === 413 ? 413 : error.status === 415 ? 415 : 400).json({ error: 'invalid_submission' });
  });
  return { router, store, ready, enabled, close: async () => { if (owned) await pool.end(); } };
}
module.exports = { createEnquiryIntakeRuntime, readIntakeConfig, normalizeSubmission };
