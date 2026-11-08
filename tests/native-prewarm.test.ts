import assert from 'node:assert/strict';
import test from 'node:test';
import {openNativeVault} from '../app/src/native-open.ts';
import {NativePolicy} from '../src/native/policy.ts';
import {NativeBridge,type NativeBackend,type NativeStatus} from '../src/native/transport.ts';

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(r=>{resolve=r;});return {promise,resolve};};
const ready:NativeStatus={phase:'ready',generation:1,mode:'tor'};
function prewarmed(){
 const joined=deferred<NativeStatus>();let native:NativeStatus={phase:'bootstrapping',generation:1,mode:'tor'},starts=0,reads=0;
 const backend:NativeBackend={invoke:async command=>{
  if(command==='native_status')return {...native};
  if(command==='native_start'){starts++;return joined.promise;}
  if(command==='native_pause'){native={phase:'paused',generation:native.generation+1,mode:'tor'};return {...native};}
  throw new Error('Unexpected native command: '+command);
 },channel:()=>{throw new Error('Unexpected native stream');}};
 const bridge=new NativeBridge(backend,new NativePolicy('https://pool.example'));
 return {bridge,get starts(){return starts;},get reads(){return reads;},ready(){native={...ready};},complete(){joined.resolve({...ready});},
  open(current:()=>boolean=()=>true){return openNativeVault(()=>bridge.start(),async()=>{reads++;return null;},current,{mode:'tor',current});},
 };
}

test('first native open joins an unobserved prewarmed generation before reading the vault',async()=>{
 const startup=prewarmed(),opening=startup.open();
 assert.equal(startup.bridge.current.generation,0);assert.equal(startup.starts,1);assert.equal(startup.reads,0);
 startup.ready();startup.complete();
 assert.deepEqual(await opening,{status:ready,secret:null});assert.equal(startup.starts,1);assert.equal(startup.reads,1);
});

test('native open joins an observed bootstrap without requiring another generation',async()=>{
 const startup=prewarmed();await startup.bridge.status();const opening=startup.open();
 assert.equal(startup.bridge.current.phase,'bootstrapping');assert.equal(startup.bridge.current.generation,1);assert.equal(startup.reads,0);
 startup.ready();startup.complete();
 assert.equal((await opening)?.status.generation,1);assert.equal(startup.starts,1);assert.equal(startup.reads,1);
});

test('an already ready prewarm opens the vault without advancing its generation',async()=>{
 const startup=prewarmed();startup.ready();startup.complete();await startup.bridge.status();
 assert.deepEqual(await startup.open(),{status:ready,secret:null});assert.equal(startup.starts,1);assert.equal(startup.reads,1);
});

test('a ready status poll can win while the prewarm join is pending',async()=>{
 const startup=prewarmed();await startup.bridge.status();const opening=startup.open();
 startup.ready();assert.deepEqual(await startup.bridge.status(),ready);assert.equal(startup.reads,0);
 startup.complete();
 assert.deepEqual(await opening,{status:ready,secret:null});assert.equal(startup.starts,1);assert.equal(startup.reads,1);
});

test('pause or lock retires a joined prewarm before its late result can read the vault',async()=>{
 for(const action of ['pause','lock']){
  const startup=prewarmed();let unlocked=true;
  await startup.bridge.status();const opening=startup.open(()=>unlocked);
  if(action==='lock')unlocked=false;
  await startup.bridge.pause();
  const stopped=action==='pause'?assert.rejects(opening,/Tor is not ready/):opening.then(value=>assert.equal(value,undefined));
  startup.complete();await stopped;
  assert.equal(startup.bridge.current.phase,'paused');assert.equal(startup.bridge.current.generation,2);assert.equal(startup.starts,1);assert.equal(startup.reads,0);
 }
});
