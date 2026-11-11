export const PRIVATE_FETCH=Symbol.for('shielded.private.fetch');
export const SEALED_FETCH=Symbol.for('shielded.sealed.fetch');
export const PRIVATE_POOL_API=Symbol.for('shielded.private.pool-api');
export const PRIVATE_POOL_PAGE=Symbol.for('shielded.private.pool-page');
export const PRIVATE_PAGE_DEFAULT=50;
export const PRIVATE_ONCHAIN_POLL_MS=60_000;
export const privateInterval=(ms:number):number=>Math.round(ms*(1+Math.random()/4));

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
