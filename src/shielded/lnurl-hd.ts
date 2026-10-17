import {DefaultVtxo,deriveDescriptorLeafCompressedPubKey,networkFromArkadeInfo,parseHDDescriptor,sequenceToTimelock,timelockToSequence,type CreateContractParams,type Identity,type Wallet} from '@arkade-os/sdk';
import {createLnurlClient,type FetchImpl} from '@arkade-os/lnurl-client';
import {deriveSessionTokenForIdentity} from '@arkade-os/lnurl-client/arkade';
import {HDKey} from '@scure/bip32';
import {hex} from '@scure/base';
import {LNURL_BASE} from './lightning.ts';

export interface HdReceiveConfig {version:1;descriptor:string;serverPubKey:string;hrp:'ark'|'tark';exitDelay:{type:'seconds'|'blocks';value:number}}
export interface HdReceiveAllocation {id:number;index:number;descriptor:string;arkadeAddress:string;claimPublicKey:string;hd:HdReceiveConfig;createdAt:number}
export interface HdLnurlPayout {id:string;descriptor:string;address:string;script:string}
export interface HdLnurlReceiver {handle:string;domain:string;lightningAddress:string|undefined;lnurl:string;status:string}
export interface HdReceiveJournal {
 getReceiveState<T>(owner:string,pool:string,key:string):Promise<T|undefined>;
 saveReceiveState(owner:string,pool:string,key:string,state:unknown):Promise<void>;
}
interface ReceiveState {v:1;enabled:true;receivers:HdLnurlReceiver[];cursors:Record<string,number>;payouts:HdLnurlPayout[]}
export interface HdLnurlConfig {
 identity:Identity;companion:Wallet;journal:HdReceiveJournal;owner:string;pool:string;baseUrl?:string;domain?:string;fetch?:FetchImpl;
 onAllocation?:(payout:HdLnurlPayout)=>Promise<void>;
}
const TESTNET_BIP32={public:0x043587cf,private:0x04358394};
const HD_UNAVAILABLE='The Lightning address service needs an update to support private HD receiving.';
const indexOf=(index:number)=>{if(!Number.isSafeInteger(index)||index<0||index>=0x80000000)throw new Error('Invalid HD receive allocation index');return index;};
const empty=():ReceiveState=>({v:1,enabled:true,receivers:[],cursors:{},payouts:[]});

function receiveBranch(accountDescriptor:string,params:Omit<HdReceiveConfig,'version'|'descriptor'>){
 const parsed=parseHDDescriptor(accountDescriptor);
 if(!parsed||!accountDescriptor.endsWith('/*)')||!/^(xpub|tpub)/.test(parsed.xpub))throw new Error('Private Lightning receive requires a public HD account template');
 const testnet=parsed.xpub.startsWith('tpub');
 if((params.hrp==='tark')!==testnet)throw new Error('HD receive descriptor network mismatch');
 const node=HDKey.fromExtendedKey(parsed.xpub,testnet?TESTNET_BIP32:undefined);
 if(node.depth!==parsed.basePath.split('/').length)throw new Error('Invalid HD receive account origin');
 const branch=node.derive('m/2/7');
 if(branch.depth<4||Number(parsed.derivationPath.split('/')[0])===2)throw new Error('HD receive requires a dedicated branch below the account');
 const base=parsed.basePath.split('/').map(part=>`${Number(part.replace(/['hH]$/,''))}${/['hH]$/.test(part)?"'":''}`).join('/'),fingerprint=parsed.fingerprint.toLowerCase();
 const hd:HdReceiveConfig={version:1,descriptor:`tr([${fingerprint}/${base}/2/7]${branch.publicExtendedKey}/*)`,serverPubKey:params.serverPubKey.toLowerCase(),hrp:params.hrp,exitDelay:{...params.exitDelay}};
 const signingDescriptor=(index:number)=>`tr([${fingerprint}/${base}]${parsed.xpub}/2/7/${indexOf(index)})`;
 const units=hd.exitDelay.type==='seconds'?hd.exitDelay.value/512:hd.exitDelay.value;
 if(!/^[0-9a-f]{64}$/.test(hd.serverPubKey)||!['ark','tark'].includes(hd.hrp)||!['seconds','blocks'].includes(hd.exitDelay.type)||!Number.isSafeInteger(units)||units<=0||units>65535)throw new Error('Invalid HD receive script configuration');
 return {hd,signingDescriptor};
}

function receiveScript(hd:HdReceiveConfig,index:number){
 const descriptor=hd.descriptor.replace('*',String(indexOf(index))),publicKey=deriveDescriptorLeafCompressedPubKey(descriptor);
 const script=new DefaultVtxo.Script({pubKey:publicKey.slice(1),serverPubKey:hex.decode(hd.serverPubKey),csvTimelock:{type:hd.exitDelay.type,value:BigInt(hd.exitDelay.value)}});
 return {descriptor,publicKey,script,address:script.address(hd.hrp,hex.decode(hd.serverPubKey)).encode()};
}

export function createHdLnurl(config:HdLnurlConfig){
 const url=new URL(config.baseUrl??LNURL_BASE);
 if(!['https:','http:'].includes(url.protocol)||url.username||url.password||url.search||url.hash)throw new Error('Invalid Lightning address service URL');
 const baseUrl=url.href.replace(/\/+$/,''),domain=(config.domain??url.hostname).toLowerCase(),key=`lnurl-hd-v1:${JSON.stringify([baseUrl,domain])}`;
 const abort=new AbortController(),fetcher=config.fetch??((input,init)=>globalThis.fetch(input,init));
 const guardedFetch:FetchImpl=(input,init)=>fetcher(input,{...init,redirect:'error',credentials:'omit',signal:AbortSignal.any([abort.signal,AbortSignal.timeout(30_000),...(init?.signal?[init.signal]:[])])});
 const client=createLnurlClient({baseUrl,fetchImpl:guardedFetch});
 let tokenOnce:Promise<string>|undefined,tail:Promise<unknown>=Promise.resolve(),timer:ReturnType<typeof setInterval>|undefined,timerBusy=false,disposed=false;
 const token=()=>tokenOnce??=deriveSessionTokenForIdentity(config.identity,domain);
 const serial=<T,>(fn:()=>Promise<T>):Promise<T>=>{const pending=tail.then(()=>{if(disposed)throw new Error('Lightning address service is disposed');return fn();});tail=pending.catch(()=>{});return pending;};
 const load=async()=>{
  const state=await config.journal.getReceiveState<ReceiveState>(config.owner,config.pool,key);
  if(state&&(state.v!==1||state.enabled!==true||!Array.isArray(state.receivers)||!Array.isArray(state.payouts)||!state.cursors||typeof state.cursors!=='object'))throw new Error('Invalid local HD receive state');
  return state;
 };
 const save=(state:ReceiveState)=>config.journal.saveReceiveState(config.owner,config.pool,key,state);
 const account=()=>{const descriptor=(config.companion.identity as Identity&{descriptor?:string}).descriptor;if(!descriptor)throw new Error('Private Lightning receive requires an HD companion');return descriptor;};
 const currentBranch=async()=>{
  const info=await config.companion.getArkadeInfo({requireLive:true}),hrp=config.companion.network.hrp;
  if((hrp!=='ark'&&hrp!=='tark')||networkFromArkadeInfo(info).hrp!==hrp)throw new Error('HD receive operator network mismatch');
  if(!/^(0[23])?[0-9a-f]{64}$/i.test(info.signerPubkey)||info.unilateralExitDelay>0xffffffffn||info.unilateralExitDelay<0n)throw new Error('Invalid HD receive operator script settings');
  const delay=sequenceToTimelock(Number(info.unilateralExitDelay));
  if(BigInt(timelockToSequence(delay))!==info.unilateralExitDelay)throw new Error('Invalid HD receive operator exit delay');
  const branch=receiveBranch(account(),{serverPubKey:info.signerPubkey.slice(-64),hrp,exitDelay:{type:delay.type,value:Number(delay.value)}});
  receiveScript(branch.hd,0);return branch;
 };
 const request=async<T,>(path:string,init?:RequestInit):Promise<T>=>{
  const response=await guardedFetch(`${baseUrl}${path}`,{...init,headers:{Authorization:`Bearer ${await token()}`,...init?.headers}});
  const body=await response.json().catch(()=>{throw new Error(response.status===404?HD_UNAVAILABLE:`Lightning address service returned an invalid response (HTTP ${response.status}).`);});
  if(body?.error==='arkadeAddress and a compressed-hex claimPublicKey (02/03 + 64 hex) are required')throw new Error(HD_UNAVAILABLE);
  if(!response.ok||body?.status==='ERROR'||typeof body?.error==='string')throw new Error(typeof body?.error==='string'?body.error:typeof body?.reason==='string'?body.reason:`Lightning address request failed (${response.status})`);
  return body as T;
 };
 const fromAddress=(row:{handle:string;domain:string;lightningAddress:string|null;lnurl:string;status:string}):HdLnurlReceiver=>{
  if(typeof row.handle!=='string'||!row.handle||typeof row.domain!=='string'||row.domain.toLowerCase()!==domain||typeof row.lnurl!=='string'||typeof row.status!=='string'||(row.lightningAddress!==null&&typeof row.lightningAddress!=='string'))throw new Error('Invalid Lightning address registration');
  return {handle:row.handle,domain,lightningAddress:row.lightningAddress??undefined,lnurl:row.lnurl,status:row.status};
 };
 const registeredReceivers=async()=>(await client.listAddresses(await token())).filter(row=>row.domain.toLowerCase()===domain).map(fromAddress);
 const bind=async(receiver:HdLnurlReceiver,hd:HdReceiveConfig)=>{
  const answer=await request<{receiveMode?:string}>(`/lnurl/address/${encodeURIComponent(receiver.handle)}/arkade`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({domain,hd})});
  if(answer?.receiveMode!=='hd')throw new Error('Lightning address server did not confirm private HD receive mode');
 };
 const restore=async(receiver:HdLnurlReceiver)=>{
  const cursorKey=JSON.stringify([domain,receiver.handle]);
  for(;;){
   const state=(await load())!,after=state.cursors[cursorKey]??0;
   if(!Number.isSafeInteger(after)||after<0)throw new Error('Invalid local HD receive allocation cursor');
   const query=new URLSearchParams({domain,after:String(after),limit:'100'});
   const page=await request<{allocations:HdReceiveAllocation[];nextAfter:number}>(`/lnurl/address/${encodeURIComponent(receiver.handle)}/arkade/allocations?${query}`);
   if(!page||!Array.isArray(page.allocations)||page.allocations.length>100||!Number.isSafeInteger(page.nextAfter))throw new Error('Invalid HD receive allocation page');
   let previous=after;
   const prepared=page.allocations.map(allocation=>{
    if(!allocation||!Number.isSafeInteger(allocation.id)||allocation.id<=previous||!Number.isSafeInteger(allocation.createdAt)||!allocation.hd||allocation.hd.version!==1)throw new Error('Invalid HD receive allocation page');
    previous=allocation.id;
    const hd=allocation.hd,branch=receiveBranch(account(),hd);
    if(hd.descriptor!==branch.hd.descriptor||hd.hrp!==config.companion.network.hrp||hd.serverPubKey!==branch.hd.serverPubKey)throw new Error('HD allocation belongs to another receive branch');
    const derived=receiveScript(branch.hd,allocation.index),descriptor=branch.signingDescriptor(allocation.index);
    if(allocation.descriptor!==derived.descriptor||allocation.arkadeAddress!==derived.address||allocation.claimPublicKey!==hex.encode(derived.publicKey)||hex.encode(deriveDescriptorLeafCompressedPubKey(descriptor))!==allocation.claimPublicKey)throw new Error('HD allocation does not match its derived receive script');
    const payout:HdLnurlPayout={id:`lnurl:${JSON.stringify([domain,receiver.handle,allocation.id])}`,descriptor,address:derived.address,script:hex.encode(derived.script.pkScript)};
    const existing=state.payouts.find(row=>row.id===payout.id);
    if(existing&&JSON.stringify(existing)!==JSON.stringify(payout))throw new Error('HD allocation changed after recovery');
    const contract:CreateContractParams={type:'default',watch:'awaiting-funds',script:payout.script,address:payout.address,params:{pubKey:hex.encode(derived.publicKey.slice(1)),serverPubKey:hd.serverPubKey,csvTimelock:timelockToSequence(derived.script.options.csvTimelock).toString()},metadata:{signingDescriptor:descriptor}};
    return {payout,contract};
   });
   if(page.nextAfter!==previous)throw new Error('Invalid HD receive allocation cursor');
   if(!prepared.length)return;
   const manager=await config.companion.getContractManager();
   for(const {contract,payout}of prepared){await manager.createContract(contract);await config.onAllocation?.(payout);}
   const payouts=new Map(state.payouts.map(payout=>[payout.id,payout]));
   for(const {payout}of prepared)payouts.set(payout.id,payout);
   await save({...state,payouts:[...payouts.values()],cursors:{...state.cursors,[cursorKey]:page.nextAfter}});
  }
 };
 const recover=({explicit=false}:{explicit?:boolean}={})=>serial(async()=>{
  let state=await load();if(!state&&!explicit)return [];
  if(!state){state=empty();await save(state);}
  if(!explicit&&!state.receivers.length&&!state.payouts.length)return [];
  const addresses=await registeredReceivers();
  if(explicit){
   const branch=await currentBranch(),active=addresses.filter(row=>row.status==='active');
   for(const receiver of active)await bind(receiver,branch.hd);
   await save({...state,receivers:active});
  }
  for(const receiver of addresses)await restore(receiver);
  return (await load())!.receivers;
 });
 return {
  enabled:async()=>Boolean(await load()),
  current:async()=>(await load())?.receivers.find(row=>row.status==='active'),
  allocations:async()=>(await load())?.payouts??[],
  claim:(options:{username?:string;domain?:string;claimCode?:string}={})=>serial(async()=>{
   if(options.domain!==undefined&&options.domain.toLowerCase()!==domain)throw new Error('Lightning address domain must match this service');
   let state=await load();if(!state){state=empty();await save(state);}
   const branch=await currentBranch(),owned=(await registeredReceivers()).filter(row=>row.status==='active');
   const existing=!options.username&&!options.claimCode?(owned.find(row=>state.receivers.some(saved=>saved.handle===row.handle))??owned[0]):undefined;
   const registered=existing??fromAddress(await client.registerAddress({token:await token(),domain,...(options.username?{username:options.username}:{}),...(options.claimCode?{claimCode:options.claimCode}:{})}));
   await bind(registered,branch.hd);
   await save({...state,receivers:[registered,...state.receivers.filter(row=>row.handle!==registered.handle)]});
   await restore(registered);return registered;
  }),
  recover,
  start(onError:(error:unknown)=>void=()=>{}){
   if(timer||disposed)return;
   const poll=()=>{if(timerBusy)return;timerBusy=true;void recover().catch(error=>{if(!disposed)onError(error);}).finally(()=>{timerBusy=false;});};
   timer=setInterval(poll,20_000);poll();
  },
  async dispose(){disposed=true;if(timer)clearInterval(timer);timer=undefined;abort.abort();await tail;},
 };
}
