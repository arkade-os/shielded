import {ArkAddress,MultisigTapscript,RestArkProvider,RestIndexerProvider,Transaction,VtxoScript,type Identity} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {TaprootControlBlock} from '@scure/btc-signer';
import {tapLeafHash} from '@scure/btc-signer/payment.js';
import type {StockBootstrapInput,StockBootstrapPlan,StockBootstrapReceipt,StockBootstrapResponse} from './bootstrap.ts';
import {validateStockCheckpoint} from './checkpoint.ts';
import {decodeStockIndexerTransaction} from './indexer.ts';
import type {StockNetworkInfo} from './network.ts';
import {openCustomerArkWallet,customerVtxoSourceMatches,walletIntentLeafScriptHex} from './ark-wallet.ts';
import type {StockWireRequest} from './transport.ts';

const equal=(a:Uint8Array|undefined,b:Uint8Array|undefined)=>!!a&&!!b&&Buffer.from(a).equals(Buffer.from(b));
const zeroFee=(value:unknown)=>(value==='0'||value==='0.0'||value==='0.000'||value===0)&&Number(value)===0;
function fail(message:string):never{throw new Error('Stock bootstrap adapter: '+message);}
function sourceInput(value:{funding:StockBootstrapInput}):StockBootstrapInput{return value.funding;}

export function restoreStockBootstrapIndexed(expected:string,raw:Transaction):string {
 const tx=Transaction.fromPSBT(base64.decode(expected));
 if(tx.id!==raw.id||!equal(tx.unsignedTx,raw.unsignedTx))fail('indexer returned a different transaction body.');
 for(let vin=0;vin<tx.inputsLength;vin++){
  const input=raw.getInput(vin),witness=input.finalScriptWitness,leaf=tx.getInput(vin).tapLeafScript?.[0];if(!leaf)fail('journaled input lacks its spend leaf.');
  const script=leaf[1].subarray(0,-1),leafHash=tapLeafHash(script,leaf[1].at(-1)!);let keys:Uint8Array[];
  try{keys=MultisigTapscript.decode(script).params.pubkeys;if(keys.length!==2)fail('genesis input leaf must be exactly the pinned two-key closure.');}
  catch{return fail('journaled input has a noncanonical Arkade multisig closure.');}
  if(input.tapScriptSig?.length){
   if(input.tapScriptSig.length!==keys.length||input.tapScriptSig.some(([key,sig])=>sig.length!==64||!equal(key.leafHash,leafHash)||!keys.some(pubkey=>equal(pubkey,key.pubKey)))||new Set(input.tapScriptSig.map(([key])=>hex.encode(key.pubKey))).size!==keys.length)fail('indexer returned a noncanonical or incomplete default-sighash signature set.');
   tx.updateInput(vin,{tapScriptSig:input.tapScriptSig});continue;
  }
  if(!witness||witness.length!==keys.length+2||witness.some((item,index)=>index<keys.length&&item.length!==64)||!equal(witness.at(-2),script)||!equal(witness.at(-1),TaprootControlBlock.encode(leaf[0])))fail('indexer lacks the exact submitted spend witness.');
  const sigs=keys.map((pubKey,index)=>[{pubKey,leafHash},witness[keys.length-index-1]!] as [{pubKey:Uint8Array;leafHash:Uint8Array},Uint8Array]);
  tx.updateInput(vin,{tapScriptSig:sigs});
 }
 return base64.encode(tx.toPSBT());
}

/** Bind the fresh-install bootstrap operations to one configured identity and the exact preflighted providers. */
export async function createStockBootstrapAdapter(network:StockNetworkInfo,identity:Identity){
 const ark=await openCustomerArkWallet(identity,network),provider=new RestArkProvider(network.arkUrl),indexer=new RestIndexerProvider(network.indexerUrl??network.arkUrl),info=await provider.getInfo();
 if(info.network!=='mutinynet'||info.checkpointTapscript==null||!info.fees||!zeroFee(info.fees.txFeeRate)||Object.keys(info.fees.intentFee??{}).length!==4||!Object.values(info.fees.intentFee??{}).every(zeroFee))fail('operator network, checkpoint policy, or zero-fee profile is not the pinned Mutinynet stock profile.');
 const checkpointTapscript=info.checkpointTapscript,checkpoint=validateStockCheckpoint(checkpointTapscript,info.forfeitPubkey),ownerKey=hex.encode(await identity.xOnlyPublicKey()),changeScript=ArkAddress.decode(ark.address).pkScript;
 const walletApi=ark.wallet as typeof ark.wallet&{getScriptMap?:()=>Promise<Map<string,VtxoScript>>;makeGetPendingTxIntentSignature?:(coins:any[])=>Promise<Parameters<RestArkProvider['getPendingTxs']>[0]>};
 const pendingLookup=async(request:StockWireRequest)=>{
  if(typeof walletApi.getScriptMap!=='function'||typeof walletApi.makeGetPendingTxIntentSignature!=='function')return undefined;
  const expected=request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded))),points=expected.map(tx=>{const input=tx.getInput(0);if(!input.txid||input.index===undefined||!input.witnessUtxo)fail('journaled checkpoint is missing its original wallet prevout.');return {txid:hex.encode(input.txid).toLowerCase(),vout:input.index,value:input.witnessUtxo.amount,script:input.witnessUtxo.script};});
  const indexed=(await indexer.getVtxos({outpoints:points.map(({txid,vout})=>({txid,vout}))})).vtxos;if(indexed.length!==points.length)return undefined;
  const scripts=await walletApi.getScriptMap(),coins=points.map(point=>{const matches=indexed.filter(coin=>coin.txid.toLowerCase()===point.txid&&coin.vout===point.vout);if(matches.length!==1)return undefined;const coin=matches[0]!,tree=scripts.get(coin.script.toLowerCase());if(coin.value!==Number(point.value)||coin.script.toLowerCase()!==hex.encode(point.script).toLowerCase()||!tree)return undefined;return {...coin,tapTree:tree.encode(),forfeitTapLeafScript:tree.forfeit(),intentTapLeafScript:tree.forfeit()};});
  if(coins.some(coin=>!coin))return undefined;
  const intent=await walletApi.makeGetPendingTxIntentSignature(coins as NonNullable<(typeof coins)[number]>[]),matches=(await provider.getPendingTxs(intent)).filter(tx=>tx.arkTxid.toLowerCase()===Transaction.fromPSBT(base64.decode(request.arkTx)).id.toLowerCase());
  return matches.length===1?matches[0]:undefined;
 };
 const lookup=async(request:StockWireRequest):Promise<StockBootstrapResponse|undefined>=>{
  const pending=await pendingLookup(request);if(pending)return {arkTxid:pending.arkTxid,finalArkTx:pending.finalArkTx,signedCheckpointTxs:pending.signedCheckpointTxs};
  const expected=[Transaction.fromPSBT(base64.decode(request.arkTx)),...request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded)))],ids=expected.map(tx=>tx.id),raw=(await indexer.getVirtualTxs(ids)).txs.map(decodeStockIndexerTransaction);
  if(expected.some(tx=>raw.filter(found=>found.id===tx.id).length!==1))return undefined;
  return {arkTxid:expected[0]!.id,finalArkTx:restoreStockBootstrapIndexed(request.arkTx,raw.find(tx=>tx.id===expected[0]!.id)!),signedCheckpointTxs:request.checkpoints.map((encoded,index)=>restoreStockBootstrapIndexed(encoded,raw.find(tx=>tx.id===expected[index+1]!.id)!))};
 };
 const input=async(outpoint:string):Promise<StockBootstrapInput|undefined>=>{
  if(!/^([0-9a-f]{64}):(0|[1-9][0-9]*)$/.test(outpoint))return undefined;
  const [txid,voutRaw]=outpoint.split(':'),vout=Number(voutRaw),fresh=await ark.wallet.getSpendableVtxos(),matches=fresh.filter(coin=>`${coin.txid.toLowerCase()}:${coin.vout}`===outpoint);if(matches.length!==1)return undefined;
  const found=matches[0]!,indexed=(await indexer.getVtxos({outpoints:[{txid:txid!,vout}]})).vtxos,coins=indexed.filter(coin=>coin.txid.toLowerCase()===txid&&coin.vout===vout);if(coins.length!==1)return undefined;
  const coin=coins[0]!;if(coin.isSpent||coin.isUnrolled||coin.isSwept||!(coin.expiresAt instanceof Date)||coin.expiresAt.getTime()<=Date.now()||coin.value!==found.value||coin.script.toLowerCase()!==found.script.toLowerCase())return undefined;
  const raw=(await indexer.getVirtualTxs([txid!])).txs.map(decodeStockIndexerTransaction).filter(tx=>tx.id.toLowerCase()===txid);if(raw.length!==1||!found.tapTree||!found.intentTapLeafScript?.[1])return undefined;
  const treeBytes=found.tapTree instanceof Uint8Array?found.tapTree:hex.decode(String(found.tapTree)),tree=VtxoScript.decode(treeBytes),source=raw[0]!;
  if(!customerVtxoSourceMatches(found,source,tree,changeScript))return undefined;
  const leafHex=walletIntentLeafScriptHex(found.intentTapLeafScript);try{tree.findLeaf(leafHex);}catch{return undefined;}
  return sourceInput({funding:{txid:source.id,vout,value:found.value,sourceTxHex:hex.encode(source.toBytes(true,true)),tapTreeHex:hex.encode(treeBytes),leafHex}});
 };
 const indexed=async(plan:StockBootstrapPlan,receipt:StockBootstrapReceipt)=>{
  const ids=[plan.txid,...receipt.checkpointTxids],txs=(await indexer.getVirtualTxs(ids)).txs.map(decodeStockIndexerTransaction);if(ids.some(id=>txs.filter(tx=>tx.id===id).length!==1))return false;
  const expected=Transaction.fromPSBT(base64.decode(plan.request.arkTx)),found=txs.find(tx=>tx.id===plan.txid)!;if(!equal(expected.unsignedTx,found.unsignedTx))fail('indexer head differs from the accepted exact genesis transaction.');
  const expectedCps=plan.request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded)));for(const cp of expectedCps){const transaction=txs.find(tx=>tx.id===cp.id);if(!transaction||!equal(cp.unsignedTx,transaction.unsignedTx))fail('indexer checkpoint differs from the exact accepted funding spend.');}
  const outputs=(await indexer.getVtxos({outpoints:[{txid:plan.txid,vout:0}]})).vtxos,head=outputs.find(value=>value.txid===plan.txid&&value.vout===0);if(!head||head.value!==330||head.script!==plan.poolScriptHex||head.isSpent||head.isUnrolled||head.isSwept||!(head.expiresAt instanceof Date)||head.expiresAt.getTime()<=Date.now())return false;
  const [inputTxid,inputVout]=plan.outpoint.split(':'),spent=(await indexer.getVtxos({outpoints:[{txid:inputTxid!,vout:Number(inputVout)}]})).vtxos.find(value=>value.txid===inputTxid&&value.vout===Number(inputVout));return !!(spent&&spent.isSpent===true&&spent.spentBy===receipt.checkpointTxids[0]&&spent.arkTxId===plan.txid);
 };
 return {ark,ownerKey,checkpoint,checkpointTapscript,input,changeScript,submit:(request:StockWireRequest)=>provider.submitTx(request.arkTx,request.checkpoints),lookup,finalize:(txid:string,checkpoints:string[])=>provider.finalizeTx(txid,checkpoints),indexed};
}
