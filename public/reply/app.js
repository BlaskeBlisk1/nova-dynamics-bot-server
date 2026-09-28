(() => {
  'use strict';
  function mount({ root, token = '', demo = false, client = '', embedded = false, onBusiness = () => {} }) {
  if (embedded) {
    root.innerHTML = INLINE_MARKUP;
    root.querySelector('.page-header').remove();
    root.querySelectorAll('[id]').forEach(node => { node.dataset.reply = node.id; node.id = 'private-' + node.id; });
    for (const node of root.querySelectorAll('[for], [aria-describedby], [aria-labelledby]')) {
      for (const attr of ['for', 'aria-describedby', 'aria-labelledby']) if (node.hasAttribute(attr)) node.setAttribute(attr, node.getAttribute(attr).split(' ').map(id => 'private-' + id).join(' '));
    }
  }
  const $ = id => embedded ? root.querySelector('[data-reply="' + id + '"]') : root.querySelector('#' + id);
  const tokenValid = value => /^[A-Za-z0-9_-]{43}$/.test(value);
  let current = null, busy = false, pending = null, uncertain = false, canReply = false, active = true, activeRequest = null;
  const errors = {
    unavailable: 'Samtalen er ikke tilgjengelig nå. Prøv å hente den på nytt, eller kontakt bedriften direkte.',
    not_found: 'Lenken er utløpt eller ikke tilgjengelig. Be bedriften om en ny svarlenke.',
    forbidden: 'Lenken kan ikke brukes. Åpne den opprinnelige lenken igjen, eller kontakt bedriften.',
    invalid_request: 'Kontroller svaret ditt. Det må inneholde mellom 1 og 2000 tegn.',
    conflict: 'Samtalen er oppdatert. Hent den på nytt og les de nye meldingene før du sender svaret.',
    request_closed: 'Denne samtalen er avsluttet. Kontakt bedriften direkte hvis du ønsker videre oppfølging.',
    approval_required: 'Svaret kunne ikke registreres. Kontakt bedriften direkte.',
    recipient_mismatch: 'Svaret kunne ikke registreres. Kontakt bedriften direkte.',
    recipient_unavailable: 'Svaret kunne ikke registreres. Kontakt bedriften direkte.',
    recipient_suppressed: 'Svaret kunne ikke registreres. Kontakt bedriften direkte.',
    send_unavailable: 'Svaret kunne ikke registreres nå. Kontakt bedriften direkte.',
    reply_unavailable: 'Lenken er utløpt eller ikke tilgjengelig. Be bedriften om en ny svarlenke.',
    rate_limited: 'Det har vært for mange forsøk. Vent litt før du prøver igjen.',
    submission_conflict: 'Dette forsøket kan ikke brukes til et nytt svar. Kontakt bedriften direkte før du prøver videre.'
  };
  const terminal = new Set(['not_found', 'forbidden', 'reply_unavailable', 'request_closed', 'submission_conflict']);
  const date = value => {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? '' : new Intl.DateTimeFormat('nb-NO', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Oslo' }).format(parsed);
  };
  function message(text, error = false) {
    $(error ? 'error' : 'status').textContent = text;
    $(error ? 'status' : 'error').textContent = '';
  }
  function controls() {
    $('send').disabled = busy || uncertain || !canReply;
    $('reply-message').readOnly = busy || uncertain || !canReply;
    $('retry').hidden = !uncertain;
    $('retry').disabled = busy;
    $('refresh').hidden = demo || uncertain || !tokenValid(token);
    $('refresh').disabled = busy;
    $('reset').disabled = busy;
    $('message-length').textContent = $('reply-message').value.length + ' av 2000 tegn';
    $('reply-form').setAttribute('aria-busy', String(busy));
  }
  function unavailable(code) {
    canReply = false;
    $('conversation').hidden = true;
    $('messages').replaceChildren();
    $('expires').textContent = '';
    if (terminal.has(code)) token = '';
    message(errors[code] || errors.not_found, true);
    controls();
  }
  function snapshotValid(data) {
    return data && typeof data.businessName === 'string' && typeof data.subject === 'string' && Array.isArray(data.messages) && typeof data.revision === 'string' && /^[1-9]\d*$/.test(data.revision) && Number.isFinite(new Date(data.expiresAt).getTime());
  }
  async function api(path, payload) {
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch('/api/replies/' + path, {
        method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: controller.signal
      });
      const data = await response.json();
      if (!response.ok) {
        const error = new Error(errors[data.error] || errors.unavailable);
        error.code = data.error;
        error.definitive = response.status >= 400 && response.status < 500 && Boolean(errors[data.error]);
        throw error;
      }
      return data;
    } finally { clearTimeout(timeout); if (activeRequest === controller) activeRequest = null; }
  }
  function seed() {
    const now = Date.now();
    return {
      businessName: 'Eksempel Bilpleie · fiktiv bedrift', subject: 'Coating av bilen din', revision: '1',
      expiresAt: new Date(now + 14 * 86400000).toISOString(),
      messages: [
        { id: 'demo-enquiry', direction: 'inbound', kind: 'enquiry', state: 'received', body: 'Hei! Jeg ønsker å høre mer om coating av bilen min. Hva trenger dere å vite for å gi et prisforslag?', createdAt: new Date(now - 3600000).toISOString() },
        { id: 'demo-question', direction: 'outbound', state: 'accepted', body: 'Hei! Takk for henvendelsen. Hvilken bilmodell og årsmodell har du? Fortell gjerne litt om lakkens tilstand, så kan vi avklare hva som passer.', createdAt: new Date(now - 1800000).toISOString() }
      ]
    };
  }
  function render(data) {
    current = data;
    $('business').textContent = data.businessName;
    onBusiness(data.businessName);
    $('subject').textContent = data.subject || 'Din samtale med bedriften';
    $('conversation').hidden = false;
    $('messages').replaceChildren();
    data.messages.forEach(item => {
      const row = document.createElement('li');
      row.className = 'message ' + (item.direction === 'inbound' ? 'inbound' : 'outbound') + (item.kind === 'enquiry' ? ' enquiry' : '');
      const header = document.createElement('div'); header.className = 'message-header';
      const author = document.createElement('span'); author.className = 'message-author';
      author.textContent = item.kind === 'enquiry' ? 'Din opprinnelige henvendelse' : item.direction === 'inbound' ? 'Deg' : data.businessName;
      const time = document.createElement('time'); time.textContent = date(item.createdAt);
      if (time.textContent) time.dateTime = item.createdAt;
      header.append(author, time); row.append(header);
      if (item.subject && item.subject !== data.subject) {
        const subject = document.createElement('p'); subject.className = 'message-subject'; subject.textContent = item.subject; row.append(subject);
      }
      const body = document.createElement('p'); body.className = 'message-body'; body.textContent = item.body || ''; row.append(body);
      $('messages').append(row);
    });
    $('message-count').textContent = data.messages.length + (data.messages.length === 1 ? ' melding' : ' meldinger');
    $('expires').textContent = 'Svarlenken er tilgjengelig til ' + date(data.expiresAt) + ' (norsk tid).';
    canReply = new Date(data.expiresAt).getTime() > Date.now();
    if (!canReply) message(errors.reply_unavailable, true);
    controls();
  }
  async function refresh() {
    if (busy || uncertain || !tokenValid(token)) return;
    busy = true; canReply = false; controls();
    try {
      const data = await api('read', { token, ...(client ? { client } : {}) });
      if (!active) return;
      if (!snapshotValid(data)) throw new Error('Invalid response');
      message(''); render(data);
    } catch (error) {
      if (!active) return;
      if (terminal.has(error.code)) unavailable(error.code);
      else message(errors[error.code] || errors.unavailable, true);
    } finally { busy = false; controls(); }
  }
  async function send(payload) {
    if (busy) return;
    const wasUncertain = uncertain;
    busy = true; controls();
    try {
      const data = demo ? {
        accepted: true, duplicate: false,
        conversation: { ...current, revision: String(Number(current.revision) + 1), messages: [...current.messages, { id: payload.submissionId, direction: 'inbound', state: 'received', body: payload.message, createdAt: new Date().toISOString() }] }
      } : await api('respond', payload);
      if (!active) return;
      if (data.accepted !== true || !snapshotValid(data.conversation)) throw new Error('Invalid response');
      pending = null; uncertain = false; $('reply-message').value = '';
      message(demo ? 'Eksempelsvaret er lagt til bare på denne siden.' : 'Svaret ditt er registrert. Bedriften kan lese det i samtalen.');
      render(data.conversation);
    } catch (error) {
      if (!active) return;
      if (!error.definitive || (wasUncertain && !terminal.has(error.code))) {
        uncertain = true;
        message((error.code === 'rate_limited' ? errors.rate_limited + ' ' : '') + 'Vi kan ikke bekrefte om svaret ble registrert. Teksten er låst. Bruk «Prøv samme svar igjen» for å gjenta nøyaktig det samme forsøket. Da unngår du at svaret registreres to ganger. Ikke last siden på nytt mens du avklarer dette.', true);
      } else {
        uncertain = false; pending = null;
        if (terminal.has(error.code)) unavailable(error.code);
        else {
          if (error.code === 'conflict') canReply = false;
          message(errors[error.code] || errors.unavailable, true);
        }
      }
    } finally { busy = false; controls(); }
  }
  $('reply-message').value = '';
  $('reply-message').addEventListener('input', controls);
  $('reply-form').addEventListener('submit', event => {
    event.preventDefault();
    if (busy || uncertain || !canReply || !current) return;
    if (new Date(current.expiresAt).getTime() <= Date.now()) { unavailable('reply_unavailable'); return; }
    const text = $('reply-message').value.trim();
    if (!text || text.length > 2000) { message(errors.invalid_request, true); return; }
    if (typeof crypto.randomUUID !== 'function') { message('Nettleseren kan ikke sende svaret sikkert. Bruk en oppdatert nettleser eller kontakt bedriften direkte.', true); return; }
    pending = Object.freeze({ token, ...(client ? { client } : {}), submissionId: crypto.randomUUID(), message: text, revision: current.revision });
    send(pending);
  });
  $('retry').addEventListener('click', () => { if (uncertain && pending && !busy) send(pending); });
  $('refresh').addEventListener('click', refresh);
  $('reset').addEventListener('click', () => {
    if (!demo || busy) return;
    pending = null; uncertain = false; $('reply-message').value = ''; message('Eksemplet er nullstilt.'); render(seed());
  });
  window.addEventListener('pagehide', () => {
    active = false; if (activeRequest) activeRequest.abort();
    token = ''; pending = null; current = null; uncertain = false; canReply = false;
    $('reply-message').value = ''; $('messages').replaceChildren(); $('conversation').hidden = true;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      active = true;
      if (demo) { message('Eksemplet er nullstilt.'); render(seed()); }
      else unavailable('not_found');
    }
  });
  if (demo) {
    $('demo-notice').hidden = false; $('reset').hidden = false; $('workspace-link').hidden = false; $('send').textContent = 'Legg til eksempelsvar';
    message(''); render(seed());
  } else if (!tokenValid(token)) unavailable('not_found');
  else refresh();
  }
  const INLINE_MARKUP = "\n    <header class=\"page-header\"><a class=\"brand\" href=\"https://www.jemlio.com\" aria-label=\"Jemlio, til hovedsiden\"><img src=\"/marketing/assets/jemlio-wordmark.webp\" alt=\"Jemlio\" width=\"180\" height=\"54\"></a><span class=\"private-label\">Privat samtale</span></header>\n    <aside id=\"demo-notice\" class=\"demo-notice\" hidden><strong>Prøv et fiktivt eksempel</strong><p>Les meldingen fra bedriften og skriv et svar. Alt skjer bare på denne siden. Ingen melding sendes til en bedrift.</p></aside>\n    <div class=\"page-intro\"><p class=\"eyebrow\" id=\"business\">Din henvendelse</p><h1 id=\"subject\">Fortsett samtalen</h1><p class=\"intro\">Les meldingen fra bedriften og svar når det passer deg.</p></div>\n    <div class=\"feedback\"><p id=\"status\" role=\"status\" aria-live=\"polite\">Henter samtalen …</p><p id=\"error\" role=\"alert\"></p></div>\n    <section id=\"conversation\" aria-labelledby=\"history-title\" hidden>\n      <div class=\"section-heading\"><h2 id=\"history-title\">Samtalen deres</h2><span id=\"message-count\" class=\"muted\"></span></div>\n      <ol id=\"messages\" class=\"messages\"></ol>\n      <form id=\"reply-form\" autocomplete=\"off\">\n        <label for=\"reply-message\">Ditt svar til bedriften</label>\n        <textarea id=\"reply-message\" name=\"message\" rows=\"5\" maxlength=\"2000\" required autocomplete=\"off\" aria-describedby=\"message-hint message-length\" placeholder=\"Skriv det bedriften trenger for å hjelpe deg videre\"></textarea>\n        <div class=\"composer-hints\"><p id=\"message-hint\" class=\"muted\">Unngå sensitive opplysninger.</p><p id=\"message-length\" class=\"muted\">0 av 2000 tegn</p></div>\n        <p class=\"notice\">Svaret ditt legges til i denne samtalen. Et svar oppretter ingen booking, kjøpsavtale eller betaling.</p>\n        <button id=\"send\" type=\"submit\" disabled>Send svar</button>\n      </form>\n    </section>\n    <div class=\"recovery-actions\"><button id=\"retry\" type=\"button\" hidden>Prøv samme svar igjen</button><button id=\"refresh\" type=\"button\" class=\"secondary\" hidden>Hent samtalen på nytt</button><button id=\"reset\" type=\"button\" class=\"secondary\" hidden>Nullstill eksemplet</button></div>\n    <footer>\n      <p id=\"expires\" class=\"muted\"></p>\n      <p>Lenken er privat. Alle som har lenken kan lese og svare i samtalen. Åpne den opprinnelige lenken igjen hvis du laster siden på nytt. Uferdige svar lagres ikke.</p>\n      <a id=\"workspace-link\" href=\"/workspace-demo\" hidden>Se bedriftens arbeidsoversikt ↗</a>\n    </footer>\n  ";
  window.JemlioReply = Object.freeze({ mount });
  if (document.getElementById('reply-root')) {
    const demo = /^\/reply-demo\/?$/.test(location.pathname);
    const token = demo ? '' : location.hash.slice(1);
    if (location.hash) history.replaceState(null, '', location.pathname);
    mount({ root: document.getElementById('reply-root'), token, demo });
  }
})();
