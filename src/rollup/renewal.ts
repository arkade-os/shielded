import {sha256} from '@noble/hashes/sha2.js';
import {schnorr} from '@noble/curves/secp256k1.js';
import {arkade,asset,Batch,EmulatorPacket,Extension,Intent,networks,RestArkProvider,RestEmulatorProvider,RestIndexerProvider,Transaction,UnknownPacket,withPrevTxs,type Identity,type VtxoScript} from '@arkade-os/sdk';
import {RawWitness} from '@scure/btc-signer';
import {hex} from '@scure/base';
import type {StockNetworkInfo} from '../stock/network.ts';
import {decodeStockIndexerTransaction} from '../stock/indexer.ts';
import {ROLLUP_STATE_PACKET,type RollupLeaves} from './covenant.ts';
import type {RollupArchive,RollupPoolCoin} from './operator.ts';

const scriptNum=(v:number)=>{const out:number[]=[];for(let x=v;x>0;x>>=8)out.push(x&255);if(out.length&&out.at(-1)!&0x80)out.push(0);return out;};

/** What the renewal leaf's gate signs: sha256(cosigners JSON || head txid in internal order || vout as a script number). */
export const rollupRenewalDigest=(cosigners:string[],head:{txid:string;vout:number})=>
 sha256(Uint8Array.from([...new TextEncoder().encode(JSON.stringify(cosigners)),...hex.decode(head.txid).reverse(),...scriptNum(head.vout)]));

export interface RenewedCoin {txid:string;vout:number;value:number;assets?:{assetId:string;amount:bigint}[]}
/** The renewed pool coins: the supply-1 pool token marks the head, and each reserve follows it in the intent's output order. */
export function renewedRollupPoolCoins<T extends RenewedCoin>(token:string,reserves:readonly (readonly [string,string])[],live:readonly T[]):{head:T;reserves:{assetId:string;coin:T;amount:string}[]} {
 const held=(coin:T,assetId:string)=>(coin.assets??[]).filter(a=>a.assetId===assetId);
 const head=live.find(coin=>held(coin,token).length===1&&held(coin,token)[0]!.amount===1n);
 if(!head)throw new Error('The renewed head is not indexed yet.');
 return {head,reserves:reserves.map(([assetId,amount],i)=>{
  // Anyone may send the pool an asset, so a reserve is only the coin the round put at the next vout.
  const coin=live.find(candidate=>candidate.txid===head.txid&&candidate.vout===head.vout+1+i);
  if(!coin)throw new Error(`The renewed ${assetId} reserve is not indexed yet.`);
  const found=held(coin,assetId);
  if((coin.assets??[]).length!==1||found.length!==1||found[0]!.amount!==BigInt(amount))throw new Error(`The renewed ${assetId} reserve does not hold its ${amount} units.`);
  return {assetId,coin,amount:String(found[0]!.amount)};
 })};
}
export const rollupRenewalSignature=(operatorSecret:Uint8Array,cosigners:string[],head:{txid:string;vout:number})=>schnorr.sign(rollupRenewalDigest(cosigners,head),operatorSecret);

/**
 * Moves the head and every reserve, unchanged, into a fresh round; returns their new outpoints.
 * ponytail: one-shot; a crash after registration leaves an intent arkd re-queues until it is confirmed and fails.
 */
export async function renewRollupPool(o:{network:StockNetworkInfo;identity:Identity;operatorSecret:Uint8Array;pool:VtxoScript;renewLeaf:Uint8Array;leaves:RollupLeaves;token:string;archive:RollupArchive}):Promise<Pick<RollupArchive,'head'|'reserves'>&{commitment:string}> {
 const ark=new RestArkProvider(o.network.arkUrl),emulator=new RestEmulatorProvider(o.network.emulatorUrl),indexer=new RestIndexerProvider(o.network.indexerUrl??o.network.arkUrl);
 const reserves=Object.entries(o.archive.reserves),points=[o.archive.head,...reserves.map(([,coin])=>coin)].map(({txid,vout})=>({txid,vout}));
 const found=(await indexer.getVtxos({outpoints:points})).vtxos,leaf=o.pool.findLeaf(hex.encode(o.renewLeaf));
 const coins=await withPrevTxs(points.map(p=>{
  const v=found.find(c=>c.txid===p.txid&&c.vout===p.vout);
  if(!v||v.isSpent)throw new Error(`Pool coin ${p.txid}:${p.vout} is missing or spent.`);
  return {...v,tapTree:o.pool.encode(),forfeitTapLeafScript:leaf,intentTapLeafScript:leaf};
 }),indexer);
 const session=o.identity.signerSession(),cosigner=hex.encode(await session.getPublicKey());
 const message:Intent.RegisterMessage={type:'register',onchain_output_indexes:[],valid_at:0,expire_at:Math.floor(Date.now()/1000)+600,cosigners_public_keys:[cosigner]};
 const witness=RawWitness.encode([rollupRenewalSignature(o.operatorSecret,[cosigner],o.archive.head)]);
 const id=asset.AssetId.fromString,parent=Transaction.fromRaw(hex.decode(o.archive.head.sourceTxHex),{allowUnknownOutputs:true});
 const groups=[asset.AssetGroup.create(id(o.token),null,[asset.AssetInput.create(1,1n)],[asset.AssetOutput.create(0,1n)],[]),
  ...reserves.map(([assetId,coin],i)=>asset.AssetGroup.create(id(assetId),null,[asset.AssetInput.create(i+2,BigInt(coin.amount))],[asset.AssetOutput.create(i+1,BigInt(coin.amount))],[]))];
 const ext=Extension.create([asset.Packet.create(groups),EmulatorPacket.create(points.map((_,i)=>({vin:i+1,script:o.leaves.renew,witness}))),new UnknownPacket(ROLLUP_STATE_PACKET,Extension.fromTx(parent).getPacketByType(ROLLUP_STATE_PACKET)!.serialize())]);
 const proof=Intent.create(message,coins,[...coins.map(c=>({script:o.pool.pkScript,amount:BigInt(c.value)})),ext.txOut()]);
 const signedProof=await emulator.submitIntent({proof:Buffer.from(proof.toPSBT()).toString('base64'),message});
 const intentId=await ark.registerIntent({proof:signedProof,message});
 // Pool forfeits are signed by the emulator and arkd only, so the handler's own signer passes them through.
 const passthrough=new Proxy(o.identity,{get:(target,prop)=>prop==='sign'?async(tx:Transaction)=>tx:typeof (target as never)[prop]==='function'?((target as never)[prop] as Function).bind(target):(target as never)[prop]});
 const handler=arkade.createArkadeBatchHandler(intentId,coins.map(c=>({...c,arkadeScriptBytes:o.leaves.renew})),passthrough,signedProof,message,session,ark,emulator,networks.mutinynet);
 const abortController=new AbortController();
 let commitment:string;
 try{commitment=await Batch.join(ark.getEventStream(abortController.signal,[cosigner,...points.map(p=>`${p.txid}:${p.vout}`)]),handler,{abortController});}
 finally{abortController.abort();}
 const live=(await indexer.getVtxos({scripts:[hex.encode(o.pool.pkScript)],spendableOnly:true})).vtxos;
 const coinOf=async(v:RenewedCoin):Promise<RollupPoolCoin>=>{
  const raw=(await indexer.getVirtualTxs([v.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===v.txid);
  if(!raw)throw new Error(`Renewed coin ${v.txid} is not indexed yet.`);
  return {txid:v.txid,vout:v.vout,value:v.value,sourceTxHex:hex.encode(raw.toBytes(true,true))};
 };
 const moved=renewedRollupPoolCoins(o.token,reserves.map(([assetId,coin])=>[assetId,coin.amount] as const),live);
 const renewed:RollupArchive['reserves']={};
 for(const reserve of moved.reserves)renewed[reserve.assetId]={...await coinOf(reserve.coin),amount:reserve.amount};
 return {commitment,head:await coinOf(moved.head),reserves:renewed};
}
