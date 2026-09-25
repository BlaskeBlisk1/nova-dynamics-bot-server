'use strict';
const assert=require('node:assert/strict');
const {readFileSync}=require('node:fs');
const {join}=require('node:path');
const {JSDOM}=require('jsdom');
const html=readFileSync(join(__dirname,'../public/workspace/index.html'),'utf8'),js=readFileSync(join(__dirname,'../public/workspace/app.js'),'utf8');
const tick=()=>new Promise(r=>setTimeout(r,0));
function build(path,fetch){const dom=new JSDOM(html,{url:'https://example.invalid'+path,runScripts:'outside-only'});dom.window.fetch=fetch;dom.window.confirm=()=>true;dom.window.eval(js);return dom;}
function change(w,id,value){const e=w.document.getElementById(id);e.value=value;e.dispatchEvent(new w.Event('change',{bubbles:true}));}
async function main(){
 let calls=0;const demo=build('/workspace-demo',async()=>{calls++;throw new Error('Demo must never call network');});const w=demo.window,d=w.document;await tick();
 assert.equal(d.getElementById('app').hidden,false);assert.equal(d.querySelectorAll('#list button').length,2);
 [...d.querySelectorAll('#list button')].find(b=>b.textContent.includes('Nora')).click();assert.ok(d.getElementById('detail').textContent.includes('Eksempel: Nora'));
 change(w,'outcome','won');change(w,'amount','1250,50');d.getElementById('edit-form').dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));await tick();assert.match(d.getElementById('error').textContent,/Bekreft/);
 d.getElementById('verified').checked=true;d.getElementById('edit-form').dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));await tick();
 change(w,'view','won');await tick();assert.equal(d.querySelectorAll('#list button').length,1);d.querySelector('#list button').click();assert.equal(d.getElementById('amount').value,'1250,5');assert.match(d.getElementById('metrics').textContent,/1\s?250,50/);
 d.getElementById('note').value='<img src=x onerror=alert(1)>';d.getElementById('verified').checked=true;d.getElementById('edit-form').dispatchEvent(new w.Event('submit',{cancelable:true,bubbles:true}));await tick();assert.equal(d.querySelectorAll('#detail img').length,0);
 d.getElementById('reset-demo').click();await tick();assert.equal(d.querySelectorAll('#list button').length,0);assert.equal(calls,0);assert.equal(w.localStorage.length,0);demo.window.close();
 console.log('ok - demo edits, verified value, escaping and reset work without network or storage');
 const calendar=build('/workspace-demo',async()=>{throw new Error('No network');}),cw=calendar.window,cd=cw.document;await tick();change(cw,'view','upcoming');await tick();assert.equal(cd.querySelectorAll('#list button').length,1);cd.querySelector('#list button').click();assert.match(cd.getElementById('detail').textContent,/Sara/);cd.getElementById('demo-reschedule').click();await tick();assert.equal(cd.getElementById('view').value,'upcoming');cd.getElementById('demo-cancel').click();await tick();assert.equal(cd.getElementById('view').value,'cancelled');assert.match(cd.getElementById('detail').textContent,/Avlyst/);cd.getElementById('demo-attention').click();await tick();assert.equal(cd.getElementById('view').value,'calendar');assert.match(cd.getElementById('detail').textContent,/kunne ikke bekreftes/);change(cw,'view','past');await tick();assert.equal(cd.querySelectorAll('#list button').length,1);assert.match(cd.getElementById('list').textContent,/Emil/);assert.equal(cw.localStorage.length,0);calendar.window.close();console.log('ok - upcoming, past, rescheduling, cancellation and calendar uncertainty remain synthetic');
 let expired=false,conflict=false,posts=0;
 const entry={id:'11111111-1111-4111-8111-111111111111',revision:'a'.repeat(64),createdAt:new Date().toISOString(),name:'Synthetic',email:'nobody@example.invalid',phone:'',service:'Visit',message:'',outcome:'new',note:'',booking:{status:'not_booked',slot:null},followup:{action:'callback',due:new Date().toISOString(),overdue:true},amountOre:null};
 const live=build('/workspace',async(url,opts)=>{if(opts.method==='POST')posts++;const error=expired?'unauthorized':conflict&&opts.method==='POST'?'conflict':null;return {ok:!error,json:async()=>error?{error}:url.endsWith('/session')?{name:'Synthetic',csrf:'test'}:url.includes('/enquiries?')?{items:[entry],hasMore:false}:{enquiries:1,confirmed:0,needs_review:0,won:0,sales_ore:'0'}};});await tick();const lw=live.window,ld=lw.document;ld.querySelector('#list button').click();conflict=true;change(lw,'note','Keep this unsaved note');ld.getElementById('edit-form').dispatchEvent(new lw.Event('submit',{cancelable:true,bubbles:true}));await tick();assert.equal(posts,1);assert.equal(ld.getElementById('note').value,'Keep this unsaved note');assert.match(ld.getElementById('error').textContent,/endret/);
 expired=true;ld.getElementById('refresh').click();await tick();assert.equal(ld.getElementById('app').hidden,true);assert.equal(ld.getElementById('login').hidden,false);for(const id of ['list','detail','metrics'])assert.equal(ld.getElementById(id).textContent,'');live.window.close();
 console.log('ok - conflicts preserve edits without retry; session expiry removes private data');
}
main().catch(e=>{console.error(e);process.exitCode=1;});
