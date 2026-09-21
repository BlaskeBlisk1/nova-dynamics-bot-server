'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { JSDOM } = require('jsdom');
const { configuration, prepareBundle, runSiteTask, FILES } = require('./staging-site-task.cjs');
const at = Date.parse('2026-09-21T21:00:00Z');
const base = { JEMLIO_SITE_TASK: 'publish-marketing', JEMLIO_STAGING_ONLY: 'true',
  RENDER_SERVICE_ID: 'srv-daopc4tg1s2s7383pokg', RENDER_GIT_REPO_SLUG: 'BlaskeBlisk1/nova-dynamics-bot-server',
  NOVA_CAPTURE_ENABLED: 'false', NOVA_CAPTURE_WORKER_ENABLED: 'false', JEMLIO_SETUP_SCHEMA: 'false',
  JEMLIO_SITE_TASK_COMMIT: 'a'.repeat(40), RENDER_GIT_COMMIT: 'a'.repeat(40),
  JEMLIO_SITE_TASK_UNTIL: new Date(at + 600000).toISOString(),
  JEMLIO_NETLIFY_DEPLOY_PROXY: 'https://netlify-mcp.netlify.app/proxy/synthetic-test-only',
  PATH: process.env.PATH, HOME: process.env.HOME, SECRET_TEST_VALUE: 'must-not-leave-parent' };
const root = path.resolve(__dirname, '..');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'jemlio-stage-test-'));
let checks = 0;
async function test(name, run) { await run(); console.log(`ok ${++checks} - ${name}`); }
function allFiles(directory, prefix = '') {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap(item => {
    const relative = path.join(prefix, item.name);
    return item.isDirectory() ? allFiles(path.join(directory, item.name), relative) : [relative];
  }).sort();
}
(async () => {
  try {
    await test('site tasks are disabled by default and restricted to the exact isolated service and revision', () => {
      assert.equal(configuration({}, at), null);
      assert.equal(configuration({ JEMLIO_SITE_TASK: 'off' }, at), null);
      for (const [key, value] of [['RENDER_SERVICE_ID', 'production'], ['RENDER_GIT_REPO_SLUG', 'other/repo'],
        ['RENDER_GIT_COMMIT', 'b'.repeat(40)], ['JEMLIO_STAGING_ONLY', 'false'],
        ['NOVA_CAPTURE_ENABLED', 'true'], ['NOVA_CAPTURE_WORKER_ENABLED', 'true'], ['JEMLIO_SETUP_SCHEMA', 'true']]) {
        assert.throws(() => configuration({ ...base, [key]: value }, at));
      }
      for (const until of ['', new Date(at - 1).toISOString(), new Date(at + 31 * 60000).toISOString()]) {
        assert.throws(() => configuration({ ...base, JEMLIO_SITE_TASK_UNTIL: until }, at));
      }
    });
    await test('publishing accepts only the existing Netlify deployment proxy, without credentials or alternate hosts', () => {
      assert.equal(configuration(base, at).task, 'publish-marketing');
      for (const url of ['https://attacker.invalid/proxy/test', 'https://netlify-mcp.netlify.app/elsewhere',
        'http://netlify-mcp.netlify.app/proxy/test', base.JEMLIO_NETLIFY_DEPLOY_PROXY + '?extra=x',
        'https://user:password@netlify-mcp.netlify.app/proxy/test', 'https://netlify-mcp.netlify.app:444/proxy/test']) {
        assert.throws(() => configuration({ ...base, JEMLIO_NETLIFY_DEPLOY_PROXY: url }, at));
      }
    });
    await test('the publish bundle contains only ten allowlisted public assets and a static publish config', () => {
      const directory = path.join(temp, 'bundle'); fs.mkdirSync(directory);
      prepareBundle(root, directory);
      assert.equal(FILES.length, 10);
      assert.deepEqual(allFiles(directory), ['netlify.toml', ...FILES.map(file => path.join('public', 'marketing', file))].sort());
      assert.match(fs.readFileSync(path.join(directory, 'public/marketing/index.html'), 'utf8'), /data-netlify="true"/);
      assert.equal(fs.existsSync(path.join(directory, '.git')), false);
      assert.equal(fs.existsSync(path.join(directory, 'lib')), false);
    });
    await test('the relative static definition matches visible fields, limits, choices, consent and canonical destination', () => {
      const visible = new JSDOM(fs.readFileSync(path.join(root, 'public/marketing/index.html'), 'utf8'));
      const blueprint = new JSDOM(fs.readFileSync(path.join(root, 'public/marketing/form-definition.html'), 'utf8'));
      try {
        const form = visible.window.document.querySelector('#contact-form');
        const definition = blueprint.window.document.querySelector('form');
        assert.equal(definition.name, form.name);
        assert.equal(definition.method, form.method);
        assert.equal(definition.getAttribute('action'), '/demo-requested');
        assert.equal(new URL(definition.getAttribute('action'), 'https://www.jemlio.com').href, form.getAttribute('action'));
        assert.equal(definition.hidden, true);
        assert.equal(definition.getAttribute('data-netlify'), 'true');
        assert.equal(definition.getAttribute('netlify-honeypot'), 'bot-field');
        const fields = node => [...node.elements].filter(item => item.name).map(item => ({
          name: item.name, tag: item.tagName, type: item.type, required: item.required,
          maxlength: item.getAttribute('maxlength'),
          value: ['hidden', 'checkbox'].includes(item.type) ? item.value : null,
          choices: item.tagName === 'SELECT' ? [...item.options].map(option => option.value) : []
        })).sort((a, b) => a.name.localeCompare(b.name));
        assert.deepEqual(fields(definition), fields(form));
        assert.match(blueprint.window.document.querySelector('meta[name="robots"]').content, /noindex/);
      } finally { visible.window.close(); blueprint.window.close(); }
    });
    await test('a mocked publish uses only the official scoped command and cannot retry its attempted session', async () => {
      let calls = 0;
      const options = { env: base, now: () => at, root, tempRoot: temp, spawnImpl(command, args, config) {
        calls++;
        assert.equal(command, 'npx');
        assert.deepEqual(args, ['-y', '@netlify/mcp@latest', '--site-id', '8fddfa2f-2643-4bb9-b40f-39d5216ce675', '--proxy-path', base.JEMLIO_NETLIFY_DEPLOY_PROXY]);
        assert.equal(config.env.SECRET_TEST_VALUE, undefined);
        assert.equal(config.env.JEMLIO_NETLIFY_DEPLOY_PROXY, undefined);
        assert.equal(config.env.NOVA_CAPTURE_ENABLED, undefined);
        assert.notEqual(config.cwd, root);
        assert.equal(config.timeout, 240000);
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        queueMicrotask(() => { child.stdout.emit('data', Buffer.from(base.JEMLIO_NETLIFY_DEPLOY_PROXY)); child.emit('close', 0); });
        return child;
      } };
      const first = await runSiteTask(options);
      assert.equal(first.state, 'command-completed'); assert.equal(first.deploymentVerified, false);
      assert.equal((await runSiteTask(options)).state, 'already-attempted'); assert.equal(calls, 1);
      assert.doesNotMatch(JSON.stringify(first), /synthetic-test-only|must-not-leave-parent/);
    });
    await test('the form smoke test uses only the owner mailbox, a fixed destination and one explicit marker', async () => {
      let calls = 0;
      const env = { ...base, JEMLIO_SITE_TASK: 'form-smoke', JEMLIO_FORM_TEST_ID: '11111111-1111-4111-8111-111111111111' };
      assert.throws(() => configuration({ ...env, JEMLIO_FORM_TEST_ID: 'unknown' }, at));
      const options = { env, now: () => at, root, tempRoot: temp, fetchImpl: async (url, init) => {
        calls++; assert.equal(url, 'https://www.jemlio.com/demo-requested');
        assert.equal(init.redirect, 'manual');
        const body = new URLSearchParams(init.body);
        assert.equal(body.get('email'), 'hei@jemlio.com');
        assert.equal(body.get('form-name'), 'jemlio-demo-request');
        assert.match(body.get('company'), /DO NOT CONTACT/);
        assert.match(body.get('message'), /11111111-1111-4111-8111-111111111111/);
        return new Response('Synthetic acknowledgement only');
      } };
      const value = await runSiteTask(options);
      assert.equal(value.httpStatus, 200); assert.equal(value.storageVerified, false);
      assert.equal((await runSiteTask(options)).state, 'already-attempted'); assert.equal(calls, 1);
    });
    await test('a failing publisher stays a failed operation, not a claimed successful deploy', async () => {
      const env = { ...base, JEMLIO_NETLIFY_DEPLOY_PROXY: 'https://netlify-mcp.netlify.app/proxy/synthetic-failure-only' };
      const value = await runSiteTask({ env, now: () => at, root, tempRoot: temp, spawnImpl() {
        const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
        queueMicrotask(() => child.emit('close', 1)); return child;
      } });
      assert.equal(value.state, 'command-failed'); assert.equal(value.deploymentVerified, false);
    });
    console.log(`Staging site task: ${checks} grouped checks passed. Publishing and external form submissions mocked.`);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
