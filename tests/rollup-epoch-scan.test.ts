import assert from 'node:assert/strict';
import {test} from 'node:test';
import {hex} from '@scure/base';
import {EPOCH_NULLIFIERS,EPOCH_SLOTS,type EpochBatchKind} from '../packages/protocol/src/rollup/constants.ts';
import {decodeEpochScan,encodeEpochScan,EPOCH_SCAN_FLAG_ROTATED,type EpochScanBatch,type EpochScannedRecord} from '../packages/protocol/src/rollup/epoch-scan.ts';
import {decodeScan,encodeScan,nullifierHint} from '../packages/protocol/src/rollup/scan.ts';
import {fromLe,recordHints,ROLLUP_RECORD_BYTES} from '../packages/protocol/src/rollup/wallet.ts';

const EPOCH_LEN=64,KINDS:EpochBatchKind[]=['spend','join','recover'];
const bytesOf=(seed:number,length:number)=>Uint8Array.from({length},(_,i)=>(seed*37+i*11+1)&255);
const recordOf=(kind:EpochBatchKind,seed:number,sealed=true):EpochScannedRecord=>({kind,...(sealed?{txid:hex.encode(bytesOf(seed,32)),at:1_700_000_000_000+seed}:{}),
 slots:Array.from({length:EPOCH_SLOTS[kind]},(_,s)=>({nullifiers:Array.from({length:EPOCH_NULLIFIERS[kind]},(_,k)=>String((BigInt(seed)<<64n)+0xdeadbeefn*BigInt(s+1)+BigInt(k))),
  ...(sealed&&s%2===0?{ciphertext:hex.encode(bytesOf(seed+s,ROLLUP_RECORD_BYTES))}:{})}))});
const expected=(record:EpochScannedRecord,batch:number,epoch:number,blockInEpoch:number,rotated:boolean,root:bigint):EpochScanBatch=>({batch,epoch,blockInEpoch,...(record.txid?{txid:record.txid}:{}),...(record.at?{at:record.at}:{}),kind:record.kind,rotated,root,
 slots:record.slots.map(s=>{const hints=s.ciphertext?recordHints(hex.decode(s.ciphertext)):undefined;return {...(hints?{ephemeral:hints.ephemeral.slice()}:{}),tags:hints?.tags??[0,0],nullifiers:s.nullifiers.map(nf=>nullifierHint(BigInt(nf)))};})});
const pageOf=(kind:EpochBatchKind,rotated=false,root=1n)=>encodeEpochScan([{record:recordOf(kind,1),root,rotated}]);

test('an epoch scan page round-trips a spend, a join and a recover batch',()=>{
 const [spend,join,recover]=KINDS.map((kind,i)=>recordOf(kind,i+1)),bare=recordOf('spend',9,false),[a,b,c,d]=[11n,12n,13n,14n].map(r=>(r<<200n)+r) as [bigint,bigint,bigint,bigint];
 const page=encodeEpochScan([{record:spend,root:a,rotated:false},{record:join,root:b,rotated:true},{record:recover,root:c,rotated:false},{record:bare,root:d,rotated:false}]);
 assert.deepEqual(decodeEpochScan(page,63,EPOCH_LEN),[expected(spend,63,0,63,false,a),expected(join,64,1,0,true,b),expected(recover,65,1,1,false,c),expected(bare,66,1,2,false,d)]);
 assert.deepEqual(decodeEpochScan(new Uint8Array(),0,EPOCH_LEN),[]);
});

test('the entry sizes are 453, 493 and 111 bytes',()=>{
 const sizes=KINDS.map(kind=>pageOf(kind).length);
 assert.deepEqual(sizes,[453,493,111]);
 assert.deepEqual(KINDS.map(kind=>73+EPOCH_SLOTS[kind]*(34+4*EPOCH_NULLIFIERS[kind])),sizes);
 assert.deepEqual([KINDS.map(kind=>pageOf(kind)[40]),KINDS.map(kind=>pageOf(kind,true)[40]),EPOCH_SCAN_FLAG_ROTATED],[[0,1,2],[4,5,6],4]);
 const recover=recordOf('recover',3),page=encodeEpochScan([{record:recover,root:7n<<100n,rotated:true}]),view=new DataView(page.buffer);
 assert.deepEqual([...page.subarray(0,32)],[...hex.decode(recover.txid!)]);
 assert.deepEqual([view.getFloat64(32,true),fromLe(page.subarray(41,73)),view.getUint32(73+34,true)],[recover.at,7n<<100n,nullifierHint(BigInt(recover.slots[0]!.nullifiers[0]!))]);
});

test('a non-rotating spend or join entry is a classic entry, and a classic reader refuses the rest',()=>{
 for(const kind of ['spend','join'] as const){
  const record={...recordOf(kind,2),kind},entry=encodeEpochScan([{record,root:9n,rotated:false}]);
  assert.deepEqual(entry,encodeScan([{record,root:9n}]),`a ${kind} is the classic bytes`);
  assert.deepEqual(decodeScan(entry,5).map(b=>[b.kind,b.root]),[[kind,9n]]);
  assert.throws(()=>decodeScan(encodeEpochScan([{record,root:9n,rotated:true}]),5),/Malformed scan page/,`a rotating ${kind}`);
 }
 assert.throws(()=>decodeScan(pageOf('recover'),5),/Malformed scan page/,'a recover batch');
});

test('a page whose rotation flags disagree with epochLen is refused',()=>{
 const batches=[62,63,64,65],page=encodeEpochScan(batches.map(n=>({record:recordOf('spend',n),root:1n,rotated:n===64})));
 assert.deepEqual(decodeEpochScan(page,62,EPOCH_LEN).map(e=>e.rotated),[false,false,true,false]);
 for(const [i] of batches.entries()){
  const flipped=page.slice();flipped[i*453+40]^=EPOCH_SCAN_FLAG_ROTATED;
  assert.throws(()=>decodeEpochScan(flipped,62,EPOCH_LEN),/Malformed epoch scan page/,`bit 2 flipped on batch ${62+i}`);
 }
 assert.throws(()=>decodeEpochScan(pageOf('spend',true),0,EPOCH_LEN),/Malformed/,'batch 0 never rotates');
 assert.throws(()=>decodeEpochScan(pageOf('spend',true),64,65),/Malformed/,'a page read under another epoch length');
 assert.equal(decodeEpochScan(pageOf('spend',true),64,32)[0]!.epoch,2);
});

test('an epochLen that is not a positive safe integer is a caller error, not a malformed page',()=>{for(const bad of [0,-64,1.5,NaN,Infinity,2**53])assert.throws(()=>decodeEpochScan(new Uint8Array(),0,bad),RangeError,`epochLen ${bad}`);});

test('a reserved flag bit, kind 3 and a truncated entry are each refused',()=>{
 for(let bit=3;bit<8;bit++){const bad=pageOf('spend');bad[40]|=1<<bit;assert.throws(()=>decodeEpochScan(bad,5,EPOCH_LEN),/Malformed epoch scan page/,`reserved bit ${bit}`);}
 for(const [flags,batch] of [[3,5],[7,64]] as const){const bad=pageOf('spend',flags===7);bad[40]=flags;assert.throws(()=>decodeEpochScan(bad,batch,EPOCH_LEN),/Malformed epoch scan page/,`flags ${flags}`);}
 for(const kind of KINDS){
  const page=pageOf(kind);
  for(const cut of [1,40,72,73,page.length-1])assert.throws(()=>decodeEpochScan(page.subarray(0,cut),5,EPOCH_LEN),/Malformed epoch scan page/,`a ${kind} entry cut at ${cut}`);
 }
 assert.throws(()=>decodeEpochScan(Uint8Array.from([...pageOf('spend'),...pageOf('join')]).subarray(0,453+100),5,EPOCH_LEN),/Malformed/,'a second entry cut short');
});

test('a recover batch reaches the wallet as one slot with one nullifier hint',()=>{
 const recover=recordOf('recover',4),[entry]=decodeEpochScan(encodeEpochScan([{record:recover,root:6n,rotated:false}]),65,EPOCH_LEN);
 assert.deepEqual([entry!.kind,entry!.slots.length,entry!.slots[0]!.nullifiers],['recover',1,[nullifierHint(BigInt(recover.slots[0]!.nullifiers[0]!))]]);
 assert.throws(()=>encodeScan([{record:recover as never,root:6n}]),/wrong shape/,'the classic encoder cannot express it');
 const [spend,join]=[recordOf('spend',1),recordOf('join',1)];
 for(const [label,record] of [['a recover of ten slots',{...spend,kind:'recover'}],['a spend of one slot',{...spend,slots:recover.slots}],['a join slot of one nullifier',{...join,slots:spend.slots}]] as const)
  assert.throws(()=>encodeEpochScan([{record,root:1n,rotated:false}]),/wrong shape/,label);
});
