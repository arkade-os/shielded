import {DefaultVtxo,deriveDescriptorLeafCompressedPubKey,networkFromArkadeInfo,parseHDDescriptor,timelockToSequence,type Identity,type Wallet} from '@arkade-os/sdk';
import {LnurlError,LnurlTransportError,createLnurlClient,type FetchImpl} from '@arkade-os/lnurl-client';
import {deriveSessionTokenForIdentity} from '@arkade-os/lnurl-client/arkade';
import {HDKey} from '@scure/bip32';
import {hex} from '@scure/base';
import {LNURL_BASE} from './lightning.ts';

interface ReceiveBranch {descriptor:string;serverPubKey:string;hrp:'ark'|'tark';exitDelay:{type:'seconds'|'blocks';value:number}}
export interface LnurlPayout {id:string;descriptor:string;address:string;script:string}
export interface PaymentMethod {type:string;destination:string}
export interface LnurlReceiver {handle:string;domain:string;lightningAddress:string|undefined;lnurl:string;status:string;paymentMethods?:PaymentMethod[]}
export interface LnurlReceiveJournal {
 getReceiveState<T>(owner:string,pool:string,key:string):Promise<T|undefined>;
 saveReceiveState(owner:string,pool:string,key:string,state:unknown):Promise<void>;
}
interface Destination extends LnurlPayout {index:number;claimPublicKey:string;params?:{pubKey:string;serverPubKey:string;csvTimelock:string}}
// withdraw: a methods:[] bind is owed to the service and stays owed until a listing shows the method gone.
interface ServerState {receivers:LnurlReceiver[];pending?:string;current?:string;boundAt?:number;refused?:true;migrated?:true;methods?:true;methodsRefused?:true;withdraw?:true}
interface ReceiveState {v:1;next:number;payouts:Destination[];servers:Record<string,ServerState>}
interface LegacyState {v:1;receivers:LnurlReceiver[];pending?:string;payouts:LnurlPayout[]}
export interface LnurlReceiveConfig {
 identity:Identity;companion:Wallet;journal:LnurlReceiveJournal;owner:string;pool:string;baseUrl?:string;domain?:string;fetch?:FetchImpl;now?:()=>number;
 onPayouts?:(payouts:LnurlPayout[])=>Promise<void>;
 shieldedAddress?:()=>string;
}
// Each idle rotation leaves one unused index, so daily keeps a year of idle rotations inside RECOVERY_GAP.
export const ROTATE_AFTER_MS=24*60*60_000,CHECK_EVERY_MS=10*60_000,RECOVERY_GAP=400;
export const HD_REFUSED='This Lightning address is still in HD receive mode, and its service cannot switch it to a private static address until the service is updated. Earlier payouts stay watched; the wallet retries automatically.';
export const METHODS_REFUSED='The service for this Lightning address did not keep the private receive address, so payers are not offered it. Private receive is not live until the service is updated; the wallet retries automatically.';
export const METHODS_NOT_WITHDRAWN='The service for this Lightning address still lists the private receive address after it was withdrawn, so payers may still be offered it. The wallet keeps asking the service to remove it and retries automatically.';
const SCAN_BATCH=50,STATE_POOL='lnurl-receive',STATE_KEY='state-v1';
const TESTNET_BIP32={public:0x043587cf,private:0x04358394};
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
 const abort=new AbortController(),fetcher=config.fetch??((input,init)=>globalThis.fetch(input,init));
 const guardedFetch:FetchImpl=(input,init)=>fetcher(input,{...init,redirect:'error',credentials:'omit',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30_000),...(init?.signal?[init.signal]:[])])});
 const client=createLnurlClient({baseUrl,fetchImpl:guardedFetch});
 let tokenOnce:Promise<string>|undefined,tail:Promise<unknown>=Promise.resolve(),timer:ReturnType<typeof setInterval>|undefined,timerBusy=false,disposed=false,watched=false,offEvents:(()=>void)|undefined;
 const token=()=>tokenOnce??=deriveSessionTokenForIdentity(config.identity,domain);
 const serial=<T,>(fn:()=>Promise<T>):Promise<T>=>{const pending=tail.then(()=>{if(disposed)throw new Error('Lightning address service is disposed');return fn();});tail=pending.catch(()=>{});return pending;};
 const migrate=async(state:ReceiveState)=>{
  const legacy=await config.journal.getReceiveState<LegacyState>(config.owner,config.pool,`lnurl-hd-v1:${serverKey}`);
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
  const state=await config.journal.getReceiveState<ReceiveState>(config.owner,STATE_POOL,STATE_KEY)??{v:1,next:0,payouts:[],servers:{}};
  if(state.v!==1||!Number.isSafeInteger(state.next)||state.next<0||!Array.isArray(state.payouts)||!state.servers||typeof state.servers!=='object')throw new Error('Invalid local Lightning receive state');
  if(!state.servers[serverKey])await migrate(state);
  return state;
 };
 const save=(state:ReceiveState)=>config.journal.saveReceiveState(config.owner,STATE_POOL,STATE_KEY,state);
 const account=()=>{const descriptor=(config.companion.identity as Identity&{descriptor?:string}).descriptor;if(!descriptor)throw new Error('Private Lightning receive requires an HD companion');return descriptor;};
 const currentBranch=async()=>{
  const info=await config.companion.getArkadeInfo({requireLive:true}),hrp=config.companion.network.hrp;
  if((hrp!=='ark'&&hrp!=='tark')||networkFromArkadeInfo(info).hrp!==hrp)throw new Error('HD receive operator network mismatch');
  if(!/^(0[23])?[0-9a-f]{64}$/i.test(info.signerPubkey)||info.unilateralExitDelay>0xffffffffn||info.unilateralExitDelay<0n)throw new Error('Invalid HD receive operator script settings');
  const delay=info.unilateralExitDelay;
  return receiveBranch(account(),{serverPubKey:info.signerPubkey.slice(-64),hrp,exitDelay:{type:delay<512n?'blocks':'seconds',value:Number(delay)}});
 };
 const fromAddress=(row:{handle:string;domain:string;lightningAddress:string|null;lnurl:string;status:string;paymentMethods?:unknown}):LnurlReceiver=>{
  if(typeof row.handle!=='string'||!row.handle||typeof row.domain!=='string'||row.domain.toLowerCase()!==domain||typeof row.lnurl!=='string'||typeof row.status!=='string'||(row.lightningAddress!==null&&typeof row.lightningAddress!=='string'))throw new Error('Invalid Lightning address registration');
  const paymentMethods=Array.isArray(row.paymentMethods)?row.paymentMethods.filter(method=>typeof method?.type==='string').map(({type,destination}):PaymentMethod=>({type,destination:typeof destination==='string'?destination:''})):undefined;
  return {handle:row.handle,domain,lightningAddress:row.lightningAddress??undefined,lnurl:row.lnurl,status:row.status,...(paymentMethods?{paymentMethods}:{})};
 };
 const registeredReceivers=async()=>(await client.listAddresses(await token())).filter(row=>row.domain.toLowerCase()===domain).map(fromAddress);
 // The pinned client's registerArkadeIdentity whitelists its body, so a bind that carries methods is posted directly.
 const postBind=async(handle:string,body:object)=>{
  const response=await guardedFetch(`${baseUrl}/lnurl/address/${encodeURIComponent(handle)}/arkade`,{method:'POST',headers:{'content-type':'application/json',Authorization:`Bearer ${await token()}`},body:JSON.stringify(body)}).catch(cause=>{throw new LnurlTransportError('Request failed',{cause});});
  const reply=await response.json().catch(cause=>{if(response.ok)throw new LnurlTransportError('Request failed',{cause});}) as {error?:unknown;code?:unknown}|undefined;
  if(!response.ok)throw new LnurlError(typeof reply?.error==='string'?reply.error:response.statusText,{httpStatus:response.status,code:typeof reply?.code==='string'?reply.code:undefined});
 };
 const advertised=()=>{if(!config.shieldedAddress)throw new Error('Private receive requires a shielded address');return config.shieldedAddress();};
 const refuseMethods=async(state:ReceiveState,server:ServerState)=>{if(!server.methodsRefused){server.methodsRefused=true;await save(state);}};
 const advertises=(server:ServerState)=>server.receivers.some(row=>row.status==='active'&&row.paymentMethods?.some(m=>m.type==='shielded'));
 const refresh=(server:ServerState,listed:LnurlReceiver[])=>{for(const row of server.receivers){const methods=listed.find(l=>l.handle===row.handle)?.paymentMethods;if(methods)row.paymentMethods=methods;else delete row.paymentMethods;}};
 // The service is the source of truth for what is advertised, so a restored device adopts it unless the user just switched it off here.
 const takeAdvertised=(server:ServerState)=>{if(config.shieldedAddress&&!server.methods&&!server.withdraw&&advertises(server)){server.methods=true;server.methodsRefused=true;}};
 const confirm=async(state:ReceiveState,server:ServerState)=>{
  const before=JSON.stringify(server.receivers);
  refresh(server,await registeredReceivers());
  if(JSON.stringify(server.receivers)!==before)await save(state);
  if(server.withdraw){
   if(advertises(server))throw new Error(METHODS_NOT_WITHDRAWN);
   delete server.withdraw;await save(state);return;
  }
  const destination=advertised();
  if(server.receivers.filter(row=>row.status==='active').every(row=>row.paymentMethods?.some(m=>m.type==='shielded'&&m.destination===destination))){
   if(server.methodsRefused){delete server.methodsRefused;await save(state);}
   return;
  }
  await refuseMethods(state,server);throw new Error(METHODS_REFUSED);
 };
 const watch=async(rows:Destination[])=>{
  if(!rows.length)return;
  const manager=await config.companion.getContractManager();
  for(const row of rows)if(row.params)await manager.createContract({type:'default',watch:'awaiting-funds',script:row.script,address:row.address,params:row.params,metadata:{signingDescriptor:row.descriptor}});
  await config.onPayouts?.(rows.map(({id,descriptor,address,script})=>({id,descriptor,address,script})));
 };
 const used=async(scripts:string[])=>new Set((await config.companion.indexerProvider.getVtxos({scripts})).vtxos.map(coin=>coin.script));
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
 const adopt=async(state:ReceiveState,branch:ReturnType<typeof receiveBranch>,from:number,high:number)=>{
  const added:Destination[]=[];
  for(let index=from;index<=high;index++){const row=receiveDestination(branch,index);if(!state.payouts.some(p=>p.script===row.script)){state.payouts.push(row);added.push(row);}}
  state.next=Math.max(state.next,high+1);await save(state);await watch(added);
 };
 const advance=async(state:ReceiveState,server:ServerState)=>{
  const row=receiveDestination(await currentBranch(),state.next);
  state.next++;state.payouts.push(row);server.current=row.script;delete server.boundAt;
  await save(state);await watch([row]);
 };
 const bind=async(state:ReceiveState,server:ServerState)=>{
  const row=state.payouts.find(p=>p.script===server.current);
  if(!row)throw new Error('The bound Lightning receive address is missing from local state');
  const body={arkadeAddress:row.address,claimPublicKey:row.claimPublicKey,domain};
  let advertise=server.methods&&!server.withdraw?[{type:'shielded',destination:advertised()}]:undefined,refusal:LnurlError|undefined;
  try{
   for(const receiver of server.receivers)if(receiver.status==='active'){
    const methods=server.withdraw?[]:advertise;
    try{await postBind(receiver.handle,methods?{...body,methods}:body);}
    catch(error){
     // A refused method rejects the whole bind, so the identity is resent alone to keep the address live.
     if(!advertise||!(error instanceof LnurlError)||error.httpStatus!==400||error.code==='invalid_rails')throw error;
     refusal=error;advertise=undefined;await postBind(receiver.handle,body);
    }
   }
  }
  catch(error){
   if(!(error instanceof LnurlError)||error.code!=='invalid_rails')throw error;
   if(!server.refused){server.refused=true;await save(state);}
   throw new Error(HD_REFUSED,{cause:error});
  }
  if(server.boundAt===undefined||server.refused||server.migrated){server.boundAt??=now();delete server.refused;delete server.migrated;await save(state);}
  if(refusal){await refuseMethods(state,server);throw new Error(METHODS_REFUSED,{cause:refusal});}
 };
 const settle=async(state:ReceiveState,server:ServerState)=>{
  if(!server.receivers.some(row=>row.status==='active'))return;
  // HD services hand out /2/7 children the journal never saw: catch up until the first static bind lands, then follow them while refused.
  if(server.refused||server.migrated){
   const branch=await currentBranch(),high=await scan(branch,state.next,server.migrated?RECOVERY_GAP:SCAN_BATCH);
   if(high>=state.next)await adopt(state,branch,state.next,high);
  }
  const current=state.payouts.find(row=>row.script===server.current);
  if(!current||(server.boundAt!==undefined&&now()-server.boundAt>=ROTATE_AFTER_MS)||(await used([current.script])).size>0)await advance(state,server);
  await bind(state,server);
  if(server.methods||server.withdraw)await confirm(state,server);
 };
 const check=()=>serial(async()=>{
  const state=await load(),server=state.servers[serverKey];if(!server)return;
  if(!watched){await watch(state.payouts);watched=true;}
  await settle(state,server);
 });
 return {
  enabled:async()=>Boolean((await load()).servers[serverKey]),
  current:async()=>(await load()).servers[serverKey]?.receivers.find(row=>row.status==='active'),
  payouts:async()=>(await load()).payouts,
  privateReceive:async()=>{const server=(await load()).servers[serverKey];return server?.methods===true&&!server.methodsRefused&&!server.withdraw;},
  // methodsRefused is raised with the switch and cleared only once a listing echoes the method, so a bind alone never reads as live.
  setPrivateReceive:(on:boolean)=>serial(async()=>{
   const state=await load(),server=state.servers[serverKey];
   if(!server){if(on)throw new Error('Enable a Lightning address before turning on private receive');return;}
   if(on){
    advertised();
    if(server.methods&&!server.methodsRefused)return;
    server.methods=true;server.methodsRefused=true;delete server.withdraw;
   }else{
    if(!server.methods&&!server.withdraw&&!advertises(server))return;
    delete server.methods;delete server.methodsRefused;server.withdraw=true;
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
   server.receivers=[registered,...server.receivers.filter(row=>row.handle!==registered.handle)];delete server.pending;refresh(server,owned);takeAdvertised(server);await save(state);
   await settle(state,server);return registered;
  }),
  // Fresh device or restored seed: every /2/7 child up to the last one that ever held a coin is watched again.
  recover:()=>serial(async()=>{
   const state=await load(),server=state.servers[serverKey]??={receivers:[]};await save(state);
   server.receivers=(await registeredReceivers()).filter(row=>row.status==='active');delete server.pending;takeAdvertised(server);
   if(!watched){await watch(state.payouts);watched=true;}
   const branch=await currentBranch();await adopt(state,branch,0,await scan(branch,0,RECOVERY_GAP));
   await settle(state,server);return server.receivers;
  }),
  check,
  start(onError:(error:unknown)=>void=()=>{}){
   if(timer||disposed)return;
   const poll=()=>{if(timerBusy)return;timerBusy=true;void check().catch(error=>{if(!disposed)onError(error);}).finally(()=>{timerBusy=false;});};
   timer=setInterval(poll,CHECK_EVERY_MS);poll();
   void config.companion.getContractManager().then(manager=>{const off=manager.onContractEvent(event=>{if(event.type==='vtxo_received')poll();});if(disposed)off();else offEvents=off;}).catch(error=>{if(!disposed)onError(error);});
  },
  async dispose(){disposed=true;if(timer)clearInterval(timer);timer=undefined;offEvents?.();abort.abort();await tail;},
 };
}
