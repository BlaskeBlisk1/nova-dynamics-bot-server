"use strict";

const { createUpgradeConfig } = require("./upgrade-config");
const { createConversationManager } = require("./conversation");
const { createCaptureRouter, PgStore, createResendNotifier, flushNotifications } = require("./capture");
const { CrmOutbox, createAirtableWriter, flushCrm } = require("./capture/crm");
const { WEBSITE_CLIENT } = require("./website-enquiries");

function createUpgradeRuntime({ env = process.env, getRegistry }) {
  const config = createUpgradeConfig({ env, getRegistry });
  const conversations = createConversationManager();
  const deliveryConfigured = env.NOVA_CAPTURE_WORKER_ENABLED === "true" &&
    Boolean(env.RESEND_API_KEY) && Boolean(env.NOVA_CAPTURE_FROM);
  const crmConfigured = env.NOVA_CAPTURE_CRM_ENABLED === "true" && Boolean(env.AIRTABLE_PERSONAL_ACCESS_TOKEN);
  let pool;
  let store;
  if (config.hasLiveCapture() && env.NOVA_DATABASE_URL && deliveryConfigured) {
    const { Pool } = require("pg");
    pool = new Pool({
      connectionString: env.NOVA_DATABASE_URL,
      max: 4,
      connectionTimeoutMillis: 5000,
      query_timeout: 5000,
      idleTimeoutMillis: 30_000,
      allowExitOnIdle: true
    });
    // Never include database errors, credentials or enquiry data in logs.
    pool.on("error", () => console.error("Nova capture: database connection unavailable."));
    store = new PgStore({ pool, excludeClient: WEBSITE_CLIENT });
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
        to_regclass('public.nova_capture_submission_tombstones') IS NOT NULL AND
        to_regclass('public.nova_capture_rate_limits') IS NOT NULL AND
        (NOT $1::boolean OR to_regclass('public.nova_capture_crm_outbox') IS NOT NULL) AS ready`,
      [config.hasLiveCrm() || crmConfigured]);
      ok = result.rows[0]?.ready === true;
    } catch {}
    readiness = { at: Date.now(), ok };
    return ok;
  }
  async function tenantConfig(client, options) {
    const selected = config.captureTenant(client, options);
    if (selected?.mode === "live" && (!deliveryConfigured || !await databaseReady())) return null;
    return selected;
  }
  const router = createCaptureRouter({
    getTenantConfig: tenantConfig,
    liveStore: store,
    secret: env.NOVA_CAPTURE_SECRET,
    notificationFrom: env.NOVA_CAPTURE_FROM
  });

  async function features(client, { preview = false } = {}) {
    return {
      conversation: preview ? config.canPreview(client) : config.conversationEnabled(client),
      capture: await router.getPublicConfig(client, { preview })
    };
  }

  // Delivery is opt-in and starts only from the application's main entry point.
  // Importing the app in tests never dispatches any notification.
  let timer;
  let active;
  let stopped = true;
  const crmStore = pool && crmConfigured ? new CrmOutbox({ pool, excludeClient: WEBSITE_CLIENT }) : null;
  async function flushMail() {
    if (stopped || !store || !deliveryConfigured || !await databaseReady()) return [];
    const notify = createResendNotifier({ apiKey: env.RESEND_API_KEY });
    return flushNotifications({
      store,
      sendNotification: notify,
      limit: 10,
      isTenantEnabled: async (client, notification) => {
        const selected = await tenantConfig(client, { preview: false });
        const publicConfig = await router.getPublicConfig(client, { preview: false });
        return publicConfig.enabled && selected?.mode === "live" &&
          notification?.from === env.NOVA_CAPTURE_FROM &&
          Array.isArray(notification?.to) && notification.to.length === 1 &&
          notification.to[0] === selected.recipient;
      }
    });
  }
  async function flushAirtable() {
    if (stopped || !crmStore || !await databaseReady()) return [];
    return flushCrm({ store: crmStore, writeCrm: createAirtableWriter({ apiKey: env.AIRTABLE_PERSONAL_ACCESS_TOKEN }),
      limit: 1,
      isTenantEnabled: async (client, destination) => {
        const selected = await tenantConfig(client, { preview: false });
        const publicConfig = await router.getPublicConfig(client, { preview: false });
        return publicConfig.enabled && selected?.mode === "live" &&
          selected.crm?.baseId === destination.baseId && selected.crm?.tableId === destination.tableId;
      }
    });
  }
  function startWorker() {
    if (!store || !deliveryConfigured || !stopped) return;
    stopped = false;
    const tick = () => {
      if (stopped || active) return;
      // A CRM outage cannot prevent the independent email queue from running.
      active = Promise.allSettled([flushMail(), flushAirtable()]).then(queues => {
        // Operational counts only; no recipients, names or message text.
        for (const queue of queues) {
          if (queue.status === "rejected") console.error("Nova capture: delivery queue unavailable; requests remain saved.");
          else {
            const attention = queue.value.filter(r => ["failed", "needs_review", "claim_lost"].includes(r.status)).length;
            if (attention) console.error(`Nova capture: ${attention} delivery item(s) need operator review.`);
          }
        }
      })
        .finally(() => { active = null; });
    };
    timer = setInterval(tick, 5000);
    timer.unref();
    tick();
  }
  async function close() {
    stopped = true;
    clearInterval(timer);
    await active;
    conversations.clear();
    if (pool) await pool.end();
  }
  return { config, conversations, router, features, startWorker, close };
}

module.exports = { createUpgradeRuntime };
