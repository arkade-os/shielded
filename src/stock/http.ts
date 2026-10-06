import express from 'express';
import {resolve} from 'node:path';
import {createHash,timingSafeEqual} from 'node:crypto';
import type {StockCoordinator} from './coordinator.ts';
import type {StockArtifactManifest} from '../../packages/protocol/src/stock-proof-node.ts';
import type {StockProfile} from './sdk.ts';
import type {StockNetworkInfo} from './network.ts';

function exact(value:any,keys:string[]){if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw new Error('Unexpected stock request fields.');}
export function validateStockPrepared(value:any){
 exact(value,['id','operation','intentSignals','transitionSignals','oldState','newState','ciphertextRecords','boundary','proofTimes']);
 if(!/^[0-9a-f]{24}$/.test(value.id)||!['shield','transfer','withdraw','seal'].includes(value.operation))throw new Error('Invalid stock prepared identity.');
 for(const [array,length] of [[value.intentSignals,25],[value.transitionSignals,30]] as const)if(!Array.isArray(array)||array.length!==length||array.some((field:any)=>typeof field!=='string'||field.length>77||!/^(0|[1-9][0-9]*)$/.test(field)))throw new Error('Invalid stock public statement.');
 for(const state of [value.oldState,value.newState]){exact(state,['noteRoot','spentRoot','historyRoot','noteCount','historyCount','revision','reserves']);exact(state.reserves,['BTC','DEMO']);}
 exact(value.boundary,['deposit','withdrawal','destination']);exact(value.boundary.deposit,['BTC','DEMO']);exact(value.boundary.withdrawal,['BTC','DEMO']);exact(value.proofTimes,['intentMs','transitionMs']);
 if(!Array.isArray(value.ciphertextRecords)||value.ciphertextRecords.length>2)throw new Error('Invalid encrypted note records.');
 for(const record of value.ciphertextRecords){exact(record,['index','commitment','ciphertext','leaf','createdRevision']);if(!Array.isArray(record.ciphertext)||record.ciphertext.length!==7)throw new Error('Invalid encrypted note record.');}
}
function validateProof(value:any){
 exact(value,['version','profile','descriptorProfileId','operation','nativeBinding','statement','publicSignals','proof']);
 exact(value.proof,['pi_a','pi_b','pi_c','protocol','curve']);
 if(value.version!==1||value.profile!=='shielded-stock-btc-v1'||!/^[0-9a-f]{402}$/.test(value.nativeBinding)||!Array.isArray(value.publicSignals)||value.publicSignals.length!==1)throw new Error('Invalid stock combined proof envelope.');
}
function validateFunding(value:any){if(value!==undefined)exact(value,['txid','vout','value','sourceTxHex','tapTreeHex','leafHex']);}
export interface StockHttpOptions {profile:StockProfile;network:StockNetworkInfo;manifest:StockArtifactManifest;checkpointTapscript:string;artifactDirectory:string;webRoot:string;adminToken?:string}
export function createStockApp(coordinator:StockCoordinator,options:StockHttpOptions){
 const app=express();app.disable('x-powered-by');app.use(express.json({limit:'128kb',strict:true}));
 let writing=false;
 const exclusive=async<T>(action:()=>Promise<T>)=>{if(writing)throw Object.assign(new Error('A stock write is in flight. Retry after reading its result.'),{status:409});writing=true;try{return await action();}finally{writing=false;}};
 const profile=()=>{const status=coordinator.status(),archive=status.archive;return {
  version:1,profile:archive.protocol.profile,registration:{scheme:'schnorr-xonly-v1',network:'mutinynet',profile:coordinator.registrationProfile,minimumParticipants:1},participants:archive.participants,
  release:status.pin,programs:{version:options.profile.version,profile:options.profile.profile,domain:options.profile.domain,publicInputs:options.profile.publicInputs,icPacketHex:options.profile.icPacketHex,fixedKeyPacketHex:options.profile.fixedKeyPacketHex,icHashHex:options.profile.icHashHex,fixedKeyHashHex:options.profile.fixedKeyHashHex,combinedKeyHashHex:options.profile.combinedKeyHashHex,programsHashHex:options.profile.programsHashHex,programs:options.profile.programs},
  verifierKey:options.profile.verifierKey,provingManifest:options.manifest,network:options.network,checkpointTapscript:options.checkpointTapscript,genesis:coordinator.genesis(),
  phase:archive.phase,head:archive.head,ready:!status.blocked&&Object.keys(archive.participants).length>0,blockedReason:status.blocked?'An exact native outcome is pending read-only reconciliation.':Object.keys(archive.participants).length===0?'Register a client wallet first.':'',pending:status.pending,
  capacity:{noteRecords:256,remainingNoteRecords:256-archive.protocol.state.noteCount,nullifiers:511},proofSystem:'groth16-bn254',setup:options.manifest.setup.phase2,custody:'client spending, viewing, and native keys',verifier:'stock Arkade emulator opcodes',
  limitations:['Test network and bounded serial pool',...(options.manifest.setup.phase2==='development-only'?['Development phase2 keys require replacement through a new genesis after a public ceremony']:[]),'No independent note-holder pooled Bitcoin exit if the Arkade platform is unavailable'],
 };};
 app.get('/health',(_req,res)=>res.json({ok:true,ready:profile().ready,pending:coordinator.status().pending}));
 app.use('/api',(req,res,next)=>{if(req.method==='POST'&&req.get('origin')){let origin:string;try{origin=new URL(req.get('origin')!).host;}catch{res.status(403).json({error:'Invalid origin'});return;}if(origin!==req.get('host')){res.status(403).json({error:'Same-origin request required'});return;}}next();});
 app.get('/api/profile',(_req,res)=>res.json(profile()));app.get('/api/archive',(_req,res)=>res.json({archive:coordinator.archive()}));
 app.get('/api/proving/:name',(req,res)=>{
  const names:Record<string,string>={'stock-combined.wasm':'stock-combined_js/stock-combined.wasm','stock-combined.zkey':'stock-combined.zkey','stock-combined.vkey.json':'stock-combined.vkey.json'};
  const file=names[req.params.name];if(!file||!options.manifest.artifacts[req.params.name]){res.status(404).json({error:'Unknown pinned proving artifact'});return;}
  res.setHeader('ETag','"'+options.manifest.artifacts[req.params.name].sha256+'"');res.sendFile(file,{root:resolve(options.artifactDirectory)});
 });
 app.post('/api/participants/:owner',async(req,res)=>{exact(req.body,['owner','recipient','nativePublicKey','authorization']);exact(req.body.recipient,['owner','viewPublicKey']);exact(req.body.authorization,['version','network','profile','signature']);if(req.body.owner!==req.params.owner)throw new Error('Participant path differs from its signed identity.');await exclusive(()=>coordinator.register(req.body));res.json(profile());});
 app.post('/api/prepare',async(req,res)=>{exact(req.body,[]);if(!profile().ready)throw new Error(profile().blockedReason);await exclusive(()=>coordinator.prepare());res.json(profile());});
 app.post('/api/draft',(req,res)=>{exact(req.body,['prepared','externalFunding','externalProgram']);validateStockPrepared(req.body.prepared);validateFunding(req.body.externalFunding);res.json(coordinator.draft(req.body.prepared,req.body.externalFunding,req.body.externalProgram));});
 app.post('/api/settlements',async(req,res)=>{exact(req.body,['prepared','proof','externalFunding','signed']);validateStockPrepared(req.body.prepared);validateProof(req.body.proof);validateFunding(req.body.externalFunding);if(req.body.signed){exact(req.body.signed,['arkTx','checkpoints']);if(typeof req.body.signed.arkTx!=='string'||!Array.isArray(req.body.signed.checkpoints)||req.body.signed.checkpoints.length>2||req.body.signed.checkpoints.some((value:any)=>typeof value!=='string'))throw new Error('Invalid signed native request.');}res.json(await exclusive(()=>coordinator.submit(req.body.prepared,req.body.proof,req.body.externalFunding,req.body.signed)));});
 app.post('/api/seal',async(req,res)=>{exact(req.body,[]);if(!profile().ready)throw new Error(profile().blockedReason);res.json(await exclusive(()=>coordinator.seal()));});
 app.post('/api/reconcile',async(req,res)=>{exact(req.body,[]);res.json(await exclusive(()=>coordinator.reconcile()));});
 app.post('/api/abort',async(req,res)=>{
  exact(req.body,[]);const token=options.adminToken,supplied=req.get('authorization')?.replace(/^Bearer /,'')??'';
  if(!token||!timingSafeEqual(createHash('sha256').update(token).digest(),createHash('sha256').update(supplied).digest())){res.status(401).json({error:'Operator recovery token required'});return;}
  await exclusive(()=>coordinator.abort());res.json(profile());
 });
 app.get('/',(_req,res)=>res.redirect('/stock-wallet'));app.use(express.static(resolve(options.webRoot)));app.get(['/wallet','/stock-wallet'],(_req,res)=>res.sendFile('index.html',{root:resolve(options.webRoot)}));
 app.use((error:any,_req:express.Request,res:express.Response,_next:express.NextFunction)=>res.status(error.status??400).json({error:error.message??'Stock request rejected'}));return app;
}
