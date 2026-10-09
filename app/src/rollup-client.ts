import {Transaction,type Identity} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import type {BuiltSpend,OwnedNote,PublishedBatch,RollupAccount} from '../../packages/protocol/src/rollup/account.ts';

export interface RollupPoolStatus {phase:'starting'|'keys'|'funding'|'genesis'|'ready'|'blocked';message:string;network?:any;proving?:Record<'spend'|'join'|'batch'|'batchJoin',{wasm:string;zkey:string}>;pool?:{token:string;notice?:string;address:string;script:string;batches:number;root:string;head:{txid:string;vout:number;value:number};pending:number;padding:number;reserves?:Record<string,string>}}
export interface SpendStatus {status:'pending'|'signing'|'included'|'dropped';batch?:number;txid?:string;reason?:string;arkTx?:string;checkpoint?:string;checkpoints?:string[];vin?:number}
export interface Groth16Proof {pi_a:unknown;pi_b:unknown;pi_c:unknown}
type Api=<T>(path:string,body?:unknown)=>Promise<T>;
export const DUST=330;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));

/** Retries outages (network errors and 5xx); a refusal is the pool's answer and surfaces at once. */
export async function rollupApi<T>(path:string,body?:unknown,fetcher:typeof fetch=fetch,pauseMs=1000):Promise<T>{
 for(let attempt=0;;attempt++){
  let response:Response|undefined;
  try{response=await fetcher('/api/rollup'+path,{method:body===undefined?'GET':'POST',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});}
  catch(error){if(attempt>=4)throw error;}
  if(response&&response.status<500){
   const json=await response.json().catch(()=>({}));
   if(!response.ok)throw Object.assign(new Error(json.error??`The pool answered ${response.status}.`),{status:response.status});
   return json as T;
  }
  if(attempt>=4)throw new Error(`The pool did not answer (${response?.status??'network error'}).`);
  await sleep(pauseMs);
 }
}

export async function syncAccount(account:RollupAccount,api:Api=rollupApi){
 for(;;){
  const page=await api<{total:number;batches:PublishedBatch[]}>(`/batches?from=${account.batchCount}&limit=50`);
  for(const batch of page.batches)await account.apply(batch);
  if(account.batchCount>=page.total||!page.batches.length)return;
 }
}

/** First batch a wallet opens: a fresh ('new') wallet skips older ones; kept per pool, as a new genesis restarts the count. */
export function bornAtFor(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,key:string,pool:{token:string;batches:number}):number {
 const mine=`${key}:${pool.token}`;
 if(storage.getItem(key)==='new'){storage.setItem(mine,String(pool.batches));storage.removeItem(key);}
 return Number(storage.getItem(mine)??0)||0;
}

/** A spend takes one note, so it needs a single note that covers the amount. */
export const pickNote=(notes:OwnedNote[],amount:bigint,inFlight:Set<bigint>)=>
 notes.filter(n=>!inFlight.has(n.nullifier)&&n.amount>=amount).sort((a,b)=>a.amount<b.amount?-1:a.amount>b.amount?1:0)[0];

/** One nullifier for a spend, two for a join; the pool reads the kind from that count. */
export function transferBody(id:string,built:BuiltSpend,proof:Groth16Proof,extra:{program?:Uint8Array;coin?:{txid:string;vout:number;tapTree:string;leaf:string};asset?:string}={}){
 const s=built.witness.slot;
 return {id,slot:{root:String(s.root),nullifiers:s.nullifiers.map(String),commitments:s.commitments.map(String),ctDigest:String(s.ctDigest),groupId:String(s.groupId),groupSize:s.groupSize},
  publics:built.witness.publicSignals.map(String),proof:{pi_a:proof.pi_a,pi_b:proof.pi_b,pi_c:proof.pi_c},ciphertext:hex.encode(built.ciphertext),
  ...(extra.program?{program:hex.encode(extra.program)}:{}),...(extra.coin?{coin:extra.coin}:{}),...(extra.asset?{asset:extra.asset}:{})};
}

/** A two-nullifier slot proves with the join circuit, so a wallet that never merges never downloads it. */
export function provingUrls(built:BuiltSpend,proving:NonNullable<RollupPoolStatus['proving']>){
 const circuit=built.witness.slot.nullifiers.length===2?'join':'spend',keys=proving[circuit];
 return {wasm:`/api/rollup/proving/${circuit}.wasm?v=${keys.wasm}`,zkey:`/api/rollup/proving/${circuit}.zkey?v=${keys.zkey}`};
}

/** Batch inputs spend checkpoint outputs, so the pool head is checkpoint 0's input and our coin is our checkpoint's. */
export function checkSigningRequest(request:SpendStatus,coin:{txid:string;vout:number},poolScript:string){
 const ark=Transaction.fromPSBT(base64.decode(request.arkTx!)),head=Transaction.fromPSBT(base64.decode(request.checkpoints![0]!)),mine=Transaction.fromPSBT(base64.decode(request.checkpoint!));
 const headInput=head.getInput(0),spent=mine.getInput(0),vin=request.vin!;
 if(!headInput.witnessUtxo||hex.encode(headInput.witnessUtxo.script)!==poolScript||hex.encode(ark.getInput(0).txid!)!==head.id)throw new Error('The batch does not spend the pool head first; not signing.');
 if(hex.encode(spent.txid!)!==coin.txid||spent.index!==coin.vout||request.checkpoints![vin]!==request.checkpoint||vin>=ark.inputsLength||hex.encode(ark.getInput(vin).txid!)!==mine.id)throw new Error('The batch does not spend this deposit coin at its input; not signing.');
}

export async function signDeposit(identity:Identity,request:SpendStatus){
 const ark=await identity.sign(Transaction.fromPSBT(base64.decode(request.arkTx!)),[request.vin!]),checkpoint=await identity.sign(Transaction.fromPSBT(base64.decode(request.checkpoint!)),[0]);
 return {arkTx:base64.encode(ark.toPSBT()),checkpoint:base64.encode(checkpoint.toPSBT())};
}

/** Polls a spend until it is settled or the deadline passes; a rebuilt batch asks the depositor to sign again. */
export async function waitForSpend(id:string,onSigning:(request:SpendStatus)=>Promise<void>,api:Api=rollupApi,pollMs=1000,deadlineMs=Infinity):Promise<SpendStatus>{
 let signed='';
 for(const end=Date.now()+deadlineMs;;){
  if(Date.now()>end)throw new Error('The spend did not settle in time; the pool may still include it.');
  const status=await api<SpendStatus>('/spends/'+id);
  if(status.status==='included'||status.status==='dropped')return status;
  if(status.status==='signing'&&status.arkTx!==signed){await onSigning(status);signed=status.arkTx!;}
  await sleep(pollMs);
 }
}

export interface ArkCoin {txid:string;vout:number;value:number;expiresAt?:number;assets?:{assetId:string;amount:bigint}[]}
export type ShieldPlan={kind:'btc';coins:ArkCoin[];amount:number}|{kind:'asset';coin:ArkCoin;assetId:string;units:bigint};
/** What auto-shield moves next: every plain coin as one deposit, else one coin of a listed asset. The pool refuses coins near expiry. */
export function shieldPlan(coins:readonly ArkCoin[],listed:ReadonlySet<string>,now:number,floorMs:number):ShieldPlan|undefined {
 const usable=coins.filter(c=>c.expiresAt===undefined||c.expiresAt-now>floorMs);
 const plain=usable.filter(c=>!c.assets?.length),amount=plain.reduce((sum,c)=>sum+c.value,0);
 if(amount>=DUST)return {kind:'btc',coins:plain,amount};
 const coin=usable.find(c=>c.assets?.length===1&&listed.has(c.assets[0]!.assetId));
 return coin?{kind:'asset',coin,assetId:coin.assets![0]!.assetId,units:coin.assets![0]!.amount}:undefined;
}
/** Arkade asset units by asset, with the coins the pool paid out kept apart, since auto-shield leaves those alone. */
export function arkAssetHoldings(coins:readonly ArkCoin[],payout:(coin:ArkCoin)=>boolean){
 const rows=new Map<string,{assetId:string;payout:boolean;units:bigint;coins:ArkCoin[]}>();
 for(const coin of coins)for(const {assetId,amount} of coin.assets??[]){
  const paid=payout(coin),key=assetId+':'+paid,row=rows.get(key)??{assetId,payout:paid,units:0n,coins:[]};
  row.units+=amount;row.coins.push(coin);rows.set(key,row);
 }
 return [...rows.values()];
}
/** Opens an Arkade wallet for one call and disposes it after; an open wallet keeps an event stream and timers running. */
export async function withArkWallet<W extends {wallet:{dispose():Promise<void>}},T>(open:()=>Promise<W>,use:(wallet:W)=>Promise<T>):Promise<T>{
 const wallet=await open();
 // Not awaited: dispose waits out an in-flight poll, up to 30 s.
 try{return await use(wallet);}finally{void wallet.wallet.dispose().catch(()=>{});}
}
