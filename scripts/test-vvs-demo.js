'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const P=require('../public/marketing/vvs-profile');
const {createUpgradeConfig}=require('../lib/upgrade-config');
const read=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
let checks=0;const test=(name,fn)=>{fn();console.log(`ok ${++checks} - ${name}`);};
function harness(){
 const errors=[],calls=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const dom=new JSDOM(read('public/marketing/index.html'),{url:'https://www.jemlio.com/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window,d=w.document;w.matchMedia=()=>({matches:true});w.HTMLElement.prototype.scrollIntoView=()=>{};w.fetch=(...a)=>{calls.push(a);throw Error('Unexpected network');};
 for(const p of ['quote-schema.js','followup-demo.js','vvs-profile.js','vvs-demo.js','site.js'])w.eval(read('public/marketing/'+p));
 const click=label=>{const b=[...d.querySelectorAll('button')].find(x=>x.textContent===label);assert.ok(b,label);b.click();};
 const set=(key,value)=>{const el=d.querySelector('.vvs-demo [name="'+key+'"]');assert.ok(el,key);el.value=value;el.dispatchEvent(new w.Event('input',{bubbles:true}));el.dispatchEvent(new w.Event('change',{bubbles:true}));};
 const approve=()=>d.querySelector('.vvs-demo [name=approved]').checked=true;
 const send=()=>{click('Gå videre til kontakt');click('Se over forespørselen');approve();click('Registrer eksempelhenvendelsen');};
 const finish=()=>{assert.equal(calls.length,0);assert.deepEqual(errors,[]);assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);w.close();};
 return {d,w,click,set,approve,send,finish};
}
test('VVS configuration is explicit and cannot enable older prospect demos',()=>{
 const getRegistry=()=>({alpha:{name:'Example plumber'},roma:{name:'RoMa'},tiller:{name:'Tiller'}});
 const configured={alpha:{mode:'live',enabled:true,vvs:{postcodes:['0150']},form:P.form()}};
 const env={NOVA_CAPTURE_ENABLED:'true',NOVA_CAPTURE_CONFIG:JSON.stringify(configured)};
 assert.equal(createUpgradeConfig({env,getRegistry}).captureTenant('alpha'),null);
 env.NOVA_VVS_CLIENTS='alpha,roma';const selected=createUpgradeConfig({env,getRegistry});assert.equal(selected.captureTenant('alpha').mode,'live');assert.equal(selected.captureTenant('tiller'),null);assert.equal(selected.captureTenant('roma'),null);
 assert.throws(()=>P.configuration({postcodes:['0150','0150']}));assert.throws(()=>P.configuration({postcodes:['0000']}));assert.throws(()=>P.configuration({postcodes:['0150'],emergencyPhone:'javascript:alert(1)'}));
 assert.throws(()=>P.configuration({postcodes:['0150']},{...P.form(),requirePhone:false}));
});
test('VVS is the working default while legacy tabs still open',()=>{const h=harness();try{assert.equal(h.d.querySelector('[aria-selected=true]').id,'tab-vvs');assert.ok(h.d.querySelector('.vvs-demo'));h.d.getElementById('tab-driving').click();assert.equal(h.d.querySelector('.vvs-demo'),null);h.d.getElementById('tab-workflow').click();assert.ok(h.d.querySelector('.followup-demo'));}finally{h.finish();}});
test('explicit urgent requests and unserved areas cannot proceed as accepted jobs',()=>{const h=harness();try{h.click('Prøv en nettsidehenvendelse');h.set('urgency','Akutt problem nå');h.click('Gå videre til kontakt');assert.match(h.d.querySelector('.fu-error').textContent,/ringe rørlegger/);assert.equal(h.d.querySelector('.vvs-demo [name=name]'),null);h.set('urgency','Planlagt arbeid');h.set('postcode','9999');h.click('Gå videre til kontakt');assert.match(h.d.querySelector('.fu-error').textContent,/utenfor/);}finally{h.finish();}});
test('reviewed job details follow the customer into owner pricing and follow-up',()=>{const h=harness();try{h.click('Prøv en nettsidehenvendelse');h.set('address','Testveien 29');h.send();assert.match(h.d.querySelector('.vvs-demo').textContent,/Testveien 29/);h.click('Lag prisforslag');assert.equal(h.d.querySelector('[name=amount]').value,'');h.set('amount','3 250,50');h.approve();h.click('Godkjenn eksempelforslaget');h.click('Se som kunden');assert.match(h.d.querySelector('.fu-summary').textContent,/3\s*250,50/);h.set('response','interested');h.approve();h.click('Send eksempeltilbakemelding');assert.match(h.d.querySelector('.fu-next').textContent,/Følg opp kundens svar/);assert.doesNotMatch(h.d.querySelector('.fu-badge').textContent,/Avklart oppdrag/);}finally{h.finish();}});
test('missed-call entrance remains simulation and copies no data to external providers',()=>{const h=harness();try{h.click('Se et ubesvart anrop');assert.match(h.d.querySelector('.vvs-demo').textContent,/ikke sendt en SMS/);h.click('Åpne eksempelhenvendelsen');h.send();assert.match(h.d.querySelector('.vvs-demo').textContent,/Ubesvart anrop · simulert/);}finally{h.finish();}});
test('job drafts and owner state survive tab changes, and source text is escaped',()=>{const h=harness();try{h.click('Prøv en nettsidehenvendelse');h.set('problem','Replace a tap <img src=x onerror=alert(1)>');h.d.getElementById('tab-optician').click();h.d.getElementById('tab-vvs').click();assert.match(h.d.querySelector('[name=problem]').value,/<img/);h.send();assert.equal(h.d.querySelector('.vvs-demo img'),null);h.click('Lag prisforslag');h.set('amount','7200');h.d.getElementById('tab-driving').click();h.d.getElementById('tab-vvs').click();assert.equal(h.d.querySelector('[name=amount]').value,'7200');}finally{h.finish();}});
test('cancelled reset retains the case; confirmed reset starts only a fresh example',()=>{const h=harness();try{h.click('Prøv en nettsidehenvendelse');h.send();h.d.getElementById('demo-reset').click();h.click('Behold eksemplet');assert.ok(h.d.querySelector('.vvs-demo .followup-demo'));h.d.getElementById('demo-reset').click();h.click('Ja, start på nytt');assert.match(h.d.querySelector('.vvs-demo').textContent,/Fra kontakt til/);h.d.getElementById('demo-reset').click();h.click('Behold eksemplet');assert.match(h.d.querySelector('.vvs-demo').textContent,/Fra kontakt til/);}finally{h.finish();}});
console.log(`VVS demo: ${checks} grouped checks passed. No external writes, storage, messages or payments.`);
