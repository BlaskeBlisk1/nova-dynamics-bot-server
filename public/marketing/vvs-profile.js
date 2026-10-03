/* Shared validation: browser demonstration and server-side VVS intake. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.JemlioVvsProfile = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const URGENCY = Object.freeze(['Planlagt arbeid', 'Ønsker rask tilbakemelding', 'Akutt problem nå']);
  const SERVICES = Object.freeze([
    { id: 'reparasjon', label: 'Reparasjon eller service' },
    { id: 'utskifting', label: 'Utskifting eller montering' },
    { id: 'befaring', label: 'Befaring eller planlagt oppussing' }
  ]);
  const fail = code => Object.assign(new Error(code), { code });
  function form() {
    return { kind: 'quote', requireEmail: true, requirePhone: true, questions: [
      { id: 'problem', label: 'Hva ønsker du hjelp med?', type: 'text', required: true },
      { id: 'urgency', label: 'Hvor mye haster det?', type: 'select', required: true, options: [...URGENCY] },
      { id: 'postcode', label: 'Postnummer for oppdraget', type: 'text', required: true },
      { id: 'address', label: 'Adresse for oppdraget', type: 'text', required: true }
    ] };
  }
  function configuration(raw, schema) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
        Object.keys(raw).some(k => !['postcodes', 'emergencyPhone'].includes(k)) ||
        !Array.isArray(raw.postcodes) || !raw.postcodes.length || raw.postcodes.length > 1000 ||
        raw.postcodes.some(p => typeof p !== 'string' || !/^\d{4}$/.test(p) || p === '0000') ||
        new Set(raw.postcodes).size !== raw.postcodes.length ||
        raw.emergencyPhone !== undefined && (typeof raw.emergencyPhone !== 'string' || !/^(?:\+47)?[2-9]\d{7}$/.test(raw.emergencyPhone))) throw fail('invalid_vvs_config');
    if (schema) {
      const expected = form();
      if (schema.kind !== 'quote' || schema.requirePhone !== true || schema.requireEmail === false ||
          !Array.isArray(schema.questions) || schema.questions.length !== 4 ||
          expected.questions.some(q => {
            const actual = schema.questions.find(v => v.id === q.id);
            return !actual || actual.required !== true || actual.type !== q.type || actual.services !== undefined ||
              q.type === 'select' && JSON.stringify(q.options) !== JSON.stringify(actual.options);
          })) throw fail('invalid_vvs_config');
    }
    return { postcodes: [...raw.postcodes], ...(raw.emergencyPhone ? { emergencyPhone: raw.emergencyPhone } : {}) };
  }
  function assess(answers, raw) {
    const config = configuration(raw);
    if (!answers || typeof answers !== 'object' || Array.isArray(answers)) throw fail('invalid_fields');
    const clean = (id, max) => {
      const v = answers[id];
      if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v)) throw fail('invalid_fields');
      return v.trim();
    };
    const urgency = clean('urgency', 50);
    if (!URGENCY.includes(urgency)) throw fail('invalid_fields');
    // Explicit visitor declaration, not an AI diagnosis or an emergency dispatch.
    if (urgency === URGENCY[2]) throw fail('urgent_call_required');
    const postcode = clean('postcode', 4);
    if (!/^\d{4}$/.test(postcode) || postcode === '0000') throw fail('invalid_postcode');
    if (!config.postcodes.includes(postcode)) throw fail('outside_service_area');
    const address = clean('address', 200), problem = clean('problem', 500);
    if (address.length < 3 || problem.length < 5) throw fail('invalid_fields');
    return { industry: 'vvs', source: 'website', postcode, address, problem,
      urgency: urgency === URGENCY[0] ? 'planned' : 'soon', area: 'configured_postcode' };
  }
  return { form, configuration, assess, URGENCY, SERVICES };
});
