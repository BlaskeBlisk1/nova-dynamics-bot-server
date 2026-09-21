'use strict';
// Explicit one-shot operations for the existing integration staging service.
// Never imported by npm start. No deployment capability is written to disk,
// copied into the publish bundle or printed in subprocess output.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const SITE = '8fddfa2f-2643-4bb9-b40f-39d5216ce675';
const SERVICE = 'srv-daopc4tg1s2s7383pokg';
const REPO = 'BlaskeBlisk1/nova-dynamics-bot-server';
const FILES = Object.freeze(['_headers', '_redirects', 'assets/jemlio-orbit.webp',
  'assets/jemlio-wordmark.webp', 'demo-requested.html', 'form-definition.html', 'index.html', 'privacy.html', 'site.js', 'styles.css']);
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

function configuration(env, at = Date.now()) {
  const task = env.JEMLIO_SITE_TASK;
  if (!task || task === 'off') return null;
  if (!['publish-marketing', 'form-smoke'].includes(task)) throw new Error('unsupported_site_task');
  if (env.JEMLIO_STAGING_ONLY !== 'true' || env.RENDER_SERVICE_ID !== SERVICE ||
      env.RENDER_GIT_REPO_SLUG !== REPO || env.NOVA_CAPTURE_ENABLED !== 'false' ||
      env.NOVA_CAPTURE_WORKER_ENABLED !== 'false' || env.JEMLIO_SETUP_SCHEMA !== 'false') throw new Error('wrong_environment');
  if (!/^[a-f0-9]{40}$/.test(env.JEMLIO_SITE_TASK_COMMIT || '') || env.RENDER_GIT_COMMIT !== env.JEMLIO_SITE_TASK_COMMIT) throw new Error('unverified_revision');
  const until = Date.parse(env.JEMLIO_SITE_TASK_UNTIL || '');
  if (!Number.isFinite(until) || until <= at || until - at > 30 * 60000) throw new Error('invalid_site_task_window');
  if (task === 'publish-marketing') {
    const u = new URL(env.JEMLIO_NETLIFY_DEPLOY_PROXY || '');
    if (u.origin !== 'https://netlify-mcp.netlify.app' || u.username || u.password || u.search || u.hash ||
        !/^\/proxy\/[A-Za-z0-9_.-]+$/.test(u.pathname)) throw new Error('invalid_deploy_capability');
    return { task, proxy: u.href, lockKey: crypto.createHash('sha256').update(u.href).digest('hex') };
  }
  if (!UUID.test(env.JEMLIO_FORM_TEST_ID || '')) throw new Error('invalid_test_marker');
  return { task, testId: env.JEMLIO_FORM_TEST_ID, lockKey: env.JEMLIO_FORM_TEST_ID };
}

function prepareBundle(root, target) {
  const source = path.join(root, 'public', 'marketing');
  const html = fs.readFileSync(path.join(source, 'index.html'), 'utf8');
  if (!html.includes('name="jemlio-demo-request"') || !html.includes('data-netlify="true"') ||
      !html.includes('netlify-honeypot="bot-field"') || !html.includes('name="form-name" value="jemlio-demo-request"') ||
      !html.includes('action="https://www.jemlio.com/demo-requested"')) throw new Error('native_form_required');
  for (const file of FILES) {
    const full = path.join(source, file), info = fs.lstatSync(full);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 3 * 1024 * 1024) throw new Error('unexpected_public_asset');
    const destination = path.join(target, 'public', 'marketing', file);
    fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.copyFileSync(full, destination);
  }
  // Only these public assets and this small config are uploaded. No repository
  // history, backend code, environment files or machine credentials are copied.
  fs.writeFileSync(path.join(target, 'netlify.toml'), '[build]\n  publish = "public/marketing"\n');
}

async function runSiteTask({ env = process.env, now = Date.now, fetchImpl = fetch, spawnImpl = spawn,
  root = path.resolve(__dirname, '..'), tempRoot = os.tmpdir() } = {}) {
  const config = configuration(env, now());
  if (!config) return { task: 'off', state: 'disabled' };
  const lock = path.join(tempRoot, `jemlio-site-task-${config.task}-${config.lockKey}.lock`);
  try { fs.writeFileSync(lock, 'attempted', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code === 'EEXIST') return { task: config.task, state: 'already-attempted' }; throw error; }
  if (config.task === 'form-smoke') {
    // Use only the owner's already-public business mailbox, never a prospect.
    // The marker makes the resulting record distinguishable from a real lead.
    const body = new URLSearchParams({ 'form-name': 'jemlio-demo-request', 'bot-field': '',
      name: 'Jemlio systemtest', email: 'hei@jemlio.com',
      company: `JEMLIO TEST - DO NOT CONTACT - ${config.testId}`, industry: 'Annen tjenestebedrift',
      message: `Synthetic release verification only. Not a sales lead. Marker: ${config.testId}`,
      'contact-request': 'Jeg ber Jemlio kontakte meg om min gratis mini-demo' });
    const response = await fetchImpl('https://www.jemlio.com/demo-requested', { method: 'POST', redirect: 'manual',
      headers: { Origin: 'https://www.jemlio.com', 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html' },
      body: body.toString(), signal: AbortSignal.timeout(20000) });
    await response.body?.cancel();
    return { task: config.task, state: 'request-finished', httpStatus: response.status, storageVerified: false };
  }
  const directory = fs.mkdtempSync(path.join(tempRoot, 'jemlio-public-publish-'));
  try {
    prepareBundle(root, directory);
    const childEnv = {};
    for (const key of ['PATH', 'HOME', 'TMPDIR']) if (env[key]) childEnv[key] = env[key];
    childEnv.CI = 'true'; childEnv.NETLIFY_TELEMETRY_DISABLED = '1';
    const exit = await new Promise(resolve => {
      const child = spawnImpl('npx', ['-y', '@netlify/mcp@latest', '--site-id', SITE, '--proxy-path', config.proxy],
        { cwd: directory, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'], timeout: 240000, killSignal: 'SIGKILL' });
      // Drain and discard output; upstream CLIs can echo bearer-capability URLs.
      child.stdout?.on('data', () => {}); child.stderr?.on('data', () => {});
      child.once('error', () => resolve(1)); child.once('close', code => resolve(code === null ? 1 : code));
    });
    return { task: config.task, state: exit === 0 ? 'command-completed' : 'command-failed', exitCode: exit,
      siteId: SITE, sourceCommit: env.RENDER_GIT_COMMIT, files: FILES.length, deploymentVerified: false };
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
module.exports = { configuration, prepareBundle, runSiteTask, FILES };
