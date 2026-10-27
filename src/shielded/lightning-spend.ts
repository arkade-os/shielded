import {ArkAddress,type Identity} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {destinationFieldOf} from '../../packages/protocol/src/rollup/notes.ts';
import type {epochTransferBody} from './epoch-pool.ts';
import {checkSigningRequest,signDeposit,waitForSpend,type PoolApi,type SpendStatus} from './pool.ts';

export type LightningTransferBody=ReturnType<typeof epochTransferBody>;
export interface LightningSpendRecord {
 v:1;id:string;owner:string;pool:string;reference:string;kind:'fund'|'shield';paymentHash?:string;destination?:string;amount:string;expiresAt?:number;
 nullifiers:string[];coin?:{txid:string;vout:number;value:number;tapTree:string;leaf:string};body:LightningTransferBody;
 state:'prepared'|'included'|'dropped';txid?:string;reason?:string;
}
export interface LightningSpendStore {
 get(owner:string,pool:string,id:string):Promise<LightningSpendRecord|undefined>;
 list(owner:string,pool:string):Promise<LightningSpendRecord[]>;
 create(record:LightningSpendRecord):Promise<LightningSpendRecord>;
 finish(owner:string,pool:string,id:string,result:{state:'included'|'dropped';txid?:string;reason?:string}):Promise<void>;
}
export const sameLightningSpendRequest=(a:LightningSpendRecord,b:LightningSpendRecord)=>
 a.v===b.v&&a.id===b.id&&a.owner===b.owner&&a.pool===b.pool&&a.reference===b.reference&&a.kind===b.kind&&a.paymentHash===b.paymentHash&&a.destination===b.destination&&a.amount===b.amount&&a.expiresAt===b.expiresAt&&JSON.stringify(a.coin)===JSON.stringify(b.coin);
export const lightningSpendConflict=(a:LightningSpendRecord,b:LightningSpendRecord)=>
 a.owner===b.owner&&a.pool===b.pool&&a.id!==b.id&&a.state!=='dropped'&&b.state!=='dropped'&&
 (a.reference===b.reference||!!a.paymentHash&&a.paymentHash===b.paymentHash||a.body.id===b.body.id||a.nullifiers.some(n=>b.nullifiers.includes(n))||!!a.coin&&!!b.coin&&a.coin.txid===b.coin.txid&&a.coin.vout===b.coin.vout);

export function validateLightningSpend(value:LightningSpendRecord,owner:string,pool:string):LightningSpendRecord {
 const r=value,b=r?.body,fail=()=>{throw new Error('The saved Lightning spend is invalid; its funds remain reserved.');};
 if(!r||r.v!==1||r.owner!==owner||r.pool!==pool||!r.id||!r.reference||!['fund','shield'].includes(r.kind)||!['prepared','included','dropped'].includes(r.state)||!/^\d+$/.test(r.amount)||BigInt(r.amount)<330n)fail();
 if(!b||!/^[0-9a-f]{32}$/.test(b.id)||!Array.isArray(r.nullifiers)||r.nullifiers.length!==1||r.nullifiers.some(n=>!/^\d+$/.test(n)||BigInt(n)<=0n)||JSON.stringify(r.nullifiers)!==JSON.stringify(b.slot?.nullifiers)||!Array.isArray(b.publics)||b.publics.length!==7||b.publics[1]!==r.nullifiers[0]||b.publics[2]!=='0'||b.asset!==undefined)fail();
 if(r.state==='included'&&(!r.txid||!/^[0-9a-f]{64}$/.test(r.txid)))fail();
 if(r.expiresAt!==undefined&&(r.kind!=='fund'||!Number.isSafeInteger(r.expiresAt)||r.expiresAt<=0))fail();
 if(r.kind==='fund'){
  if(!r.paymentHash||!/^[0-9a-f]{64}$/.test(r.paymentHash)||r.coin||b.coin||!r.destination||b.publics[3]!=='0'||b.publics[4]!==r.amount||b.publics[5]!=='0')fail();
  const program=ArkAddress.decode(r.destination!).pkScript.subarray(2);
  if(b.program!==hex.encode(program)||b.publics[6]!==String(destinationFieldOf(program)))fail();
 }else{
  const c=r.coin;
  if(!c||!/^[0-9a-f]{64}$/.test(c.txid)||!Number.isSafeInteger(c.vout)||c.vout<0||!Number.isSafeInteger(c.value)||String(c.value)!==r.amount||!c.tapTree||!c.leaf||!r.destination||r.paymentHash||b.program||b.publics[3]!==r.amount||b.publics[4]!=='0'||b.publics[5]!=='0'||b.publics[6]!=='0')fail();
  if(!b.coin||b.coin.txid!==c!.txid||b.coin.vout!==c!.vout||b.coin.tapTree!==c!.tapTree||b.coin.leaf!==c!.leaf)fail();
 }
 JSON.stringify(r);
 return r;
}

export async function submitLightningSpend(record:LightningSpendRecord,store:LightningSpendStore,o:{api:PoolApi;identity:Identity;poolScript:string;step?:(n:number)=>void}):Promise<SpendStatus> {
 const r=validateLightningSpend(record,record.owner,record.pool);
 if(r.state==='included')return {status:'included',txid:r.txid};
 if(r.state==='dropped')return {status:'dropped',reason:r.reason};
 let first:SpendStatus|undefined;
 try{first=await o.api<SpendStatus>(`/spends/${r.body.id}`);}
 catch(error){
  if((error as {status?:number})?.status!==404)throw error;
  const beforeRequest=()=>{if(r.expiresAt!==undefined&&Date.now()/1000>=r.expiresAt)throw new Error('The Lightning funding deadline expired; the saved spend remains reserved until reconciled.');};
  try{beforeRequest();await o.api('/spends',JSON.parse(JSON.stringify(r.body)),beforeRequest);}
  catch(postError){
   // stale-anchor follows the double-spend check over the anchor epoch's sets (epoch-operator.ts:201, :210), so no copy landed; window-tag's older epoch proves nothing.
   if((postError as {code?:unknown})?.code==='stale-anchor')first={status:'dropped',reason:(postError as Error).message};
   else try{first=await o.api<SpendStatus>(`/spends/${r.body.id}`);}catch{throw postError;}
  }
 }
 o.step?.(2);
 const final=await waitForSpend(r.body.id,async request=>{
  if(!r.coin)throw new Error('The pool asked to sign a Lightning funding withdrawal; not signing.');
  checkSigningRequest(request,r.coin,o.poolScript);o.step?.(3);
  await o.api(`/spends/${r.body.id}/sign`,await signDeposit(o.identity,request));
 },async<T,>(path:string,body?:unknown)=>{if(first&&body===undefined&&path===`/spends/${r.body.id}`){const result=first;first=undefined;return result as T;}return o.api<T>(path,body);},1000,30*60_000);
 if(final.status==='included'&&(!final.txid||!/^[0-9a-f]{64}$/.test(final.txid)))throw new Error('The pool did not identify the included Lightning spend.');
 await store.finish(r.owner,r.pool,r.id,{state:final.status as 'included'|'dropped',...(final.txid?{txid:final.txid}:{}),...(final.reason?{reason:final.reason}:{})});
 return final;
}
