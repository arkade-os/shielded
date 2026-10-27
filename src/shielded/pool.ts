import {Transaction,type Identity} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import type {OwnedNote} from '../../packages/protocol/src/rollup/account.ts';

export interface RollupPoolStatus {phase:'starting'|'keys'|'funding'|'genesis'|'ready'|'blocked';message:string;network?:any;proving?:Record<'spend'|'join'|'batch'|'batchJoin',{wasm:string;zkey:string}>&{batchRecover?:{wasm:string;zkey:string}};pool?:{token:string;notice?:string;address:string;script:string;batches:number;root:string;head:{txid:string;vout:number;value:number};pending:number;padding:number;reserves?:Record<string,string>;maxReserves?:number;
 epoch?:number;epochLen?:number;batchesInEpoch?:number;prevNoteRoot?:string;erCount?:number;rsCount?:number;nullifiers?:number;heapBytes?:number}}
export interface SpendStatus {status:'pending'|'signing'|'included'|'dropped';batch?:number;txid?:string;reason?:string;arkTx?:string;checkpoint?:string;checkpoints?:string[];vin?:number}
export interface Groth16Proof {pi_a:unknown;pi_b:unknown;pi_c:unknown}
export type PoolApi=<T>(path:string,body?:unknown,beforeRequest?:()=>void)=>Promise<T>;
export const poolApiOf=(origin:string,fetcher:typeof fetch=fetch):PoolApi=><T,>(path:string,body?:unknown,beforeRequest?:()=>void)=>rollupApi<T>(path,body,fetcher,1000,origin,beforeRequest);
export const DUST=330;
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
const rateLimitedUntil=new Map<string,number>();
const admissionLimitedUntil=new Map<string,number>();
class PoolRequestError extends Error {
 constructor(message:string,readonly status?:number,options?:ErrorOptions){super(message,options);}
 get transient(){return this.status===undefined||this.status===429||this.status>=500;}
}

/** Retries outages and rate limits; definitive refusals surface at once. */
export async function rollupApi<T>(path:string,body?:unknown,fetcher:typeof fetch=fetch,pauseMs=1000,origin='',beforeRequest?:()=>void):Promise<T>{
 const key=new URL(origin||globalThis.location?.origin||'http://localhost').origin;
 const admission=body!==undefined&&!/^\/spends\/[^/]+\/sign(?:\?|$)/.test(path);
 const request:RequestInit={method:body===undefined?'GET':'POST',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})};
 for(let attempt=0;;attempt++){
  for(let remaining;(remaining=Math.max(rateLimitedUntil.get(key)??0,admission?admissionLimitedUntil.get(key)??0:0)-Date.now())>0;)await sleep(Math.min(remaining,2_147_483_647));
  beforeRequest?.();
  let response:Response|undefined;
  try{response=await fetcher(origin+'/api/rollup'+path,request);}
  catch(error){if(attempt>=4)throw new PoolRequestError(error instanceof Error?error.message:'The pool did not answer (network error).',undefined,{cause:error});}
  if(response&&response.status<500){
   const json=await response.json().catch(()=>({}));
   const metadata=json&&typeof json==='object'?json:{};
   if(response.status===429){
    const retryAfter=response.headers.get('Retry-After')?.trim();
    const delay=retryAfter&&/^\d+$/.test(retryAfter)?Number(retryAfter)*1000:retryAfter&&/^[A-Za-z]/.test(retryAfter)?Date.parse(retryAfter)-Date.now():NaN;
    const cooldown=admission&&(metadata.code==='admission-rate-limit'||metadata.error==='Too many requests from this address; try again in a minute.')?admissionLimitedUntil:rateLimitedUntil;
    cooldown.set(key,Math.max(cooldown.get(key)??0,Date.now()+(Number.isSafeInteger(delay)&&delay>=0?Math.max(1000,delay):60_000)));
    if(attempt<4)continue;
   }
   if(!response.ok)throw Object.assign(new PoolRequestError(metadata.error??`The pool answered ${response.status}.`,response.status),typeof metadata.code==='string'?{code:metadata.code}:{});
   return json as T;
  }
  if(attempt>=4)throw new PoolRequestError(`The pool did not answer (${response?.status??'network error'}).`,response?.status);
  await sleep(pauseMs);
 }
}

/** First batch a wallet opens: a fresh ('new') wallet skips older ones; kept per pool, as a new genesis restarts the count. */
export function bornAtFor(storage:Pick<Storage,'getItem'|'setItem'|'removeItem'>,key:string,pool:{token:string;batches:number}):number {
 const mine=`${key}:${pool.token}`;
 if(storage.getItem(key)==='new'){storage.setItem(mine,String(pool.batches));storage.removeItem(key);}
 return Number(storage.getItem(mine)??0)||0;
}

/** A spend takes one note, so it needs a single note that covers the amount. */
export const pickNote=<N extends OwnedNote>(notes:N[],amount:bigint,inFlight:ReadonlySet<bigint>):N|undefined=>
 notes.filter(n=>!inFlight.has(n.nullifier)&&n.amount>=amount).sort((a,b)=>a.amount<b.amount?-1:a.amount>b.amount?1:0)[0];

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
export async function waitForSpend(id:string,onSigning:(request:SpendStatus)=>Promise<void>,api:PoolApi=poolApiOf(''),pollMs=1000,deadlineMs=Infinity):Promise<SpendStatus>{
 let signed='',interval=pollMs;
 for(const end=Date.now()+deadlineMs;;){
  if(Date.now()>end)throw new Error('The spend did not settle in time; the pool may still include it.');
  let status:SpendStatus|undefined;
  try{status=await api<SpendStatus>('/spends/'+id);}
  catch(error){if(!(error instanceof PoolRequestError)||!error.transient)throw error;}
  if(status?.status==='included'||status?.status==='dropped')return status;
  if(status?.status==='signing'){
   if(status.arkTx!==signed){await onSigning(status);signed=status.arkTx!;}
   interval=pollMs;
  }
  await sleep(interval);
  interval=Math.min(5*pollMs,2*interval);
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
