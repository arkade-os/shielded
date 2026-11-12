import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PRIVATE_RECEIVE_RESTART_KEY,claimPrivateReceiveRestart,clearNativeTransientDocument,clearPrivateReceiveRestart,createProgressWatchdog,dismissTransientWalletViews,privateReceiveStageLabel,restartWhenVisible,shouldAutoDismissPaymentResult} from '../app/src/wallet-recovery.ts';

class MemoryStorage {
 private readonly values=new Map<string,string>();
 getItem(key:string){return this.values.get(key)??null;}
 setItem(key:string,value:string){this.values.set(key,value);}
 removeItem(key:string){this.values.delete(key);}
}

test('a stalled private receive activates one automatic restart per cooldown',()=>{
 const storage=new MemoryStorage();
 assert.equal(claimPrivateReceiveRestart(storage,1_000),true);
 assert.equal(claimPrivateReceiveRestart(storage,2_000),false);
 assert.equal(claimPrivateReceiveRestart(storage,121_000),true);
 storage.setItem(PRIVATE_RECEIVE_RESTART_KEY,'200000');
 assert.equal(claimPrivateReceiveRestart(storage,1000),true);
 clearPrivateReceiveRestart(storage);
 assert.equal(claimPrivateReceiveRestart(storage,122_000),true);
});

test('private receive progress names its numbered setup step',()=>{
 assert.equal(privateReceiveStageLabel('Reading your saved receiver'),'Step 1 of 5 · Reading your saved receiver');
 assert.equal(privateReceiveStageLabel('Restoring payout watches'),'Step 4 of 5 · Restoring payout watches');
 assert.equal(privateReceiveStageLabel('Unified address ready'),'Step 5 of 5 · Unified address ready');
});

test('private receive stall timers restart from each observed progress step',()=>{
 let scheduled:()=>void=()=>{},stalls=0;
 const watchdog=createProgressWatchdog(60_000,()=>stalls++,{
  set:callback=>{scheduled=callback;return {} as ReturnType<typeof setTimeout>;},
  clear:()=>{scheduled=()=>{};},
 });
 watchdog.arm();const first=scheduled;watchdog.arm();first();assert.equal(stalls,0);scheduled();assert.equal(stalls,1);
 watchdog.arm();const stopped=scheduled;watchdog.stop();stopped();assert.equal(stalls,1);
});

test('an automatic restart deferred while hidden restores manual recovery instead of staying disabled',()=>{
 let restarts=0,deferrals=0;
 assert.equal(restartWhenVisible(()=>true,()=>restarts++,()=>deferrals++),false);
 assert.deepEqual([restarts,deferrals],[0,1]);
 assert.equal(restartWhenVisible(()=>false,()=>restarts++,()=>deferrals++),true);
 assert.deepEqual([restarts,deferrals],[1,1]);
});

test('a terminal payment result is retained while hidden and auto-dismisses only when visible',()=>{
 assert.equal(shouldAutoDismissPaymentResult({done:true},false),false);
 assert.equal(shouldAutoDismissPaymentResult({done:true},true),true);
 assert.equal(shouldAutoDismissPaymentResult({done:false},true),false);
 assert.equal(shouldAutoDismissPaymentResult(undefined,true),false);
});

test('foreground recovery dismisses every transient wallet surface',()=>{
 const calls:string[]=[];
 dismissTransientWalletViews({
  closeSheet:()=>calls.push('sheet'),
  closeScanner:()=>calls.push('scanner'),
  closeAbout:()=>calls.push('about'),
  closeSecurity:()=>calls.push('security'),
 });
 assert.deepEqual(calls,['scanner','sheet','about','security']);
});

test('foreground recovery clears stale document-level sheet locks and inert attributes',()=>{
 const calls:string[]=[],root={classList:{remove:(name:string)=>calls.push(`class:${name}`)},style:{removeProperty:(name:string)=>calls.push(`style:${name}`)}};
 clearNativeTransientDocument(root,[{removeAttribute:name=>calls.push(`attr:${name}`)},{removeAttribute:name=>calls.push(`attr:${name}`)}]);
 assert.deepEqual(calls,['class:native-sheet-open','style:overflow','attr:inert','attr:inert']);
});

test('soft background hides the recovery phrase but keeps scanner intent, sheets and About',()=>{
 const calls:string[]=[];
 dismissTransientWalletViews({
  closeSheet:()=>calls.push('sheet'),
  closeScanner:()=>calls.push('scanner'),
  closeAbout:()=>calls.push('about'),
  closeSecurity:()=>calls.push('security'),
 },'background');
 assert.deepEqual(calls,['security']);
});
