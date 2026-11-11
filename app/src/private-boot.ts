import {base64urlnopad} from '@scure/base';
import {installPrivateTransport,type PrivateTransport} from '../../src/shielded/private-transport.ts';

export const PRIVATE_FLAG='shielded-private-transport-v1';
type FlagStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

/** The URL is read before storage, so storage that throws loses only the stored flag. */
export function privateFlag(search:string,storage:FlagStorage,store=true):boolean{
 if(new URLSearchParams(search).get('private')==='1'){if(store)try{storage.setItem(PRIVATE_FLAG,'1');}catch{}return true;}
 try{return storage.getItem(PRIVATE_FLAG)==='1';}catch{return false;}
}

export function bootPrivateTransport(env:{config:string;gateway:string;relays:string;poolOrigin:string},search:string,storage:FlagStorage,pageOrigin:string,globals?:Record<string,unknown>):PrivateTransport|undefined{
 if(!env.config||!env.gateway||!privateFlag(search,storage))return undefined;
 const relays=env.relays.split(',').map(relay=>relay.trim()).filter(Boolean);
 return installPrivateTransport({config:base64urlnopad.decode(env.config),gateway:env.gateway,poolOrigin:env.poolOrigin,pageOrigin,storage,globals,...(relays.length?{relays}:{})});
}

/** A native build has its own transport. Without `install`, which only a pinned build makes, the flag keeps the wallet closed: opening would send every request direct. */
export function bootPrivate(native:boolean,install:(()=>PrivateTransport|undefined)|undefined,search:string,storage:FlagStorage):PrivateTransport|undefined{
 if(native)return undefined;
 if(install)return install();
 if(privateFlag(search,storage,false))throw new Error('this build has no private gateway pinned');
 return undefined;
}

if(typeof __NATIVE_BUILD__!=='undefined'){
 // Reading localStorage throws where site data is blocked; through these calls that reads as off rather than as a failed boot.
 const storage:FlagStorage={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)};
 // A ternary on the defines, not a call taking them: only constant folding drops the transport and its cipher suite from an unpinned build.
 const install=__SHIELDED_OHTTP_CONFIG__&&__SHIELDED_NOSTR_GATEWAY__?()=>bootPrivateTransport({config:__SHIELDED_OHTTP_CONFIG__,gateway:__SHIELDED_NOSTR_GATEWAY__,relays:__SHIELDED_NOSTR_RELAYS__,poolOrigin:__SHIELDED_POOL_ORIGIN__},location.search,storage,location.origin):undefined;
 try{bootPrivate(__NATIVE_BUILD__,install,location.search,storage);}
 catch(error){
  document.getElementById('root')?.replaceChildren(`Private networking could not start, so the wallet stays closed: ${String(error instanceof Error?error.message:error).replace(/\.$/,'')}. To turn private networking off, remove ${PRIVATE_FLAG} from this site's local storage, then open this page again without ?private=1 in its address.`);
  throw error;
 }
}
