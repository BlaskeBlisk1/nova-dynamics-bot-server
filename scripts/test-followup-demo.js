'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { JSDOM, VirtualConsole } = require('jsdom');
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
let checks = 0;
async function test(name, fn) { await fn(); console.log(`ok ${++checks} - ${name}`); }
function harness() {
  const errors = [], calls = [], vc = new VirtualConsole(); vc.on('jsdomError', e => errors.push(e));
  const dom = new JSDOM(read('public/marketing/index.html'), { url: 'https://www.jemlio.com/', runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole: vc });
  const w = dom.window, d = w.document; w.matchMedia = () => ({ matches: true }); w.HTMLElement.prototype.scrollIntoView = () => {};
  w.fetch = async (url, opts) => { calls.push({ url, opts }); return { ok: true, json: async () => ({ reply: 'Synthetic explanatory reply.' }) }; };
  for (const file of ['quote-schema.js', 'followup-demo.js', 'site.js']) w.eval(read('public/marketing/' + file));
  const click = label => { const b = [...d.querySelectorAll('.followup-demo button')].find(b => b.textContent.trim() === label); assert.ok(b, 'button ' + label); b.click(); };
  const set = (name, value) => { const el = d.querySelector(`.followup-demo [name="${name}"]`); assert.ok(el, 'field ' + name); el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); el.dispatchEvent(new w.Event('change', { bubbles: true })); };
  const approve = () => { const el = d.querySelector('.followup-demo [name=approved]'); assert.ok(el); el.checked = true; };
  const open = () => d.getElementById('tab-workflow').click();
  const finish = () => { assert.deepEqual(errors, []); assert.equal(calls.length, 0, 'synthetic business actions never make network requests'); w.close(); };
  return { w, d, calls, click, set, approve, open, finish };
}
(async () => {
  await test('follow-up tab opens a real interactive case, not a paragraph of sales copy', () => {
    const h = harness(); try { h.open(); assert.match(h.d.querySelector('.followup-demo').textContent, /J-1001/); assert.match(h.d.querySelector('.fu-next').textContent, /Vurder behovet/); assert.equal(h.d.getElementById('demo-title').textContent, 'Jemlio Oppfølging'); assert.ok(h.d.querySelector('.fu-progress [aria-current=step]')); } finally { h.finish(); }
  });
  await test('owner must approve a valid price and the exact proposal reaches the customer', () => {
    const h = harness(); try { h.open(); h.click('Lag prisforslag'); h.set('amount', '7 250,50'); h.click('Godkjenn eksempelforslaget'); assert.ok(h.d.querySelector('[name=amount]')); h.approve(); h.click('Godkjenn eksempelforslaget'); h.click('Se som kunden'); assert.match(h.d.querySelector('.fu-summary').textContent, /7\s*250,50/); h.set('response', 'interested'); h.approve(); h.click('Send eksempeltilbakemelding'); assert.match(h.d.querySelector('.fu-next').textContent, /Følg opp kundens svar/); assert.doesNotMatch(h.d.querySelector('.fu-badge').textContent, /Avklart oppdrag/); } finally { h.finish(); }
  });
  await test('draft price and case progress survive tab switches', () => {
    const h = harness(); try { h.open(); h.click('Lag prisforslag'); h.set('amount', '6200'); h.set('description', 'Kontrollert og avgrenset eksempelomfang.'); h.d.getElementById('tab-driving').click(); assert.equal(h.d.querySelector('.followup-demo'), null); h.open(); assert.equal(h.d.querySelector('[name=amount]').value, '6200'); assert.equal(h.d.querySelector('.followup-demo [name=description]').value, 'Kontrollert og avgrenset eksempelomfang.'); } finally { h.finish(); }
  });
  await test('clarification remains attached to the same customer request', () => {
    const h = harness(); try { h.open(); h.click('Be om mer informasjon'); h.approve(); h.click('Godkjenn eksempelspørsmålet'); h.set('answer', 'Fredag passer. Vinduer innvendig er riktig.'); h.click('Send eksempelavklaring'); assert.match(h.d.querySelector('.followup-demo').textContent, /Fredag passer/); assert.match(h.d.querySelector('.fu-history').textContent, /Kunden avklarte/); assert.match(h.d.querySelector('.fu-top').textContent, /J-1001/); } finally { h.finish(); }
  });
  await test('scheduled follow-up has one date, one action and no automatic customer send', () => {
    const h = harness(); try { h.open(); h.click('Planlegg oppfølging'); h.set('days', '3'); h.set('task-note', 'Avklar tidspunkt personlig.'); h.click('Lagre eksempeloppfølging'); assert.match(h.d.querySelector('.fu-next').textContent, /Ring kunden/); assert.match(h.d.querySelector('.fu-next').textContent, /Avklar tidspunkt personlig/); h.d.getElementById('tab-optician').click(); h.open(); assert.match(h.d.querySelector('.fu-badge').textContent, /Oppfølging planlagt/); } finally { h.finish(); }
  });
  await test('change requests need a note, quote revisions cannot reuse stale controls', () => {
    const h = harness(); try { h.open(); h.click('Lag prisforslag'); h.approve(); h.click('Godkjenn eksempelforslaget'); h.click('Se som kunden'); h.set('response', 'changes'); h.approve(); const old = [...h.d.querySelectorAll('.followup-demo button')].find(b => b.textContent === 'Send eksempeltilbakemelding'); old.click(); assert.ok(h.d.querySelector('[name=note]')); h.set('note', 'Ta ut vinduene.'); old.click(); h.click('Revider prisforslaget'); h.set('amount', '3500'); h.approve(); h.click('Godkjenn eksempelforslaget'); old.click(); h.click('Se som kunden'); assert.match(h.d.querySelector('.fu-summary').textContent, /Versjon2/); assert.match(h.d.querySelector('.fu-summary').textContent, /3\s*500/); } finally { h.finish(); }
  });
  await test('explicit outcome confirmation and reset confirmation protect the case', () => {
    const h = harness(); try { h.open(); h.click('Be om mer informasjon'); h.approve(); h.click('Godkjenn eksempelspørsmålet'); h.click('Send eksempelavklaring'); h.click('Registrer avklart resultat'); h.click('Lagre eksempelresultatet'); assert.ok(h.d.querySelector('[name=outcome]')); h.approve(); h.click('Lagre eksempelresultatet'); assert.match(h.d.querySelector('.fu-badge').textContent, /Avklart oppdrag/); h.d.getElementById('demo-reset').click(); h.click('Behold saken'); assert.match(h.d.querySelector('.fu-badge').textContent, /Avklart oppdrag/); h.d.getElementById('demo-reset').click(); h.click('Ja, start på nytt'); assert.match(h.d.querySelector('.fu-badge').textContent, /Ny henvendelse/); h.d.getElementById('demo-reset').click(); h.click('Behold saken'); assert.match(h.d.querySelector('.fu-badge').textContent, /Ny henvendelse/); } finally { h.finish(); }
  });
  await test('literal customer text cannot become HTML; explanatory chat does not destroy the case', () => {
    const h = harness(); try { h.open(); h.click('Be om mer informasjon'); h.approve(); h.click('Godkjenn eksempelspørsmålet'); h.set('answer', '<img src=x onerror=alert(1)>'); h.click('Send eksempelavklaring'); assert.match(h.d.querySelector('.followup-demo').textContent, /<img/); assert.equal(h.d.querySelector('.followup-demo img'), null); h.click('Spør om løsningen'); assert.equal(h.d.querySelector('.followup-demo'), null); h.d.getElementById('followup-chat-return').click(); assert.match(h.d.querySelector('.followup-demo').textContent, /<img/); } finally { h.finish(); }
  });
  console.log(`Follow-up demo: ${checks} grouped checks passed. No live data or sends.`);
})().catch(e => { console.error(e); process.exitCode = 1; });
