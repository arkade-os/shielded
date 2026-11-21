import assert from 'node:assert/strict';
import test from 'node:test';
import {createNativeOperationScope,NativePolicy} from '../src/native/policy.ts';

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
test('release metadata uses a separate purpose for the canonical query-free GET route',()=>{
 const p=policy(),url='https://shielded.mutinynet.arkade.sh/api/native/releases';
 assert.equal(p.classify(url).purpose,'release');
 assert.notEqual(p.classify(url).key,p.classify('https://pool.example/api/rollup/status').key);
 for(const method of ['POST','HEAD','PUT'])assert.throws(()=>p.classify(url,method));
 for(const denied of [url+'?',url+'?wallet=hidden',url+'/',url+'/latest',url.replace('/releases','/%72eleases'),url.replace('shielded.mutinynet.arkade.sh','pool.example'),url.replace('https:','wss:')])assert.throws(()=>p.classify(denied));
});
test('the pool\'s swap routes are a rendezvous POST and a registry GET, nothing else',()=>{
 const p=policy(),pool='https://pool.example/api/rollup';
 assert.deepEqual([p.classify(pool+'/rendezvous','POST','{}').purpose,p.classify(pool+'/solver-registry').purpose],['swap','discovery']);
 for(const [m,path] of [['GET','/rendezvous'],['POST','/solver-registry'],['PATCH','/rendezvous'],['GET','/rendezvous/x']])assert.throws(()=>p.classify(pool+path,m),/not approved/,`${m} ${path}`);
 assert.throws(()=>p.classify('https://ark.example/api/rollup/rendezvous','POST','{}'),/not approved/,'only on the pool');
});
test('a registered Lightning address service gets exactly its routes, one key per handle, and only it may carry a bearer',()=>{
 const p=policy(),lnurl='https://lnurl.example',session='ab'.repeat(32);
 assert.throws(()=>p.classify(lnurl+'/lnurl/address','GET'),/not approved/,'nothing before registration');
 assert.equal(p.authorizes(lnurl+'/lnurl/address'),false);
 p.registerLnurl(lnurl);
 for(const [m,path] of [['GET','/lnurl/address'],['POST','/lnurl/address'],['PATCH','/lnurl/address/alice?domain=lnurl.example'],['POST','/lnurl/address/alice/arkade'],['GET','/.well-known/lnurlp/bob'],['GET','/.well-known/lnurlp/bob/callback?amount=1000'],['GET','/lnurl/'+session],['GET','/lnurl/'+session+'/callback?amount=1000']])
  assert.equal(p.classify(lnurl+path,m).purpose,'lnurl',`${m} ${path}`);
 assert.notEqual(p.classify(lnurl+'/lnurl/address/alice/arkade','POST').key,p.classify(lnurl+'/lnurl/address/bob/arkade','POST').key);
 assert.equal(p.classify(lnurl+'/lnurl/address/alice/arkade','POST').key,p.classify(lnurl+'/lnurl/address/alice','PATCH').key);
 for(const [m,path] of [['DELETE','/lnurl/address/alice'],['PATCH','/lnurl/address'],['GET','/lnurl/address/alice'],['GET','/lnurl/address/alice/payments'],['PATCH','/lnurl/address/alice/arkade'],['POST','/.well-known/lnurlp/bob'],['GET','/lnurl/address/callback'],['GET','/lnurl/a/b'],['GET','/v1/info'],['GET','/other'],['GET','/']])
  assert.throws(()=>p.classify(lnurl+path,m),/not approved/,`${m} ${path}`);
 assert.throws(()=>p.classify('https://ark.example/lnurl/address','GET'),/not approved/,'an LNURL path elsewhere is not an LNURL route');
 p.registerLnurl('https://ark.example');
 assert.equal(p.classify('https://ark.example/v1/indexer/vtxos?scripts='+script,'GET').purpose,'indexer','an LNURL service on the indexer origin relabels no indexer route');
 assert.throws(()=>p.classify('https://ark.example/v1/indexer/vtxos?scripts='+script+'&scripts='+other,'GET'),/one|group/i);
 for(const path of ['/lnurl/address','/lnurl/address/alice?domain=lnurl.example','/lnurl/address/alice/arkade'])assert.ok(p.authorizes(lnurl+path),path);
 for(const url of [lnurl+'/.well-known/lnurlp/bob',lnurl+'/.well-known/lnurlp/bob/callback?amount=1000',lnurl+'/lnurl/'+session+'/callback',lnurl+'/lnurl/addressbook',
  'https://pool.example/api/rollup/status','https://lnurl.example.evil/lnurl/address','http://lnurl.example/lnurl/address','not a url'])assert.equal(p.authorizes(url),false,url);
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

test('an operation releases every isolated route it opened exactly once',async()=>{
 const p=policy(),released:string[]=[],scope=createNativeOperationScope(route=>{released.push(route.key);});
 scope.track(p.explicit('https://lnurl.example','lnurl','operation|https://lnurl.example'));
 scope.track(p.explicit('https://pay.example','lnurl','operation|https://pay.example'));
 scope.close();scope.close();await Promise.resolve();
 assert.deepEqual(released,[p.explicit('https://lnurl.example','lnurl','operation|https://lnurl.example').key,p.explicit('https://pay.example','lnurl','operation|https://pay.example').key]);
 assert.throws(()=>scope.track(p.explicit('https://late.example','lnurl','operation|https://late.example')),/closed/i);
});
test("the indexer's asset route is one GET per id at a registered indexer",()=>{
 const p=policy(),url='https://ark.example/v1/indexer/asset/'+'ee'.repeat(34);
 assert.equal(p.classify(url,'GET').purpose,'indexer');
 assert.throws(()=>p.classify(url,'POST'));
 assert.throws(()=>p.classify('https://tracker.example/v1/indexer/asset/'+'ee'.repeat(34),'GET'),/not approved/);
});
