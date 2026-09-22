'use strict';

const { PgStore } = require('./capture/store');
const { createResendNotifier, flushNotifications } = require('./capture/notification');
const { CrmOutbox, createAirtableWriter, flushCrm } = require('./capture/crm');
const { WEBSITE_CLIENT, readWebsiteConfig, createWebsiteEnquiryRouter } = require('./website-enquiries');

function createWebsiteEnquiryRuntime({ env = process.env } = {}) {
  const config = readWebsiteConfig(env);
  let pool, store, crmStore;
  // Importing the app does not migrate data, send mail, or start a worker.
  if (config.enabled && env.NOVA_DATABASE_URL) {
    const { Pool } = require('pg');
    pool = new Pool({ connectionString: env.NOVA_DATABASE_URL, max: 3, connectionTimeoutMillis: 5000,
      query_timeout: 5000, idleTimeoutMillis: 30_000, allowExitOnIdle: true });
    pool.on('error', () => console.error('Jemlio website: database connection unavailable.'));
    store = new PgStore({ pool, claimClient: WEBSITE_CLIENT });
    crmStore = new CrmOutbox({ pool, claimClient: WEBSITE_CLIENT });
  }
  let readiness = { at: 0, ok: false };
  async function databaseReady() {
    if (!pool) return false;
    if (Date.now() - readiness.at < 10_000) return readiness.ok;
    let ok = false;
    try {
      const result = await pool.query(`SELECT
        to_regclass('public.nova_capture_requests') IS NOT NULL AND
        to_regclass('public.nova_capture_outbox') IS NOT NULL AND
        to_regclass('public.nova_capture_crm_outbox') IS NOT NULL AND
        to_regclass('public.nova_capture_submission_tombstones') IS NOT NULL AS ready`);
      ok = result.rows[0]?.ready === true;
    } catch {}
    readiness = { at: Date.now(), ok }; return ok;
  }
  const router = createWebsiteEnquiryRouter({ config, store, databaseReady });
  let timer, active, stopped = true;
  const emailReady = Boolean(config.enabled && config.emailEnabled && env.RESEND_API_KEY);
  const crmReady = Boolean(config.enabled && config.crmEnabled && env.AIRTABLE_PERSONAL_ACCESS_TOKEN);
  async function flushEmail() {
    if (!emailReady) return [];
    return flushNotifications({ store, limit: 1, sendNotification: createResendNotifier({ apiKey: env.RESEND_API_KEY }),
      isTenantEnabled: async (client, message) => config.enabled && config.emailEnabled && client === WEBSITE_CLIENT &&
        message?.from === config.from && Array.isArray(message.to) && message.to.length === 1 && message.to[0] === config.recipient });
  }
  async function flushAirtable() {
    if (!crmReady) return [];
    return flushCrm({ store: crmStore, limit: 1, writeCrm: createAirtableWriter({ apiKey: env.AIRTABLE_PERSONAL_ACCESS_TOKEN }),
      isTenantEnabled: async (client, destination) => config.enabled && config.crmEnabled && client === WEBSITE_CLIENT &&
        destination.baseId === config.destination.baseId && destination.tableId === config.destination.tableId });
  }
  async function tick() {
    if (stopped || active || !store) return;
    active = (async () => {
      if (!await databaseReady()) return;
      const results = await Promise.allSettled([flushEmail(), flushAirtable()]);
      for (const result of results) {
        if (result.status === 'rejected') console.error('Jemlio website: delivery unavailable; enquiry remains saved.');
        else if (result.value.some(item => ['failed', 'needs_review', 'claim_lost'].includes(item.status))) {
          console.error('Jemlio website: a delivery item requires operator review.');
        }
      }
    })().finally(() => { active = null; });
    await active;
  }
  function startWorker() {
    if (!stopped || !store || !emailReady && !crmReady) return;
    stopped = false;
    timer = setInterval(() => { void tick(); }, 5000); timer.unref(); void tick();
  }
  async function close() {
    stopped = true; clearInterval(timer); await active; if (pool) await pool.end();
  }
  return { router, startWorker, close };
}

module.exports = { createWebsiteEnquiryRuntime };
