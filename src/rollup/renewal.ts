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
 const holder=(assetId:string)=>live.find(v=>v.assets?.some(a=>a.assetId===assetId));
 const coinOf=async(v:NonNullable<ReturnType<typeof holder>>):Promise<RollupPoolCoin>=>{
  const raw=(await indexer.getVirtualTxs([v.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===v.txid);
  if(!raw)throw new Error(`Renewed coin ${v.txid} is not indexed yet.`);
  return {txid:v.txid,vout:v.vout,value:v.value,sourceTxHex:hex.encode(raw.toBytes(true,true))};
 };
 const head=holder(o.token);
 if(!head)throw new Error('The renewed head is not indexed yet.');
 const renewed:RollupArchive['reserves']={};
 for(const [assetId,coin] of reserves){const v=holder(assetId);if(!v)throw new Error(`The renewed ${assetId} reserve is not indexed yet.`);renewed[assetId]={...await coinOf(v),amount:coin.amount};}
 return {commitment,head:await coinOf(head),reserves:renewed};
}
