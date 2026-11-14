import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createElement,type ReactElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {Transaction} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {ActivityLink,EXPLORER_WARNING,REVEAL_LINE,TxSheet,explorerUrl,readTx,txOf,type TxSource,type TxView} from '../app/src/tx-details.tsx';
import {NativePolicy} from '../src/native/policy.ts';

const BATCH='10ba752c367d35c0adb35d624ed07ff67386fe1165aefdfad191c22c5737e91a';
const ark=new Transaction();ark.addInput({txid:'11'.repeat(32),index:0});ark.addInput({txid:'22'.repeat(32),index:1});
ark.addOutput({script:hex.decode('5120'+'ab'.repeat(32)),amount:246529n});ark.addOutput({script:hex.decode('51024e73'),amount:0n});
const ARK=ark.id,PSBT=base64.encode(ark.toPSBT());
// Shapes and not-found answers as the Mutinynet indexer and esplora returned them on 2026-11-14.
const ESPLORA_TX={txid:BATCH,version:2,locktime:0,size:248,weight:788,fee:203,vin:[],vout:[],status:{confirmed:true,block_height:3589315,block_hash:'00',block_time:1794650568}};
const BATCH_INFO={startedAt:'1794650535',endedAt:'1794650548',batches:{0:{totalOutputAmount:'204161',totalOutputVtxos:2,expiresAt:'1795255220',swept:false}},totalInputAmount:'204161',totalInputVtxos:2,totalOutputAmount:'204161',totalOutputVtxos:2};

function services(routes:Record<string,{status?:number;body:unknown}|Error>){
 const asked:string[]=[];
 const source:TxSource={indexer:'https://ark.test',esplora:'https://esplora.test/api',fetch:async input=>{
  const url=String(input),route=routes[url];asked.push(url);
  if(route instanceof Error)throw route;
  return new Response(JSON.stringify(route?route.body:{error:'No such mempool or blockchain transaction'}),{status:route?.status??(route?200:404)});
 }};
 return {source,asked};
}
const facts=(read:Awaited<ReturnType<typeof readTx>>)=>new Map(read.state==='found'?read.facts:[]);

test('an Ark transaction reads only its own virtual tx from the indexer',async()=>{
 const {source,asked}=services({[`https://ark.test/v1/indexer/virtualTx/${ARK}`]:{body:{txs:[PSBT],page:null}}});
 assert.deepEqual(await readTx('ark',ARK,source),{state:'found',facts:[['Inputs','2'],['Outputs','2 · 246,529 sats']]});
 assert.deepEqual(asked,[`https://ark.test/v1/indexer/virtualTx/${ARK}`]);
});

test('an indexer with no such virtual tx answers 200 with none, and one answering another tx is not believed',async()=>{
 assert.deepEqual(await readTx('ark',ARK,services({[`https://ark.test/v1/indexer/virtualTx/${ARK}`]:{body:{txs:[],page:null,authToken:''}}}).source),{state:'missing'});
 const other='33'.repeat(32);
 assert.equal((await readTx('ark',other,services({[`https://ark.test/v1/indexer/virtualTx/${other}`]:{body:{txs:[PSBT]}}}).source)).state,'error');
});

test('a commitment tx shows its batch totals, and arkd\'s 500 "batch not found" reads as not found yet',async()=>{
 const url=`https://ark.test/v1/indexer/commitmentTx/${BATCH}`,found=await readTx('commitment',BATCH,services({[url]:{body:BATCH_INFO}}).source);
 assert.equal(facts(found).get('Inputs'),'2 VTXOs · 204,161 sats');assert.equal(facts(found).get('Outputs'),'2 VTXOs · 204,161 sats');assert.match(facts(found).get('Batch ended')??'',/2026/);
 assert.deepEqual(await readTx('commitment',BATCH,services({[url]:{status:500,body:{code:13,message:'batch not found',details:[]}}}).source),{state:'missing'});
 assert.deepEqual(await readTx('commitment',BATCH,services({[url]:{status:500,body:{code:13,message:'database is locked'}}}).source),{state:'error',message:'The service answered HTTP 500.'});
});

test('a Bitcoin tx reads esplora\'s tx, then the tip for its confirmations',async()=>{
 const {source,asked}=services({[`https://esplora.test/api/tx/${BATCH}`]:{body:ESPLORA_TX},'https://esplora.test/api/blocks':{body:[{id:'00',height:3589619}]}}),read=facts(await readTx('bitcoin',BATCH,source));
 assert.deepEqual([read.get('Status'),read.get('Block height'),read.get('Confirmations'),read.get('Fee')],['Confirmed','3,589,315','305','203 sats · 1.0 sat/vB']);
 assert.match(read.get('Mined')??'',/2026/);
 assert.deepEqual(asked,[`https://esplora.test/api/tx/${BATCH}`,'https://esplora.test/api/blocks']);
});

test('an unconfirmed tx asks for no tip, an unknown one is not found yet, and a failed tip read drops only the count',async()=>{
 const pending=services({[`https://esplora.test/api/tx/${BATCH}`]:{body:{txid:BATCH,weight:400,fee:150,status:{confirmed:false}}}});
 assert.deepEqual(await readTx('bitcoin',BATCH,pending.source),{state:'found',facts:[['Status','In the mempool, not confirmed yet'],['Fee','150 sats · 1.5 sat/vB']]});
 assert.equal(pending.asked.length,1);
 assert.deepEqual(await readTx('bitcoin',BATCH,services({}).source),{state:'missing'});
 const tipless=facts(await readTx('bitcoin',BATCH,services({[`https://esplora.test/api/tx/${BATCH}`]:{body:ESPLORA_TX},'https://esplora.test/api/blocks':new Error('Tor connection failed')}).source));
 assert.equal(tipless.get('Block height'),'3,589,315');assert.equal(tipless.has('Confirmations'),false);
});

test('a transport failure becomes an error state instead of a rejection',async()=>{
 assert.deepEqual(await readTx('ark',ARK,services({[`https://ark.test/v1/indexer/virtualTx/${ARK}`]:new Error('Native network generation is retired or paused')}).source),{state:'error',message:'Native network generation is retired or paused'});
 assert.deepEqual(await readTx('bitcoin',BATCH,services({[`https://esplora.test/api/tx/${BATCH}`]:{status:502,body:{}}}).source),{state:'error',message:'The service answered HTTP 502.'});
});

test('every read the sheet makes is an already approved native route, isolated per transaction',async()=>{
 const indexer='https://mutinynet.arkade.sh',esplora='https://mempool.mutinynet.arkade.sh/api',policy=new NativePolicy('https://shielded.mutinynet.arkade.sh'),asked:string[]=[];
 policy.registerArk(indexer,indexer);policy.registerEsplora(esplora);
 const answer=(url:string)=>url.endsWith('/blocks')?[{height:3589619}]:url.includes('/api/tx/')?{...ESPLORA_TX,txid:url.slice(-64)}:{txs:[]};
 const source:TxSource={indexer,esplora,fetch:async input=>{asked.push(String(input));return new Response(JSON.stringify(answer(String(input))));}};
 for(const txid of [ARK,BATCH])for(const kind of ['ark','commitment','bitcoin'] as const)await readTx(kind,txid,source);
 const routes=asked.map(url=>({url,...policy.classify(url)}));
 for(const route of routes)assert.equal(route.purpose,route.url.endsWith('/blocks')?'public':route.url.includes('/v1/indexer/')?'indexer':'esplora',route.url);
 const perTx=routes.filter(route=>route.purpose!=='public');
 assert.equal(perTx.length,6);assert.equal(new Set(perTx.map(route=>route.key)).size,6,'no two transactions share an isolation key');
});

test('a row opens its Ark tx first, then its commitment, then its boarding tx, each at its own explorer',()=>{
 assert.deepEqual(txOf({arkTxid:ARK,commitmentTxid:BATCH,boardingTxid:''}),{kind:'ark',txid:ARK});
 assert.deepEqual(txOf({arkTxid:'',commitmentTxid:BATCH,boardingTxid:'aa'.repeat(32)}),{kind:'commitment',txid:BATCH});
 assert.deepEqual(txOf({arkTxid:'',commitmentTxid:'',boardingTxid:BATCH}),{kind:'bitcoin',txid:BATCH});
 assert.equal(txOf({arkTxid:'',commitmentTxid:'',boardingTxid:''}),undefined);
 assert.deepEqual([explorerUrl('ark',ARK),explorerUrl('commitment',BATCH),explorerUrl('bitcoin',BATCH)],[`https://explorer.mutinynet.arkade.sh/tx/${ARK}`,`https://explorer.mutinynet.arkade.sh/commitment-tx/${BATCH}`,`https://mempool.mutinynet.arkade.sh/tx/${BATCH}`]);
 const allowed=JSON.parse(readFileSync(new URL('../src-tauri/capabilities/main.json',import.meta.url),'utf8')).permissions.find((p:{identifier?:string})=>p.identifier==='opener:allow-open-url').allow.map((entry:{url:string})=>entry.url) as string[];
 for(const kind of ['ark','commitment','bitcoin'] as const)assert.ok(allowed.some(url=>url.endsWith('/*')&&explorerUrl(kind,BATCH).startsWith(url.slice(0,-1))),`the native opener may open ${kind} explorer pages`);
});

test('every activity link is the same button: a tap opens it in the app and nothing navigates',()=>{
 let opened=0,click:(()=>void)|undefined;
 function Capture(){const view=ActivityLink({value:ARK,copy:explorerUrl('ark',ARK),onOpen:()=>opened++}) as ReactElement<{onClick:()=>void}>;click=view.props.onClick;return view;}
 const html=renderToStaticMarkup(createElement(Capture)),reveal=renderToStaticMarkup(createElement(ActivityLink,{value:'https://shielded.mutinynet.arkade.sh/verify#eyJ2IjoxLCJ0byI6InNocm9sIn0',onOpen:()=>{}}));
 for(const link of [html,reveal]){assert.match(link,/^<button type="button" class="stock-txlink" aria-haspopup="dialog"/);assert.doesNotMatch(link,/href=|target=/);}
 assert.ok(html.includes(`${ARK.slice(0,8)}…${ARK.slice(-4)}`));assert.ok(reveal.includes('shielded…sIn0'));
 click!();assert.equal(opened,1);
});

test('a hold the WebView refuses to copy mid-press copies on the release, and its click stays spent',async t=>{
 const previous=Object.getOwnPropertyDescriptor(globalThis,'navigator'),writes:string[]=[];let allowed=false;
 Object.defineProperty(globalThis,'navigator',{configurable:true,value:{clipboard:{writeText:async(text:string)=>{if(!allowed)throw new DOMException('Write permission denied.','NotAllowedError');writes.push(text);}}}});
 t.after(()=>{if(previous)Object.defineProperty(globalThis,'navigator',previous);else Reflect.deleteProperty(globalThis,'navigator');});
 t.mock.timers.enable({apis:['setTimeout']});
 type Handlers={onPointerDown:(event:object)=>void;onPointerUp:()=>void;onClick:()=>void};
 let link!:Handlers,opened=0;const flush=()=>new Promise(resolve=>setImmediate(resolve));
 function Capture(){const view=ActivityLink({value:ARK,copy:explorerUrl('ark',ARK),onOpen:()=>opened++}) as ReactElement<Handlers>;link=view.props;return view;}
 renderToStaticMarkup(createElement(Capture));
 link.onPointerDown({pointerType:'touch',isPrimary:true,clientX:0,clientY:0});t.mock.timers.tick(500);await flush();
 assert.deepEqual(writes,[]);
 allowed=true;link.onPointerUp();await flush();link.onClick();
 assert.deepEqual(writes,[explorerUrl('ark',ARK)]);assert.equal(opened,0);
});

const view:TxView={kind:'ark',value:ARK,title:'Sent privately',facts:[['Amount','−1,000 sats'],['Status','Settled']],explorer:explorerUrl('ark',ARK)};
const sheet=(props:Partial<Parameters<typeof TxSheet>[0]>)=>renderToStaticMarkup(createElement(TxSheet,{view,source:services({}).source,native:true,onClose:()=>{},...props}));
test('the sheet shows the txid with copy and the row\'s facts while it loads, and its explorer action warns it leaves Tor',()=>{
 const html=sheet({});
 for(const text of ['Arkade transaction','Sent privately','−1,000 sats',ARK,'aria-label="Copy to clipboard"','From the Arkade indexer','Loading…','Open in explorer',EXPLORER_WARNING])assert.ok(html.includes(text),text);
 assert.doesNotMatch(html,/href="https:\/\/explorer/,'the native app opens the explorer only through the opener');
 const web=sheet({native:false});
 assert.ok(web.includes(`href="${explorerUrl('ark',ARK)}" target="_blank"`));assert.ok(!web.includes(EXPLORER_WARNING));
 assert.doesNotMatch(sheet({view:{...view,explorer:undefined}}),/Open in explorer/,'a private wallet gets no explorer action');
 const reveal=sheet({view:{kind:'reveal',value:'https://shielded.mutinynet.arkade.sh/verify#e30',title:'Sent privately',facts:[]}});
 assert.ok(reveal.includes(REVEAL_LINE.replace("'",'&#x27;')));assert.doesNotMatch(reveal,/From the|Loading/);
});
