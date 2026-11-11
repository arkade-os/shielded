import {ROLLUP_FIELD} from '../../packages/protocol/src/rollup/constants.ts';

type JournalStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;
export interface NativeMutation {url:string;method:string;body?:string}
export interface NativeMutationResponse extends NativeMutation {status:number;requestBody?:string}
interface PendingMutation {origin:string;id:string;body:string;nullifiers:string[];coin?:string;createdAt:number}
const KEY='shielded-native-pool-mutations-v1',MAX_BYTES=4*1024*1024,MAX_ENTRIES=256;
const REFUSED_CODES=new Set(['slot-shape','group-invalid','recover-unarchived','window-tag','nullifier-range','stale-anchor','fee-missing']);
const REFUSED_BODY=new Set(['The request body is not valid JSON.','A spend id is 8 to 32 random bytes in hex.','A spend carries its seven public inputs.','Malformed epoch slot.','An epoch slot names its anchor, not a root.','An epoch slot names exactly one of rCur, for a fast-path spend, and origin, for a recovery.','A recovery names its origin epoch as a whole number.','A window leaf names a whole epoch and its root.','A group has a nonzero id and two or three members; a lone spend has neither.','Expected a decimal field element.','An asset id is 68 lowercase hex characters.','Expected lowercase hex of the right length.','Malformed Groth16 proof.']);
// http.ts refuses these before service.submit; named operator refusals remove their tentative admission before throwing.
const preAdmissionRefusal=(status:number,result:any)=>typeof result?.error==='string'&&(status===429?result.code==='admission-rate-limit'&&result.error==='Too many requests from this address; try again in a minute.':status===400&&(result.code===undefined?REFUSED_BODY.has(result.error):REFUSED_CODES.has(result.code)));
const invalid=()=>new Error('The native payment journal is invalid; funds remain reserved.');
const route=(raw:string)=>{const url=new URL(raw);return {origin:url.origin,path:decodeURIComponent(url.pathname).toLowerCase()};};
export const journalledRoute=(url:string,method:string):boolean=>{const m=method.toUpperCase(),{path}=route(url);return m==='GET'&&/^\/api\/rollup\/spends\/[0-9a-f]{32}$/.test(path)||m==='POST'&&path==='/api/rollup/spends';};
const parseBody=(body:string)=>{
 if(typeof body!=='string'||body.length>MAX_BYTES)throw invalid();
 let parsed:any;try{parsed=JSON.parse(body);}catch{throw invalid();}
 if(!parsed||typeof parsed.id!=='string'||!/^[0-9a-f]{32}$/.test(parsed.id)||!Array.isArray(parsed.slot?.nullifiers)||![1,2].includes(parsed.slot.nullifiers.length))throw invalid();
 const nullifiers:string[]=parsed.slot.nullifiers;
 if(nullifiers.some(n=>typeof n!=='string'||!/^[1-9]\d{0,77}$/.test(n)||BigInt(n)>=ROLLUP_FIELD)||new Set(nullifiers).size!==nullifiers.length)throw invalid();
 let coin:string|undefined;
 if(parsed.coin!==undefined){const c=parsed.coin;if(!c||typeof c.txid!=='string'||!/^[0-9a-f]{64}$/.test(c.txid)||!Number.isSafeInteger(c.vout)||c.vout<0||c.vout>0xffffffff)throw invalid();coin=`${c.txid}:${c.vout}`;}
 return {id:parsed.id as string,nullifiers,...(coin?{coin}:{})};
};
const feeGroup=(body:string)=>{
 const slot=JSON.parse(body).slot;
 return typeof slot.groupId==='string'&&/^[1-9]\d{0,77}$/.test(slot.groupId)&&BigInt(slot.groupId)<ROLLUP_FIELD&&(slot.groupSize===2||slot.groupSize===3)?slot.groupId+':'+slot.groupSize:undefined;
};

export function makeNativeMutationJournal(storage:JournalStorage){
 const load=():PendingMutation[]=>{
  const raw=storage.getItem(KEY);if(raw===null)return [];
  if(raw.length>MAX_BYTES)throw invalid();
  let data:any;try{data=JSON.parse(raw);}catch{throw invalid();}
  if(data?.v!==1||!Array.isArray(data.entries)||data.entries.length>MAX_ENTRIES)throw invalid();
  const entries:PendingMutation[]=[],ids=new Set<string>();
  for(const value of data.entries){
   if(!value||typeof value.origin!=='string'||typeof value.body!=='string'||!Number.isSafeInteger(value.createdAt)||value.createdAt<0)throw invalid();
   let origin:string;try{origin=new URL(value.origin).origin;}catch{throw invalid();}
   if(origin!==value.origin||!value.origin.startsWith('https://'))throw invalid();
   const parsed=parseBody(value.body),key=origin+'/'+parsed.id;
   if(value.id!==parsed.id||JSON.stringify(value.nullifiers)!==JSON.stringify(parsed.nullifiers)||value.coin!==parsed.coin||ids.has(key))throw invalid();
   ids.add(key);entries.push({origin,...parsed,body:value.body,createdAt:value.createdAt});
  }
  return entries;
 };
 const save=(entries:PendingMutation[])=>{
  const encoded=JSON.stringify({v:1,entries});
  if(entries.length>MAX_ENTRIES||new TextEncoder().encode(encoded).byteLength>MAX_BYTES)throw new Error('The native payment journal is full; no payment was sent.');
  storage.setItem(KEY,encoded);
 };
 const beforeNativeMutation=(request:NativeMutation)=>{
  if(request.method.toUpperCase()!=='POST')return;
  const {origin,path}=route(request.url);if(path!=='/api/rollup/spends')return;
  if(!origin.startsWith('https://')||request.body===undefined)throw invalid();
  const parsed=parseBody(request.body),entries=load();
  for(const kept of entries)if(kept.origin===origin){
   if(kept.id===parsed.id)throw new Error('This payment has an uncertain outcome; its funds remain reserved until reconciled.');
   if(parsed.nullifiers.some(n=>kept.nullifiers.includes(n))||parsed.coin&&kept.coin===parsed.coin)throw new Error('These funds remain reserved by an uncertain payment.');
  }
  save([...entries,{origin,...parsed,body:request.body,createdAt:Date.now()}]);
 };
 const pendingPoolNullifiers=(poolOrigin:string):bigint[]=>{
  const origin=new URL(poolOrigin).origin;
  return [...new Set(load().filter(row=>row.origin===origin).flatMap(row=>row.nullifiers))].map(BigInt);
 };
 const pendingPoolOutpoints=(poolOrigin:string):string[]=>{
  const origin=new URL(poolOrigin).origin;
  return [...new Set(load().filter(row=>row.origin===origin&&row.coin!==undefined).map(row=>row.coin!))];
 };
 const observeNativeResponse=(response:NativeMutationResponse)=>{
  if(response.body===undefined)return;
  const method=response.method.toUpperCase(),{origin,path}=route(response.url);
  let result:any;try{result=JSON.parse(response.body);}catch{return;}
  if(method==='POST'&&path==='/api/rollup/spends'){
   if(response.requestBody===undefined||!preAdmissionRefusal(response.status,result))return;
   let parsed:ReturnType<typeof parseBody>;try{parsed=parseBody(response.requestBody);}catch{return;}
   const entries=load(),refused=entries.find(row=>row.origin===origin&&row.id===parsed.id&&row.body===response.requestBody);if(!refused)return;
   const group=result.code==='fee-missing'?feeGroup(refused.body):undefined;
   const remaining=entries.filter(row=>row.origin!==origin||row.id!==refused.id&&(!group||feeGroup(row.body)!==group));
   save(remaining);return;
  }
  const match=/^\/api\/rollup\/spends\/([0-9a-f]{32})$/.exec(path);if(method!=='GET'||response.status!==200||!match)return;
  // An abandoned batch can still land, correcting its spend from dropped to included.
  if(!result||!(result.status==='included'&&typeof result.txid==='string'&&/^[0-9a-f]{64}$/.test(result.txid)&&(result.batch===undefined||Number.isSafeInteger(result.batch)&&result.batch>=0)))return;
  const entries=load(),remaining=entries.filter(row=>row.origin!==origin||row.id!==match[1]);
  if(remaining.length!==entries.length)save(remaining);
 };
 const reconcileNativeMutations=async(fetcher:typeof fetch,poolOrigin:string)=>{
  const origin=new URL(poolOrigin).origin,entries=load().filter(row=>row.origin===origin),controller=new AbortController();let next=0;
  const expired=new Promise<void>(resolve=>{controller.signal.addEventListener('abort',()=>resolve(),{once:true});}),deadline=setTimeout(()=>controller.abort(),10_000);
  try{await Promise.race([expired,Promise.all(Array.from({length:Math.min(4,entries.length)},async()=>{
   while(!controller.signal.aborted){
    const row=entries[next++];if(!row)return;
    const url=origin+'/api/rollup/spends/'+row.id;
    let response:Response,body:string;try{response=await fetcher(url,{cache:'no-store',credentials:'omit',redirect:'error',signal:controller.signal});if(controller.signal.aborted)return;body=await response.text();}catch{continue;}
    if(controller.signal.aborted)return;
    observeNativeResponse({url,method:'GET',status:response.status,body});
   }
  }))]);}finally{clearTimeout(deadline);controller.abort();}
  return {pending:load().filter(row=>row.origin===origin).length};
 };
 return {beforeNativeMutation,pendingPoolNullifiers,pendingPoolOutpoints,observeNativeResponse,reconcileNativeMutations};
}

const current=()=>{if(!globalThis.localStorage)throw new Error('The native payment journal is unavailable; no payment was sent.');return makeNativeMutationJournal(globalThis.localStorage);};
export const beforeNativeMutation=(request:NativeMutation)=>{
 if(request.method.toUpperCase()==='POST'&&route(request.url).path==='/api/rollup/spends')current().beforeNativeMutation(request);
};
export const pendingPoolNullifiers=(poolOrigin:string)=>current().pendingPoolNullifiers(poolOrigin);
export const pendingPoolOutpoints=(poolOrigin:string)=>current().pendingPoolOutpoints(poolOrigin);
export const observeNativeResponse=(response:NativeMutationResponse)=>{
 if(journalledRoute(response.url,response.method))current().observeNativeResponse(response);
};
export const reconcileNativeMutations=(fetcher:typeof fetch,poolOrigin:string)=>current().reconcileNativeMutations(fetcher,poolOrigin);
