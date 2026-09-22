(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const examples = {
    driving: { client: 'jemlio-driving-demo', title: 'Trafikkskoleassistent', greeting: 'Hei! Jeg er assistenten til en fiktiv trafikkskole. Spør meg om kjøretimer, automatgir eller hvordan du bestiller en time.', questions: ['Hva koster en kjøretime?', 'Tilbyr dere automatgir?', 'Hvordan bestiller jeg time?'] },
    optician: { client: 'jemlio-optician-demo', title: 'Optikerassistent', greeting: 'Hei! Jeg er assistenten til en fiktiv optiker. Spør meg om synsundersøkelser, kontaktlinser eller veien til timebestilling.', questions: ['Hva koster en synsundersøkelse?', 'Kan jeg få hjelp med kontaktlinser?', 'Hvordan bestiller jeg en synstest?'] }
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
      if (!question || controller) return;
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
      reset(greeting, questions) {
        generation++; if (controller) controller.abort(); controller = null;
        clearTimeout(requestTimer); requestTimer = null; composing = false;
        log.replaceChildren(); input.value = ''; message(greeting, 'assistant'); suggestions(questions); pending(false);
      }
    };
  }
  let selected = 'driving';
  const demo = chat('demo', () => examples[selected].client, () => { $('demo-next').hidden = false; });
  const tabs = [...document.querySelectorAll('[data-demo]')];
  function select(kind, focus = false) {
    if (!examples[kind]) return;
    selected = kind;
    $('demo-next').hidden = true;
    tabs.forEach(tab => { const active = tab.dataset.demo === kind; tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1; if (active && focus) tab.focus(); });
    $('demo-title').textContent = examples[kind].title;
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
  $('demo-reset').addEventListener('click', () => { select(selected); $('demo-input').focus(); });
  $('demo-tailor').addEventListener('click', () => {
    // Only the explicitly chosen example category crosses into the contact form.
    // No question, answer or conversation content is copied or stored.
    $('contact-industry').value = selected === 'optician' ? 'Optiker' : 'Trafikkskole';
    $('contact-company').focus({ preventScroll: true });
    updateEmailDraft();
  });
  document.querySelectorAll('[data-try]').forEach(button => button.addEventListener('click', () => { select(button.dataset.try); $('demo').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); $('demo-input').focus({ preventScroll: true }); }));
  const support = chat('support', () => 'jemlio');
  $('support-reset').addEventListener('click', () => {
    support.reset('Hei! Jeg kan svare på spørsmål om Jemlio og hvordan du får en gratis demo. Hva lurer du på?',
      ['Hva kan Jemlio hjelpe med?', 'Hvordan får jeg en gratis demo?']);
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
      $('contact-copy-status').textContent = 'Kopiert. Lim inn i en e-post til hei@jemlio.com og send den selv. Kopieringen sender ingenting.';
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
      contactStatus.textContent = 'Du ser ut til å være frakoblet. Ingen innsending er startet. Feltene er beholdt; koble til nettet eller kopier forespørselen til en e-post.';
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
      contactStatus.textContent = 'Vi kan ikke bekrefte om forespørselen kom frem. Ikke send skjemaet på nytt nå. Feltene er beholdt; kontakt hei@jemlio.com og nevn at du allerede forsøkte skjemaet.';
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
