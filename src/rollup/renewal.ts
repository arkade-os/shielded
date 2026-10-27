import {sha256} from '@noble/hashes/sha2.js';
import {schnorr} from '@noble/curves/secp256k1.js';
import {arkade,asset,Batch,EmulatorPacket,Estimator,Extension,Intent,networks,RestArkProvider,RestEmulatorProvider,RestIndexerProvider,SettlementEventType,Transaction,UnknownPacket,withPrevTxs,type ArkadeBatchInput,type Identity,type IntentFeeConfig,type VtxoScript} from '@arkade-os/sdk';
import {RawWitness} from '@scure/btc-signer';
import {base64,hex} from '@scure/base';
import type {StockNetworkInfo} from '../stock/network.ts';
import {decodeStockIndexerTransaction} from '../stock/indexer.ts';
import {openCustomerArkWallet,withArkWallet} from '../stock/ark-wallet.ts';
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

/** The pool's coins in the order a renewal intent carries them: the head, then each reserve. */
export const rollupPoolPoints=(archive:Pick<RollupArchive,'head'|'reserves'>)=>
 [archive.head,...Object.values(archive.reserves)].map(({txid,vout})=>({txid,vout}));
/** arkd sweeps each pool coin at its own expiry, so the soonest one among them sets the deadline for the whole pool. */
export function rollupRenewalDue(points:readonly {txid:string;vout:number}[],found:readonly {txid:string;vout:number;expiresAt?:Date}[],beforeMs:number,now:number){
 const missing=points.find(p=>!found.some(c=>c.txid===p.txid&&c.vout===p.vout));
 if(missing)throw new Error(`Pool coin ${missing.txid}:${missing.vout} is not indexed, so its expiry is unknown.`);
 const expiries=found.flatMap(c=>c.expiresAt instanceof Date?[c.expiresAt.getTime()]:[]);
 if(!expiries.length)throw new Error('The indexer reports no expiry for any pool coin.');
 return expiries.some(t=>t-now<beforeMs);
}

/** The renew leaf only needs the head at input 1, so each intent carries it and this many reserves: about 16.5k of arkd's 40k WU. */
export const RENEWAL_CHUNK=8;
/** Reserve ids in the order they come due, a chunk per intent; with no reserve, one intent renews the head alone. */
export function renewalChunks(reserves:Readonly<Record<string,{txid:string;vout:number}>>,expiresAt:(coin:{txid:string;vout:number})=>number):string[][]{
 const ids=Object.keys(reserves).sort((a,b)=>expiresAt(reserves[a]!)-expiresAt(reserves[b]!)),chunks:string[][]=[];
 for(let i=0;i<ids.length;i+=RENEWAL_CHUNK)chunks.push(ids.slice(i,i+RENEWAL_CHUNK));
 return chunks.length?chunks:[[]];
}
/** The reserves an intent carries, in its output order; an id the archive lacks is refused, since skipping it would shift every later vout. */
export function carriedReserves<T>(reserves:Readonly<Record<string,T>>,ids:readonly string[]=Object.keys(reserves)):Record<string,T>{
 return Object.fromEntries(ids.map(assetId=>{const coin=reserves[assetId];if(!coin)throw new Error(`Reserve ${assetId} is not in the archive.`);return [assetId,coin];}));
}

export interface RenewalFeeCoin {txid:string;vout:number;value:number;script:string;createdAt?:Date;expiresAt?:Date;isSwept?:boolean}
/** What arkd charges for an intent, by its own CEL programs: on mutinynet 0.2% of every VTXO input younger than a day. */
export function rollupRenewalFee(fees:IntentFeeConfig,inputs:readonly RenewalFeeCoin[],outputs:readonly {value:number;script:string}[]):number {
 return new Estimator(fees).evaluate(inputs.map(c=>({amount:BigInt(c.value),type:c.isSwept?'recoverable':'vtxo',weight:0,birth:c.createdAt,expiry:c.expiresAt})),[],
  outputs.map(o=>({amount:BigInt(o.value),script:o.script})),[]).satoshis;
}
/** The operator address is published, so anyone may pay it: enough carried inputs would push an intent past arkd's 40k WU. */
export const MAX_CARRIED=8;
export function fundRollupRenewalFee<T extends RenewalFeeCoin>(o:{fees:IntentFeeConfig;dust:number;pool:readonly RenewalFeeCoin[];outputs:readonly {value:number;script:string}[];coins:readonly T[]}):{coins:T[];fee:number;change:number} {
 // Largest first and capped: the float always rides, gifts can neither crowd it out nor grow the intent without bound.
 const take=[...o.coins].sort((a,b)=>b.value-a.value||a.txid.localeCompare(b.txid)||a.vout-b.vout).slice(0,MAX_CARRIED);
 const priced=(change:number)=>rollupRenewalFee(o.fees,[...o.pool,...take],[...o.outputs,...(change&&take[0]?[{value:change,script:take[0].script}]:[])]);
 const held=take.reduce((sum,c)=>sum+c.value,0),fee=priced(0);
 if(held>=fee){
  // arkd keeps any fee at or above its minimum, so a price that moved between these two calls -- an output program, or
  // the head ageing out of the young window -- must come off the change rather than be left to arkd as the whole coin.
  const spare=held-fee,change=spare-(priced(spare)-fee);
  if(change>=o.dust&&priced(change)<=held-change)return {coins:take,fee:held-change,change};
  if(spare>=o.dust)throw new Error(`The renewal would pay ${spare} sats over its ${fee}-sat fee.`);
  return {coins:take,fee:held,change:0};
 }
 // A deposit owes a young input's own fee, and has to leave a float above dust behind, or the next renewal asks again.
 const deposited=(value:number)=>rollupRenewalFee(o.fees,[...o.pool,...take,{txid:'',vout:0,value,script:'',createdAt:new Date()}],o.outputs)-held;
 let needs=o.dust;
 for(let i=0;i<8&&deposited(needs)+o.dust>needs;i++)needs=deposited(needs)+o.dust;
 throw new Error(`The operator wallet needs ${needs} sats to pay the renewal fee.`);
}

/** The coin a forfeit the batch handler built is for: it puts the coin being forfeited at input 0. */
export function rollupForfeitCoin(tx:Pick<Transaction,'getInput'>):string {
 const input=tx.getInput(0);
 return input?.txid?`${hex.encode(input.txid)}:${input.index}`:'';
}
export const isRollupFeeForfeit=(fee:readonly {txid:string;vout:number}[],tx:Pick<Transaction,'getInput'>):boolean=>
 fee.some(c=>`${c.txid}:${c.vout}`===rollupForfeitCoin(tx));
// A PSBT that will not parse keys as '' instead of throwing: a mangled forfeit belongs in front of arkd, which refuses it.
const forfeitCoinOf=(psbt:string):string=>{try{return rollupForfeitCoin(Transaction.fromPSBT(base64.decode(psbt)));}catch{return '';}};
/** The forfeits arkd must see: the emulator answers only for the coins its own packet names, so ours stand as signed. */
export function rollupForfeitsForArkd(fee:readonly {txid:string;vout:number}[],sent:readonly string[],answered:readonly string[]):string[] {
 const byCoin=new Map(answered.map(a=>[forfeitCoinOf(a),a])),mine=new Set(fee.map(c=>`${c.txid}:${c.vout}`));
 return sent.map(forfeit=>{const coin=forfeitCoinOf(forfeit);return mine.has(coin)?forfeit:byCoin.get(coin)??forfeit;});
}
/** The emulator provider the batch handler must use: only what this returns from submitFinalization reaches arkd. */
export function rollupFeeEmulator(emulator:RestEmulatorProvider,fee:readonly {txid:string;vout:number}[]):RestEmulatorProvider {
 if(!fee.length)return emulator;
 return new Proxy(emulator,{get:(target,prop)=>prop==='submitFinalization'
  ?async(intent:{proof:string;message:Intent.RegisterMessage},forfeits:string[],connectors:never,commitment:string)=>{
    const answer=await emulator.submitFinalization(intent,forfeits,connectors,commitment);
    return {...answer,signedForfeits:rollupForfeitsForArkd(fee,forfeits,answer.signedForfeits)};
   }
  :typeof (target as never)[prop]==='function'?((target as never)[prop] as Function).bind(target):(target as never)[prop]});
}

/**
 * Moves the head and the given reserves (all, by default), unchanged, into a fresh round; returns their new outpoints.
 * ponytail: one-shot; a crash after registration strands the intent until flushRollupIntent clears it.
 */
export interface RollupRenewalProviders {ark?:RestArkProvider;emulator?:RestEmulatorProvider;indexer?:RestIndexerProvider;wallet?():ReturnType<typeof openCustomerArkWallet>}
export async function renewRollupPool(o:{network:StockNetworkInfo;identity:Identity;operatorSecret:Uint8Array;pool:VtxoScript;renewLeaf:Uint8Array;leaves:RollupLeaves;token:string;archive:RollupArchive;reserves?:readonly string[];
 /** Called with the registered intent id before the round is joined; arkd re-queues that intent until it confirms or is cleared. */
 onIntent?(intentId:string):Promise<void>|void;providers?:RollupRenewalProviders}):Promise<Pick<RollupArchive,'head'|'reserves'>&{commitment:string}> {
 const ark=o.providers?.ark??new RestArkProvider(o.network.arkUrl),emulator=o.providers?.emulator??new RestEmulatorProvider(o.network.emulatorUrl);
 const indexer=o.providers?.indexer??new RestIndexerProvider(o.network.indexerUrl??o.network.arkUrl);
 const carried=carriedReserves(o.archive.reserves,o.reserves),reserves=Object.entries(carried);
 const points=rollupPoolPoints({head:o.archive.head,reserves:carried});
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
 const poolOut=coins.map(c=>({value:c.value,script:hex.encode(o.pool.pkScript)}));
 const info=await ark.getInfo(),fees=info.fees.intentFee;
 // The renew leaf tunnels each pool coin's value onto its own output, so the fee can only come from coins outside the pool.
 const funded=await withArkWallet(()=>o.providers?.wallet?.()??openCustomerArkWallet(o.identity,o.network),async operator=>
  fundRollupRenewalFee({fees,dust:Number(info.dust),pool:coins,outputs:poolOut,coins:operator.coins.map(c=>c.coin)}));
 const fee=await withPrevTxs(funded.coins,indexer),feePoints=fee.map(c=>`${c.txid}:${c.vout}`);
 const proof=Intent.create(message,[...coins,...fee],[...coins.map(c=>({script:o.pool.pkScript,amount:BigInt(c.value)})),
  ...(funded.change?[{script:hex.decode(funded.coins[0]!.script),amount:BigInt(funded.change)}]:[]),ext.txOut()]);
 const emulated=await emulator.submitIntent({proof:Buffer.from(proof.toPSBT()).toString('base64'),message});
 // The emulator signs the pool's inputs; the operator's own fee coins are signed after, so its signatures survive the round trip.
 const signedProof=fee.length?base64.encode((await o.identity.sign(Transaction.fromPSBT(base64.decode(emulated)),fee.map((_,i)=>coins.length+1+i))).toPSBT()):emulated;
 const intentId=await ark.registerIntent({proof:signedProof,message});
 // Every failure past this point names the intent, which arkd re-queues until it is confirmed or cleared.
 try{
  await o.onIntent?.(intentId);
  // Pool forfeits are signed by the emulator and arkd, so the handler's signer passes those through and signs only the fee coins'.
  const selective=new Proxy(o.identity,{get:(target,prop)=>prop==='sign'?async(tx:Transaction,indexes?:number[])=>isRollupFeeForfeit(fee,tx)?o.identity.sign(tx,indexes):tx:typeof (target as never)[prop]==='function'?((target as never)[prop] as Function).bind(target):(target as never)[prop]});
  // A fee coin carries no arkade script; the handler reads the field on no path, but its input type still demands one.
  const inputs=[...coins.map(c=>({...c,arkadeScriptBytes:o.leaves.renew})),...fee] as ArkadeBatchInput[];
  const handler=arkade.createArkadeBatchHandler(intentId,inputs,selective,signedProof,message,session,ark,rollupFeeEmulator(emulator,fee),networks.mutinynet);
  const abortController=new AbortController();
  let commitment:string;
  try{commitment=await Batch.join(ark.getEventStream(abortController.signal,[cosigner,...points.map(p=>`${p.txid}:${p.vout}`),...feePoints]),handler,{abortController});}
  finally{abortController.abort();}
  return {commitment,...await renewedRollupPool(indexer,o.pool,o.token,{reserves:carried})};
 }catch(error){throw new Error(`Rollup renewal intent ${intentId} is registered and must be confirmed or cleared: ${(error as Error).message}`,{cause:error});}
}

export async function renewedRollupPool(indexer:Pick<RestIndexerProvider,'getVtxos'|'getVirtualTxs'>,pool:VtxoScript,token:string,archive:Pick<RollupArchive,'reserves'>):Promise<Pick<RollupArchive,'head'|'reserves'>> {
 const live=(await indexer.getVtxos({scripts:[hex.encode(pool.pkScript)],spendableOnly:true})).vtxos;
 const coinOf=async(v:RenewedCoin):Promise<RollupPoolCoin>=>{
  const raw=(await indexer.getVirtualTxs([v.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===v.txid);
  if(!raw)throw new Error(`Renewed coin ${v.txid} is not indexed yet.`);
  return {txid:v.txid,vout:v.vout,value:v.value,sourceTxHex:hex.encode(raw.toBytes(true,true))};
 };
 const moved=renewedRollupPoolCoins(token,Object.entries(archive.reserves).map(([assetId,coin])=>[assetId,coin.amount] as const),live);
 const renewed:RollupArchive['reserves']={};
 for(const reserve of moved.reserves)renewed[reserve.assetId]={...await coinOf(reserve.coin),amount:reserve.amount};
 return {head:await coinOf(moved.head),reserves:renewed};
}

/** What a renewal left behind by a dead process needs, given the head it started from and that head's indexer record. */
export function leftoverRenewal(pending:{head:{txid:string;vout:number}},archiveHead:{txid:string;vout:number},coin:{isSpent?:boolean;settledBy?:string}|undefined):'done'|'adopt'|'moved'|'flush' {
 if(archiveHead.txid!==pending.head.txid||archiveHead.vout!==pending.head.vout)return 'done';
 if(coin?.settledBy)return 'adopt';
 return coin?.isSpent?'moved':'flush';
}

/**
 * Clears an intent no live process can cosign. arkd re-queues it into every round and meanwhile refuses batch spends of the head;
 * confirming it lets its round fail at nonce collection, after which arkd drops it. 'absent' means no round took it up.
 */
export async function flushRollupIntent(o:{arkUrl:string;intentId:string;topics:string[];waitMs?:number;ark?:Pick<RestArkProvider,'getEventStream'|'confirmRegistration'>}):Promise<'flushed'|'absent'> {
 const ark=o.ark??new RestArkProvider(o.arkUrl),hash=hex.encode(sha256(new TextEncoder().encode(o.intentId))),abort=new AbortController();
 let batch='',timer=setTimeout(()=>abort.abort(),o.waitMs??180_000);
 try{
  for await(const event of ark.getEventStream(abort.signal,o.topics)){
   if(event.type===SettlementEventType.BatchStarted&&!batch&&event.intentIdHashes.includes(hash)){
    batch=event.id;await ark.confirmRegistration(o.intentId);
    clearTimeout(timer);timer=setTimeout(()=>abort.abort(),120_000);
   }else if(batch&&event.type===SettlementEventType.BatchFailed&&event.id===batch)return 'flushed';
  }
  if(!abort.signal.aborted)throw new Error('The arkd event stream closed before the intent could be cleared.');
 }catch(error){if(!abort.signal.aborted)throw error;}
 finally{clearTimeout(timer);abort.abort();}
 if(batch)throw new Error(`Renewal intent ${o.intentId} was confirmed in round ${batch}, but that round never failed.`);
 return 'absent';
}
