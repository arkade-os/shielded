import {DefaultVtxo,deriveDescriptorLeafCompressedPubKey,networkFromArkadeInfo,parseHDDescriptor,timelockToSequence,type Identity,type Wallet} from '@arkade-os/sdk';
import {LnurlError,createLnurlClient,type FetchImpl} from '@arkade-os/lnurl-client';
import {deriveSessionTokenForIdentity} from '@arkade-os/lnurl-client/arkade';
import {HDKey} from '@scure/bip32';
import {hex} from '@scure/base';
import {LNURL_BASE} from './lightning.ts';

interface ReceiveBranch {descriptor:string;serverPubKey:string;hrp:'ark'|'tark';exitDelay:{type:'seconds'|'blocks';value:number}}
export interface LnurlPayout {id:string;descriptor:string;address:string;script:string}
export interface PaymentMethod {type:string;destination:string}
export interface LnurlReceiver {handle:string;domain:string;lightningAddress:string|undefined;lnurl:string;status:string;nameless?:boolean;sessionLnurl?:string;paymentMethods?:PaymentMethod[]}
export interface PrivateReceiveState {on:boolean;pending:boolean;refused:boolean;withdrawing:boolean;listed:'own'|'foreign'|null}
export type UnifiedReceiveStage='Reading your saved receiver'|'Checking the Lightning address service through Tor'|'Registering your unified address'|'Restoring payout watches'|'Binding your payment routes'|'Unified address ready';
export interface LnurlReceiveJournal {
 getReceiveState<T>(owner:string,pool:string,key:string):Promise<T|undefined>;
 saveReceiveState(owner:string,pool:string,key:string,state:unknown):Promise<void>;
}
interface Destination extends LnurlPayout {index:number;claimPublicKey:string;params?:{pubKey:string;serverPubKey:string;csvTimelock:string}}
// withdraw: a methods:[] bind is owed to the service and stays owed until a listing shows the method gone.
// methodsPending: switched on, not live until a listing echoes the address. methodsRefused: the service did not keep it, so consent was dropped and whatever stays listed is withdrawn.
interface ServerState {receivers:LnurlReceiver[];pending?:string;current?:string;boundAt?:number;refused?:true;migrated?:true;recovering?:true;methods?:true;methodsPending?:true;methodsRefused?:true;withdraw?:true}
interface ReceiveState {v:1;next:number;payouts:Destination[];servers:Record<string,ServerState>}
interface LegacyState {v:1;receivers:LnurlReceiver[];pending?:string;payouts:LnurlPayout[]}
export const WATCH_STARTUP_GRACE_MS=5_000;
export interface LnurlReceiveConfig {
 identity:Identity;companion:Wallet;journal:LnurlReceiveJournal;owner:string;pool:string;baseUrl?:string;domain?:string;fetch?:FetchImpl;now?:()=>number;
 signal?:AbortSignal;
  onStage?:(stage:UnifiedReceiveStage)=>void;
 onPayouts?:(payouts:LnurlPayout[],signal:AbortSignal)=>Promise<void>;
 onPayoutError?:(error:unknown,revision:number)=>void;
 onPayoutReady?:(revision:number)=>void;
 watchStartupGraceMs?:number;
 shieldedAddress?:()=>string;
}
// Each idle rotation leaves one unused index, so daily keeps a year of idle rotations inside RECOVERY_GAP.
export const ROTATE_AFTER_MS=24*60*60_000,CHECK_EVERY_MS=10*60_000,RECOVERY_GAP=400;
export const HD_REFUSED='This Lightning address is still in HD receive mode, and its service cannot switch it to a private static address until the service is updated. Earlier payouts stay watched; the wallet retries automatically.';
export const METHODS_REFUSED='The service for this Lightning address did not keep the private receive address, so payers are not offered it. The wallet has stopped sending it; switch private receive on again once the service is updated.';
export const METHODS_NOT_WITHDRAWN='The service for this Lightning address still lists the private receive address after it was withdrawn, so payers may still be offered it. The wallet keeps asking the service to remove it and retries automatically.';
const SCAN_BATCH=50,STATE_POOL='lnurl-receive',STATE_KEY='state-v1';
const TESTNET_BIP32={public:0x043587cf,private:0x04358394};
const failedContractWatches=new WeakMap<Wallet,Set<string>>();
const indexOf=(index:number)=>{if(!Number.isSafeInteger(index)||index<0||index>=0x80000000)throw new Error('Invalid Lightning receive index');return index;};

export function receiveBranch(accountDescriptor:string,params:Omit<ReceiveBranch,'descriptor'>){
 const parsed=parseHDDescriptor(accountDescriptor);
 if(!parsed||!accountDescriptor.endsWith('/*)')||!/^(xpub|tpub)/.test(parsed.xpub))throw new Error('Private Lightning receive requires a public HD account template');
 const testnet=parsed.xpub.startsWith('tpub');
 if((params.hrp==='tark')!==testnet)throw new Error('HD receive descriptor network mismatch');
 const node=HDKey.fromExtendedKey(parsed.xpub,testnet?TESTNET_BIP32:undefined);
 if(node.depth!==parsed.basePath.split('/').length)throw new Error('Invalid HD receive account origin');
 const branch=node.derive('m/2/7');
 if(branch.depth<4||Number(parsed.derivationPath.split('/')[0])===2)throw new Error('HD receive requires a dedicated branch below the account');
 const base=parsed.basePath.split('/').map(part=>`${Number(part.replace(/['hH]$/,''))}${/['hH]$/.test(part)?"'":''}`).join('/'),fingerprint=parsed.fingerprint.toLowerCase();
 const hd:ReceiveBranch={descriptor:`tr([${fingerprint}/${base}/2/7]${branch.publicExtendedKey}/*)`,serverPubKey:params.serverPubKey.toLowerCase(),hrp:params.hrp,exitDelay:{...params.exitDelay}};
 const signingDescriptor=(index:number)=>`tr([${fingerprint}/${base}]${parsed.xpub}/2/7/${indexOf(index)})`;
 const units=hd.exitDelay.type==='seconds'?hd.exitDelay.value/512:hd.exitDelay.value;
 if(!/^[0-9a-f]{64}$/.test(hd.serverPubKey)||!['ark','tark'].includes(hd.hrp)||!['seconds','blocks'].includes(hd.exitDelay.type)||!Number.isSafeInteger(units)||units<=0||units>65535)throw new Error('Invalid HD receive script configuration');
 return {hd,node:branch,signingDescriptor};
}

function receiveScript(hd:ReceiveBranch,index:number){
 const descriptor=hd.descriptor.replace('*',String(indexOf(index))),publicKey=deriveDescriptorLeafCompressedPubKey(descriptor);
 const script=new DefaultVtxo.Script({pubKey:publicKey.slice(1),serverPubKey:hex.decode(hd.serverPubKey),csvTimelock:{type:hd.exitDelay.type,value:BigInt(hd.exitDelay.value)}});
 return {descriptor,publicKey,script,address:script.address(hd.hrp,hex.decode(hd.serverPubKey)).encode()};
}

export function receiveDestination(branch:ReturnType<typeof receiveBranch>,index:number):Destination{
 const derived=receiveScript(branch.hd,index),descriptor=branch.signingDescriptor(index),claimPublicKey=hex.encode(derived.publicKey),script=hex.encode(derived.script.pkScript);
 if(hex.encode(deriveDescriptorLeafCompressedPubKey(descriptor))!==claimPublicKey)throw new Error('Lightning receive key does not match its signing descriptor');
 return {id:`lnurl:${script}`,index,descriptor,address:derived.address,script,claimPublicKey,
  params:{pubKey:hex.encode(derived.publicKey.slice(1)),serverPubKey:branch.hd.serverPubKey,csvTimelock:timelockToSequence(derived.script.options.csvTimelock).toString()}};
}

export function createLnurlReceive(config:LnurlReceiveConfig){
 const url=new URL(config.baseUrl??LNURL_BASE);
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid Lightning address service URL');
 const baseUrl=url.href.replace(/\/+$/,''),domain=(config.domain??url.hostname).toLowerCase(),serverKey=JSON.stringify([baseUrl,domain]),now=config.now??Date.now;
 const abort=new AbortController(),stop=()=>abort.abort(),fetcher=config.fetch??((input,init)=>globalThis.fetch(input,init));
 if(config.signal?.aborted)abort.abort();else config.signal?.addEventListener('abort',stop,{once:true});
   const untilStopped=<T,>(work:Promise<T>)=>new Promise<T>((resolve,reject)=>{
    const stop=()=>reject(new Error('Lightning address service is disposed'));
    if(abort.signal.aborted){void work.catch(()=>{});return stop();}
   abort.signal.addEventListener('abort',stop,{once:true});
   work.then(value=>{abort.signal.removeEventListener('abort',stop);resolve(value);},error=>{abort.signal.removeEventListener('abort',stop);reject(error);});
  });
 const guardedFetch:FetchImpl=(input,init)=>fetcher(input,{...init,redirect:'error',credentials:'omit',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30_000),...(init?.signal?[init.signal]:[])])});
 const client=createLnurlClient({baseUrl,fetchImpl:guardedFetch});
 let tokenOnce:Promise<string>|undefined,tail:Promise<unknown>=Promise.resolve(),timer:ReturnType<typeof setInterval>|undefined,timerBusy=false,disposed=false,watched=false,watchRevision=0,offEvents:(()=>void)|undefined,closing:Promise<void>|undefined;
 const pendingWrites=new Set<Promise<unknown>>();
 const token=()=>tokenOnce??=deriveSessionTokenForIdentity(config.identity,domain);
 const dataWork=<T>(work:Promise<T>)=>{pendingWrites.add(work);void work.then(()=>pendingWrites.delete(work),()=>pendingWrites.delete(work));return untilStopped(work);};
 const serial=<T,>(fn:()=>Promise<T>):Promise<T>=>{const pending=tail.then(()=>{if(disposed||abort.signal.aborted)throw new Error('Lightning address service is disposed');return fn();});tail=pending.catch(()=>{});return pending;};
 const migrate=async(state:ReceiveState)=>{
  const legacy=await dataWork(config.journal.getReceiveState<LegacyState>(config.owner,config.pool,`lnurl-hd-v1:${serverKey}`));
  if(!legacy)return;
  if(legacy.v!==1||!Array.isArray(legacy.receivers)||!Array.isArray(legacy.payouts))throw new Error('Invalid local HD receive state');
  state.servers[serverKey]={receivers:legacy.receivers,migrated:true,...(legacy.pending?{pending:legacy.pending}:{})};
  for(const payout of legacy.payouts){
   const index=indexOf(Number(/\/2\/7\/(\d+)\)$/.exec(payout.descriptor)?.[1]));
   if(!state.payouts.some(row=>row.script===payout.script))state.payouts.push({id:payout.id,descriptor:payout.descriptor,address:payout.address,script:payout.script,index,claimPublicKey:hex.encode(deriveDescriptorLeafCompressedPubKey(payout.descriptor))});
   state.next=Math.max(state.next,index+1);
  }
 };
 // Migration stays unsaved until the next serialized write, so read paths never race one.
 const load=async()=>{
  const state=await dataWork(config.journal.getReceiveState<ReceiveState>(config.owner,STATE_POOL,STATE_KEY))??{v:1,next:0,payouts:[],servers:{}};
  if(state.v!==1||!Number.isSafeInteger(state.next)||state.next<0||!Array.isArray(state.payouts)||!state.servers||typeof state.servers!=='object')throw new Error('Invalid local Lightning receive state');
  if(!state.servers[serverKey])await migrate(state);
  return state;
 };
 const save=(state:ReceiveState)=>dataWork(config.journal.saveReceiveState(config.owner,STATE_POOL,STATE_KEY,state));
 const account=()=>{const descriptor=(config.companion.identity as Identity&{descriptor?:string}).descriptor;if(!descriptor)throw new Error('Private Lightning receive requires an HD companion');return descriptor;};
 const currentBranch=async()=>{
  const info=await dataWork(config.companion.getArkadeInfo({requireLive:true})),hrp=config.companion.network.hrp;
  if((hrp!=='ark'&&hrp!=='tark')||networkFromArkadeInfo(info).hrp!==hrp)throw new Error('HD receive operator network mismatch');
  if(!/^(0[23])?[0-9a-f]{64}$/i.test(info.signerPubkey)||info.unilateralExitDelay>0xffffffffn||info.unilateralExitDelay<0n)throw new Error('Invalid HD receive operator script settings');
  const delay=info.unilateralExitDelay;
  return receiveBranch(account(),{serverPubKey:info.signerPubkey.slice(-64),hrp,exitDelay:{type:delay<512n?'blocks':'seconds',value:Number(delay)}});
 };
 const fromAddress=(row:{handle:string;domain:string;lightningAddress:string|null;lnurl:string;status:string;nameless?:boolean;sessionLnurl?:string|null;paymentMethods?:unknown}):LnurlReceiver=>{
  if(typeof row.handle!=='string'||!row.handle||typeof row.domain!=='string'||row.domain.toLowerCase()!==domain||typeof row.lnurl!=='string'||typeof row.status!=='string'||(row.lightningAddress!==null&&typeof row.lightningAddress!=='string')||(row.nameless!==undefined&&typeof row.nameless!=='boolean')||(row.sessionLnurl!==undefined&&row.sessionLnurl!==null&&typeof row.sessionLnurl!=='string'))throw new Error('Invalid Lightning address registration');
  const paymentMethods=Array.isArray(row.paymentMethods)?row.paymentMethods.filter(method=>typeof method?.type==='string').map(({type,destination}):PaymentMethod=>({type,destination:typeof destination==='string'?destination:''})):undefined;
  return {handle:row.handle,domain,lightningAddress:row.lightningAddress??undefined,lnurl:row.lnurl,status:row.status,...(row.nameless!==undefined?{nameless:row.nameless}:{}),...(row.sessionLnurl?{sessionLnurl:row.sessionLnurl}:{}),...(paymentMethods?{paymentMethods}:{})};
 };
 const registeredReceivers=async()=>(await client.listAddresses(await token())).filter(row=>row.domain.toLowerCase()===domain).map(fromAddress);
 const advertised=()=>{const address=config.shieldedAddress?.();if(!address)throw new Error('Private receive requires a shielded address');return address;};
 const refuseMethods=async(state:ReceiveState,server:ServerState)=>{if(server.methods||!server.methodsRefused){delete server.methods;delete server.methodsPending;server.methodsRefused=true;if(shieldedListed(server).length)server.withdraw=true;await save(state);}};
 const shieldedListed=(server:ServerState)=>server.receivers.filter(row=>row.status==='active').flatMap(row=>row.paymentMethods??[]).filter(m=>m.type==='shielded');
 const refresh=(server:ServerState,listed:LnurlReceiver[])=>{for(const row of server.receivers){const methods=listed.find(l=>l.handle===row.handle)?.paymentMethods;if(methods)row.paymentMethods=methods;else delete row.paymentMethods;}};
 const relist=async(state:ReceiveState,server:ServerState)=>{
  const before=JSON.stringify(server.receivers);
  refresh(server,await registeredReceivers());
  if(JSON.stringify(server.receivers)!==before)await save(state);
 };
 const confirm=async(state:ReceiveState,server:ServerState)=>{
  await relist(state,server);
  if(server.withdraw){
   if(shieldedListed(server).length)throw new Error(METHODS_NOT_WITHDRAWN);
   delete server.withdraw;await save(state);return;
  }
  const destination=advertised();
  if(server.receivers.filter(row=>row.status==='active').every(row=>row.paymentMethods?.some(m=>m.type==='shielded'&&m.destination===destination))){
   if(server.methodsPending){delete server.methodsPending;await save(state);}
   return;
  }
  await refuseMethods(state,server);throw new Error(METHODS_REFUSED);
 };
 const watch=async(rows:Destination[])=>{
  if(!rows.length)return;
  try{
   const manager=await dataWork(config.companion.getContractManager());
   for(const row of rows)if(row.params){
    try{await dataWork(manager.createContract({type:'default',watch:'awaiting-funds',script:row.script,address:row.address,params:row.params,metadata:{signingDescriptor:row.descriptor}}));}
    catch(error){if(abort.signal.aborted)throw error;const failed=failedContractWatches.get(config.companion)??new Set<string>();failed.add(row.script);failedContractWatches.set(config.companion,failed);throw error;}
    // A failed create can persist before attaching; a later create then returns that row without attaching it.
    const failed=failedContractWatches.get(config.companion);
    if(failed?.has(row.script)){await dataWork(manager.updateContract(row.script,{}));failed.delete(row.script);if(!failed.size)failedContractWatches.delete(config.companion);}
   }
   if(config.onPayouts)await dataWork(config.onPayouts(rows.map(({id,descriptor,address,script})=>({id,descriptor,address,script})),abort.signal));
  }catch(error){watched=false;throw error;}
 };
 /** Bounds payout startup while its watch continues in the background. */
 const watchWithGrace=async(rows:Destination[])=>{
  if(!rows.length)return true;
  const revision=++watchRevision,pending=watch(rows);let timer:ReturnType<typeof setTimeout>|undefined;
  try{
   const settled=await Promise.race([
    pending.then(()=>true),
    new Promise<false>(resolve=>{timer=setTimeout(()=>resolve(false),Math.max(0,config.watchStartupGraceMs??WATCH_STARTUP_GRACE_MS));}),
   ]);
   if(settled){
    try{config.onPayoutReady?.(revision);}catch{}
   }else{
    watched=false;
    void pending.then(()=>{
     if(!abort.signal.aborted)try{config.onPayoutReady?.(revision);}catch{}
    },error=>{
     if(abort.signal.aborted)return;
     try{config.onPayoutError?.(error,revision);}catch{}
    });
   }
   return settled;
  }finally{if(timer)clearTimeout(timer);}
 };
 /** Restores payout watches without letting a stalled wallet service hold receive. */
 const restoreWatches=async(state:ReceiveState)=>{if(!watched)watched=await watchWithGrace(state.payouts);};
 const used=async(scripts:string[])=>new Set((await untilStopped(config.companion.indexerProvider.getVtxos({scripts}))).vtxos.map(coin=>coin.script));
 // Highest index from `from` on that ever held a coin; stops after `gap` unused ones.
 const scan=async(branch:ReturnType<typeof receiveBranch>,from:number,gap:number)=>{
  let high=from-1;
  const {hd}=branch,serverPubKey=hex.decode(hd.serverPubKey),csvTimelock={type:hd.exitDelay.type,value:BigInt(hd.exitDelay.value)};
  for(let start=from;start<high+1+gap;start+=SCAN_BATCH){
   const scripts=Array.from({length:SCAN_BATCH},(_,i)=>hex.encode(new DefaultVtxo.Script({pubKey:branch.node.deriveChild(indexOf(start+i)).publicKey!.slice(1),serverPubKey,csvTimelock}).pkScript)),hits=await used(scripts);
   scripts.forEach((script,i)=>{if(hits.has(script))high=start+i;});
  }
  return high;
 };
 /** Adds recovered payout keys and starts their watches without blocking the address forever. */
 const adopt=async(state:ReceiveState,branch:ReturnType<typeof receiveBranch>,from:number,high:number)=>{
  const added:Destination[]=[];
  for(let index=from;index<=high;index++){const row=receiveDestination(branch,index);if(!state.payouts.some(p=>p.script===row.script)){state.payouts.push(row);added.push(row);}}
  state.next=Math.max(state.next,high+1);await save(state);await watchWithGrace(added);
 };
 /** Persists and watches a fresh payout without blocking the address forever. */
 const advance=async(state:ReceiveState,server:ServerState)=>{
  const row=receiveDestination(await currentBranch(),state.next);
  state.next++;state.payouts.push(row);server.current=row.script;delete server.boundAt;
  await save(state);await watchWithGrace([row]);
 };
 const bind=async(state:ReceiveState,server:ServerState)=>{
  const row=state.payouts.find(p=>p.script===server.current);
  if(!row)throw new Error('The bound Lightning receive address is missing from local state');
  const send=async(handle:string,methods?:PaymentMethod[])=>client.registerArkadeIdentity({token:await token(),handle,arkadeAddress:row.address,claimPublicKey:row.claimPublicKey,domain,methods});
  let advertise=server.methods&&!server.withdraw?[{type:'shielded',destination:advertised()}]:undefined,refusal:LnurlError|undefined;
  try{
   for(const receiver of server.receivers)if(receiver.status==='active'){
    const methods=server.withdraw?[]:advertise;
    try{await send(receiver.handle,methods);}
    catch(error){
     // A refused method rejects the whole bind, so the identity is resent alone to keep the address live.
     if(!methods||!(error instanceof LnurlError)||error.httpStatus!==400||error.code==='invalid_rails')throw error;
     if(advertise){refusal=error;advertise=undefined;}
     await send(receiver.handle);
    }
   }
  }
  catch(error){
   if(!(error instanceof LnurlError)||error.code!=='invalid_rails')throw error;
   if(!server.refused){server.refused=true;await save(state);}
   throw new Error(HD_REFUSED,{cause:error});
  }
  if(server.boundAt===undefined||server.refused||server.migrated||server.recovering){server.boundAt??=now();delete server.refused;delete server.migrated;delete server.recovering;await save(state);}
  if(refusal){
   // A listing that cannot be read may still hold the method from an earlier bind, so the withdrawal is owed.
   await relist(state,server).catch(()=>{server.withdraw=true;});
   await refuseMethods(state,server);throw new Error(METHODS_REFUSED,{cause:refusal});
  }
 };
 const settle=async(state:ReceiveState,server:ServerState,beforeBind?:()=>void)=>{
  if(!server.receivers.some(row=>row.status==='active'))return;
  await restoreWatches(state);
  // HD services hand out /2/7 children the journal never saw: catch up until the first static bind lands, then follow them while refused.
  if(server.refused||server.migrated||server.recovering){
   const branch=await currentBranch(),high=await scan(branch,state.next,server.migrated||server.recovering?RECOVERY_GAP:SCAN_BATCH);
   if(high>=state.next)await adopt(state,branch,state.next,high);
  }
  const current=state.payouts.find(row=>row.script===server.current);
  if(!current||(server.boundAt!==undefined&&now()-server.boundAt>=ROTATE_AFTER_MS)||(await used([current.script])).size>0)await advance(state,server);
  beforeBind?.();
  await bind(state,server);
  if(server.methods||server.withdraw)await confirm(state,server);
 };
 const check=()=>serial(async()=>{
  const state=await load(),server=state.servers[serverKey];if(!server)return;
  await restoreWatches(state);
  const off=!server.methods&&!server.withdraw;
  await settle(state,server);
  // Off, the listing is still read so another device's registration shows here; the read sends no methods and no address.
  if(off&&server.receivers.some(row=>row.status==='active'))await relist(state,server);
 });
 const sameReceiver=(a:LnurlReceiver,b:LnurlReceiver)=>a.handle===b.handle||!!a.sessionLnurl&&a.sessionLnurl===b.sessionLnurl;
 const unified=(receiver:LnurlReceiver)=>!!receiver.sessionLnurl&&receiver.lnurl===receiver.sessionLnurl;
 const unsupportedUnified=()=>new Error('This Lightning address service did not register a unified address. Use Recover a Lightning address to enable its existing address explicitly.');
 const ensureUnifiedLocked=async()=>{
   config.onStage?.('Reading your saved receiver');
  const state=await load(),existing=state.servers[serverKey],server=existing??{receivers:[]};
  if(!existing){state.servers[serverKey]=server;await save(state);}
   config.onStage?.('Checking the Lightning address service through Tor');
  const owned=(await registeredReceivers()).filter(row=>row.status==='active');
  const tracked=server.receivers.find(row=>row.status==='active');
  const matched=tracked&&owned.find(row=>sameReceiver(row,tracked));
  let receiver=matched;
  receiver??=owned.find(row=>row.handle===server.pending);
  // A session LNURL belongs to this identity even after its handle is upgraded. A legacy named alias still needs explicit recovery.
  receiver??=owned.find(row=>!!row.sessionLnurl);
  if(receiver&&!matched&&!unified(receiver))throw unsupportedUnified();
  if(!receiver&&owned.length)throw new Error('A Lightning address already exists. Use Recover a Lightning address to enable it here explicitly.');
  const recoverPayouts=!!receiver&&!state.payouts.length;
  if(!receiver){
    config.onStage?.('Registering your unified address');
   const registered=fromAddress(await client.registerAddress({token:await token(),domain,nameless:true}));
   server.pending=registered.handle;await save(state);
   if(!unified(registered))throw unsupportedUnified();
   receiver=registered;
  }
  const receivers=[receiver,...server.receivers.filter(row=>!sameReceiver(row,receiver))];
  if(recoverPayouts)server.recovering=true;
  if(JSON.stringify(server.receivers)!==JSON.stringify(receivers)||server.pending||recoverPayouts){server.receivers=receivers;delete server.pending;await save(state);}
   config.onStage?.('Restoring payout watches');
  await settle(state,server,()=>config.onStage?.('Binding your payment routes'));
   config.onStage?.('Unified address ready');
  return receiver;
 };
 return {
  enabled:async()=>Boolean((await load()).servers[serverKey]),
  current:async()=>(await load()).servers[serverKey]?.receivers.find(row=>row.status==='active'),
  ensureUnified:()=>serial(ensureUnifiedLocked),
  claimName:()=>serial(async()=>{
   const receiver=await ensureUnifiedLocked();
   if(receiver.lightningAddress)return receiver;
   if(!receiver.sessionLnurl)throw new Error('This unified address cannot be named.');
   const named=fromAddress(await client.upgradeAddress({token:await token(),handle:receiver.handle,domain}));
   if(!named.lightningAddress||named.sessionLnurl!==receiver.sessionLnurl||named.lnurl!==receiver.lnurl)throw new Error('The Lightning address service did not keep the unified address during the claim.');
   const state=await load(),server=state.servers[serverKey];
   if(!server)throw new Error('The unified address is not enabled on this device.');
   server.receivers=[{...named,...(named.paymentMethods===undefined&&receiver.paymentMethods?{paymentMethods:receiver.paymentMethods}:{})},...server.receivers.filter(row=>!sameReceiver(row,receiver))];
   await save(state);
   return named;
  }),
  payouts:async()=>(await load()).payouts,
  privateReceiveState:async():Promise<PrivateReceiveState>=>{
   const server=(await load()).servers[serverKey],listed=server?shieldedListed(server):[],own=listed.length?config.shieldedAddress?.():undefined;
   return {
    on:server?.methods===true&&!server.methodsPending&&!server.withdraw,
    pending:server?.methods===true&&server.methodsPending===true,
    refused:server?.methodsRefused===true&&!server.methods,
    withdrawing:server?.withdraw===true,
    listed:!listed.length?null:own&&listed.every(m=>m.destination===own)?'own':'foreign',
   };
  },
  setPrivateReceive:(on:boolean)=>serial(async()=>{
   const state=await load(),server=state.servers[serverKey];
   if(!server){if(on)throw new Error('Enable a Lightning address before turning on private receive');return;}
   if(on){
    advertised();
    if(server.methods&&!server.methodsPending)return;
    server.methods=true;server.methodsPending=true;delete server.methodsRefused;delete server.withdraw;
   }else{
    if(!server.methods&&!server.withdraw&&!shieldedListed(server).length){if(server.methodsRefused){delete server.methodsRefused;await save(state);}return;}
    delete server.methods;delete server.methodsPending;delete server.methodsRefused;server.withdraw=true;
   }
   await save(state);await settle(state,server);
  }),
  claim:(options:{username?:string;domain?:string;claimCode?:string}={})=>serial(async()=>{
   if(options.domain!==undefined&&options.domain.toLowerCase()!==domain)throw new Error('Lightning address domain must match this service');
   const state=await load(),server=state.servers[serverKey]??={receivers:[]};await save(state);
   const owned=(await registeredReceivers()).filter(row=>row.status==='active');
   const automatic=!options.username&&!options.claimCode;
   const existing=automatic?owned.find(row=>server.receivers.some(saved=>saved.handle===row.handle))??owned.find(row=>row.handle===server.pending):undefined;
   if(automatic&&!existing&&owned.length)throw new Error('A Lightning address already exists. Use Recover a Lightning address to enable it here explicitly.');
   const registered=existing??fromAddress(await client.registerAddress({token:await token(),domain,...(options.username?{username:options.username}:{}),...(options.claimCode?{claimCode:options.claimCode}:{})}));
   if(!existing){server.pending=registered.handle;await save(state);}
   server.receivers=[registered,...server.receivers.filter(row=>row.handle!==registered.handle)];delete server.pending;refresh(server,owned);await save(state);
   await settle(state,server);return registered;
  }),
  // Fresh device or restored seed: every /2/7 child up to the last one that ever held a coin is watched again.
  recover:()=>serial(async()=>{
   const state=await load(),server=state.servers[serverKey]??={receivers:[]};await save(state);
   server.receivers=(await registeredReceivers()).filter(row=>row.status==='active');delete server.pending;
   await restoreWatches(state);
   const branch=await currentBranch();await adopt(state,branch,0,await scan(branch,0,RECOVERY_GAP));
   await settle(state,server);return server.receivers;
  }),
  check,
  start(onError:(error:unknown)=>void=()=>{}){
   if(timer||disposed||abort.signal.aborted)return;
   const poll=()=>{if(timerBusy)return;timerBusy=true;void check().catch(error=>{if(!disposed)onError(error);}).finally(()=>{timerBusy=false;});};
   timer=setInterval(poll,CHECK_EVERY_MS);poll();
   void dataWork(config.companion.getContractManager()).then(manager=>{const off=manager.onContractEvent(event=>{if(event.type==='vtxo_received')poll();});if(disposed)off();else offEvents=off;}).catch(error=>{if(!disposed&&!abort.signal.aborted)onError(error);});
  },
  async dispose(){
   disposed=true;if(timer)clearInterval(timer);timer=undefined;offEvents?.();config.signal?.removeEventListener('abort',stop);abort.abort();
   closing??=(async()=>{await tail;if(pendingWrites.size)throw new Error('Wallet data is still finishing; reopen Shielded and retry the reset.');})().catch(error=>{closing=undefined;throw error;});
   await closing;
  },
 };
}
