import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';
// @ts-ignore upstream has no declarations.
import { buildPoseidon } from 'circomlibjs';
// @ts-ignore upstream has no declarations.
import * as snarkjs from 'snarkjs';
import { IndexedNullifiers } from '../packages/protocol/src/indexed-nullifiers.ts';
import { STOCK_FIELD } from '../packages/protocol/src/stock-native.ts';
const root=resolve(import.meta.dirname,'..'), build=join(root,'circuits/stock/build');
const generation=spawnSync(process.execPath,[join(root,'circuits/stock/generate.mjs')],{cwd:root,stdio:'inherit'}); assert.equal(generation.status,0);
await writeFile(join(build,'indexed-nullifiers.circom'),await readFile(join(root,'circuits/stock/indexed-nullifiers.circom')));
const source=`pragma circom 2.1.6;
include "common.circom";
include "indexed-nullifiers.circom";
template TestNF() {
 signal input nf; signal input active; signal input expectedOld; signal input expectedNew;
 signal input nfCount; signal input nfPredecessorIndex; signal input nfPredecessor[3];
 signal input nfPredecessorPath[9]; signal input nfAppendPath[9];
 component relation=StockIndexedNullifier();
 relation.nf <== nf; relation.active <== active;
 relation.nfCount <== nfCount; relation.nfPredecessorIndex <== nfPredecessorIndex;
 for(var i=0;i<3;i++) relation.nfPredecessor[i] <== nfPredecessor[i];
 for(var i=0;i<9;i++) { relation.nfPredecessorPath[i] <== nfPredecessorPath[i]; relation.nfAppendPath[i] <== nfAppendPath[i]; }
 relation.oldRoot === expectedOld; relation.newRoot === expectedNew;
}
component main {public [nf,active,expectedOld,expectedNew]} = TestNF();`;
await writeFile(join(build,'stock-nullifier-test.circom'),source);
const compile=spawnSync(process.execPath,[join(root,'node_modules/circom2/cli.js'),'stock-nullifier-test.circom','--r1cs','--wasm','--O2','-o','.'],{cwd:build,stdio:'inherit'});
assert.equal(compile.status,0);
const poseidon=await buildPoseidon(), hash=(values:bigint[])=>BigInt(poseidon.F.toObject(poseidon(values)));
const wasmBytes=new Uint8Array(await readFile(join(build,'stock-nullifier-test_js/stock-nullifier-test.wasm')));
let tracker=new IndexedNullifiers(hash), positives=0, negatives=0;
async function accepts(input:Record<string,unknown>) {
 const file=join(build,'stock-nullifier-test.wtns');
 try { await snarkjs.wtns.calculate(input,wasmBytes,file); return await snarkjs.wtns.check(join(build,'stock-nullifier-test.r1cs'),file); } catch { return false; }
}
for(const value of ['257','1',(STOCK_FIELD-1n).toString(),'513',(STOCK_FIELD-2n).toString()]){
 const result=tracker.insert(value), input={nf:value,active:1,expectedOld:tracker.root().toString(),expectedNew:result.next.root().toString(),...result.witness};
 assert.equal(await accepts(input),true); positives++;
 assert.equal(await accepts({...input,nf:'0'}),false); negatives++;
 const badPath=result.witness.nfAppendPath.slice();badPath[0]=((BigInt(badPath[0])+1n)%STOCK_FIELD).toString();
 assert.equal(await accepts({...input,nfAppendPath:badPath}),false);negatives++;
 tracker=result.next;
 assert.equal(await accepts({nf:'0',active:0,expectedOld:tracker.root().toString(),expectedNew:tracker.root().toString(),...tracker.noopWitness()}),true);positives++;
}
console.log(JSON.stringify({relation:'stock-indexed-nullifier',positiveWitnesses:positives,rejectedWitnesses:negatives,realConstraints:true}));
await (globalThis as any).curve_bn128?.terminate();