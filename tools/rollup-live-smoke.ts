// Runs the rollup operator end to end on Mutinynet with the toy covenant circuits: genesis, a deposit
// batch, a withdrawal batch, a renewal round and a batch from the renewed head. Test funds only.
import {createHash,randomBytes} from 'node:crypto';
import {mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {ArkAddress,Extension,RestIndexerProvider,SingleKey,Transaction,VtxoScript} from '@arkade-os/sdk';
import {schnorr} from '@noble/curves/secp256k1.js';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {F1Field} from 'ffjavascript';
import * as snarkjs from 'snarkjs';
import {BTC_ASSET,ROLLUP_DOMAIN,ROLLUP_FIELD} from '../packages/protocol/src/rollup/constants.ts';
import {clientWitness,type ClientInput} from '../packages/protocol/src/rollup/client.ts';
import {assetFieldOfId,destinationFieldOf,groupIdOf,nullifierOf,ownerOf} from '../packages/protocol/src/rollup/notes.ts';
import {RollupState} from '../packages/protocol/src/rollup/state.ts';
import {deriveWalletKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';
import {DEFAULT_VM_BINARY} from '../src/sdk/runtime.ts';
import {EngineStore} from '../src/storage.ts';
import {createStockBootstrapAdapter} from '../src/stock/bootstrap-adapter.ts';
import {decodeStockIndexerTransaction} from '../src/stock/indexer.ts';
import {preflightStockMutinynet} from '../src/stock/network.ts';
import type {StockWireRequest} from '../src/stock/transport.ts';
import type {RollupSpend} from '../src/rollup/batcher.ts';
import {rollupPoolTree,ROLLUP_STATE_PACKET,type RollupCoin,type SnarkProof} from '../src/rollup/covenant.ts';
import {loadRollupLeaves} from '../src/rollup/leaves.ts';
import {openRollupOperator,type RollupArchive} from '../src/rollup/operator.ts';
import {renewRollupPool} from '../src/rollup/renewal.ts';
import {createRollupTransport} from '../src/rollup/transport.ts';

const toy=(name:string)=>resolve('tests','fixtures','rollup-toy',name);
const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-covenant-snarkjs.json','utf8')) as {clientKey:unknown;batchKey:unknown};
const poseidon=await buildPoseidon(),hash=(v:bigint[])=>BigInt(poseidon.F.toObject(poseidon(v))),field=new F1Field(ROLLUP_FIELD);
const owner=ownerOf(hash,ROLLUP_DOMAIN,7n),le32=(v:bigint)=>Array.from({length:32},(_,i)=>Number((v>>BigInt(8*i))&255n));
const dir=resolve('.deps','rollup-smoke',new Date().toISOString().replace(/[:.]/g,'-'));mkdirSync(dir,{recursive:true});
const log=(...parts:unknown[])=>console.log(new Date().toISOString().slice(11,19),...parts);
let counter=BigInt('0x'+randomBytes(6).toString('hex'));
const fresh=()=>++counter;

// Toy client proofs over real statements; a group is built whole so its id commits to its members.
interface Leg {deposit?:bigint;withdraw?:bigint;asset?:string;program?:Uint8Array;coin?:RollupCoin&{assetAmount?:bigint}}
async function spends(root:bigint,legs:Leg[],grouped=false):Promise<Omit<RollupSpend,'receivedAt'>[]> {
 for(;;){
  const inputs:ClientInput[]=legs.map(()=>({amount:0n,spendSecret:fresh(),rho:fresh(),index:0,path:Array(32).fill(0n)}));
  const groupId=grouped?groupIdOf(hash,inputs.map(i=>nullifierOf(hash,ROLLUP_DOMAIN,i.spendSecret,i.rho))):0n;
  const made=legs.map((leg,i)=>clientWitness(hash,{domain:ROLLUP_DOMAIN,root,asset:leg.asset?assetFieldOfId(leg.asset):BTC_ASSET,inputs:[inputs[i]!],
   outputs:[{amount:leg.deposit??0n,owner,random:fresh()},{amount:0n,owner,random:fresh()}],deposit:leg.deposit??0n,withdraw:leg.withdraw??0n,
   destination:leg.program?destinationFieldOf(leg.program):0n,ctDigest:fresh(),groupId,groupSize:grouped?legs.length:0}));
  const roots=made.map(w=>field.sqrt(w.publicSignals[0]!));
  if(roots.some(r=>r===null))continue;
  return Promise.all(made.map(async(w,i)=>{
   const [pub,deposit,withdraw,boundaryAsset,destination]=w.publicSignals.map(String);
   const {proof}=await snarkjs.groth16.fullProve({pub,deposit,withdraw,boundaryAsset,destination,w:String(roots[i])},toy('covenant-client.wasm'),toy('covenant-client.zkey'));
   const leg=legs[i]!;
   return {id:randomBytes(8).toString('hex'),slot:w.slot,publics:w.publicSignals as unknown as RollupSpend['publics'],proof:proof as SnarkProof,
    ...(leg.asset&&(leg.deposit||leg.withdraw)?{asset:leg.asset}:{}),...(leg.program?{program:leg.program}:{}),...(leg.coin?{coin:leg.coin}:{})};
  }));
 }
}
const pads=async(root:bigint,n:number)=>(await spends(root,Array.from({length:n},()=>({})))).map(s=>({...s,receivedAt:Infinity}));

const network=await preflightStockMutinynet();
const store=EngineStore.open(resolve('.recovery/stock-funding-wallet'));
const secret=deriveWalletKeyMaterial(store.load<{masterSecret:string}>()!.masterSecret,'mutinynet').nativeSecret;store.close();
const identity=SingleKey.fromHex(secret),adapter=await createStockBootstrapAdapter(network,identity),wallet=adapter.ark.wallet;
const operatorSecret=randomBytes(32),operatorKey=hex.encode(schnorr.getPublicKey(operatorSecret));
writeFileSync(join(dir,'operator.key'),hex.encode(operatorSecret));
log('emulator',network.emulatorVersion,'data',dir);

const token=(await wallet.assetManager.issue({amount:1n})).assetId,x=(await wallet.assetManager.issue({amount:11_000n})).assetId;
log('pool token',token,'asset',x);
writeFileSync(join(dir,'client.json'),JSON.stringify(fixture.clientKey));writeFileSync(join(dir,'batch.json'),JSON.stringify(fixture.batchKey));
writeFileSync(join(dir,'spec.json'),JSON.stringify({clientKey:'client.json',batchKey:'batch.json',slots:11,kind:0,token,operator:operatorKey}));
const leaves=await loadRollupLeaves(DEFAULT_VM_BINARY,join(dir,'spec.json'));
const serverKey=hex.decode(network.serverKey),emulatorKey=hex.decode(network.emulatorKey),pool=rollupPoolTree(serverKey,emulatorKey,leaves,network.exitDelay);
const address=new ArkAddress(serverKey,pool.tree.pkScript.subarray(2),'tark').encode();
const genesisPacket=Uint8Array.from([...le32(RollupState.genesis(hash).commitment()),...le32(0n)]);
const txid=await wallet.send({recipients:[
 {address,amount:3000,assets:[{assetId:token,amount:1n}],tapTree:pool.tree.encode(),extensions:[{type:ROLLUP_STATE_PACKET,payload:genesisPacket}]},
 {address,amount:330,assets:[{assetId:x,amount:10_000n}],tapTree:pool.tree.encode()},
 {address:adapter.ark.address,amount:2500},
 {address:adapter.ark.address,amount:330,assets:[{assetId:x,amount:1_000n}]},
]});
const indexer=new RestIndexerProvider(network.indexerUrl??network.arkUrl);
const genesisTx=(await indexer.getVirtualTxs([txid])).txs.map(decodeStockIndexerTransaction).find(t=>t.id===txid)!;
const packet=Extension.fromTx(genesisTx).getAssetPacket()!;
const holds=(vout:number)=>packet.groups.flatMap(g=>g.outputs.filter(o=>o.vout===vout).map(o=>`${g.assetId}=${o.amount}`)).join(',');
const vout=(script:Uint8Array,value:number,holding:string)=>Array.from({length:genesisTx.outputsLength},(_,i)=>i).find(i=>hex.encode(genesisTx.getOutput(i).script!)===hex.encode(script)&&Number(genesisTx.getOutput(i).amount)===value&&holds(i)===holding)!;
const sourceTxHex=hex.encode(genesisTx.toBytes(true,true)),poolCoin=(v:number)=>({txid,vout:v,value:Number(genesisTx.getOutput(v).amount),sourceTxHex});
const genesis:RollupArchive={version:1,head:poolCoin(vout(pool.tree.pkScript,3000,`${token}=1`)),reserves:{[x]:{...poolCoin(vout(pool.tree.pkScript,330,`${x}=10000`)),amount:'10000'}},batches:0};
const depositCoin=async(v:number)=>{const input=(await adapter.input(`${txid}:${v}`))!,tree=VtxoScript.decode(hex.decode(input.tapTreeHex));return {txid,vout:v,value:input.value,sourceTx:hex.decode(input.sourceTxHex),tapTree:tree.encode(),leaf:tree.findLeaf(input.leafHex)};};
const btcCoin=await depositCoin(vout(adapter.changeScript,2500,'')),assetCoin={...await depositCoin(vout(adapter.changeScript,330,`${x}=1000`)),assetAmount:1000n};
log('genesis',txid);

const sha=(t:string|Uint8Array)=>createHash('sha256').update(t).digest('hex');
const operator=await openRollupOperator({directory:dir,pin:{version:1,network:'mutinynet',descriptorProfileId:sha('rollup-toy-smoke'),programsHash:sha(leaves.batch),artifactsHash:sha('toy'),checkpointHash:sha(adapter.checkpoint.script),genesisTxid:txid,serverKey:network.serverKey,emulatorKey:network.emulatorKey},
 genesis,leaves,token,serverKey,emulatorKey,exitDelay:network.exitDelay,checkpoint:adapter.checkpoint,clientKey:fixture.clientKey,hash,transport:createRollupTransport(network),depositFloorMs:3600_000,
 prover:{prove:async(_i,expected)=>(await snarkjs.groth16.fullProve({x:expected.map(String)},toy('covenant-batch.wasm'),toy('covenant-batch.zkey'))).proof as SnarkProof},
 signDeposits:async(request:StockWireRequest,deposits:RollupSpend[])=>{
  const ark=Transaction.fromPSBT(base64.decode(request.arkTx)),first=ark.inputsLength-deposits.length,vins=deposits.map((_,i)=>first+i);
  const checkpoints=await Promise.all(request.checkpoints.map(async(c,vin)=>vin<first?c:base64.encode((await identity.sign(Transaction.fromPSBT(base64.decode(c)),[0])).toPSBT())));
  return {arkTx:base64.encode((await identity.sign(ark,vins)).toPSBT()),checkpoints};
 }});
const batch=async(label:string)=>{const t0=Date.now(),result=await operator.tick();log(label,JSON.stringify(result),`${Date.now()-t0} ms`);if(!result||'blocked' in result)throw new Error(label+' did not land');};
const program=adapter.changeScript.subarray(2);

for(const s of [...await spends(operator.state.latestRoot(),[{deposit:2500n,coin:btcCoin}]),...await spends(operator.state.latestRoot(),[{deposit:1000n,asset:x,coin:assetCoin},{deposit:330n}],true)])await operator.submit(s);
operator.addPadding(await pads(operator.state.latestRoot(),8));
await new Promise(r=>setTimeout(r,10_000));
await batch('batch 1: BTC deposit and an asset deposit with its carrier');

for(const s of [...await spends(operator.state.latestRoot(),[{withdraw:1000n,program}]),...await spends(operator.state.latestRoot(),[{withdraw:400n,asset:x,program},{withdraw:330n,program}],true)])await operator.submit(s);
operator.addPadding(await pads(operator.state.latestRoot(),8));
await new Promise(r=>setTimeout(r,10_000));
await batch('batch 2: BTC withdrawal and an asset payout with its carrier');

// The id is the only way to clear a stranded intent later (.deps/rollup-probe/flush.ts <intentId>), and arkd's are random.
const t0=Date.now(),moved=await renewRollupPool({network,identity,operatorSecret,pool:pool.tree,renewLeaf:pool.renew,leaves,token,archive:operator.status().archive,
 onIntent:id=>{writeFileSync(join(dir,'renewal-intent.txt'),id);log('renewal intent',id);}});
await operator.relocate(moved);
log('renewed in round',moved.commitment,`${Date.now()-t0} ms`,'head',moved.head.txid);

for(const s of await spends(operator.state.latestRoot(),[{}]))await operator.submit(s);
operator.addPadding(await pads(operator.state.latestRoot(),10));
await new Promise(r=>setTimeout(r,10_000));
await batch('batch 3: a transfer from the renewed head');
const {vtxos}=await indexer.getVtxos({scripts:[hex.encode(pool.tree.pkScript)],spendableOnly:true});
for(const v of vtxos)log('pool coin',v.txid.slice(0,8),v.vout,v.value,JSON.stringify((v.assets??[]).map(a=>[a.assetId.slice(0,8),String(a.amount)])),'expires',v.expiresAt?.toISOString?.());
operator.close();
await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();
process.exit(0);
