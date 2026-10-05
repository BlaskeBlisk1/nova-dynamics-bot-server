'use strict';
// Shipped homepage, public demonstrations and form contract. No provider requests.
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const html=read('public/marketing/index.html');
let checks=0;
async function check(name,run){await run();console.log(`ok ${++checks} - ${name}`);}
function harness(){
  const errors=[],requests=[],observers=[];
  const vc=new VirtualConsole();vc.on('jsdomError',error=>errors.push(error));
  const dom=new JSDOM(html,{url:'https://www.jemlio.com/',runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
  const w=dom.window,d=w.document;
  w.matchMedia=()=>({matches:true});w.HTMLElement.prototype.scrollIntoView=()=>{};
  w.IntersectionObserver=class{constructor(callback){observers.push(callback);}observe(){}disconnect(){}};
  w.fetch=async(url,options)=>{requests.push({url,options});throw Error('External requests are disabled in this rehearsal');};
  for(const file of ['quote-schema.js','quote-flow.js','followup-demo.js','vvs-profile.js','vvs-demo.js','site.js'])w.eval(read('public/marketing/'+file));
  const click=label=>{const b=[...d.querySelectorAll('.vvs-demo button')].find(el=>el.textContent===label);assert.ok(b,label);b.click();};
  const close=()=>{assert.deepEqual(errors,[]);w.close();};
  return{w,d,requests,observers,click,close};
}
(async()=>{
  await check('homepage has a single heading, working section anchors and no duplicate IDs',()=>{
    const {window:w}=new JSDOM(html),d=w.document;
    assert.equal(d.documentElement.lang,'nb');assert.equal(d.querySelectorAll('h1').length,1);
    assert.match(d.querySelector('h1').textContent,/Jemlio holder/);
    const ids=[...d.querySelectorAll('[id]')].map(el=>el.id);assert.equal(new Set(ids).size,ids.length);
    for(const a of d.querySelectorAll('a[href^="#"]'))if(a.getAttribute('href')!=='#')assert.ok(d.getElementById(a.getAttribute('href').slice(1)),a.outerHTML);
    assert.ok(!d.querySelector('.hero #demo'),'the complete demo is separate from the hero');
    for(const script of d.querySelectorAll('script[src]'))assert.ok(script.src.startsWith('./'),'no new third-party scripts');
    for(const image of d.querySelectorAll('img'))assert.ok(image.hasAttribute('alt'));
    w.close();
  });
  await check('visible form and Netlify build definition retain the same explicit contact contract',()=>{
    const a=new JSDOM(html),b=new JSDOM(read('public/marketing/form-definition.html'));
    const visible=a.window.document.getElementById('contact-form'),hidden=b.window.document.querySelector('form');
    assert.equal(visible.getAttribute('action'),'https://www.jemlio.com/demo-requested');
    assert.equal(visible.getAttribute('name'),'jemlio-demo-request');assert.equal(visible.getAttribute('data-netlify'),'true');
    const names=form=>[...form.elements].filter(x=>x.name).map(x=>x.name).sort();assert.deepEqual(names(visible),names(hidden));
    assert.equal(visible.elements['contact-request'].value,hidden.elements['contact-request'].value);
    assert.equal(visible.elements['contact-request'].required,true);
    const options=form=>[...form.elements.industry.options].map(x=>x.value);assert.deepEqual(options(visible),options(hidden));
    assert.ok(options(visible).includes('Rørlegger / VVS'));
    assert.ok(visible.elements['bot-field'].closest('[hidden]'));
    a.window.close();b.window.close();
  });
  await check('initial VVS render does not steal focus and support is only hidden in the demo viewport',()=>{
    const h=harness();try{
      assert.equal(h.d.activeElement,h.d.body);assert.ok(h.d.querySelector('.vvs-demo'));
      assert.equal(h.d.getElementById('tab-vvs').getAttribute('aria-selected'),'true');
      h.d.getElementById('chat-launcher').click();assert.equal(h.d.getElementById('support-panel').hidden,false);
      h.d.getElementById('chat-close').click();assert.equal(h.d.getElementById('support-panel').hidden,true);
      h.observers[0]([{isIntersecting:true}]);assert.ok(h.d.body.classList.contains('demo-in-view'));
      h.observers[0]([{isIntersecting:false}]);assert.ok(!h.d.body.classList.contains('demo-in-view'));
      assert.equal(h.requests.length,0);
    }finally{h.close();}
  });
  await check('SMS status examples distinguish sent, delivered and uncertain without contacting a provider',()=>{
    const h=harness();try{
      h.click('Se et ubesvart anrop');const box=h.d.querySelector('.vvs-delivery');assert.ok(box);
      assert.match(box.querySelector('[role=status]').textContent,/levering er ikke bekreftet/);
      h.click('SMS levert');assert.match(box.querySelector('[role=status]').textContent,/Kunden må fortsatt/);
      h.click('Uavklart');assert.match(box.querySelector('[role=status]').textContent,/ikke automatisk en ny SMS/);
      assert.equal(box.querySelectorAll('[aria-pressed=true]').length,1);
      assert.equal(h.requests.length,0);assert.equal(h.w.localStorage.length,0);assert.equal(h.w.sessionStorage.length,0);
      h.click('Åpne eksempelhenvendelsen');assert.ok(h.d.querySelector('[name=problem]'));
    }finally{h.close();}
  });
  await check('VVS contact CTA transfers only industry, never draft or customer details',()=>{
    const h=harness();try{
      h.d.getElementById('contact-message').value='Owner note';h.d.getElementById('contact-email').value='owner@example.invalid';
      h.d.getElementById('demo-tailor').click();
      assert.equal(h.d.getElementById('contact-industry').value,'Rørlegger / VVS');
      assert.equal(h.d.getElementById('contact-message').value,'Owner note');assert.equal(h.d.getElementById('contact-email').value,'owner@example.invalid');
      assert.doesNotMatch(decodeURIComponent(h.d.getElementById('contact-email-draft').href),/Kari Eksempel|99999999|Eksempelveien/);
      assert.equal(h.requests.length,0);
    }finally{h.close();}
  });
  await check('native mobile menu closes after selection and supports Escape',()=>{
    const h=harness();try{
      const menu=h.d.querySelector('.mobile-nav');menu.open=true;menu.querySelector('a').click();assert.equal(menu.open,false);
      menu.open=true;h.d.dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));assert.equal(menu.open,false);assert.equal(h.d.activeElement,menu.querySelector('summary'));
    }finally{h.close();}
  });
  await check('public copy and chat describe implemented SMS and explicit pilot setup, not automatic customer campaigns',()=>{
    const d=new JSDOM(html);const faq=d.window.document.querySelector('.faq-list').textContent;
    assert.match(faq,/Twilio-integrasjonen.*også bygget/);assert.match(faq,/testes før aktivering/);
    assert.match(faq,/Direkte koblinger til Cordel og SmartDok er ikke bygget/);
    assert.match(faq,/Bildeopplasting og betaling er heller ikke/);
    assert.match(faq,/ikke.*automatiske purringer/s);
    const structured=[...d.window.document.querySelectorAll('script[type="application/ld+json"]')].map(x=>JSON.parse(x.textContent));
    assert.doesNotMatch(JSON.stringify(structured),/aggregateRating|reviewCount|ratingValue/);
    d.window.close();
    if(!process.argv.includes('--frontend-only')){
      const {answer}=require('../clients/jemlio/answer');
      assert.match(answer('jemlio','Hvordan fungerer ubesvarte anrop?').reply,/SMS er bygget/);
      assert.match(answer('jemlio','Hvordan fungerer ubesvarte anrop?').reply,/testes for hver bedrift/);
      assert.match(answer('jemlio','Hva koster Jemlio?').reply,/ingen bekreftet offentlig pris/i);
      assert.match(answer('jemlio','Kobles Jemlio til Cordel eller SmartDok?').reply,/ikke bygget/);
    }
  });
  console.log(`Marketing refresh: ${checks} groups passed. No real submissions, sends or provider activity.`);
})().catch(error=>{console.error(error);process.exitCode=1;});
