import assert from 'node:assert/strict';
import test from 'node:test';
import {NativePolicy} from '../src/native/policy.ts';

const script='0014'+'ab'.repeat(20),other='0014'+'cd'.repeat(20);
const policy=()=>{const p=new NativePolicy('https://pool.example');p.registerArk('https://ark.example','https://ark.example');return p;};
test('native routes identify one item independently of pagination and reject grouped requests',()=>{
 const p=policy(),a=p.classify('https://ark.example/v1/indexer/vtxos?scripts='+script,'GET');
 assert.deepEqual(a,p.classify('https://ark.example/v1/indexer/vtxos?scripts='+script+'&page.index=3','GET'));
 assert.notEqual(a.key,p.classify('https://ark.example/v1/indexer/vtxos?scripts='+other,'GET').key);
 assert.throws(()=>p.classify('https://ark.example/v1/indexer/vtxos?scripts='+script+'&scripts='+other,'GET'),/one|group/i);
 assert.throws(()=>p.classify('https://ark.example/v1/indexer/script/subscribe','POST',JSON.stringify({scripts:[script,other]})),/one|group/i);
});
test('native routes reject direct unknown traffic and encoded global streams',()=>{
 const p=policy();
 for(const url of ['https://tracker.example/pixel','https://ark.example/v1/txs','https://ark.example/v1/tx%73','https://user:pass@ark.example/v1/info','http://ark.example/v1/info'])assert.throws(()=>p.classify(url,'GET'));
});
test('server subscription identifiers inherit only their script scope',()=>{
 const p=policy();p.subscription('server-a',script,'https://ark.example');
 assert.equal(p.classify('https://ark.example/v1/indexer/script/subscription/server-a','GET').key,p.classify('https://ark.example/v1/indexer/vtxos?scripts='+script,'GET').key);
 assert.throws(()=>p.classify('https://ark.example/v1/indexer/script/subscription/unknown','GET'));
 p.clear();assert.throws(()=>p.classify('https://ark.example/v1/indexer/script/subscription/server-a','GET'));
});
test('a malicious server cannot rebind one subscription id to another item',()=>{
 const p=policy();p.subscription('shared-id',script,'https://ark.example');
 assert.throws(()=>p.subscription('shared-id',other,'https://ark.example'),/reused|another/i);
 assert.equal(p.classify('https://ark.example/v1/indexer/script/subscription/shared-id','GET').key,p.classify('https://ark.example/v1/indexer/vtxos?scripts='+script,'GET').key);
});
