import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:net';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {mkdir,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {SingleKey} from '@arkade-os/sdk';
// @ts-ignore upstream libraries have no declarations.
import {buildPoseidon,buildBabyjub} from 'circomlibjs';
// @ts-ignore upstream library has no declarations.
import * as snarkjs from 'snarkjs';
import {Kernel,type Owner,type ProtocolEnvironment,type PreparedSettlement} from '../packages/protocol/src/index.ts';
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
const [poseidon,baby]=await Promise.all([buildPoseidon(),buildBabyjub()]);
const keys=Object.fromEntries(['intent','transition'].map(name=>[name,JSON.parse(readFileSync(resolve(root,'circuits/build/'+name+'.vkey.json'),'utf8'))]));
function fixture(owner:Owner,spend:string,view:string){
 // Deterministic note entropy belongs only to this disposable local harness.
 let counter=0;const env:ProtocolEnvironment={vkeys:keys,randomBytes:length=>createHash('sha256').update('shielded-client-smoke-v1:'+owner+':'+counter++).digest().subarray(0,length),prove:(name,witness)=>snarkjs.groth16.fullProve(witness,resolve(root,'circuits/build/'+name+'_js/'+name+'.wasm'),resolve(root,'circuits/build/'+name+'.zkey'),undefined,undefined,{singleThread:true}),verify:(key,signals,proof)=>snarkjs.groth16.verify(key,signals,proof)};
 return new Kernel(poseidon,baby,env,'client',owner,{spend,view});
}
const alice=fixture('alice','17','19'),bob=fixture('bob','23','29');
try{
 if(!suppliedImage)await command(['build','-f','Dockerfile.noncustodial','-t',image,'.']);
 await command(['volume','create',volume]);volumeCreated=true;const base='http://127.0.0.1:'+await port();
 await command(['run','--detach','--name',name,'--read-only','--cap-drop','ALL','--security-opt','no-new-privileges','--stop-timeout','120','--tmpfs','/tmp:rw,noexec,nosuid,size=64m,mode=1777','--publish',base.replace('http://','')+':8789','--mount','type=volume,source='+volume+',target=/data','--env','SHIELDED_API_TOKEN='+token,image]);created=true;await ready(base);console.log('Authenticated synthetic container is ready.');
 const api=async(path:string,body?:unknown)=>{const response=await fetch(base+'/api/'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+token,...(body===undefined?{}:{'Content-Type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(180000)});const value=await response.json();assert.equal(response.status,200,value.error??path);return value;};
 assert.equal((await fetch(base+'/wallet')).status,200);assert.equal((await fetch(base+'/api/profile')).status,401);
 const wasm=await fetch(base+'/api/proving/intent.wasm',{headers:{Authorization:'Bearer '+token}});assert.equal(wasm.status,200);assert.deepEqual([...new Uint8Array(await wasm.arrayBuffer()).slice(0,4)],[0,97,115,109]);
 const recipients={alice:alice.publicDescriptor(),bob:bob.publicDescriptor()};alice.setRecipients(recipients);bob.setRecipients(recipients);
 for(const [owner,client,secret] of [['alice',alice,'31'],['bob',bob,'32']] as const)await api('participants/'+owner,{recipient:client.publicDescriptor(),nativePublicKey:Buffer.from(await SingleKey.fromHex(secret.repeat(32)).xOnlyPublicKey()).toString('hex')});
 const sync=async()=>{const result=await api('archive');alice.restorePublicCheckpoint(result.archive);bob.restorePublicCheckpoint(result.archive);return result;};await sync();
 let first:PreparedSettlement|undefined;
 const apply=async(prepared:PreparedSettlement)=>{first??=prepared;const result=await api('settlements',prepared);const receipt=result.receipt;assert.ok(receipt.nativeWeight>0&&receipt.nativeWeight<=4000);assert.equal(receipt.nativeWeight,receipt.native.estimatedSignedWeight);assert.ok(receipt.checkpointWeights.every((weight:number)=>weight>0&&weight<=4000));measurements.push({operation:prepared.operation,nativeWeight:receipt.nativeWeight,checkpointWeights:receipt.checkpointWeights});await sync();console.log(prepared.operation+': '+receipt.nativeWeight+' WU verified');return result;};
 await apply(await alice.prepareShield('alice','BTC',100000));await apply(await alice.prepareShield('alice','DEMO',1000));
 await assert.rejects(alice.prepareTransfer('alice','bob','BTC',25000),/No sealed/);
 const seal=async()=>{const result=await api('seal',{});assert.ok(result.receipt.nativeWeight<=4000);measurements.push({operation:'seal',nativeWeight:result.receipt.nativeWeight,checkpointWeights:result.receipt.checkpointWeights});await sync();};await seal();
 await apply(await alice.prepareTransfer('alice','bob','BTC',25000));await apply(await alice.prepareTransfer('alice','bob','DEMO',250));await seal();
 const profile=await api('profile');await apply(await bob.prepareWithdraw('bob','BTC',10000,profile.destinations.bob));await apply(await bob.prepareWithdraw('bob','DEMO',100,profile.destinations.bob));await seal();
 const before=await sync();assert.deepEqual(before.archive.state.reserves,{BTC:90000,DEMO:900});
 const encrypted=await encryptWallet({keys:bob.exportWalletKeys(),archive:before.archive},'synthetic fixture password');const backup=await decryptWallet<{keys:{spend:string;view:string};archive:typeof before.archive}>(encrypted,'synthetic fixture password');const restored=fixture('bob',backup.keys.spend,backup.keys.view);restored.setRecipients(recipients);restored.restorePublicCheckpoint(backup.archive);assert.deepEqual(restored.snapshot().wallets.bob.balances,{BTC:15000,DEMO:150});
 await command(['restart',name]);await ready(base);console.log('Same-volume restart completed.');assert.deepEqual((await api('archive')).archive,before.archive);const replay=await api('settlements',first);assert.equal(replay.replay,true);assert.deepEqual(replay.archive,before.archive);
 const check="import assert from 'node:assert/strict'; import {EngineStore} from './src/storage.ts'; const store=EngineStore.open('/data'); try {const value=store.load(); assert.equal(Object.hasOwn(value.protocol,'wallets'),false); assert.equal(value.native.aliceSecret,''); assert.equal(value.native.bobSecret,''); assert.equal(value.journal,undefined); console.log('Public-only checkpoint verified');} finally {store.close();}";
 await command(['stop','--time','120',name]);assert.match(await command(['run','--rm','--network','none','--read-only','--tmpfs','/tmp:rw,noexec,nosuid,size=32m,mode=1777','--mount','type=volume,source='+volume+',target=/data','--entrypoint','node',image,'--import','tsx','--input-type=module','-e',check]),/Public-only checkpoint verified/);
 await mkdir(resolve(root,'validation'),{recursive:true});await writeFile(resolve(root,'validation/noncustodial-deployment.json'),JSON.stringify({network:'local-emulator',fundedMutinynet:false,proofSystem:'Groth16 BN254 development setup',clientKeys:true,coordinatorHasWalletSecrets:false,registeredIndependentVm:true,profile:before.archive.profile,budgetWu:4000,measurements,encryptedClientRestore:true,sameVolumeRestart:true,acceptedReplayDoesNotSignAgain:true,finality:'synthetic SDK transactions; no Ark inclusion or Bitcoin settlement'},null,2)+'\n');
 console.log('Client-owned Docker lifecycle passed: BTC/DEMO deposit, seal, transfer, withdrawal, client backup restore, same-volume restart and replay.');
}catch(error){if(created)console.error(await command(['logs',name]).catch(()=>''));throw error;}
finally{if(created)await command(['rm','--force',name]).catch(()=>{});if(volumeCreated)await command(['volume','rm',volume]).catch(()=>{});if(!suppliedImage)await command(['image','rm',image]).catch(()=>{});await (globalThis as any).curve_bn128?.terminate();}
