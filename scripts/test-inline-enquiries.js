'use strict';
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {JSDOM,VirtualConsole}=require('jsdom');
const read=file=>readFileSync(join(__dirname,'../',file),'utf8');
const tick=()=>new Promise(r=>setImmediate(r));
const response=data=>({ok:true,status:200,json:async()=>data});
const view=(revision='1',messages=[])=>({businessName:'Fiktiv trafikkskole',subject:'Kjøreopplæring',revision,messages,expiresAt:new Date(Date.now()+86400000).toISOString()});
function build(html,url){const errors=[];const vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));const dom=new JSDOM(read(html),{url,runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});dom.window.matchMedia=()=>({matches:false});return {dom,w:dom.window,d:dom.window.document,errors};}
const submit=(w,node)=>node.dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));
const click=(d,text)=>{const b=[...d.querySelectorAll('button')].find(b=>b.textContent===text&&!b.closest('[hidden]'));assert.ok(b,text);b.click();};
(async()=>{
for(const kind of ['driving','optician','workflow']){
 const {w,d,errors}=build('public/marketing/index.html','https://www.jemlio.com/');let calls=0;
 w.fetch=()=>{calls++;throw Error('No remote requests in local demo');};w.eval(read('public/marketing/site.js'));
 d.querySelector(`[data-demo=${kind}]`).click();d.getElementById('demo-enquiry').click();
 assert.equal(d.getElementById('demo-form').hidden,true);const f=d.querySelector('.enquiry-chat form');
 f.elements.name.value='  ';submit(w,f);assert.equal(f.hidden,false);
 f.elements.name.value='<img src=x onerror=alert(1)>';submit(w,f);assert.equal(f.hidden,true);assert.equal(d.querySelectorAll('.enquiry-chat img').length,0);
 assert.equal(d.activeElement.textContent,'Bekreft eksempelhenvendelsen');
 click(d,'Endre opplysninger');assert.equal(f.hidden,false);submit(w,f);
 click(d,'Bekreft eksempelhenvendelsen');click(d,'Vis et eksempel på svar fra bedriften');
 const r=d.querySelector('.enquiry-chat form');r.elements.reply.value='  ';submit(w,r);assert.ok(r.isConnected);
 r.elements.reply.value='Tirsdag passer. <script>example</script>';submit(w,r);assert.equal(d.querySelectorAll('.enquiry-chat script').length,0);
 assert.match(d.querySelector('.enquiry-chat').textContent,/Tirsdag passer/);click(d,'Fortsett å spørre');assert.equal(d.getElementById('demo-form').hidden,false);
 assert.equal(calls,0);assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);
 d.getElementById('demo-reset').click();assert.equal(d.querySelector('.enquiry-chat'),null);assert.equal(d.getElementById('demo-enquiry').disabled,false);
 assert.deepEqual(errors,[]);w.close();console.log('ok - inline '+kind+' enquiry: review, edit, reply, escaping, reset, no network/storage');
}
{
 const {w,d,errors}=build('public/marketing/index.html','https://www.jemlio.com/');let resolve,calls=0;
 w.fetch=()=>{calls++;return new Promise(r=>resolve=r);};w.eval(read('public/marketing/site.js'));
 d.getElementById('demo-input').value='Spørsmål';submit(w,d.getElementById('demo-form'));d.getElementById('demo-enquiry').click();
 resolve(response({reply:'LATE ANSWER',unsure:false}));await tick();assert.doesNotMatch(d.getElementById('demo-messages').textContent,/LATE ANSWER/);
 const stale=d.querySelector('.enquiry-chat form');d.querySelector('[data-demo=optician]').click();submit(w,stale);
 assert.equal(d.querySelector('.enquiry-chat'),null);assert.equal(calls,1);assert.deepEqual(errors,[]);w.close();
 console.log('ok - entering enquiry cancels FAQ; reset/tab switches invalidate stale controls');
}
{
 const token='a'.repeat(43),calls=[];let attempts=0;
 const {w,d,errors}=build('public/demo/index.html','https://example.invalid/demos/tiller#reply='+token);
 w.fetch=async(url,opts)=>{calls.push({url,opts});if(url==='/api/replies/read')return response(view());assert.equal(url,'/api/replies/respond');
  if(++attempts===1)throw Error('lost acknowledgement');return response({accepted:true,duplicate:true,conversation:view('2',[{direction:'inbound',body:'Privat eksempeltekst',createdAt:new Date().toISOString()}])});};
 w.eval(read('public/reply/app.js'));w.eval(read('public/demo/app.js'));await tick();
 assert.equal(w.location.hash,'');assert.equal(w.location.search,'?reply=1');assert.equal(d.body.dataset.privateReply,'true');assert.equal(d.getElementById('business-name').textContent,'Fiktiv trafikkskole');
 assert.deepEqual(JSON.parse(calls[0].opts.body),{token,client:'tiller'});
 const field=d.getElementById('private-reply-message');field.value='Privat eksempeltekst';submit(w,d.getElementById('private-reply-form'));await tick();
 assert.equal(field.readOnly,true);d.getElementById('private-retry').click();await tick();
 assert.equal(calls[1].opts.body,calls[2].opts.body);assert.equal(JSON.parse(calls[1].opts.body).client,'tiller');
 assert.equal(field.value,'');assert.equal(w.localStorage.length,0);assert.equal(w.sessionStorage.length,0);
 assert.equal(d.body.textContent.includes(token),false);assert.equal(calls.some(c=>c.url==='/chat'||c.url.includes('posthog')||c.url.includes('demo-config')),false);
 w.dispatchEvent(new w.PageTransitionEvent('pagehide'));assert.equal(d.getElementById('private-messages').textContent,'');
 w.dispatchEvent(new w.PageTransitionEvent('pageshow',{persisted:true}));assert.equal(d.getElementById('private-conversation').hidden,true);
 assert.deepEqual(errors,[]);w.close();console.log('ok - secure inline replies: tenant binding, no FAQ/analytics/storage, identical retry, cleared history');
}
for(const suffix of ['broken','']){
 const {w,d,errors}=build('public/demo/index.html','https://example.invalid/demos/tiller#reply='+suffix);let calls=0;
 w.fetch=()=>{calls++;throw Error('Invalid token');};w.eval(read('public/reply/app.js'));w.eval(read('public/demo/app.js'));await tick();
 assert.equal(calls,0);assert.equal(w.sessionStorage.length,0);assert.equal(d.getElementById('private-conversation').hidden,true);assert.equal(w.location.hash,'');assert.deepEqual(errors,[]);w.close();
}
{
 const {w,d}=build('public/demo/index.html','https://example.invalid/demos/tiller?reply=1');let calls=0;w.fetch=()=>{calls++;throw Error('no token');};w.eval(read('public/reply/app.js'));w.eval(read('public/demo/app.js'));assert.equal(calls,0);assert.equal(d.getElementById('private-conversation').hidden,true);assert.equal(w.sessionStorage.length,0);w.close();
}
console.log('ok - malformed private reply links and token-free reloads fail closed without becoming ordinary tracked demos');
})().catch(e=>{console.error(e);process.exitCode=1;});
