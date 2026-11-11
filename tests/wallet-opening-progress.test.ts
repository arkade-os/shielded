import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWalletOpeningProgress,walletSyncProgressLabel} from '../app/src/wallet-opening-progress.ts';

test('opening progress counts public history work from its aligned start',()=>{
 assert.equal(walletSyncProgressLabel({stage:'history',from:128,through:178,total:255}),'Reading private pool history · 39% · 50 of 127 updates');
 assert.equal(walletSyncProgressLabel({stage:'history',from:0,through:100,total:200}),'Reading private pool history · 50% · 100 of 200 updates');
});

test('download completion does not claim verification or invent an unknown total',()=>{
 assert.equal(walletSyncProgressLabel({stage:'history',from:0,through:127,total:127}),'Reading private pool history · 99% · 127 of 127 updates');
 assert.equal(walletSyncProgressLabel({stage:'history',from:0,through:50}),'Reading private pool history · 50 updates');
 assert.equal(walletSyncProgressLabel({stage:'history',from:0,through:0,total:0}),'Reading private pool history · 0 updates');
 assert.equal(walletSyncProgressLabel({stage:'verifying',through:127,total:127}),'Verifying private pool history');
 assert.equal(walletSyncProgressLabel({stage:'verified',through:127,total:127}),'Private pool history verified');
});

test('waiting progress counts down a real cooldown and labels a slow request',()=>{
 assert.equal(walletSyncProgressLabel({stage:'waiting',request:'history',attempt:1,retryInMs:4000},1500),'Retrying private pool history in 3s');
 assert.equal(walletSyncProgressLabel({stage:'waiting',request:'status',attempt:2,retryInMs:4000},5000),'Retrying the private pool connection');
 assert.equal(walletSyncProgressLabel({stage:'request',request:'status',attempt:1},6100),'Checking the private pool connection · 5s');
});

test('opening progress stops its clock and rejects late callbacks after its owner closes',()=>{
 let now=0,tick=()=>{},cancelled=0;const lines:string[]=[];
 const progress=createWalletOpeningProgress(line=>lines.push(line),{now:()=>now,repeat:fn=>{tick=fn;return()=>{cancelled++;};}});
 progress.update({stage:'request',request:'history',attempt:1});now=6100;tick();
 assert.deepEqual(lines,['Reading private pool history','Reading private pool history · 5s']);
 progress.update({stage:'verified',through:0,total:0});assert.equal(cancelled,1);
 now=12000;tick();assert.equal(lines.at(-1),'Private pool history verified');
 progress.stop();progress.update({stage:'request',request:'status',attempt:2});tick();
 assert.equal(lines.length,3);assert.equal(cancelled,1);
});

test('the last real percentage stays visible while the next page downloads or retries',()=>{
 let now=0,tick=()=>{};const lines:string[]=[];
 const progress=createWalletOpeningProgress(line=>lines.push(line),{now:()=>now,repeat:fn=>{tick=fn;return()=>{};}});
 progress.update({stage:'history',from:128,through:178,total:228});
 progress.update({stage:'request',request:'history',attempt:1});now=6100;tick();
 assert.equal(lines.at(-1),'Reading private pool history · 50% · 50 of 100 updates · 5s');
 progress.update({stage:'waiting',request:'history',attempt:2,retryInMs:4000});
 assert.equal(lines.at(-1),'Reading private pool history · 50% · 50 of 100 updates · Retrying private pool history in 4s');
 progress.update({stage:'verified',through:228,total:228});
 progress.update({stage:'request',request:'history',attempt:1});
 assert.equal(lines.at(-1),'Reading private pool history');progress.stop();
});
