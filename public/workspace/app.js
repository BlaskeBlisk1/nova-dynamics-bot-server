(() => {
  'use strict';
  const $=id=>document.getElementById(id), demo=/^\/workspace-demo\/?$/.test(location.pathname);
  const names={new:'Ny',contacted:'Kontaktet',qualified:'Avklart behov',won:'Vunnet',lost:'Avsluttet uten salg'};
  const bookings={not_booked:'Ingen bekreftet avtale',attempting:'Booking behandles',needs_review:'Booking må kontrolleres',rejected:'Booking ble ikke bekreftet',confirmed:'Bekreftet avtale',completed:'Gjennomført',cancelled:'Avlyst',no_show:'Ikke møtt'};
  let csrf='',rows=[],chosen=null,page=0,hasMore=false,dirty=false,busy=false,view='due',examples=[],generation=0,loadId=0;
  const date=value=>value?new Intl.DateTimeFormat('nb-NO',{dateStyle:'short',timeStyle:'short',timeZone:'Europe/Oslo'}).format(new Date(value)):'Ikke satt';
  const money=ore=>new Intl.NumberFormat('nb-NO',{style:'currency',currency:'NOK',maximumFractionDigits:2}).format(ore/100);
  function node(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
  function message(text,error=false){$(error?'error':'status').textContent=text;$(error?'status':'error').textContent='';}
  const errors={unauthorized:'Økten er utløpt. Logg inn igjen.',invalid_login:'Tilgangsnøkkelen stemmer ikke.',forbidden:'Forespørselen ble ikke godkjent. Last siden på nytt og logg inn igjen.',rate_limited:'For mange forsøk. Vent litt før du prøver igjen.',unavailable:'Oversikten er ikke tilgjengelig nå. Kontakt Jemlio hvis dette fortsetter.',conflict:'Denne henvendelsen er endret siden du åpnet den. Noter dine endringer og oppdater oversikten før du lagrer igjen.',verification_required:'Bekreft at resultatet er kontrollert.',request_closed:'Avslutt oppfølgingen før du lukker henvendelsen.',confirmed_booking_required:'Kontroller bookingstatus i bookingsystemet før du registrerer dette.',appointment_not_started:'Avtalen har ikke startet ennå.',invalid_request:'Kontroller feltene før du lagrer.',invalid_amount:'Oppgi et gyldig salgsbeløp.'};
  function clearPrivate(){generation++;csrf='';rows=[];chosen=null;dirty=false;page=0;for(const id of ['detail','list','metrics'])$(id).replaceChildren();$('business').textContent='JEMLIO';$('app').hidden=true;$('login').hidden=false;$('logout').hidden=true;$('refresh').hidden=true;}
  async function api(path,body){
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),12000);
    try {const r=await fetch('/api/workspace'+path,{method:body?'POST':'GET',credentials:'same-origin',cache:'no-store',headers:body?{'Content-Type':'application/json','X-Jemlio-CSRF':csrf}:{},body:body?JSON.stringify(body):undefined,signal:controller.signal});
      const data=await r.json();if(!r.ok){if(data.error==='unauthorized')clearPrivate();const e=new Error(errors[data.error]||'Handlingen kunne ikke fullføres.');e.code=data.error;throw e;}return data;
    }catch(e){if(e.name==='AbortError'||e instanceof TypeError)throw new Error(body?'Forbindelsen ble brutt. Oppdater oversikten for å kontrollere om endringen ble lagret før du prøver igjen.':'Kunne ikke hente oversikten. Prøv å oppdatere igjen.');throw e;}finally{clearTimeout(timer);}
  }
  function seed(){const now=Date.now();examples=[
    {id:'example-1',name:'Eksempel: Nora',email:'nora@example.invalid',phone:'',service:'Vurdering av PPF',message:'Jeg ønsker å vite hvilken behandling som passer bilen min.',outcome:'new',note:'',createdAt:new Date(now-2*86400000).toISOString(),booking:{status:'not_booked',slot:null},followup:{action:'callback',due:new Date(now-3600000).toISOString(),overdue:true},amountOre:null,revision:'example-1'},
    {id:'example-2',name:'Eksempel: Emil',email:'emil@example.invalid',phone:'',service:'Keramisk coating',message:'Ønsker befaring før tilbud.',outcome:'contacted',note:'Ring etter kl. 14, som avtalt i dette eksempelet.',createdAt:new Date(now-86400000).toISOString(),booking:{status:'confirmed',slot:new Date(now-3600000).toISOString()},followup:{action:'done',due:null,overdue:false},amountOre:null,revision:'example-2'},
    {id:'example-3',name:'Eksempel: Alex',email:'alex@example.invalid',phone:'',service:'Vurdering av bilen',message:'Bookingsystemet ga ikke et sikkert svar.',outcome:'new',note:'Kontroller kalenderen før kunden får en bekreftelse.',createdAt:new Date(now-7200000).toISOString(),booking:{status:'needs_review',slot:new Date(now+86400000).toISOString()},followup:{action:'reconcile',due:new Date(now-7200000).toISOString(),overdue:true},amountOre:null,revision:'example-3'}];}
  function demoReport(){return {enquiries:examples.length,confirmed:examples.filter(r=>r.booking.status==='confirmed').length,completed:examples.filter(r=>r.booking.status==='completed').length,needs_review:examples.filter(r=>r.booking.status==='needs_review').length,won:examples.filter(r=>r.outcome==='won').length,sales_ore:String(examples.filter(r=>r.outcome==='won').reduce((s,r)=>s+(r.amountOre||0),0))};}
  function metrics(r){$('metrics').replaceChildren();for(const [label,value] of [['Henvendelser',r.enquiries],['Bekreftede avtaler',r.confirmed],['Må kontrolleres',r.needs_review],['Vunnet',r.won],['Registrert salgsverdi',money(Number(r.sales_ore))]]){const el=node('div',undefined,'metric');el.append(node('strong',String(value)),node('span',label));$('metrics').append(el);}}
  function list(){ $('list').replaceChildren();if(!rows.length)$('list').append(node('p','Ingen henvendelser i denne visningen.','empty'));
    for(const r of rows){const b=node('button',undefined,'row');b.type='button';b.setAttribute('aria-pressed',String(chosen?.id===r.id));b.append(node('strong',r.name||'Uten navn'),node('small',r.service),node('span',r.followup.overdue?'Trenger oppfølging':names[r.outcome],'tag'+(r.followup.overdue?' urgent':'')),node('small',r.followup.due?'Neste steg: '+date(r.followup.due):'Mottatt '+date(r.createdAt)));b.addEventListener('click',()=>{if(discard()){chosen=r;renderDetail();list();}});$('list').append(b);}
    $('previous').disabled=page===0||busy;$('next').disabled=!hasMore||busy;$('page-label').textContent='Side '+(page+1);
  }
  function discard(){if(busy)return false;if(dirty&&!window.confirm('Du har endringer som ikke er lagret. Vil du forkaste dem?'))return false;dirty=false;return true;}
  function field(form,label,id,type='text'){const l=node('label',label);l.htmlFor=id;const input=node(type==='textarea'?'textarea':'input');input.id=id;if(type!=='textarea')input.type=type;form.append(l,input);return input;}
  function select(form,label,id,options,value){const l=node('label',label);l.htmlFor=id;const s=node('select');s.id=id;for(const [v,t] of options){const o=node('option',t);o.value=v;s.append(o);}s.value=value;form.append(l,s);return s;}
  function renderDetail(){const box=$('detail');box.replaceChildren();dirty=false;if(!chosen){box.append(node('p','Velg en henvendelse for å se detaljer og neste steg.','empty'));return;}
    const r=chosen;box.append(node('p',r.service,'eyebrow'),node('h2',r.name||'Henvendelse'),node('p','Mottatt '+date(r.createdAt),'muted'));
    const links=node('div',undefined,'contact-links');
    for(const [value,kind] of [[r.email,'mailto:'],[r.phone,'tel:']]){if(!value)continue;const valid=kind==='mailto:'?/^[^\s@?\r\n]+@[^\s@?\r\n]+$/.test(value):/^\+?[\d ()-]{3,30}$/.test(value);if(valid&&!demo){const a=node('a',value);a.href=kind+encodeURIComponent(value);links.append(a);}else links.append(node('span',value));}box.append(links);
    if(r.message)box.append(node('p',r.message,'customer-message'));
    box.append(node('p',bookings[r.booking.status]+(r.booking.slot?' · '+date(r.booking.slot):''),'tag'));
    if(r.booking.status==='needs_review'||r.booking.status==='attempting')box.append(node('p','Kontroller den faktiske kalenderen med Jemlio. Ikke send kunden en ny bookingbekreftelse eller be kunden bestille på nytt. Denne saken blir stående til bookingstatus er avklart.','attention'));
    const form=node('form');form.id='edit-form';
    const outcome=select(form,'Status','outcome',Object.entries(names),r.outcome);
    const note=field(form,'Internt notat','note','textarea');note.value=r.note;note.maxLength=2000;form.append(node('p','Skriv praktiske oppfølgingsnotater. Unngå helseopplysninger og andre sensitive detaljer.','muted'));
    const follow=select(form,'Neste handling','follow-action',[['keep','Behold neste handling'],['callback','Ring kunden'],['review','Se over henvendelsen'],['done','Ingen videre oppfølging']], 'keep');
    // The browser converts local input to UTC. Show its timezone explicitly.
    const due=field(form,'Tidspunkt for neste handling (din enhets lokale tid)','follow-due','datetime-local');due.step='60';
    const zone=Intl.DateTimeFormat().resolvedOptions().timeZone;form.append(node('p','Inntasting: '+zone+'. Oversikten viser Europe/Oslo.','muted'));
    follow.addEventListener('change',()=>{due.required=['callback','review'].includes(follow.value);due.disabled=!due.required;});due.disabled=true;
    if(r.booking.status==='confirmed'){select(form,'Registrer observert avtaleresultat','appointment',[['keep','Behold avtalen'],['completed','Gjennomført'],['cancelled','Avlyst i bookingsystemet'],['no_show','Kunden møtte ikke']], 'keep');}
    const amount=field(form,'Registrert salgsverdi i NOK (valgfritt)','amount','text');amount.inputMode='decimal';amount.placeholder='For eksempel 2500,00';amount.value=r.amountOre===null||r.outcome!=='won'?'':String(r.amountOre/100).replace('.',',');
    form.append(node('p','Beløpet er en manuelt registrert salgsverdi. Ingen betaling trekkes. Velg «Vunnet» for å registrere en verdi.','muted'));
    const verifyLabel=node('label',undefined,'check-label'),verified=node('input');verified.type='checkbox';verified.id='verified';verifyLabel.append(verified,node('span','Jeg har kontrollert et eventuelt vunnet salg, beløp eller avtaleresultat.'));form.append(verifyLabel);
    const actions=node('div',undefined,'form-actions'),save=node('button',demo?'Lagre eksempel':'Lagre endringer','primary');save.type='submit';save.id='save';actions.append(save,node('span','Sender ingen meldinger.','muted'));form.append(actions);
    form.addEventListener('input',()=>{dirty=true;});form.addEventListener('change',()=>{dirty=true;});form.addEventListener('submit',saveChanges);box.append(form);
  }
  function parseAmount(value){if(!/^\d{1,9}(?:[.,]\d{1,2})?$/.test(value))throw new Error('Oppgi beløpet som kroner, med høyst to desimaler.');const [kr,ore='']=value.replace(',','.').split('.');const result=Number(kr)*100+Number(ore.padEnd(2,'0'));if(result>10000000000)throw new Error('Beløpet er for stort.');return result;}
  async function saveChanges(e){e.preventDefault();if(busy||!chosen)return;const r=chosen;
    try{const body={revision:r.revision,note:$('note').value,outcome:$('outcome').value};const a=$('follow-action').value;
      if(a!=='keep'){body.followup={action:a};if(a!=='done'){const input=$('follow-due').value,dt=new Date(input);if(!input||!Number.isFinite(dt.getTime()))throw new Error('Velg dato og tidspunkt.');body.followup.due=dt.toISOString();}}
      const value=$('amount').value.trim();if(value && (r.amountOre===null||parseAmount(value)!==r.amountOre))body.amountOre=parseAmount(value);
      if(r.amountOre!==null&&r.outcome==='won'&&!value)throw new Error('Sett beløpet til 0 for å korrigere verdien, eller behold det registrerte beløpet.');
      if($('appointment')&&$('appointment').value!=='keep')body.appointmentStatus=$('appointment').value;
      body.verified=$('verified').checked;
      if((body.outcome==='won'||body.amountOre!==undefined||body.appointmentStatus)&&!body.verified)throw new Error(errors.verification_required);
      if(body.amountOre!==undefined&&body.outcome!=='won')throw new Error('Velg «Vunnet» før du registrerer en salgsverdi.');
      if(['won','lost'].includes(body.outcome)&&body.followup&&body.followup.action!=='done')throw new Error(errors.request_closed);
      busy=true;$('save').disabled=true;message('Lagrer …');
      if(demo){r.outcome=body.outcome;r.note=body.note;if(body.amountOre!==undefined)r.amountOre=body.amountOre;if(body.appointmentStatus)r.booking.status=body.appointmentStatus;
        if(body.followup)r.followup={...body.followup,due:body.followup.due||null,overdue:Boolean(body.followup.due&&Date.parse(body.followup.due)<=Date.now())};
        if(['won','lost'].includes(r.outcome)&&r.booking.status!=='needs_review')r.followup={action:'done',due:null,overdue:false};
        if(r.booking.status==='needs_review')r.followup={action:'reconcile',due:r.createdAt,overdue:true};r.revision+='x';
      }else await api('/enquiries/'+encodeURIComponent(r.id),body);
      dirty=false;await load();message(demo?'Eksempelet er lagret i denne økten.':'Endringene er lagret.');
    }catch(err){message(err.message,true);}finally{busy=false;if($('save'))$('save').disabled=false;list();}
  }
  async function load(){const version=generation,request=++loadId,id=chosen?.id;let data,report;if(demo){let items=examples.filter(r=>view==='all'||view==='due'&&r.followup.overdue||view==='open'&&!['won','lost'].includes(r.outcome)||view===r.outcome);data={items,hasMore:false};report=demoReport();}else{[data,report]=await Promise.all([api('/enquiries?view='+view+'&page='+page),api('/report')]);}
    if(version!==generation||request!==loadId)return;rows=data.items;hasMore=data.hasMore;chosen=rows.find(r=>r.id===id)||null;metrics(report);renderDetail();list();
  }
  async function enter(session){csrf=session.csrf||'';$('business').textContent=session.name;$('login').hidden=true;$('app').hidden=false;$('refresh').hidden=false;$('logout').hidden=demo;await load();}
  $('login-form').addEventListener('submit',async e=>{e.preventDefault();if(busy)return;busy=true;const button=e.currentTarget.querySelector('button');button.disabled=true;try{const key=$('access-key').value.trim();const session=await api('/login',{key});$('access-key').value='';await enter(session);message('Du er logget inn.');}catch(err){message(err.message,true);}finally{busy=false;button.disabled=false;}});
  $('logout').addEventListener('click',async()=>{if(!discard())return;try{await api('/logout',{});clearPrivate();message('Du er logget ut.');}catch(e){message(e.message,true);}});
  $('view').addEventListener('change',async()=>{if(!discard()){$('view').value=view;return;}view=$('view').value;page=0;chosen=null;try{await load();message('');}catch(e){message(e.message,true);}});
  $('refresh').addEventListener('click',async()=>{if(!discard())return;try{await load();message('Oversikten er oppdatert.');}catch(e){message(e.message,true);}});
  for(const [id,delta]of[['previous',-1],['next',1]])$(id).addEventListener('click',async()=>{if(!discard())return;page+=delta;chosen=null;try{await load();}catch(e){page-=delta;message(e.message,true);}});
  $('reset-demo').addEventListener('click',async()=>{if(!discard())return;seed();chosen=null;page=0;await load();message('Eksemplene er nullstilt.');});
  window.addEventListener('pageshow',e=>{if(e.persisted&&!demo){clearPrivate();api('/session').then(enter).catch(err=>message(err.message,true));}});
  window.addEventListener('beforeunload',e=>{if(dirty){e.preventDefault();e.returnValue='';}});
  if(demo){seed();$('demo-notice').hidden=false;$('reset-demo').hidden=false;enter({name:'EKSEMPEL BILPLEIE · FIKTIVE DATA'}).catch(e=>message(e.message,true));}
  else api('/session').then(enter).catch(e=>{$('login').hidden=false;if(e.code!=='unauthorized')message(e.message,true);});
})();
