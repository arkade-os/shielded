export const PRIVATE_FETCH=Symbol.for('shielded.private.fetch');
export const SEALED_FETCH=Symbol.for('shielded.sealed.fetch');
export const PRIVATE_POOL_API=Symbol.for('shielded.private.pool-api');
export const PRIVATE_POOL_PAGE=Symbol.for('shielded.private.pool-page');
export const PRIVATE_PAGE_DEFAULT=50;
export const PRIVATE_ONCHAIN_POLL_MS=60_000;
export const PRIVATE_SUBMIT_JITTER_MS=10_000,PRIVATE_SPEND_POLL_MS=20_000,PRIVATE_VERDICT_EVERY=5,PRIVATE_SIGN_POLL_MS=3_000;
export const privateInterval=(ms:number):number=>Math.round(ms*(1+Math.random()/4));

export const RATE_LIMIT_MIN_MS=1_000,RATE_LIMIT_FALLBACK_MS=60_000,RATE_LIMIT_MAX_MS=60_000;
export const retryAfterMs=(header:string|null|undefined):number|undefined=>{
 const value=header?.trim();if(!value)return undefined;
 const delay=/^\d+$/.test(value)?Number(value)*1000:/^[A-Za-z]/.test(value)?Date.parse(value)-Date.now():NaN;
 return Number.isSafeInteger(delay)&&delay>=0?delay:undefined;
};
const limitedUntil=new Map<string,number>();
export const rateLimitRemainingMs=(url:string):number=>Math.max(0,(limitedUntil.get(new URL(url).origin)??0)-Date.now());
// Every host is fronted by one CDN whose limit counts the exit address, so a refusal on any path to it holds back the rest; a capped cooldown re-reads instead of stalling behind an hour-long Retry-After.
export const reportRateLimit=(url:string,retryAfter:string|null|undefined):void=>{
 const parsed=retryAfterMs(retryAfter),origin=new URL(url).origin;
 const until=Date.now()+Math.min(parsed===undefined?RATE_LIMIT_FALLBACK_MS:Math.max(RATE_LIMIT_MIN_MS,parsed),RATE_LIMIT_MAX_MS);
 limitedUntil.set(origin,Math.max(limitedUntil.get(origin)??0,until));
};
// Jittered, so the scripts held back by one refusal do not all resume on the same tick.
export const awaitRateLimit=async(url:string,signal?:AbortSignal):Promise<void>=>{
 for(let remaining=rateLimitRemainingMs(url);remaining>0&&!signal?.aborted;remaining=rateLimitRemainingMs(url))
  await new Promise<void>(resolve=>{
   const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();},timer=setTimeout(done,privateInterval(remaining));
   signal?.addEventListener('abort',done,{once:true});
  });
};

const brandOf=(value:unknown,key:symbol)=>typeof value==='function'?(value as unknown as Record<symbol,unknown>)[key]:undefined;
const marked=(value:unknown,key:symbol)=>brandOf(value,key)===true;
const mark=<T extends object>(value:T,key:symbol,brand:unknown=true):T=>{Object.defineProperty(value,key,{value:brand});return value;};
export const isPrivateFetch=(value:unknown):boolean=>marked(value,PRIVATE_FETCH);
export const markPrivateFetch=<T extends typeof fetch>(value:T):T=>mark(value,PRIVATE_FETCH);
export const isSealedFetch=(value:unknown):boolean=>marked(value,SEALED_FETCH);
export const markSealedFetch=<T extends typeof fetch>(value:T):T=>mark(value,SEALED_FETCH);
export const isPrivatePoolApi=(value:unknown):boolean=>marked(value,PRIVATE_POOL_API);
export const markPrivatePoolApi=<T extends object>(value:T):T=>mark(value,PRIVATE_POOL_API);
export const markPrivatePoolPage=<T extends object>(value:T,size:number):T=>mark(value,PRIVATE_POOL_PAGE,size);
export const privatePoolPage=(value:unknown):number=>{const size=brandOf(value,PRIVATE_POOL_PAGE) as number;return Number.isSafeInteger(size)&&size>=1&&size<=100?size:PRIVATE_PAGE_DEFAULT;};
