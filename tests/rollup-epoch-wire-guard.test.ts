import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import type {AddressInfo} from 'node:net';
import {setTimeout as sleep} from 'node:timers/promises';
import {test} from 'node:test';
import {ArkAddress,InMemoryContractRepository,InMemoryWalletRepository,SingleKey} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import info from './fixtures/ark-info.json' with {type:'json'};
import {fullViewOf} from '../app/src/Disclose.tsx';
import * as prover from '../app/src/shielded-prover.ts';
import {fullViewKeyOf,parseFullViewKey} from '../packages/protocol/src/rollup/disclosure.ts';
import {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import {akOf} from '../packages/protocol/src/rollup/notes.ts';
import {rollupAddressOf,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import type {LightningSpendRecord,LightningSpendStore} from '../src/shielded/lightning-spend.ts';
import {epochTransferBody} from '../src/shielded/epoch-pool.ts';
import {epochCatchUp} from '../src/shielded/epoch-sync.ts';
import {poolApiOf,transferBody,type PoolApi,type RollupPoolStatus} from '../src/shielded/pool.ts';
import {ShieldedWallet,shieldedKeysOf} from '../src/shielded/wallet.ts';
import {epochPool,fromBody,type PoolSpend} from './fixtures/epoch-pool.ts';
import {hash,keySet,listen,offline,proof,ready,scratch} from './fixtures/epoch-service.ts';

const TOKEN='2df7aa3628161299e03ef35e71916d68952490aa7b37423e358ab32bbe26a7de0000';
const POOL_ADDRESS='tark1qqcpq7yq3e8hhsx6ml3fud93m7827qggaurtzu3zwsr4a0qs0gf84ckejct66mcfz88xtqfr9pxprckm7tkha23m0d0tnqzpw0r8gqtwfz8ete';
const pool=ArkAddress.decode(POOL_ADDRESS),elsewhere=new ArkAddress(pool.serverPubKey,new Uint8Array(32).fill(9),pool.hrp).encode();
const answer=(status:number,body:unknown)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});

/** The fake epoch pool behind a fetch: every POST /spends body is kept and must pass the epoch parser; the first poll lands what is queued. */
function walletPool(){
 const fake=epochPool(hash,4),bodies:{slot:Record<string,unknown>}[]=[],queued:{id:string;spend:PoolSpend}[]=[],landed=new Map<string,{batch:number;txid:string}>();
 const fetcher=(async(url:string,init?:RequestInit)=>{
  const path=String(url).replace('/api/rollup',''),polled=/^\/spends\/([0-9a-f]+)$/.exec(path)?.[1];
  if(init?.method==='POST'&&path==='/spends'){
   const body=JSON.parse(String(init.body));bodies.push(body);
   if('root' in body.slot)return answer(400,{error:'An epoch slot names its anchor, not a root.'});
   try{const {slot,publics,ciphertext}=fromBody(body);queued.push({id:body.id,spend:{slot,publics,ciphertext}});}
   catch(error){return answer(400,{error:(error as Error).message});}
   return answer(202,{id:body.id,status:'pending'});
  }
  if(polled){
   if(queued.some(q=>q.id===polled)){
    const record=fake.land(queued[0]!.spend.slot.nullifiers.length===2?'join':'spend',queued.map(q=>q.spend));
    for(const q of queued.splice(0))landed.set(q.id,{batch:fake.records.length-1,txid:record.txid!});
   }
   const done=landed.get(polled);return done?answer(200,{status:'included',...done}):answer(404,{error:'Unknown spend.'});
  }
  try{
   const body=await fake.api<Record<string,any>>(path);
   return answer(200,path==='/status'?{...body,pool:{...body.pool,token:TOKEN,address:POOL_ADDRESS,script:hex.encode(pool.pkScript)}}:body);
  }catch(error){return answer((error as {status?:number}).status??400,{error:(error as Error).message});}
 }) as unknown as typeof fetch;
 return {fake,bodies,fetcher};
}
const openWallet=async(fetcher:typeof fetch,store:LightningSpendStore)=>ShieldedWallet.create({identity:SingleKey.fromHex('11'.repeat(32)),walletMode:'static',settlementConfig:false,
 storage:{walletRepository:new InMemoryWalletRepository(),contractRepository:new InMemoryContractRepository()},
 arkProvider:{serverUrl:'https://mutinynet.arkade.sh',getInfo:async()=>info} as never,
 indexerProvider:{getVtxos:async()=>({vtxos:[]}),getVirtualTxs:async()=>({txs:[]}),subscribeForScripts:async()=>'sub',getSubscription:async function*(){},unsubscribeForScripts:async()=>{}} as never,
 onchainProvider:{getCoins:async()=>[],getTransactions:async()=>[],getFeeRate:async()=>1,broadcastTransaction:async()=>'x',getChainTip:async()=>({height:1,time:1}),watchAddresses:async()=>()=>{}} as never,
 pool:{origin:'',status:await (await fetcher('/api/rollup/status')).json() as RollupPoolStatus},secret:'11'.repeat(32),hash,prover:{prove:async()=>proof},fetcher,lightningSpendStore:store});
const memoryStore=():LightningSpendStore=>{
 const rows=new Map<string,LightningSpendRecord>();
 return {get:async(_o,_p,id)=>rows.get(id),list:async()=>[...rows.values()],create:async r=>{rows.set(r.id,r);return r;},finish:async(_o,_p,id,result)=>{rows.set(id,{...rows.get(id)!,...result});}};
};

test('no spend body built by the wallet carries slot.root, and every one carries slot.anchor',async()=>{
 const {fake,bodies,fetcher}=walletPool(),{self}=shieldedKeysOf(hash,'11'.repeat(32)),bob=deriveRollupKeys2('22'.repeat(32),'mutinynet'),journal=memoryStore();
 fake.land('spend',[await fake.deposit(self,1000n),await fake.deposit(self,500n)]);
 const wallet=await openWallet(fetcher,journal);
 try{
  assert.equal(wallet.shieldedBalance(),1500n);
  await (await wallet.pay(rollupAddressOf(rollupRecipientOf(hash,bob.ask,bob.nk,bob.viewSecret)),100n)).settled();
  await (await wallet.withdraw(elsewhere,330n)).settled();
  await (await wallet.mintLink(200n)).settled();
  await (await wallet.claimLink(wallet.links()[0]!.token)).settled();
  await wallet.fundLightning('ln-1','33'.repeat(32),elsewhere,330n,journal);
  assert.equal(bodies.length,5,'pay, withdraw, mint, claim and the Lightning funding each posted one body');
  for(const body of bodies)assert.deepEqual(['root' in body.slot,'anchor' in body.slot],[false,true],JSON.stringify(body.slot));
 }finally{await wallet.dispose();}
});

test('the /watch full viewing key replays with EpochAccount, which refuses a record whose commitments do not rebuild its block root',async()=>{
 const fake=epochPool(hash,4),keys=deriveRollupKeys2('11'.repeat(32),'mutinynet');
 fake.land('spend',[await fake.deposit(rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret),700n)]);
 const key=parseFullViewKey(hash,fullViewKeyOf(akOf(hash,keys.ask),keys.nk,keys.viewSecret));
 assert.deepEqual((await fullViewOf(hash,key,fake.api)).notes().map(n=>[n.epoch,n.amount]),[[0,700n]]);
 // A padding slot's leaf, so the note itself still opens.
 const [record]=fake.records,tampered={...record!,slots:record!.slots.map((s,i)=>i===1?{...s,commitments:['1',s.commitments[1]] as [string,string]}:s)};
 const api=(async(path:string)=>path.startsWith('/batches')?{total:1,batches:[tampered]}:fake.api(path)) as PoolApi;
 await assert.rejects(fullViewOf(hash,key,api),/do not rebuild the block root/);
});

let served:ReturnType<typeof serve>|undefined;
const serve=async()=>{
 const request=await listen(await ready(offline(),scratch('rollup-wire-guard-'),keySet('epoch'),'64'));
 const origin=`http://127.0.0.1:${(request.server.address() as AddressInfo).port}`;
 return {request,origin,api:poolApiOf(origin)};
};
const service=()=>served??=serve();

test('a classic transferBody body is refused by the epoch /spends parser',async()=>{
 const {request,api}=await service(),keys=deriveRollupKeys2('11'.repeat(32),'mutinynet'),account=EpochAccount.owning(hash,keys,{epochLen:64});
 await epochCatchUp(account,api);
 const built=await account.spend({deposit:0n},rollupRecipientOf(hash,keys.ask,keys.nk,keys.viewSecret)),id=()=>randomBytes(16).toString('hex');
 const post=async(body:unknown)=>{const r=await request('/api/rollup/spends',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return [r.status,await r.json()];};
 assert.deepEqual(await post(transferBody(id(),built,proof)),[400,{error:'An epoch slot names its anchor, not a root.'}]);
 const epoch=epochTransferBody(id(),built,proof);
 assert.deepEqual(await post(epoch),[202,{id:epoch.id,status:'pending'}],'the same spend in the epoch body is admitted');
});

test('the browser prover asks for epoch-spend.wasm, and the classic name 404s on the same pool',async t=>{
 const {origin,api}=await service(),status=await api<RollupPoolStatus>('/status'),real=globalThis.fetch,asked:string[]=[];
 t.mock.method(globalThis,'fetch',async(url:unknown)=>{const r=await real(origin+String(url));asked.push(`${String(url).split('?')[0]} ${r.status}`);return r;});
 const built={witness:{input:{},slot:{nullifiers:[1n]}},slot:{nullifiers:[1n]}} as unknown as EpochBuiltSpend;
 // The served files are stand-ins, so snarkjs refuses them; only what was asked for, and the answer, matter here.
 await prover.browserProver(()=>status).prove(built,'spend').catch(()=>{});
 prover.prefetchProvingKeys(status,'join');
 for(let i=0;i<200&&asked.length<4;i++)await sleep(10);
 assert.deepEqual(asked.sort(),['epoch-join.wasm','epoch-join.zkey','epoch-spend.wasm','epoch-spend.zkey'].map(file=>`/api/rollup/proving/${file} 200`));
 for(const file of ['spend.wasm','spend.zkey','join.wasm','join.zkey'])assert.equal((await real(`${origin}/api/rollup/proving/${file}`)).status,404,file);
});
