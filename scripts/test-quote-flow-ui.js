'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{JSDOM,VirtualConsole}=require('jsdom');
const source=p=>fs.readFileSync(path.join(__dirname,'..',p),'utf8');
const schema=source('public/marketing/quote-schema.js'),flow=source('public/marketing/quote-flow.js'),app=source('public/demo/app.js'),html=source('public/demo/index.html');
const settle=()=>new Promise(r=>setImmediate(r));
async function until(fn){for(let i=0;i<40;i++){if(fn())return;await settle();}assert.ok(fn(),'condition settled');}
function harness({privateLink=false,stored='',response='open',lost=false}={}){
 const errors=[],calls=[],vc=new VirtualConsole();vc.on('jsdomError',e=>errors.push(e));
 const dom=new JSDOM(html,{url:'https://quotes.example.invalid/demos/tiller'+(privateLink?'#offer='+'a'.repeat(64):''),runScripts:'outside-only',pretendToBeVisual:true,virtualConsole:vc});
 const w=dom.window;w.structuredClone=structuredClone;w.matchMedia=()=>({matches:false});w.confirm=()=>true;
 if(stored)w.sessionStorage.setItem('jemlio-private-offer:/demos/tiller',stored);
 let current={id:'q1',version:1,title:'Synthetic proposal',description:'Included synthetic work. Timing agreed separately.',totalOre:250000,priceBasis:'incl_vat',expiresAt:new Date(Date.now()+86400000).toISOString(),state:response,response:null};
 const result=data=>({ok:true,status:200,json:async()=>data});
 w.fetch=async(url,options={})=>{calls.push({url:String(url),body:options.body});
   if(url==='/api/offers/read')return result({client:'tiller',business:'Synthetic business',offer:{...current}});
   if(url==='/api/offers/respond'){const body=JSON.parse(options.body);current={...current,state:'responded',response:body.response,responseNote:body.note};if(lost){lost=false;throw new TypeError('lost acknowledgement');}return result({offer:current});}
   if(String(url).startsWith('/api/demo-config/'))return result({name:'Synthetic business',description:'Example',greeting:'Hei!',suggestedQuestions:[],features:{capture:{enabled:false,mode:'off',services:[]}}});
   if(String(url).includes('posthog.com'))return result({});
   throw new Error('Unexpected network call '+url);
 };
 w.eval(schema);w.eval(flow);w.eval(app);
 return {dom,w,document:w.document,calls,errors};
}
function click(d,text){const b=[...d.querySelectorAll('button')].find(b=>b.textContent.trim()===text);assert.ok(b,'button '+text);b.click();}
function approve(d){const el=d.querySelector('.quote-flow [name=approved]');assert.ok(el);el.checked=true;}
function set(d,name,value){const el=d.querySelector('.quote-flow [name='+name+']');assert.ok(el,'field '+name);el.value=value;el.dispatchEvent(new d.defaultView.Event('change',{bubbles:true}));}
let checks=0;async function check(name,fn){await fn();console.log(`ok ${++checks} - ${name}`);}
async function main(){
 await check('request, owner price, customer response all work inside one demo with no writes',async()=>{
  const h=harness();try{await until(()=>h.document.querySelector('.demo-flow-start'));const before=h.calls.length;click(h.document,'Prøv henvendelse → prisforslag → svar');
   click(h.document,'Se over forespørselen');assert.ok(h.document.querySelector('[name=name]'),'approval required');approve(h.document);click(h.document,'Se over forespørselen');
   assert.match(h.document.querySelector('.quote-flow').textContent,/kari@example.invalid/);click(h.document,'Send eksempelhenvendelse');click(h.document,'Se som bedriften');
   set(h.document,'amount','3 400,50');approve(h.document);click(h.document,'Godkjenn og send eksempelforslag');assert.match(h.document.querySelector('.quote-flow').textContent,/3\s*400,50/);
   set(h.document,'response','interested');approve(h.document);click(h.document,'Send tilbakemelding');await settle();
   assert.match(h.document.querySelector('.quote-flow').textContent,/Kunden har svart/);assert.match(h.document.querySelector('.quote-flow').textContent,/ikke registrert som et betalt salg/);
   assert.equal(h.calls.length,before);assert.equal(h.errors.length,0);
  }finally{h.dom.window.close();}
 });
 await check('clarification and revised offer preserve the same demo request',async()=>{
  const h=harness();try{await until(()=>h.document.querySelector('.demo-flow-start'));click(h.document,'Prøv henvendelse → prisforslag → svar');approve(h.document);click(h.document,'Se over forespørselen');click(h.document,'Send eksempelhenvendelse');click(h.document,'Se som bedriften');
   click(h.document,'Be om mer informasjon');click(h.document,'Send eksempelspørsmål');set(h.document,'answer','Fredag passer best.');click(h.document,'Send eksempelavklaring');assert.match(h.document.querySelector('.quote-flow').textContent,/Fredag passer best/);
   approve(h.document);click(h.document,'Godkjenn og send eksempelforslag');set(h.document,'response','changes');approve(h.document);click(h.document,'Send tilbakemelding');assert.ok(h.document.querySelector('[name=note]'));
   set(h.document,'note','Et mindre omfang, takk.');click(h.document,'Send tilbakemelding');await settle();click(h.document,'Revider prisforslaget');set(h.document,'amount','1500');approve(h.document);click(h.document,'Godkjenn og send eksempelforslag');assert.match(h.document.querySelector('.qf-summary').textContent,/Versjon2/);assert.equal(h.errors.length,0);
  }finally{h.dom.window.close();}
 });
 await check('private quote tokens never enter URL, analytics or ordinary chatbot initialization',async()=>{
  const h=harness({privateLink:true});try{await until(()=>h.document.querySelector('.qf-summary'));assert.equal(h.w.location.hash,'');assert.equal(h.w.JemlioQuoteFlow.privateMode,true);
   assert.ok(h.calls.every(c=>c.url==='/api/offers/read'));assert.ok(h.document.getElementById('chat-form').hidden);assert.ok(h.calls.every(c=>!c.url.includes('a'.repeat(64))));
   assert.equal(h.w.sessionStorage.getItem('jemlio-private-offer:/demos/tiller'),'a'.repeat(64));assert.equal(h.errors.length,0);
  }finally{h.dom.window.close();}
 });
 await check('private mode survives reload and handles a lost response acknowledgement by re-reading',async()=>{
  const h=harness({stored:'a'.repeat(64),lost:true});try{await until(()=>h.document.querySelector('.qf-summary'));set(h.document,'response','interested');approve(h.document);click(h.document,'Send tilbakemelding');await until(()=>h.document.querySelector('.qf-success'));
   assert.equal(h.calls.filter(c=>c.url==='/api/offers/respond').length,1);assert.match(h.document.querySelector('.qf-success').textContent,/Ønsker å gå videre/);assert.ok(h.calls.every(c=>c.url.startsWith('/api/offers/')));assert.equal(h.errors.length,0);
  }finally{h.dom.window.close();}
 });
 console.log(`Quote UI: ${checks} grouped checks passed. Intercepted requests only.`);
}
main().catch(e=>{console.error(e);process.exitCode=1;});
