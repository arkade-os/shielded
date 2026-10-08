import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {after,test} from 'node:test';
import {createRollupProver,runChild,verifyRollupProof} from '../src/rollup/prover.ts';

const toy=(name:string)=>join('tests','fixtures','rollup-toy',name);
const fixture=JSON.parse(readFileSync('tools/vm/testdata/rollup-covenant-snarkjs.json','utf8')) as {clientKey:unknown};
after(async()=>{await (globalThis as {curve_bn128?:{terminate():Promise<void>}}).curve_bn128?.terminate();});

test('the prover proves in a child process and refuses a proof of other public signals',async()=>{
 const calls:string[][]=[];
 const prover=createRollupProver({wasm:toy('covenant-client.wasm'),zkey:toy('covenant-client.zkey')},undefined,(file,args)=>{calls.push(args);return runChild(file,args);});
 const input={pub:9n,deposit:0n,withdraw:0n,boundaryAsset:0n,destination:0n,w:3n};
 const proof=await prover.prove(input,[9n,0n,0n,0n,0n]);
 assert.deepEqual(calls.map(args=>args.slice(1,3)),[['groth16','fullprove']]);
 assert.equal(await verifyRollupProof(fixture.clientKey,[9n,0n,0n,0n,0n],proof),true);
 await assert.rejects(prover.prove(input,[9n,1n,0n,0n,0n]),/public signals differ/);
});
