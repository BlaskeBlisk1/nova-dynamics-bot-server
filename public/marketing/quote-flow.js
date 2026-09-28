(function () {
  'use strict';
  const S = window.JemlioQuoteSchema;
  if (!S) return;
  const storageKey = 'jemlio-private-offer:' + location.pathname;
  let privateToken = '', privateMode = location.hash.startsWith('#offer=');
  try {
    if (privateMode) {
      privateToken = location.hash.slice(7);
      // Scrub the address before any analytics or ordinary demo initialization.
      history.replaceState(null, '', location.pathname + location.search);
      sessionStorage.setItem(storageKey, privateToken);
    } else {
      privateToken = sessionStorage.getItem(storageKey) || '';
      privateMode = Boolean(privateToken);
    }
  } catch { /* Restricted storage does not stop an already opened private link. */ }
  const node = (tag, text, cls) => { const n=document.createElement(tag); if(text!==undefined)n.textContent=text; if(cls)n.className=cls; return n; };
  const money = n => new Intl.NumberFormat('nb-NO',{style:'currency',currency:'NOK'}).format(n/100);
  const responses = {interested:'Ønsker å gå videre',changes:'Har spørsmål eller ønsker endringer',declined:'Ikke aktuelt nå'};
  function button(label, fn, secondary=false) { const b=node('button',label,secondary?'qf-secondary':'qf-primary');b.type='button';b.addEventListener('click',fn);return b; }
  function field(form,label,name,value='',type='text',required=true) {
    const wrap=node('label',undefined,'qf-field');wrap.append(node('span',label));const input=node(type==='textarea'?'textarea':'input');
    if(type!=='textarea')input.type=type;input.name=name;input.value=value;input.required=required;input.maxLength=type==='textarea'?2000:254;
    if(type==='textarea')input.rows=3;wrap.append(input);form.append(wrap);return input;
  }
  function approval(form, copy) { const label=node('label',undefined,'qf-check'),check=node('input');check.type='checkbox';check.required=true;check.name='approved';label.append(check,node('span',copy));form.append(label);return check; }
  function frame(host,role,title,copy,demo=true) {
    host.querySelectorAll('.demo-flow-card,.quote-flow').forEach(n=>n.remove());
    const card=node('section',undefined,'quote-flow');card.setAttribute('aria-label',title);card.setAttribute('aria-live','off');
    card.append(node('p',(demo?'DEMO · ':'PRIVAT · ')+role,'qf-role'));
    const heading=node('h3',title);heading.tabIndex=-1;card.append(heading,node('p',copy,'qf-copy'));
    if(demo){card.append(node('p','Kun eksempeldata i denne fanen. Ingen meldinger, bestillinger eller betalinger.','qf-notice'));
      const close=button('Tilbake til vanlig chat',()=>{card.remove();if(typeof window.renderDemoFlowLauncher==='function')window.renderDemoFlowLauncher();document.getElementById('message-input')?.focus();},true);close.classList.add('qf-close');card.append(close);}
    host.append(card);heading.focus({preventScroll:true});host.scrollTop=host.scrollHeight;return card;
  }
  function summary(card,items) { const dl=node('dl',undefined,'qf-summary');for(const [k,v] of items){if(v!==undefined&&v!==''){dl.append(node('dt',k),node('dd',String(v)));}}card.append(dl); }
  function actions(card,...items) { const group=node('div',undefined,'qf-actions');group.append(...items);card.append(group);return group; }
  function error(card,text) { let p=card.querySelector('.qf-error');if(!p){p=node('p',undefined,'qf-error');p.setAttribute('role','alert');card.append(p);}p.textContent=text; }

  // The same schema drives the real capture form and the synthetic demonstration.
  function mountFields(container,form,service,initial={}) {
    container.querySelector('.qf-custom-fields')?.remove();const box=node('div',undefined,'qf-custom-fields');
    const questions=S.questionsFor(form,service);
    for(const q of questions){const label=node('label',undefined,'qf-field');label.append(node('span',q.label+(q.required?' *':' (valgfritt)')));
      const input=node(q.type==='select'?'select':'input');input.name='detail-'+q.id;input.dataset.question=q.id;input.required=q.required;
      if(q.type==='select'){input.append(new Option('Velg',''));for(const option of q.options)input.append(new Option(option,option));}else{input.type='text';input.maxLength=500;}
      input.value=initial[q.id]||'';label.append(input);box.append(label);
    }
    container.append(box);
    return () => Object.fromEntries([...box.querySelectorAll('[data-question]')].map(el=>[el.dataset.question,el.value.trim()]));
  }
  function launch(host,{business='Eksempelbedriften',profile}={}) {
    if(!host || privateMode)return;
    const services=[{id:'selected',label:'Tjenesten kunden ønsker'}];
    const form=S.normalizeForm(profile||{kind:'quote',requireEmail:true,requirePhone:false,questions:[{id:'need',label:'Hva ønsker du hjelp med?',type:'text',required:true}]},services);
    const state={request:null,quote:null,version:0,question:'',clarification:'',history:[],draft:null};
    const demoRequest={name:'Kari Eksempel',email:'kari@example.invalid',phone:'',answers:{need:'Jeg ønsker et tilbud på tjenesten vi har snakket om.'}};
    function intake(){
      const card=frame(host,'KUNDEN','Be om et prisforslag','Kunden velger selv å gå videre. Bedriften bestemmer hvilke opplysninger som er nødvendige ved oppsett.');
      const editor=node('form');editor.className='qf-form';const name=field(editor,'Navn','name',state.request?.name||demoRequest.name);name.minLength=2;name.maxLength=100;
      const email=field(editor,'E-post for svar og prisforslag','email',state.request?.email||demoRequest.email,'email');
      const phone=field(editor,form.requirePhone?'Telefon':'Telefon (valgfritt)','phone',state.request?.phone||'','tel',form.requirePhone);phone.maxLength=30;
      const read=mountFields(editor,form,'selected',state.request?.answers||demoRequest.answers);
      const check=approval(editor,'Jeg bruker eksempelopplysninger og ønsker å se forespørselen før den registreres i demoen.');
      const submit=node('button','Se over forespørselen','qf-primary');submit.type='submit';editor.append(submit);
      editor.addEventListener('submit',e=>{e.preventDefault();e.stopPropagation();if(!editor.reportValidity()||!check.checked)return;try{
        const answers=read(),details=S.validateAnswers(form,'selected',answers);const value=phone.value.trim();if(value&&(!/^[+\d ()-]{6,30}$/.test(value)||value.replace(/\D/g,'').length<6||value.replace(/\D/g,'').length>15))throw new Error();
        state.request={name:name.value.trim(),email:email.value.trim(),phone:value,answers,details};review();
      }catch{error(card,'Kontroller de nødvendige opplysningene.');}});card.append(editor);
    }
    function review(){const card=frame(host,'KUNDEN','Er dette riktig?','Dette er opplysningene bedriften får. Du kan endre dem før du går videre.');
      summary(card,[['Navn',state.request.name],['E-post',state.request.email],['Telefon',state.request.phone],...state.request.details.map(d=>[d.label,d.value])]);
      actions(card,button('Send eksempelhenvendelse',received),button('Endre opplysninger',intake,true));}
    function received(){const card=frame(host,'BEKREFTELSE','Forespørselen er registrert i demoen','Bedriften får ett varsel og én henvendelse å følge opp. Kunden trenger ikke holde chatten åpen.');
      summary(card,[['Henvendelse','DEMO-001'],['Neste steg','Bedriften vurderer behovet'],['Eksempel på e-postvarsel','Ny forespørsel om prisforslag – åpne henvendelsen']]);
      actions(card,button('Se som bedriften',owner));}
    function owner(){const card=frame(host,'BEDRIFTEN','Vurder behovet og sett prisen','Den samme henvendelsen følger hele veien. Bare bedriften bestemmer pris, omfang og vilkår.');
      summary(card,[['Kunde',state.request.name],['E-post',state.request.email],...state.request.details.map(d=>[d.label,d.value]),['Kundens avklaring',state.clarification]]);
      const editor=node('form');editor.className='qf-form';const previous=state.draft||state.quote||{};
      const title=field(editor,'Hva gjelder forslaget?','title',previous.title||'Et tilpasset tjenesteforslag');title.maxLength=120;title.minLength=3;
      const description=field(editor,'Hva er inkludert, og hva må avtales?','description',previous.description||'Tjenesten utføres som beskrevet i forespørselen. Endelig tidspunkt avtales etter avklaring.','textarea');description.minLength=10;
      const amount=field(editor,'Totalpris i NOK · fiktiv demopris','amount',previous.totalOre!==undefined?String(previous.totalOre/100):'2500');amount.inputMode='decimal';
      const check=approval(editor,'Jeg har kontrollert pris og omfang og godkjenner dette eksempelforslaget.');
      const send=node('button','Godkjenn og send eksempelforslag','qf-primary');send.type='submit';editor.append(send);
      editor.addEventListener('submit',e=>{e.preventDefault();e.stopPropagation();if(!editor.reportValidity()||!check.checked)return;try{
        const totalOre=S.parseAmount(amount.value);state.quote=Object.freeze({id:'DEMO-001-v'+(++state.version),version:state.version,title:title.value.trim(),description:description.value.trim(),totalOre,priceBasis:'incl_vat',expiresAt:new Date(Date.now()+7*86400000).toISOString(),state:'open',response:null});
        state.history.push(state.quote);state.draft=null;customer();
      }catch{error(card,'Oppgi en gyldig totalpris i kroner, med høyst to desimaler.');}});card.append(editor);
      actions(card,button('Be om mer informasjon',()=>{try{state.draft={title:title.value,description:description.value,totalOre:S.parseAmount(amount.value)};}catch{state.draft={title:title.value,description:description.value};}clarifyOwner();},true));
    }
    function clarifyOwner(){const card=frame(host,'BEDRIFTEN','Avklar før du priser','Spørsmålet og svaret blir del av den samme henvendelsen.');const editor=node('form');const q=field(editor,'Spørsmål til kunden','question',state.question||'Når ønsker du at dette gjennomføres?','textarea');q.maxLength=800;
      const b=node('button','Send eksempelspørsmål','qf-primary');b.type='submit';editor.append(b);editor.addEventListener('submit',e=>{e.preventDefault();e.stopPropagation();if(!editor.reportValidity())return;state.question=q.value.trim();clarifyCustomer();});card.append(editor);}
    function clarifyCustomer(){const card=frame(host,'KUNDEN','Bedriften har et spørsmål',state.question);const editor=node('form');const a=field(editor,'Din avklaring','answer',state.clarification||'Neste uke passer fint.','textarea');a.maxLength=800;
      const b=node('button','Send eksempelavklaring','qf-primary');b.type='submit';editor.append(b);editor.addEventListener('submit',e=>{e.preventDefault();e.stopPropagation();if(!editor.reportValidity())return;state.clarification=a.value.trim();owner();});card.append(editor);}
    function customer(){const card=frame(host,'KUNDEN','Prisforslaget er klart','Kunden får en privat lenke tilbake til forslaget. Her ser du det som et eksempel, uten at e-post sendes.');
      renderOffer(card,state.quote,(response,note)=>{if(state.quote.state!=='open')return;state.quote=Object.freeze({...state.quote,state:'responded',response,responseNote:note});result();});}
    function result(){const card=frame(host,'BEDRIFTEN','Kunden har svart',responses[state.quote.response]);
      summary(card,[['Henvendelse','DEMO-001'],['Kunde',state.request.name],['Prisforslag','Versjon '+state.quote.version],['Totalpris',money(state.quote.totalOre)],['Kundens beskjed',state.quote.responseNote||''],['Neste handling',state.quote.response==='declined'?'Avklar avslutning':'Følg opp personlig og avklar neste steg']]);
      card.append(node('p','Dette er ikke registrert som et betalt salg eller en bekreftet booking.','qf-notice'));
      actions(card,button(state.quote.response==='changes'?'Revider prisforslaget':'Se eller endre prisforslaget',owner),button('Start demoen på nytt',()=>launch(host,{business,profile}),true));}
    intake();
    return {getState:()=>structuredClone(state)};
  }
  function renderOffer(card,offer,onResponse) {
    summary(card,[['Forslag',offer.title],['Totalpris',money(offer.totalOre)+(offer.priceBasis==='incl_vat'?' inkl. mva.':' · mva. ikke beregnet')],['Omfang og vilkår',offer.description],['Versjon',offer.version],['Svarfrist',new Intl.DateTimeFormat('nb-NO',{dateStyle:'medium',timeZone:'Europe/Oslo'}).format(new Date(offer.expiresAt))]]);
    if(offer.state==='responded'){card.append(node('p','Registrert svar: '+responses[offer.response],'qf-success'));if(offer.responseNote)card.append(node('p',offer.responseNote));return;}
    if(offer.state!=='open'){card.append(node('p','Forslaget er ikke lenger åpent. Be bedriften om et oppdatert forslag.','qf-notice'));return;}
    const form=node('form');form.className='qf-form';const label=node('label',undefined,'qf-field');label.append(node('span','Hva ønsker du å gjøre?'));
    const select=node('select');select.name='response';select.required=true;select.append(new Option('Velg et svar',''));
    for(const [value,text]of Object.entries(responses))select.append(new Option(text,value));label.append(select);form.append(label);
    const note=field(form,'Spørsmål eller beskjed (valgfritt)','note','','textarea',false);note.maxLength=800;
    select.addEventListener('change',()=>{note.required=select.value==='changes';});
    const check=approval(form,'Jeg har lest forslaget. Svaret mitt er ikke en betaling eller en bekreftet time.');
    const submit=node('button','Send tilbakemelding','qf-primary');submit.type='submit';form.append(submit);
    form.addEventListener('submit',async e=>{e.preventDefault();e.stopPropagation();if(!form.reportValidity()||!check.checked||submit.disabled)return;
      if(!Object.hasOwn(responses,select.value))return;
      submit.disabled=true;try{await onResponse(select.value,note.value.trim());}catch(e){error(card,e.message);} });card.append(form);
  }
  async function mountPrivate(host) {
    document.body.dataset.privateOffer='true';
    const mainForm=document.getElementById('chat-form');if(mainForm)mainForm.hidden=true;
    document.getElementById('chat-tools')?.setAttribute('hidden','');
    let busy=false,pending=null,current=null;
    const client=location.pathname.split('/').filter(Boolean)[1];
    async function api(path,body={}) {
      const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
      try{const r=await fetch('/api/offers/'+path,{method:'POST',credentials:'omit',cache:'no-store',headers:{'Content-Type':'application/json'},signal:controller.signal,body:JSON.stringify({token:privateToken,...body})});
        const data=await r.json();if(!r.ok)throw new Error(['offer_unavailable','request_not_found'].includes(data.error)?'Lenken er utløpt, erstattet eller ikke tilgjengelig. Be bedriften om et nytt forslag.':data.error==='response_conflict'?'Et svar er allerede registrert. Kontroller status før du gjør noe mer.':'Kunne ikke bekrefte handlingen. Kontroller status før du prøver igjen.');return data;
      }finally{clearTimeout(timer);}
    }
    async function refresh(){if(busy)return;busy=true;let card=frame(host,'PRISFORSLAG','Henter prisforslaget','Ingen opplysninger deles med demoens analyseverktøy.',false);
      try{if(!/^[a-f0-9]{64}$/.test(privateToken))throw new Error('Ugyldig privat lenke. Be bedriften om et nytt prisforslag.');
        const data=await api('read');if(data.client!==client)throw new Error('Denne lenken tilhører en annen bedrift. Åpne den opprinnelige lenken fra e-posten.');
        const q=data.offer;if(!q||typeof q.title!=='string'||typeof q.description!=='string'||!Number.isSafeInteger(q.totalOre)||q.totalOre<0||!Number.isFinite(Date.parse(q.expiresAt))||!Number.isInteger(q.version))throw new Error('Prisforslaget kunne ikke leses.');
        current=q;const status=document.getElementById('status-label');if(status)status.textContent='Privat prisforslag';for(const id of ['business-name','assistant-label']){const el=document.getElementById(id);if(el)el.textContent=data.business;}
        const description=document.getElementById('business-description');if(description)description.textContent='Din private henvendelse og bedriftens prisforslag.';
        card=frame(host,'KUNDEN',data.business,'Les pris og omfang før du svarer. Booking og betaling avklares separat.',false);
        renderOffer(card,q,respond);
        if(pending&&q.state==='open'){card.querySelector('form')?.remove();card.append(node('p','Forrige innsending var uavklart. Du kan sende nøyaktig samme svar på nytt.','qf-notice'));actions(card,button('Send samme svar igjen',()=>respond(pending.response,pending.note)));}
        if(q.state==='responded')pending=null;
      }catch(e){error(card,e.name==='AbortError'?'Forbindelsen tok for lang tid. Kontroller status igjen.':e.message);}
      finally{busy=false;actions(card,button('Kontroller lagret svar',refresh,true));}
    }
    async function respond(response,note){if(busy||current?.state!=='open')return;busy=true;pending ||= {response,note};
      const card=host.querySelector('.quote-flow');card?.querySelectorAll('button,input,select,textarea').forEach(n=>n.disabled=true);
      try{await api('respond',pending);pending=null;}catch(e){error(card,'Svaret kan være lagret, men bekreftelsen mangler. Kontroller status før du prøver igjen.');}
      finally{busy=false;await refresh();}
    }
    await refresh();
  }
  window.JemlioQuoteFlow={privateMode,launch,mountFields,mountPrivate};
  const setup=()=>{document.getElementById('quote-flow-launcher')?.addEventListener('click',()=>launch(document.getElementById('demo-messages')));};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',setup,{once:true});else setup();
})();
