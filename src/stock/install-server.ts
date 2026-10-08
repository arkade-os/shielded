import {createHash,randomBytes} from 'node:crypto';
import {execFile,execFileSync} from 'node:child_process';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import express from 'express';
import {MnemonicIdentity,SingleKey,type Identity} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {EngineStore} from '../storage.ts';
import {loadStockInstallConfig,type StockInstallConfig} from './config.ts';
import {preflightStockMutinynet} from './network.ts';
import {createStockInstallation,type StockInstallationRecord,type StockSetupStatus,type StockQualificationProgress} from './install.ts';
import {createStockBootstrap,type StockProfileWeightEvidence} from './bootstrap.ts';
import {createStockBootstrapAdapter} from './bootstrap-adapter.ts';
import {stockJournalFingerprint} from './journal.ts';
import {loadStockProfile,type StockProgramManifest} from './sdk.ts';
import {openStockMutinynetService} from './server.ts';
import {loadStockProofArtifacts,type StockArtifactManifest} from '../../packages/protocol/src/stock-proof-node.ts';
import {createRollupRouter} from '../rollup/http.ts';
import {openRollupService,type RollupService} from '../rollup/service.ts';

const root=fileURLToPath(new URL('../..',import.meta.url));
const sha=(bytes:Uint8Array)=>createHash('sha256').update(bytes).digest('hex');
const files=['stock-combined.manifest.json','stock-combined.vkey.json','stock-combined.zkey','stock-combined_js/stock-combined.wasm'];
function openStore(directory:string,required=false){
 if(required&&(!existsSync(join(directory,'shielded.sqlite'))||!existsSync(join(directory,'.key'))))throw new Error('An accepted installation journal is missing; restore the complete volume backup.');
 if(existsSync(join(directory,'shielded.sqlite'))&&!existsSync(join(directory,'.key')))throw new Error('Persistent storage key is missing; restore the volume backup rather than initializing a new wallet.');
 return EngineStore.open(directory);
}
function identityFor(funding:StockInstallationRecord['funding']):Identity {
 return funding.kind==='mnemonic'?MnemonicIdentity.fromMnemonic(funding.secret,{isMainnet:false}):SingleKey.fromHex(funding.secret);
}
export async function openStockInstallation(config:StockInstallConfig,activate:(app:express.Express)=>void,options:{bundledArtifacts?:string;webRoot?:string;signal?:AbortSignal}={}){
 const data=resolve(config.network.dataDirectory),metadataDirectory=join(data,'installation'),artifactDirectory=join(data,'artifacts');
 mkdirSync(data,{recursive:true,mode:0o700});
 if(existsSync(join(data,'shielded.sqlite'))||existsSync(join(data,'.key')))throw new Error('This volume belongs to a previous service. A fresh installation requires its own volume.');
 const store=openStore(metadataDirectory);let service:Awaited<ReturnType<typeof openStockMutinynetService>>|undefined;
 try{
  let record=store.load<StockInstallationRecord>();
  if(record){
   if(record.version!==1||stockJournalFingerprint(record.network)!==stockJournalFingerprint(config.network)||!record.funding||!record.manifest||!record.programs)throw new Error('Saved installation configuration differs from these network settings; restore the original environment.');
   const identity=identityFor(record.funding);
   if(hex.encode(await identity.xOnlyPublicKey())!==record.funding.publicKey)throw new Error('Saved bootstrap wallet identity failed integrity validation.');
   if(config.secrets.bootstrapMnemonic&&hex.encode(await MnemonicIdentity.fromMnemonic(config.secrets.bootstrapMnemonic,{isMainnet:false}).xOnlyPublicKey())!==record.funding.publicKey)throw new Error('Configured bootstrap mnemonic differs from the persisted wallet; refusing replacement.');
  }else{
   if(readdirSync(data).some(name=>name!=='installation'))throw new Error('Installation metadata is missing from a populated volume; restore its complete backup.');
   const source=resolve(options.bundledArtifacts??join(root,'stock-artifacts'));
   const manifest=JSON.parse(readFileSync(join(source,files[0]!),'utf8')) as StockArtifactManifest;
   if(manifest.setup.phase2==='development-only'&&!config.allowDevelopmentSetup)throw new Error('This Mutinynet image requires SHIELDED_ALLOW_DEV_SETUP=true.');
   await loadStockProofArtifacts(source,manifest);
   const funding:StockInstallationRecord['funding']={kind:config.secrets.bootstrapMnemonic?'mnemonic':'single-key',secret:config.secrets.bootstrapMnemonic??randomBytes(32).toString('hex'),publicKey:''};
   funding.publicKey=hex.encode(await identityFor(funding).xOnlyPublicKey());
   const programs=JSON.parse(execFileSync(join(root,'bin',process.platform==='win32'?'shielded-vm.exe':'shielded-vm'),['--stock-build',join(source,'stock-combined.vkey.json')],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024})) as StockProgramManifest;
   record={version:1,network:structuredClone(config.network),funding,manifest,programs};store.save(record);
  }
  if(record.manifest.setup.phase2==='development-only'&&!config.allowDevelopmentSetup)throw new Error('The persisted test pool requires SHIELDED_ALLOW_DEV_SETUP=true.');
  const source=resolve(options.bundledArtifacts??join(root,'stock-artifacts'));
  for(const relative of files){
   const target=join(artifactDirectory,relative);
   if(existsSync(target)){if(!lstatSync(target).isFile()||lstatSync(target).isSymbolicLink())throw new Error('Persisted proving artifact is not a regular file.');continue;}
   if(record.initialized||record.outpoint)throw new Error('A pinned proving artifact is missing after bootstrap selection; restore the complete volume.');
   const sourceManifest=JSON.parse(readFileSync(join(source,files[0]!),'utf8'));
   if(stockJournalFingerprint(sourceManifest)!==stockJournalFingerprint(record.manifest))throw new Error('An interrupted installation requires the original image artifacts; refusing to replace its verifier.');
   mkdirSync(resolve(target,'..'),{recursive:true,mode:0o700});writeFileSync(target,readFileSync(join(source,relative)),{flag:'wx',mode:0o600});
  }
  if(stockJournalFingerprint(JSON.parse(readFileSync(join(artifactDirectory,files[0]!),'utf8')))!==stockJournalFingerprint(record.manifest))throw new Error('Persisted proving manifest changed.');
  const loaded=await loadStockProofArtifacts(artifactDirectory,record.manifest);
  const rebuilt=JSON.parse(execFileSync(join(root,'bin',process.platform==='win32'?'shielded-vm.exe':'shielded-vm'),['--stock-build',join(artifactDirectory,'stock-combined.vkey.json')],{encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024})) as StockProgramManifest;
  if(stockJournalFingerprint(rebuilt)!==stockJournalFingerprint(record.programs))throw new Error('This image changes the funded verifier program; use the original image or a new pool.');
  const identity=identityFor(record.funding),poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toString(poseidon(values)));
  const controller=createStockInstallation({store,record,
   openContext:async(saved)=>{
    const network=await preflightStockMutinynet({...config.network,...(saved.pin?{expected:{serverKey:saved.pin.serverKey,emulatorKey:saved.pin.emulatorKey}}:{})});
    const adapter=await createStockBootstrapAdapter(network,identity),profile=loadStockProfile(saved.programs,loaded.verifierKey,loaded.descriptor.profileId,network,saved.programs.programsHashHex);
    const pin={version:1 as const,network:'mutinynet' as const,networkInfo:network,descriptorProfileId:loaded.descriptor.profileId,programsHash:saved.programs.programsHashHex,artifactsHash:stockJournalFingerprint(saved.manifest),checkpointHash:sha(hex.decode(adapter.checkpointTapscript)),serverKey:network.serverKey,emulatorKey:network.emulatorKey,policyVersion:1 as const,developmentOnly:saved.manifest.setup.phase2==='development-only'};
    const bootstrapStore=openStore(join(data,'bootstrap'),!!saved.releaseFingerprint);
    return {pin,fundingAddress:adapter.ark.address,coins:adapter.ark.coins.map(coin=>coin.funding),close:()=>bootstrapStore.close(),makeBootstrap:(weightEvidence,expectedReleaseFingerprint)=>createStockBootstrap({store:bootstrapStore,pin,expectedReleaseFingerprint,proving:saved.manifest,checkpointTapscript:adapter.checkpointTapscript,weightEvidence,profile,programs:saved.programs,backend:loaded.backend,identity,ownerKey:adapter.ownerKey,input:adapter.input,changeScript:adapter.changeScript,checkpoint:adapter.checkpoint,hash,submit:adapter.submit,lookup:adapter.lookup,finalize:adapter.finalize,indexed:adapter.indexed,releaseRoot:join(data,'releases'),artifactFiles:Object.fromEntries(files.map(name=>[name,join(artifactDirectory,name)]))})};
   },
   qualify:async(pin,onProgress)=>{
    const startedAt=new Date().toISOString(),progress=(stage:StockQualificationProgress['stage'],completed:number)=>onProgress?.({stage,completed,total:9,startedAt,updatedAt:new Date().toISOString()});
    const path=join(data,'stock-profile-qualification.json');
    if(existsSync(path)){
     const evidence=JSON.parse(readFileSync(path,'utf8')) as StockProfileWeightEvidence;
     if(evidence.artifactsHash===pin.artifactsHash&&evidence.programsHash===pin.programsHash&&evidence.serverKey===pin.serverKey&&evidence.emulatorKey===pin.emulatorKey&&evidence.checkpointHash===pin.checkpointHash&&evidence.targetWeightLimit===pin.networkInfo.weightLimit&&stockJournalFingerprint(evidence.exitDelay)===stockJournalFingerprint(pin.networkInfo.exitDelay)){progress('cached',9);return evidence;}
    }
    const env:NodeJS.ProcessEnv={...process.env,SHIELDED_NETWORK:config.network.name,SHIELDED_ARK_URL:config.network.arkUrl,SHIELDED_EMULATOR_URL:config.network.emulatorUrl,SHIELDED_INDEXER_URL:config.network.indexerUrl,SHIELDED_DATA_DIR:data,SHIELDED_STOCK_ARTIFACTS:artifactDirectory};delete env.SHIELDED_BOOTSTRAP_MNEMONIC;
    progress('preparing',0);
    await new Promise<void>((resolve,reject)=>{
     let buffer='',completed=0;
     const child=execFile(process.execPath,['--experimental-eventsource','--import','tsx',join(root,'tools/stock-profile-gate.ts'),'--installation'],{cwd:root,env,signal:options.signal,timeout:30*60*1000,maxBuffer:4*1024*1024,windowsHide:true},error=>error?reject(error):resolve());
     child.stdout?.on('data',(chunk:string)=>{
      buffer+=chunk;const lines=buffer.split(/\r?\n/);buffer=lines.pop()!.slice(-4096);
      for(const line of lines){
       if(!line.startsWith('STOCK_INSTALL_PROGRESS='))continue;
       try{const item=JSON.parse(line.slice('STOCK_INSTALL_PROGRESS='.length));if(item.stage==='native-paths'&&item.total===9&&Number.isInteger(item.completed)&&item.completed>completed&&item.completed<=9){completed=item.completed;progress('native-paths',completed);}}catch{}
      }
     });
    });
    return JSON.parse(readFileSync(path,'utf8')) as StockProfileWeightEvidence;
   },
   activate:async(saved)=>{
    if(service)return;
    if(saved.serviceInitialized){const persisted=openStore(join(data,'coordinator'),true);persisted.close();}
    if(!saved.releaseFingerprint||!/^[0-9a-f]{64}$/.test(saved.releaseFingerprint))throw new Error('Installation has no authenticated pool fingerprint.');
    const directory=join(data,'releases',saved.releaseFingerprint),deployment=JSON.parse(readFileSync(join(directory,'deployment.json'),'utf8'));
    if(stockJournalFingerprint(deployment.pin)!==saved.releaseFingerprint)throw new Error('Persisted deployment differs from the accepted bootstrap fingerprint.');
    service=await openStockMutinynetService({deploymentFile:join(directory,'deployment.json'),artifactDirectory:directory,dataDirectory:join(data,'coordinator'),webRoot:options.webRoot??join(root,'app/dist'),allowDevelopmentSetup:config.allowDevelopmentSetup,endpoints:config.network});activate(service.app);
   },
  });
  return {controller,close:()=>{service?.coordinator.close();store.close();}};
 }catch(error){store.close();throw error;}
}
// Swarm's start-first update keeps the old task until this one is healthy, so wait for its lock instead of failing.
export async function openWhenUnlocked<T>(open:()=>Promise<T>,signal:AbortSignal,onWait:()=>void,delay=2000):Promise<T>{
 for(;;){
  try{return await open();}
  catch(error){
   if(signal.aborted||!(error instanceof Error&&error.cause instanceof Error&&/database is locked/i.test(error.cause.message)))throw error;
   onWait();await new Promise(resolve=>setTimeout(resolve,delay));
  }
 }
}
export function createStockInstallApp(status:()=>StockSetupStatus,webRoot:string,rollup?:express.Router){
 const app=express();app.disable('x-powered-by');let service:express.Express|undefined;
 app.get('/api/setup',(_req,res)=>{res.setHeader('Cache-Control','no-store');res.json(status());});
 if(rollup){app.use('/api/rollup',rollup);app.get('/rollup',(_req,res)=>res.sendFile(join(webRoot,'index.html')));}
 app.get('/health',(_req,res)=>{const phase=status().phase;res.status(phase==='blocked'?503:200).json({ok:phase!=='blocked',ready:phase==='ready',phase});});
 app.get('/readyz',(_req,res)=>res.status(status().phase==='ready'?200:503).json({ready:status().phase==='ready'}));
 app.get('/',(_req,res)=>res.sendFile(join(webRoot,'index.html')));app.get('/lab',(_req,res)=>res.sendFile(join(webRoot,'index.html')));app.get('/wallet',(_req,res)=>res.redirect('/stock-wallet'));app.get('/stock-wallet',(_req,res)=>res.sendFile(join(webRoot,'index.html')));
 app.use((req,res,next)=>{if(service&&status().phase==='ready')return service(req,res,next);if(req.path.startsWith('/api/')){res.status(503).json({error:'The pool is being initialized. Read /api/setup for funding and recovery status.'});return;}next();});
 app.use(express.static(webRoot));
 return {app,activate:(value:express.Express)=>{service=value;}};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--help')){console.log('Shielded Mutinynet fresh install: set SHIELDED_NETWORK, SHIELDED_ARK_URL, SHIELDED_EMULATOR_URL and SHIELDED_ALLOW_DEV_SETUP=true. Optional SHIELDED_BOOTSTRAP_MNEMONIC funds only the 330-sat carrier. Persist /data; use /stock-wallet and /api/setup. Customer keys remain on clients.');process.exit(0);}
 const config=loadStockInstallConfig(),port=Number(process.env.PORT??8792);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid installation HTTP port.');
 let initial:StockSetupStatus={version:1,phase:'starting',network:'mutinynet',minimumFundingSats:660,message:'Initializing the persistent test pool.'};
 const shutdown=new AbortController();
 let installation:Awaited<ReturnType<typeof openStockInstallation>>|undefined,stopping=false,timer:ReturnType<typeof setTimeout>|undefined,active:Promise<void>|undefined;
 let rollup:RollupService|undefined,rollupTimer:ReturnType<typeof setTimeout>|undefined;
 const http=createStockInstallApp(()=>installation?.controller.status()??initial,join(root,'app/dist'),createRollupRouter(()=>rollup));
 const listener=http.app.listen(port,process.env.HOST??'0.0.0.0',()=>console.log('Shielded setup and wallet listening on port '+port+'. Customer keys remain client-side.'));
 const logError=(error:unknown)=>{const reasons:string[]=[];let current=error;for(let depth=0;depth<4&&current instanceof Error;depth++){reasons.push(current.message);current=current.cause;}let message=reasons.join(': ')||'Setup failed safely.';if(config.secrets.bootstrapMnemonic)message=message.replaceAll(config.secrets.bootstrapMnemonic,'[redacted]');console.error(message.replace(/\b[0-9a-f]{64}\b/gi,'[redacted 32-byte value]'));};
 const tick=()=>{active=(async()=>{try{await installation!.controller.step();}catch(error){logError(error);}if(!stopping&&installation!.controller.status().phase!=='ready')timer=setTimeout(tick,10000);})();};
 // v2 lives beside v1 under its own directory and opens only after v1 has claimed the volume.
 const startRollup=async()=>{
  try{
   const binary=join(root,'bin',process.platform==='win32'?'shielded-vm.exe':'shielded-vm'),rapidsnark=join(root,'bin','rapidsnark');
   rollup=await openRollupService({directory:join(resolve(config.network.dataDirectory),'rollup'),circuits:resolve(process.env.SHIELDED_ROLLUP_CIRCUITS??join(root,'rollup-circuits')),setupTool:join(root,'tools','rollup-setup.mjs'),
    ...(process.env.SHIELDED_ROLLUP_KEYS?{bundled:resolve(process.env.SHIELDED_ROLLUP_KEYS)}:{}),vmBinary:binary,...(existsSync(rapidsnark)?{rapidsnark}:{}),
    endpoints:{arkUrl:config.network.arkUrl,emulatorUrl:config.network.emulatorUrl,...(config.network.indexerUrl?{indexerUrl:config.network.indexerUrl}:{})}});
   const step=async()=>{await rollup!.step();if(!stopping&&!rollup!.ready())rollupTimer=setTimeout(step,15000);};void step();
  }catch(error){logError(error);}
 };
 const stop=async()=>{if(stopping)return;stopping=true;shutdown.abort();if(timer)clearTimeout(timer);if(rollupTimer)clearTimeout(rollupTimer);rollup?.close();listener.close();await active;installation?.close();await (globalThis as any).curve_bn128?.terminate();process.exit(0);};process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
 const waiting='Waiting for the previous instance to release the data volume.';
 try{installation=await openWhenUnlocked(()=>openStockInstallation(config,http.activate,{signal:shutdown.signal}),shutdown.signal,()=>{if(initial.message!==waiting){initial={...initial,message:waiting};console.log(waiting);}});if(!stopping){tick();if(process.env.SHIELDED_ROLLUP!=='off')void startRollup();}else installation.close();}catch(error){initial={...initial,phase:'blocked',message:'Installation stopped safely. Check the server logs and preserve the data volume.'};logError(error);}
}