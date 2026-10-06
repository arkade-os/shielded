import React,{useEffect,useRef,useState} from 'react';
// @ts-ignore circomlibjs has no browser declarations.
import {buildPoseidon} from 'circomlibjs';
import {SingleKey,CSVMultisigTapscript,VtxoScript} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {bytesToHex} from '@noble/hashes/utils.js';
import {createStockBrowserClient} from '../../packages/protocol/src/browser-stock.ts';
import {createPinnedArtifactLoader} from '../../packages/protocol/src/pinned-artifact.ts';
import {deriveWalletKeyMaterial,parseMasterSecret} from '../../packages/protocol/src/wallet-keys.ts';
import {participantId,participantPublicKey,signParticipantRegistration,verifyParticipantRegistration,type RegistrationPayload} from '../../packages/protocol/src/registration.ts';
import {stockProofDescriptor,type StockSettlementProof} from '../../packages/protocol/src/stock-native.ts';
import type {ClientProtocolKernel,Owner,StockPreparedSettlement} from '../../packages/protocol/src/types.ts';
import {buildStockSpend,loadStockProfile,signCustomerFunding,stockVmRequest,type StockDraft} from '../../src/stock/sdk.ts';
import {openCustomerArkWallet,type CustomerVtxo} from '../../src/stock/ark-wallet.ts';
import {verifyStockArchive,stockReleaseFingerprint,type StockArchiveProfile,type VerifiedStockHead} from '../../src/stock/archive-client.ts';
import type {StockPublicArchive} from '../../src/stock/coordinator.ts';
import {decryptWallet,encryptWallet,type EncryptedWallet} from './wallet-backup.ts';
import {storeWalletBackup} from './wallet-storage.ts';
import {useStockSetup,stockSetupPresentation,stockWalletStatus} from './stock-setup.ts';
import {autoShieldCoins,noteSummary,parseRecipient,sealedAfter} from './stock-flow.ts';
import {CopyButton,Icon} from './components.tsx';
import {Seal} from './guilloche.tsx';

type Profile=StockArchiveProfile&{profile:string;participants:Record<string,RegistrationPayload>;ready:boolean;phase:17|18;head:{txid:string;vout:number;value:number;sourceTxHex:string};blockedReason:string;pending?:{id:string;stage:string};capacity:{remainingNoteRecords:number};proofSystem:string;setup:string;limitations:string[]};
type Archive=StockPublicArchive;
type Funding=CustomerVtxo['funding'];
type Pending={prepared:StockPreparedSettlement;proof:StockSettlementProof;draft:StockDraft;externalFunding?:Funding;externalProgram?:string};
interface WalletBackup {version:1;owner:Owner;network:'mutinynet';registrationProfile:string;trustedReleaseFingerprint:string;descriptorProfileId:string;masterSecret:string;lastVerifiedHead?:VerifiedStockHead;pending?:Pending}
type Note={index:number;amount:number;commitment:string;spent:boolean;spendable:boolean};
type Activity={title:string;steps:string[];current:number;visited:number[];startedAt:number;endedAt?:number;done?:boolean;error?:string;retry?:()=>void};
type Step=(label:string)=>void;
const STORAGE='shielded-stock-wallet-v1',PASSPHRASE='shielded-stock-wallet-passphrase-v1',BACKED_UP='shielded-stock-wallet-backed-up-v1',PROOF_KEYS=['stock-combined.wasm','stock-combined.zkey'],AUTO_MS=12000,BUSY_RETRIES=40;
const OPEN_STEPS=['Unlock','Register with pool','Verify pool archive','Open Arkade balance'],CREATE_STEPS=['Create keys','Register with pool','Verify pool archive','Open Arkade balance'];
const SHIELD_STEPS=['Check pool','Publish pool keys','Build transaction','Generate proof','Sign','Submit','Verify result','Seal new notes'],SPEND_STEPS=['Check pool','Seal pending notes','Publish pool keys','Build transaction','Generate proof','Submit','Verify result','Seal new notes'],RECONCILE_STEPS=['Ask pool to reconcile','Verify result'],SEAL_STEPS=['Seal notes','Verify result'];
const number=(value:string,label:string)=>{const n=Number(value);if(!Number.isSafeInteger(n)||n<1)throw new Error(`${label} must be a positive whole number of satoshis.`);return n;};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms)),same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b),randomHex=()=>bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
const short=(value:string)=>value?`${value.slice(0,10)}…${value.slice(-8)}`:'—',sats=(value:number)=>value.toLocaleString('en-US'),mb=(bytes:number)=>(bytes/1048576).toFixed(0);
const validEncrypted=(value:any):value is EncryptedWallet=>value?.version===1&&/^[0-9a-f]{32}$/.test(value.salt)&&/^[0-9a-f]{24}$/.test(value.iv)&&/^(?:[0-9a-f]{2})+$/.test(value.ciphertext)&&value.ciphertext.length<=4000000;
// Only bytes that already matched their pinned sha256 are cached, keyed by that hash, so a hit skips both download and re-hash.
const PROOF_CACHE='shielded-proof-keys-v2';
const cachedProofKey=async(key:string)=>{try{const hit=await (await caches.open(PROOF_CACHE)).match(key);return hit?new Uint8Array(await hit.arrayBuffer()):undefined;}catch{return undefined;}};
const storeProofKey=(key:string,bytes:Uint8Array)=>void caches.open(PROOF_CACHE).then(cache=>cache.put(key,new Response(bytes as Uint8Array<ArrayBuffer>))).catch(()=>undefined);
const Copyable=({value}:{value:string})=><div className="stock-copy"><code>{value}</code><CopyButton value={value}/></div>;
const saveFile=(name:string,value:unknown)=>{const url=URL.createObjectURL(new Blob([JSON.stringify(value)],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download=name;link.click();URL.revokeObjectURL(url);};

export default function StockWallet(){
 const {setup,supported:setupSupported,error:setupError}=useStockSetup(),setupPresentation=stockSetupPresentation(setup,setupError);
 const [profile,setProfile]=useState<Profile>(),[profileError,setProfileError]=useState<string>(),[profileAttempt,setProfileAttempt]=useState(0);
 const [wallet,setWallet]=useState<WalletBackup>(),[notes,setNotes]=useState<Note[]>([]),[ark,setArk]=useState<{address:string;coins:CustomerVtxo[]}>();
 const [saved,setSaved]=useState(()=>!!localStorage.getItem(STORAGE)),[backedUp,setBackedUp]=useState(()=>localStorage.getItem(BACKED_UP)==='1'),[reveal,setReveal]=useState(false);
 const [passphraseInput,setPassphraseInput]=useState(''),[pin,setPin]=useState(''),[recovery,setRecovery]=useState('');
 const [tab,setTab]=useState<'receive'|'send'>('receive'),[sendTo,setSendTo]=useState(''),[sendAmount,setSendAmount]=useState('');
 const [activity,setActivity]=useState<Activity>(),[busy,setBusy]=useState(false),[syncing,setSyncing]=useState(false),[now,setNow]=useState(()=>Date.now()),[proofKeys,setProofKeys]=useState<{loaded:number;total:number;ready:boolean}>(),[message,setMessage]=useState('');
 const kernel=useRef<ClientProtocolKernel|undefined>(undefined),nativeSecret=useRef<string|undefined>(undefined),verifiedArchive=useRef<Archive|undefined>(undefined),walletRef=useRef<WalletBackup|undefined>(undefined),backupFile=useRef<EncryptedWallet|undefined>(undefined);
 const passphrase=useRef(localStorage.getItem(PASSPHRASE)??''),busyRef=useRef(false),pausedUntil=useRef(0),lastHead=useRef(''),autoOpened=useRef(false),prefetching=useRef(false),artifact=useRef<((name:string)=>Promise<Uint8Array>)|undefined>(undefined),downloads=useRef<Record<string,[number,number]>>({});

 const api=async<T=any>(path:string,body?:unknown,retries=0):Promise<T>=>{
  for(let attempt=0;;attempt++){
   const response=await fetch('/api'+path,{method:body===undefined?'GET':'POST',cache:'no-store',headers:body===undefined?{}:{'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});
   const data=await response.json().catch(()=>({}));
   if(response.ok)return data as T;
   if(response.status===409&&attempt<retries){await sleep(3000);continue;}
   throw Object.assign(new Error(data.error??`Request failed (HTTP ${response.status})`),{status:response.status});
  }
 };
 const save=async(value=walletRef.current,createOnly=false)=>{if(!value)return;const encrypted=await encryptWallet(value,passphrase.current);await storeWalletBackup(encrypted,createOnly);backupFile.current=encrypted;};
 const loader=(current:Profile)=>artifact.current??=(()=>{
  const pins=current.provingManifest.artifacts,loads=new Map<string,Promise<Uint8Array>>();
  const network=createPinnedArtifactLoader(fetch,pins,name=>'/api/proving/'+encodeURIComponent(name),undefined,(name,loaded,total)=>{
   downloads.current[name]=[loaded,total];const parts=Object.values(downloads.current);
   setProofKeys(value=>({loaded:parts.reduce((sum,[part])=>sum+part,0),total:parts.reduce((sum,[,part])=>sum+part,0),ready:value?.ready??false}));
  });
  return (name:string)=>{
   let load=loads.get(name);
   if(!load){const key='/proof-keys/'+pins[name]?.sha256;load=cachedProofKey(key).then(hit=>hit??network(name).then(bytes=>{storeProofKey(key,bytes);return bytes;}));load.catch(()=>loads.delete(name));loads.set(name,load);}
   return load;
  };
 })();
 const prefetch=(current:Profile)=>{
  if(prefetching.current)return;prefetching.current=true;void caches.delete('shielded-proof-keys-v1').catch(()=>undefined);
  const load=loader(current);
  void Promise.all(PROOF_KEYS.map(name=>load(name))).then(()=>setProofKeys(value=>value&&{...value,loaded:value.total,ready:true})).catch(()=>{prefetching.current=false;downloads.current={};setProofKeys(undefined);});
 };
 const refresh=async()=>{const current=await api<Profile>('/profile');setProfile(current);const {archive}=await api<{archive:Archive}>('/archive');return {current,archive};};
 const install=async(value:WalletBackup,current:Profile,archive:Archive)=>{
  if(value.network!=='mutinynet'||value.registrationProfile!==current.registration.profile||!value.trustedReleaseFingerprint)throw new Error('This wallet backup is missing its independently trusted Mutinynet release pin.');
  const verified=await verifyStockArchive(current,archive,value.trustedReleaseFingerprint,value.lastVerifiedHead);
  const keys=deriveWalletKeyMaterial(value.masterSecret,value.network),descriptorProfileId=stockProofDescriptor(current.verifierKey).profileId;
  if(value.descriptorProfileId!==descriptorProfileId)throw new Error('The registered Groth16 verifier changed. This backup cannot safely use the new profile.');
  const client=await createStockBrowserClient({owner:value.owner,keys:keys.keys,profile:current,checkpoint:verified.checkpoint,artifact:loader(current)});
  for(const entry of Object.values(archive.participants))if(!verifyParticipantRegistration(entry,'mutinynet',current.registration.profile))throw new Error('The public participant directory contains an invalid signature.');
  if(!archive.participants[value.owner]||archive.participants[value.owner].nativePublicKey!==participantPublicKey(keys.nativeSecret)||!same(archive.participants[value.owner].recipient,client.publicDescriptor()))throw new Error('This recovery secret does not match a registered wallet.');
  client.setRecipients(verified.checkpoint.recipients);client.restorePublicCheckpoint(verified.checkpoint);value.lastVerifiedHead=verified.head;verifiedArchive.current=archive;lastHead.current=archive.head.txid;kernel.current=client;nativeSecret.current=keys.nativeSecret;
  if(value.pending&&archive.history.some(entry=>same(entry.prepared,value.pending!.prepared)&&same(entry.proof,value.pending!.proof)))delete value.pending;
  // Neither accepted nor journaled by the pool: the verified archive stays authoritative, so it must not block new spends.
  else if(value.pending&&!current.pending){delete value.pending;setMessage('The previous request was not accepted by the pool, so nothing was spent.');}
  walletRef.current=value;setWallet({...value});setNotes(client.recover(value.owner));await save(value);
 };
 // The pool head can move between the archive fetch and the indexer check; a fresh fetch resolves it.
 const settled=async<T,>(action:()=>Promise<T>):Promise<T>=>{for(let attempt=0;;attempt++){try{return await action();}catch(error){if(attempt>=4||!/indexer does not confirm/.test((error as Error).message))throw error;await sleep(2000);}}};
 const sync=()=>settled(async()=>{const {current,archive}=await refresh();await install(walletRef.current!,current,archive);return {current,archive};});
 const connect=async(value:WalletBackup,step:Step)=>{
  let {current,archive}=await refresh();
  if(value.network!=='mutinynet'||!/^[0-9a-f]{64}$/.test(value.trustedReleaseFingerprint)||stockReleaseFingerprint(current.release)!==value.trustedReleaseFingerprint||value.registrationProfile!==current.registration.profile)throw new Error('This wallet backup does not match the independently trusted stock release.');
  await verifyStockArchive(current,archive,value.trustedReleaseFingerprint,value.lastVerifiedHead);
  const keys=deriveWalletKeyMaterial(value.masterSecret,value.network),owner=participantId(participantPublicKey(keys.nativeSecret));
  if(owner!==value.owner)throw new Error('The recovery secret does not match this wallet identity.');
  const client=await createStockBrowserClient({owner,keys:keys.keys,profile:current,artifact:loader(current)}),recipient=client.publicDescriptor(),known=archive.participants[owner];
  if(known){if(known.nativePublicKey!==participantPublicKey(keys.nativeSecret)||!same(known.recipient,recipient))throw new Error('This owner is already registered to a different wallet descriptor.');}
  else{
   step('Register with pool');
   await api('/participants/'+owner,signParticipantRegistration({network:'mutinynet',profile:current.registration.profile,secretKey:keys.nativeSecret,recipient}),BUSY_RETRIES);
   ({current,archive}=await refresh());
   await verifyStockArchive(current,archive,value.trustedReleaseFingerprint,value.lastVerifiedHead);
   const accepted=archive.participants[owner];
   if(!accepted||accepted.nativePublicKey!==participantPublicKey(keys.nativeSecret)||!same(accepted.recipient,recipient))throw new Error('The operator did not accept this wallet registration. The encrypted backup is safe; retry after checking the operator.');
  }
  step('Verify pool archive');await install(value,current,archive);return current;
 };
 const loadArk=async(current:Profile)=>{const value=await openCustomerArkWallet(SingleKey.fromHex(nativeSecret.current!),current.network),next={address:value.address,coins:value.coins};setArk(next);return next;};
 const run=async(title:string,steps:string[],action:(step:Step)=>Promise<void>,retry?:()=>void)=>{
  if(busyRef.current)return false;
  busyRef.current=true;setBusy(true);setMessage('');setNow(Date.now());setActivity({title,steps,current:0,visited:[],startedAt:Date.now()});
  const step:Step=label=>setActivity(value=>{const index=value?value.steps.indexOf(label):-1;return value&&index>=value.current?{...value,current:index,visited:[...value.visited,index]}:value;});
  try{await action(step);setActivity(value=>value&&{...value,current:value.steps.length,done:true,endedAt:Date.now()});return true;}
  catch(error){pausedUntil.current=Date.now()+60000;setActivity(value=>value&&{...value,error:(error as Error).message,endedAt:Date.now(),retry});return false;}
  finally{busyRef.current=false;setBusy(false);}
 };
 const sealPool=async(needed:()=>boolean)=>{
  for(let attempt=0;attempt<BUSY_RETRIES&&needed();attempt++){
   try{await api('/seal',{});return;}
   catch(error){if((error as {status?:number}).status!==409)throw error;await sleep(3000);await sync();}
  }
  if(needed())throw new Error('The pool stayed busy. Sealing retries automatically.');
 };
 const settle=async(kind:'deposit'|'transfer'|'withdraw',options:{amount:number;to?:Owner;program?:string;funding?:Funding},step:Step)=>{
  const value=walletRef.current!,owned=()=>noteSummary(kernel.current!.recover(value.owner));
  if(value.pending)throw new Error('A previous request is still resolving. The wallet checks it automatically.');
  step('Check pool');let {current,archive}=await sync();
  if(!current.ready)throw new Error(current.blockedReason||'The pool is not ready.');
  if(kind!=='deposit'&&owned().maxSendable<options.amount){
   if(owned().maxAfterSeal<options.amount)throw new Error(`Your largest note is ${sats(owned().maxAfterSeal)} sats. This pool spends one note per transaction.`);
   step('Seal pending notes');await sealPool(()=>owned().maxSendable<options.amount);({current,archive}=await sync());
  }
  if(archive.phase===17){step('Publish pool keys');await api('/prepare',{},BUSY_RETRIES);({current,archive}=await sync());}
  step('Build transaction');
  const prepared=kind==='deposit'?await kernel.current!.prepareStockShield(value.owner,'BTC',options.amount):kind==='transfer'?await kernel.current!.prepareStockTransfer(value.owner,options.to!,'BTC',options.amount):await kernel.current!.prepareStockWithdraw(value.owner,'BTC',options.amount,options.program!);
  const externalFunding=options.funding,request:any={profile:loadStockProfile(current.programs,current.verifierKey,current.release.descriptorProfileId,current.network,current.release.programsHash),operation:kind,pool:{...archive.head,sourceTx:hex.decode(archive.head.sourceTxHex)},oldState:prepared.oldState,newState:prepared.newState,checkpoint:CSVMultisigTapscript.decode(hex.decode(current.checkpointTapscript)),hash:()=>{throw new Error('Poseidon is initializing.');},weightLimit:current.network.weightLimit};
  if(externalFunding)request.externalFunding={...externalFunding,sourceTx:hex.decode(externalFunding.sourceTxHex),tapTree:hex.decode(externalFunding.tapTreeHex),tapLeafScript:VtxoScript.decode(hex.decode(externalFunding.tapTreeHex)).findLeaf(externalFunding.leafHex)};
  if(kind==='withdraw'){request.payoutBTC=prepared.boundary.withdrawal.BTC;request.externalProgram=options.program;}
  const draft=await api<StockDraft>('/draft',{prepared,...(externalFunding?{externalFunding}:{}),...(kind==='withdraw'?{externalProgram:options.program}:{})});
  if(!draft.nativeBinding)throw new Error('Operator did not return the native proof binding.');
  step('Generate proof');prefetch(current);
  const proof=await kernel.current!.proveStock(prepared,draft.nativeBinding),poseidon=await buildPoseidon();request.hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
  step('Sign');const signedSpend=buildStockSpend(request,proof,draft),finalSpend=externalFunding?await signCustomerFunding(signedSpend,SingleKey.fromHex(nativeSecret.current!)):signedSpend;
  step('Submit');value.pending={prepared,proof,draft,...(externalFunding?{externalFunding}:{}),...(kind==='withdraw'?{externalProgram:options.program}:{})};await save(value);
  await api('/settlements',{prepared,proof,...(externalFunding?{externalFunding}:{}),signed:stockVmRequest(finalSpend)});
  step('Verify result');({current,archive}=await sync());
  if(walletRef.current!.pending)throw new Error('Submitted, but the result is not visible yet. The wallet keeps checking.');
  void loadArk(current).catch(()=>undefined);
  const unsealed=kind==='withdraw'?()=>owned().sealing>0:()=>!sealedAfter(verifiedArchive.current!.history,prepared.id);
  if(unsealed()){step('Seal new notes');await sealPool(unsealed);await sync();}
 };
 const checkPending=()=>run('Checking the previous transaction',RECONCILE_STEPS,async step=>{step('Ask pool to reconcile');await api('/reconcile',{},BUSY_RETRIES);step('Verify result');await sync();if(walletRef.current?.pending)throw new Error('The pool has not resolved it yet. The wallet checks again automatically.');});
 const sealNotes=(title:string,needed:()=>boolean)=>run(title,SEAL_STEPS,async step=>{step('Seal notes');await sealPool(needed);step('Verify result');await sync();});
 const autoStep=async()=>{
  const value=walletRef.current;if(!value||busyRef.current)return;
  if(value.pending){await checkPending();return;}
  const current=await api<Profile>('/profile');setProfile(current);
  if(current.head.txid!==lastHead.current&&!busyRef.current){
   busyRef.current=true;setSyncing(true);
   try{await sync();setMessage(value=>value.startsWith('Pool check failed')?'':value);}catch(error){setMessage(`Pool check failed: ${(error as Error).message}`);return;}finally{busyRef.current=false;setSyncing(false);}
  }
  const coins=autoShieldCoins((await loadArk(current)).coins,verifiedArchive.current?.history??[]);
  if(coins.length&&current.ready&&current.capacity.remainingNoteRecords>=2){const coin=coins[0];await run(`Shielding ${sats(coin.amount)} sats`,SHIELD_STEPS,step=>settle('deposit',{amount:coin.amount,funding:coin.funding},step));return;}
  if(noteSummary(kernel.current?.recover(value.owner)??[]).sealing>0)await sealNotes('Sealing received notes',()=>noteSummary(kernel.current!.recover(value.owner)).sealing>0);
 };
 const finishOpen=async(current:Profile,step:Step)=>{step('Open Arkade balance');await loadArk(current);prefetch(current);};
 const openSaved=(secret:string,remember:boolean):Promise<boolean>=>run('Opening your wallet',OPEN_STEPS,async step=>{
  step('Unlock');const raw=JSON.parse(localStorage.getItem(STORAGE)??'null');
  if(!validEncrypted(raw))throw new Error('The saved wallet is unreadable. Restore it from your recovery secret.');
  const value=await decryptWallet<WalletBackup>(raw,secret);
  if(remember){passphrase.current=secret;localStorage.setItem(PASSPHRASE,secret);setPassphraseInput('');}
  await finishOpen(await settled(()=>connect(value,step)),step);
 },()=>void openSaved(secret,remember));
 const trustedPin=()=>{
  const legacy=(import.meta as ImportMeta&{env?:Record<string,string|undefined>}).env?.VITE_STOCK_RELEASE_FINGERPRINT,value=(pin||(setupSupported===true?setup?.releaseFingerprint:legacy)||'').toLowerCase();
  if(!/^[0-9a-f]{64}$/.test(value))throw new Error('No trusted pool fingerprint is available. Paste one under “Restore or pin”.');
  if(!pin&&!window.isSecureContext)throw new Error('Open this wallet over HTTPS to trust the pool on first use.');
  return value;
 };
 const createFrom=async(master:Uint8Array,step:Step)=>{
  if(localStorage.getItem(STORAGE))throw new Error('This browser already has a wallet.');
  const trusted=trustedPin(),current=await api<Profile>('/profile'),{archive}=await api<{archive:Archive}>('/archive');
  if(stockReleaseFingerprint(current.release)!==trusted)throw new Error('This pool does not match the trusted fingerprint.');
  await verifyStockArchive(current,archive,trusted);
  const keys=deriveWalletKeyMaterial(master,'mutinynet'),value:WalletBackup={version:1,owner:participantId(participantPublicKey(keys.nativeSecret)),network:'mutinynet',registrationProfile:current.registration.profile,trustedReleaseFingerprint:trusted,descriptorProfileId:stockProofDescriptor(current.verifierKey).profileId,masterSecret:bytesToHex(master)};
  // A random device passphrase trades key secrecy for auto-open; acceptable only for Mutinynet test funds.
  passphrase.current=randomHex();await save(value,true);localStorage.setItem(PASSPHRASE,passphrase.current);setSaved(true);
  await finishOpen(await settled(()=>connect(value,step)),step);
 };
 const create=():Promise<boolean>=>run('Creating your wallet',CREATE_STEPS,async step=>{step('Create keys');localStorage.removeItem(BACKED_UP);setBackedUp(false);await createFrom(crypto.getRandomValues(new Uint8Array(32)),step);},()=>void (localStorage.getItem(STORAGE)?openSaved(passphrase.current,false):create()));
 const restore=()=>run('Restoring your wallet',CREATE_STEPS,async step=>{step('Create keys');await createFrom(parseMasterSecret(recovery),step);localStorage.setItem(BACKED_UP,'1');setBackedUp(true);setRecovery('');});
 const send=()=>{
  try{
   const value=walletRef.current!,current=profile!,recipient=parseRecipient(sendTo,{self:value.owner,serverKey:current.network.serverKey,participants:current.participants}),amount=number(sendAmount,'Amount');
   if(recipient.kind==='arkade'&&amount<current.network.dust)throw new Error(`Send at least ${current.network.dust} sats to an Arkade address.`);
   const title=recipient.kind==='wallet'?`Sending ${sats(amount)} sats privately`:`Unshielding ${sats(amount)} sats`;
   const attempt=():Promise<boolean>=>run(title,SPEND_STEPS,async step=>{await (recipient.kind==='wallet'?settle('transfer',{amount,to:recipient.owner},step):settle('withdraw',{amount,program:recipient.program},step));setSendAmount('');},()=>void attempt());
   void attempt();
  }catch(error){setMessage((error as Error).message);}
 };
 const download=async()=>{if(!wallet)return;await save();saveFile('shielded-stock-encrypted-backup.json',backupFile.current);};
 const downloadArchive=()=>{if(!wallet||!verifiedArchive.current)return;saveFile('shielded-stock-verified-public-archive.json',{version:1,releaseFingerprint:wallet.trustedReleaseFingerprint,lastVerifiedHead:wallet.lastVerifiedHead,archive:verifiedArchive.current});};
 const importBackup=async(file:File)=>{
  try{
   if(localStorage.getItem(STORAGE))throw new Error('An encrypted wallet already exists. Export it first, then import in a fresh browser profile.');
   const value=JSON.parse(await file.text());if(!validEncrypted(value))throw new Error('The selected encrypted backup is invalid.');
   await storeWalletBackup(value,true);backupFile.current=value;passphrase.current='';localStorage.removeItem(PASSPHRASE);setSaved(true);setMessage('Encrypted backup imported. Enter its passphrase to open it.');
  }catch(error){setMessage((error as Error).message);}
 };

 useEffect(()=>{
  if(setupSupported!==false&&setup?.phase!=='ready')return;
  let stopped=false;const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),15000);setProfileError(undefined);
  void fetch('/api/profile',{cache:'no-store',signal:controller.signal}).then(async response=>{const data=await response.json();if(!response.ok)throw new Error(data.error??`Pool details request failed (HTTP ${response.status})`);if(!stopped)setProfile(data as Profile);}).catch(error=>{if(!stopped)setProfileError(controller.signal.aborted?'Pool details did not respond within 15 seconds.':error.message);}).finally(()=>clearTimeout(timeout));
  return()=>{stopped=true;controller.abort();clearTimeout(timeout);};
 },[setupSupported,setup?.phase,profileAttempt]);
 useEffect(()=>{if(!profile||walletRef.current||autoOpened.current||!saved||!passphrase.current)return;autoOpened.current=true;void openSaved(passphrase.current,false);},[profile,saved]);
 useEffect(()=>{if(!activity||activity.endedAt)return;const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[activity?.startedAt,activity?.endedAt]);
 useEffect(()=>{if(!activity?.done)return;const timer=setTimeout(()=>setActivity(value=>value===activity?undefined:value),8000);return()=>clearTimeout(timer);},[activity]);
 useEffect(()=>{
  if(!wallet?.owner)return;
  let stopped=false,timer:ReturnType<typeof setTimeout>;
  const tick=async()=>{
   if(!busyRef.current&&Date.now()>=pausedUntil.current&&document.visibilityState==='visible')await autoStep().catch(error=>console.warn('Wallet automation paused:',error));
   if(!stopped)timer=setTimeout(()=>void tick(),AUTO_MS);
  };
  timer=setTimeout(()=>void tick(),1500);
  return()=>{stopped=true;clearTimeout(timer);};
 },[wallet?.owner]);

 const summary=noteSummary(notes),arkBalance=ark?.coins.reduce((sum,coin)=>sum+coin.amount,0)??0,status=stockWalletStatus(setup,setupSupported,profile,profileError,!!verifiedArchive.current);
 const elapsed=activity?Math.max(0,Math.round(((activity.endedAt??now)-activity.startedAt)/1000)):0,others=Object.keys(profile?.participants??{}).filter(owner=>owner!==wallet?.owner);
 let hint='';
 if(wallet&&profile&&sendTo.trim()){try{hint=parseRecipient(sendTo,{self:wallet.owner,serverKey:profile.network.serverKey,participants:profile.participants}).kind==='wallet'?'Private transfer: the amount and recipient stay hidden inside the pool.':'Unshield: this amount leaves the pool publicly to that Arkade address.';}catch(error){hint=(error as Error).message;}}
 const proofBar=proofKeys&&!proofKeys.ready&&<div className="stock-progress" role="progressbar" aria-label="Proof keys" aria-valuemin={0} aria-valuemax={proofKeys.total} aria-valuenow={proofKeys.loaded}><div><span style={{width:`${Math.min(100,Math.round(100*proofKeys.loaded/Math.max(1,proofKeys.total)))}%`}}/></div><small>{proofKeys.loaded<proofKeys.total?`Downloading proof keys · ${mb(proofKeys.loaded)} of ${mb(proofKeys.total)} MB`:'Checking proof keys…'}</small></div>;
 const activityCard=activity&&<section className={`stock-card stock-activity${activity.error?' failed':activity.done?' finished':''}`} aria-live="polite">
  <div className="stock-activity-head"><h2>{activity.title}</h2><span>{activity.error?'Stopped':activity.done?`Done · ${elapsed}s`:`${elapsed}s`}</span></div>
  <ol className="stock-steps">{activity.steps.map((label,index)=>{const state=activity.done||index<activity.current?(activity.visited.includes(index)?'done':'skipped'):index===activity.current?(activity.error?'error':'active'):'todo';return <li key={label} className={state}><i aria-hidden="true"/>{label}{state==='skipped'&&<small>not needed</small>}</li>;})}</ol>
  {!activity.endedAt&&activity.steps[activity.current]==='Generate proof'&&(proofBar||<small className="stock-muted">Proving in your browser. This keeps your amounts and keys private.</small>)}
  {activity.error&&<p className="stock-blocked">{activity.error}</p>}
  {activity.endedAt&&<div className="stock-actions">{activity.error&&activity.retry&&<button onClick={activity.retry}>Try again</button>}<button className="stock-ghost" onClick={()=>setActivity(undefined)}>Dismiss</button></div>}
 </section>;
 const setupCard=<section className="stock-card stock-install"><h2>{setupPresentation.title}</h2><p role="status">{setupPresentation.detail}</p>{setupPresentation.progress&&<p>{setupPresentation.progress.stage}{Number.isSafeInteger(setupPresentation.progress.completed)&&Number.isSafeInteger(setupPresentation.progress.total)?` · ${setupPresentation.progress.completed} of ${setupPresentation.progress.total} checks complete`:''}</p>}{setupPresentation.funding&&<><p>The operator needs at least <b>{setup!.minimumFundingSats} Mutinynet sats</b> at this initial funding address.</p><div className="stock-address"><small>Initial pool funding address</small><Copyable value={setup!.fundingAddress!}/></div></>}{setup?.phase==='blocked'&&<p className="stock-muted">Status refreshes automatically. Customer deposits are unavailable until setup succeeds.</p>}</section>;
 const loadingCard=<section className="stock-card stock-loading" aria-busy={!profileError}>{!profileError&&<span className="stock-spinner" aria-hidden="true"/>}<div><h2>{profileError?'Pool details unavailable':'Connecting to the pool'}</h2><p className="stock-muted">{profileError??'Loading the pool and its proof verifier.'}</p></div>{profileError&&<button onClick={()=>setProfileAttempt(value=>value+1)}>Retry</button>}</section>;
 const welcomeCard=<section className="stock-card stock-welcome">
  <Seal className="stock-welcome-seal"/>
  <h2>Private Bitcoin on Arkade</h2>
  <p className="stock-muted">Creating a wallet generates keys in this browser and registers your private receiving key with the pool. Your keys never leave this device.</p>
  <button className="stock-primary" disabled={busy} onClick={()=>void create()}>Create wallet</button>
  <details className="stock-advanced"><summary>Restore or pin</summary>
   <label>Recovery secret<input value={recovery} onChange={e=>setRecovery(e.target.value)} autoComplete="off" spellCheck={false}/></label>
   <button disabled={busy||!recovery} onClick={()=>void restore()}>Restore wallet</button>
   <label>Trusted pool fingerprint (optional)<input value={pin} onChange={e=>setPin(e.target.value.trim().toLowerCase())} autoComplete="off" spellCheck={false}/></label>
   <p className="stock-muted">{setup?.releaseFingerprint?<>Leave empty to trust this pool on first use: <code>{setup.releaseFingerprint}</code>. Verify it through a separate channel if you need stronger assurance.</>:'Paste the 64-character fingerprint from a trusted release channel.'}</p>
   <label className="stock-file">Import encrypted backup<input type="file" accept="application/json" onChange={e=>e.target.files?.[0]&&void importBackup(e.target.files[0])}/></label>
  </details>
 </section>;
 const unlockCard=<section className="stock-card"><h2>Open your wallet</h2>
  {passphrase.current?<><p className="stock-muted">This device remembers your wallet.</p><button className="stock-primary" onClick={()=>void openSaved(passphrase.current,false)}>Open wallet</button></>:<p className="stock-muted">This wallet was saved with a passphrase. Enter it once and this device will remember it.</p>}
  <form className="stock-send" onSubmit={e=>{e.preventDefault();void openSaved(passphraseInput,true);}}><label>Passphrase<input type="password" autoComplete="current-password" value={passphraseInput} onChange={e=>setPassphraseInput(e.target.value)}/></label><button className={passphrase.current?'stock-ghost':''} disabled={passphraseInput.length<12}>Unlock with passphrase</button></form>
 </section>;
 const home=wallet&&<>
  <section className="stock-card stock-balance">
   <div><small>SHIELDED BALANCE{syncing&&' · SYNCING'}</small><strong key={summary.spendable+summary.sealing}>{sats(summary.spendable+summary.sealing)} <em>sats</em></strong>{summary.sealing>0&&<span className="stock-pill">{sats(summary.sealing)} sats sealing</span>}</div>
   <Seal className="stock-seal"/>
   <div className="stock-balance-side"><div><small>ARKADE · NOT SHIELDED</small><b>{ark?`${sats(arkBalance)} sats`:'Loading…'}</b>{ark?.coins.length&&profile?<button className="stock-ghost stock-mini" disabled={busy||syncing} onClick={()=>{const coin=[...ark.coins].sort((a,b)=>b.amount-a.amount)[0]!;void run(`Shielding ${sats(coin.amount)} sats`,SHIELD_STEPS,step=>settle('deposit',{amount:coin.amount,funding:coin.funding},step));}}>Shield</button>:null}</div><div><small>MAX PER SEND</small><b>{sats(summary.maxAfterSeal)} sats</b></div></div>
   {proofBar}
  </section>
  {activityCard}
  {!backedUp&&<section className="stock-card stock-recovery"><h2>Save your recovery secret</h2><p className="stock-muted">It restores this wallet in any browser. Anyone who has it can spend your funds.</p>{reveal&&<div className="stock-address"><Copyable value={wallet.masterSecret}/></div>}<div className="stock-actions">{!reveal&&<button onClick={()=>setReveal(true)}>Show secret</button>}<button className="stock-ghost" onClick={()=>{localStorage.setItem(BACKED_UP,'1');setBackedUp(true);setReveal(false);}}>I saved it</button></div></section>}
  <section className="stock-card stock-panel">
   <div className="stock-tabs" role="tablist">{(['receive','send'] as const).map(name=><button key={name} role="tab" aria-selected={tab===name} className={tab===name?'selected':''} onClick={()=>setTab(name)}><Icon name={name==='receive'?'download':'arrow'} size={16}/>{name==='receive'?'Receive':'Send'}</button>)}</div>
   {tab==='receive'?<div className="stock-receive">
    <div className="stock-address"><small>FROM ANY ARKADE WALLET</small>{ark?<Copyable value={ark.address}/>:<code>Loading your Arkade address…</code>}<p className="stock-muted">BTC sent here is shielded automatically. Each incoming coin becomes one private note.</p></div>
    <div className="stock-address"><small>FROM ANOTHER SHIELDED WALLET</small><Copyable value={wallet.owner}/><p className="stock-muted">Share this wallet ID to receive private transfers inside the pool.</p></div>
   </div>:<form className="stock-send" onSubmit={e=>{e.preventDefault();send();}}>
    <label>To<input list="stock-wallets" value={sendTo} onChange={e=>setSendTo(e.target.value)} placeholder="Wallet ID or tark1… address" autoComplete="off" spellCheck={false}/></label>
    <datalist id="stock-wallets">{others.map(owner=><option key={owner} value={owner}/>)}</datalist>
    <label>Amount (sats)<div className="stock-amount"><input inputMode="numeric" value={sendAmount} onChange={e=>setSendAmount(e.target.value.replace(/\D/g,''))}/><button type="button" className="stock-ghost" disabled={!summary.maxAfterSeal} onClick={()=>setSendAmount(String(summary.maxAfterSeal))}>Max</button></div></label>
    {hint&&<p className="stock-muted">{hint}</p>}
    <button className="stock-primary" disabled={busy||syncing||!sendTo.trim()||!sendAmount}>{busy?'Working…':'Send'}</button>
   </form>}
  </section>
  {notes.some(note=>!note.spent)&&<section className="stock-card"><h2>Notes</h2><div className="stock-notes">{notes.filter(note=>!note.spent).map(note=><div key={note.index}><span>{sats(note.amount)} sats</span><span className={note.spendable?'ok':'wait'}>{note.spendable?'Spendable':'Sealing'}</span><code>{short(note.commitment)}</code></div>)}</div></section>}
  <details className="stock-card stock-advanced"><summary>Advanced</summary>
   <div className="stock-row"><div><small>POOL KEYS</small><strong>{profile?.phase===18?'Published':'Publish on next use'}</strong></div><div><small>NOTE RECORDS LEFT</small><strong>{profile?.capacity.remainingNoteRecords??'—'}</strong></div><div><small>TRUSTED FINGERPRINT</small><code>{short(wallet.trustedReleaseFingerprint)}</code></div></div>
   <div className="stock-actions"><button disabled={busy} onClick={()=>void checkPending()}>Reconcile now</button><button disabled={busy} onClick={()=>void sealNotes('Sealing notes',()=>true)}>Seal now</button><button className="stock-ghost" onClick={()=>void download()}>Download encrypted backup</button><button className="stock-ghost" disabled={!verifiedArchive.current} onClick={downloadArchive}>Download verified archive</button></div>
   {reveal?<><div className="stock-address"><small>RECOVERY SECRET</small><Copyable value={wallet.masterSecret}/></div><div className="stock-address"><small>BACKUP PASSPHRASE (THIS DEVICE)</small><Copyable value={passphrase.current}/></div></>:<button className="stock-ghost" onClick={()=>setReveal(true)}>Reveal recovery secret and backup passphrase</button>}
  </details>
 </>;

 return <div className="stock-page"><main className="stock-shell"><header className="stock-header"><a className="stock-brand" href="/">Shielded<span>Wallet</span></a><a className="stock-home" href="/">Home</a></header>
  <section className="stock-warning"><strong>Mutinynet test wallet</strong><span>Your keys and backup passphrase are stored in this browser so the wallet opens automatically. Use test funds only.</span></section>
  {setupSupported!==false&&setup?.phase!=='ready'?setupCard:!profile?loadingCard:wallet?home:<>{activityCard}{!busy&&(saved?unlockCard:welcomeCard)}</>}
  {message&&<p className="stock-message" role="status">{message}</p>}
  {status&&<section className="stock-meta"><span>Proof system: {status.proof}</span><span>Verifier setup: {status.setup}</span><span>Wallet verification: {status.state}</span>{profile?.limitations?.map(item=><small key={item}>{item}</small>)}</section>}
 </main></div>;
}
