(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const preview = /^\/booking-demo\/?$/.test(location.pathname);
  const client = preview ? null : location.pathname.split('/')[2];
  const examples = { enabled: true, name: 'Eksempel Bilpleie', timezone: 'Europe/Oslo', services: [
    { id: 'vurdering', label: 'Vurdering av bilen', durationMinutes: 30, mode: 'calendly' },
    { id: 'radgivning', label: 'Rådgivning om behandling', durationMinutes: 20, mode: 'calendly' },
    { id: 'tilbud', label: 'Be om et tilpasset tilbud', mode: 'request' }
  ] };
  let config, service, slot, busy = false, version = 0, pending, receipt, access, current, captureSaved = false;
  let records = [];
  const format = value => new Intl.DateTimeFormat('nb-NO', { timeZone: 'Europe/Oslo', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
  const money = value => new Intl.NumberFormat('nb-NO', { style: 'currency', currency: 'NOK', maximumFractionDigits: 0 }).format(value);
  function node(tag, text, className) { const n = document.createElement(tag); if (text !== undefined) n.textContent = text; if (className) n.className = className; return n; }
  function say(text = '', error = '') { $('status').textContent = text; $('error').textContent = error; }
  function show(step) {
    for (const id of ['service', 'time', 'review', 'result']) $(id + '-step').hidden = id !== step;
    for (const id of ['service', 'time', 'review']) $('step-' + id).classList.toggle('active', id === step);
  }
  async function api(path, body) {
    if (preview) throw new Error('preview_network_forbidden');
    const response = await fetch(path, { method: body ? 'POST' : 'GET', cache: 'no-store', credentials: 'omit',
      headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(18000) });
    let data; try { data = await response.json(); } catch { throw new Error('unavailable'); }
    if (!response.ok) throw new Error(data.error || 'unavailable');
    return data;
  }
  function selectView(owner) {
    $('customer-view').hidden = owner; $('owner-view').hidden = !owner;
    $('customer-tab').setAttribute('aria-pressed', String(!owner)); $('owner-tab').setAttribute('aria-pressed', String(owner));
    if (owner) renderOwner();
  }
  $('customer-tab').onclick = () => selectView(false);
  $('owner-tab').onclick = () => selectView(true);
  function sampleSlots() {
    if ($('scenario').value === 'no-slots') return [];
    // Explicit synthetic times, displayed in Norway time. No business calendar is read.
    const day = new Date(); day.setUTCDate(day.getUTCDate() + 1); day.setUTCHours(9, 0, 0, 0);
    return [0, 60, 180, 24 * 60 + 60].map(minutes => new Date(day.getTime() + minutes * 60000).toISOString());
  }
  function freeze(value) {
    for (const id of ['name', 'email', 'phone', 'consent']) $(id).disabled = value;
    $('back-time').disabled = value;
  }
  function resetJourney() {
    version++; service = slot = pending = receipt = access = current = null; captureSaved = false; busy = false;
    freeze(false); $('submit').disabled = false; $('check-status').hidden = true; $('details').reset();
    if (preview) { $('name').value = 'Anna Eksempel'; $('email').value = 'anna@example.invalid'; }
    say(); show('service');
  }
  async function loadSlots(selected) {
    if (busy) return;
    const turn = ++version; service = selected; slot = null; show('time'); say();
    $('selected-service').textContent = service.label; $('slots').replaceChildren(); $('retry-slots').hidden = true;
    $('request-contact').hidden = false;
    if (service.mode === 'request') { review(null); return; }
    say('Henter tilgjengelige tider …');
    try {
      const list = preview ? sampleSlots() : (await api(`/api/booking/slots/${encodeURIComponent(client)}`, { service: service.id })).slots;
      if (turn !== version) return;
      if (!Array.isArray(list)) throw new Error('unavailable');
      say();
      $('time-help').textContent = list.length ? (preview ? 'Eksempeltider · norsk tid. Velg et tidspunkt for å prøve flyten.' : 'Velg et tidspunkt. Alle tider vises i norsk tid.') : 'Ingen ledige tider å vise. Du kan be virksomheten kontakte deg for å finne en løsning.';
      for (const time of list.slice(0, 12)) {
        const button = node('button', format(time), 'slot'); button.onclick = () => review(time); $('slots').append(button);
      }
    } catch {
      if (turn !== version) return;
      say('', 'Vi kunne ikke hente tider. Prøv igjen eller be om å bli kontaktet.'); $('retry-slots').hidden = false;
    }
  }
  $('retry-slots').onclick = () => loadSlots(service);
  $('back-services').onclick = () => { version++; show('service'); say(); };
  $('back-time').onclick = () => { if (!pending && !busy) loadSlots(service); };
  $('request-contact').onclick = () => review(null);
  function review(time) {
    slot = time; show('review'); say(); $('summary').textContent = `${service.label}\n${time ? format(time) : 'Virksomheten kontakter deg for å avtale videre.'}`;
    $('submit').textContent = time ? (preview ? 'Prøv bekreftelse' : 'Bekreft tidspunkt') : (preview ? 'Prøv kontaktforespørsel' : 'Be om å bli kontaktet');
    if (preview) $('consent').checked = true;
  }
  const titles = { confirmed: 'Timen er bekreftet', not_booked: 'Forespørselen er lagret', needs_review: 'Bookingen må avklares', attempting: 'Bookingen behandles', rejected: 'Tidspunktet ble ikke bekreftet', cancelled: 'Timen er avbestilt', completed: 'Avtalen er registrert gjennomført', no_show: 'Avtalen er registrert som ikke møtt' };
  function result(data) {
    show('result'); say(); const state = data.status || 'needs_review';
    $('result-title').textContent = `${preview ? 'Eksempel: ' : ''}${titles[state] || titles.needs_review}`;
    $('result-icon').textContent = state === 'confirmed' ? '✓' : '·';
    $('result-body').textContent = state === 'confirmed' ? `${service.label}\n${format(data.slot)}\n${preview ? 'Dette er en simulert bekreftelse. Ingen ekte time er bestilt.' : 'Bookingsystemet har bekreftet tidspunktet.'}` :
      state === 'not_booked' ? 'Dette er en kontaktforespørsel. Virksomheten må avtale og bekrefte et tidspunkt med deg.' :
      ['attempting', 'needs_review'].includes(state) ? 'Forespørselen er lagret, men vi kan ikke bekrefte timen ennå. Bookingen må sjekkes før du prøver på nytt.' :
      state === 'rejected' ? 'Forespørselen din er fortsatt lagret. Virksomheten må følge opp for å avtale en tid.' : 'Kontakt virksomheten dersom du har spørsmål om denne avtalen.';
    $('manage').replaceChildren();
    for (const [key, label] of [['rescheduleUrl', 'Endre tidspunkt'], ['cancelUrl', 'Avbestill']]) if (data[key] && !preview) {
      try { const url = new URL(data[key]); if (url.origin !== 'https://calendly.com') continue;
        const a = node('a', label); a.href = url.href; a.rel = 'noopener noreferrer'; a.target = '_blank'; $('manage').append(a); } catch {}
    }
    $('check-status').hidden = preview || !access || !['attempting', 'needs_review'].includes(state);
    $('new-example').hidden = !preview; $('result-title').focus();
  }
  $('details').addEventListener('submit', async event => {
    event.preventDefault(); if (busy) return;
    if (!pending && (!$('details').reportValidity() || $('website').value)) return;
    if (!preview && navigator.onLine === false) { say('', 'Du er frakoblet. Opplysningene dine er beholdt. Prøv igjen når du er på nett.'); return; }
    busy = true; $('submit').disabled = true; say('Lagrer og sjekker bekreftelsen …');
    try {
      if (preview) {
        const state = slot ? ($('scenario').value === 'uncertain' ? 'needs_review' : 'confirmed') : 'not_booked';
        current = { id: records.length + 1, service: service.label, status: state, slot, contacted: false, value: null, lost: false };
        records.push(current); result(current); return;
      }
      if (!pending) pending = { client, submissionId: crypto.randomUUID(), name: $('name').value.trim(), email: $('email').value.trim(),
        phone: $('phone').value.trim(), service: service.id, preferredTime: slot ? format(slot) : '', consent: true, website: '' };
      freeze(true);
      if (!captureSaved) {
        const session = await api('/api/capture/session', { client });
        const saved = await api('/api/capture/requests', { ...pending, token: session.token });
        receipt = saved.receipt; access = saved.bookingAccess; captureSaved = true;
      }
      if (!slot || !access) { result({ status: 'not_booked' }); return; }
      try { result(await api('/api/booking/confirm', { client, receipt, access, slot, confirmed: true })); }
      catch (error) {
        if (error.message === 'slot_unavailable' || error.message === 'invalid_service') result({ status: 'rejected' });
        else result({ status: 'needs_review' });
      }
    } catch (error) {
      if (!captureSaved && error.message === 'invalid_fields') {
        pending = null; freeze(false);
        say('', 'Se over navn, e-post og telefon. Navnet må ha minst to tegn, og et telefonnummer må ha 6–15 sifre.');
        $('submit').textContent = slot ? 'Bekreft tidspunkt' : 'Be om å bli kontaktet';
        return;
      }
      // Keep submission ID and exact reviewed details until the server resolves
      // the uncertainty. A second click cannot create a new enquiry.
      say('', 'Vi kunne ikke bekrefte at forespørselen ble lagret. Opplysningene er beholdt. Prøv igjen med samme forespørsel.');
      $('submit').textContent = 'Prøv samme forespørsel igjen';
    } finally { busy = false; $('submit').disabled = false; }
  });
  $('check-status').onclick = async () => {
    if (busy) return; busy = true; $('check-status').disabled = true;
    try { result(await api('/api/booking/status', { client, receipt, access })); }
    catch { say('', 'Status kunne ikke hentes. Kontakt virksomheten for avklaring før du bestiller på nytt.'); }
    finally { busy = false; $('check-status').disabled = false; }
  };
  $('new-example').onclick = resetJourney;
  $('reset-demo').onclick = () => { if (!preview) return; records = []; resetJourney(); renderOwner(); };
  function renderOwner() {
    if (!preview) return;
    $('metrics').replaceChildren();
    const metrics = [[records.length, 'Eksempelhenvendelser'], [records.filter(r => ['confirmed', 'completed'].includes(r.status)).length, 'Bekreftede bookinger'],
      [records.filter(r => r.status === 'completed').length, 'Gjennomførte avtaler'], [money(records.reduce((sum, r) => sum + (r.value || 0), 0)), 'Registrert eksempelomsetning']];
    for (const [value, label] of metrics) { const card = node('div', undefined, 'metric'); card.append(node('strong', String(value)), node('span', label)); $('metrics').append(card); }
    $('queue').replaceChildren();
    if (!records.length) { $('queue').append(node('p', 'Ingen eksempler ennå. Gå til kundereisen og prøv en booking eller kontaktforespørsel.', 'muted')); return; }
    for (const row of [...records].reverse()) {
      const item = node('article', undefined, 'record'), info = node('div'), actions = node('div', undefined, 'record-actions');
      info.append(node('strong', `Anna Eksempel · ${row.service}`));
      info.append(node('p', row.slot ? format(row.slot) : 'Ønsker kontakt for å avtale videre'));
      const label = row.status === 'needs_review' ? 'Må avklares før ny booking' : row.lost ? 'Avsluttet' : row.value !== null ? 'Salg registrert' : row.contacted && row.status === 'not_booked' ? 'Kontaktet · avtal neste steg' : titles[row.status];
      info.append(node('span', label, `badge${row.status === 'needs_review' ? ' attention' : ''}`));
      const add = (label, change) => { const b = node('button', label, 'secondary'); b.onclick = () => { change(); renderOwner(); }; actions.append(b); };
      if (row.status === 'needs_review') add('Simuler kontroll: time bekreftet', () => { row.status = 'confirmed'; });
      else if (!row.lost) {
        if (row.status === 'not_booked' && !row.contacted) add('Marker kontaktet', () => { row.contacted = true; });
        if (row.status === 'confirmed') add('Simuler gjennomført avtale', () => { row.status = 'completed'; });
        if (row.status === 'completed' && row.value === null) add('Registrer eksempelsalg · 2 500 kr', () => { row.value = 2500; });
        if (row.status === 'not_booked') add('Avslutt uten salg', () => { row.lost = true; });
      }
      item.append(info, actions); $('queue').append(item);
    }
  }
  async function init() {
    if (preview) {
      for (const id of ['preview-notice', 'owner-tab', 'scenarios']) $(id).hidden = false;
      config = examples; $('name').readOnly = true; $('email').readOnly = true; $('phone').readOnly = true;
      $('submit-help').textContent = 'Vi bruker faste eksempelopplysninger. Ingen time bestilles, og ingen melding sendes.';
    } else {
      $('headline').textContent = 'Finn en tid som passer.';
      $('intro').textContent = 'Velg tjeneste og se tilgjengelige tider, eller be om å bli kontaktet.';
      try { config = await api(`/api/booking/config/${encodeURIComponent(client)}`); }
      catch { say('', 'Booking er ikke tilgjengelig akkurat nå. Kontakt virksomheten direkte.'); return; }
      if (!config.enabled) { $('business').textContent = 'Booking er ikke aktivert'; say('', 'Kontakt virksomheten direkte for å avtale tid.'); return; }
      try { const privacy = new URL(config.privacyUrl); if (privacy.protocol === 'https:') { $('privacy').href = privacy.href; $('privacy').hidden = false; } } catch {}
    }
    $('business').textContent = config.name; $('services').replaceChildren();
    for (const selected of config.services) {
      const b = node('button', undefined, 'service'), text = node('div');
      text.append(node('strong', selected.label), node('span', selected.mode === 'request' ? 'Vi tar kontakt for å avklare behovet' : `${selected.durationMinutes} minutter · velg tidspunkt`));
      b.append(text, node('b', '→')); b.onclick = () => loadSlots(selected); $('services').append(b);
    }
    resetJourney();
  }
  void init();
})();
