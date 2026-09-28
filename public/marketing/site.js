(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const examples = {
    driving: { client: 'jemlio-driving-demo', title: 'Trafikkskoleassistent', industry: 'Trafikkskole', greeting: 'Hei! Jeg er assistenten til en fiktiv trafikkskole. Spør om kjøretimer eller booking. Du kan også spørre hvordan Jemlio hjelper bedriften med oppfølging etter en henvendelse.', questions: ['Hva koster en kjøretime?', 'Hvordan bestiller jeg time?', 'Hva skjer etter henvendelsen?'] },
    optician: { client: 'jemlio-optician-demo', title: 'Optikerassistent', industry: 'Optiker', greeting: 'Hei! Jeg er assistenten til en fiktiv optiker. Spør om synsundersøkelser eller booking. Du kan også spørre hvordan Jemlio hjelper bedriften med henvendelser og oppfølging.', questions: ['Hva koster en synsundersøkelse?', 'Hvordan bestiller jeg en synstest?', 'Hva skjer etter henvendelsen?'] },
    workflow: { client: 'jemlio', title: 'Henvendelse og oppfølging', greeting: 'Prøv en henvendelse og et svar fra bedriften direkte i denne chatten. Velg «Prøv en henvendelse» for å begynne. Alt er et fiktivt eksempel. Du kan også spørre meg om Jemlios funksjoner.', questions: ['Hvordan fungerer oppfølgingen?', 'Hvordan fungerer prisforslag?', 'Hva viser resultatrapporten?'] }
  };
  // On the marketing host, Netlify proxies only this endpoint to the stable API.
  const api = '/chat';
  function richText(parent, text) {
    const pattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+|mailto:[^\s)]+)\)|(https?:\/\/[^\s<>]+|mailto:[^\s<>]+)/g;
    let end = 0;
    for (const match of String(text).matchAll(pattern)) {
      parent.append(document.createTextNode(text.slice(end, match.index)));
      let href = match[2] || match[3];
      let suffix = '';
      if (!match[2]) { const clean = href.replace(/[.,;!?]+$/, ''); suffix = href.slice(clean.length); href = clean; }
      const a = document.createElement('a');
      a.href = href;
      a.textContent = match[1] || href;
      a.rel = 'noopener noreferrer';
      if (href.startsWith('http')) a.target = '_blank';
      parent.append(a, document.createTextNode(suffix));
      end = match.index + match[0].length;
    }
    parent.append(document.createTextNode(text.slice(end)));
  }
  function chat(prefix, getClient, onAnswer = () => {}) {
    const log = $(prefix + '-messages');
    const form = $(prefix + '-form');
    const input = $(prefix + '-input');
    const choices = $(prefix + '-suggestions');
    let controller = null;
    let generation = 0;
    let requestTimer = null;
    let composing = false;
    let flowMode = false;
    function message(text, kind) {
      const item = document.createElement('div');
      item.className = 'message ' + kind;
      const p = document.createElement('p');
      const sender = document.createElement('span');
      sender.className = 'sr-only';
      sender.textContent = kind === 'user' ? 'Du: ' : 'Assistenten: ';
      item.append(sender);
      if (kind === 'user') p.textContent = text;
      else richText(p, text);
      item.append(p); log.append(item); log.scrollTop = log.scrollHeight;
      return item;
    }
    function pending(value) {
      form.querySelector('button').disabled = value;
      choices.querySelectorAll('button').forEach(button => { button.disabled = value; });
      form.setAttribute('aria-busy', String(value));
    }
    function suggestions(questions) {
      choices.replaceChildren();
      questions.slice(0, 3).forEach(question => {
        if (typeof question !== 'string' || question.length > 200) return;
        const button = document.createElement('button');
        button.type = 'button'; button.textContent = question;
        button.addEventListener('click', () => submit(question, 'suggestion')); choices.append(button);
      });
    }
    function clearRetries() { log.querySelectorAll('.chat-retry').forEach(button => button.remove()); }
    function failure(question, source, error = {}) {
      clearRetries();
      const offline = navigator.onLine === false;
      const item = message(offline
        ? 'Du ser ut til å være frakoblet. Koble til nettet og prøv spørsmålet igjen.'
        : error.httpStatus === 429 ? 'Det kom mange spørsmål på kort tid. Vent litt og prøv igjen.'
        : 'Jeg fikk ikke hentet svaret akkurat nå. Du kan prøve igjen eller kontakte Jemlio på hei@jemlio.com.', 'assistant error');
      const retry = document.createElement('button');
      retry.type = 'button'; retry.className = 'chat-retry'; retry.textContent = 'Prøv spørsmålet igjen';
      retry.addEventListener('click', () => { if (retry.isConnected) submit(question, source, true); });
      item.append(retry); log.scrollTop = log.scrollHeight;
    }
    async function submit(raw, source = 'typed', retrying = false) {
      const question = String(raw).trim().slice(0, 1200);
      if (!question || controller || flowMode) return;
      clearRetries();
      if (navigator.onLine === false) { failure(question, source); return; }
      const current = ++generation;
      const activeController = new AbortController(); controller = activeController;
      const client = getClient();
      message(question, 'user');
      if (source === 'typed' && (!retrying || input.value.trim() === question)) input.value = '';
      pending(true);
      const waiting = message('Henter svar …', 'assistant pending');
      const timer = setTimeout(() => activeController.abort(), 25000);
      requestTimer = timer;
      try {
        const response = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, message: question }), signal: activeController.signal });
        if (!response.ok) { const error = new Error('Chat unavailable'); error.httpStatus = response.status; throw error; }
        const data = await response.json();
        if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('Missing reply');
        if (current !== generation) return;
        waiting.remove(); message(data.reply, 'assistant');
        if (Array.isArray(data.suggestions)) suggestions(data.suggestions);
        if (data.unsure !== true) onAnswer();
      } catch (error) {
        if (current !== generation) return;
        waiting.remove();
        failure(question, source, error);
      } finally {
        clearTimeout(timer);
        if (current === generation) { controller = null; requestTimer = null; pending(false); }
      }
    }
    input.addEventListener('compositionstart', () => { composing = true; });
    input.addEventListener('compositionend', () => { composing = false; });
    form.addEventListener('submit', event => { event.preventDefault(); if (!composing && !event.isComposing) submit(input.value); });
    choices.querySelectorAll('button').forEach(button => button.addEventListener('click', () => submit(button.textContent, 'suggestion')));
    return {
      pause() {
        flowMode = true; generation++; if (controller) controller.abort(); controller = null;
        clearTimeout(requestTimer); requestTimer = null; log.querySelectorAll('.pending,.chat-retry').forEach(node => node.remove());
        input.value = ''; form.hidden = choices.hidden = true; pending(false);
      },
      resume() { flowMode = false; form.hidden = choices.hidden = false; input.focus({ preventScroll: true }); },
      reset(greeting, questions) {
        flowMode = false; form.hidden = choices.hidden = false;
        generation++; if (controller) controller.abort(); controller = null;
        clearTimeout(requestTimer); requestTimer = null; composing = false;
        log.replaceChildren(); input.value = ''; message(greeting, 'assistant'); suggestions(questions); pending(false);
      }
    };
  }

  function enquiryFlow(log, kind, done) {
    let active = true, phase = 'form';
    const root = document.createElement('section'); root.className = 'enquiry-chat';
    root.setAttribute('aria-label', 'Fiktiv henvendelse i chatten'); root.setAttribute('aria-live', 'off');
    log.append(root);
    const element = (tag, text, className = '') => { const n = document.createElement(tag); n.textContent = text; n.className = className; return n; };
    const note = element('p', 'Fiktiv øvelse · Ingen opplysninger sendes eller lagres', 'enquiry-demo-label'); root.append(note);
    const focus = () => {
      const target = [...root.querySelectorAll('input:not(:disabled),textarea:not(:disabled),button:not(:disabled)')].find(node => !node.closest('[hidden]'));
      target?.focus({ preventScroll: true });
      if (target) log.scrollTop = Math.max(0, target.offsetTop - log.offsetTop - 50);
    };
    const bubble = (text, user = false) => { const n = element('div', '', 'enquiry-bubble' + (user ? ' enquiry-user' : '')); n.append(element('p', text)); root.append(n); return n; };
    const action = (host, label, expected, fn, secondary = false) => {
      const button = element('button', label, secondary ? 'enquiry-secondary' : ''); button.type = 'button';
      button.addEventListener('click', () => { if (active && phase === expected && button.isConnected) fn(); }); host.append(button); return button;
    };
    const services = kind === 'driving' ? ['Kjøreopplæring', 'Trafikalt grunnkurs', 'Et annet spørsmål']
      : kind === 'optician' ? ['Synsundersøkelse', 'Briller', 'Et annet spørsmål'] : ['Coating av bil', 'Bilpleie', 'Et annet spørsmål'];
    bubble('Hva ønsker du hjelp med? Fyll ut den korte forespørselen her. Bruk bare oppdiktede opplysninger.');
    const form = document.createElement('form'); form.className = 'enquiry-card'; form.autocomplete = 'off';
    function field(label, name, value, tag = 'input') {
      const wrapper = document.createElement('label'); wrapper.append(element('span', label));
      const input = document.createElement(tag); input.name = name; input.required = true; input.maxLength = name === 'email' ? 254 : 100;
      input.value = value; input.autocomplete = 'off'; wrapper.append(input); form.append(wrapper); return input;
    }
    const name = field('Navn', 'name', 'Nora Eksempel');
    const email = field('E-post', 'email', 'nora@example.com'); email.type = 'email';
    const service = field('Hva gjelder det?', 'service', '', 'select');
    services.forEach(value => { const option = element('option', value); option.value = value; service.append(option); });
    const details = field('Kort beskjed', 'details', kind === 'driving' ? 'Jeg ønsker å starte med automat. Passer det etter kl. 16?'
      : kind === 'optician' ? 'Jeg ønsker informasjon om synsundersøkelse. Passer det etter kl. 16?' : 'Jeg ønsker et prisforslag på coating av bilen min.', 'textarea');
    details.maxLength = 500; details.rows = 3;
    form.append(element('p', 'Unngå helseopplysninger og andre sensitive opplysninger.', 'enquiry-help'));
    const review = element('button', 'Se over forespørselen'); review.type = 'submit'; form.append(review);
    action(form, 'Tilbake til spørsmål', 'form', () => { phase = 'done'; form.remove(); finish('Øvelsen er avsluttet. Du kan fortsette å stille spørsmål.'); }, true);
    root.append(form); focus();
    form.addEventListener('submit', event => {
      event.preventDefault(); if (!active || phase !== 'form') return;
      name.value = name.value.trim(); email.value = email.value.trim(); details.value = details.value.trim();
      if (!form.reportValidity()) return;
      phase = 'review'; form.hidden = true;
      const card = bubble('Se over forespørselen din'); card.classList.add('enquiry-card');
      for (const [label, value] of [['Navn', name.value], ['E-post', email.value], ['Tjeneste', service.value], ['Beskjed', details.value]]) {
        const line = element('p', ''); line.append(element('strong', label + ': '), document.createTextNode(value)); card.append(line);
      }
      card.append(element('p', 'Dette sender ingen melding og bestiller ingen time.', 'enquiry-help'));
      action(card, 'Bekreft eksempelhenvendelsen', 'review', () => {
        phase = 'waiting'; card.querySelectorAll('button').forEach(b => b.remove()); form.reset(); form.remove();
        const receipt = bubble('Eksempelhenvendelsen er registrert i denne øvelsen. I en aktiv løsning kan bedriften lese den i arbeidsoversikten og godkjenne et personlig svar.');
        action(receipt, 'Vis et eksempel på svar fra bedriften', 'waiting', () => {
          phase = 'reply'; receipt.querySelector('button').remove();
          const question = kind === 'driving' ? 'Hei! Har du fullført trafikalt grunnkurs, og hvilke ukedager passer best?'
            : kind === 'optician' ? 'Hei! Hvilke ukedager passer best for deg etter kl. 16?'
            : 'Hei! Hvilken bilmodell og årsmodell har du, og hvordan er lakkens tilstand?';
          const answer = bubble(question); answer.prepend(element('strong', 'Eksempelsvar fra bedriften'));
          const response = document.createElement('form'); response.className = 'enquiry-card';
          const label = element('label', 'Ditt svar til bedriften');
          const text = document.createElement('textarea'); text.name = 'reply'; text.maxLength = 2000; text.rows = 3; text.required = true;
          text.placeholder = kind === 'driving' ? 'For eksempel: Grunnkurset er fullført. Tirsdag passer best.' : kind === 'optician' ? 'For eksempel: Tirsdag og torsdag passer best.' : 'For eksempel: Volvo V60, 2022. Lakken har noen små riper.';
          label.append(text); response.append(label, element('p', 'Dette svaret blir bare værende i øvelsen.', 'enquiry-help'));
          const send = element('button', 'Legg til eksempelsvar'); send.type = 'submit'; response.append(send); root.append(response); focus();
          response.addEventListener('submit', event => {
            event.preventDefault(); if (!active || phase !== 'reply') return;
            text.value = text.value.trim(); if (!response.reportValidity() || text.value.length > 2000) return;
            phase = 'done'; bubble(text.value, true); text.value = ''; response.remove();
            finish('Eksempelsvaret er lagt til i samme henvendelse. Bedriften kan følge opp fra arbeidsoversikten. Ingen time eller kjøpsavtale er opprettet.');
          });
        }); focus();
      });
      action(card, 'Endre opplysninger', 'review', () => { phase = 'form'; card.remove(); form.hidden = false; focus(); }, true);
      focus();
    });
    function finish(text) {
      const end = bubble(text); end.setAttribute('role', 'status');
      action(end, 'Fortsett å spørre', 'done', () => { active = false; end.querySelector('button').remove(); done(); }); focus();
    }
    return { focus, destroy() { active = false; root.querySelectorAll('input,textarea').forEach(input => { input.value = ''; }); root.remove(); } };
  }

  let selected = 'driving';
  let enquiryDemo = null;
  const demo = chat('demo', () => examples[selected].client, () => { $('demo-next').hidden = false; });
  const tabs = [...document.querySelectorAll('[data-demo]')];
  function select(kind, focus = false) {
    if (!examples[kind]) return;
    if (enquiryDemo) enquiryDemo.destroy(); enquiryDemo = null;
    selected = kind;
    if ($('demo-enquiry')) $('demo-enquiry').disabled = false;
    $('demo-next').hidden = true;
    tabs.forEach(tab => { const active = tab.dataset.demo === kind; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; if (active && focus) tab.focus(); });
    $('demo-title').textContent = examples[kind].title;
    $('demo-badge').textContent = kind === 'workflow' ? 'Jemlio' : 'Eksempel';
    $('demo-note').textContent = kind === 'workflow' ? 'Prøv med fiktive data. Ingen meldinger sendes.' : 'Priser og tjenester er fiktive. Ingen bestillinger blir gjort.';
    $('demo-input').placeholder = kind === 'workflow' ? 'Spør om booking, prisforslag eller oppfølging …' : 'Hva ville kundene dine spurt om?';
    $('demo-panel').setAttribute('aria-labelledby', 'tab-' + kind);
    demo.reset(examples[kind].greeting, examples[kind].questions);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => select(tab.dataset.demo));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
      select(tabs[next].dataset.demo, true);
    });
  });
  function startEnquiryDemo() {
    if (enquiryDemo) { enquiryDemo.focus(); return; }
    demo.pause();
    $('demo-enquiry').disabled = true;
    enquiryDemo = enquiryFlow($('demo-messages'), selected, () => {
      demo.resume(); $('demo-next').hidden = false;
      $('demo-enquiry').disabled = false; enquiryDemo = null;
    });
  }
  $('demo-enquiry')?.addEventListener('click', startEnquiryDemo);
  document.querySelectorAll('[data-inline-enquiry]').forEach(link => link.addEventListener('click', () => {
    select('workflow'); startEnquiryDemo();
  }));
  $('demo-reset').addEventListener('click', () => { select(selected); $('demo-input').focus(); });
  $('demo-tailor').addEventListener('click', () => {
    // Only the explicitly chosen example category crosses into the contact form.
    // No question, answer or conversation content is copied or stored.
    if (examples[selected].industry) $('contact-industry').value = examples[selected].industry;
    $('contact-company').focus({ preventScroll: true });
    updateEmailDraft();
  });
  document.querySelectorAll('[data-try]').forEach(button => button.addEventListener('click', () => { select(button.dataset.try); $('demo').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); $('demo-input').focus({ preventScroll: true }); }));
  const support = chat('support', () => 'jemlio');
  $('support-reset').addEventListener('click', () => {
    support.reset('Hei! Spør meg om Jemlios chat, booking, prisforslag eller oppfølging. Jeg kan vise deg hvordan du prøver funksjonene med fiktive data eller ber om en demo for bedriften din.',
      ['Hvordan fungerer oppfølgingen?', 'Hvordan fungerer prisforslag?', 'Hvordan får jeg en gratis demo?']);
    $('support-input').focus();
  });
  const launcher = $('chat-launcher');
  const panel = $('support-panel');
  function toggle(open) { panel.hidden = !open; launcher.setAttribute('aria-expanded', String(open)); if (open) $('support-input').focus(); else launcher.focus(); }
  launcher.addEventListener('click', () => toggle(panel.hidden));
  $('chat-close').addEventListener('click', () => toggle(false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); toggle(false); } });

  // Native POST lets Netlify own form processing and the success navigation.
  // The absolute action is intentional: mirrors on Render and localhost must
  // navigate to the actual form host instead of posting to a different backend.
  // We never infer delivery from an arbitrary fetch() 200 or retry a POST.
  const contactForm = $('contact-form');
  const contactSubmit = $('contact-submit');
  const contactStatus = $('contact-status');
  let contactPending = false;
  let contactTimer = null;
  function requestDetails() {
    const name = $('contact-name').value.trim();
    const email = $('contact-email').value.trim();
    const company = $('contact-company').value.trim();
    const industry = $('contact-industry').value;
    const details = $('contact-message').value.trim();
    const subject = 'Gratis Jemlio-demo' + (company ? ' — ' + company.slice(0, 100) : '');
    const body = `Hei Matteus,\n\nJeg ønsker en gratis, tilpasset Jemlio-demo og ber dere kontakte meg om denne.\n\nBedrift eller nettside: ${company}\nNavn: ${name}\nE-post: ${email}\nBransje: ${industry || 'Ikke oppgitt'}\n\nDette ønsker jeg hjelp med:\n${details || 'Vi kan avklare dette sammen.'}\n\nMed vennlig hilsen\n${name}`;
    return { subject, body };
  }
  function updateEmailDraft() {
    const { subject, body } = requestDetails();
    $('contact-email-draft').href = 'mailto:hei@jemlio.com?subject=' + encodeURIComponent(subject) + '&body=' + encodeURIComponent(body);
    if (!$('contact-copy-manual').hidden) $('contact-copy-text').value = `Til: hei@jemlio.com\nEmne: ${subject}\n\n${body}`;
  }
  contactForm.addEventListener('input', updateEmailDraft);
  contactForm.addEventListener('change', updateEmailDraft);
  $('contact-email-draft').addEventListener('click', () => {
    updateEmailDraft();
    $('contact-copy-status').textContent = 'E-postutkastet må sendes fra e-postprogrammet ditt. Hvis det ikke åpnes, bruk «Kopier forespørselen».';
  });
  $('contact-copy').addEventListener('click', async () => {
    const { subject, body } = requestDetails();
    const text = `Til: hei@jemlio.com\nEmne: ${subject}\n\n${body}`;
    try {
      if (!navigator.clipboard || !navigator.clipboard.writeText) throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      $('contact-copy-status').textContent = 'Forespørselen er kopiert. Lim den inn i en e-post til hei@jemlio.com og send den selv. Kopieringen sender ingenting.';
    } catch {
      $('contact-copy-manual').hidden = false;
      $('contact-copy-text').value = text;
      $('contact-copy-text').focus();
      $('contact-copy-text').select();
      $('contact-copy-status').textContent = 'Automatisk kopiering er ikke tilgjengelig. Kopier den markerte teksten og send den i ditt eget e-postprogram.';
    }
  });
  contactForm.addEventListener('submit', event => {
    if (contactPending) { event.preventDefault(); return; }
    for (const id of ['contact-name', 'contact-email', 'contact-company']) $(id).value = $(id).value.trim();
    if (!contactForm.reportValidity()) { event.preventDefault(); return; }
    if (navigator.onLine === false) {
      event.preventDefault();
      contactStatus.textContent = 'Du ser ut til å være frakoblet. Ingen innsending er startet. Feltene er beholdt. Koble til nettet eller kopier forespørselen til en e-post.';
      $('contact-fallback').open = true;
      return;
    }
    updateEmailDraft();
    contactPending = true;
    contactSubmit.disabled = true;
    contactForm.setAttribute('aria-busy', 'true');
    contactStatus.textContent = 'Sender forespørselen … Vent på bekreftelsessiden før du lukker siden.';
    contactTimer = setTimeout(() => {
      // The request may have arrived even if the navigation did not finish.
      // Keep the send guard until the browser restores the page, preserving all
      // fields and offering a different way to ask about the same request.
      contactForm.setAttribute('aria-busy', 'false');
      contactStatus.textContent = 'Vi kan ikke bekrefte om forespørselen kom frem. Ikke send skjemaet på nytt nå. Feltene er beholdt. Kontakt hei@jemlio.com og nevn at du allerede forsøkte skjemaet.';
      $('contact-fallback').open = true;
    }, 20000);
    // Intentionally do not preventDefault(): the browser performs exactly one
    // standard form POST, including when JavaScript is unavailable.
  });
  window.addEventListener('pagehide', () => { clearTimeout(contactTimer); });
  window.addEventListener('pageshow', event => {
    if (!event.persisted) return;
    clearTimeout(contactTimer);
    contactPending = false;
    contactSubmit.disabled = false;
    contactForm.setAttribute('aria-busy', 'false');
    contactStatus.textContent = 'Feltene er beholdt. Hvis du allerede fikk bekreftelsessiden, trenger du ikke sende på nytt.';
  });
  updateEmailDraft();
  $('year').textContent = String(new Date().getFullYear());
})();
