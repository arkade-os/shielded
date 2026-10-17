import {ArkAddress,DefaultVtxo,DescriptorIdentity,IndexedDBContractRepository,IndexedDBWalletRepository,MnemonicIdentity,TxType,Wallet,deriveDescriptorLeafPubKey,identityDescriptor,parseHDDescriptor,sequenceToTimelock,timelockToSequence,type Activity,type IWallet,type Identity,type SendParams,type WalletConfig} from '@arkade-os/sdk';
import {IndexedDbAssetSwapRepository,createSwapClient,type AssetSwapRepository,type Quote,type ReceiveOptions,type ReceiveRequest,type SwapClient,type SwapClientConfig,type SwapRailClient,type SwapUpdate} from '@arkade-os/swap';
import {hex} from '@scure/base';
import {recoveryPhraseOf} from '../../packages/protocol/src/wallet-keys.ts';
import {BTC_ASSET} from '../../packages/protocol/src/rollup/constants.ts';
import {DUST} from './pool.ts';
import type {LightningArtifact,LightningPayout,LightningRepository} from './lightning-repository.ts';
import type {ShieldedWallet} from './wallet.ts';

export interface PrivateLightningService extends SwapRailClient,Pick<SwapClient,'markets'|'receive'>,AsyncDisposable {
 registerPayouts(records:LightningPayout[]):Promise<void>;
 getActivityHistory():Promise<Activity[]>;
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
  getBalance:async()=>({available:available(),availableAssets:[],assets:[],total:0,settled:0,preconfirmed:0,gated:0,intentLocked:0,recoverable:0,pendingRecovery:0,unrolled:0,boarding:{confirmed:0,unconfirmed:0,total:0}}),send};
 return new Proxy(companion,{get(target,key){if(key in overrides)return overrides[key];const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}}) as IWallet&Pick<Wallet,'signerForDescriptor'>;
}
const terminal=new Set(['paid','claimed','refunded','lapsed','failed','cancelled','filled']);
const artifactEnded=(artifact:LightningArtifact)=>artifact.state==='ended';
const biggestNote=(wallet:ShieldedWallet)=>Number(wallet.shieldedNotes(BTC_ASSET).filter(n=>!wallet.inFlight.has(n.nullifier)).reduce((max,n)=>n.amount>max?n.amount:max,0n));
export async function acquireLightningSession(name:string):Promise<()=>Promise<void>>{
 if(typeof navigator==='undefined'||!navigator.locks)throw new Error('Private Lightning requires browser locking to protect active payments');
 let release!:()=>void,done!:Promise<void>;
 const held=new Promise<void>(resolve=>{release=resolve;});
 await new Promise<void>((resolve,reject)=>{
  done=navigator.locks.request(name,{ifAvailable:true},async lock=>{if(!lock){reject(new Error('This Lightning payment is active in another tab'));return;}resolve();await held;});
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
 const {wallet,companion,journal,repositoryFor=name=>new IndexedDbAssetSwapRepository(name),clientFactory=createSwapClient,acquireSession=acquireLightningSession,legacyRecovery=true,onError,...config}=options;
 const owner=await lightningOwner(companion),pool=wallet.pool.status.pool!.token,namespace=`shielded-lightning-${owner}-${pool}`;
 const sessions=new Map<string,Session>(),listeners=new Set<(update:SwapUpdate)=>void>(),updates=new Map<string,SwapUpdate>();
 const operations=new AbortController();
 const payouts=new Map<string,LightningPayout>(),shielding=new Map<string,Promise<void>>();
 let stopped=false,timer:ReturnType<typeof setTimeout>|undefined,legacy:SwapClient|undefined,legacyRepository:AssetSwapRepository|undefined,releaseLegacy:(()=>Promise<void>)|undefined,offLegacy:(()=>void)|undefined;
 const discoveryRepository=repositoryFor(`${namespace}-markets`),discovery=clientFactory({...config,wallet:companion,repository:discoveryRepository,policy:{drive:'readonly'}});
 const forward=(update:SwapUpdate)=>{updates.set(update.swap.id,update);for(const listener of listeners)try{listener(update);}catch{}};
 const report=(error:unknown)=>{try{onError?.(error instanceof Error?error:new Error(String(error)));}catch{}};
 const assertOpen=()=>{if(stopped)throw new Error('Private Lightning service is closed');};
 const getActivityHistory=async():Promise<Activity[]>=>{
  assertOpen();if(!payouts.size)return [];
  const manager=await companion.getContractManager(),[contracts,spends,artifacts]=await Promise.all([manager.getContractsWithVtxos(undefined,undefined,{unspentOnly:false}),journal.list(String(wallet.self.owner),pool),journal.artifacts(owner,pool)]);
  const rows=new Map<string,Activity>();
  for(const {contract,vtxos} of contracts){
   if(!payouts.has(contract.script))continue;
   for(const coin of vtxos){
    if(coin.script!==contract.script)continue;
    const outpoint=`${coin.txid}:${coin.vout}`,attempts=spends.filter(record=>record.kind==='shield'&&record.reference===outpoint);
    const outcome=attempts.some(r=>r.state==='included')?'shielded':coin.value<DUST?'below-minimum':attempts.some(r=>r.state==='prepared')||shielding.has(outpoint)?'shielding':attempts.length?'retrying':'received';
    const id=`shielded-lightning:receive:${outpoint}`,createdAt=coin.createdAt.getTime(),settled=!coin.isPreconfirmed;
    rows.set(id,{id,amount:coin.value,createdAt,settled,intent:{kind:'lightning-receive',label:artifacts.some(a=>a.kind==='send'&&a.script===contract.script)?'Lightning refund':'Received via Lightning',outcome,metadata:{outpoint}},
     txs:[{key:{boardingTxid:'',commitmentTxid:'',arkTxid:coin.txid},type:TxType.TxReceived,amount:coin.value,createdAt,settled}]});
   }
  }
  return [...rows.values()].sort((a,b)=>b.createdAt-a.createdAt);
 };
 const close=(session:Session)=>session.closing??=(async()=>{await session.funding?.catch(()=>{});session.off();await session.client[Symbol.asyncDispose]();await session.repository[Symbol.asyncDispose]?.();await session.release();sessions.delete(session.artifact.id);})();
 const bind=(session:Session)=>{session.off=session.client.onUpdate(update=>{
  forward(update);if(!terminal.has(update.outcome)||session.artifact.state!=='accepted')return;
  session.retiring=(async()=>{
   if(session.artifact.kind==='send'){
    const funding=await journal.get(String(wallet.self.owner),pool,`lightning-fund-${session.artifact.index}`);
    if(funding?.state==='prepared')return;
    if(funding?.state==='included'&&!['paid','refunded'].includes(update.outcome)){report(new Error('Lightning funding is confirmed and still needs HTLC recovery.'));return;}
   }
   session.artifact.state='ended';await journal.updateArtifact(owner,pool,session.artifact);if(session.initialized&&!session.accepting&&!session.funding)await close(session);await scan();
  })();void session.retiring.catch(report);
 });};
 const scan=async()=>{
  if(stopped||!payouts.size)return;
  for(const coin of await companion.getVtxos({withRecoverable:false})){
   const payout=payouts.get(coin.script),outpoint=`${coin.txid}:${coin.vout}`;
   if(!payout||coin.assets?.length||shielding.has(outpoint))continue;
   if(coin.value<DUST){report(new Error(`This individual Lightning payout is below the pool minimum of ${DUST} sats and cannot be shielded alone.`));continue;}
   const task=(async()=>{const release=await acquireSession(`${namespace}-shield-${outpoint}`);try{
    const attempts=(await journal.list(String(wallet.self.owner),pool)).filter(record=>record.kind==='shield'&&record.reference===outpoint),existing=attempts.find(record=>record.state!=='dropped'),baseId=`lightning-shield-${outpoint}`;
    let id=existing?.id??baseId;
    if(!existing&&attempts.length){let suffix=attempts.length;do{id=`${baseId}-${suffix++}`;}while(attempts.some(record=>record.id===id));}
    const handle=await wallet.shieldLightning(coin,lightningSigner(companion,payout.descriptor),journal,{id,reference:outpoint,signal:operations.signal});await handle.settled();
   }finally{await release();}})();
   shielding.set(outpoint,task);wallet.changed();void task.catch(report).finally(()=>{shielding.delete(outpoint);wallet.changed();});
  }
 };
 const registerPayouts=async(records:LightningPayout[])=>{
  assertOpen();const manager=await companion.getContractManager(),contracts=await manager.getContracts();
  for(const record of records){
   const contract=contracts.find(c=>c.script===record.script),pubKey=deriveDescriptorLeafPubKey(record.descriptor);
   lightningSigner(companion,record.descriptor);
   if(!contract||contract.type!=='default'||contract.address!==record.address||contract.metadata?.signingDescriptor!==record.descriptor||contract.params.pubKey!==hex.encode(pubKey))throw new Error('Lightning payout contract does not match its recoverable descriptor');
   const script=new DefaultVtxo.Script({pubKey,serverPubKey:hex.decode(String(contract.params.serverPubKey)),csvTimelock:sequenceToTimelock(Number(contract.params.csvTimelock))});
   if(hex.encode(script.pkScript)!==record.script||hex.encode(ArkAddress.decode(record.address).pkScript)!==record.script)throw new Error('Lightning payout script does not match its contract');
  }
  await journal.savePayouts(owner,pool,records);
  for(const record of records){payouts.set(record.script,record);await manager.setContractWatchState(record.script,'watched');}
  wallet.changed();
  await scan();
 };
 const watchArtifact=async(artifact:LightningArtifact)=>{
  if(!artifact.descriptor||!artifact.address||!artifact.script||!artifact.serverPubKey||!artifact.csvTimelock)throw new Error('Incomplete saved Lightning artifact');
  const pubKey=deriveDescriptorLeafPubKey(artifact.descriptor),manager=await companion.getContractManager();
  await manager.createContract({type:'default',script:artifact.script,address:artifact.address,watch:'watched',
   params:{pubKey:hex.encode(pubKey),serverPubKey:artifact.serverPubKey,csvTimelock:artifact.csvTimelock},metadata:{signingDescriptor:artifact.descriptor}});
  return {id:artifact.id,descriptor:artifact.descriptor,address:artifact.address,script:artifact.script};
 };
 const open=async(artifact:LightningArtifact):Promise<Session>=>{
  const release=await acquireSession(`${namespace}-${artifact.id}`),repository=repositoryFor(`${namespace}-${artifact.id}`);
  let client:SwapClient|undefined;
  try{
   const view=await artifactWallet(companion,artifact,async params=>{
    const keys=Object.keys(params),payment=params as unknown as {address:string;amount:number};
    if(keys.some(key=>!['address','amount'].includes(key))||typeof payment.address!=='string'||!Number.isSafeInteger(payment.amount)||payment.amount<=0||!artifact.quoteId||!Number.isSafeInteger(artifact.expiresAt)||artifact.expiresAt!<=0)throw new Error('Private Lightning can fund only its verified HTLC');
    const record=await repository.getSwapRecord(artifact.quoteId);
    if(!record||record.family!=='rfq'||record.kind!=='lightning_send'||record.route.give.corridor!=='arkade'||record.route.take.corridor!=='lightning'||record.lockupAddress!==payment.address||record.give.amount!==String(payment.amount)||record.expiresAt!==artifact.expiresAt||!record.route.give.asset.endsWith('/slip44:0')||hex.encode(ArkAddress.decode(payment.address).pkScript)!==record.lockupPkScript||!/^[0-9a-f]{64}$/.test(record.lock.hash))throw new Error('Private Lightning funding does not match its stored HTLC');
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
  assertOpen();await wallet.restoreLightningSpends(journal);const resolution=await discovery.resolve(input),send=resolution.give.corridor==='arkade'&&resolution.take.corridor==='lightning',receive=resolution.give.corridor==='lightning'&&resolution.take.corridor==='arkade';
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
  try{const swap=await session.client.accept(quoted);if(!artifactEnded(artifact))await session.client.start();return swap;}
  catch(error){
   const stored=await session.repository.getSwapRecord(quoted.id);await close(session);
   if(stored&&!artifactEnded(artifact)){const resumed=await open(artifact);await startSession(resumed);}
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
 let offPayout:()=>void=()=>{};
 const dispose=async()=>{if(stopped)return;stopped=true;operations.abort();if(timer)clearTimeout(timer);offPayout();offLegacy?.();await Promise.allSettled([...sessions.values()].map(close));await legacy?.[Symbol.asyncDispose]();await legacyRepository?.[Symbol.asyncDispose]?.();await releaseLegacy?.();await discovery[Symbol.asyncDispose]();await discoveryRepository[Symbol.asyncDispose]?.();await Promise.allSettled([...shielding.values()]);listeners.clear();};
 try{
  const artifacts=await journal.artifacts(owner,pool),restoredPayouts=await journal.payouts(owner,pool);
  for(const artifact of artifacts)if(artifact.descriptor)restoredPayouts.push(await watchArtifact(artifact));
  await registerPayouts(restoredPayouts);
  for(const artifact of artifacts){
   if(artifact.state==='accepted'){const session=await open(artifact);await startSession(session);}
  }
  if(legacyRecovery){
   const address=await wallet.getAddress();releaseLegacy=await acquireSession(`shielded-lightning-legacy-${address}`);legacyRepository=repositoryFor(`shielded-swaps-${address}`);
   const legacyView=new Proxy(wallet,{get(target,key){if(key==='send')return async()=>{throw new Error('Legacy Lightning funding is disabled');};const value=Reflect.get(target,key,target);return typeof value==='function'?value.bind(target):value;}});
   legacy=clientFactory({...config,wallet:legacyView,repository:legacyRepository,policy:{drive:'manual'}});offLegacy=legacy.onUpdate(forward);await legacy.ready;await legacy.start();
  }
  offPayout=(await companion.getContractManager()).onContractEvent(event=>{
   if(event.type!=='connection_reset'&&!payouts.has(event.contractScript))return;
   wallet.changed();if(event.type==='vtxo_received'||event.type==='connection_reset')void scan().catch(report);
  });
  const tick=async()=>{if(stopped)return;try{for(const session of [...sessions.values()]){if(session.artifact.state==='quoted'&&(session.artifact.expiresAt??0)*1000<=Date.now())await close(session);else if(session.needsFundingRetry)await startSession(session);}await scan();}catch(error){report(error);}finally{if(!stopped)timer=setTimeout(()=>void tick(),20_000);}};
  timer=setTimeout(()=>void tick(),20_000);
  return {resolve:input=>discovery.resolve(input),markets:()=>discovery.markets(),quote,accept,receive,registerPayouts,getActivityHistory,
   onUpdate(listener){for(const update of updates.values())listener(update);listeners.add(listener);return()=>listeners.delete(listener);},[Symbol.asyncDispose]:dispose};
 }catch(error){await dispose();throw error;}
}
