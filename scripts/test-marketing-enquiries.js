'use strict';
const assert = require('node:assert/strict');
const express = require('express');
const { createMarketingEnquiryRouter, validateWebhookUrl, validateEnquiry, CONSENT_TEXT } = require('../lib/marketing-enquiries');
const { seed } = require('./staging-enquiry-setup.cjs');
const origin = 'https://www.jemlio.com';
const target = 'https://hooks.airtable.com/workflows/v1/genericWebhook/appExample0000000/wflExample0000000/wtrExample';
const good = { name: ' Kari Test ', email: ' NOBODY@EXAMPLE.INVALID ', company: 'Testbedrift',
  industry: 'Trafikkskole', message: ' Vanlige spørsmål om priser. ', 'contact-request': CONSENT_TEXT };
const ack = () => new Response(JSON.stringify({ success: true }), { status: 200 });
let checks = 0;
async function test(name, run) { await run(); console.log(`ok ${++checks} - ${name}`); }
async function withServer(options, run) {
  const app = express(); app.set('trust proxy', 1); app.use(express.json({ limit: '64kb' }));
  app.use('/api/marketing-enquiry', createMarketingEnquiryRouter(options));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}/api/marketing-enquiry`); }
  finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
const post = (url, body = good, headers = {}) => fetch(url, { method: 'POST', redirect: 'manual',
  headers: { Origin: origin, 'Content-Type': 'application/json', Accept: 'application/json', ...headers },
  body: JSON.stringify(body) });

(async () => {
  await test('destination is an exact HTTPS Airtable webhook with no credentials, query, port or redirect target', () => {
    assert.equal(validateWebhookUrl(target), target);
    for (const value of [null, {}, target.replace('https:', 'http:'), target + '?token=x', target + '#x',
      target.replace('hooks.airtable.com', 'hooks.airtable.com.attacker.invalid'),
      target.replace('hooks.airtable.com', 'user:secret@hooks.airtable.com'),
      target.replace('hooks.airtable.com', 'hooks.airtable.com:444'), 'https://hooks.airtable.com/other']) {
      assert.equal(validateWebhookUrl(value), null);
    }
  });
  await test('explicit consent only; negations and arbitrary contact text are rejected', () => {
    for (const value of [false, null, undefined, [], {}, ['on'], 'false', 'ikke kontakt meg',
      'Jeg vil ikke bli kontaktet', 'kontakt', 'on please', 1]) {
      assert.equal(validateEnquiry({ ...good, 'contact-request': value }), null);
    }
    for (const value of [true, 'true', 'on', '1', CONSENT_TEXT]) {
      assert.ok(validateEnquiry({ ...good, 'contact-request': value }));
    }
  });
  await test('malformed scalar fields and overlength contact data are rejected rather than silently truncated', () => {
    for (const body of [null, [], 'text', 7]) assert.equal(validateEnquiry(body), null);
    for (const field of ['name', 'email', 'company', 'industry', 'message', 'bot-field']) {
      for (const value of [{ text: 'x' }, ['x'], null, true]) assert.equal(validateEnquiry({ ...good, [field]: value }), null);
    }
    for (const [field, length] of [['name', 121], ['email', 255], ['company', 301], ['industry', 101], ['message', 1001]]) {
      assert.equal(validateEnquiry({ ...good, [field]: 'a'.repeat(length) }), null);
    }
    for (const value of ['not-an-email', 'a b@example.invalid', 'a@example.invalid\u0000']) {
      assert.equal(validateEnquiry({ ...good, email: value }), null);
    }
  });
  await test('normalization keeps Unicode and separates text company names from safe website URLs', () => {
    const value = validateEnquiry({ ...good, name: ' Åse Łukasz ' });
    assert.equal(value.name, 'Åse Łukasz'); assert.equal(value.email, 'nobody@example.invalid');
    assert.equal(value.website, ''); assert.equal(value.notes, 'Vanlige spørsmål om priser.');
    assert.equal(validateEnquiry({ ...good, company: 'https://example.invalid' }).website, 'https://example.invalid/');
    assert.equal(validateEnquiry({ ...good, company: 'https://name:password@example.invalid' }).website, '');
  });
  await test('webhook URL alone does not activate intake; readiness never asserts verified storage', async () => {
    let calls = 0;
    await withServer({ webhookUrl: target, enabled: false, fetchImpl: async () => { calls++; return ack(); } }, async url => {
      assert.equal((await post(url)).status, 503);
      assert.deepEqual(await (await fetch(url + '/status')).json(), { enabled: false, capability: 'webhook-forwarding', storageVerified: false });
    });
    assert.equal(calls, 0);
  });
  await test('valid requests use the mapped payload but HTTP acceptance is not a saved-lead receipt', async () => {
    const sent = [];
    await withServer({ webhookUrl: target, enabled: true, randomUUID: () => '11111111-1111-4111-8111-111111111111',
      fetchImpl: async (url, options) => { sent.push({ url, options }); return ack(); } }, async url => {
      const response = await post(url);
      assert.equal(response.status, 202);
      assert.deepEqual(await response.json(), { accepted: true, persisted: false, requestId: '11111111-1111-4111-8111-111111111111' });
      assert.equal(response.headers.get('cache-control'), 'no-store');
    });
    assert.equal(sent.length, 1); assert.equal(sent[0].url, target);
    assert.equal(sent[0].options.redirect, 'error');
    const body = JSON.parse(sent[0].options.body);
    assert.equal(body.setupOnly, false); assert.equal(body.consent, true);
    assert.equal(body.source, 'Jemlio website'); assert.equal(body.email, 'nobody@example.invalid');
    assert.equal(body.receipt, '11111111-1111-4111-8111-111111111111');
    assert.equal(Object.hasOwn(body, 'transcript'), false); assert.equal(Object.hasOwn(body, 'ip'), false);
  });
  await test('missing, unrelated and null origins cannot submit; exact same-site referer fallback works', async () => {
    let calls = 0;
    await withServer({ webhookUrl: target, enabled: true, fetchImpl: async () => { calls++; return ack(); } }, async url => {
      for (const value of ['https://attacker.invalid', 'null', 'https://www.jemlio.com.attacker.invalid']) {
        const response = await post(url, good, { Origin: value }); assert.equal(response.status, 403);
        assert.equal(response.headers.get('access-control-allow-origin'), null);
      }
      assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(good) })).status, 403);
      assert.equal((await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Referer: origin + '/contact' }, body: JSON.stringify(good) })).status, 202);
    }); assert.equal(calls, 1);
  });
  await test('honeypot submissions never reach the CRM', async () => {
    let calls = 0;
    await withServer({ webhookUrl: target, enabled: true, fetchImpl: async () => { calls++; return ack(); } }, async url => {
      const response = await post(url, { ...good, 'bot-field': 'spam' }); assert.equal(response.status, 202);
      assert.equal((await response.json()).persisted, false);
    }); assert.equal(calls, 0);
  });
  await test('empty, malformed, negative and oversized acknowledgements never claim successful forwarding', async () => {
    const responses = [() => new Response(null, { status: 204 }), () => new Response('not json'),
      () => new Response('{"success":false}'), () => new Response('{"success":"true"}'),
      () => new Response('null'), () => new Response('x'.repeat(5000)), () => new Response('{}', { status: 503 })];
    for (const make of responses) await withServer({ webhookUrl: target, enabled: true, fetchImpl: async () => make() }, async url => {
      const response = await post(url); assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'enquiry_unconfirmed' });
    });
  });
  await test('network failure is uncertain and never retried or logged to the response', async () => {
    let calls = 0;
    await withServer({ webhookUrl: target, enabled: true, fetchImpl: async () => { calls++; throw new Error('PRIVATE_WEBHOOK_URL_AND_BODY'); } }, async url => {
      const response = await post(url); assert.equal(response.status, 503);
      assert.doesNotMatch(await response.text(), /PRIVATE|hooks\.airtable/);
    }); assert.equal(calls, 1);
  });
  await test('rate limits expire and Retry-After reflects the remaining window', async () => {
    let at = 1000000;
    await withServer({ webhookUrl: target, enabled: true, now: () => at, fetchImpl: async () => ack() }, async url => {
      for (let i = 0; i < 6; i++) assert.equal((await post(url)).status, 202);
      at += 1000;
      const response = await post(url); assert.equal(response.status, 429); assert.equal(response.headers.get('retry-after'), '599');
      at += 600000; assert.equal((await post(url)).status, 202);
    });
  });
  await test('no-JavaScript users get truthful HTML without contact data or a false success redirect', async () => {
    await withServer({ webhookUrl: target, enabled: true, fetchImpl: async () => ack() }, async url => {
      const response = await fetch(url, { method: 'POST', redirect: 'manual', headers: {
        Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'text/html'
      }, body: new URLSearchParams(good).toString() });
      assert.equal(response.status, 202); assert.equal(response.headers.get('location'), null);
      const html = await response.text(); assert.match(html, /bekrefter ikke at den er lagret/);
      assert.doesNotMatch(html, /NOBODY|nobody|hooks\.airtable/);
    });
  });
  await test('duplicate URL-encoded consent fields are rejected as arrays', async () => {
    await withServer({ webhookUrl: target, enabled: true, fetchImpl: async () => { throw new Error('must not call'); } }, async url => {
      const body = new URLSearchParams(good); body.append('contact-request', 'ikke kontakt meg');
      assert.equal((await fetch(url, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() })).status, 400);
    });
  });
  await test('staging seed is explicitly isolated, time-limited and synthetic', async () => {
    const at = Date.parse('2026-09-21T20:00:00Z'); let calls = 0;
    const env = { JEMLIO_STAGING_ONLY: 'true', NOVA_CAPTURE_ENABLED: 'false', NOVA_CAPTURE_WORKER_ENABLED: 'false',
      JEMLIO_SETUP_SCHEMA: 'true', JEMLIO_SETUP_VALID_UNTIL: new Date(at + 60000).toISOString(), JEMLIO_SETUP_WEBHOOK_URL: target };
    await assert.rejects(seed({ env: {}, now: () => at }), /staging_only/);
    await assert.rejects(seed({ env: { ...env, NOVA_CAPTURE_ENABLED: 'true' }, now: () => at }), /disabled/);
    await assert.rejects(seed({ env: { ...env, JEMLIO_SETUP_VALID_UNTIL: new Date(at - 1).toISOString() }, now: () => at }), /window/);
    assert.equal(await seed({ env: { ...env, JEMLIO_SETUP_SCHEMA: 'false' }, now: () => at }), 'disabled');
    assert.equal(await seed({ env, now: () => at, fetchImpl: async (url, init) => {
      calls++; assert.equal(url, target); assert.equal(init.redirect, 'error');
      const data = JSON.parse(init.body); assert.equal(data.setupOnly, true); assert.equal(data.email, 'nobody@example.invalid');
      return ack();
    } }), 'accepted');
    assert.equal(calls, 1);
  });
  console.log(`Marketing enquiry safety: ${checks} grouped checks passed. External calls mocked; no real contacts submitted.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
