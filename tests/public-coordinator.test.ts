import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {SingleKey} from '@arkade-os/sdk';
import {createClientProtocol} from '../packages/protocol/src/index.ts';
import {createPublicCoordinator} from '../src/noncustodial/coordinator.ts';
import {createNoncustodialApp} from '../src/noncustodial/server.ts';
import {EngineStore} from '../src/storage.ts';
test('public proof API stores no user secrets, replays accepted IDs and restores durable acceptances', {timeout:120000},async()=>{
 const directory=await mkdtemp(join(tmpdir(),'shielded-public-'));
 const alice=await createClientProtocol({owner:'alice',keys:{spend:'41',view:'43'}}),bob=await createClientProtocol({owner:'bob',keys:{spend:'47',view:'53'}});
 const recipients={alice:alice.publicDescriptor(),bob:bob.publicDescriptor()};alice.setRecipients(recipients);bob.setRecipients(recipients);
 let coordinator=await createPublicCoordinator(directory);let listener=createNoncustodialApp(coordinator).listen(0,'127.0.0.1');await new Promise<void>(resolve=>listener.once('listening',resolve));
 const address=listener.address() as {port:number};const url='http://127.0.0.1:'+address.port;
 const post=async(path:string,body:unknown)=>{const response=await fetch(url+'/api/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return {status:response.status,body:await response.json()};};
 const closeHttp=()=>new Promise<void>((resolve,reject)=>listener.close(error=>error?reject(error):resolve()));
 try{
  const metadata=await post('settlements',{from:'alice',to:'bob',amount:1});assert.equal(metadata.status,400);
  await coordinator.register('alice',{recipient:recipients.alice,nativePublicKey:Buffer.from(await SingleKey.fromHex('51'.repeat(32)).xOnlyPublicKey()).toString('hex')});
  await coordinator.register('bob',{recipient:recipients.bob,nativePublicKey:Buffer.from(await SingleKey.fromHex('52'.repeat(32)).xOnlyPublicKey()).toString('hex')});
  const initial=coordinator.archive().archive;assert.equal('wallets' in initial,false);alice.restorePublicCheckpoint(initial);
  assert.equal(coordinator.profile().profile,initial.profile);assert.equal(coordinator.profile().capacity.remainingNoteRecords,256);
  const excessive=await alice.prepareShield('alice','BTC',20000000);await assert.rejects(coordinator.submit(excessive),/funding resource exhausted/);assert.equal(coordinator.profile().ready,true);assert.deepEqual(coordinator.archive().archive,initial);
  const shield=await alice.prepareShield('alice','BTC',1000);const leaking=await post('settlements',{...shield,spendSecret:'41'});assert.equal(leaking.status,400);
  const originalSave=EngineStore.prototype.save;let injected=false;
  EngineStore.prototype.save=function(value:any){if(!injected&&Object.keys(value.accepted??{}).length>0&&!value.journal){injected=true;throw new Error('Injected final persistence interruption');}originalSave.call(this,value);};
  try{const interrupted=await post('settlements',shield);assert.equal(interrupted.status,400);assert.equal(injected,true);assert.equal(coordinator.profile().ready,false);}finally{EngineStore.prototype.save=originalSave;}
  await closeHttp();await coordinator.close();coordinator=await createPublicCoordinator(directory);
  assert.equal(coordinator.archive().archive.state.revision,1);assert.equal(coordinator.profile().ready,true);
  const replay=await coordinator.submit(shield);assert.equal(replay.replay,true);assert.equal(coordinator.archive().archive.state.revision,1);
  const changed=structuredClone(shield);changed.proofTimes.intentMs++;await assert.rejects(coordinator.submit(changed),/different payload/);
  await coordinator.seal();alice.restorePublicCheckpoint(coordinator.archive().archive);assert.equal(alice.snapshot().wallets.alice.balances.BTC,1000);
  const saved=coordinator.archive().archive;await coordinator.close();coordinator=await createPublicCoordinator(directory);assert.deepEqual(coordinator.archive().archive,saved);
 }finally{if(listener.listening)await closeHttp();await coordinator.close();await rm(directory,{recursive:true,force:true});}
});
after(async()=>{await (globalThis as any).curve_bn128?.terminate();});
