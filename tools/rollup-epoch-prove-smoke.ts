// Local only, never in npm test: real epoch batch proofs through openRollupEpochOperator with the genesis-4 ceremony keys.
// Usage: npm run test:rollup:epoch-prove [-- <key dir>]. The service refuses an epoch under EPOCH_LEN_FLOOR; the operator and circuits do not, so 2 keeps it to six batches.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {copyFileSync,mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {asset,CSVMultisigTapscript,EmulatorPacket,Extension,MultisigTapscript,SingleKey,Transaction,UnknownPacket,VtxoScript} from '@arkade-os/sdk';
import {x25519} from '@noble/curves/ed25519.js';
import {base64,hex} from '@scure/base';
import {RawWitness} from '@scure/btc-signer';
import {buildPoseidon} from 'circomlibjs';
import * as snarkjs from 'snarkjs';
import {randomField} from '../packages/protocol/src/rollup/account.ts';
import {BATCH_SLOTS,BTC_ASSET,ROLLUP_DOMAIN,SUBTREE_DEPTH,type EpochBatchKind} from '../packages/protocol/src/rollup/constants.ts';
import {inputNullifierOf,type ClientInput,type ClientSpend} from '../packages/protocol/src/rollup/client.ts';
import {EpochState} from '../packages/protocol/src/rollup/epoch.ts';
import {EPOCH_DERIVED_FIELDS,epochClientInput,epochPaddingTransfer} from '../packages/protocol/src/rollup/epoch-circuit.ts';
import type {RollupEpochRecord} from '../packages/protocol/src/rollup/epoch-record.ts';
import {akOf,outputRhoOf,ownerOf} from '../packages/protocol/src/rollup/notes.ts';
import {rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {rollupEpochPoolTree,rollupProofItems,ROLLUP_STATE_PACKET,type RollupCoin,type SnarkProof} from '../src/rollup/covenant.ts';
import {openRollupEpochOperator,slotOf,type RollupEpochSpend} from '../src/rollup/epoch-operator.ts';
import {DEFAULT_VM_BINARY,loadRollupEpochLeaves} from '../src/rollup/leaves.ts';
import type {RollupTransport} from '../src/rollup/operator.ts';
import {createRollupProver} from '../src/rollup/prover.ts';
import {rollupEpochPin,rollupSpecOf,verifyRollupKeys} from '../src/rollup/service.ts';
import type {StockWireRequest} from '../src/stock/transport.ts';
import {executeVmBinary,offlineNativeFixture} from '../tests/fixtures/native.ts';

type Spend=Omit<RollupEpochSpend,'receivedAt'>;
const keys=resolve(process.argv[2]??join('.deps','genesis4-ceremony-keys')),EPOCH_LEN=2,started=Date.now(),secs=(ms:number)=>`${(ms/1000).toFixed(1)} s`;
verifyRollupKeys(keys,'epoch');
const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const vkey=(name:string)=>JSON.parse(readFileSync(join(keys,`${name}.vkey.json`),'utf8'));
const artifacts=(name:string)=>({wasm:join(keys,`${name}.wasm`),zkey:join(keys,`${name}.zkey`)});
const le32=(v:bigint)=>Array.from({length:32},(_,i)=>Number((v>>BigInt(8*i))&255n));
const dir=mkdtempSync(join(tmpdir(),'rollup-epoch-prove-')),token=asset.AssetId.create('cc'.repeat(32),0).toString();

// The leaves embed the ceremony's verifying keys, so the covenant VM checks the real proofs; 01/02 are the VM's PoC server and emulator keys.
mkdirSync(join(dir,'keys'));
for(const c of ['epoch-spend','epoch-join','epoch-batch-spend','epoch-batch-join','epoch-batch-recover'])copyFileSync(join(keys,`${c}.vkey.json`),join(dir,'keys',`${c}.vkey.json`));
writeFileSync(join(dir,'spec.json'),JSON.stringify(rollupSpecOf('epoch',token,'aa'.repeat(32))));
const leaves=await loadRollupEpochLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json'));
const [server,emulator,user]=await Promise.all(['01','02','03'].map(b=>SingleKey.fromHex(b.repeat(32)).xOnlyPublicKey()));
const exitDelay={type:'seconds' as const,value:2048},pool=rollupEpochPoolTree(server,emulator,leaves,exitDelay);
const checkpoint=CSVMultisigTapscript.encode({pubkeys:[server],timelock:{type:'seconds',value:2048n}});
const depositor=SingleKey.fromHex('03'.repeat(32)),userCollab=MultisigTapscript.encode({pubkeys:[user,server]}).script;
const userTree=new VtxoScript([userCollab,CSVMultisigTapscript.encode({timelock:{type:'seconds',value:2048n},pubkeys:[user]}).script]);
const tokenPacket=asset.Packet.create([asset.AssetGroup.create(asset.AssetId.fromString(token),null,[asset.AssetInput.create(0,1n)],[asset.AssetOutput.create(0,1n)],[])]);
const genesisPacket=Uint8Array.from([...le32(EpochState.genesis(hash,EPOCH_LEN).commitment()),...le32(0n),...le32(0n)]);
const parent=offlineNativeFixture([{script:pool.tree.pkScript,amount:100_330n},{script:userTree.pkScript,amount:1000n},{script:userTree.pkScript,amount:1000n}],[tokenPacket,new UnknownPacket(ROLLUP_STATE_PACKET,genesisPacket)]);
const coin=(vout:number):RollupCoin=>({txid:parent.id,vout,value:1000,sourceTx:parent.toBytes(),tapTree:userTree.encode(),leaf:userTree.findLeaf(hex.encode(userCollab))});

const proved:{kind:EpochBatchKind;input:Record<string,unknown>;expected:readonly bigint[];proof:SnarkProof;ms:number}[]=[],vm:{ok:boolean;error?:string;ms:number;forged?:{ok:boolean;error?:string}}[]=[];
/** The batch with another batch's proof: valid points for another statement, so only the leaf's pairing check can refuse it. */
const forged=(request:StockWireRequest,proof:SnarkProof):StockWireRequest=>{
 const tx=Transaction.fromPSBT(base64.decode(request.arkTx)),ext=Extension.fromTx(tx),vout=Array.from({length:tx.outputsLength},(_,i)=>i).find(i=>Extension.isExtension(tx.getOutput(i).script!))!;
 const entries=ext.getEmulatorPacket()!.entries.map(e=>e.vin===0?{...e,witness:RawWitness.encode([...rollupProofItems(proof),...RawWitness.decode(e.witness!).slice(8)])}:e);
 tx.updateOutput(vout,{script:Extension.create([ext.getAssetPacket()!,EmulatorPacket.create(entries),new UnknownPacket(ROLLUP_STATE_PACKET,ext.getPacketByType(ROLLUP_STATE_PACKET)!.serialize())]).serialize()});
 return {arkTx:base64.encode(tx.toPSBT()),checkpoints:request.checkpoints};
};
const batchProver=(kind:EpochBatchKind)=>{
 const real=createRollupProver(artifacts(`epoch-batch-${kind}`));
 return {prove:async(input:Record<string,unknown>,expected:readonly bigint[])=>{const at=Date.now(),proof=await real.prove(input,expected);proved.push({kind,input,expected,proof,ms:Date.now()-at});return proof;}};
};
const clientProver={spend:createRollupProver(artifacts('epoch-spend')),join:createRollupProver(artifacts('epoch-join'))};
// Every batch lands, so a refusal is reported per batch rather than ending the run; the VM's cosigned transaction becomes the next head.
// Batch 0 has no earlier proof, and its deposit signatures would refuse any forged copy first.
const transport:RollupTransport={
 submit:async request=>{
  const at=Date.now(),r=await executeVmBinary(DEFAULT_VM_BINARY,request),signed=r.ok?{arkTx:r.arkTx!,checkpoints:r.checkpoints!}:request,ms=Date.now()-at,n=vm.length;
  vm.push({ok:r.ok,...(r.error?{error:r.error}:{}),ms,...(n?{forged:await executeVmBinary(DEFAULT_VM_BINARY,forged(request,proved[n-1]!.proof))}:{})});
  return {txid:Transaction.fromPSBT(base64.decode(signed.arkTx)).id,checkpointTxids:signed.checkpoints.map(c=>Transaction.fromPSBT(base64.decode(c)).id),signedArkTx:signed.arkTx,signedCheckpointTxs:signed.checkpoints,weights:{ark:0,checkpoints:[]},network:'mutinynet',finality:'operator-preconfirmed'};
 },
 lookup:async()=>undefined,verify:()=>{},unspent:async()=>true,
};
const signDeposits=async(request:StockWireRequest,spends:RollupEpochSpend[])=>{
 const ark=Transaction.fromPSBT(base64.decode(request.arkTx)),first=ark.inputsLength-spends.length,signed=await depositor.sign(ark,spends.map((_,i)=>first+i));
 const checkpoints=await Promise.all(request.checkpoints.map(async(encoded,vin)=>vin<first?encoded:base64.encode((await depositor.sign(Transaction.fromPSBT(base64.decode(encoded)),[0])).toPSBT())));
 return {arkTx:base64.encode(signed.toPSBT()),checkpoints};
};
const op=await openRollupEpochOperator({directory:join(dir,'operator'),epochLen:EPOCH_LEN,hash,leaves,token,serverKey:server,emulatorKey:emulator,exitDelay,checkpoint,transport,signDeposits,batchWaitMs:0,joinWaitMs:0,
 pin:rollupEpochPin({leaves,manifest:readFileSync(join(keys,'manifest.json')),checkpoint:checkpoint.script,genesisTxid:parent.id,serverKey:hex.encode(server),emulatorKey:hex.encode(emulator)}),
 genesis:{version:1,head:{txid:parent.id,vout:0,value:100_330,sourceTxHex:hex.encode(parent.toBytes())},reserves:{},batches:0},
 clientKey:{spend:vkey('epoch-spend'),join:vkey('epoch-join'),recover:vkey('epoch-spend')},
 prover:{spend:batchProver('spend'),join:batchProver('join'),recover:batchProver('recover')},onDrop:(ids,reason)=>console.log(`dropped ${ids.length}: ${reason}`)});

const ask=7n,nk=8n,owner=ownerOf(hash,ROLLUP_DOMAIN,akOf(hash,ask),nk),recipient=rollupRecipientOf(hash,randomField(),randomField(),x25519.utils.randomSecretKey());
let counter=1000n;
const fresh=()=>++counter,dummy=():ClientInput=>({amount:0n,ask:fresh(),nk:fresh(),rho:fresh(),index:0,path:Array(32).fill(0n)});
const spendOf=(inputs:ClientInput[],amounts:[bigint,bigint],deposit=0n):ClientSpend=>({domain:ROLLUP_DOMAIN,root:0n,asset:BTC_ASSET,inputs,
 outputs:[{amount:amounts[0],owner,random:fresh()},{amount:amounts[1],owner,random:fresh()}],deposit,withdraw:0n,destination:0n,ctDigest:fresh(),groupId:0n,groupSize:0});
/** A client proof against the anchor the next batch opens with, or, for a recovery, its origin's final root twice. */
const client=async(spend:ClientSpend,sel:bigint[],recover?:{origin:number;root:bigint}):Promise<Spend>=>{
 const s=op.state,rCur={epoch:s.epoch,root:s.latestRoot()},w=epochClientInput(hash,spend,recover?{rPrev:recover.root,rCur:recover.root,sel}:{rPrev:s.nextAnchorRoot(),rCur:rCur.root,sel});
 const {root:anchor,...rest}=w.slot,proof=await clientProver[spend.inputs.length===2?'join':'spend'].prove(w.input,w.publicSignals);
 return {id:randomBytes(8).toString('hex'),slot:{...rest,anchor,...(recover?{origin:recover.origin}:{rCur})},publics:w.publicSignals as unknown as Spend['publics'],proof,...(recover?{origin:recover.origin}:{})};
};
/** service.ts's padding loop, verbatim but for its queue target. */
const pad=async(kind:'spend'|'join')=>{
 const {state}=op,built=await epochPaddingTransfer(hash,{rPrev:state.nextAnchorRoot(),rCur:{epoch:state.epoch,root:state.latestRoot()},self:recipient,width:kind==='join'?2:1});
 const proof=await clientProver[kind].prove(built.witness.input,built.witness.publicSignals);
 return {id:'pad-'+randomBytes(8).toString('hex'),slot:built.slot,publics:built.witness.publicSignals as unknown as Spend['publics'],proof,ciphertext:built.ciphertext,receivedAt:Infinity};
};

const mirror=EpochState.genesis(hash,EPOCH_LEN),rows:string[]=[],failures:string[]=[];
const fail=(label:string,why:string)=>{failures.push(`${label}: ${why}`);console.log(`FAIL ${label}: ${why}`);};
async function land(label:string,kind:EpochBatchKind,clients:()=>Promise<Spend[]>){
 const at=Date.now(),list=await clients(),n=op.status().archive.batches,rotates=op.state.rotatesNext();
 for(const s of list)await op.submit(s);
 if(kind!=='recover')op.addPadding(await Promise.all(Array.from({length:BATCH_SLOTS-list.length},()=>pad(kind))));
 const ticked=Date.now(),tick=await op.tick();
 assert.ok(tick&&'txid' in tick,`${label}: ${JSON.stringify(tick)}`);
 const record=JSON.parse(readFileSync(join(dir,'operator','batches',`${n}.json`),'utf8')) as RollupEpochRecord,p=proved[n]!,v=vm[n]!;
 mirror.apply(record.kind,record.slots.map(slotOf));
 assert.equal(mirror.commitment(),op.state.commitment(),`${label}: a leaf-keeping replay reaches the operator's commitment`);
 const verified=await snarkjs.groth16.verify(vkey(`epoch-batch-${kind}`),p.expected.map(String),p.proof),derived=EPOCH_DERIVED_FIELDS.filter(f=>f in p.input);
 if(p.kind!==kind||record.kind!==kind)fail(label,`proved as ${p.kind}, recorded as ${record.kind}`);
 if(derived.length)fail(label,`the prover was handed ${derived.join()}`);
 if(!verified)fail(label,'the batch proof does not verify against its vkey');
 if(!v.ok)fail(label,`the covenant VM refused it: ${v.error}`);
 if(v.forged?.ok)fail(label,'the covenant VM accepted it with the previous batch\'s proof');
 rows.push(`| ${n} | ${kind} | ${rotates?'yes':'no'} | ${op.state.epoch} | ${list.length}+${kind==='recover'?0:BATCH_SLOTS-list.length} | ${secs(ticked-at)} | ${secs(p.ms)} | ${p.expected.length} | ${verified} | ${v.ok?'accepted':'REFUSED'} (${secs(v.ms)}) | ${v.forged?(v.forged.ok?'ACCEPTED':`refused (${v.forged.error?.split(': ').at(-1)})`):'n/a'} |`);
 console.log(rows.at(-1));
 return {n,record};
}
const leafOf=(r:{n:number;record:RollupEpochRecord},slot:{nullifiers:bigint[]},out:number)=>{
 const i=r.record.slots.findIndex(s=>s.nullifiers[0]===String(slot.nullifiers[0]));assert.ok(i>=0);
 return (r.n%EPOCH_LEN)*2**SUBTREE_DEPTH+2*i+out;
};
const noteOf=(r:{n:number;record:RollupEpochRecord},spend:ClientSpend,slot:Spend['slot'],out:number):ClientInput=>
 ({amount:spend.outputs[out].amount,ask,nk,rho:outputRhoOf(hash,ROLLUP_DOMAIN,spend.outputs[out].random,slot.nullifiers,out),index:leafOf(r,slot,out),path:[]});

console.log(`keys ${keys} (manifest checked), scratch ${dir}, epochLen ${EPOCH_LEN}`);
console.log('| batch | kind | rotates | epoch after | clients+pads | client proofs | batch proof | publics | vkey verify | covenant VM | with the previous proof |\n|---|---|---|---|---|---|---|---|---|---|---|');
try{
 const deposits=[spendOf([dummy()],[500n,500n],1000n),spendOf([dummy()],[500n,500n],1000n)];
 let minted:Spend[]=[];
 const r0=await land('spend, epoch 0, two deposits minting notes A-D','spend',async()=>minted=await Promise.all(deposits.map((d,i)=>client(d,[0n]).then(s=>({...s,coin:coin(1+i)})))));
 const [A,B,C,D]=deposits.flatMap((d,i)=>[0,1].map(out=>noteOf(r0,d,minted[i]!.slot,out)));
 const joined=spendOf([C,D].map(note=>({...note!,path:mirror.notes.path(note!.index)})),[1000n,0n]);
 let joinSpend!:Spend;
 const r1=await land('join, epoch 0, notes C and D into E','join',async()=>[joinSpend=await client(joined,[0n,0n])]);
 const E=noteOf(r1,joined,joinSpend.slot,0),epoch0=mirror.notes;
 await land('spend, the rotation into epoch 1','spend',async()=>[await client(spendOf([dummy()],[0n,0n]),[0n])]);
 assert.deepEqual([op.state.epoch,op.state.prevNoteRoot],[1,epoch0.root()]);
 await land('spend, epoch 1, E as a previous-epoch note (sel 1)','spend',async()=>[await client(spendOf([{...E,path:epoch0.path(E.index)}],[1000n,0n]),[1n])]);
 const recover=(note:ClientInput)=>client(spendOf([{...note,path:epoch0.path(note.index)}],[note.amount,0n]),[0n],{origin:0,root:epoch0.root()});
 await land('recover A, the rotation into epoch 2 that archives epoch 0','recover',async()=>[await recover(A!)]);
 await land('recover B, epoch 2, from the epoch-0 archive file','recover',async()=>[await recover(B!)]);
 assert.deepEqual([op.state.epoch,op.state.archive.has(0),[A!,B!].map(note=>op.state.recovered.has(inputNullifierOf(hash,ROLLUP_DOMAIN,note)))],[2,true,[true,true]]);
}catch(error){fail('run',(error as Error).stack??String(error));}
op.close();
console.log(`\n${rows.length} batches in ${secs(Date.now()-started)}; ${failures.length?`${failures.length} failure(s):\n${failures.join('\n')}`:'every batch proof verified, and the covenant VM accepted every batch and refused each one carrying the previous batch\'s proof'}`);
rmSync(dir,{recursive:true,force:true,maxRetries:10});
process.exit(failures.length?1:0);
