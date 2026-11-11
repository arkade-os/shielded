import {base64urlnopad} from '@scure/base';
import {installPrivateTransport,type PrivateTransport} from '../../src/shielded/private-transport.ts';

export const PRIVATE_FLAG='shielded-private-transport-v1';
type FlagStorage=Pick<Storage,'getItem'|'setItem'|'removeItem'>;

export function privateFlag(search:string,storage:FlagStorage):boolean{
 try{
  const value=new URLSearchParams(search).get('private');
  if(value==='1'){storage.setItem(PRIVATE_FLAG,'1');return true;}
  if(value==='0'){storage.removeItem(PRIVATE_FLAG);return false;}
  return storage.getItem(PRIVATE_FLAG)==='1';
 }catch{return false;}
}

export function bootPrivateTransport(env:{config:string;gateway:string;relays:string;poolOrigin:string},search:string,storage:FlagStorage,pageOrigin:string,globals?:Record<string,unknown>):PrivateTransport|undefined{
 if(!env.config||!env.gateway||!privateFlag(search,storage))return undefined;
 const relays=env.relays.split(',').map(relay=>relay.trim()).filter(Boolean);
 return installPrivateTransport({config:base64urlnopad.decode(env.config),gateway:env.gateway,poolOrigin:env.poolOrigin,pageOrigin,storage,globals,...(relays.length?{relays}:{})});
}

if(typeof __SHIELDED_OHTTP_CONFIG__!=='undefined'&&__SHIELDED_OHTTP_CONFIG__&&__SHIELDED_NOSTR_GATEWAY__){
 // Reading localStorage throws where site data is blocked; through these calls that reads as off rather than as a failed boot.
 const storage:FlagStorage={getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value),removeItem:key=>localStorage.removeItem(key)};
 try{bootPrivateTransport({config:__SHIELDED_OHTTP_CONFIG__,gateway:__SHIELDED_NOSTR_GATEWAY__,relays:__SHIELDED_NOSTR_RELAYS__,poolOrigin:__SHIELDED_POOL_ORIGIN__},location.search,storage,location.origin);}
 catch(error){
  document.getElementById('root')?.replaceChildren(`Private networking could not start, so the wallet stays closed: ${String(error instanceof Error?error.message:error).replace(/\.$/,'')}. Open this page with ?private=0 to turn it off.`);
  throw error;
 }
}
