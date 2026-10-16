import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildPoseidon} from 'circomlibjs';
import {base64,hex} from '@scure/base';
import {buildRollupTransfer,RollupAccount,type BuiltSpend,type PublishedBatch} from '../packages/protocol/src/rollup/account.ts';
import {BATCH_SLOTS,NOTE_DEPTH,SUBTREE_DEPTH} from '../packages/protocol/src/rollup/constants.ts';
import {NoteFrontier} from '../packages/protocol/src/rollup/frontier.ts';
import {decodeScan,encodeScan,nullifierHint} from '../packages/protocol/src/rollup/scan.ts';
import {DeepTree} from '../packages/protocol/src/rollup/tree.ts';
import {recordHints,rollupRecipientOf} from '../packages/protocol/src/rollup/wallet.ts';
import {deriveRollupKeys2} from '../packages/protocol/src/wallet-keys.ts';
import {birthCheckpoint} from '../src/shielded/checkpoint.ts';
import {catchUp,SCAN_AFTER,SCAN_FROM} from '../src/shielded/sync.ts';

const poseidon=await buildPoseidon();
const hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const blockRoot=(leaves:bigint[])=>{let level=Array.from({length:2**SUBTREE_DEPTH},(_,i)=>leaves[i]??0n);while(level.length>1)level=Array.from({length:level.length/2},(_,i)=>hash([level[2*i]!,level[2*i+1]!]));return level[0]!;};

test('a frontier that takes some blocks by root alone keeps the root and tracked paths of one that takes every leaf',()=>{
 const full=new DeepTree(hash,NOTE_DEPTH),lean=new NoteFrontier(hash),tracked:number[]=[];
 let next=1n;
 for(let block=0;block<40;block++){
  const leaves=Array.from({length:22},()=>next++),offsets=block%7===0?[3,20]:[];
  leaves.forEach((leaf,i)=>full.set(block*32+i,leaf));
  if(offsets.length)lean.append(leaves,offsets);else lean.appendRoot(blockRoot(leaves));
  tracked.push(...offsets.map(o=>block*32+o));
  assert.equal(lean.root(),full.root(),`root after block ${block}`);
 }
 for(const index of tracked)assert.deepEqual(lean.path(index),full.path(index),`path of leaf ${index}`);
});

const [alice,bob,pad]=['11','22','33'].map(byte=>deriveRollupKeys2(byte.repeat(32),'mutinynet')) as ReturnType<typeof deriveRollupKeys2>[];
const [aliceTo,bobTo,padTo]=[alice!,bob!,pad!].map(k=>rollupRecipientOf(hash,k.ask,k.nk,k.viewSecret));
const published=(spends:BuiltSpend[],number:number):PublishedBatch=>({kind:'spend',txid:number.toString(16).padStart(64,'0'),at:1_000+number,slots:spends.map(({witness,ciphertext})=>({root:String(witness.slot.root),nullifiers:witness.slot.nullifiers.map(String),
 commitments:witness.slot.commitments.map(String) as [string,string],ctDigest:String(witness.slot.ctDigest),groupId:String(witness.slot.groupId),groupSize:witness.slot.groupSize,publics:witness.publicSignals.map(String),ciphertext:hex.encode(ciphertext)}))});

test('a scan entry carries each record\'s ephemeral key and view tags, the nullifier hints, and the batch\'s block root',async()=>{
 const replica=RollupAccount.owning(hash,pad!),root=replica.latestRoot();
 const spends=await Promise.all(Array.from({length:BATCH_SLOTS},()=>buildRollupTransfer(hash,{root,ask:pad!.ask,nk:pad!.nk,self:padTo!,request:{}})));
 const batch=published(spends,7);await replica.apply(batch);
 const [entry]=decodeScan(encodeScan([{record:batch,root:replica.state.notes.node(SUBTREE_DEPTH,0)}]),7);
 assert.deepEqual([entry!.batch,entry!.txid,entry!.at,entry!.kind,entry!.root],[7,batch.txid,batch.at,'spend',replica.state.notes.node(SUBTREE_DEPTH,0)]);
 batch.slots.forEach((slot,i)=>{
  const hints=recordHints(hex.decode(slot.ciphertext!));
  assert.deepEqual([entry!.slots[i]!.ephemeral,entry!.slots[i]!.tags,entry!.slots[i]!.nullifiers],[hints.ephemeral.slice(),hints.tags,[nullifierHint(BigInt(slot.nullifiers[0]!))]]);
 });
 assert.throws(()=>decodeScan(encodeScan([{record:batch,root:0n}]).subarray(0,200),0),/Malformed/);
});

test('a wallet synced by scan ends where one that read every batch does, fetching its own batches and few others',async()=>{
 const replica=RollupAccount.owning(hash,pad!),whole=RollupAccount.owning(hash,alice!,{frontier:true}),scanned=RollupAccount.owning(hash,alice!,{frontier:true});
 const bobs=RollupAccount.owning(hash,bob!,{frontier:true}),batches:PublishedBatch[]=[],own=new Set<number>();
 const land=async(spends:BuiltSpend[],mine:boolean)=>{
  const root=replica.latestRoot(),padding=await Promise.all(Array.from({length:BATCH_SLOTS-spends.length},()=>buildRollupTransfer(hash,{root,ask:pad!.ask,nk:pad!.nk,self:padTo!,request:{}})));
  const batch=published([...spends,...padding],batches.length);
  if(mine)own.add(batches.length);
  batches.push(batch);for(const account of [replica,whole,bobs])await account.apply(batch);
 };
 await land([await whole.spend({deposit:900n},aliceTo!)],true);
 for(let i=0;i<4;i++)await land([await bobs.spend({deposit:100n},bobTo!)],false);
 await land([await whole.spend({input:whole.notes()[0]!,to:{recipient:bobTo!,amount:300n}},aliceTo!)],true);
 for(let i=0;i<3;i++)await land([],false);
 await land([await bobs.spend({input:bobs.notes().find(n=>n.amount===300n)!,to:{recipient:aliceTo!,amount:50n}},bobTo!)],true);
 await land([],false);
 const fetched:number[]=[];
 for(const [n,batch] of batches.entries()){
  const [entry]=decodeScan(encodeScan([{record:batch,root:replica.state.notes.node(SUBTREE_DEPTH,n)}]),n);
  if(await scanned.concerns(entry!)){fetched.push(n);await scanned.apply(batch);}else scanned.skip(entry!);
 }
 const json=(account:RollupAccount)=>JSON.stringify([account.notes(),account.history,account.latestRoot(),[...account.txids]],(_,v)=>typeof v==='bigint'?String(v):v);
 assert.equal(json(scanned),json(whole),'the same notes, history, root and batch txids');
 assert.equal(scanned.balance(),650n);
 assert.ok([...own].every(n=>fetched.includes(n)),`fetched ${fetched} covers its own batches ${[...own]}`);
 assert.ok(fetched.length<batches.length,'batches without its notes or spends are passed by their root');
 const later=batches[5]!,[entry]=decodeScan(encodeScan([{record:later,root:0n}]),5),spent=BigInt(later.slots[0]!.nullifiers[0]!);
 assert.equal(await RollupAccount.owning(hash,bob!,{frontier:true,bornAt:99}).concerns(entry!,[spent]),true,'a watched nullifier fetches the batch that spends it');
});

test('catch-up scans a long gap, takes whole only the batch that concerns the wallet, then the newest batches',async()=>{
 const replica=RollupAccount.owning(hash,pad!),root=replica.latestRoot(),total=SCAN_FROM+150,mineAt=200;
 const deposit=await RollupAccount.owning(hash,alice!).spend({deposit:700n},aliceTo!),filler=await buildRollupTransfer(hash,{root,ask:pad!.ask,nk:pad!.nk,self:padTo!,request:{}});
 let n=0n;
 const synthetic=():PublishedBatch=>({kind:'spend',slots:Array.from({length:BATCH_SLOTS},()=>({root:'0',nullifiers:[String(++n)],commitments:[String(++n),String(++n)] as [string,string],ctDigest:'0',groupId:'0',groupSize:0}))});
 const batches=Array.from({length:total},(_,i)=>i===mineAt?published([deposit,...Array.from({length:BATCH_SLOTS-1},()=>filler)],i):synthetic());
 const roots=batches.map(b=>blockRoot(b.slots.flatMap(s=>s.commitments.map(BigInt))));
 const asked:string[]=[];
 const api=(async(path:string)=>{
  asked.push(path);
  const query=new URLSearchParams(path.split('?')[1]),from=Number(query.get('from')),to=Math.min(total,from+Number(query.get('limit')));
  if(path.startsWith('/scan'))return {from,total,data:base64.encode(encodeScan(batches.slice(from,to).map((record,i)=>({record,root:roots[from+i]!}))))};
  return {total,batches:batches.slice(from,to)};
 }) as never;
 const account=RollupAccount.owning(hash,alice!,{frontier:true});
 assert.equal(await catchUp(account,api),total);
 assert.equal(account.batchCount,total);
 assert.equal(account.balance(),700n);
 const whole=asked.filter(p=>p.startsWith('/batches')).map(p=>new URLSearchParams(p.split('?')[1]).get('from'));
 assert.ok(asked.some(p=>p.startsWith('/scan')),'the gap past the first page is scanned');
 assert.ok(whole.includes(String(mineAt)),'the batch holding its deposit comes whole');
 assert.ok(asked.filter(p=>p.startsWith('/batches')&&p.endsWith('limit=1')).length<10,'only a few others are fetched whole');
 assert.deepEqual(whole.filter(f=>Number(f)>=total-SCAN_AFTER).length>0,true,'the newest batches always come whole');
});

test('a restore date picks the last checkpoint at least a day before it, from the full list',async()=>{
 const asked:string[]=[],api=(async(path:string)=>{asked.push(path);return {every:64,at:[0,1_000,90_000_000,200_000_000]};}) as never,day=86_400_000;
 assert.equal(await birthCheckpoint(api,90_000_000+day),128);
 assert.equal(await birthCheckpoint(api,90_000_000+day-1),64);
 assert.equal(await birthCheckpoint(api,0),0);
 assert.deepEqual(asked,['/times','/times','/times'],'the date never leaves the wallet');
});

test('an older pool without a scan endpoint is caught up with whole pages, asked for a scan once',async()=>{
 let n=0n;const total=SCAN_FROM+120,asked:string[]=[];
 const batches=Array.from({length:total},():PublishedBatch=>({kind:'spend',slots:Array.from({length:BATCH_SLOTS},()=>({root:'0',nullifiers:[String(++n)],commitments:[String(++n),String(++n)] as [string,string],ctDigest:'0',groupId:'0',groupSize:0}))}));
 const api=(async(path:string)=>{
  asked.push(path);
  if(path.startsWith('/scan'))throw Object.assign(new Error('Not found'),{status:404});
  const query=new URLSearchParams(path.split('?')[1]),from=Number(query.get('from'));
  return {total,batches:batches.slice(from,from+Number(query.get('limit')))};
 }) as never;
 const account=RollupAccount.owning(hash,alice!,{frontier:true});
 assert.equal(await catchUp(account,api),total);
 assert.equal(asked.filter(p=>p.startsWith('/scan')).length,1);
});
