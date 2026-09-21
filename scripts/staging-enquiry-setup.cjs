'use strict';

// Run only on the separate integration staging service, never npm start.
// All setup and site-task capabilities must be cleared after their one-shot use.
const http = require('node:http');
const { randomUUID } = require('node:crypto');

function validTarget(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' && u.hostname === 'hooks.airtable.com' &&
      !u.port && !u.username && !u.password && !u.search && !u.hash &&
      /^\/workflows\/v1\/genericWebhook\/app[A-Za-z0-9]{14}\/wfl[A-Za-z0-9]{14}\/wtr[A-Za-z0-9]+$/.test(u.pathname);
  } catch { return false; }
}

async function seed({ env = process.env, fetchImpl = fetch, now = Date.now } = {}) {
  if (env.JEMLIO_STAGING_ONLY !== 'true') throw new Error('staging_only');
  for (const name of ['NOVA_CAPTURE_ENABLED', 'NOVA_CAPTURE_WORKER_ENABLED']) {
    if (env[name] !== 'false') throw new Error('capture_must_be_disabled');
  }
  if (env.JEMLIO_SETUP_SCHEMA !== 'true') return 'disabled';
  const until = Date.parse(env.JEMLIO_SETUP_VALID_UNTIL || '');
  if (!Number.isFinite(until) || now() > until || until - now() > 6 * 3600000) throw new Error('setup_window_invalid');
  const target = env.JEMLIO_SETUP_WEBHOOK_URL;
  if (!validTarget(target)) throw new Error('setup_target_invalid');
  const payload = {
    setupOnly: true,
    source: 'Jemlio website', received: new Date(now()).toISOString(),
    name: 'Synthetic integration test', email: 'nobody@example.invalid',
    phone: '', business: 'TEST ONLY - no sales follow-up',
    website: 'https://example.invalid', industry: 'Trafikkskole',
    service: 'gratis mini-demo', preferredContact: 'email', consent: true,
    receipt: randomUUID(), notes: 'Synthetic schema example only. Do not contact.'
  };
  const response = await fetchImpl(target, {
    method: 'POST', redirect: 'error',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload), signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error('setup_rejected');
  const result = await response.json();
  if (result.success !== true) throw new Error('setup_not_acknowledged');
  return 'accepted';
}

if (require.main === module) {
  if (process.env.JEMLIO_STAGING_ONLY !== 'true') {
    console.error('Refusing to run outside isolated staging.'); process.exitCode = 1;
  } else {
    let state = 'starting', siteTask = { state: 'starting' };
    const server = http.createServer((req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (req.method !== 'GET' || !['/', '/healthz'].includes(req.url)) {
        res.writeHead(404); return res.end();
      }
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ mode: 'integration-staging', schemaSample: state, siteTask }));
    });
    server.listen(Number(process.env.PORT || 10000), '0.0.0.0', async () => {
      try {
        state = await seed(); console.log(`Schema setup: ${state}. No customer data or mail.`);
        siteTask = await require('./staging-site-task.cjs').runSiteTask();
        console.log(`Site task: ${siteTask.task}; state: ${siteTask.state}; exit: ${siteTask.exitCode ?? 'none'}. Verify provider state separately.`);
      } catch {
        if (state === 'starting') state = 'failed';
        siteTask = { state: 'failed' };
        console.error('Staging task failed; no configuration, request body or subprocess output logged.');
      }
    });
    process.on('SIGTERM', () => server.close());
  }
}
module.exports = { seed, validTarget };
