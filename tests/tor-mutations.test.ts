import assert from 'node:assert/strict';
import {test} from 'node:test';
import {rollupApi,poolApiOf} from '../src/shielded/pool.ts';
import {isPrivatePoolApi,markPrivateFetch} from '../src/shielded/network-privacy.ts';
import {makeNativeMutationJournal} from '../src/native/mutations.ts';
import {PRIVATE_GRACE_MS} from '../src/shielded/private-transport.ts';
import {ROLLUP_FIELD} from '../packages/protocol/src/rollup/constants.ts';

const origin='https://pool.test',id='a'.repeat(32),other='b'.repeat(32);
const body=(submission=id,nullifiers=['17'],coin?:{txid:string;vout:number})=>JSON.stringify({id:submission,slot:{nullifiers},proof:{pi_a:['proof']},...(coin?{coin}:{})});
const mutation=(submission=id,nullifiers=['17'])=>({url:origin+'/api/rollup/spends',method:'POST',body:body(submission,nullifiers)});
const storage=()=>{const rows=new Map<string,string>();return {rows,getItem:(key:string)=>rows.get(key)??null,setItem:(key:string,value:string)=>{rows.set(key,value);},removeItem:(key:string)=>{rows.delete(key);}};};

test('private pool mutation errors never retry while private reads and browser writes retain retry behavior',async()=>{
 for(const status of [undefined,503]){
  let calls=0;
  const fetcher=markPrivateFetch((async()=>{calls++;if(status) return new Response('',{status});throw new Error('lost');}) as typeof fetch);
  await assert.rejects(rollupApi('/spends',{id},fetcher,0,origin));
  assert.equal(calls,1);
 }
 for(const [privateMode,write] of [[true,false],[false,true]] as const){
  let calls=0;
  const raw=(async()=>{if(++calls===1)throw new Error('lost');return Response.json({ok:true});}) as typeof fetch;
  const fetcher=privateMode?markPrivateFetch(raw):raw;
  assert.deepEqual(await rollupApi(write?'/spends':'/status',write?{id}:undefined,fetcher,0,origin),{ok:true});
  assert.equal(calls,2);
 }
 assert.equal(isPrivatePoolApi(poolApiOf(origin,markPrivateFetch((async()=>Response.json({})) as typeof fetch))),true);
 assert.equal(isPrivatePoolApi(poolApiOf(origin,(async()=>Response.json({})) as typeof fetch)),false);
});

test('a private admission rate limit is returned without a second dispatch',async()=>{
 let calls=0;
 const fetcher=markPrivateFetch((async()=>{calls++;return Response.json({error:'busy'},{status:429,headers:{'Retry-After':'0'}});}) as typeof fetch);
 await assert.rejects(rollupApi('/spends',{id},fetcher,0,'https://private-limit.test'),(error:{status?:number})=>error.status===429);
 assert.equal(calls,1);
});

test('a pool mutation is durable before dispatch and reload rejects uncertain replay or conflicting inputs',()=>{
 const persisted=storage(),journal=makeNativeMutationJournal(persisted);
 journal.beforeNativeMutation(mutation());
 assert.deepEqual(journal.pendingPoolNullifiers(origin),[17n]);
 assert.ok([...persisted.rows.values()].some(value=>value.includes('proof')));
 const reloaded=makeNativeMutationJournal(persisted);
 assert.throws(()=>reloaded.beforeNativeMutation(mutation()),/uncertain|reserved/i);
 assert.throws(()=>reloaded.beforeNativeMutation(mutation(id,['99'])),/uncertain|reserved/i);
 assert.throws(()=>reloaded.beforeNativeMutation(mutation(other)),/reserved/i);
 reloaded.beforeNativeMutation(mutation(other,['23']));
 assert.deepEqual(reloaded.pendingPoolNullifiers(origin),[17n,23n]);
 assert.deepEqual(reloaded.pendingPoolNullifiers('https://other.test'),[]);
});

test('a failed durable write prevents dispatch and does not create an in-memory-only reservation',()=>{
 const journal=makeNativeMutationJournal({getItem:()=>null,setItem:()=>{throw new Error('quota');},removeItem:()=>{}});
 assert.throws(()=>journal.beforeNativeMutation(mutation()),/quota/);
 assert.deepEqual(journal.pendingPoolNullifiers(origin),[]);
});

test('uncertain deposits reserve the same coin across differently named submissions',()=>{
 const persisted=storage(),journal=makeNativeMutationJournal(persisted),coin={txid:'c'.repeat(64),vout:1};
 journal.beforeNativeMutation({...mutation(id,['17']),body:body(id,['17'],coin)});
 assert.deepEqual(makeNativeMutationJournal(persisted).pendingPoolOutpoints(origin),[`${coin.txid}:1`]);
 assert.deepEqual(journal.pendingPoolOutpoints('https://other.test'),[]);
 assert.throws(()=>journal.beforeNativeMutation({...mutation(other,['23']),body:body(other,['23'],coin)}),/reserved/i);
});

test('network errors, nonterminal states, malformed terminal evidence and a 404 inside the grace retain reservations',async()=>{
 for(const response of [new Response('',{status:404}),Response.json({status:'pending'}),Response.json({status:'signing'}),Response.json({status:'included'}),Response.json({status:'dropped',reason:42})]){
  const journal=makeNativeMutationJournal(storage());journal.beforeNativeMutation(mutation());
  await journal.reconcileNativeMutations((async()=>response) as typeof fetch,origin);
  assert.deepEqual(journal.pendingPoolNullifiers(origin),[17n]);
 }
 const journal=makeNativeMutationJournal(storage());journal.beforeNativeMutation(mutation());
 await journal.reconcileNativeMutations((async()=>{throw new Error('lost');}) as typeof fetch,origin);
 assert.deepEqual(journal.pendingPoolNullifiers(origin),[17n]);
});

const UNKNOWN=JSON.stringify({error:'Unknown spend; it may have expired or the server restarted.'});
const lost=(journal:ReturnType<typeof makeNativeMutationJournal>,answer='')=>journal.reconcileNativeMutations((async()=>new Response(answer,{status:404})) as typeof fetch,origin);
test('a 404 inside the grace keeps a spend reserved, and past it releases',async()=>{
 const coin={txid:'c'.repeat(64),vout:1};
 for(const answer of ['',UNKNOWN]){
  let at=1_000_000;const journal=makeNativeMutationJournal(storage(),{graceMs:180_000,now:()=>at});
  journal.beforeNativeMutation({...mutation(),body:body(id,['17'],coin)});
  at+=179_999;await lost(journal,answer);
  assert.deepEqual([journal.pendingPoolNullifiers(origin),journal.pendingPoolOutpoints(origin)],[[17n],[`${coin.txid}:1`]],answer);
  at+=2;await lost(journal,answer);
  assert.deepEqual([journal.pendingPoolNullifiers(origin),journal.pendingPoolOutpoints(origin)],[[],[]],answer);
 }
});

test('a 404 after the pool stops tracking leaves the entry pending',async()=>{
 let at=1_000_000;const journal=makeNativeMutationJournal(storage(),{graceMs:180_000,now:()=>at});
 journal.beforeNativeMutation(mutation());
 at+=3_600_001;await lost(journal,UNKNOWN);
 assert.deepEqual(journal.pendingPoolNullifiers(origin),[17n]);
});

test('with the browser grace, a 404 releases until 45 minutes after the POST and keeps the entry from then on',async()=>{
 for(const [age,left] of [[2_699_999,[]],[2_700_000,[17n]]] as const){
  let at=1_000_000;const journal=makeNativeMutationJournal(storage(),{graceMs:PRIVATE_GRACE_MS,now:()=>at});
  journal.beforeNativeMutation(mutation());
  at+=age;await lost(journal,UNKNOWN);
  assert.deepEqual(journal.pendingPoolNullifiers(origin),left,String(age));
 }
});

test('a journal built without a grace never releases on a 404',async t=>{
 let at=1_000_000;t.mock.method(Date,'now',()=>at);
 const journal=makeNativeMutationJournal(storage());journal.beforeNativeMutation(mutation());
 for(const later of [300_001,3_599_999]){at=1_000_000+later;await lost(journal,UNKNOWN);assert.deepEqual(journal.pendingPoolNullifiers(origin),[17n],String(later));}
});

test('only a matching definitive status response retires a reservation durably',async()=>{
 for(const answer of [{status:'included',txid:'d'.repeat(64),batch:1},{status:'included',txid:'d'.repeat(64)}]){
  const persisted=storage(),journal=makeNativeMutationJournal(persisted);journal.beforeNativeMutation(mutation());
  journal.observeNativeResponse({url:'https://other.test/api/rollup/spends/'+id,method:'GET',status:200,body:JSON.stringify(answer)});
  assert.deepEqual(journal.pendingPoolNullifiers(origin),[17n]);
  await journal.reconcileNativeMutations((async(url)=>{assert.equal(String(url),origin+'/api/rollup/spends/'+id);return Response.json(answer);}) as typeof fetch,origin);
  assert.deepEqual(makeNativeMutationJournal(persisted).pendingPoolNullifiers(origin),[]);
 }
});

test('journal reconciliation caps concurrent reads and preserves failed outcomes',async()=>{
 const journal=makeNativeMutationJournal(storage());let active=0,maximum=0;
 for(let n=1;n<=9;n++)journal.beforeNativeMutation(mutation(n.toString(16).padStart(32,'0'),[String(n)]));
 const result=await journal.reconcileNativeMutations((async input=>{
  active++;maximum=Math.max(maximum,active);await new Promise(resolve=>setTimeout(resolve,1));active--;
  if(String(input).endsWith('9'))throw new Error('unknown');
  return Response.json({status:'included',txid:'d'.repeat(64)});
 }) as typeof fetch,origin);
 assert.equal(maximum,4);assert.deepEqual(result,{pending:1});assert.deepEqual(journal.pendingPoolNullifiers(origin),[9n]);
});

test('startup reconciliation expires hung reads and leaves every unresolved input reserved',async t=>{
 t.mock.timers.enable({apis:['setTimeout']});
 const journal=makeNativeMutationJournal(storage()),signals:AbortSignal[]=[],releases:((response:Response)=>void)[]=[];
 for(let n=1;n<=9;n++)journal.beforeNativeMutation(mutation(n.toString(16).padStart(32,'0'),[String(n)]));
 const pending=journal.reconcileNativeMutations((async(_input,init)=>{signals.push(init!.signal!);return new Promise<Response>(resolve=>{releases.push(resolve);});}) as typeof fetch,origin);
 try{assert.equal(signals.length,4);}finally{t.mock.timers.tick(10_000);}
 assert.deepEqual(await pending,{pending:9});assert.ok(signals.every(signal=>signal.aborted));
 for(const release of releases)release(Response.json({status:'included',txid:'d'.repeat(64)}));await Promise.resolve();await Promise.resolve();
 assert.equal(signals.length,4);
 assert.deepEqual(journal.pendingPoolNullifiers(origin),[1n,2n,3n,4n,5n,6n,7n,8n,9n]);
});

test('a dropped deposit remains reserved across restart until its abandoned batch is included',async()=>{
 const persisted=storage(),coin={txid:'c'.repeat(64),vout:1},request={...mutation(),body:body(id,['17'],coin)};
 const journal=makeNativeMutationJournal(persisted);journal.beforeNativeMutation(request);
 const dropped={status:'dropped',reason:'The network kept refusing the batch with this deposit.'};
 journal.observeNativeResponse({url:origin+'/api/rollup/spends/'+id,method:'GET',status:200,body:JSON.stringify(dropped)});
 const reloaded=makeNativeMutationJournal(persisted);
 assert.deepEqual(reloaded.pendingPoolNullifiers(origin),[17n]);
 assert.deepEqual(reloaded.pendingPoolOutpoints(origin),[`${coin.txid}:1`]);
 assert.throws(()=>reloaded.beforeNativeMutation(request),/uncertain|reserved/i);
 assert.throws(()=>reloaded.beforeNativeMutation(mutation(other)),/reserved/i);
 assert.throws(()=>reloaded.beforeNativeMutation({...mutation(other,['23']),body:body(other,['23'],coin)}),/reserved/i);
 assert.deepEqual(await reloaded.reconcileNativeMutations((async()=>Response.json(dropped)) as typeof fetch,origin),{pending:1});
 const afterRestart=makeNativeMutationJournal(persisted);
 assert.deepEqual(await afterRestart.reconcileNativeMutations((async()=>Response.json({status:'included',batch:0,txid:'d'.repeat(64)})) as typeof fetch,origin),{pending:0});
 assert.deepEqual(afterRestart.pendingPoolNullifiers(origin),[]);
 assert.deepEqual(afterRestart.pendingPoolOutpoints(origin),[]);
});

test('malformed stored journals fail closed and unrelated HTTP never touches storage',()=>{
 const persisted=storage(),journal=makeNativeMutationJournal(persisted);journal.beforeNativeMutation(mutation());
 const key=[...persisted.rows.keys()][0]!;persisted.rows.set(key,'{"v":1,"entries":[{}]}');
 assert.throws(()=>makeNativeMutationJournal(persisted).pendingPoolNullifiers(origin),/journal/i);
 const unavailable=makeNativeMutationJournal({getItem:()=>{throw new Error('unavailable');},setItem:()=>{},removeItem:()=>{}});
 unavailable.beforeNativeMutation({url:origin+'/api/rollup/status',method:'GET'});
 unavailable.observeNativeResponse({url:origin+'/api/rollup/status',method:'GET',status:200,body:'{}'});
});

test('invalid input identities or outpoints fail before a journal entry can be sent',()=>{
 for(const value of [{id:[id],slot:{nullifiers:['17']}},{id,slot:{nullifiers:['01']}},{id,slot:{nullifiers:[]}},{id,slot:{nullifiers:['0']}},{id,slot:{nullifiers:['17','17']}},{id,slot:{nullifiers:[String(ROLLUP_FIELD)]}},{id,slot:{nullifiers:['17']},coin:{txid:'c'.repeat(64),vout:-1}}]){
  const persisted=storage(),journal=makeNativeMutationJournal(persisted);
  assert.throws(()=>journal.beforeNativeMutation({...mutation(),body:JSON.stringify(value)}),/journal/i);
  assert.equal(persisted.rows.size,0);
 }
});

test('source-proven admission refusals retire only the exact request that was refused',()=>{
 for(const [status,answer] of [[429,{code:'admission-rate-limit',error:'Too many requests from this address; try again in a minute.'}],[400,{code:'stale-anchor',error:'Rebuild against the current root.'}],[400,{code:'fee-missing',error:'Pay the fee.'}],[400,{error:'Malformed Groth16 proof.'}]] as const){
  const persisted=storage(),journal=makeNativeMutationJournal(persisted),request=mutation();journal.beforeNativeMutation(request);
  journal.observeNativeResponse({...request,status,body:JSON.stringify(answer),requestBody:body(id,['99'])});
  assert.deepEqual(journal.pendingPoolNullifiers(origin),[17n]);
  journal.observeNativeResponse({...request,status,body:JSON.stringify(answer),requestBody:request.body});
  assert.deepEqual(journal.pendingPoolNullifiers(origin),[]);
  journal.beforeNativeMutation(request);
 }
});

test('generic 400, double-spend, unknown codes, mismatched status and 5xx remain uncertain',()=>{
 for(const [status,answer] of [[400,{error:'Disk write failed.'}],[400,{code:'double-spend',error:'Already pending.'}],[400,{code:'new-code',error:'Unknown.'}],[429,{code:'stale-anchor',error:'Wrong status.'}],[429,{code:'admission-rate-limit',error:'Proxy busy.'}],[503,{code:'fee-missing',error:'May have reached the operator.'}]] as const){
  const journal=makeNativeMutationJournal(storage()),request=mutation();journal.beforeNativeMutation(request);
  journal.observeNativeResponse({...request,status,body:JSON.stringify(answer),requestBody:request.body});
  assert.deepEqual(journal.pendingPoolNullifiers(origin),[17n]);
 }
});

test('a complete fee-refused group releases its local members while unrelated payments remain held',()=>{
 const journal=makeNativeMutationJournal(storage()),group=(submission:string,nf:string)=>({url:origin+'/api/rollup/spends',method:'POST',body:JSON.stringify({id:submission,slot:{nullifiers:[nf],groupId:'41',groupSize:2}})});
 const first=group(id,'17'),last=group(other,'23');journal.beforeNativeMutation(first);journal.beforeNativeMutation(last);journal.beforeNativeMutation(mutation('c'.repeat(32),['29']));
 journal.observeNativeResponse({...last,status:400,requestBody:last.body,body:JSON.stringify({code:'fee-missing',error:'Missing deposit fee.'})});
 assert.deepEqual(journal.pendingPoolNullifiers(origin),[29n]);
});
