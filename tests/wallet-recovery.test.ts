import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PRIVATE_RECEIVE_RESTART_KEY,claimPrivateReceiveRestart,clearPrivateReceiveRestart,dismissTransientWalletViews,privateReceiveStageLabel} from '../app/src/wallet-recovery.ts';

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

test('foreground recovery dismisses every transient wallet surface',()=>{
 const calls:string[]=[];
 dismissTransientWalletViews({
  closeSheet:()=>calls.push('sheet'),
  closeScanner:()=>calls.push('scanner'),
  closeAbout:()=>calls.push('about'),
  closeRequest:()=>calls.push('request'),
  closeSecurity:()=>calls.push('security'),
 });
 assert.deepEqual(calls,['scanner','sheet','about','request','security']);
});
