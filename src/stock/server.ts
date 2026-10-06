import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {RestArkProvider,RestIndexerProvider,Transaction} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {buildPoseidon} from 'circomlibjs';
import {loadStockProofArtifacts,type StockArtifactManifest} from '../../packages/protocol/src/stock-proof-node.ts';
import {createStockCoordinator,type StockPublicArchive} from './coordinator.ts';
import {createStockApp} from './http.ts';
import {stockJournalFingerprint,type StockReleasePin} from './journal.ts';
import {preflightStockMutinynet,type StockNetworkEndpoints} from './network.ts';
import {loadStockProfile,type StockProgramManifest} from './sdk.ts';
import {createStockMutinynetTransport} from './transport.ts';
import {decodeStockIndexerTransaction} from './indexer.ts';
import {validateStockCheckpoint} from './checkpoint.ts';

export interface StockDeployment {
 version:1;
 pin:StockReleasePin;
 programs:StockProgramManifest;
 proving:StockArtifactManifest;
 checkpointTapscript:string;
 genesis:StockPublicArchive;
}
export async function openStockMutinynetService(options:{deploymentFile:string;artifactDirectory:string;dataDirectory:string;webRoot:string;allowDevelopmentSetup?:boolean;adminToken?:string;endpoints?:StockNetworkEndpoints}){
 const deployment=JSON.parse(await readFile(options.deploymentFile,'utf8')) as StockDeployment;
 if(deployment.version!==1||deployment.pin.network!=='mutinynet'||deployment.pin.artifactsHash!==stockJournalFingerprint(deployment.proving))throw new Error('Stock deployment has an invalid network or artifact release pin.');
 if(deployment.proving.setup.phase2==='development-only'&&!options.allowDevelopmentSetup)throw new Error('Development Groth16 keys require explicit SHIELDED_STOCK_ALLOW_DEV_SETUP=true on this test network.');
 const loaded=await loadStockProofArtifacts(options.artifactDirectory,deployment.proving);
 const network=await preflightStockMutinynet({...options.endpoints,expected:{serverKey:deployment.pin.serverKey,emulatorKey:deployment.pin.emulatorKey}});
 const provider=new RestArkProvider(network.arkUrl),indexer=new RestIndexerProvider(network.indexerUrl??network.arkUrl),info=await provider.getInfo();
 const noFee=(value:unknown)=>typeof value==='string'&&/^0(?:\.0+)?$/.test(value);
 if(!info.fees||!noFee(info.fees.txFeeRate)||Object.values(info.fees.intentFee??{}).length!==4||!Object.values(info.fees.intentFee).every(noFee))throw new Error('The first stock profile requires zero offchain operator fees; a fee-aware profile needs a separate genesis.');
 if(info.checkpointTapscript!==deployment.checkpointTapscript||createHash('sha256').update(hex.decode(info.checkpointTapscript)).digest('hex')!==deployment.pin.checkpointHash)throw new Error('Public Arkade checkpoint policy changed; migration is required.');
 validateStockCheckpoint(info.checkpointTapscript,info.forfeitPubkey);
 const profile=loadStockProfile(deployment.programs,loaded.verifierKey,deployment.pin.descriptorProfileId,network,deployment.pin.programsHash);
 const genesis=deployment.genesis.head,raw=(await indexer.getVirtualTxs([genesis.txid])).txs.map(decodeStockIndexerTransaction).find(tx=>tx.id===genesis.txid);
 if(!raw||hex.encode(raw.unsignedTx)!==hex.encode(Transaction.fromRaw(hex.decode(genesis.sourceTxHex)).unsignedTx))throw new Error('Fresh stock genesis is not authenticated by the public Mutinynet indexer.');
 const poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toString(poseidon(values)));
 const beforeSubmit=async(request:{checkpoints:string[]})=>{
  const checkpoints=request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded))),inputs=checkpoints.map(tx=>tx.getInput(0));
  const {vtxos}=await indexer.getVtxos({outpoints:inputs.map(input=>({txid:hex.encode(input.txid!),vout:input.index!}))});
  if(inputs.some(input=>!vtxos.some(coin=>coin.txid===hex.encode(input.txid!)&&coin.vout===input.index&&!coin.isSpent&&!coin.isUnrolled&&!coin.isSwept&&coin.expiresAt instanceof Date&&coin.expiresAt.getTime()>Date.now()&&coin.value===Number(input.witnessUtxo!.amount)&&coin.script===hex.encode(input.witnessUtxo!.script))))throw new Error('Exact stock input is absent, spent, unrolled, expired, or changed; no transaction was submitted.');
 };
 const coordinator=await createStockCoordinator({directory:options.dataDirectory,pin:deployment.pin,profile,network,checkpointTapscript:deployment.checkpointTapscript,initialArchive:deployment.genesis,backend:loaded.backend,hash,beforeSubmit,transport:createStockMutinynetTransport(network,{indexer})});
 try{
  const status=coordinator.status(),head=status.archive.head,coins=(await indexer.getVtxos({outpoints:[{txid:head.txid,vout:head.vout}]})).vtxos;
  const coin=coins.find(value=>value.txid===head.txid&&value.vout===head.vout);
  if(!coin||coin.value!==head.value||coin.script!==hex.encode(profile.vtxo.pkScript)||!status.pending&&(coin.isSpent||coin.isUnrolled||coin.isSwept||!(coin.expiresAt instanceof Date)||coin.expiresAt.getTime()<=Date.now()))throw new Error('Saved stock head is absent, altered, expired, swept, unrolled, or spent outside its exact recovery journal.');
  const app=createStockApp(coordinator,{profile,network,manifest:deployment.proving,checkpointTapscript:deployment.checkpointTapscript,artifactDirectory:options.artifactDirectory,webRoot:options.webRoot,adminToken:options.adminToken});
  return {app,coordinator,network};
 }catch(error){coordinator.close();throw error;}
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 if(process.argv.includes('--help')){console.log('Stock Shielded test-network service. Mount a separately accepted immutable deployment and its pinned proving artifacts. Configure SHIELDED_STOCK_DEPLOYMENT, SHIELDED_STOCK_ARTIFACTS, SHIELDED_STOCK_DATA_DIR, HOST and PORT. Development phase2 requires SHIELDED_STOCK_ALLOW_DEV_SETUP=true. Customer keys remain in their wallets.');process.exit(0);}
 const root=fileURLToPath(new URL('../..',import.meta.url));
 const service=await openStockMutinynetService({deploymentFile:process.env.SHIELDED_STOCK_DEPLOYMENT??resolve(root,'stock-release/deployment.json'),artifactDirectory:process.env.SHIELDED_STOCK_ARTIFACTS??resolve(root,'stock-release'),dataDirectory:process.env.SHIELDED_STOCK_DATA_DIR??resolve(root,'data-stock'),webRoot:resolve(root,'app/dist'),allowDevelopmentSetup:process.env.SHIELDED_STOCK_ALLOW_DEV_SETUP==='true',adminToken:process.env.SHIELDED_STOCK_ADMIN_TOKEN});
 const port=Number(process.env.PORT??8792);if(!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid stock HTTP port.');
 const listener=service.app.listen(port,process.env.HOST??'127.0.0.1',()=>console.log('Stock Shielded Mutinynet wallet listening on port '+port+'. Test network; '+service.network.weightLimit+' WU cap.'));
 let stopping=false;const stop=()=>{if(stopping)return;stopping=true;listener.close(()=>{service.coordinator.close();process.exitCode=0;});};process.once('SIGTERM',stop);process.once('SIGINT',stop);
}
