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
  function chat(prefix, getClient) {
    const log = $(prefix + '-messages');
    const form = $(prefix + '-form');
    const input = $(prefix + '-input');
    const choices = $(prefix + '-suggestions');
    let controller = null;
    let generation = 0;
    function message(text, kind) {
      const item = document.createElement('div');
      item.className = 'message ' + kind;
      const p = document.createElement('p');
      richText(p, text);
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
        button.addEventListener('click', () => submit(question)); choices.append(button);
      });
    }
    async function submit(raw) {
      const question = String(raw).trim().slice(0, 1200);
      if (!question || controller) return;
      const current = ++generation;
      const activeController = new AbortController(); controller = activeController;
      const client = getClient();
      message(question, 'user'); input.value = ''; pending(true);
      const waiting = message('Henter svar …', 'assistant pending');
      const timer = setTimeout(() => activeController.abort(), 25000);
      try {
        const response = await fetch(api, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ client, message: question }), signal: activeController.signal });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        const data = await response.json();
        if (typeof data.reply !== 'string' || !data.reply.trim()) throw new Error('Missing reply');
        if (current !== generation) return;
        waiting.remove(); message(data.reply, 'assistant');
        if (Array.isArray(data.suggestions)) suggestions(data.suggestions);
      } catch (error) {
        if (current !== generation) return;
        waiting.remove();
        message('Jeg fikk ikke hentet svaret akkurat nå. Prøv igjen om litt, eller kontakt Jemlio på novadynamics7@gmail.com.', 'assistant error');
      } finally {
        clearTimeout(timer);
        if (current === generation) { controller = null; pending(false); }
      }
    }
    form.addEventListener('submit', event => { event.preventDefault(); submit(input.value); });
    choices.querySelectorAll('button').forEach(button => button.addEventListener('click', () => submit(button.textContent)));
    return {
      reset(greeting, questions) {
        generation++; if (controller) controller.abort(); controller = null;
        log.replaceChildren(); input.value = ''; message(greeting, 'assistant'); suggestions(questions); pending(false);
      }
    };
  }
  let selected = 'driving';
  const demo = chat('demo', () => examples[selected].client);
  const tabs = [...document.querySelectorAll('[data-demo]')];
  function select(kind, focus = false) {
    if (!examples[kind]) return;
    selected = kind;
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
  document.querySelectorAll('[data-try]').forEach(button => button.addEventListener('click', () => { select(button.dataset.try); $('demo').scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); $('demo-input').focus({ preventScroll: true }); }));
  chat('support', () => 'jemlio');
  const launcher = $('chat-launcher');
  const panel = $('support-panel');
  function toggle(open) { panel.hidden = !open; launcher.setAttribute('aria-expanded', String(open)); if (open) $('support-input').focus(); else launcher.focus(); }
  launcher.addEventListener('click', () => toggle(panel.hidden));
  $('chat-close').addEventListener('click', () => toggle(false));
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) { event.preventDefault(); toggle(false); } });

  // Compose in the visitor's mail client. No invisible submission or false success.
  $('contact-form').addEventListener('submit', event => {
    event.preventDefault();
    if (!$('contact-form').reportValidity()) return;
    const name = $('contact-name').value.trim();
    const email = $('contact-email').value.trim();
    const company = $('contact-company').value.trim();
    const details = $('contact-message').value.trim();
    if (!name || !email || !company) { $('contact-status').textContent = 'Fyll inn navn, e-post og bedrift før du fortsetter.'; return; }
    const body = `Hei Matteus,\n\nJeg ønsker en gratis, tilpasset Jemlio-demo.\n\nBedrift eller nettside: ${company}\nNavn: ${name}\nE-post: ${email}\n\nVanlige kundespørsmål:\n${details || 'Vi kan avklare dette sammen.'}\n\nMed vennlig hilsen\n${name}`;
    const href = 'mailto:novadynamics7@gmail.com?subject=' + encodeURIComponent('Gratis Jemlio-demo — ' + company.slice(0, 100)) + '&body=' + encodeURIComponent(body);
    $('contact-status').textContent = 'Ingen forespørsel er sendt ennå. Hvis e-postprogrammet åpner seg, se over meldingen og trykk Send der. Ellers kan du skrive til novadynamics7@gmail.com.';
    try { window.location.href = href; }
    catch {
      $('contact-status').textContent = 'Vi fikk ikke åpnet e-postprogrammet. Ingen forespørsel er sendt. Feltene dine er beholdt; skriv til novadynamics7@gmail.com for å be om demoen.';
    }
  });
  $('year').textContent = String(new Date().getFullYear());
})();
