import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRequire} from 'node:module';
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
