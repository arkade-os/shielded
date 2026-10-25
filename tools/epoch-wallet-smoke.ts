// Local only: never in npm test, and nothing imports it. Plan 6's §10 live checks of the epoch wallet against a running epoch pool.
// Pool: SHIELDED_DATA_DIR=<fresh dir> HOST=127.0.0.1 PORT=8794 SHIELDED_ROLLUP_EPOCH_LEN=64 SHIELDED_ROLLUP_KEYS=<key dir> npm run server, its operator funded.
// Deposits are signed by the funding wallet (.recovery/stock-funding-wallet, or SHIELDED_FUNDING_WALLET); renew its coins first, as the pool
// refuses a deposit coin expiring within a day. Run: node --max-old-space-size=8192 --experimental-eventsource --import tsx
// tools/epoch-wallet-smoke.ts <pool url> [key dir, default .deps/genesis4-ceremony-keys]. It prints numbers, and exits 1 only on an outright failure.
import {createHash,randomBytes} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {SingleKey} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {decodeDisclosure,verifyDisclosure} from '../packages/protocol/src/rollup/disclosure.ts';
import type {EpochAccount} from '../packages/protocol/src/rollup/epoch-account.ts';
import type {EpochBuiltSpend} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import {rollupAddressOf,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2,deriveWalletKeyMaterial,parseMasterSecret,recoveryPhraseOf} from '../packages/protocol/src/wallet-keys.ts';
import type {RollupEpochRecord} from '../src/rollup/epoch-operator.ts';
import {createRollupProver} from '../src/rollup/prover.ts';
import {verifyRollupKeys} from '../src/rollup/service.ts';
import {epochFreshAccount,epochMatchesPool,loadEpochAccount} from '../src/shielded/epoch-checkpoint.ts';
import {epochRevealLinkOf} from '../src/shielded/epoch-disclosure.ts';
import {epochTransferBody} from '../src/shielded/epoch-pool.ts';
import {archivesHeld,needsRecovery} from '../src/shielded/epoch-recovery.ts';
import {epochCatchUp,type EpochBatchPage} from '../src/shielded/epoch-sync.ts';
import {checkSigningRequest,poolApiOf,signDeposit,waitForSpend,type RollupPoolStatus} from '../src/shielded/pool.ts';
import {openCustomerArkWallet,withArkWallet} from '../src/stock/ark-wallet.ts';
import {EngineStore} from '../src/storage.ts';

const [url,keyArg=join('.deps','genesis4-ceremony-keys')]=process.argv.slice(2);
if(!url){console.error('Usage: tools/epoch-wallet-smoke.ts <pool url> [key dir]');process.exit(1);}
const base=url.replace(/\/$/,''),keys=resolve(keyArg),api=poolApiOf(base),started=Date.now(),failures:string[]=[];
const log=(...parts:unknown[])=>console.log(new Date().toISOString().slice(11,19),...parts),secs=(ms:number)=>`${(ms/1000).toFixed(1)} s`;
const fail=(why:string)=>{failures.push(why);log('FAIL',why);};
const sha=(file:string)=>createHash('sha256').update(readFileSync(file)).digest('hex'),sleep=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const median=(xs:number[])=>xs.length?[...xs].sort((a,b)=>a-b)[Math.floor(xs.length/2)]!:NaN;
const pool=async()=>(await api<RollupPoolStatus>('/status')).pool!;

verifyRollupKeys(keys,'epoch');
const status=await api<RollupPoolStatus>('/status'),epochLen=status.pool?.epochLen;
if(status.phase!=='ready'||!epochLen||!status.proving)throw new Error(`${base} is not an open epoch pool (${status.phase}: ${status.message}).`);
for(const c of ['spend','join'] as const)for(const ext of ['wasm','zkey'] as const)if(sha(join(keys,`epoch-${c}.${ext}`))!==status.proving[c][ext])throw new Error(`${keys} holds another epoch-${c}.${ext} than the pool serves.`);
const prover={spend:createRollupProver({wasm:join(keys,'epoch-spend.wasm'),zkey:join(keys,'epoch-spend.zkey')}),join:createRollupProver({wasm:join(keys,'epoch-join.wasm'),zkey:join(keys,'epoch-join.zkey')})};
const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const fundingDir=resolve(process.env.SHIELDED_FUNDING_WALLET??'.recovery/stock-funding-wallet');
if(!existsSync(fundingDir))throw new Error(`No funding wallet at ${fundingDir}; set SHIELDED_FUNDING_WALLET.`);
const store=EngineStore.open(fundingDir),funding=store.load<{purpose:string;masterSecret:string}>();store.close();
if(funding?.purpose!=='new-stock-profile-test-funding')throw new Error(`${fundingDir} holds another wallet than the stock test funding one.`);
const identity=SingleKey.fromHex(deriveWalletKeyMaterial(funding.masterSecret,'mutinynet').nativeSecret);

type Wallet={name:string;secret:string;self:ReturnType<typeof rollupRecipientOf>;bornAt:number;account:EpochAccount};
const wallet=async(name:string):Promise<Wallet>=>{
 const secret=hex.encode(randomBytes(32)),k=deriveRollupKeys2(secret,'mutinynet'),bornAt=(await pool()).batches;
 return {name,secret,self:rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret),bornAt,account:await epochFreshAccount(hash,k,bornAt,api)};
};
// Alice and Bob stay open and renew as Plan 6's tick would; Carol closes after her deposit and comes back for a recovery.
const [alice,bob,carol]=[await wallet('alice'),await wallet('bob'),await wallet('carol')],open=[alice,bob];
const secrets=resolve('.deps',`epoch-wallet-smoke-${started}.json`);mkdirSync(resolve('.deps'),{recursive:true});
writeFileSync(secrets,JSON.stringify(Object.fromEntries([alice,bob,carol].map(w=>[w.name,{phrase:recoveryPhraseOf(w.secret),bornAt:w.bornAt}])),null,1),{mode:0o600});
log(`pool ${base}, epochLen ${epochLen}, at batch ${alice.bornAt}; the wallets' phrases are in ${secrets}`);

const steps:{batch:number;proveMs:number;waitMs:number}[]=[],renewals=new Map<number,Record<string,number>>(),notes:{batch:number;alice:number;bob:number}[]=[];
async function submit(built:EpochBuiltSpend,coin?:{txid:string;vout:number;tapTree:string;leaf:string}):Promise<number>{
 const id=hex.encode(randomBytes(16)),t=Date.now(),proof=await prover[built.slot.nullifiers.length===2?'join':'spend'].prove(built.witness.input,built.witness.publicSignals),proved=Date.now();
 await api('/spends',epochTransferBody(id,built,proof,coin?{coin}:{}));
 const done=await waitForSpend(id,async request=>{
  if(!coin)throw new Error('The pool asked to sign a spend that has no deposit.');
  checkSigningRequest(request,coin,status.pool!.script);await api(`/spends/${id}/sign`,await signDeposit(identity,request));
 },api,1000,30*60_000);
 if(done.status!=='included')throw new Error(`Spend ${id} was ${done.status}: ${done.reason??''}`);
 steps.push({batch:done.batch!,proveMs:proved-t,waitMs:Date.now()-proved});
 return done.batch!;
}
async function shield(w:Wallet,sats:number,split?:bigint){
 const openFunding=()=>openCustomerArkWallet(identity,status.network),txid=await withArkWallet(openFunding,ark=>ark.wallet.send({recipients:[{address:ark.address,amount:sats}]}));
 let coin:{txid:string;vout:number;tapTreeHex:string;leafHex:string}|undefined;
 for(let i=0;i<30&&!coin;i++){await sleep(2000);coin=await withArkWallet(openFunding,async ark=>ark.coins.find(c=>c.funding.txid===txid&&c.funding.value===sats)?.funding);}
 if(!coin)throw new Error(`The ${sats}-sat deposit coin ${txid} never reached the funding wallet.`);
 await epochCatchUp(w.account,api);
 const batch=await submit(await w.account.spend({deposit:BigInt(sats),...(split?{to:{recipient:w.self,amount:split}}:{})},w.self),{txid:coin.txid,vout:coin.vout,tapTree:coin.tapTreeHex,leaf:coin.leafHex});
 log(`${w.name} shielded ${sats} sats in batch ${batch}`);
}
async function observe(){
 for(const w of open)await epochCatchUp(w.account,api);
 if(notes.at(-1)?.batch!==alice.account.batchCount)notes.push({batch:alice.account.batchCount,alice:alice.account.notes().length,bob:bob.account.notes().length});
}
async function renew(){
 for(const w of open)for(let plan;(plan=w.account.renewalDue());){
  const batch=await submit(plan.kind==='join'?await w.account.join(plan.due,w.self):await w.account.spend({asset:plan.due[0].asset,input:plan.due[0]},w.self)),epoch=Math.floor(batch/epochLen!);
  const row=renewals.get(epoch)??{};row[w.name]=(row[w.name]??0)+1;renewals.set(epoch,row);
  log(`${w.name} renewed ${plan.due.length} note(s) of epoch ${plan.due[0].epoch} in batch ${batch}`);
  await observe();
 }
}
/** One batch of our own when the pool has nothing else to do: a zero deposit, then the open wallets' renewal policy. */
async function step(){await epochCatchUp(alice.account,api);await submit(await alice.account.spend({deposit:0n},alice.self));await observe();await renew();}
async function rotations(n:number){const target=(await pool()).epoch!+n;while((await pool()).epoch!<target)await step();log(`epoch ${target} reached`);}
const verifies=async(link:string)=>{
 const d=decodeDisclosure(link.split('#')[1]!),batches=new Map<number,RollupEpochRecord|undefined>();
 for(const n of new Set(d.notes.map(note=>Math.floor(note.index/32))))batches.set(n,(await api<EpochBatchPage>(`/batches?from=${n}&limit=1`)).batches[0]);
 return (await verifyDisclosure(hash,d,index=>batches.get(Math.floor(index/32))?.slots[Math.floor((index%32)/2)]?.commitments[index%2])).every(Boolean);
};

try{
 const e0=(await pool()).epoch!;
 await shield(alice,4000,2500n);
 await shield(carol,1000);
 await epochCatchUp(alice.account,api);
 for(const s of (await alice.account.pay(bob.self,600n,alice.self)).spends)log(`alice paid bob 600 in batch ${await submit(s)}`);
 await observe();
 await rotations(1);
 while(!renewals.has(e0+1)&&(await pool()).epoch===e0+1)await step();
 if(!renewals.has(e0+1))fail(`no renewal ran in epoch ${e0+1}`);
 await rotations(2);
 await epochCatchUp(carol.account,api);
 const [late]=carol.account.notes(),plan=carol.account.anchorPlan();
 if(!late||!needsRecovery(late,plan))throw new Error(`Carol's note is ${late?`still on the fast path (epoch ${late.epoch}, live ${plan.liveEpoch})`:'gone'}.`);
 log(`carol recovers a note of epoch ${late.epoch}; /archives says ${await archivesHeld(api,late.epoch)}`);
 const [first,again]=[await carol.account.recover(late,carol.self),await carol.account.recover(late,carol.self)];
 log(`carol's recovery landed in batch ${await submit(first)}`);
 const proof=await prover.spend.prove(again.witness.input,again.witness.publicSignals);
 const second=await api('/spends',epochTransferBody(hex.encode(randomBytes(16)),again,proof)).then(()=>undefined,(e:{code?:string;message?:string})=>e);
 if(second?.code==='double-spend')log('the second recovery was refused: double-spend');else fail(`the second recovery was ${second?`refused with ${second.code}: ${second.message}`:'accepted'}`);
 const t=Date.now(),restored=(await loadEpochAccount(hash,deriveRollupKeys2(parseMasterSecret(recoveryPhraseOf(alice.secret)),'mutinynet'),{bornAt:alice.bornAt,api})).account;
 const view=(a:EpochAccount)=>JSON.stringify([a.batchCount,String(a.latestRoot()),a.notes().map(n=>[n.epoch,n.index,String(n.amount)]),a.history.map(e=>[e.kind,e.batch])]);
 for(let i=0;i<3&&view(restored)!==view(alice.account);i++)await Promise.all([epochMatchesPool(restored,api),epochCatchUp(alice.account,api)]);
 if(view(restored)===view(alice.account))log(`alice restored from her phrase across epochs ${Math.floor(alice.bornAt/epochLen)}-${restored.epoch} in ${secs(Date.now()-t)}`);else fail('the wallet restored from the phrase differs from the live one');
 const receipt=bob.account.history.find(e=>e.kind==='receive'),link=receipt&&epochRevealLinkOf(base,receipt,{self:rollupAddressOf(bob.self),sentOf:()=>undefined});
 if(link&&await verifies(link))log(`bob's reveal link verifies against /batches: ${link}`);else fail('bob\'s reveal link is missing or does not verify');
}catch(error){fail((error as Error).stack??String(error));}

const first=alice.bornAt,last=(await pool().catch(()=>({batches:first}))).batches,records:RollupEpochRecord[]=[];
for(let n=first;n<last;n+=100)records.push(...(await api<EpochBatchPage>(`/batches?from=${n}&limit=100`).catch(()=>({batches:[]}))).batches);
const gap=(n:number)=>(records[n-first]?.at??NaN)-(records[n-first-1]?.at??NaN),rotating=records.map((_,i)=>first+i).filter(n=>n>first&&n%epochLen===0);
const waits=steps.filter(s=>s.batch%epochLen!==0).map(s=>s.waitMs);
console.log(`\n## Epoch wallet smoke, ${new Date(started).toISOString()}\n${base}, epochLen ${epochLen}, batches ${first}-${last-1}, ${secs(Date.now()-started)}, ${failures.length} failure(s)`);
console.log(`\n| rotating batch | gap after the batch before | median gap otherwise | our spend in it waited | median wait otherwise |\n|---|---|---|---|---|`);
const others=records.map((_,i)=>first+i).filter(n=>n>first&&n%epochLen!==0).map(gap);
for(const r of rotating)console.log(`| ${r} | ${secs(gap(r))} | ${secs(median(others))} | ${steps.find(s=>s.batch===r)?secs(steps.find(s=>s.batch===r)!.waitMs):'n/a'} | ${secs(median(waits))} |`);
console.log(`\n| epoch | renewals: alice | renewals: bob | notes: alice (first, last, max) | notes: bob (first, last, max) |\n|---|---|---|---|---|`);
for(const e of [...new Set(notes.map(n=>Math.floor((n.batch-1)/epochLen)))]){
 const rows=notes.filter(n=>Math.floor((n.batch-1)/epochLen)===e),of=(k:'alice'|'bob')=>`${rows[0]![k]}, ${rows.at(-1)![k]}, ${Math.max(...rows.map(r=>r[k]))}`;
 console.log(`| ${e} | ${renewals.get(e)?.alice??0} | ${renewals.get(e)?.bob??0} | ${of('alice')} | ${of('bob')} |`);
}
console.log(`\nnote count after each batch (batch:alice/bob): ${notes.map(n=>`${n.batch}:${n.alice}/${n.bob}`).join(' ')}`);
for(const f of failures)console.log(`FAIL ${f}`);
await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();
process.exit(failures.length?1:0);
