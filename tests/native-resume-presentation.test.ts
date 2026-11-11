import assert from 'node:assert/strict';
import test from 'node:test';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import NativeResumePresentation from '../app/src/NativeResumePresentation.tsx';
import {createNativeResumePresentation} from '../app/src/native-resume-presentation.ts';

test('a short suspension retains bounded copied display data and one scanner delivery',()=>{
 let now=0;const memory=createNativeResumePresentation(()=>now);
 const source={balance:'123',activity:[{title:'Received',amount:'+123 sats'}],secret:'never copy'};
 memory.remember(source);memory.scanner(true);memory.freeze();
 source.activity[0]!.title='changed';
 assert.deepEqual(memory.snapshot,{balance:'123',activity:[{title:'Received',amount:'+123 sats'}]});
 const token=memory.delivery();assert.equal(typeof token,'number');
 memory.acknowledge(token!);assert.equal(memory.delivery(),undefined);
 memory.promote();memory.remember(source);memory.freeze();
 assert.notEqual(memory.delivery(),token);
 memory.scanner(false);assert.equal(memory.delivery(),undefined);
});

test('duplicate hides do not extend presentation expiry and hard clear drops scanner intent',()=>{
 let now=0;const memory=createNativeResumePresentation(()=>now);
 memory.remember({balance:'1',activity:[]});memory.scanner(true);memory.freeze();
 now=29_999;memory.freeze();assert.ok(memory.snapshot);assert.ok(memory.delivery());
 now=30_000;assert.equal(memory.snapshot,undefined);assert.equal(memory.delivery(),undefined);
 memory.remember({balance:'2',activity:[]});memory.freeze();assert.equal(memory.delivery(),undefined);
 memory.scanner(true);memory.clear();assert.equal(memory.snapshot,undefined);assert.equal(memory.delivery(),undefined);
});

test('presentation copies only bounded primitives and old expiry cannot clear a new display',()=>{
 let now=0;const memory=createNativeResumePresentation(()=>now);
 memory.remember({balance:'1'.repeat(1000),activity:Array.from({length:10},()=>({title:'a'.repeat(1000),amount:'2'.repeat(1000)}))});
 memory.freeze();const first=memory.ticket;
 assert.equal(memory.snapshot!.activity.length,3);assert.ok(memory.snapshot!.balance.length<=80);assert.ok(memory.snapshot!.activity[0]!.title.length<=160);
 memory.promote();now=100;memory.remember({balance:'2',activity:[]});memory.freeze();
 now=30_000;memory.expire(first);assert.equal(memory.snapshot!.balance,'2');
 now=30_100;memory.expire(memory.ticket);assert.equal(memory.snapshot,undefined);
});

test('expired scanner acknowledgements cannot revive intent and a payment link can supersede delivery',()=>{
 let now=0;const memory=createNativeResumePresentation(()=>now);
 memory.scanner(true);memory.freeze();const expired=memory.delivery()!;
 now=30_000;memory.scanner(true);memory.acknowledge(expired);
 memory.freeze();assert.equal(memory.delivery(),undefined);
 memory.clear();memory.scanner(true);memory.freeze();assert.ok(memory.delivery());
 memory.scanner(false);memory.promote();assert.equal(memory.delivery(),undefined);
});

test('the frozen shell renders formatted amounts without live wallet controls',()=>{
 const markup=renderToStaticMarkup(createElement(NativeResumePresentation,{snapshot:{balance:'123 sats',unshielded:'2 sats',activity:[]},phase:'Checking Tor readiness',error:''}));
 assert.match(markup,/123 sats/);assert.doesNotMatch(markup,/sats sats|<(?:a|input|textarea)\b/);
 assert.equal([...markup.matchAll(/<button\b/g)].length,4);assert.equal([...markup.matchAll(/disabled=""/g)].length,4);
 assert.match(markup,/Last known private balance/);assert.match(markup,/Checking Tor readiness/);
});
