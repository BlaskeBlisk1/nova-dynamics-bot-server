'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { JSDOM } = require('jsdom');
const html = readFileSync(join(__dirname, '../public/workspace/index.html'), 'utf8');
const script = readFileSync(join(__dirname, '../public/workspace/app.js'), 'utf8');
const tick = () => new Promise(resolve => setImmediate(resolve));
const clone = value => JSON.parse(JSON.stringify(value));
const id = '11111111-1111-4111-8111-111111111111';
const conversationPath = '/api/workspace/enquiries/' + id + '/conversation';
const row = () => ({ id, source: 'external_form', name: 'Synthetic customer', email: 'customer@example.invalid', phone: '', service: 'Coating', message: 'Original request <img src=x>', outcome: 'new', note: '', createdAt: new Date().toISOString(), booking: { status: 'not_booked', slot: null }, followup: { action: 'review', due: new Date().toISOString(), overdue: true }, amountOre: null, revision: 'enquiry-v1' });
const snapshot = () => ({ enabled: true, revision: '1', recipient: 'customer@example.invalid', canSend: true, sendUnavailableReason: '', templates: [{ id: 'question', label: 'Avklar behov', subject: 'Om forespørselen', body: 'Hva ønsker du hjelp med?' }], messages: [{ id: 'enquiry', kind: 'enquiry', direction: 'inbound', state: 'received', body: 'Original request <img src=x>', createdAt: new Date().toISOString() }] });
function draftSnapshot() { const data = snapshot(); data.messages.push({ id: 'draft-1', direction: 'outbound', kind: 'reply', state: 'draft', subject: 'Om forespørselen', body: 'Et kontrollert svar', canCancel: true }); return data; }
function build({ demo = false, enabled = true, conversation = snapshot(), handle } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.invalid/' + (demo ? 'workspace-demo' : 'workspace'), runScripts: 'outside-only' });
  const w = dom.window, d = w.document, calls = [];
  w.confirm = () => true;
  w.fetch = async (url, options = {}) => {
    calls.push({ url, options, body: options.body ? JSON.parse(options.body) : null });
    if (demo) throw Error('Demo must never call the network');
    if (handle && url.startsWith(conversationPath)) return handle(url, options, w);
    const data = url.endsWith('/session') ? { name: 'Synthetic business', csrf: 'synthetic-csrf', features: { conversations: enabled } }
      : url.includes('/enquiries?') ? { items: [row()], hasMore: false }
      : url === conversationPath ? conversation
      : { enquiries: 1, needs_review: 0, won: 0, sales_ore: '0' };
    return { ok: true, json: async () => clone(data) };
  };
  w.eval(script);
  const open = async () => { await tick(); d.querySelector('#list button').click(); d.getElementById('open-conversation')?.click(); await tick(); };
  return { w, d, calls, open, close: () => w.close() };
}
function submit(h, form) { h.d.getElementById(form).dispatchEvent(new h.w.Event('submit', { cancelable: true, bubbles: true })); }
function change(h, id, value) { const el = h.d.getElementById(id); el.value = value; el.dispatchEvent(new h.w.Event('input', { bubbles: true })); }
const response = data => ({ ok: true, json: async () => clone(data) });

async function main() {
  const demo = build({ demo: true }); await demo.open();
  assert.match(demo.d.getElementById('conversation-history').textContent, /Opprinnelig henvendelse/);
  assert.match(demo.d.getElementById('list').textContent, /Nettsideskjema/);
  const rowsBefore = demo.d.querySelectorAll('#list button').length;
  change(demo, 'conversation-body', 'Fiktivt utkast <img src=x onerror=alert(1)>');
  demo.d.getElementById('show-results').click(); await tick(); demo.d.getElementById('back-to-work').click();
  assert.match(demo.d.getElementById('conversation-body').value, /Fiktivt utkast/);
  demo.w.confirm = () => false; demo.d.querySelector('[data-nav=offers]').click();
  assert.match(demo.d.getElementById('conversation-body').value, /Fiktivt utkast/);
  demo.w.confirm = () => true; submit(demo, 'conversation-draft'); await tick();
  assert.equal(demo.d.querySelectorAll('#detail img').length, 0);
  assert.match(demo.d.getElementById('conversation-preview').textContent, /nora@example.invalid/);
  submit(demo, 'conversation-approval'); await tick();
  assert.match(demo.d.getElementById('error').textContent, /Kontroller mottakeren/);
  demo.d.getElementById('conversation-reviewed').checked = true; submit(demo, 'conversation-approval'); await tick();
  assert.match(demo.d.getElementById('conversation-history').textContent, /Simulert: Godtatt.*levering ikke bekreftet/);
  assert.match(demo.d.getElementById('status').textContent, /Ingen e-post er sendt/);
  demo.d.getElementById('conversation-simulate-reply').click();
  assert.match(demo.d.getElementById('detail').textContent, /Neste handling: Følg opp kundesvaret/);
  assert.equal(demo.d.querySelectorAll('#conversation-history li').length, 3);
  assert.equal(demo.d.querySelectorAll('#list button').length, rowsBefore);
  demo.d.getElementById('conversation-back').click(); await tick();
  assert.equal(demo.d.getElementById('outcome').value, 'new');
  assert.equal(demo.d.getElementById('amount').value, '');
  demo.d.getElementById('reset-demo').click(); await tick();
  assert.equal(demo.d.querySelector('#conversation-history'), null);
  demo.d.querySelector('[data-nav=all]').click(); await tick();
  [...demo.d.querySelectorAll('#list button')].find(button => button.textContent.includes('Eksempel: Emil')).click();
  demo.d.getElementById('open-conversation').click(); await tick();
  submit(demo, 'conversation-draft'); await tick();
  demo.d.getElementById('conversation-reviewed').checked = true; submit(demo, 'conversation-approval'); await tick();
  demo.d.getElementById('conversation-simulate-reply').click();
  demo.d.querySelector('[data-nav=due]').click(); await tick();
  assert.match(demo.d.getElementById('list').textContent, /Eksempel: Emil/);
  assert.match(demo.d.getElementById('list').textContent, /Bekreftet avtale/);
  assert.equal(demo.calls.length, 0); assert.equal(demo.w.localStorage.length, 0); assert.equal(demo.w.sessionStorage.length, 0); demo.close();
  console.log('ok - fictional form request, protected draft, explicit simulated approval and same-case reply use no network or storage');

  const gated = build({ enabled: false }); await gated.open();
  assert.equal(gated.d.getElementById('open-conversation'), null);
  assert.equal(gated.calls.some(call => call.url.includes('/conversation')), false); gated.close();
  const unavailable = build({ conversation: { ...draftSnapshot(), canSend: false, sendUnavailableReason: 'recipient_unavailable', recipient: '' } }); await unavailable.open();
  assert.equal(unavailable.d.getElementById('conversation-send').disabled, true);
  assert.match(unavailable.d.getElementById('detail').textContent, /ingen gyldig e-postadresse/);
  unavailable.d.getElementById('conversation-reviewed').checked = true; submit(unavailable, 'conversation-approval');
  assert.equal(unavailable.calls.filter(call => call.options.method === 'POST').length, 0); unavailable.close();
  console.log('ok - live session feature and recipient capability gates prevent unapproved controls or sends');

  let current = snapshot(), releaseSend;
  const live = build({ handle: async (url, options) => {
    if (!options.body) return response(current);
    const body = JSON.parse(options.body);
    if (url.endsWith('/draft')) { assert.equal(body.revision, '1'); assert.equal(body.template, 'question'); current = draftSnapshot(); current.revision = '2'; current.messages[1].body = body.body; return response(current); }
    if (url.endsWith('/send')) return new Promise(resolve => { releaseSend = () => { current.messages[1].state = 'accepted'; current.messages[1].canCancel = false; current.revision = '3'; resolve(response(current)); }; });
    throw Error('Unexpected endpoint');
  } }); await live.open();
  change(live, 'conversation-body', 'Eierens redigerte svar'); submit(live, 'conversation-draft'); await tick();
  assert.match(live.d.getElementById('conversation-preview').textContent, /Eierens redigerte svar/);
  assert.match(live.d.getElementById('conversation-preview').textContent, /customer@example.invalid/);
  live.d.getElementById('conversation-reviewed').checked = true;
  submit(live, 'conversation-approval'); submit(live, 'conversation-approval'); await tick();
  const sends = live.calls.filter(call => call.url.endsWith('/send'));
  assert.equal(sends.length, 1);
  assert.deepEqual(sends[0].body, { revision: '2', draftId: 'draft-1', recipient: 'customer@example.invalid', body: 'Eierens redigerte svar', approved: true });
  assert.equal(sends[0].options.headers['X-Jemlio-CSRF'], 'synthetic-csrf');
  releaseSend(); await tick(); assert.match(live.d.getElementById('conversation-history').textContent, /Godtatt.*levering ikke bekreftet/);
  assert.doesNotMatch(live.d.getElementById('conversation-history').textContent, /Levert ifølge/); live.close();
  console.log('ok - edited saved content and recipient are reviewed before one explicit approval; provider acceptance is not delivery');

  let uncertainState = draftSnapshot(), cancelled = false;
  const uncertain = build({ handle: async (url, options, w) => {
    if (!options.body) return response(uncertainState);
    if (url.endsWith('/send')) { uncertainState.messages[1].state = 'queued'; uncertainState.revision = '2'; throw new w.TypeError('Synthetic response loss'); }
    if (url.endsWith('/cancel')) { cancelled = true; uncertainState.messages[1].state = 'cancelled'; uncertainState.messages[1].canCancel = false; uncertainState.revision = '3'; return response(uncertainState); }
    throw Error('Unexpected request');
  } }); await uncertain.open(); uncertain.d.getElementById('conversation-reviewed').checked = true; submit(uncertain, 'conversation-approval'); await tick();
  assert.match(uncertain.d.getElementById('error').textContent, /kan ikke bekrefte/);
  assert.equal(uncertain.d.getElementById('conversation-send').disabled, true);
  submit(uncertain, 'conversation-approval'); await tick();
  assert.equal(uncertain.calls.filter(call => call.url.endsWith('/send')).length, 1);
  uncertain.d.getElementById('conversation-refresh').click(); await tick();
  assert.match(uncertain.d.getElementById('conversation-history').textContent, /I kø.*levering ikke bekreftet/);
  assert.equal(uncertain.d.getElementById('conversation-send'), null);
  [...uncertain.d.querySelectorAll('#conversation-history button')].find(button => button.textContent === 'Stans meldingen i kø').click(); await tick();
  assert.equal(cancelled, true); assert.ok(uncertain.d.getElementById('conversation-draft')); uncertain.close();
  console.log('ok - uncertain approval freezes controls until status is read; queued cancellation is explicit and never resends');

  const expired = build({ handle: async (url, options) => options.body ? { ok: false, json: async () => ({ error: 'unauthorized' }) } : response(snapshot()) }); await expired.open();
  change(expired, 'conversation-body', 'Private unsaved content'); submit(expired, 'conversation-draft'); await tick();
  assert.equal(expired.d.getElementById('app').hidden, true);
  assert.equal(expired.d.getElementById('detail').textContent, '');
  assert.doesNotMatch(expired.d.body.textContent, /Private unsaved content|Original request/); expired.close();
  console.log('ok - session expiry clears private conversation and draft without rendering late data');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
