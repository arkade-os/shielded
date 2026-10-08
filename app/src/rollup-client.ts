import {Transaction,type Identity} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import type {BuiltSpend,OwnedNote,PublishedBatch,RollupAccount} from '../../packages/protocol/src/rollup/account.ts';

export interface RollupPoolStatus {phase:'starting'|'keys'|'funding'|'genesis'|'ready'|'blocked';message:string;network?:any;proving?:{spend:{wasm:string;zkey:string}};pool?:{token:string;address:string;script:string;batches:number;root:string;head:{txid:string;vout:number;value:number};pending:number;padding:number}}
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
  const page=await api<{total:number;batches:PublishedBatch[]}>(`/batches?from=${account.state.batchCount}&limit=50`);
  for(const batch of page.batches)await account.apply(batch);
  if(account.state.batchCount>=page.total||!page.batches.length)return;
 }
}

/** A spend takes one note, so it needs a single note that covers the amount. */
export const pickNote=(notes:OwnedNote[],amount:bigint,inFlight:Set<bigint>)=>
 notes.filter(n=>!inFlight.has(n.nullifier)&&n.amount>=amount).sort((a,b)=>a.amount<b.amount?-1:a.amount>b.amount?1:0)[0];

export function spendBody(id:string,built:BuiltSpend,proof:Groth16Proof,extra:{program?:Uint8Array;coin?:{txid:string;vout:number;tapTree:string;leaf:string}}={}){
 const s=built.witness.slot;
 return {id,slot:{root:String(s.root),nullifiers:s.nullifiers.map(String),commitments:s.commitments.map(String),ctDigest:String(s.ctDigest),groupId:String(s.groupId),groupSize:s.groupSize},
  publics:built.witness.publicSignals.map(String),proof:{pi_a:proof.pi_a,pi_b:proof.pi_b,pi_c:proof.pi_c},ciphertext:hex.encode(built.ciphertext),
  ...(extra.program?{program:hex.encode(extra.program)}:{}),...(extra.coin?{coin:extra.coin}:{})};
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

/** Polls a spend until it is settled; a rebuilt batch asks the depositor to sign again. */
export async function waitForSpend(id:string,onSigning:(request:SpendStatus)=>Promise<void>,api:Api=rollupApi,pollMs=1000):Promise<SpendStatus>{
 let signed='';
 for(;;){
  const status=await api<SpendStatus>('/spends/'+id);
  if(status.status==='included'||status.status==='dropped')return status;
  if(status.status==='signing'&&status.arkTx!==signed){await onSigning(status);signed=status.arkTx!;}
  await sleep(pollMs);
 }
}
