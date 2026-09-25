'use strict';

// Execute the shipped HTML + browser code without contacting Netlify, sending
// mail, or using real customer data. These DOM checks deliberately do not claim
// that a Netlify form is enabled; production must verify form detection + POST.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');

const html = fs.readFileSync(path.join(__dirname, '../public/marketing/index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/marketing/site.js'), 'utf8');
const confirmation = fs.readFileSync(path.join(__dirname, '../public/marketing/demo-requested.html'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
let checks = 0;
async function test(name, run) { await run(); console.log(`ok ${++checks} - ${name}`); }

function harness({ url = 'https://www.jemlio.com/', online = true, clipboard = 'success', answer = true, onChat } = {}) {
  const calls = [], copied = [], timers = new Map(), errors = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', error => errors.push(error));
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const { window } = dom;
  const document = window.document;
  window.matchMedia = () => ({ matches: true });
  window.HTMLElement.prototype.scrollIntoView = () => {};
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: online });
  Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async text => {
    if (clipboard === 'failure') throw new Error('Not allowed');
    copied.push(text);
  } } });
  let timerId = 0;
  window.setTimeout = (run, delay) => { timers.set(++timerId, { run, delay }); return timerId; };
  window.clearTimeout = id => timers.delete(id);
  window.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (url !== '/chat') throw new Error('Contact must use native POST, never AJAX');
    if (onChat) return onChat(JSON.parse(options.body), options);
    if (!answer) throw new Error('Chat offline');
    return { ok: true, json: async () => ({ reply: 'Du finner riktig informasjon her.', suggestions: ['Hva koster det?'] }) };
  };
  window.eval(script);
  const get = selector => document.querySelector(selector);
  const fill = () => {
    get('#contact-name').value = 'Kari Test';
    get('#contact-email').value = 'kari@example.com';
    get('#contact-company').value = 'Testbedrift';
    get('#contact-industry').value = 'Optiker';
    get('#contact-message').value = 'Spørsmål om åpningstider & linser';
    get('#contact-acknowledgment').checked = true;
    get('#contact-form').dispatchEvent(new window.Event('input', { bubbles: true }));
  };
  const submit = () => {
    const event = new window.Event('submit', { bubbles: true, cancelable: true });
    get('#contact-form').dispatchEvent(event);
    return event;
  };
  const ask = async () => {
    get('#demo-input').value = 'Private test question kari@example.com';
    get('#demo-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
    await settle();
  };
  const finish = () => { assert.deepEqual(errors, [], 'no uncaught DOM errors'); window.close(); };
  return { window, document, calls, copied, timers, get, fill, submit, ask, finish };
}

(async () => {
  await test('native form has canonical POST, Netlify registration, honeypot and accessible inputs', () => {
    const dom = new JSDOM(html);
    const form = dom.window.document.querySelector('#contact-form');
    assert.equal(form.method, 'post');
    assert.equal(form.getAttribute('action'), 'https://www.jemlio.com/demo-requested');
    assert.equal(form.getAttribute('data-netlify'), 'true');
    assert.equal(form.elements['form-name'].value, form.name);
    assert.equal(form.getAttribute('netlify-honeypot'), 'bot-field');
    assert.ok(form.elements['bot-field'].closest('[hidden]'));
    for (const field of [...form.elements].filter(el => el.matches('input:not([type=hidden]),textarea,select') && !el.closest('[hidden]'))) {
      assert.ok(field.labels.length, `${field.id} has an associated visible label`);
    }
    assert.equal(form.elements['contact-request'].required, true);
    assert.equal(form.getAttribute('aria-describedby'), 'contact-note');
    dom.window.close();
  });

  await test('a valid request proceeds as exactly one native POST without an invented AJAX receipt', () => {
    const h = harness(); h.fill();
    assert.equal(h.submit().defaultPrevented, false);
    assert.equal(h.get('#contact-submit').disabled, true);
    assert.equal(h.get('#contact-form').getAttribute('aria-busy'), 'true');
    assert.match(h.get('#contact-status').textContent, /Sender forespørselen/);
    assert.doesNotMatch(h.get('#contact-status').textContent, /mottatt|kommet frem/);
    const payload = new h.window.FormData(h.get('#contact-form'));
    assert.equal(payload.get('email'), 'kari@example.com');
    assert.equal(payload.get('industry'), 'Optiker');
    assert.equal(payload.get('contact-request'), 'Jeg ber Jemlio kontakte meg om min gratis mini-demo');
    assert.equal(payload.get('message'), 'Spørsmål om åpningstider & linser');
    assert.deepEqual(h.calls, []);
    h.finish();
  });

  await test('double click cannot submit a second native request', () => {
    const h = harness(); h.fill();
    assert.equal(h.submit().defaultPrevented, false);
    assert.equal(h.submit().defaultPrevented, true);
    assert.equal([...h.timers.values()].filter(timer => timer.delay === 20000).length, 1);
    h.finish();
  });

  await test('missing acknowledgment and whitespace-only required fields block submission', () => {
    const h = harness(); h.fill();
    h.get('#contact-acknowledgment').checked = false;
    assert.equal(h.submit().defaultPrevented, true);
    assert.equal(h.get('#contact-submit').disabled, false);
    h.get('#contact-acknowledgment').checked = true;
    h.get('#contact-company').value = '    ';
    assert.equal(h.submit().defaultPrevented, true);
    assert.equal(h.get('#contact-company').value, '');
    h.finish();
  });

  await test('offline submission preserves all details and offers email without posting', () => {
    const h = harness({ online: false }); h.fill();
    assert.equal(h.submit().defaultPrevented, true);
    assert.equal(h.get('#contact-email').value, 'kari@example.com');
    assert.equal(h.get('#contact-submit').disabled, false);
    assert.equal(h.get('#contact-fallback').open, true);
    assert.match(h.get('#contact-status').textContent, /Ingen innsending er startet/);
    assert.deepEqual(h.calls, []);
    h.finish();
  });

  await test('a stalled navigation becomes uncertain, keeps details and never retries', () => {
    const h = harness(); h.fill(); h.submit();
    const timer = [...h.timers.values()].find(timer => timer.delay === 20000);
    timer.run();
    assert.match(h.get('#contact-status').textContent, /kan ikke bekrefte/);
    assert.match(h.get('#contact-status').textContent, /Ikke send skjemaet på nytt/);
    assert.equal(h.get('#contact-name').value, 'Kari Test');
    assert.equal(h.get('#contact-fallback').open, true);
    assert.equal(h.submit().defaultPrevented, true);
    assert.deepEqual(h.calls, []);
    h.finish();
  });

  await test('back-forward cache restores the form without a stuck pending button or automatic resubmit', () => {
    const h = harness(); h.fill(); h.submit();
    const restored = new h.window.Event('pageshow');
    Object.defineProperty(restored, 'persisted', { value: true });
    h.window.dispatchEvent(restored);
    assert.equal(h.get('#contact-submit').disabled, false);
    assert.equal(h.get('#contact-form').getAttribute('aria-busy'), 'false');
    assert.equal(h.get('#contact-email').value, 'kari@example.com');
    assert.match(h.get('#contact-status').textContent, /ikke sende på nytt/);
    assert.equal(h.timers.size, 0);
    assert.deepEqual(h.calls, []);
    h.finish();
  });

  await test('Render and localhost mirrors retain a canonical native action rather than POSTing to themselves', () => {
    for (const url of ['https://nova-dynamics-bot-server.onrender.com/jemlio', 'http://localhost:3000/jemlio']) {
      const h = harness({ url }); h.fill();
      assert.equal(h.get('#contact-form').action, 'https://www.jemlio.com/demo-requested');
      assert.equal(h.submit().defaultPrevented, false);
      assert.deepEqual(h.calls, []);
      h.finish();
    }
  });

  await test('email fallback preserves details and clipboard success does not claim delivery', async () => {
    const h = harness(); h.fill();
    const href = h.get('#contact-email-draft').href;
    assert.match(href, /^mailto:hei@jemlio\.com\?/);
    assert.match(decodeURIComponent(href), /kari@example.com/);
    assert.match(decodeURIComponent(href), /Spørsmål om åpningstider & linser/);
    h.get('#contact-copy').click(); await settle();
    assert.equal(h.copied.length, 1);
    assert.match(h.copied[0], /Bransje: Optiker/);
    assert.match(h.get('#contact-copy-status').textContent, /Kopieringen sender ingenting/);
    assert.deepEqual(h.calls, []);
    h.finish();
  });

  await test('denied clipboard permission exposes selected text for manual copying', async () => {
    const h = harness({ clipboard: 'failure' }); h.fill();
    h.get('#contact-copy').click(); await settle();
    assert.equal(h.get('#contact-copy-manual').hidden, false);
    assert.equal(h.document.activeElement.id, 'contact-copy-text');
    assert.match(h.get('#contact-copy-text').value, /kari@example.com/);
    assert.ok(h.get('#contact-copy-text').selectionEnd > 0);
    assert.match(h.get('#contact-copy-status').textContent, /Automatisk kopiering er ikke tilgjengelig/);
    h.finish();
  });

  await test('a useful demo answer reveals a CTA that copies only industry, never chat or personal data', async () => {
    const h = harness(); h.fill();
    const originalMessage = h.get('#contact-message').value;
    assert.equal(h.get('#demo-next').hidden, true);
    await h.ask();
    assert.equal(h.get('#demo-next').hidden, false);
    h.get('#demo-tailor').click();
    assert.equal(h.get('#contact-industry').value, 'Trafikkskole');
    assert.equal(h.get('#contact-message').value, originalMessage);
    assert.equal(h.get('#contact-email').value, 'kari@example.com');
    assert.equal(h.document.activeElement.id, 'contact-company');
    assert.doesNotMatch(decodeURIComponent(h.get('#contact-email-draft').href), /Private test question/);
    h.get('#tab-optician').click();
    assert.equal(h.get('#demo-next').hidden, true);
    await h.ask(); h.get('#demo-tailor').click();
    assert.equal(h.get('#contact-industry').value, 'Optiker');
    assert.equal(h.window.localStorage.length, 0);
    assert.equal(h.window.sessionStorage.length, 0);
    h.finish();
  });

  await test('failed demo answers do not reveal a success-driven CTA', async () => {
    const h = harness({ answer: false }); await h.ask();
    assert.equal(h.get('#demo-next').hidden, true);
    assert.match(h.get('#demo-messages').textContent, /ikke hentet svaret/);
    h.finish();
  });

  await test('all demo tabs explain the real product workflow and render its links without moving chat data', async () => {
    const { answer } = require('../clients/jemlio/answer');
    const h = harness({ onChat: ({ client, message }) => ({ ok: true, json: async () => answer(client, message) }) });
    for (const [tab, client] of [['driving', 'jemlio-driving-demo'], ['optician', 'jemlio-optician-demo'], ['workflow', 'jemlio']]) {
      h.get('#tab-' + tab).click();
      h.get('#demo-input').value = 'Hva skjer etter henvendelsen?';
      h.get('#demo-form').requestSubmit(); await settle();
      assert.equal(JSON.parse(h.calls.at(-1).options.body).client, client);
      const link = h.get('#demo-messages a[href="https://nova-dynamics-bot-server.onrender.com/workspace-demo"]');
      assert.ok(link); assert.equal(link.target, '_blank');
      assert.match(link.rel, /noopener/);
      assert.equal(h.get('#demo-panel').getAttribute('aria-labelledby'), 'tab-' + tab);
    }
    assert.equal(h.get('#demo-badge').textContent, 'JEMLIO');
    assert.equal(h.get('#demo-note').textContent.includes('Ingen meldinger sendes'), true);
    h.fill();
    h.get('#demo-tailor').click();
    assert.equal(h.get('#contact-industry').value, 'Optiker', 'product tab must not invent a driving-school category');
    assert.equal(h.get('#contact-message').value, 'Spørsmål om åpningstider & linser');
    assert.equal(h.get('#demo-next').hidden, false);
    assert.equal(h.document.querySelectorAll('.demo-journey a').length, 3);
    for (const link of h.document.querySelectorAll('.demo-journey a')) {
      assert.equal(new URL(link.href).search, '');
      assert.equal(link.target, '_blank');
    }
    h.get('#tab-workflow').dispatchEvent(new h.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(h.get('#tab-driving').getAttribute('aria-selected'), 'true');
    assert.equal(h.get('#demo-badge').textContent, 'EKSEMPEL');
    assert.equal(h.window.localStorage.length, 0);
    h.finish();
  });

  await test('the native success page is accessible and does not assert a receipt for a direct visit', () => {
    const dom = new JSDOM(confirmation, { url: 'https://www.jemlio.com/demo-requested' });
    const document = dom.window.document;
    assert.equal(document.documentElement.lang, 'nb');
    assert.match(document.title, /demoforespørsel/);
    assert.equal(document.querySelectorAll('h1').length, 1);
    assert.equal(document.querySelector('main').getAttribute('aria-labelledby'), 'request-title');
    assert.ok(document.querySelector('.skip-link[href="#main"]'));
    assert.match(document.body.textContent, /åpnet denne siden direkte, er det ikke sendt/);
    assert.doesNotMatch(document.body.textContent, /garantert|e-posten er levert|e-posten er lest/i);
    assert.equal(document.querySelector('form'), null);
    dom.window.close();
  });

  await test('website retries preserve a different draft and expired buttons cannot send', async () => {
    let attempt = 0;
    const h = harness({ onChat: () => {
      if (++attempt === 1) throw new Error('Offline');
      return { ok: true, json: async () => ({ reply: 'Et nyttig svar.' }) };
    } });
    await h.ask();
    const oldRetry = h.get('.chat-retry');
    h.get('#demo-input').value = 'Mitt neste spørsmål';
    oldRetry.click(); await settle();
    assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].options.body, h.calls[1].options.body);
    assert.equal(h.get('#demo-input').value, 'Mitt neste spørsmål');
    oldRetry.click(); await settle();
    assert.equal(h.calls.length, 2);
    h.finish();
  });

  await test('offline website chat preserves the draft and performs no automatic request on reconnect', async () => {
    const h = harness({ online: false }); await h.ask();
    assert.equal(h.calls.length, 0);
    assert.match(h.get('#demo-input').value, /Private test question/);
    Object.defineProperty(h.window.navigator, 'onLine', { value: true });
    h.window.dispatchEvent(new h.window.Event('online')); await settle();
    assert.equal(h.calls.length, 0);
    h.get('.chat-retry').click(); await settle();
    assert.equal(h.calls.length, 1);
    h.finish();
  });

  await test('website suggestions preserve drafts and composition waits for completion', async () => {
    const h = harness();
    h.get('#demo-input').value = 'Min kladd'; h.get('#demo-suggestions button').click(); await settle();
    assert.equal(h.get('#demo-input').value, 'Min kladd');
    h.get('#demo-input').dispatchEvent(new h.window.Event('compositionstart'));
    h.get('#demo-form').requestSubmit(); await settle();
    assert.equal(h.calls.length, 1);
    h.get('#demo-input').dispatchEvent(new h.window.Event('compositionend'));
    h.get('#demo-form').requestSubmit(); await settle();
    assert.equal(h.calls.length, 2);
    assert.equal(JSON.parse(h.calls[1].options.body).message, 'Min kladd');
    h.finish();
  });

  await test('switching demos cancels the pending timer and suppresses a late answer', async () => {
    let complete, signal;
    const h = harness({ onChat: (_payload, options) => { signal = options.signal; return new Promise(resolve => { complete = resolve; }); } });
    await h.ask();
    h.get('#tab-optician').click();
    assert.equal(signal.aborted, true);
    assert.equal(h.timers.size, 0);
    complete({ ok: true, json: async () => ({ reply: 'Stale driving answer.' }) }); await settle();
    assert.doesNotMatch(h.get('#demo-messages').textContent, /Stale driving answer/);
    assert.match(h.get('#demo-messages').textContent, /fiktiv optiker/);
    assert.equal(h.get('#demo-next').hidden, true);
    h.finish();
  });

  await test('support reset clears pending messages and drafts without submitting anything else', async () => {
    let complete;
    const h = harness({ onChat: () => new Promise(resolve => { complete = resolve; }) });
    h.get('#chat-launcher').click();
    h.get('#support-input').value = 'Hei'; h.get('#support-form').requestSubmit(); await settle();
    h.get('#support-input').value = 'En usendt kladd'; h.get('#support-reset').click();
    assert.equal(h.get('#support-input').value, '');
    assert.equal(h.document.activeElement.id, 'support-input');
    assert.equal(h.timers.size, 0);
    complete({ ok: true, json: async () => ({ reply: 'Stale support answer.' }) }); await settle();
    assert.doesNotMatch(h.get('#support-messages').textContent, /Stale support answer/);
    assert.equal(h.calls.length, 1);
    assert.equal(h.get('#support-form button').disabled, false);
    h.finish();
  });

  await test('uncertain answers do not reveal a success CTA and rate limits have their own recovery', async () => {
    const uncertain = harness({ onChat: () => ({ ok: true, json: async () => ({ reply: 'Ukjent spørsmål.', unsure: true }) }) });
    await uncertain.ask(); assert.equal(uncertain.get('#demo-next').hidden, true); uncertain.finish();
    const limited = harness({ onChat: () => ({ ok: false, status: 429 }) });
    await limited.ask(); assert.match(limited.get('#demo-messages').textContent, /mange spørsmål/);
    assert.ok(limited.get('.chat-retry')); assert.equal(limited.get('#demo-next').hidden, true); limited.finish();
  });

  console.log(`Marketing UI: ${checks} checks passed. Native Netlify processing must be verified separately on the deployed site.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
