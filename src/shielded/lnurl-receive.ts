import {DefaultVtxo,deriveDescriptorLeafCompressedPubKey,networkFromArkadeInfo,parseHDDescriptor,timelockToSequence,type Identity,type Wallet} from '@arkade-os/sdk';
import {LnurlError,createLnurlClient,type FetchImpl} from '@arkade-os/lnurl-client';
import {deriveSessionTokenForIdentity} from '@arkade-os/lnurl-client/arkade';
import {HDKey} from '@scure/bip32';
import {hex} from '@scure/base';
import {LNURL_BASE} from './lightning.ts';

interface ReceiveBranch {descriptor:string;serverPubKey:string;hrp:'ark'|'tark';exitDelay:{type:'seconds'|'blocks';value:number}}
export interface LnurlPayout {id:string;descriptor:string;address:string;script:string}
export interface LnurlReceiver {handle:string;domain:string;lightningAddress:string|undefined;lnurl:string;status:string}
export interface LnurlReceiveJournal {
 getReceiveState<T>(owner:string,pool:string,key:string):Promise<T|undefined>;
 saveReceiveState(owner:string,pool:string,key:string,state:unknown):Promise<void>;
}
interface Destination extends LnurlPayout {index:number;claimPublicKey:string;params?:{pubKey:string;serverPubKey:string;csvTimelock:string}}
interface ServerState {receivers:LnurlReceiver[];pending?:string;current?:string;boundAt?:number;refused?:true;migrated?:true}
interface ReceiveState {v:1;next:number;payouts:Destination[];servers:Record<string,ServerState>}
interface LegacyState {v:1;receivers:LnurlReceiver[];pending?:string;payouts:LnurlPayout[]}
export interface LnurlReceiveConfig {
 identity:Identity;companion:Wallet;journal:LnurlReceiveJournal;owner:string;pool:string;baseUrl?:string;domain?:string;fetch?:FetchImpl;now?:()=>number;
 onPayouts?:(payouts:LnurlPayout[])=>Promise<void>;
}
// Each idle rotation leaves one unused index, so daily keeps a year of idle rotations inside RECOVERY_GAP.
export const ROTATE_AFTER_MS=24*60*60_000,CHECK_EVERY_MS=10*60_000,RECOVERY_GAP=400;
export const HD_REFUSED='This Lightning address is still in HD receive mode, and its service cannot switch it to a private static address until the service is updated. Earlier payouts stay watched; the wallet retries automatically.';
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
 const fromAddress=(row:{handle:string;domain:string;lightningAddress:string|null;lnurl:string;status:string}):LnurlReceiver=>{
  if(typeof row.handle!=='string'||!row.handle||typeof row.domain!=='string'||row.domain.toLowerCase()!==domain||typeof row.lnurl!=='string'||typeof row.status!=='string'||(row.lightningAddress!==null&&typeof row.lightningAddress!=='string'))throw new Error('Invalid Lightning address registration');
  return {handle:row.handle,domain,lightningAddress:row.lightningAddress??undefined,lnurl:row.lnurl,status:row.status};
 };
 const registeredReceivers=async()=>(await client.listAddresses(await token())).filter(row=>row.domain.toLowerCase()===domain).map(fromAddress);
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
  try{for(const receiver of server.receivers)if(receiver.status==='active')await client.registerArkadeIdentity({token:await token(),handle:receiver.handle,domain,arkadeAddress:row.address,claimPublicKey:row.claimPublicKey});}
  catch(error){
   if(!(error instanceof LnurlError)||error.code!=='invalid_rails')throw error;
   if(!server.refused){server.refused=true;await save(state);}
   throw new Error(HD_REFUSED,{cause:error});
  }
  if(server.boundAt===undefined||server.refused||server.migrated){server.boundAt??=now();delete server.refused;delete server.migrated;await save(state);}
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
  claim:(options:{username?:string;domain?:string;claimCode?:string}={})=>serial(async()=>{
   if(options.domain!==undefined&&options.domain.toLowerCase()!==domain)throw new Error('Lightning address domain must match this service');
   const state=await load(),server=state.servers[serverKey]??={receivers:[]};await save(state);
   const owned=(await registeredReceivers()).filter(row=>row.status==='active');
   const automatic=!options.username&&!options.claimCode;
   const existing=automatic?owned.find(row=>server.receivers.some(saved=>saved.handle===row.handle))??owned.find(row=>row.handle===server.pending):undefined;
   if(automatic&&!existing&&owned.length)throw new Error('A Lightning address already exists. Use Recover a Lightning address to enable it here explicitly.');
   const registered=existing??fromAddress(await client.registerAddress({token:await token(),domain,...(options.username?{username:options.username}:{}),...(options.claimCode?{claimCode:options.claimCode}:{})}));
   if(!existing){server.pending=registered.handle;await save(state);}
   server.receivers=[registered,...server.receivers.filter(row=>row.handle!==registered.handle)];delete server.pending;await save(state);
   await settle(state,server);return registered;
  }),
  // Fresh device or restored seed: every /2/7 child up to the last one that ever held a coin is watched again.
  recover:()=>serial(async()=>{
   const state=await load(),server=state.servers[serverKey]??={receivers:[]};await save(state);
   server.receivers=(await registeredReceivers()).filter(row=>row.status==='active');delete server.pending;
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
