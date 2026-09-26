'use strict';
const assert=require('node:assert/strict'),{readFileSync}=require('node:fs'),{join}=require('node:path'),{JSDOM}=require('jsdom');
const html=readFileSync(join(__dirname,'../public/journey/index.html'),'utf8'),js=readFileSync(join(__dirname,'../public/journey/app.js'),'utf8');
for(const response of ['interested','changes','declined']){
 const dom=new JSDOM(html,{url:'https://example.invalid/journey-demo',runScripts:'outside-only'}),w=dom.window,d=w.document;let calls=0;w.fetch=()=>{calls++;throw Error('network forbidden');};w.eval(js);
 const act=()=>d.querySelector('#actions button').click(),next=()=>act();
 assert.equal(d.querySelectorAll('#steps button:disabled').length,4);act();next();assert.match(d.getElementById('summary').textContent,/Registrert/);
 d.querySelector('[value="Onsdag kl. 10:30"]').checked=true;act();next();assert.match(d.getElementById('summary').textContent,/Onsdag kl. 10:30/);
 act();next();d.querySelector(`[value=${response}]`).checked=true;act();assert.match(d.getElementById('alert-title').textContent,/Nytt svar/);assert.match(d.getElementById('summary').textContent,/Salgsverdi0 kr/);next();
 act();assert.match(d.getElementById('feedback').textContent,/Bekreft/);assert.match(d.getElementById('summary').textContent,/Salgsverdi0 kr/);
 d.getElementById('verified').checked=true;if(response==='changes')d.querySelector('[value=followup]').checked=true;act();
 assert.match(d.getElementById('summary').textContent,response==='interested'?/8 900 kr · manuelt registrert/:response==='changes'?/avtalt tidspunkt/:/Avsluttet/);
 assert.equal(d.querySelectorAll('#timeline li').length,5);assert.ok([...d.querySelectorAll('.person h2')].every(e=>e.textContent==='Nora Eksempel'));
 const conversion=d.querySelector('#actions a');assert.equal(conversion.textContent,'Se dette med min bedrift ↗');assert.equal(conversion.href,'https://www.jemlio.com/#contact');
 d.querySelector('#steps button').click();assert.match(d.getElementById('actions').textContent,/Neste/);assert.equal(d.querySelectorAll('#timeline li').length,5);
 d.getElementById('reset').click();assert.equal(d.querySelectorAll('#steps button:disabled').length,4);assert.match(d.getElementById('summary').textContent,/Ikke registrert/);assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);assert.equal(calls,0);w.close();
 console.log('ok - one connected customer, guarded outcome, reset and zero network: '+response);
}
const {answer}=require('../clients/jemlio/answer');for(const tenant of ['jemlio','jemlio-driving-demo','jemlio-optician-demo']){assert.match(answer(tenant,'Kan jeg prøve hele kundereisen?').reply,/journey-demo/);assert.match(answer(tenant,'Hvordan fungerer eiervarsler?').reply,/mottaker|Mottaker/);}
console.log('ok - public product explanations link to journey and qualify alert activation');
