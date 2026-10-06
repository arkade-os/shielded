import {createHash} from 'node:crypto';
import {existsSync,readFileSync} from 'node:fs';
import {resolve,join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {ArkAddress,MultisigTapscript,RestArkProvider,RestIndexerProvider,SingleKey,Transaction,VtxoScript} from '@arkade-os/sdk';
import {base64,hex} from '@scure/base';
import {TaprootControlBlock} from '@scure/btc-signer';
import {buildPoseidon} from 'circomlibjs';
import {deriveWalletKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';
import {stockJournalFingerprint} from '../src/stock/journal.ts';
import {loadStockProofArtifacts,type StockArtifactManifest} from '../packages/protocol/src/stock-proof-node.ts';
import {EngineStore} from '../src/storage.ts';
import {openCustomerArkWallet} from '../src/stock/ark-wallet.ts';
import {createStockBootstrap,stockBootstrapReleaseFingerprint,type StockBootstrapInput} from '../src/stock/bootstrap.ts';
import {preflightStockMutinynet} from '../src/stock/network.ts';
import {loadStockProfile,type StockProgramManifest} from '../src/stock/sdk.ts';
import type {StockProfileWeightEvidence} from '../src/stock/bootstrap.ts';
import {decodeStockIndexerTransaction} from '../src/stock/indexer.ts';
import {validateStockCheckpoint} from '../src/stock/checkpoint.ts';

function arg(name:string){const index=process.argv.indexOf(name);return index<0?undefined:process.argv[index+1];}
function has(name:string){return process.argv.includes(name);}
function usage(){console.log('Stock genesis bootstrap: node --import tsx tools/stock-bootstrap.ts [--outpoint txid:vout] [--weight-evidence <all-nine-qualification.json>] [--apply --expected-release-fingerprint <64-hex>] [--reconcile] [--allow-development-only]');console.log('Dry-run is the default. Apply always uses the exact selected customer Arkade VTXO and never selects a replacement.');}
function fail(message:string):never{throw new Error('Stock bootstrap CLI: '+message);}
function sourceInput(value:{funding:{txid:string;vout:number;value:number;sourceTxHex:string;tapTreeHex:string;leafHex:string}}):StockBootstrapInput{return value.funding;}
function zeroFee(value:unknown){return (value==='0'||value==='0.0'||value==='0.000'||value===0)&&Number(value)===0;}
function equal(a:Uint8Array|undefined,b:Uint8Array|undefined){return !!a&&!!b&&Buffer.from(a).equals(Buffer.from(b));}
function restoreIndexed(expected:string,raw:Transaction):string{
 const tx=Transaction.fromPSBT(base64.decode(expected));if(tx.id!==raw.id||!equal(tx.unsignedTx,raw.unsignedTx))fail('indexer returned a different transaction body.');
 for(let vin=0;vin<tx.inputsLength;vin++){
  const input=raw.getInput(vin),witness=input.finalScriptWitness,leaf=tx.getInput(vin).tapLeafScript?.[0];if(!leaf)fail('journaled input lacks its spend leaf.');
  const script=leaf[1].subarray(0,-1),leafHash=awaitTapLeafHash(script,leaf[1].at(-1)!);let keys:Uint8Array[];try{keys=MultisigTapscript.decode(script).params.pubkeys;if(keys.length!==2)fail('genesis input leaf must be exactly the pinned two-key closure.');}catch{return fail('journaled input has a noncanonical Arkade multisig closure.');}
  if(input.tapScriptSig?.length){if(input.tapScriptSig.length!==keys.length||input.tapScriptSig.some(([key,sig])=>sig.length!==64||!equal(key.leafHash,leafHash)||!keys.some(pubkey=>equal(pubkey,key.pubKey)))||new Set(input.tapScriptSig.map(([key])=>hex.encode(key.pubKey))).size!==keys.length)fail('indexer returned a noncanonical or incomplete default-sighash signature set.');tx.updateInput(vin,{tapScriptSig:input.tapScriptSig});continue;}
  if(!witness||witness.length!==keys.length+2||witness.some((item,index)=>index<keys.length&&item.length!==64)||!equal(witness.at(-2),script)||!equal(witness.at(-1),TaprootControlBlock.encode(leaf[0])))fail('indexer lacks the exact submitted spend witness.');
  const sigs=keys.map((pubKey,index)=>[{pubKey,leafHash},witness[keys.length-index-1]!] as [{pubKey:Uint8Array;leafHash:Uint8Array},Uint8Array]);
  tx.updateInput(vin,{tapScriptSig:sigs});
 }
 return base64.encode(tx.toPSBT());
}
import {tapLeafHash as awaitTapLeafHash} from '@scure/btc-signer/payment.js';

async function main(){
 if(has('--help'))usage();
else {
 if(has('--apply')&&!arg('--outpoint'))fail('--apply requires the exact customer outpoint.');
 if(has('--apply')&&!arg('--expected-release-fingerprint'))fail('--apply requires an independently reviewed --expected-release-fingerprint from the dry-run.');
 if(has('--expected-release-fingerprint')&&!/^[0-9a-f]{64}$/.test(arg('--expected-release-fingerprint')!))fail('--expected-release-fingerprint must be canonical lowercase 64-hex.');
 if(has('--reconcile')&&(has('--apply')||arg('--outpoint')||arg('--expected-release-fingerprint')))fail('--reconcile is read-only and takes no outpoint, apply, or new release approval.');
 const root=process.cwd(),artifactDir=resolve(arg('--artifacts')??'circuits/stock/build/compiled'),manifestPath=join(artifactDir,'stock-combined.manifest.json');
 if(!existsSync(manifestPath))fail('missing compiled stock artifact manifest; use the exact approved verifier profile.');
 const manifest=JSON.parse(readFileSync(manifestPath,'utf8')) as StockArtifactManifest;
 if(manifest.setup.phase2==='development-only'&&!has('--allow-development-only'))fail('development-only Groth16 setup requires explicit --allow-development-only.');
 const loaded=await loadStockProofArtifacts(artifactDir,manifest),binary=resolve(root,'bin',process.platform==='win32'?'shielded-vm.exe':'shielded-vm');
 if(!existsSync(binary))fail('stock VM is not built.');
 const programs=JSON.parse(execFileSync(binary,['--stock-build',join(artifactDir,'stock-combined.vkey.json')],{encoding:'utf8',windowsHide:true})) as StockProgramManifest;
  const network=await preflightStockMutinynet(),provider=new RestArkProvider(network.arkUrl),indexer=new RestIndexerProvider(network.arkUrl),info=await provider.getInfo();
 if(info.network!=='mutinynet'||info.checkpointTapscript==null||!info.fees||!zeroFee(info.fees.txFeeRate)||Object.keys(info.fees.intentFee??{}).length!==4||!Object.values(info.fees.intentFee??{}).every(zeroFee))fail('operator network, checkpoint policy, or zero-fee profile is not the pinned Mutinynet stock profile.');
  let checkpoint;try{checkpoint=validateStockCheckpoint(info.checkpointTapscript,info.forfeitPubkey);}catch(error){fail(error instanceof Error?error.message:'operator checkpoint policy is invalid.');}
 const walletDir=resolve('.recovery/stock-funding-wallet');if(!existsSync(join(walletDir,'shielded.sqlite'))||!existsSync(join(walletDir,'.key')))fail('the existing encrypted stock funding wallet is missing; refusing to create a new identity.');
 const fundingStore=EngineStore.open(walletDir);let funding:{version:1;purpose:string;network:string;masterSecret:string};
 try{const saved=fundingStore.load<typeof funding>();if(!saved||saved.version!==1||saved.purpose!=='new-stock-profile-test-funding'||saved.network!=='mutinynet'||!/^[a-f0-9]{64}$/i.test(saved.masterSecret))fail('the existing encrypted funding wallet has an unexpected identity or network.');funding=saved;}finally{fundingStore.close();}
 const material=deriveWalletKeyMaterial(funding.masterSecret,'mutinynet'),identity=SingleKey.fromHex(material.nativeSecret),ark=await openCustomerArkWallet(identity,network),ownerKey=hex.encode(await identity.xOnlyPublicKey());
  if(!arg('--outpoint')&&!has('--reconcile'))console.log(JSON.stringify({network:'mutinynet',spendableVtxos:ark.coins.map(coin=>({outpoint:`${coin.funding.txid}:${coin.funding.vout}`,value:coin.funding.value})),selectedOutpointRequired:true,transactionsSubmitted:0},null,2));
  else {
    const outpoint=arg('--outpoint');
   const store=EngineStore.open(resolve('.recovery/stock-bootstrap'));
   try{
   const pin={version:1 as const,network:'mutinynet' as const,networkInfo:network,descriptorProfileId:loaded.descriptor.profileId,programsHash:programs.programsHashHex,artifactsHash:stockJournalFingerprint(manifest),checkpointHash:createHash('sha256').update(hex.decode(info.checkpointTapscript)).digest('hex'),serverKey:network.serverKey,emulatorKey:network.emulatorKey,policyVersion:1 as const,developmentOnly:manifest.setup.phase2==='development-only'};
    const profile=loadStockProfile(programs,loaded.verifierKey,loaded.descriptor.profileId,network,programs.programsHashHex),poseidon=await buildPoseidon(),hash=(values:bigint[])=>BigInt(poseidon.F.toString(poseidon(values)));
     const pendingIds=(request:{arkTx:string;checkpoints:string[]})=>[Transaction.fromPSBT(base64.decode(request.arkTx)),...request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded)))];
     const pendingLookup=async(request:{arkTx:string;checkpoints:string[]})=>{
      const walletApi=ark.wallet as typeof ark.wallet&{getScriptMap?:()=>Promise<Map<string,VtxoScript>>;makeGetPendingTxIntentSignature?:(coins:any[])=>Promise<Parameters<RestArkProvider['getPendingTxs']>[0]>};
      if(typeof walletApi.getScriptMap!=='function'||typeof walletApi.makeGetPendingTxIntentSignature!=='function')return undefined;
      const expected=request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded))),points=expected.map(tx=>{const input=tx.getInput(0);if(!input.txid||input.index===undefined||!input.witnessUtxo)fail('journaled checkpoint is missing its original wallet prevout.');return {txid:hex.encode(input.txid).toLowerCase(),vout:input.index,value:input.witnessUtxo.amount,script:input.witnessUtxo.script};});
      const indexed=(await indexer.getVtxos({outpoints:points.map(({txid,vout})=>({txid,vout}))})).vtxos;if(indexed.length!==points.length)return undefined;
      const scripts=await walletApi.getScriptMap(),coins=points.map(point=>{const matches=indexed.filter(coin=>coin.txid.toLowerCase()===point.txid&&coin.vout===point.vout);if(matches.length!==1)return undefined;const coin=matches[0]!,tree=scripts.get(coin.script.toLowerCase());if(coin.value!==Number(point.value)||coin.script.toLowerCase()!==hex.encode(point.script).toLowerCase()||!tree)return undefined;return {...coin,tapTree:tree.encode(),forfeitTapLeafScript:tree.forfeit(),intentTapLeafScript:tree.forfeit()};});
      if(coins.some(coin=>!coin))return undefined;const intent=await walletApi.makeGetPendingTxIntentSignature(coins as NonNullable<(typeof coins)[number]>[]),matches=(await provider.getPendingTxs(intent)).filter(tx=>tx.arkTxid.toLowerCase()===Transaction.fromPSBT(base64.decode(request.arkTx)).id.toLowerCase());return matches.length===1?matches[0]:undefined;
     };
     const lookup=async(request:{arkTx:string;checkpoints:string[]})=>{
      const pending=await pendingLookup(request);if(pending)return pending;
      const expected=pendingIds(request),ids=expected.map(tx=>tx.id),raw=(await indexer.getVirtualTxs(ids)).txs.map(decodeStockIndexerTransaction);
     if(expected.some(tx=>raw.filter(found=>found.id===tx.id).length!==1))return undefined;
     const arkTx=restoreIndexed(request.arkTx,raw.find(tx=>tx.id===expected[0]!.id)!);
     const signedCheckpointTxs=request.checkpoints.map((encoded,index)=>restoreIndexed(encoded,raw.find(tx=>tx.id===expected[index+1]!.id)!));
     return {arkTxid:expected[0]!.id,finalArkTx:arkTx,signedCheckpointTxs};
    };
      const readExactInput=async(key:string)=>{const [txid,voutRaw]=key.split(':');if(!/^[0-9a-f]{64}$/.test(txid!)||!/^(0|[1-9][0-9]*)$/.test(voutRaw!))return undefined;const vout=Number(voutRaw),found=ark.coins.find(item=>`${item.funding.txid}:${item.funding.vout}`===key);if(!found)return undefined;const coins=(await indexer.getVtxos({outpoints:[{txid:txid!,vout}]})).vtxos,coin=coins.find(item=>item.txid===txid&&item.vout===vout);if(!coin||coin.isSpent||coin.isUnrolled||coin.isSwept||!(coin.expiresAt instanceof Date)||coin.expiresAt.getTime()<=Date.now()||coin.value!==found.funding.value||coin.script!==hex.encode(VtxoScript.decode(hex.decode(found.funding.tapTreeHex)).pkScript))return undefined;return sourceInput(found);};
      const weightEvidence=arg('--weight-evidence')?JSON.parse(readFileSync(resolve(arg('--weight-evidence')!),'utf8')) as StockProfileWeightEvidence:undefined;
      const engine=await createStockBootstrap({store,pin,expectedReleaseFingerprint:arg('--expected-release-fingerprint'),proving:manifest,checkpointTapscript:info.checkpointTapscript!,weightEvidence,profile,programs,backend:loaded.backend,identity,ownerKey,input:readExactInput,changeScript:ArkAddress.decode(ark.address).pkScript,checkpoint,hash,
     submit:async(request)=>provider.submitTx(request.arkTx,request.checkpoints),
     lookup:async(request)=>{const response=await lookup(request);return response?{arkTxid:response.arkTxid,finalArkTx:response.finalArkTx,signedCheckpointTxs:response.signedCheckpointTxs}:undefined;},
     finalize:async(txid,checkpoints)=>provider.finalizeTx(txid,checkpoints),
      indexed:async(plan,receipt)=>{
       const ids=[plan.txid,...receipt.checkpointTxids],txs=(await indexer.getVirtualTxs(ids)).txs.map(decodeStockIndexerTransaction);if(ids.some(id=>txs.filter(tx=>tx.id===id).length!==1))return false;
       const expected=Transaction.fromPSBT(base64.decode(plan.request.arkTx)),found=txs.find(tx=>tx.id===plan.txid)!;if(!equal(expected.unsignedTx,found.unsignedTx))fail('indexer head differs from the accepted exact genesis transaction.');
       const expectedCps=plan.request.checkpoints.map(encoded=>Transaction.fromPSBT(base64.decode(encoded)));for(const cp of expectedCps){const indexed=txs.find(tx=>tx.id===cp.id);if(!indexed||!equal(cp.unsignedTx,indexed.unsignedTx))fail('indexer checkpoint differs from the exact accepted funding spend.');}
       const outputs=(await indexer.getVtxos({outpoints:[{txid:plan.txid,vout:0}]})).vtxos,head=outputs.find(value=>value.txid===plan.txid&&value.vout===0);if(!head||head.value!==330||head.script!==plan.poolScriptHex||head.isSpent||head.isUnrolled||head.isSwept||!(head.expiresAt instanceof Date)||head.expiresAt.getTime()<=Date.now())return false;
       const [inputTxid,inputVout]=plan.outpoint.split(':'),spent=(await indexer.getVtxos({outpoints:[{txid:inputTxid!,vout:Number(inputVout)}]})).vtxos.find(value=>value.txid===inputTxid&&value.vout===Number(inputVout));return !!(spent&&spent.isSpent===true&&spent.spentBy===receipt.checkpointTxids[0]&&spent.arkTxId===plan.txid);
       },releaseRoot:resolve(arg('--release-root')??'stock-release'),artifactFiles:{'stock-combined_js/stock-combined.wasm':join(artifactDir,'stock-combined_js','stock-combined.wasm'),'stock-combined.zkey':join(artifactDir,'stock-combined.zkey'),'stock-combined.vkey.json':join(artifactDir,'stock-combined.vkey.json'),'stock-combined.manifest.json':manifestPath}});
     if(has('--reconcile'))console.log(JSON.stringify(await engine.reconcile(),null,2));
     else {
      if(!outpoint)fail('--outpoint is required for a plan or apply; reconcile uses the encrypted exact-identity journal.');
      const plan=await engine.plan(outpoint);
      if(has('--apply'))console.log(JSON.stringify(await engine.apply(outpoint),null,2));
     else console.log(JSON.stringify({phase:engine.status().phase,selectedOutpoint:plan.outpoint,genesisTxid:plan.txid,releaseFingerprint:stockBootstrapReleaseFingerprint(pin,plan.txid),descriptorProfileId:pin.descriptorProfileId,programsHash:pin.programsHash,artifactsHash:pin.artifactsHash,poolScriptHex:plan.poolScriptHex,poolValue:plan.poolValue,changeValue:plan.changeValue,weightLimit:network.weightLimit,proof:'none; phase-17 empty genesis',readyForOperatorAcceptance:false,transactionsSubmitted:0},null,2));
    }
   }finally{store.close();}
 }
}
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;}).finally(async()=>{await (globalThis as any).curve_bn128?.terminate();process.exit(process.exitCode??0);});
