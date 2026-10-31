import {ArkAddress,DefaultVtxo,DescriptorIdentity,IndexedDBContractRepository,IndexedDBWalletRepository,MnemonicIdentity,OnchainWallet,TxType,UnilateralExit,Wallet,deriveDescriptorLeafPubKey,identityDescriptor,isVtxoSpent,parseHDDescriptor,sequenceToTimelock,timelockToSequence,type Activity,type ExitQuote,type IWallet,type Identity,type NormalizedExtendedVirtualCoin,type SendParams,type WalletBalance,type WalletConfig} from '@arkade-os/sdk';
import {createSwapClient,isBtcAssetLenient,type AssetSwapRepository,type CorridorSwapRecord,type Quote,type ReceiveOptions,type ReceiveRequest,type SwapClient,type SwapClientConfig,type SwapRailClient,type SwapUpdate} from '@arkade-os/swap';
import {hex} from '@scure/base';
import {recoveryPhraseOf} from '../../packages/protocol/src/wallet-keys.ts';
import {BTC_ASSET} from '../../packages/protocol/src/rollup/constants.ts';
import {DUST} from './pool.ts';
import type {LightningArtifact,LightningPayout,LightningRepository} from './lightning-repository.ts';
import type {ShieldedWallet} from './wallet.ts';
import {createLightningRecovery,recoveryLock,type LightningRecovery} from './lightning-recovery.ts';
import {LightningSwapRepository,ReceiptStoreCompatibilityError,repairLightningReceipt} from './lightning-receipt.ts';

/** One pool-funded on-chain exit's payout key: where the pool pays, what signs it, and the hold that keeps everything else off it. */
export interface ExitPayout {
 address:string;
 wallet:IWallet;
 coin(value:number):Promise<NormalizedExtendedVirtualCoin|undefined>;
 release(outcome:{spent:boolean}):Promise<void>;
}
export interface PrivateLightningService extends SwapRailClient,Pick<SwapClient,'markets'|'receive'>,AsyncDisposable {
 exitPayout(poolAddress?:string):Promise<ExitPayout>;
 registerPayouts(records:LightningPayout[]):Promise<void>;
 getActivityHistory():Promise<Activity[]>;
 quoteRecovery(outpoint:string):Promise<ExitQuote>;
 getRecovery(outpoint:string):Promise<LightningRecovery|undefined>;
 prepareRecovery(outpoint:string,quote:ExitQuote):Promise<LightningRecovery>;
 repairRecovery(outpoint:string):Promise<LightningRecovery>;
 startRecovery(outpoint:string):Promise<void>;
 pauseRecovery():Promise<void>;
 [Symbol.asyncDispose]():Promise<void>;
}
export const lightningOwner=async(wallet:Pick<Wallet,'identity'>)=>hex.encode(await wallet.identity.xOnlyPublicKey());
export async function createLightningWallet(secret:string,config:Omit<WalletConfig,'identity'|'walletMode'|'settlementConfig'|'storage'>):Promise<Wallet>{
 const identity=MnemonicIdentity.fromMnemonic(recoveryPhraseOf(secret),{isMainnet:false}),name=`shielded-lightning-${await lightningOwner({identity})}`;
 return Wallet.create({...config,identity,walletMode:'hd',settlementConfig:false,
  storage:{walletRepository:new IndexedDBWalletRepository(`${name}-wallet`),contractRepository:new IndexedDBContractRepository(`${name}-contracts`)}});
}
function hdIdentity(wallet:Wallet){
 const identity=wallet.identity as MnemonicIdentity;
 if(typeof identity.descriptor!=='string'||typeof identity.signDescriptorTransactions!=='function'||typeof identity.ownsDescriptor!=='function')throw new Error('Lightning requires a recoverable HD companion wallet');
 return identity;
}
export function lightningSigner(wallet:Wallet,descriptor:string):Identity{
 const root=hdIdentity(wallet);
 if(!root.ownsDescriptor(descriptor))throw new Error('Foreign Lightning artifact descriptor');
 return new DescriptorIdentity({descriptor,base:root,signer:{
  signWithDescriptor:requests=>root.signDescriptorTransactions(requests),
  signMessageWithDescriptor:(descriptor,message,type)=>root.signDescriptorMessage(descriptor,message,type),
 }});
}
export async function materializeLightningArtifact(wallet:Wallet,artifact:LightningArtifact):Promise<LightningArtifact>{
 const parsed=parseHDDescriptor(hdIdentity(wallet).descriptor);
 if(!parsed||!Number.isSafeInteger(artifact.index)||artifact.index<0||artifact.index>=0x80000000)throw new Error('Invalid Lightning artifact index');
 const descriptor=`tr([${parsed.fingerprint}/${parsed.basePath}]${parsed.xpub}/2/8/${artifact.index})`,pubKey=deriveDescriptorLeafPubKey(descriptor);
 const serverPubKey=hex.encode(wallet.offchainTapscript.options.serverPubKey),csvTimelock=timelockToSequence(wallet.offchainTapscript.options.csvTimelock).toString();
 const script=new DefaultVtxo.Script({pubKey,serverPubKey:hex.decode(serverPubKey),csvTimelock:sequenceToTimelock(Number(csvTimelock))});
 return {...artifact,descriptor,serverPubKey,csvTimelock,address:script.address(wallet.network.hrp,wallet.arkServerPublicKey).encode(),script:hex.encode(script.pkScript)};
}
export async function artifactWallet(companion:Wallet,artifact:LightningArtifact,send:(params:SendParams)=>Promise<string>,available:()=>number):Promise<IWallet&Pick<Wallet,'signerForDescriptor'>>{
 if(!artifact.descriptor||!artifact.address||!artifact.script)throw new Error('Incomplete Lightning artifact');
 const identity=lightningSigner(companion,artifact.descriptor),bare=await identityDescriptor(identity),descriptor=artifact.descriptor;
 const signerForDescriptor=async(requested:string)=>{if(requested!==descriptor&&requested!==bare)throw new Error('Descriptor belongs to another Lightning artifact');return identity;};
 const overrides:Record<PropertyKey,unknown>={identity,getAddress:async()=>artifact.address,getNextSigningDescriptor:async()=>descriptor,
  advanceSigningDescriptorWatermark:async()=>{},signerForDescriptor,
  getBalance:async():Promise<WalletBalance>=>({available:available(),availableAssets:[],assets:[],total:0,settled:0,preconfirmed:0,gated:0,pendingSettlement:0,reserved:0,recoverable:0,pendingRecovery:0,unrolled:0,boarding:{confirmed:0,unconfirmed:0,total:0}}),send};
 return new Proxy(companion,{get(target,key){if(key in overrides)return overrides[key];const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}}) as IWallet&Pick<Wallet,'signerForDescriptor'>;
}
/** Held by the one tab running an exit, so another tab's payout scan leaves that script alone. Never persisted. */
export const exitReservation=(owner:string,script:string)=>`shielded-exit-${owner}-payout-${script}`;
const terminal=new Set(['paid','claimed','refunded','lapsed','failed','cancelled','filled']);
const artifactEnded=(artifact:LightningArtifact)=>artifact.state==='ended';
const biggestNote=(wallet:ShieldedWallet)=>{try{return Number(wallet.account.spendableNotes(BTC_ASSET,wallet.inFlight).reduce((max,n)=>n.amount>max?n.amount:max,0n));}catch{return 0;}};
export class LightningSessionBusy extends Error {constructor(){super('This Lightning payment is running in another tab. It continues there, and this tab takes it over if that tab closes.');}}
export async function acquireLightningSession(name:string):Promise<()=>Promise<void>>{
 if(typeof navigator==='undefined'||!navigator.locks)throw new Error('Private Lightning requires browser locking to protect active payments');
 let release!:()=>void,done!:Promise<void>;
 const held=new Promise<void>(resolve=>{release=resolve;});
 await new Promise<void>((resolve,reject)=>{
  done=navigator.locks.request(name,{ifAvailable:true},async lock=>{if(!lock){reject(new LightningSessionBusy());return;}resolve();await held;});
  void done.catch(reject);
 });
 return async()=>{release();await done;};
}
type ClientOptions=Omit<SwapClientConfig,'wallet'|'repository'|'policy'>;
interface PrivateLightningOptions extends ClientOptions {
 wallet:ShieldedWallet;companion:Wallet;journal:LightningRepository;
 repositoryFor?:(name:string)=>AssetSwapRepository;
 clientFactory?:typeof createSwapClient;
 acquireSession?:(name:string)=>Promise<()=>Promise<void>>;
 legacyRecovery?:boolean;
 onError?:(error:Error)=>void;
}
interface Session {artifact:LightningArtifact;repository:AssetSwapRepository;client:SwapClient;view:IWallet;release:()=>Promise<void>;off:()=>void;initialized:boolean;accepting:boolean;funding?:Promise<void>;retiring?:Promise<void>;needsFundingRetry?:boolean;quote?:Quote;closing?:Promise<void>}
export async function createPrivateLightning(options:PrivateLightningOptions):Promise<PrivateLightningService>{
 const {wallet,companion,journal,repositoryFor=name=>new LightningSwapRepository(name),clientFactory=createSwapClient,acquireSession=acquireLightningSession,legacyRecovery=true,onError,...config}=options;
 const owner=await lightningOwner(companion),pool=wallet.pool.status.pool!.token,namespace=`shielded-lightning-${owner}-${pool}`;
 const sessions=new Map<string,Session>(),listeners=new Set<(update:SwapUpdate)=>void>(),updates=new Map<string,SwapUpdate>();
 const operations=new AbortController();
 const payouts=new Map<string,LightningPayout>(),shielding=new Map<string,Promise<void>>(),shieldingControllers=new Map<string,AbortController>();
 const exiting=new Map<string,()=>Promise<void>>(),exitScripts=new Set<string>();
 const receipts=new Map<string,CorridorSwapRecord>();
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,legacy:SwapClient|undefined,legacyRepository:AssetSwapRepository|undefined,releaseLegacy:(()=>Promise<void>)|undefined,offLegacy:(()=>void)|undefined;
 const discoveryRepository=repositoryFor(`${namespace}-markets`),discovery=clientFactory({...config,wallet:companion,repository:discoveryRepository,policy:{drive:'readonly'}});
 const forward=(update:SwapUpdate)=>{updates.set(update.swap.id,update);for(const listener of listeners)try{listener(update);}catch{}};
 const report=(error:unknown)=>{try{onError?.(error instanceof Error?error:new Error(String(error)));}catch{}};
 const repairReceipt=async(artifact:LightningArtifact,repository:AssetSwapRepository)=>{
  if(artifact.kind!=='send'||!artifact.quoteId)return;
  try{
   await repairLightningReceipt(repository,companion.indexerProvider,artifact.quoteId);
   const record=await repository.getSwapRecord(artifact.quoteId);
   if(record?.family==='rfq'&&record.kind==='lightning_send'&&record.state==='settled'&&!record.refundTxid&&record.fundingTxid&&/^[0-9a-f]{64}$/.test(record.fundingTxid)&&Number.isSafeInteger(Number(record.give.amount))&&Number(record.give.amount)>0){receipts.set(record.id,record);wallet.changed();}
  }
  catch(error){report(error instanceof ReceiptStoreCompatibilityError?error:new Error('A saved Lightning receipt could not be verified; it remains unchanged.'));}
 };
 const assertOpen=()=>{if(stopped)throw new Error('Private Lightning service is closed');};
 const getActivityHistory=async():Promise<Activity[]>=>{
  assertOpen();
  const manager=await companion.getContractManager(),[contracts,spends,artifacts]=await Promise.all([manager.getContractsWithVtxos(undefined,undefined,{unspentOnly:false}),journal.list(String(wallet.self.owner),pool),journal.artifacts(owner,pool)]);
  const rows=new Map<string,Activity>();
  for(const record of receipts.values()){
   const amount=Number(record.give.amount),createdAt=record.createdAt*1000,txid=record.fundingTxid!;
   rows.set(`shielded-lightning:send:${record.id}`,{id:`shielded-lightning:send:${record.id}`,amount:-amount,createdAt,settled:true,intent:{kind:'lightning-send',label:'Paid via Lightning',outcome:'paid',metadata:{fundingTxid:txid}},
    txs:[{key:{boardingTxid:'',commitmentTxid:'',arkTxid:txid},type:TxType.TxSent,amount,createdAt,settled:true}]});
  }
  for(const {contract,vtxos} of contracts){
   if(!payouts.has(contract.script))continue;
   for(const coin of vtxos){
    if(coin.script!==contract.script)continue;
    const outpoint=`${coin.txid}:${coin.vout}`,attempts=spends.filter(record=>record.kind==='shield'&&record.reference===outpoint);
    const recoveryState=await recovery.get(outpoint),source=artifacts.find(a=>a.script===contract.script);
    // A completed exit spent its payout on-chain and left no shield attempt behind; the SDK's own history carries that spend.
    if(source?.kind==='exit'&&isVtxoSpent(coin)&&!attempts.length&&!recoveryState)continue;
    const outcome=recoveryState?.state==='complete'?'onchain-recovered':recoveryState?.state==='shielded'?'shielded':recoveryState?'onchain-recovery':attempts.some(r=>r.state==='included')?'shielded':coin.value<DUST?'below-minimum':attempts.some(r=>r.state==='prepared')||shielding.has(outpoint)?'shielding':attempts.length?'retrying':'received';
    const id=`shielded-lightning:receive:${outpoint}`,createdAt=coin.createdAt.getTime(),settled=!coin.isPreconfirmed;
    rows.set(id,{id,amount:coin.value,createdAt,settled,intent:{kind:'lightning-receive',label:source?.kind==='send'?'Lightning refund':source?.kind==='exit'?'On-chain exit payout':'Received via Lightning',outcome,metadata:{outpoint}},
     txs:[{key:{boardingTxid:'',commitmentTxid:'',arkTxid:coin.txid},type:TxType.TxReceived,amount:coin.value,createdAt,settled}]});
   }
  }
  for(const saved of await recovery.list()){
   const id=`shielded-lightning:receive:${saved.outpoint}`;if(rows.has(id))continue;
   const amount=saved.quote.vtxos[0]!.value!,createdAt=saved.createdAt,txid=saved.outpoint.split(':')[0]!,outcome=saved.state==='complete'?'onchain-recovered':saved.state==='shielded'?'shielded':'onchain-recovery';
   rows.set(id,{id,amount,createdAt,settled:false,intent:{kind:'lightning-receive',label:'Lightning payout recovery',outcome,metadata:{outpoint:saved.outpoint}},txs:[{key:{boardingTxid:'',commitmentTxid:'',arkTxid:txid},type:TxType.TxReceived,amount,createdAt,settled:false}]});
  }
  return [...rows.values()].sort((a,b)=>b.createdAt-a.createdAt);
 };
 const close=(session:Session)=>session.closing??=(async()=>{await session.funding?.catch(()=>{});await session.retiring?.catch(()=>{});session.off();await session.client[Symbol.asyncDispose]();await session.repository[Symbol.asyncDispose]?.();await session.release();sessions.delete(session.artifact.id);})();
 const bind=(session:Session)=>{session.off=session.client.onUpdate(update=>{
  forward(update);if(!terminal.has(update.outcome)||session.artifact.state!=='accepted'||session.retiring)return;
  const retiring=(async()=>{
   if(session.artifact.kind==='send'){
    const funding=await journal.get(String(wallet.self.owner),pool,`lightning-fund-${session.artifact.index}`);
    if(funding?.state==='prepared')return;
    if(funding?.state==='included'&&!['paid','refunded'].includes(update.outcome)){report(new Error('Lightning funding is confirmed and still needs HTLC recovery.'));return;}
    await repairReceipt(session.artifact,session.repository);
   }
   session.artifact.state='ended';await journal.updateArtifact(owner,pool,session.artifact);await scan();
  })();session.retiring=retiring;
  void retiring.then(async()=>{if(artifactEnded(session.artifact)&&session.initialized&&!session.accepting&&!session.funding)await close(session);}).catch(report).finally(()=>{if(session.retiring===retiring)session.retiring=undefined;});
 });};
 const scan=async()=>{
  if(stopped||!payouts.size)return;
  for(const coin of await companion.getVtxos({withRecoverable:false})){
   const payout=payouts.get(coin.script),outpoint=`${coin.txid}:${coin.vout}`;
   if(!payout||coin.assets?.length||exiting.has(coin.script)||shielding.has(outpoint)||await recovery.held(outpoint))continue;
   if(coin.value<DUST){report(new Error(`This individual Lightning payout is below the pool minimum of ${DUST} sats and cannot be shielded alone.`));continue;}
   const reserved=exitScripts.has(coin.script)?await acquireSession(exitReservation(owner,coin.script)).catch(()=>undefined):async()=>{};
   if(!reserved)continue;
   const controller=new AbortController();shieldingControllers.set(outpoint,controller);
   const task=(async()=>{try{const release=await acquireSession(recoveryLock(owner,outpoint));try{
    if(await recovery.held(outpoint))return;
    const attempts=(await journal.list(String(wallet.self.owner),pool)).filter(record=>record.kind==='shield'&&record.reference===outpoint),existing=attempts.find(record=>record.state!=='dropped'),baseId=`lightning-shield-${outpoint}`;
    let id=existing?.id??baseId;
    if(!existing&&attempts.length){let suffix=attempts.length;do{id=`${baseId}-${suffix++}`;}while(attempts.some(record=>record.id===id));}
    const handle=await wallet.shieldLightning(coin,lightningSigner(companion,payout.descriptor),journal,{id,reference:outpoint,signal:AbortSignal.any([operations.signal,controller.signal])});await handle.settled();
   }finally{await release();}}finally{await reserved();}})();
   shielding.set(outpoint,task);wallet.changed();void task.catch(report).finally(()=>{shielding.delete(outpoint);shieldingControllers.delete(outpoint);wallet.changed();});
  }
 };
 const validatePayouts=async(records:LightningPayout[])=>{
  assertOpen();const manager=await companion.getContractManager(),contracts=await manager.getContracts();
  const scripts:DefaultVtxo.Script[]=[];
  for(const record of records){
   const contract=contracts.find(c=>c.script===record.script),pubKey=deriveDescriptorLeafPubKey(record.descriptor);
   lightningSigner(companion,record.descriptor);
   if(!contract||contract.type!=='default'||contract.address!==record.address||contract.metadata?.signingDescriptor!==record.descriptor||contract.params.pubKey!==hex.encode(pubKey))throw new Error('Lightning payout contract does not match its recoverable descriptor');
   const script=new DefaultVtxo.Script({pubKey,serverPubKey:hex.decode(String(contract.params.serverPubKey)),csvTimelock:sequenceToTimelock(Number(contract.params.csvTimelock))});
   if(hex.encode(script.pkScript)!==record.script||hex.encode(ArkAddress.decode(record.address).pkScript)!==record.script)throw new Error('Lightning payout script does not match its contract');
   scripts.push(script);
  }
  return scripts;
 };
 const recoveryOptions=async(outpoint:string)=>{
  assertOpen();const parsed=/^([0-9a-f]{64}):(0|[1-9]\d*)$/.exec(outpoint),vout=Number(parsed?.[2]);
  if(!parsed||!Number.isSafeInteger(vout)||vout>0xffffffff)throw new Error('Invalid Lightning payout outpoint');
  const requested={txid:parsed[1]!,vout},{vtxos}=await companion.indexerProvider.getVtxos({outpoints:[requested]}),coin=vtxos[0];
  if(vtxos.length!==1||!coin||coin.txid!==requested.txid||coin.vout!==vout||isVtxoSpent(coin)||coin.isSwept||coin.assets?.length)throw new Error('This Lightning payout is missing, spent, swept or carries an asset.');
  const payout=payouts.get(coin.script);if(!payout)throw new Error('This output is not a saved Lightning payout for this wallet.');
  const [script]=await validatePayouts([payout]);
  const attempts=await journal.list(String(wallet.self.owner),pool);
  if(attempts.some(r=>r.kind==='shield'&&r.reference===outpoint&&r.state==='included'))throw Object.assign(new Error('This Lightning payout is already shielded.'),{code:'lightning-payout-shielded'});
  const onchain=await OnchainWallet.create(companion.identity,'mutinynet',companion.onchainProvider);
  return {options:{wallet:companion,onchainWallet:onchain,sweepAddress:onchain.address,vtxos:[requested],networkName:'mutinynet' as const},coin,script:script!};
 };
 const quoteRecovery=async(outpoint:string):Promise<ExitQuote>=>{
  const {options,coin,script}=await recoveryOptions(outpoint),quote=await UnilateralExit.estimate(options);
  assertOpen();const info=quote.vtxos[0],delay=script!.options.csvTimelock;
  if(quote.vtxos.length!==1||info?.outpoint!==outpoint)throw new Error('The recovery quote does not match this Lightning payout.');
  if(info.skipped)throw new Error(`Onchain recovery is unavailable: ${info.skipped}`);
  if(info.value!==coin.value||info.delay?.type!==delay.type||BigInt(info.delay.value)!==delay.value||quote.totals.recoveredSats<=0)throw new Error('The recovery quote does not match the original payout contract.');
  recovery.remember(outpoint,quote);return quote;
 };
 const recovery=createLightningRecovery({owner,pool,companion,journal,acquireSession,options:async outpoint=>(await recoveryOptions(outpoint)).options,
  stopShielding:async outpoint=>{shieldingControllers.get(outpoint)?.abort();await shielding.get(outpoint)?.catch(()=>{});},
  reconcileShielding:outpoint=>wallet.reconcileLightningPayout(outpoint,journal),changed:()=>wallet.changed(),report});
 const registerPayouts=async(records:LightningPayout[],rescan=true)=>{
  await validatePayouts(records);const manager=await companion.getContractManager();
  await journal.savePayouts(owner,pool,records);
  for(const record of records){payouts.set(record.script,record);await manager.setContractWatchState(record.script,'watched');}
  wallet.changed();
  if(rescan)await scan();
 };
 const watchArtifact=async(artifact:LightningArtifact)=>{
  if(!artifact.descriptor||!artifact.address||!artifact.script||!artifact.serverPubKey||!artifact.csvTimelock)throw new Error('Incomplete saved Lightning artifact');
  const pubKey=deriveDescriptorLeafPubKey(artifact.descriptor),manager=await companion.getContractManager();
  await manager.createContract({type:'default',script:artifact.script,address:artifact.address,watch:'watched',
   params:{pubKey:hex.encode(pubKey),serverPubKey:artifact.serverPubKey,csvTimelock:artifact.csvTimelock},metadata:{signingDescriptor:artifact.descriptor}});
  return {id:artifact.id,descriptor:artifact.descriptor,address:artifact.address,script:artifact.script};
 };
 /** A never-reused key for one on-chain exit: saved and watched before the caller withdraws, so a crash mid-exit still finds the payout. */
 const exitPayout=async(poolAddress?:string):Promise<ExitPayout>=>{
  assertOpen();
  const allocated=await journal.allocateArtifact(owner,pool,'exit'),artifact=await materializeLightningArtifact(companion,allocated);
  // Refused before its descriptor is saved, since restore re-watches every saved descriptor.
  if(poolAddress){
   const mine=ArkAddress.decode(artifact.address!),theirs=ArkAddress.decode(poolAddress);
   if(mine.hrp!==theirs.hrp||hex.encode(mine.serverPubKey)!==hex.encode(theirs.serverPubKey)){await journal.updateArtifact(owner,pool,{...allocated,state:'ended'});throw new Error('The exit payout key belongs to another Arkade server.');}
  }
  await journal.updateArtifact(owner,pool,artifact);
  const script=artifact.script!,address=artifact.address!;
  let value=0,unlock:(()=>Promise<void>)|undefined;
  const view=await artifactWallet(companion,artifact,async()=>{throw new Error('An on-chain exit offboards its payout; it never sends it.');},()=>value);
  const reservation=await acquireSession(exitReservation(owner,script));
  exitScripts.add(script);exiting.set(script,reservation);
  try{await registerPayouts([await watchArtifact(artifact)]);}
  catch(error){exiting.delete(script);await reservation().catch(()=>{});throw error;}
  return {address,wallet:view,
   async coin(expected){
    const found=(await companion.getVtxos({withRecoverable:false})).find(v=>v.script===script&&v.value===expected&&!v.assets?.length&&!isVtxoSpent(v)&&!v.isSwept);
    if(!found)return undefined;
    value=found.value;
    unlock??=await acquireSession(recoveryLock(owner,`${found.txid}:${found.vout}`));
    return found;
   },
   async release({spent}){
    if(!exiting.delete(script))return;
    artifact.state='ended';
    for(const step of [async()=>journal.updateArtifact(owner,pool,artifact),async()=>unlock?.(),reservation,async()=>{if(!spent&&!stopped)await scan();}])
     try{await step();}catch(error){report(error);}
   }};
 };
 const open=async(artifact:LightningArtifact):Promise<Session>=>{
  const release=await acquireSession(`${namespace}-${artifact.id}`),repository=repositoryFor(`${namespace}-${artifact.id}`);
  let client:SwapClient|undefined;
  try{
   await repairReceipt(artifact,repository);
   const view=await artifactWallet(companion,artifact,async params=>{
    const keys=Object.keys(params),payment=params as unknown as {address:string;amount:number};
    if(keys.some(key=>!['address','amount'].includes(key))||typeof payment.address!=='string'||!Number.isSafeInteger(payment.amount)||payment.amount<=0||!artifact.quoteId||!Number.isSafeInteger(artifact.expiresAt)||artifact.expiresAt!<=0)throw new Error('Private Lightning can fund only its verified HTLC');
    const record=await repository.getSwapRecord(artifact.quoteId);
    if(!record||record.family!=='rfq'||record.kind!=='lightning_send'||record.route.give.corridor!=='arkade'||record.route.take.corridor!=='lightning'||record.lockupAddress!==payment.address||record.give.amount!==String(payment.amount)||record.expiresAt!==artifact.expiresAt||!isBtcAssetLenient(record.route.give.asset)||hex.encode(ArkAddress.decode(payment.address).pkScript)!==record.lockupPkScript||!/^[0-9a-f]{64}$/.test(record.lock.hash))throw new Error('Private Lightning funding does not match its stored HTLC');
    return wallet.fundLightning(`lightning-fund-${artifact.index}`,record.lock.hash,record.lockupAddress,BigInt(record.give.amount),journal,operations.signal,artifact.expiresAt);
   },()=>biggestNote(wallet));
   client=clientFactory({...config,wallet:view,repository,policy:{drive:'manual'}});
   const session:Session={artifact,repository,client,view,release,off:()=>{},initialized:false,accepting:false};sessions.set(artifact.id,session);
   bind(session);
   await client.ready;await session.retiring;session.initialized=true;if(artifact.state==='ended')await close(session);return session;
  }catch(error){if(client)await client[Symbol.asyncDispose]().catch(()=>{});await repository[Symbol.asyncDispose]?.();await release();throw error;}
 };
 const startSession=async(session:Session)=>{
  if(artifactEnded(session.artifact)||session.funding)return;
  const {artifact,repository}=session,record=artifact.quoteId?await repository.getSwapRecord(artifact.quoteId):undefined;
  const funding=artifact.kind==='send'?await journal.get(String(wallet.self.owner),pool,`lightning-fund-${artifact.index}`):undefined;
  if(!funding||funding.state==='dropped'){await session.client.start();return;}
  if(!record||record.family!=='rfq'||record.kind!=='lightning_send'||record.lock.hash!==funding.paymentHash||record.lockupAddress!==funding.destination||record.give.amount!==funding.amount||funding.expiresAt!==artifact.expiresAt)throw new Error('Saved Lightning funding does not match its accepted HTLC');
  session.needsFundingRetry=false;
  session.funding=(async()=>{
   const txid=await session.view.send({address:record.lockupAddress,amount:Number(record.give.amount)});
   const latest=await repository.getSwapRecord(record.id);
   if(!latest||latest.family!=='rfq'||latest.lockupAddress!==record.lockupAddress)throw new Error('Lightning record changed during funding recovery');
   if(latest.fundingTxid&&latest.fundingTxid!==txid)throw new Error('Lightning funding transaction changed during recovery');
   await repository.saveSwapRecord({...latest,fundingTxid:txid,...latest.state==='failed'?{state:'pending',failure:undefined,blockedReason:undefined}:{}});
   if(stopped)return;
   session.off();await session.client[Symbol.asyncDispose]();session.initialized=false;
   session.client=clientFactory({...config,wallet:session.view,repository,policy:{drive:'manual'}});bind(session);
   await session.client.ready;await session.retiring;session.initialized=true;
   if(!stopped&&!artifactEnded(artifact))await session.client.start();
  })();
  const task=session.funding;
  void task.then(async()=>{if(artifactEnded(artifact))await close(session);}).catch(error=>{session.needsFundingRetry=true;report(error);}).finally(()=>{if(session.funding===task)session.funding=undefined;});
 };
 const quote:PrivateLightningService['quote']=async input=>{
  assertOpen();await wallet.restoreLightningSpends(journal);await discovery.markets();const resolution=await discovery.resolve(input),send=resolution.give.corridor==='arkade'&&resolution.take.corridor==='lightning',receive=resolution.give.corridor==='lightning'&&resolution.take.corridor==='arkade';
  if(!send&&!receive)throw new Error('Private Lightning supports Bitcoin Lightning payments only');
  const amount=resolution.amount?.value;
  if(amount===undefined||amount<=0n||amount>BigInt(Number.MAX_SAFE_INTEGER))throw new Error('Lightning needs a valid whole-sat amount');
  if(receive&&amount<BigInt(DUST))throw new Error(`Each individual Lightning payout needs at least ${DUST} sats to enter the shielded pool.`);
  if(send&&!wallet.canWithdraw(amount))throw new Error('No single unreserved pool note covers this Lightning payment');
  const artifact=await materializeLightningArtifact(companion,await journal.allocateArtifact(owner,pool,send?'send':'receive'));
  await journal.updateArtifact(owner,pool,artifact);await registerPayouts([await watchArtifact(artifact)]);
  const session=await open(artifact);
  try{
   const quoted=await session.client.quote(input);
   if(!Number.isSafeInteger(quoted.expiresAt)||quoted.expiresAt<=0)throw new Error('Lightning quote has no valid funding deadline');
   if(receive&&quoted.take.amount<BigInt(DUST))throw new Error(`The quoted individual Lightning payout is below the shielded pool minimum of ${DUST} sats.`);
   if(send&&!wallet.canWithdraw(quoted.give.amount))throw new Error('No single unreserved pool note covers this Lightning payment and its fee');
   artifact.state='quoted';artifact.quoteId=quoted.id;artifact.expiresAt=quoted.expiresAt;await journal.updateArtifact(owner,pool,artifact);session.quote=quoted;
   return quoted;
  }catch(error){await close(session);throw error;}
 };
 const accept:PrivateLightningService['accept']=async quoted=>{
  assertOpen();const session=[...sessions.values()].find(s=>s.quote===quoted);
  if(!session)throw new Error('Lightning quote is no longer active; request another quote');
  const artifact=session.artifact;session.accepting=true;artifact.state='accepted';await journal.updateArtifact(owner,pool,artifact);
  try{const swap=await session.client.accept(quoted);await session.retiring;if(!stopped&&!artifactEnded(artifact))await session.client.start();return swap;}
  catch(error){
   const stored=await session.repository.getSwapRecord(quoted.id);await close(session);
   if(stored&&!artifactEnded(artifact)){const resumed=await open(artifact).catch(e=>{if(e instanceof LightningSessionBusy)return undefined;throw e;});if(resumed)await startSession(resumed);}
   else if(!stored){artifact.state='ended';await journal.updateArtifact(owner,pool,artifact);}
   throw error;
  }finally{session.accepting=false;if(artifact.state==='ended')await close(session);}
 };
 const receive:SwapClient['receive']=async <C extends ReceiveOptions['via']>(options:ReceiveOptions&{readonly via:C}):Promise<ReceiveRequest<C>>=>{
  if(options.via!=='lightning')throw new Error('Private receiving requires Lightning');
  const quoted=await quote({give:options.asset,via:options.via,amount:options.amount,amountOn:'take'});
  if(options.maxFee&&(quoted.fee.asset!==options.maxFee.asset||quoted.fee.amount>options.maxFee.amount))throw new Error('Lightning receive exceeds its fee ceiling');
  const swap=await accept(quoted);if(swap.artifact?.kind!=='invoice')throw new Error('Lightning receive returned no invoice');
  return swap as ReceiveRequest<C>;
 };
 let offPayout:()=>void=()=>{},taking:Promise<void>=Promise.resolve();
 const dispose=async()=>{if(stopped)return;stopped=true;operations.abort();await taking.catch(()=>{});await recovery.dispose();if(timer)clearTimeout(timer);offPayout();offLegacy?.();await Promise.allSettled([...sessions.values()].map(close));await legacy?.[Symbol.asyncDispose]();await legacyRepository?.[Symbol.asyncDispose]?.();await releaseLegacy?.();await discovery[Symbol.asyncDispose]();await discoveryRepository[Symbol.asyncDispose]?.();await Promise.allSettled([...shielding.values()]);
  await Promise.allSettled([...exiting.values()].map(release=>release()));exiting.clear();listeners.clear();};
 // An accepted swap nobody here drives: opened at startup, and on each tick once a sibling tab holding it closes.
 const unopenable=new Set<string>();
 const takeOver=async(startup:boolean)=>{
  for(const artifact of await journal.artifacts(owner,pool)){
   if(stopped)return;
   if(artifact.kind==='exit'||unopenable.has(artifact.id))continue;
   // A swap a sibling started after this tab did, even one that has ended, has no payout watch here yet, so its payout would never be shielded.
   if(artifact.descriptor&&!payouts.has(artifact.script!))try{await registerPayouts([await watchArtifact(artifact)],false);}catch(error){unopenable.add(artifact.id);report(error);continue;}
   if(artifact.state!=='accepted'||sessions.has(artifact.id))continue;
   const session=await open(artifact).catch(error=>{const busy=error instanceof LightningSessionBusy;if(!busy)unopenable.add(artifact.id);if(!busy||startup)report(error);});
   if(!session)continue;
   if(stopped){await close(session);return;}
   try{await startSession(session);}catch(error){unopenable.add(artifact.id);await close(session);if(startup)throw error;report(error);}
  }
 };
 try{
  const artifacts=await journal.artifacts(owner,pool),restoredPayouts=await journal.payouts(owner,pool);
  for(const artifact of artifacts)if(artifact.descriptor){restoredPayouts.push(await watchArtifact(artifact));if(artifact.kind==='exit')exitScripts.add(artifact.script!);}
  await registerPayouts(restoredPayouts);
  taking=takeOver(true);await taking;
  for(const artifact of artifacts){
   if(artifact.state==='ended'&&artifact.kind==='send'&&artifact.quoteId){
    try{
     const release=await acquireSession(`${namespace}-${artifact.id}`);
     try{const repository=repositoryFor(`${namespace}-${artifact.id}`);try{await repairReceipt(artifact,repository);}finally{await repository[Symbol.asyncDispose]?.();}}
     finally{await release();}
    }catch{report(new Error('A saved Lightning receipt is unavailable; it remains unchanged.'));}
   }
  }
  if(legacyRecovery){
   const address=await wallet.getAddress();releaseLegacy=await acquireSession(`shielded-lightning-legacy-${address}`).catch(error=>{if(!(error instanceof LightningSessionBusy))report(error);return undefined;});
   if(releaseLegacy){
    legacyRepository=repositoryFor(`shielded-swaps-${address}`);
    const legacyView=new Proxy(wallet,{get(target,key){if(key==='send')return async()=>{throw new Error('Legacy Lightning funding is disabled');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
    legacy=clientFactory({...config,wallet:legacyView,repository:legacyRepository,policy:{drive:'manual'}});offLegacy=legacy.onUpdate(forward);await legacy.ready;await legacy.start();
   }
  }
  offPayout=(await companion.getContractManager()).onContractEvent(event=>{
   if(event.type!=='connection_reset'&&!payouts.has(event.contractScript))return;
   wallet.changed();if(event.type==='vtxo_received'||event.type==='connection_reset')void scan().catch(report);
  });
  const tick=async()=>{if(stopped)return;try{for(const session of [...sessions.values()]){if(session.artifact.state==='quoted'&&(session.artifact.expiresAt??0)*1000<=Date.now())await close(session);else if(session.needsFundingRetry)await startSession(session);}taking=takeOver(false);await taking;await scan();}catch(error){report(error);}finally{if(!stopped)timer=setTimeout(()=>void tick(),20_000);}};
  timer=setTimeout(()=>void tick(),20_000);
  return {resolve:input=>discovery.resolve(input),markets:()=>discovery.markets(),quote,accept,receive,exitPayout,registerPayouts,getActivityHistory,quoteRecovery,getRecovery:recovery.get,prepareRecovery:recovery.prepare,repairRecovery:recovery.repair,startRecovery:recovery.start,pauseRecovery:recovery.pause,
   onUpdate(listener){for(const update of updates.values())listener(update);listeners.add(listener);return()=>listeners.delete(listener);},[Symbol.asyncDispose]:dispose};
 }catch(error){await dispose();throw error;}
}
