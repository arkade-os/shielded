import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';

export type NativePurpose='public'|'pool-sync'|'pool-operation'|'indexer'|'ark'|'esplora'|'swap'|'lnurl'|'assets'|'discovery';
export interface NativeRoute {purpose:NativePurpose;key:string}
const digest=(value:string)=>bytesToHex(sha256(new TextEncoder().encode(value)));
const object=(body?:string):Record<string,unknown>=>{try{const value=JSON.parse(body??'{}');if(value&&typeof value==='object'&&!Array.isArray(value))return value;}catch{}throw new Error('Native request requires an object body');};
export function nativeUrl(input:string,origin?:string):URL {
 const url=new URL(input,origin);
 if(!['https:','wss:'].includes(url.protocol)||url.username||url.password||url.hash)throw new Error('Native networking requires a credential-free HTTPS or WSS URL');
 return url;
}
const route=(purpose:NativePurpose,identity:string):NativeRoute=>({purpose,key:purpose+':'+digest(identity)});
export class NativePolicy {
 readonly poolOrigin:string;
 private arks=new Set<string>();
 private indexers=new Set<string>();
 private esploras=new Set<string>();
 private subscriptions=new Map<string,NativeRoute>();
 constructor(pool:string){this.poolOrigin=nativeUrl(pool).origin;}
 registerArk(ark:string,indexer:string){this.arks.add(nativeUrl(ark).origin);this.indexers.add(nativeUrl(indexer).origin);}
 registerEsplora(base:string){this.esploras.add(nativeUrl(base).href.replace(/\/$/,''));}
 subscription(id:string,script:string,origin:string){
  if(!id||!script)throw new Error('Invalid native subscription');
  const key=origin+'|'+id,next=route('indexer',origin+'|script|'+script),previous=this.subscriptions.get(key);
  if(previous&&previous.key!==next.key)throw new Error('The indexer reused a subscription identifier for another script');
  this.subscriptions.set(key,next);
 }
 forgetSubscription(id:string,origin:string){this.subscriptions.delete(origin+'|'+id);}
 clear(){this.subscriptions.clear();}
 explicit(input:string,purpose:NativePurpose,identity:string):NativeRoute {nativeUrl(input,this.poolOrigin);return route(purpose,identity);}
 classify(input:string,method='GET',body?:string):NativeRoute {
  const url=nativeUrl(input,this.poolOrigin),path=decodeURIComponent(url.pathname),origin=url.origin,m=method.toUpperCase();
  if(path.includes('%')||/[\\\u0000-\u001f]/.test(path))throw new Error('Invalid encoded native route');
  if(origin===this.poolOrigin&&path.startsWith('/api/rollup/')){
   const suffix=path.slice('/api/rollup'.length);
   if(m==='GET'&&/^\/(status|assets|archives|times)$/.test(suffix))return route('public',origin+suffix);
   if(m==='GET'&&/^\/(batches|scan|checkpoints\/\d+\/\d+)$/.test(suffix))return route('pool-sync',origin);
   if(m==='GET'&&/^\/proving\/epoch-(spend|join)\.(wasm|zkey)$/.test(suffix))return route('assets',origin);
   if(m==='POST'&&suffix==='/spends'){const id=object(body).id;if(typeof id!=='string'||!id)throw new Error('A native spend needs its durable id');return route('pool-operation',origin+'|'+id);}
   const spend=/^\/spends\/([^/]+)(\/sign)?$/.exec(suffix);
   if(spend&&((m==='GET'&&!spend[2])||(m==='POST'&&spend[2])))return route('pool-operation',origin+'|'+spend[1]);
   if(m==='POST'&&suffix==='/assets')return route('pool-operation',origin+'|asset|'+digest(body??''));
  }
  if(this.indexers.has(origin)&&path.startsWith('/v1/indexer/')){
   if(m==='GET'&&path==='/v1/indexer/vtxos'){
    const scripts=url.searchParams.getAll('scripts'),outpoints=url.searchParams.getAll('outpoints');
    if(scripts.length+outpoints.length!==1)throw new Error('Native indexer reads require exactly one item; grouped reads are forbidden');
    return route('indexer',origin+(scripts.length?'|script|':'|outpoint|')+(scripts[0]??outpoints[0]));
   }
   if(m==='POST'&&path==='/v1/indexer/script/subscribe'){
    const data=object(body),scripts=data.scripts;
    if(!Array.isArray(scripts)||scripts.length!==1||typeof scripts[0]!=='string'||data.subscriptionId)throw new Error('Native subscriptions require one script and a fresh server identifier');
    return route('indexer',origin+'|script|'+scripts[0]);
   }
   const subscription=/^\/v1\/indexer\/script\/subscription\/([^/]+)$/.exec(path);
   if(subscription&&m==='GET')return this.knownSubscription(subscription[1]!,origin);
   if(m==='POST'&&path==='/v1/indexer/script/unsubscribe'){const data=object(body);if(typeof data.subscriptionId==='string')return this.knownSubscription(data.subscriptionId,origin);}
   if(m==='GET'&&/^\/v1\/indexer\/virtualTx\/[0-9a-f]{64}$/.test(path))return route('indexer',origin+path);
   if(m==='GET'&&/^\/v1\/indexer\/(batch\/[0-9a-f]{64}\/\d+\/(tree(?:\/leaves)?|sweepTxs)|commitmentTx\/[0-9a-f]{64}(?:\/(connectors|forfeitTxs))?|vtxo\/[0-9a-f]{64}\/\d+\/chain|asset\/[^/]+)$/.test(path))return route('indexer',origin+path);
  }
  if(this.arks.has(origin)){
   if(m==='GET'&&path==='/v1/info')return route('public',origin+path);
   if(m==='GET'&&path==='/v1/batch/events')return route('ark',origin+'|topics|'+url.search);
   if(m==='POST'&&/^\/v1\/(tx\/(submit|finalize|pending)|batch\/(registerIntent|deleteIntent|ack|tree\/submitNonces|tree\/submitSignatures|submitForfeitTxs))$/.test(path))return route('ark',origin+path+'|'+digest(body??''));
  }
  for(const base of this.esploras){
   if(!url.href.startsWith(base+'/'))continue;
   const suffix=path.slice(new URL(base).pathname.replace(/\/$/,'').length);
   if(m==='GET'&&/^\/(fee-estimates|v1\/fees\/recommended|blocks|v1\/blocks)$/.test(suffix))return route('public',base+suffix);
   const address=/^\/address\/([^/]+)(?:\/(utxo|txs))?$/.exec(suffix);
   if(m==='GET'&&address)return route('esplora',base+'|address|'+address[1]);
   const tx=/^\/tx\/([0-9a-f]{64})(?:\/(hex|status|outspends|outspend\/\d+))?$/.exec(suffix);
   if(m==='GET'&&tx)return route('esplora',base+'|tx|'+tx[1]);
   if(m==='POST'&&/^\/(tx|txs\/package)$/.test(suffix))return route('esplora',base+'|broadcast|'+digest(body??''));
  }
  throw new Error('Native network route is not approved: '+m+' '+origin+path);
 }
 private knownSubscription(id:string,origin:string){const found=this.subscriptions.get(origin+'|'+id);if(!found)throw new Error('Unknown native subscription');return found;}
}
