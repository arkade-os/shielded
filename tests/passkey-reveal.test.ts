import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createLockedPageWallet,revealSource} from '../app/src/locked-wallet.ts';
import {createPasskeyRevealOwner} from '../app/src/passkey-reveal.ts';
import {PASSKEY,SECRET} from '../app/src/shielded-page.ts';

test('leaving recovery after a prompt reply cannot publish when foreground resumes',async()=>{
 const owner=createPasskeyRevealOwner(),request=owner.begin();let resume!:()=>void,published=0;
 const foreground=new Promise<void>(resolve=>{resume=resolve;});
 const reading=(async()=>{request.current();await foreground;request.current();published++;})();
 owner.cancel();resume();await assert.rejects(reading,/closed/);assert.equal(published,0);assert.equal(request.signal.aborted,true);
});

test('a late completion cannot clear a newer reveal owner',()=>{
 const owner=createPasskeyRevealOwner(),old=owner.begin(),next=owner.begin();
 assert.throws(old.current,/closed/);old.finish();assert.equal(owner.active,true);next.current();next.finish();assert.equal(owner.active,false);
});

test('a browser recovery result that arrives while hidden cannot reveal on return',async()=>{
 const owner=createPasskeyRevealOwner(),request=owner.begin();let foreground=true,published=0,reply!:()=>void;
 const received=new Promise<void>(resolve=>{reply=resolve;});
 const reading=(async()=>{await received;request.publish(()=>foreground,()=>{published++;});})();
 foreground=false;reply();await assert.rejects(reading,/foreground/);foreground=true;assert.equal(published,0);
});

test('Backup asks the passkey again for a locked wallet and never calls passkeyWords',async()=>{
 const rows=new Map<string,string>(),storage={getItem:(k:string)=>rows.get(k)??null,setItem:(k:string,v:string)=>{rows.set(k,v);},removeItem:(k:string)=>{rows.delete(k);},key:(i:number)=>[...rows.keys()][i]??null,get length(){return rows.size;}};
 await createLockedPageWallet(storage,{credentialId:new Uint8Array(16).fill(1),userHandle:new Uint8Array(32).fill(2),wordCount:24});
 assert.equal(revealSource(storage),'locked','even 24 words, which the secret could show, wait for the passkey');
 rows.set(SECRET,'ab'.repeat(32));
 assert.equal(revealSource(storage),'secret','an interrupted restore leaves both, and its phrase wallet opens');
 rows.set(PASSKEY,JSON.stringify({version:1,credentialId:'AQ',label:'Default',words:12}));
 assert.equal(revealSource(storage),'passkey');
 const wallet=readFileSync(new URL('../app/src/RollupWallet.tsx',import.meta.url),'utf8');
 assert.match(wallet,/const words=revealSource\(storage\)==='locked'\?await unlockPageWallet\(storage,[\s\S]*?:await passkeyWords\(storage,/);
});
