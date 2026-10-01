(() => {
  'use strict';
  const sessions = new WeakMap();
  const S = window.JemlioQuoteSchema;
  const text = (tag, value, cls) => { const el = document.createElement(tag); if (value !== undefined) el.textContent = value; if (cls) el.className = cls; return el; };
  const money = value => new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK' }).format(value / 100);
  const date = value => new Intl.DateTimeFormat('nb-NO', { dateStyle: 'medium', timeZone: 'Europe/Oslo' }).format(new Date(value));
  const replies = { interested: 'Ønsker å gå videre', changes: 'Ønsker avklaring', declined: 'Ikke aktuelt nå' };
  const statuses = { new: 'Ny henvendelse', waiting: 'Avventer kunden', response: 'Kunden har svart', scheduled: 'Oppfølging planlagt', won: 'Avklart oppdrag', lost: 'Avsluttet uten salg' };
  function initial() {
    return { screen: 'overview', status: 'new', name: 'Kari Eksempel', email: 'kari@example.invalid',
      need: 'Flyttevask av en leilighet på 75 m². Ønsker vask neste uke, inkludert vinduer innvendig.',
      quote: null, draft: { title: 'Flyttevask · 75 m²', description: 'Vask av leiligheten og vinduer innvendig. Endelig omfang og tidspunkt avklares med kunden.', amount: '4500', basis: 'incl_vat', days: '7' },
      question: '', answer: '', task: null, events: ['Henvendelsen er mottatt · eksempelsak J-1001.'] };
  }
  function mount(host, { reset = false, onClose = () => {} } = {}) {
    if (!host || !S) return null;
    let session = sessions.get(host);
    if (!session || reset) { session = { state: initial(), revision: 0 }; sessions.set(host, session); }
    session.onClose = onClose;
    const state = session.state;
    let card;
    const addEvent = value => { state.events.push(value); };
    const closed = () => ['won', 'lost'].includes(state.status);
    const hasReply = () => Boolean(state.quote?.response || state.answer);
    function go(screen) { state.screen = screen; render(); }
    function button(label, fn, secondary = false) {
      const generation = session.revision;
      const b = text('button', label, secondary ? 'fu-secondary' : 'fu-primary'); b.type = 'button';
      b.addEventListener('click', () => { if (b.isConnected && generation === session.revision) fn(); }); return b;
    }
    function actions(...buttons) { const row = text('div', undefined, 'fu-actions'); row.append(...buttons); card.append(row); }
    function paragraph(value, cls = 'fu-copy') { const p = text('p', value, cls); card.append(p); return p; }
    function summary(items, parent = card) {
      const dl = text('dl', undefined, 'fu-summary');
      for (const [label, value] of items) if (value !== undefined && value !== '') dl.append(text('dt', label), text('dd', String(value)));
      parent.append(dl); return dl;
    }
    function details(label, fn) { const d = text('details', undefined, 'fu-details'); d.append(text('summary', label)); fn(d); card.append(d); }
    function heading(role, title, copy) {
      card.append(text('p', 'DEMO · ' + role, 'fu-role'));
      const h = text('h3', title); h.tabIndex = -1; card.append(h);
      if (copy) paragraph(copy); return h;
    }
    function field(form, label, name, value, type = 'text', required = true) {
      const wrap = text('label', undefined, 'fu-field'); wrap.append(text('span', label));
      const el = text(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') el.type = type;
      el.name = name; el.value = value || ''; el.required = required; el.maxLength = type === 'textarea' ? 2000 : 254;
      if (type === 'textarea') el.rows = 4;
      wrap.append(el); form.append(wrap); return el;
    }
    function choose(form, label, name, options, value) {
      const wrap = text('label', undefined, 'fu-field'); wrap.append(text('span', label)); const el = text('select'); el.name = name; el.required = true;
      for (const [v, l] of options) { const o = text('option', l); o.value = v; el.append(o); } el.value = value; wrap.append(el); form.append(wrap); return el;
    }
    function approve(form, copy) { const label = text('label', undefined, 'fu-check'), el = text('input'); el.type = 'checkbox'; el.name = 'approved'; el.required = true; label.append(el, text('span', copy)); form.append(label); return el; }
    function error(form, message) { let p = form.querySelector('.fu-error'); if (!p) { p = text('p', undefined, 'fu-error'); p.setAttribute('role', 'alert'); form.append(p); } p.textContent = message; }
    function submit(form, label, fn) {
      const b = text('button', label, 'fu-primary'); b.type = 'submit'; form.append(b);
      const generation = session.revision;
      form.addEventListener('submit', event => {
        event.preventDefault(); event.stopPropagation();
        if (!form.isConnected || session.revision !== generation || !form.reportValidity()) return;
        try { fn(); } catch { error(form, 'Kontroller feltene. Pris oppgis i kroner med høyst to desimaler.'); }
      });
    }
    function newForm() { const form = text('form', undefined, 'fu-form'); card.append(form); return form; }
    function nextAction() {
      if (closed()) return ['Saken er avklart', 'Utfallet er registrert av eieren. Ingen betaling er registrert av demoen.'];
      if (state.task) return [state.task.action === 'callback' ? 'Ring kunden ' + date(state.task.due) : 'Følg opp ' + date(state.task.due), state.task.note || 'Oppgaven ligger hos eieren. Ingen automatisk kundemelding sendes.'];
      if (state.quote?.response === 'declined') return ['Avklar om saken skal avsluttes', 'Kunden har takket nei. Du bestemmer om saken avsluttes eller følges opp senere.'];
      if (state.status === 'response') return ['Følg opp kundens svar', 'Avklar neste steg, juster forslaget eller planlegg personlig kontakt.'];
      if (state.quote && !state.quote.response && !(state.question && !state.answer)) return ['Avvent svar på prisforslaget', 'Du kan planlegge en oppfølging eller se kundens side.'];
      if (state.question && !state.answer) return ['Avvent kundens avklaring', 'Spørsmålet og svaret følger den samme saken.'];
      return ['Vurder behovet og lag et prisforslag', 'Du bestemmer pris og omfang. Jemlio holder saken samlet.'];
    }
    function overview() {
      heading('BEDRIFTENS OVERSIKT', 'Én sak. Et tydelig neste steg.', 'Se kundens behov, svar når du er klar, og hold oversikt over det som gjenstår.');
      paragraph('Fiktiv eksempelsak. Ingen meldinger, bestillinger eller betalinger.', 'fu-notice');
      const counts = text('div', undefined, 'fu-counts');
      for (const [n, label] of [[!closed() && state.status !== 'waiting' ? 1 : 0, 'Trenger svar'], [state.status === 'waiting' ? 1 : 0, 'Avventer kunde'], [closed() ? 1 : 0, 'Avklart']]) {
        const cell = text('div'); cell.append(text('strong', String(n)), text('span', label)); counts.append(cell);
      } card.append(counts);
      const person = text('div', undefined, 'fu-person'); person.append(text('span', state.name.charAt(0), 'fu-avatar'), text('strong', state.name), text('span', statuses[state.status], 'fu-badge')); card.append(person); paragraph(state.need);
      if (state.answer) summary([['Kundens avklaring', state.answer]]);
      if (state.quote) summary([['Prisforslag', money(state.quote.totalOre) + ' · versjon ' + state.quote.version], ['Kundens svar', state.quote.response ? replies[state.quote.response] : 'Ikke svart'], ['Beskjed', state.quote.responseNote || '']]);
      const next = text('div', undefined, 'fu-next'), [title, copy] = nextAction(); next.append(text('span', 'NESTE HANDLING'), text('strong', title), text('p', copy)); card.append(next);
      if (!closed()) {
        actions(button(state.quote ? 'Revider prisforslaget' : 'Lag prisforslag', () => go('quote')), button('Be om mer informasjon', () => go('question'), true), button('Planlegg oppfølging', () => go('schedule'), true));
        if (hasReply()) actions(button('Registrer avklart resultat', () => go('outcome'), true));
      }
      details('Kunde og forespørsel', d => summary([['Saksnummer', 'J-1001'], ['Navn', state.name], ['E-post', state.email], ['Behov', state.need], ['Kilde', 'Nettsidechat · eksempel']], d));
      details('Historikk · ' + state.events.length + ' hendelser', d => { const list = text('ol', undefined, 'fu-history'); for (const event of state.events) list.append(text('li', event)); d.append(list); });
      details('Utforsk eksemplet', d => {
        if (state.quote && !closed()) d.append(button('Se kundens prisforslag', () => go('customer'), true));
        else if (state.question && !state.answer && !closed()) d.append(button('Se kundens avklaring', () => go('clarification'), true));
        else d.append(text('p', 'Prøv eierens neste handling over. Du bytter selv mellom kundens og bedriftens side.'));
        d.append(button('Start et nytt eksempel', confirmReset, true));
      });
      details('Når løsningen tas i bruk', d => d.append(text('p', 'Vi setter opp spørsmål, mottakere, privat tilgang og utsending for bedriften. Før oppstart tester vi en kontrollert henvendelse helt frem til kundesvar. Denne offentlige demoen er ikke koblet til en kundes konto.')));
    }
    function quoteEditor() {
      if (closed()) return overview();
      heading('BEDRIFTEN', state.quote ? 'Revider prisforslaget' : 'Lag et prisforslag', 'Kontroller omfanget og totalprisen før du godkjenner.');
      summary([['Til', state.name], ['Behov', state.need], ['Avklaring', state.answer]]);
      const form = newForm(), draft = state.draft;
      const title = field(form, 'Tjeneste eller oppdrag', 'title', draft.title); title.maxLength = 120; title.minLength = 3;
      const description = field(form, 'Omfang og vilkår', 'description', draft.description, 'textarea'); description.minLength = 10;
      const amount = field(form, 'Totalpris i NOK · demopris', 'amount', draft.amount); amount.inputMode = 'decimal';
      const basis = choose(form, 'Prisgrunnlag', 'basis', [['incl_vat', 'Inkludert mva.'], ['not_vat', 'Mva. ikke beregnet']], draft.basis);
      const days = choose(form, 'Forslaget er gyldig i', 'days', [['3', '3 dager'], ['7', '7 dager'], ['14', '14 dager'], ['30', '30 dager']], draft.days);
      const remember = () => { state.draft = { title: title.value, description: description.value, amount: amount.value, basis: basis.value, days: days.value }; };
      form.addEventListener('input', remember); form.addEventListener('change', remember);
      const check = approve(form, 'Jeg har kontrollert pris og omfang i dette eksemplet.');
      submit(form, 'Godkjenn eksempelforslaget', () => {
        if (!check.checked || title.value.trim().length < 3 || description.value.trim().length < 10 || !['incl_vat', 'not_vat'].includes(basis.value) || !['3', '7', '14', '30'].includes(days.value)) throw new Error();
        const totalOre = S.parseAmount(amount.value); remember();
        state.quote = { title: title.value.trim(), description: description.value.trim(), totalOre, priceBasis: basis.value, version: (state.quote?.version || 0) + 1, expiresAt: new Date(Date.now() + Number(days.value) * 86400000).toISOString(), response: null, responseNote: '' };
        state.question = ''; state.status = 'waiting'; state.task = null; addEvent('Prisforslag v' + state.quote.version + ' godkjent · ' + money(totalOre) + ' · eksempel.'); go('sent');
      });
      actions(button('Tilbake til saken', () => go('overview'), true));
    }
    function sent() {
      heading('BEDRIFTEN', 'Prisforslaget er klart', 'I en aktiv løsning legges den godkjente e-posten i utsendingskø. Kunden får en privat lenke tilbake til forslaget.');
      summary([['Mottaker i eksemplet', state.email], ['Totalpris', money(state.quote.totalOre)], ['Status', 'Avventer kundesvar']]);
      paragraph('Demoen sender ingenting. I bruk skilles det mellom kølagt, akseptert av e-postleverandøren og bekreftet levert.', 'fu-notice');
      actions(button('Se som kunden', () => go('customer')), button('Tilbake til saken', () => go('overview'), true));
    }
    function customer() {
      if (!state.quote || closed()) return overview();
      const q = state.quote;
      heading('KUNDENS SIDE', 'Ditt prisforslag', 'Les omfang og pris. Booking og betaling avklares separat.');
      summary([['Forslag', q.title], ['Omfang og vilkår', q.description], ['Totalpris', money(q.totalOre) + (q.priceBasis === 'incl_vat' ? ' inkl. mva.' : ' · mva. ikke beregnet')], ['Versjon', q.version], ['Svarfrist', date(q.expiresAt)]]);
      if (q.response) { paragraph('Registrert tilbakemelding: ' + replies[q.response]); actions(button('Se bedriftens oppfølging', () => go('overview'))); return; }
      if (Date.parse(q.expiresAt) <= Date.now()) { paragraph('Forslaget er utløpt. Bedriften må sende et nytt.'); actions(button('Tilbake til saken', () => go('overview'), true)); return; }
      const form = newForm();
      const response = choose(form, 'Hva ønsker du å gjøre?', 'response', [['', 'Velg et svar'], ...Object.entries(replies)], '');
      const note = field(form, 'Spørsmål eller beskjed (valgfritt)', 'note', '', 'textarea', false); note.maxLength = 800;
      response.addEventListener('change', () => { note.required = response.value === 'changes'; });
      const check = approve(form, 'Jeg har lest forslaget. Dette er ikke en betaling eller en bekreftet time.');
      submit(form, 'Send eksempeltilbakemelding', () => {
        if (!check.checked || !Object.hasOwn(replies, response.value) || response.value === 'changes' && !note.value.trim() || q !== state.quote || q.response) throw new Error();
        q.response = response.value; q.responseNote = note.value.trim(); state.status = 'response'; state.task = null;
        addEvent('Kunden svarte på v' + q.version + ': ' + replies[q.response] + (q.responseNote ? ' · ' + q.responseNote : '') + '.'); go('overview');
      });
      actions(button('Tilbake til bedriften', () => go('overview'), true));
    }
    function questionEditor() {
      if (closed()) return overview();
      heading('BEDRIFTEN', 'Avklar før du priser', 'Spør kun om det som mangler for å gi et godt forslag.');
      const form = newForm(), input = field(form, 'Spørsmål til kunden', 'question', state.question || 'Hvilken dag neste uke passer best, og er leiligheten tømt?', 'textarea'); input.maxLength = 800;
      form.addEventListener('input', () => { session.questionDraft = input.value; }); if (session.questionDraft) input.value = session.questionDraft;
      const check = approve(form, 'Jeg har kontrollert eksempelspørsmålet.');
      submit(form, 'Godkjenn eksempelspørsmålet', () => { if (!check.checked || !input.value.trim()) throw new Error(); state.question = input.value.trim(); state.answer = ''; state.status = 'waiting'; state.task = null; addEvent('Eieren ber om avklaring: ' + state.question); session.questionDraft = ''; go('clarification'); });
      actions(button('Tilbake til saken', () => go('overview'), true));
    }
    function clarification() {
      if (closed()) return overview();
      heading('KUNDENS SIDE', 'Bedriften har et spørsmål', state.question);
      const form = newForm(), input = field(form, 'Din avklaring', 'answer', state.answer || 'Fredag passer best. Leiligheten vil være tømt.', 'textarea'); input.maxLength = 800;
      submit(form, 'Send eksempelavklaring', () => { if (!input.value.trim()) throw new Error(); state.answer = input.value.trim(); state.status = 'response'; state.task = null; addEvent('Kunden avklarte: ' + state.answer); go('overview'); });
      actions(button('Tilbake til saken', () => go('overview'), true));
    }
    function schedule() {
      if (closed()) return overview();
      heading('BEDRIFTEN', 'Planlegg neste oppfølging', 'Gi saken én tydelig handling og en dato.');
      const form = newForm();
      const action = choose(form, 'Neste handling', 'action', [['callback', 'Ring kunden'], ['review', 'Følg opp henvendelsen']], state.task?.action || 'callback');
      const days = choose(form, 'Når?', 'days', [['1', 'Om én dag'], ['2', 'Om to dager'], ['3', 'Om tre dager'], ['7', 'Om én uke']], '1');
      const note = field(form, 'Intern beskjed (valgfritt)', 'task-note', state.task?.note || '', 'textarea', false); note.maxLength = 500;
      submit(form, 'Lagre eksempeloppfølging', () => {
        if (!['callback', 'review'].includes(action.value) || !['1', '2', '3', '7'].includes(days.value)) throw new Error();
        state.task = { action: action.value, due: new Date(Date.now() + Number(days.value) * 86400000).toISOString(), note: note.value.trim() };
        state.status = 'scheduled'; addEvent('Oppfølging planlagt ' + date(state.task.due) + ': ' + (state.task.action === 'callback' ? 'ring kunden' : 'vurder saken') + '.'); go('overview');
      });
      paragraph('Dette er en oppgave for eieren, ikke en automatisk melding til kunden. E-postpåminnelser til eieren må aktiveres ved oppsett.', 'fu-notice');
      actions(button('Tilbake til saken', () => go('overview'), true));
    }
    function outcome() {
      if (closed()) return overview();
      heading('BEDRIFTEN', 'Registrer et avklart resultat', 'Først etter personlig avklaring registrerer du hvordan saken endte.');
      const form = newForm(), choices = state.quote?.response === 'declined' ? [['lost', 'Avsluttet uten salg']] : [['won', 'Oppdraget er avklart med kunden'], ['lost', 'Avsluttet uten salg']];
      const choice = choose(form, 'Resultat', 'outcome', choices, choices[0][0]);
      const check = approve(form, 'Utfallet er avklart med kunden i dette fiktive eksemplet. Jeg registrerer ikke en betaling.');
      submit(form, 'Lagre eksempelresultatet', () => { if (!check.checked || !choices.some(([v]) => v === choice.value)) throw new Error(); state.status = choice.value; state.task = null; addEvent('Eieren registrerte: ' + statuses[state.status] + '.'); go('overview'); });
      actions(button('Tilbake til saken', () => go('overview'), true));
    }
    function confirmReset() { const current = sessions.get(host); if (current && current !== session) return current.api.confirmReset(); go('reset'); }
    function render() {
      session.revision++; host.replaceChildren();
      card = text('section', undefined, 'followup-demo'); card.setAttribute('aria-label', 'Jemlio Oppfølging · fiktiv eksempelsak'); host.append(card);
      const top = text('div', undefined, 'fu-top'); top.append(text('span', 'EKSEMPELSAK · J-1001'), text('span', statuses[state.status], 'fu-badge'), button('Spør om løsningen', () => session.onClose(), true)); card.append(top);
      const progress = text('ol', undefined, 'fu-progress'), stage = closed() || state.status === 'response' || state.status === 'scheduled' ? 3 : state.quote ? 2 : 1;
      ['Henvendelse', 'Vurdering', 'Prisforslag', 'Oppfølging'].forEach((name, index) => { const li = text('li', (index + 1) + '. ' + name); li.dataset.state = index < stage ? 'done' : index === stage ? 'current' : 'next'; if (index === stage) li.setAttribute('aria-current', 'step'); progress.append(li); }); card.append(progress);
      if (state.screen === 'reset') {
        heading('NYTT EKSEMPEL', 'Starte på nytt?', 'Eksempeldata, utkast og historikk i denne fanen blir nullstilt.');
        actions(button('Ja, start på nytt', () => mount(host, { reset: true, onClose: session.onClose })), button('Behold saken', () => go('overview'), true));
      } else ({ overview, quote: quoteEditor, sent, customer, question: questionEditor, clarification, schedule, outcome }[state.screen] || overview)();
      const h = card.querySelector('h3'); h?.focus({ preventScroll: true });
      host.scrollTop = 0;
    }
    const api = { getState: () => JSON.parse(JSON.stringify(sessions.get(host).state)), confirmReset, show: () => render() };
    session.api = api; render(); return api;
  }
  window.JemlioFollowupDemo = { mount };
})();
