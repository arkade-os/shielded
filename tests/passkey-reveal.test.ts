import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPasskeyRevealOwner} from '../app/src/passkey-reveal.ts';

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
