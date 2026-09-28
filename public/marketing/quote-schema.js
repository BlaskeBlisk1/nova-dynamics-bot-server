/* Shared, dependency-free validation for configurable enquiry fields. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JemlioQuoteSchema = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  'use strict';
  const ID = /^[a-z][a-z0-9_-]{0,39}$/;
  const fail = (code = 'invalid_fields') => Object.assign(new Error(code), { code });
  const plain = value => value && typeof value === 'object' && !Array.isArray(value);
  function clean(value, max, required = false) {
    if (typeof value !== 'string' || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw fail();
    const result = value.trim();
    if (required && !result) throw fail();
    return result;
  }
  function normalizeForm(raw, services = []) {
    if (raw === undefined || raw === null) return null;
    if (!plain(raw) || Object.keys(raw).some(k => !['kind','requireEmail','requirePhone','questions'].includes(k)) ||
        raw.kind !== 'quote' || raw.requireEmail !== undefined && typeof raw.requireEmail !== 'boolean' ||
        raw.requirePhone !== undefined && typeof raw.requirePhone !== 'boolean' ||
        !Array.isArray(raw.questions) || raw.questions.length > 8) throw fail('invalid_form_configuration');
    const seen = new Set(), available = new Set(services.map(s => typeof s === 'string' ? s : s.id));
    const questions = raw.questions.map(q => {
      if (!plain(q) || Object.keys(q).some(k => !['id','label','type','required','options','services'].includes(k)) ||
          !ID.test(q.id || '') || ['__proto__','prototype','constructor'].includes(q.id) || seen.has(q.id) ||
          !['text','select'].includes(q.type) || typeof q.required !== 'boolean') throw fail('invalid_form_configuration');
      seen.add(q.id);
      const label = clean(q.label, 100, true);
      const item = { id:q.id, label, type:q.type, required:q.required };
      if (q.type === 'select') {
        if (!Array.isArray(q.options) || !q.options.length || q.options.length > 15) throw fail('invalid_form_configuration');
        item.options = q.options.map(v => clean(v, 100, true));
        if (new Set(item.options).size !== item.options.length) throw fail('invalid_form_configuration');
      } else if (q.options !== undefined) throw fail('invalid_form_configuration');
      if (q.services !== undefined) {
        if (!Array.isArray(q.services) || !q.services.length || q.services.some(s => !available.has(s)) ||
            new Set(q.services).size !== q.services.length) throw fail('invalid_form_configuration');
        item.services = [...q.services];
      }
      return item;
    });
    // Email is mandatory for a quote that must be delivered after the visitor leaves.
    if (raw.requireEmail === false) throw fail('invalid_form_configuration');
    return { kind:'quote', requireEmail:true, requirePhone:raw.requirePhone === true, questions };
  }
  function questionsFor(form, service) {
    return (form?.questions || []).filter(q => !q.services || q.services.includes(service));
  }
  function validateAnswers(form, service, answers) {
    const input = answers === undefined ? {} : answers;
    if (!plain(input)) throw fail();
    const questions = questionsFor(form, service), allowed = new Set(questions.map(q => q.id));
    if (Object.keys(input).some(k => !allowed.has(k))) throw fail();
    return questions.map(q => {
      const value = clean(Object.hasOwn(input, q.id) ? input[q.id] : '', q.type === 'select' ? 100 : 500, q.required);
      if (value && q.type === 'select' && !q.options.includes(value)) throw fail();
      return { id:q.id, label:q.label, value };
    }).filter(item => item.value);
  }
  function parseAmount(value) {
    if (typeof value !== 'string') throw fail('invalid_amount');
    const normalized = value.trim().replace(/[ \u00a0]/g, '');
    if (!/^\d{1,9}(?:[.,]\d{1,2})?$/.test(normalized)) throw fail('invalid_amount');
    const [kr, ore = ''] = normalized.replace(',', '.').split('.');
    const result = Number(kr) * 100 + Number(ore.padEnd(2, '0'));
    if (!Number.isSafeInteger(result) || result > 10000000000) throw fail('invalid_amount');
    return result;
  }
  return { normalizeForm, questionsFor, validateAnswers, parseAmount };
});
