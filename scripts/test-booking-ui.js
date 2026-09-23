'use strict';
// Execute the shipped page with every network request intercepted.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const html = fs.readFileSync(path.join(__dirname, '../public/booking/index.html'), 'utf8');
const script = fs.readFileSync(path.join(__dirname, '../public/booking/app.js'), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
const response = (data, status = 200) => ({ ok: status < 400, status, json: async () => data });
async function until(fn) { for (let i = 0; i < 30; i++) { if (fn()) return; await settle(); } assert.ok(fn(), 'UI should reach the expected state'); }
async function harness({ preview = true, capture, booking, enabled = true, slots } = {}) {
  const calls = [], errors = [], virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(html, { url: `https://booking.example.invalid/${preview ? 'booking-demo' : 'book/example'}`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole });
  const w = dom.window, $ = id => w.document.getElementById(id);
  w.fetch = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ url, body, method: options.method });
    assert.equal(preview, false, 'Preview must never access any API');
    if (url === '/api/booking/config/example') return response({ enabled, name: 'Synthetic business', privacyUrl: 'https://booking.example.invalid/privacy', services: [{ id: 'visit', label: 'Visit', mode: 'calendly', durationMinutes: 30 }] });
    if (url === '/api/booking/slots/example') return slots ? slots(body) : response({ slots: ['2026-09-24T10:00:00.000Z'] });
    if (url === '/api/capture/session') return response({ token: 'synthetic-token' });
    if (url === '/api/capture/requests') return capture ? capture(body) : response({ receipt: 'synthetic-receipt', bookingAccess: 'synthetic-access' });
    if (url === '/api/booking/confirm' || url === '/api/booking/status') return booking ? booking(url, body) : response({ status: 'confirmed', slot: '2026-09-24T10:00:00.000Z' });
    throw new Error('Unexpected API');
  };
  w.eval(script);
  await until(() => enabled ? $('services').children.length > 0 : $('error').textContent.length > 0);
  const submit = () => $('details').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
  async function choose({ contact = false } = {}) {
    $('services').firstElementChild.click();
    await until(() => !$('review-step').hidden || $('slots').children.length > 0 || $('time-help').textContent.startsWith('Ingen') || $('error').textContent);
    if (contact) $('request-contact').click(); else $('slots').firstElementChild.click();
    if (!preview) { $('name').value = 'Synthetic person'; $('email').value = 'nobody@example.invalid'; $('consent').checked = true; }
  }
  const clickText = text => { const b = [...w.document.querySelectorAll('button')].find(b => b.textContent === text); assert.ok(b, text); b.click(); };
  const close = () => { assert.deepEqual(errors, []); dom.window.close(); };
  return { $, calls, choose, submit, clickText, close };
}
let checks = 0;
async function check(name, fn) { await fn(); console.log(`ok ${++checks} - ${name}`); }
async function main() {
  await check('preview keeps all example data in memory, confirms and records an example sale', async () => {
    const h = await harness();
    try {
      assert.equal(h.$('preview-notice').hidden, false); assert.equal(h.$('email').readOnly, true);
      await h.choose(); h.submit(); await until(() => !h.$('result-step').hidden);
      assert.match(h.$('result-title').textContent, /Eksempel: Timen er bekreftet/);
      h.$('owner-tab').click(); assert.equal(h.$('metrics').children[1].firstElementChild.textContent, '1');
      h.clickText('Simuler gjennomført avtale'); h.clickText('Registrer eksempelsalg · 2 500 kr');
      assert.equal(h.$('metrics').children[2].firstElementChild.textContent, '1');
      assert.match(h.$('metrics').children[3].textContent, /2\s500/);
      assert.equal(h.calls.length, 0);
      h.$('reset-demo').click(); assert.equal(h.$('metrics').firstElementChild.firstElementChild.textContent, '0');
    } finally { h.close(); }
  });
  await check('no availability uses a contact request without claiming a booking', async () => {
    const h = await harness();
    try {
      h.$('scenario').value = 'no-slots'; await h.choose({ contact: true }); h.submit();
      await until(() => !h.$('result-step').hidden); assert.match(h.$('result-title').textContent, /Forespørselen er lagret/);
      h.$('owner-tab').click(); assert.equal(h.$('metrics').children[1].firstElementChild.textContent, '0');
      h.clickText('Marker kontaktet'); assert.match(h.$('queue').textContent, /Kontaktet/);
      h.clickText('Avslutt uten salg'); assert.match(h.$('queue').textContent, /Avsluttet/);
      assert.equal(h.calls.length, 0);
    } finally { h.close(); }
  });
  await check('uncertain example needs explicit staff reconciliation before it counts as booked', async () => {
    const h = await harness();
    try {
      h.$('scenario').value = 'uncertain'; await h.choose(); h.submit();
      await until(() => !h.$('result-step').hidden); assert.match(h.$('result-title').textContent, /må avklares/);
      h.$('owner-tab').click(); assert.equal(h.$('metrics').children[1].firstElementChild.textContent, '0');
      h.clickText('Simuler kontroll: time bekreftet'); assert.equal(h.$('metrics').children[1].firstElementChild.textContent, '1');
    } finally { h.close(); }
  });
  await check('live page waits for consent and confirms only after capture hands off a receipt', async () => {
    const h = await harness({ preview: false });
    try {
      assert.equal(h.$('owner-tab').hidden, true); assert.equal(h.$('preview-notice').hidden, true);
      await h.choose(); h.$('consent').checked = false; h.submit(); await settle();
      assert.equal(h.calls.filter(c => c.url === '/api/capture/requests').length, 0);
      h.$('consent').checked = true; h.submit(); await until(() => !h.$('result-step').hidden);
      assert.match(h.$('result-title').textContent, /^Timen er bekreftet$/);
      const sent = h.calls.find(c => c.url === '/api/booking/confirm').body;
      assert.equal(sent.receipt, 'synthetic-receipt'); assert.equal(sent.confirmed, true); assert.equal(sent.email, undefined);
      assert.equal(h.calls.find(c => c.url.includes('/slots/')).method, 'POST');
    } finally { h.close(); }
  });
  await check('uncertain capture retries preserve the same ID and exact reviewed fields', async () => {
    let n = 0; const sent = [];
    const h = await harness({ preview: false, capture: body => { sent.push(body); if (!n++) throw new Error('lost response'); return response({ receipt: 'same-receipt', bookingAccess: 'access' }); } });
    try {
      await h.choose(); h.submit(); await until(() => h.$('error').textContent.length > 0);
      assert.equal(h.$('name').disabled, true); assert.equal(h.$('back-time').disabled, true);
      h.submit(); await until(() => !h.$('result-step').hidden);
      assert.deepEqual(sent[0], sent[1]);
      assert.equal(h.calls.filter(c => c.url === '/api/booking/confirm').length, 1);
    } finally { h.close(); }
  });
  await check('definitively invalid capture fields can be corrected without freezing the visitor', async () => {
    let n = 0;
    const h = await harness({ preview: false, capture: () => n++ ? response({ receipt: 'saved' }) : response({ error: 'invalid_fields' }, 400) });
    try {
      await h.choose(); h.submit(); await until(() => h.$('error').textContent.length > 0);
      assert.equal(h.$('name').disabled, false); h.$('name').value = 'Corrected example'; h.submit();
      await until(() => !h.$('result-step').hidden);
      assert.match(h.$('result-title').textContent, /Forespørselen er lagret/);
      assert.equal(h.calls.filter(c => c.url === '/api/booking/confirm').length, 0);
    } finally { h.close(); }
  });
  await check('lost booking response offers status reading and never repeats the booking POST', async () => {
    const h = await harness({ preview: false, booking: url => { if (url.endsWith('confirm')) throw new Error('timeout'); return response({ status: 'confirmed', slot: '2026-09-24T10:00:00.000Z' }); } });
    try {
      await h.choose(); h.submit(); await until(() => !h.$('result-step').hidden);
      assert.match(h.$('result-title').textContent, /må avklares/); assert.equal(h.$('check-status').hidden, false);
      h.$('check-status').click(); await until(() => h.$('result-title').textContent === 'Timen er bekreftet');
      assert.equal(h.calls.filter(c => c.url === '/api/booking/confirm').length, 1);
    } finally { h.close(); }
  });
  await check('inactive live booking displays no available services or contact form', async () => {
    const h = await harness({ preview: false, enabled: false });
    try { assert.equal(h.$('services').children.length, 0); assert.equal(h.$('review-step').hidden, true); assert.match(h.$('business').textContent, /ikke aktivert/); }
    finally { h.close(); }
  });
  console.log(`Booking UI checks passed: ${checks}. All network requests intercepted.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
