'use strict';
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');
const html = readFileSync(join(__dirname, '../public/reply/index.html'), 'utf8');
const app = readFileSync(join(__dirname, '../public/reply/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const token = 'a'.repeat(43);
const snapshot = (revision = '1', messages = []) => ({ businessName: 'Fiktiv bedrift', subject: 'Fiktiv henvendelse', messages, revision, expiresAt: new Date(Date.now() + 86400000).toISOString() });
const result = data => ({ ok: true, status: 200, json: async () => data });
const rejection = (error, status = 409) => ({ ok: false, status, json: async () => ({ error }) });
function build(url, fetch) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only' });
  dom.window.fetch = fetch;
  dom.window.eval(app);
  return dom;
}
function submit(window, value) {
  if (value !== undefined) window.document.getElementById('reply-message').value = value;
  window.document.getElementById('reply-form').dispatchEvent(new window.Event('submit', { cancelable: true, bubbles: true }));
}
async function main() {
  let calls = 0;
  const demo = build('https://example.invalid/reply-demo', async () => { calls++; throw new Error('Demo must not fetch'); });
  const d = demo.window.document;
  assert.equal(d.getElementById('demo-notice').hidden, false);
  assert.equal(d.querySelectorAll('.message').length, 2);
  submit(demo.window, '  '); await tick();
  assert.match(d.getElementById('error').textContent, /mellom 1 og 2000/);
  submit(demo.window, 'x'.repeat(2001)); await tick();
  assert.equal(d.querySelectorAll('.message').length, 2);
  submit(demo.window, '<img src=x onerror=alert(1)>'); await tick();
  assert.equal(d.querySelectorAll('.message').length, 3);
  assert.equal(d.querySelectorAll('#messages img').length, 0);
  assert.match(d.getElementById('messages').textContent, /<img/);
  assert.equal(d.getElementById('reply-message').value, '');
  d.getElementById('reset').click();
  assert.equal(d.querySelectorAll('.message').length, 2);
  assert.equal(calls, 0);
  assert.equal(demo.window.localStorage.length, 0);
  assert.equal(demo.window.sessionStorage.length, 0);
  demo.window.close();
  console.log('ok - fake reply demo validates, escapes, clears and resets entirely in memory');

  const requests = [];
  let attempts = 0;
  const live = build('https://example.invalid/reply/#' + token, async (url, opts) => {
    requests.push({ url, opts });
    if (url.endsWith('/read')) return result(snapshot());
    attempts++;
    if (attempts === 1) throw new TypeError('Lost acknowledgement');
    if (attempts === 2) return rejection('rate_limited', 429);
    const payload = JSON.parse(opts.body);
    return result({ accepted: true, duplicate: true, conversation: snapshot('2', [{ id: payload.submissionId, direction: 'inbound', body: payload.message, createdAt: new Date().toISOString() }]) });
  });
  const w = live.window, ld = w.document;
  assert.equal(w.location.hash, '');
  await tick();
  assert.equal(requests[0].url, '/api/replies/read');
  assert.deepEqual(JSON.parse(requests[0].opts.body), { token });
  assert.equal(requests[0].opts.credentials, 'omit');
  assert.equal(requests[0].opts.cache, 'no-store');
  assert.equal(requests[0].opts.referrerPolicy, 'no-referrer');
  submit(w, 'Min fiktive bil er fra 2022.'); await tick();
  assert.equal(ld.getElementById('reply-message').readOnly, true);
  assert.equal(ld.getElementById('send').disabled, true);
  assert.equal(ld.getElementById('retry').hidden, false);
  assert.equal(ld.getElementById('refresh').hidden, true);
  assert.match(ld.getElementById('error').textContent, /ikke bekrefte/);
  submit(w); await tick();
  assert.equal(attempts, 1);
  ld.getElementById('retry').click(); await tick();
  assert.equal(ld.getElementById('reply-message').readOnly, true);
  assert.equal(ld.getElementById('retry').hidden, false);
  ld.getElementById('retry').click(); await tick();
  const sends = requests.filter(request => request.url.endsWith('/respond'));
  assert.equal(sends.length, 3);
  assert.equal(sends[0].opts.body, sends[1].opts.body);
  assert.equal(sends[1].opts.body, sends[2].opts.body);
  assert.equal(JSON.parse(sends[0].opts.body).revision, '1');
  assert.match(JSON.parse(sends[0].opts.body).submissionId, /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
  assert.equal(ld.getElementById('reply-message').value, '');
  assert.equal(ld.getElementById('reply-message').readOnly, false);
  assert.equal(ld.getElementById('retry').hidden, true);
  assert.equal(ld.querySelectorAll('.message').length, 1);
  assert.equal(ld.body.textContent.includes(token), false);
  assert.equal(w.localStorage.length, 0);
  assert.equal(w.sessionStorage.length, 0);
  assert.equal(ld.getElementById('demo-notice').hidden, true);
  w.dispatchEvent(new w.PageTransitionEvent('pagehide'));
  w.dispatchEvent(new w.PageTransitionEvent('pageshow', { persisted: true }));
  assert.equal(ld.getElementById('conversation').hidden, true);
  assert.equal(ld.getElementById('reply-message').value, '');
  assert.equal(ld.getElementById('messages').textContent, '');
  w.close();
  console.log('ok - private token removed; ambiguous sends freeze draft and retry identical payload even after rate limiting; page history clears access');

  let readCount = 0, writeCount = 0;
  const conflict = build('https://example.invalid/reply/#' + token, async url => {
    if (url.endsWith('/read')) return result(snapshot(String(++readCount)));
    writeCount++;
    return rejection('conflict');
  });
  await tick();
  submit(conflict.window, 'Fiktivt svar'); await tick();
  const cd = conflict.window.document;
  assert.match(cd.getElementById('error').textContent, /Samtalen er oppdatert/);
  assert.equal(cd.getElementById('send').disabled, true);
  assert.equal(cd.getElementById('reply-message').value, 'Fiktivt svar');
  submit(conflict.window); await tick();
  assert.equal(writeCount, 1);
  cd.getElementById('refresh').click(); await tick();
  assert.equal(cd.getElementById('send').disabled, false);
  assert.equal(cd.getElementById('reply-message').value, 'Fiktivt svar');
  conflict.window.close();
  console.log('ok - revision conflict requires a fresh read while retaining unsent text');

  for (const suffix of ['', '#invalid']) {
    const invalid = build('https://example.invalid/reply/' + suffix, async () => { throw new Error('Invalid token must not fetch'); });
    assert.equal(invalid.window.document.getElementById('conversation').hidden, true);
    assert.equal(invalid.window.document.getElementById('send').disabled, true);
    assert.equal(invalid.window.location.hash, '');
    invalid.window.close();
  }
  const expired = build('https://example.invalid/reply/#' + token, async () => rejection('reply_unavailable', 410));
  await tick();
  assert.equal(expired.window.document.getElementById('conversation').hidden, true);
  assert.match(expired.window.document.getElementById('error').textContent, /utløpt/);
  expired.window.close();
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.match(html, /name="robots" content="noindex,nofollow"/);
  console.log('ok - missing, malformed and expired private links fail closed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
