export const PRIVATE_FETCH=Symbol.for('shielded.private.fetch');
export const PRIVATE_POOL_API=Symbol.for('shielded.private.pool-api');

const marked=(value:unknown,key:symbol)=>typeof value==='function'&&(value as unknown as Record<symbol,unknown>)[key]===true;
const mark=<T extends object>(value:T,key:symbol):T=>{Object.defineProperty(value,key,{value:true});return value;};
export const isPrivateFetch=(value:unknown):boolean=>marked(value,PRIVATE_FETCH);
export const markPrivateFetch=<T extends typeof fetch>(value:T):T=>mark(value,PRIVATE_FETCH);
export const isPrivatePoolApi=(value:unknown):boolean=>marked(value,PRIVATE_POOL_API);
export const markPrivatePoolApi=<T extends object>(value:T):T=>mark(value,PRIVATE_POOL_API);
