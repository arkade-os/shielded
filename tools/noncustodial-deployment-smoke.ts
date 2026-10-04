import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {SingleKey} from '@arkade-os/sdk';
import {signParticipantRegistration,type Owner,type PreparedSettlement} from '../packages/protocol/src/index.ts';
import {deriveWalletKeyMaterial} from '../packages/protocol/src/wallet-keys.ts';
import {createTestClientProtocol} from '../tests/fixtures/client-protocol.ts';
import {encryptWallet,decryptWallet} from '../app/src/wallet-backup.ts';

const root=fileURLToPath(new URL('..',import.meta.url));
const name='shielded-client-smoke-'+randomUUID().replaceAll('-','').slice(0,12),volume=name+'-data';
const suppliedImage=process.env.SHIELDED_NONCUSTODIAL_SMOKE_IMAGE;
const image=suppliedImage??name+':test',token=randomBytes(32).toString('base64url');
let created=false,volumeCreated=false;
const measurements:{operation:string;nativeWeight:number;checkpointWeights:number[]}[]=[];
function command(args:string[]){return new Promise<string>((resolve,reject)=>{const child=spawn('docker',args,{windowsHide:true,stdio:['ignore','pipe','pipe']});let output='';for(const stream of [child.stdout,child.stderr])stream.on('data',chunk=>{output=(output+chunk.toString()).slice(-10000);});child.on('error',reject);child.on('close',code=>code===0?resolve(output.trim()):reject(new Error('docker '+args[0]+' failed: '+output)));});}
async function port(){const listener=createServer();await new Promise<void>((resolve,reject)=>listener.once('error',reject).listen(0,'127.0.0.1',resolve));const value=(listener.address() as {port:number}).port;await new Promise<void>(resolve=>listener.close(()=>resolve()));return value;}
async function ready(base:string){for(let n=0;n<60;n++){try{if((await fetch(base+'/health',{signal:AbortSignal.timeout(1000)})).ok)return;}catch{}await new Promise(resolve=>setTimeout(resolve,1000));}throw new Error('Synthetic lab did not start');}
const masterSecret='42'.repeat(32),network='local-emulator' as const;
const partySeed=(label:string)=>createHash('sha256').update(`shielded-client-smoke-v1:${masterSecret}:${label}`).digest();
const party=(label:string)=>deriveWalletKeyMaterial(partySeed(label),network);
async function participant(label:string){const material=party(label),publicKey=Buffer.from(await SingleKey.fromHex(material.nativeSecret).xOnlyPublicKey()).toString('hex');return {label,material,owner:publicKey as Owner};}
const aliceParty=await participant('alice'),bobParty=await participant('bob'),carolParty=await participant('carol');
let alice=await createTestClientProtocol({owner:aliceParty.owner,keys:aliceParty.material.keys,entropyLabel:'deployment-alice'});
let bob=await createTestClientProtocol({owner:bobParty.owner,keys:bobParty.material.keys,entropyLabel:'deployment-bob'});
let carol:Awaited<ReturnType<typeof createTestClientProtocol>>|undefined;
try{
 if(!suppliedImage)await command(['build','-f','Dockerfile.noncustodial','-t',image,'.']);
 await command(['volume','create',volume]);volumeCreated=true;const base='http://127.0.0.1:'+await port();
 await command(['run','--detach','--name',name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--stop-timeout','120','--tmpfs','/tmp:rw,noexec,nosuid,size=64m,mode=1777','--publish',base.replace('http://','')+':8789','--mount','type=volume,source='+volume+',target=/data','--env','SHIELDED_API_TOKEN='+token,image]);created=true;await ready(base);console.log('Authenticated synthetic container is ready.');
 const api=async(path:string,body?:unknown)=>{const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(180000)});const value=await response.json();assert.equal(response.status,200,value.error??path);return value;};
 assert.equal((await fetch(base+'/wallet')).status,200);assert.equal((await fetch(base+'/api/profile')).status,401);
 const wasm=await fetch(base+'/api/proving/intent.wasm',{headers:{Authorization:'Bearer '+token}});assert.equal(wasm.status,200);assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer()).slice(0,4)],[0,97,115,109]);
	let recipients:Record<Owner,ReturnType<typeof alice.publicDescriptor>>={};
	const register=async(value:typeof aliceParty,client:typeof alice,profile:string)=>{const signed=signParticipantRegistration({network,profile,secretKey:value.material.nativeSecret,recipient:client.publicDescriptor()});assert.equal(signed.owner,value.owner);await api('participants/'+signed.owner,{recipient:signed.recipient,nativePublicKey:signed.nativePublicKey,authorization:signed.authorization});};
	recipients={[aliceParty.owner]:alice.publicDescriptor(),[bobParty.owner]:bob.publicDescriptor()};alice.setRecipients(recipients);bob.setRecipients(recipients);
	const registrationProfile=(await api('profile')).registration.profile as string;
	await register(aliceParty,alice,registrationProfile);await register(bobParty,bob,registrationProfile);
	const clients=()=>[alice,bob,...(carol?[carol]:[])];
	const sync=async()=>{const result=await api('archive');for(const client of clients())client.restorePublicCheckpoint(result.archive);return result;};await sync();
 let first:PreparedSettlement|undefined;
 const apply=async(prepared:PreparedSettlement)=>{first??=prepared;const result=await api('settlements',prepared);const receipt=result.receipt;assert.ok(receipt.nativeWeight>0&&receipt.nativeWeight<=4000);assert.equal(receipt.nativeWeight,receipt.native.estimatedSignedWeight);assert.ok(receipt.checkpointWeights.every((weight:number)=>weight>0&&weight<=4000));measurements.push({operation:prepared.operation,nativeWeight:receipt.nativeWeight,checkpointWeights:receipt.checkpointWeights});await sync();console.log(prepared.operation+': '+receipt.nativeWeight+' WU verified');return result;};
	await apply(await alice.prepareShield(aliceParty.owner,'BTC',100000));await apply(await alice.prepareShield(aliceParty.owner,'DEMO',1000));
	await assert.rejects(alice.prepareTransfer(aliceParty.owner,bobParty.owner,'BTC',25000),/No sealed/);
	const beforeAppend=await sync();assert.equal(beforeAppend.archive.state.revision,2);
	const withoutRecipients=(value:any)=>{const result=structuredClone(value);delete result.recipients;return result;};
	const oldPrograms=beforeAppend.native.artifacts,oldHeads=beforeAppend.native.heads,oldProfile=beforeAppend.profile;
	const carolPublic=await createTestClientProtocol({owner:carolParty.owner,keys:carolParty.material.keys,entropyLabel:'deployment-carol-register'});
	await register(carolParty,carolPublic,registrationProfile);
	const appended=await api('archive');assert.deepEqual(withoutRecipients(appended.archive),withoutRecipients(beforeAppend.archive));
	assert.equal(appended.profile.profile,oldProfile.profile);assert.equal(appended.profile.network,oldProfile.network);assert.equal(appended.profile.proofSystem,oldProfile.proofSystem);assert.equal(appended.profile.setup,oldProfile.setup);
	assert.deepEqual(appended.native.heads,oldHeads);assert.deepEqual(appended.native.nativeAssets,beforeAppend.native.nativeAssets);assert.deepEqual(appended.native.gateFunding,beforeAppend.native.gateFunding);assert.deepEqual(appended.native.receipts,beforeAppend.native.receipts);assert.deepEqual(appended.native.genesis,beforeAppend.native.genesis);
	for(const [name,artifact] of Object.entries(oldPrograms))assert.deepEqual(appended.native.artifacts[name],artifact,`existing registered program ${name} changed during participant append`);
	assert.ok(appended.native.artifacts[carolParty.owner+'Recipient']);
	recipients=appended.archive.recipients;
	alice=await createTestClientProtocol({owner:aliceParty.owner,keys:alice.exportWalletKeys(),recipients,entropyLabel:'deployment-alice-after-carol'});alice.restorePublicCheckpoint(appended.archive);
	bob=await createTestClientProtocol({owner:bobParty.owner,keys:bob.exportWalletKeys(),recipients,entropyLabel:'deployment-bob-after-carol'});bob.restorePublicCheckpoint(appended.archive);
	carol=await createTestClientProtocol({owner:carolParty.owner,keys:carolParty.material.keys,recipients,entropyLabel:'deployment-carol-seed'});carol.restorePublicCheckpoint(appended.archive);
	await assert.rejects(alice.prepareTransfer(aliceParty.owner,carolParty.owner,'BTC',25000),/No sealed/);
	const seal=async()=>{const result=await api('seal',{});assert.ok(result.receipt.nativeWeight>0&&result.receipt.nativeWeight<=4000);assert.ok(result.receipt.checkpointWeights.every((weight:number)=>weight>0&&weight<=4000));measurements.push({operation:'seal',nativeWeight:result.receipt.nativeWeight,checkpointWeights:result.receipt.checkpointWeights});await sync();};await seal();
	await apply(await alice.prepareTransfer(aliceParty.owner,bobParty.owner,'BTC',25000));await apply(await alice.prepareTransfer(aliceParty.owner,bobParty.owner,'DEMO',250));await seal();
	await apply(await alice.prepareTransfer(aliceParty.owner,carolParty.owner,'BTC',15000));await apply(await alice.prepareTransfer(aliceParty.owner,carolParty.owner,'DEMO',150));await seal();
	assert.deepEqual(carol.snapshot().wallets[carolParty.owner].balances,{BTC:15000,DEMO:150});
	const seedRecovered=await createTestClientProtocol({owner:carolParty.owner,keys:deriveWalletKeyMaterial(partySeed('carol'),network).keys,recipients,entropyLabel:'deployment-carol-seed-recovery'});seedRecovered.restorePublicCheckpoint((await sync()).archive);assert.deepEqual(seedRecovered.snapshot().wallets[carolParty.owner].balances,{BTC:15000,DEMO:150});
	const backupSource=await sync();const encrypted=await encryptWallet({keys:carol.exportWalletKeys(),archive:backupSource.archive},'synthetic fixture password');const backup=await decryptWallet<{keys:{spend:string;view:string};archive:typeof backupSource.archive}>(encrypted,'synthetic fixture password');const backupRecovered=await createTestClientProtocol({owner:carolParty.owner,keys:backup.keys,recipients,entropyLabel:'deployment-carol-backup'});backupRecovered.restorePublicCheckpoint(backup.archive);assert.deepEqual(backupRecovered.snapshot().wallets[carolParty.owner].balances,{BTC:15000,DEMO:150});
	const profile=await api('profile');await apply(await carol.prepareWithdraw(carolParty.owner,'BTC',5000,profile.destinations[carolParty.owner]));await apply(await carol.prepareWithdraw(carolParty.owner,'DEMO',50,profile.destinations[carolParty.owner]));await apply(await bob.prepareWithdraw(bobParty.owner,'BTC',10000,profile.destinations[bobParty.owner]));await apply(await bob.prepareWithdraw(bobParty.owner,'DEMO',100,profile.destinations[bobParty.owner]));await seal();
	const before=await sync();assert.deepEqual(before.archive.state.reserves,{BTC:85000,DEMO:850});
	assert.deepEqual(carol.snapshot().wallets[carolParty.owner].balances,{BTC:10000,DEMO:100});
	const finalHeads=before.native.heads,finalReceipts=before.native.receipts;
	await command(['restart',name]);await ready(base);console.log('Same-volume restart completed.');assert.deepEqual((await api('archive')).archive,before.archive);const replay=await api('settlements',first);assert.equal(replay.replay,true);assert.deepEqual(replay.archive,before.archive);assert.deepEqual(replay.native.heads,finalHeads);assert.deepEqual(replay.native.receipts,finalReceipts);
 const forbidden=[masterSecret,aliceParty.material.nativeSecret,bobParty.material.nativeSecret,carolParty.material.nativeSecret,aliceParty.material.keys.spend,aliceParty.material.keys.view,bobParty.material.keys.spend,bobParty.material.keys.view,carolParty.material.keys.spend,carolParty.material.keys.view];
 const check=`import assert from 'node:assert/strict'; import {EngineStore} from './src/storage.ts'; const store=EngineStore.open('/data'); try {const value=store.load(); assert.equal(Object.hasOwn(value.protocol,'wallets'),false); assert.equal(value.native.aliceSecret,''); assert.equal(value.native.bobSecret,''); assert.equal(value.journal,undefined); const encoded=JSON.stringify(value); for(const secret of ${JSON.stringify(forbidden)}) assert.equal(encoded.includes(secret),false,'server state contains client secret'); console.log('Public-only checkpoint verified');} finally {store.close();}`;
 await command(['stop','--time','120',name]);assert.match(await command(['run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=32m,mode=1777','--mount','type=volume,source='+volume+',target=/data','--entrypoint','node',image,'--import','tsx','--input-type=module','-e',check]),/Public-only checkpoint verified/);
	await mkdir(resolve(root,'validation'),{recursive:true});await writeFile(resolve(root,'validation/noncustodial-deployment.json'),JSON.stringify({network:'local-emulator',fundedMutinynet:false,proofSystem:'Groth16 BN254 development setup',clientKeys:true,coordinatorHasWalletSecrets:false,registeredIndependentVm:true,profile:before.archive.profile,budgetWu:4000,participants:3,thirdParticipantAppendAfterAcceptedTransactions:true,priorNativeHeadsAndProgramsUnchanged:true,btcDemoUnsealedAndSealed:true,transferToThirdAndWithdrawBothAssets:true,seedOnlyArchiveRecovery:true,encryptedClientRestore:true,measurements,sameVolumeRestart:true,acceptedReplayDoesNotSignAgain:true,finality:'synthetic SDK transactions; no Ark inclusion or Bitcoin settlement'},null,2)+'\n');
	console.log('Client-owned Docker lifecycle passed: signed three-party registration, BTC/DEMO deposit/seal/transfer/withdraw, seed and encrypted backup recovery, same-volume restart and accepted replay.');
}catch(error){if(created)console.error(await command(['logs',name]).catch(()=>''));throw error;}
finally{if(created)await command(['rm','--force',name]).catch(()=>{});if(volumeCreated)await command(['volume','rm',volume]).catch(()=>{});if(!suppliedImage)await command(['image','rm',image]).catch(()=>{});await (globalThis as any).curve_bn128?.terminate();}
