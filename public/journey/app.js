(() => {
  'use strict';
  const $=id=>document.getElementById(id),labels=['Henvendelse','Booking','Prisforslag','Kundesvar','Resultat'];
  let step=0,unlocked=0,state;
  const text=(tag,value,cls)=>{const n=document.createElement(tag);n.textContent=value;if(cls)n.className=cls;return n;};
  function button(label,fn,secondary=false){const b=text('button',label,secondary?'secondary':'');b.type='button';b.addEventListener('click',fn);$('actions').append(b);return b;}
  function paragraph(value){$('content').append(text('p',value));}
  function box(title,body,cls='message'){const n=text('div','',cls);n.append(text('strong',title),text('p',body));$('content').append(n);return n;}
  function choices(name,options,value){const wrap=text('div','','choices');wrap.setAttribute('role','radiogroup');wrap.setAttribute('aria-label',{slot:'Velg en eksempeltid',response:'Noras tilbakemelding',outcome:'Avklart eksempelresultat'}[name]);for(const [v,label] of options){const l=text('label',''),r=document.createElement('input');r.type='radio';r.name=name;r.value=v;r.checked=v===value;l.append(r,text('span',label));wrap.append(l);}$('content').append(wrap);}
  function go(n){step=n;render();$('stage-title').focus({preventScroll:true});$('stage-title').scrollIntoView?.({block:'nearest'});}
  function advance(label,event){state.events.push(event);unlocked=Math.max(unlocked,step+1);render();$('feedback').textContent=label;$('actions').querySelector('button')?.focus({preventScroll:true});}
  function next(){button('Neste: '+labels[step+1]+' →',()=>go(step+1));}
  function render(){
    $('content').replaceChildren();$('actions').replaceChildren();$('steps').replaceChildren();$('feedback').textContent='';
    labels.forEach((label,i)=>{const b=text('button',`${i+1}. ${label}`);b.type='button';b.disabled=i>unlocked;b.setAttribute('aria-current',step===i?'step':'false');b.addEventListener('click',()=>go(i));$('steps').append(b);});
    $('perspective').textContent=['KUNDENS FØRSTE KONTAKT','KUNDEN VELGER TID','BEDRIFTEN FORESLÅR','KUNDEN GIR TILBAKEMELDING','BEDRIFTEN AVKLARER RESULTATET'][step];
    $('stage-title').textContent=['«Hva passer bilen min?»','Fra spørsmål til befaring.','Et konkret forslag til Nora.','Svaret lander hos eieren.','Et svar er starten på en samtale.'][step];
    if(step===0){
      paragraph('Nora vurderer keramisk coating og spør på nettsiden. Bedriften får én samlet henvendelse å følge opp.');
      box('Nora Eksempel','Hei! Jeg vil beskytte lakken på bilen min. Kan dere vurdere bilen og foreslå en behandling?');
      box('Jemlio · eksempel','Vi kan starte med en befaring. Da kan bedriften vurdere bilens tilstand før dere avklarer behandling og pris.');
      if(!state.enquiry)button('Registrer Noras eksempelhenvendelse',()=>{state.enquiry=true;advance('Henvendelsen er registrert.','Noras spørsmål er samlet i én henvendelse.');});
      else{paragraph('Henvendelsen er registrert i dette eksemplet. Nora følger med videre gjennom hele reisen.');next();}
    }
    if(step===1){
      paragraph('Nora velger en eksempelavtale for befaring. I en pilot må bedriftens bookingkonto kobles til og kontrolleres før ekte tider kan bekreftes.');
      if(!state.booking){choices('slot',[['Tirsdag kl. 14:00','Tirsdag · 14:00–14:30'],['Onsdag kl. 10:30','Onsdag · 10:30–11:00']],'Tirsdag kl. 14:00');button('Bekreft eksempelavtalen',()=>{state.booking=document.querySelector('[name=slot]:checked').value;advance('Eksempelavtalen er bekreftet.',`Eksempelbefaring: ${state.booking}.`);});}
      else{box('Bekreftet i demoen',`${state.booking} · Befaring hos Eksempel Bilpleie. Samme henvendelse, samme kunde.`);next();}
    }
    if(step===2){
      paragraph('Etter eksempelbefaringen vurderer bedriften behovet og lager et prisforslag. Eieren kontrollerer innholdet og deler lenken med Nora.');
      const p=box('Keramisk coating etter befaring','Vask, klargjøring og keramisk behandling av personbil. Tidspunkt og endelig omfang avtales direkte.','proposal');p.append(text('p','8 900 kr','price'),text('small','Fiktiv eksempelpris inkl. mva. Ikke Jemlios pris.'));
      if(!state.offer)button('Kontroller og opprett eksempelforslaget',()=>{state.offer=true;advance('Forslaget er klart.','Prisforslag på 8 900 kr opprettet etter eksempelbefaring.');});else{paragraph('I neste steg åpner du Noras kundeside. Ingen lenke eller e-post er sendt.');next();}
    }
    if(step===3){
      paragraph('Nora ser forslaget og gir beskjed om hva hun ønsker. Eieren får et varsel og en oppgave i arbeidsoversikten.');
      if(!state.response){choices('response',[['interested','Jeg ønsker å gå videre'],['changes','Jeg ønsker å diskutere omfanget først'],['declined','Ikke aktuelt nå']],'interested');button('Gi Noras eksempeltilbakemelding',()=>{state.response=document.querySelector('[name=response]:checked').value;advance('Eksempelsvaret er registrert.',{interested:'Nora ønsker å gå videre. Eieren må avklare oppdraget.',changes:'Nora ønsker å diskutere omfanget. Eieren må følge opp.',declined:'Nora sier det ikke er aktuelt nå. Eieren må avklare avslutningen.'}[state.response]);});}
      else{box('Kundesvar registrert',{interested:'«Jeg ønsker å gå videre.»',changes:'«Jeg ønsker å diskutere omfanget først.»',declined:'«Ikke aktuelt nå.»'}[state.response]);paragraph('Se eksempelvarselet i bedriftens oversikt. Kundesvaret registrerer ikke et salg, en ny booking eller en betaling.');next();}
    }
    if(step===4){
      if(!state.outcome){
        paragraph(state.response==='declined'?'Eieren snakker med Nora og avklarer om saken skal avsluttes. Et nei registreres ærlig som avsluttet uten salg.':'Eieren følger opp Nora personlig. Først når dere har avklart oppdraget, kan eieren registrere utfallet.');
        choices('outcome',state.response==='declined'?[['lost','Avslutt uten salg'],['followup','Avtal en senere oppfølging']]:[['won','Registrer et avklart salg · 8 900 kr'],['followup','Avtal en senere oppfølging'],['lost','Avslutt uten salg']],state.response==='declined'?'lost':'won');
        const verify=text('label','','verify'),input=document.createElement('input');input.type='checkbox';input.id='verified';verify.append(input,text('span','Jeg har avklart utfallet med Nora i dette fiktive eksemplet.'));$('content').append(verify);
        button('Lagre eksempelresultatet',()=>{if(!$('verified').checked){$('feedback').textContent='Bekreft at utfallet er avklart i eksemplet før du lagrer.';return;}state.outcome=document.querySelector('[name=outcome]:checked').value;state.events.push({won:'Eieren har bekreftet et eksempelresultat på 8 900 kr.',lost:'Henvendelsen er avsluttet uten salg.',followup:'Ny personlig oppfølging avtalt. Ingen salgsverdi registrert.'}[state.outcome]);render();});
      }else{
        const r=box('Fra første spørsmål til avklart neste steg',{won:'Eieren har registrert et eksempel på et avklart salg.',lost:'Noras henvendelse er avsluttet uten salg.',followup:'Nora skal følges opp igjen. Saken er fortsatt åpen.'}[state.outcome],'result');
        r.append(text('p',state.outcome==='won'?'8 900 kr':'0 kr','price'),text('small','Registrert eksempelverdi. Ikke betaling, fortjeneste eller dokumentert meromsetning.'));
        paragraph('Spørsmålet, befaringen, prisforslaget, kundesvaret og resultatet hører fortsatt til samme henvendelse.');
        const tailor=text('a','Se dette med min bedrift ↗','button');tailor.href='https://www.jemlio.com/#contact';$('actions').append(tailor);
        button('Prøv reisen på nytt',reset,true);
      }
    }
    $('content').append(text('small','Alt du gjør her gjelder bare Nora Eksempel i denne fanen.'));
    const summary=[['Henvendelse',state.enquiry?'Registrert':'Ikke registrert'],['Avtale',state.booking||'Ingen ennå'],['Prisforslag',state.offer?'8 900 kr · eksempel':'Ikke opprettet'],['Neste handling',state.outcome==='won'||state.outcome==='lost'?'Avsluttet':state.outcome==='followup'?'Følg opp på avtalt tidspunkt':state.response?'Følg opp kundesvaret':state.offer?'Avvent Noras svar':state.booking?'Gjennomfør befaring':'Avklar behov'],['Salgsverdi',state.outcome==='won'?'8 900 kr · manuelt registrert':'0 kr']];
    $('summary').replaceChildren(...summary.map(([k,v])=>{const d=text('div','');d.append(text('dt',k),text('dd',v));return d;}));
    $('timeline').replaceChildren(...(state.events.length?state.events:['Reisen starter med Noras spørsmål.']).map(v=>text('li',v)));
    $('alert-title').textContent=state.response?'Nytt svar på et prisforslag':'Ingen varsler ennå';
    $('alert-copy').textContent=state.response?'Eksempel på e-post til eieren: «Et nytt kundesvar trenger personlig oppfølging. Åpne arbeidsoversikten.» Ingen kundedetaljer i e-posten.':'Når Nora svarer på prisforslaget, vises eierens eksempelvarsel her.';
    if(state.response&&!state.outcome){$('alert-copy').append(text('br',''),text('span','Hvis oppgaven fortsatt er forfalt ved dagens oppsummering: «1 henvendelse trenger oppfølging».'));}
  }
  function reset(){state={enquiry:false,booking:null,offer:false,response:null,outcome:null,events:[]};step=0;unlocked=0;render();}
  $('reset').addEventListener('click',reset);reset();
})();
