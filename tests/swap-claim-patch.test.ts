import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {ConditionWitness,SingleKey,Transaction,scriptFromTapLeafScript,setArkPsbtField} from '@arkade-os/sdk';
import {lightningSendContract,readLockupFate} from '@arkade-os/swap/protocol';
import {sha256} from '@noble/hashes/sha2.js';
import {base64,hex} from '@scure/base';
import {TaprootControlBlock} from '@scure/btc-signer';

const key=async(n:number)=>SingleKey.fromPrivateKey(new Uint8Array(32).fill(n)).xOnlyPublicKey();
const preimage=new Uint8Array(32).fill(9),paymentHash=hex.encode(sha256(preimage));
const payout=new Uint8Array([0x51,0x20,...await key(2)]);
const lockup=lightningSendContract({solverPubkey:await key(1),operatorPubkey:await key(3),paymentHash,refundLocktime:2_000_000_000,claimDelay:4096,emulatorPubkey:await key(9),refundPkScript:payout,senderPubkey:await key(13),receiverPkScript:payout});
const a={txid:'b2'.repeat(32),vout:0},b={txid:'b3'.repeat(32),vout:1};
function spend(out=a,leaf:ReturnType<typeof lockup.claim>|undefined=lockup.claim()){
 const tx=new Transaction({allowUnknownInputs:true,allowUnknownOutputs:true});
 tx.addInput({txid:out.txid,index:out.vout,...leaf?{tapLeafScript:[leaf]}:{}});tx.addOutput({script:payout,amount:1000n});return tx;
}
const indexer=(vtxos:unknown[],txs:Transaction[])=>({getVtxos:async()=>({vtxos}),getVirtualTxs:async()=>({txs:txs.map(tx=>base64.encode(tx.toPSBT()))})}) as unknown as Parameters<typeof readLockupFate>[0];
const readers=[readLockupFate,createRequire(import.meta.url)('@arkade-os/swap/protocol').readLockupFate as typeof readLockupFate];
const require=createRequire(import.meta.url);
const {bundles,digest,patchSwapClaim}=require('../tools/patch-swap-claim.mjs') as {bundles:Record<string,[string,string]>;digest:(source:string)=>string;patchSwapClaim:(directory?:string)=>number};

test('all shipped classifier copies are hash-pinned, idempotent and reject drift before writing',t=>{
 const root=mkdtempSync(join(tmpdir(),'shielded-swap-claim-')),directory=join(root,'dist');mkdirSync(directory);
 t.after(()=>{assert.equal(dirname(resolve(root)),resolve(tmpdir()));assert.ok(root.startsWith(join(tmpdir(),'shielded-swap-claim-')));rmSync(root,{recursive:true,force:true});});writeFileSync(join(root,'package.json'),JSON.stringify({version:'0.1.0-rc.23'}));
 const installed=dirname(require.resolve('@arkade-os/swap'));
 for(const [file,[,after]] of Object.entries(bundles)){
  const source=readFileSync(join(installed,file),'utf8');assert.equal(digest(source),after);writeFileSync(join(directory,file),source);
 }
 assert.equal(patchSwapClaim(directory),0);
 writeFileSync(join(directory,'protocol.cjs'),readFileSync(join(directory,'protocol.cjs'),'utf8')+'\n');
 const snapshots=Object.keys(bundles).map(file=>readFileSync(join(directory,file),'utf8'));
 assert.throws(()=>patchSwapClaim(directory),/hash mismatch/);
 assert.deepEqual(Object.keys(bundles).map(file=>readFileSync(join(directory,file),'utf8')),snapshots);
 writeFileSync(join(root,'package.json'),JSON.stringify({version:'0.1.0-rc.27'}));assert.throws(()=>patchSwapClaim(directory),/requires rc.23/);
});

test('the claim patch rejects a non-dist directory before reading package metadata',t=>{
 const root=mkdtempSync(join(tmpdir(),'shielded-swap-layout-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
 assert.throws(()=>patchSwapClaim(root),/expected.*dist.*directory/i);
 assert.throws(()=>patchSwapClaim(join(root,'dist')),/expected.*dist.*directory/i);
});

for(const [format,read] of readers.entries()){
 test(`${format?'CJS':'ESM'} claim waits for a matching witness at the same checkpoint txid`,async()=>{
  const tx=spend(),id=tx.id,source=indexer([{...a,spentBy:id,arkTxId:'c3'.repeat(32)}],[tx]);
  assert.deepEqual(await read(source,{swapPkScript:lockup.pkScript,paymentHash}),{fate:'unknown'});
  const wrong=spend();setArkPsbtField(wrong,0,ConditionWitness,[new Uint8Array(32).fill(8)]);
  assert.equal((await read(indexer([{...a,spentBy:id}],[wrong]),{swapPkScript:lockup.pkScript,paymentHash})).fate,'unknown');
  setArkPsbtField(tx,0,ConditionWitness,[preimage]);assert.equal(tx.id,id);
  const fate=await read(source,{swapPkScript:lockup.pkScript,paymentHash});assert.equal(fate.fate,'claimed');
  if(fate.fate==='claimed'){assert.deepEqual(fate.preimage,preimage);assert.deepEqual(fate.spends,[{checkpointTxid:id,txid:'c3'.repeat(32)}]);}
 });
 test(`${format?'CJS':'ESM'} refund requires a recognized leaf on every exact outpoint`,async()=>{
  const first=spend(a,lockup.refundWithoutReceiver()),second=spend(b),vtxos=[{...a,spentBy:first.id},{...b,spentBy:second.id}];
  assert.equal((await read(indexer(vtxos,[first,second]),{swapPkScript:lockup.pkScript,paymentHash})).fate,'unknown');
  const refund=lockup.refundWithoutReceiver();second.updateInput(0,{finalScriptWitness:[new Uint8Array(64),scriptFromTapLeafScript(refund),TaprootControlBlock.encode(refund[0])]});
  assert.equal((await read(indexer(vtxos,[first,second]),{swapPkScript:lockup.pkScript,paymentHash})).fate,'returned');
  assert.equal((await read(indexer([...vtxos,{...b,vout:2,spentBy:second.id}],[first,second]),{swapPkScript:lockup.pkScript,paymentHash})).fate,'unknown');
 });
 test(`${format?'CJS':'ESM'} claim evidence is bound to the named checkpoint and its input`,async()=>{
  const tx=spend();setArkPsbtField(tx,0,ConditionWitness,[preimage]);
  for(const vtxos of [[{...a,spentBy:'ff'.repeat(32)}],[{...b,spentBy:tx.id}],[{...a,spentBy:'ff'.repeat(32)},{...b,spentBy:tx.id}]]){
   assert.equal((await read(indexer(vtxos,[tx]),{swapPkScript:lockup.pkScript,paymentHash})).fate,'unknown');
  }
 });
}
