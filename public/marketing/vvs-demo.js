/* VVS product demonstration. Page memory only; never calls intake, SMS or email. */
(() => {
  'use strict';
  const P = window.JemlioVvsProfile, sessions = new WeakMap();
  if (!P) return;
  const policy = { postcodes: ['0150', '0160', '0250'] };
  const n = (tag, value, cls) => { const e = document.createElement(tag); if (value !== undefined) e.textContent = value; if (cls) e.className = cls; return e; };
  const copy = {
    urgent_call_required: 'Ved et akutt problem må du ringe rørlegger eller vakttelefon direkte. Ikke vent på svar i dette skjemaet. Ingen hjelp er bestilt eller bekreftet.',
    outside_service_area: 'Dette postnummeret er utenfor demoområdet. I en pilot bestemmer bedriften sine egne postnumre. Ingen jobb er registrert.',
    invalid_postcode: 'Oppgi et firesifret postnummer. Bruk 0150, 0160 eller 0250 i eksemplet.',
    invalid_fields: 'Kontroller opplysningene. Beskriv arbeidet og oppgi adresse, hastegrad og postnummer.'
  };
  function mount(host, { onClose = () => {} } = {}) {
    if (!host || !window.JemlioFollowupDemo) return null;
    let s = sessions.get(host);
    if (!s) {
      s = { screen: 'entry', generation: 0, source: 'website', ownerHost: null, request: null,
        draft: { service: 'utskifting', problem: 'Jeg ønsker å skifte blandebatteriet på kjøkkenet. Ingen pågående lekkasje.',
          urgency: P.URGENCY[0], postcode: '0150', address: 'Eksempelveien 12', name: 'Kari Eksempel', phone: '99999999', email: 'kari@example.invalid', preferredTime: 'Etter klokken 14' } };
      sessions.set(host, s);
    }
    s.onClose = onClose;
    let card;
    function button(label, fn, secondary = false) {
      const generation = s.generation, b = n('button', label, secondary ? 'fu-secondary' : 'fu-primary'); b.type = 'button';
      b.addEventListener('click', () => { if (b.isConnected && generation === s.generation) fn(); }); return b;
    }
    function actions(...buttons) { const row = n('div', undefined, 'fu-actions'); row.append(...buttons); card.append(row); }
    function title(role, heading, explanation) {
      card.append(n('p', 'VVS · ' + role, 'fu-role')); const h = n('h3', heading); h.tabIndex = -1; card.append(h, n('p', explanation, 'fu-copy'));
    }
    function summary(items, parent = card) { const dl = n('dl', undefined, 'fu-summary'); for (const [a,b] of items) if (b) dl.append(n('dt', a), n('dd', b)); parent.append(dl); }
    function route(screen) { s.screen = screen; render(); }
    function error(form, code) { let e = form.querySelector('.fu-error'); if (!e) { e = n('p', undefined, 'fu-error'); e.setAttribute('role','alert'); form.append(e); } e.textContent = copy[code] || copy.invalid_fields; }
    function input(form, label, key, type = 'text') {
      const wrap = n('label', undefined, 'fu-field'); wrap.append(n('span', label));
      const e = n(type === 'textarea' ? 'textarea' : 'input'); if (type !== 'textarea') e.type = type;
      e.name = key; e.required = key !== 'preferredTime'; e.value = s.draft[key]; e.maxLength = key === 'problem' ? 500 : key === 'postcode' ? 4 : key === 'address' ? 200 : key === 'phone' ? 16 : 254;
      if (type === 'textarea') e.rows = 3;
      if (key === 'postcode') { e.pattern = '[0-9]{4}'; e.inputMode = 'numeric'; }
      if (key === 'phone') e.pattern = '(\\+47)?[2-9][0-9]{7}';
      if (key === 'name') { e.minLength=2; e.maxLength=100; }
      if (key === 'preferredTime') e.maxLength=120;
      e.addEventListener('input', () => { s.draft[key] = e.value; }); wrap.append(e); form.append(wrap); return e;
    }
    function select(form,label,key,choices) {
      const wrap = n('label', undefined, 'fu-field'); wrap.append(n('span', label)); const e = n('select'); e.name=key; e.required=true;
      for (const [id,text] of choices) { const o=n('option',text);o.value=id;e.append(o); } e.value=s.draft[key];
      e.addEventListener('change',()=>{s.draft[key]=e.value;});wrap.append(e);form.append(wrap);return e;
    }
    function submit(form,label,fn) {
      const b=n('button',label,'fu-primary');b.type='submit';form.append(b);const generation=s.generation;
      form.addEventListener('submit',event=>{event.preventDefault();event.stopPropagation();if(!form.isConnected || generation!==s.generation || !form.reportValidity())return;try{fn();}catch(e){error(form,e.code);}});
    }
    function entry() {
      title('PRØV PILOTEN', 'Fra kontakt til en jobb du kan vurdere', 'Kunden forklarer behovet. Du får adresse, hastegrad og kontaktinformasjon samlet – og bestemmer pris og neste steg.');
      card.append(n('p','Fiktiv produktvisning. Ingen SMS, e-post, booking eller betaling.','fu-notice'));
      actions(button('Prøv en nettsidehenvendelse',()=>{s.source='website';route('job');}),button('Se et ubesvart anrop',()=>{s.source='missed_call_demo';route('sms');},true));
      const d=n('details',undefined,'fu-details');d.append(n('summary','Hva er klart, og hva kobles til i piloten?'),n('p','Jobbdetaljer, eierens prisforslag og oppfølging bygger på Jemlios eksisterende arbeidsflyt. Ekte SMS, telefonruting, bilder og direkte kobling til Cordel eller SmartDok er ikke aktivert. De avtales og testes separat.'));card.append(d);
    }
    function sms() {
      title('SIMULERT TELEFONFLYT', 'Når kunden ikke får svar på telefonen', 'Dette viser den planlagte inngangen. Det er ikke sendt en SMS, og ingen telefon er koblet til.');
      const example=n('div',undefined,'fu-next');example.append(n('span','EKSEMPEL PÅ SMS'),n('p','Hei! Vi fikk ikke svart akkurat nå. Beskriv oppdraget via den private lenken, så kan vi vurdere behovet og kontakte deg. Ved et akutt problem: ring vakttelefon direkte.'));card.append(example);
      actions(button('Åpne eksempelhenvendelsen',()=>route('job')),button('Tilbake',()=>route('entry'),true));
    }
    function job() {
      title('KUNDEN · 1 AV 2','Hva gjelder oppdraget?','Demoområde: 0150, 0160 og 0250. Bedriften velger selv tjenester og område ved oppsett.');
      const form=n('form',undefined,'fu-form');card.append(form);
      select(form,'Type arbeid','service',P.SERVICES.map(x=>[x.id,x.label]));
      select(form,'Hvor mye haster det?','urgency',P.URGENCY.map(x=>[x,x]));
      input(form,'Postnummer','postcode');input(form,'Adresse for oppdraget','address');input(form,'Beskriv behovet kort','problem','textarea');
      submit(form,'Gå videre til kontakt',()=>{P.assess(s.draft,policy);if(!P.SERVICES.some(x=>x.id===s.draft.service))throw Error();route('contact');});
      card.append(n('p','Dette er ikke en vakttelefon. Skjemaet bekrefter aldri utrykning, pris eller ledig kapasitet.','fu-notice'));
      actions(button('Tilbake til start',()=>route('entry'),true));
    }
    function contact() {
      title('KUNDEN · 2 AV 2','Hvordan kan bedriften nå deg?','Bruk eksempelopplysninger. Telefon brukes til avklaring; e-post til et privat prisforslag.');
      const form=n('form',undefined,'fu-form');card.append(form);input(form,'Navn','name');input(form,'Telefon','phone','tel');input(form,'E-post','email','email');input(form,'Når passer det å bli kontaktet? (valgfritt)','preferredTime');
      submit(form,'Se over forespørselen',()=>{P.assess(s.draft,policy);route('review');});actions(button('Endre jobbdetaljer',()=>route('job'),true));
    }
    function items() { const d=s.draft;return [['Kilde',s.source==='website'?'Nettside · eksempel':'Ubesvart anrop · simulert'],['Type arbeid',P.SERVICES.find(x=>x.id===d.service)?.label],['Hastegrad',d.urgency],['Adresse',d.address+', '+d.postcode],['Behov',d.problem],['Kunde',d.name],['Telefon',d.phone],['E-post',d.email],['Ønsket kontakt',d.preferredTime]]; }
    function review() {
      title('KUNDEN','Er opplysningene riktige?','Dette er grunnlaget bedriften får for å vurdere oppdraget. Ingen pris eller time er avtalt.');summary(items());
      const form=n('form',undefined,'fu-form');const label=n('label',undefined,'fu-check'),check=n('input');check.type='checkbox';check.name='approved';check.required=true;
      label.append(check,n('span','Jeg bruker eksempeldata og ønsker å se hvordan bedriften følger opp.'));form.append(label);card.append(form);
      submit(form,'Registrer eksempelhenvendelsen',()=>{if(!check.checked)return;P.assess(s.draft,policy);s.request=JSON.parse(JSON.stringify(s.draft));s.ownerHost=null;route('owner');});
      actions(button('Endre opplysninger',()=>route('contact'),true));
    }
    function owner() {
      const source=s.source==='website'?'Nettside · eksempel':'Ubesvart anrop · simulert';
      const toolbar=n('div',undefined,'fu-actions');const handoff=items().map(([a,b])=>a+': '+(b||'Ikke oppgitt')).join('\n');
      toolbar.append(button('Kopier oppdragsgrunnlag',async()=>{
        try{await navigator.clipboard.writeText(handoff);status.textContent='Kopiert. Ikke sendt til et fagsystem.';}
        catch{const area=n('textarea');area.value=handoff;area.readOnly=true;area.setAttribute('aria-label','Oppdragsgrunnlag for manuell kopiering');card.append(area);area.focus();area.select();status.textContent='Marker og kopier teksten manuelt. Ingenting er sendt.';}
      },true),button('Start en ny eksempelhenvendelse',()=>route('reset'),true));
      const status=n('p',undefined,'fu-notice');status.setAttribute('role','status');card.append(toolbar,status);
      s.ownerHost ||= n('div');card.append(s.ownerHost);
      const d=s.request;
      window.JemlioFollowupDemo.mount(s.ownerHost,{scenario:{name:d.name,email:d.email,title:P.SERVICES.find(x=>x.id===d.service).label,
        need:d.problem+'\n'+d.address+', '+d.postcode+'\n'+d.urgency+' · '+source+'\nTelefon: '+d.phone+(d.preferredTime?' · '+d.preferredTime:'')},onClose:s.onClose});
    }
    function reset() { title('NYTT EKSEMPEL','Starte på nytt?','Dette nullstiller bare eksempeldataene i denne fanen.');actions(button('Ja, start på nytt',()=>{sessions.delete(host);mount(host,{onClose:s.onClose});}),button('Behold eksemplet',()=>route(s.request?'owner':'entry'),true)); }
    function render() {
      ++s.generation;host.replaceChildren();card=n('section',undefined,'followup-demo vvs-demo');card.setAttribute('aria-label','Jemlio VVS · fiktiv pilot');host.append(card);
      const top=n('div',undefined,'fu-top');top.append(n('span','RØRLEGGER / VVS · PILOTVISNING'),button('Spør om løsningen',s.onClose,true));card.append(top);
      ({entry,sms,job,contact,review,owner,reset}[s.screen]||entry)();const heading=card.querySelector('h3');heading?.focus({preventScroll:true});if(s.generation>1 && heading?.scrollIntoView)heading.scrollIntoView({block:'nearest',behavior:'instant'});host.scrollTop=0;
    }
    const api={show:render,reset:()=>{const current=sessions.get(host);if(current!==s)return current.api.reset();route('reset');},getState:()=>JSON.parse(JSON.stringify({screen:s.screen,draft:s.draft,request:s.request,source:s.source}))};s.api=api;render();return api;
  }
  window.JemlioVvsDemo={mount};
})();
