import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {hex} from '@scure/base';
import type {RollupEpochLeaves} from './covenant.ts';

export const DEFAULT_VM_BINARY=process.env.SHIELDED_VM_BIN??fileURLToPath(new URL(`../../bin/${process.platform==='win32'?'shielded-vm.exe':'shielded-vm'}`,import.meta.url));

export interface RollupLeavesSpec {clientKey:string;batchKey:string;clientJoinKey:string;batchJoinKey:string;batchRecoverKey?:string;slots:number;token:string;operator:string;epoch?:boolean}

/** Builds the pool leaves with the Go covenant builder (`shielded-vm -rollup-leaves`); key paths resolve against the spec file. */
export async function loadRollupEpochLeaves(vmBinary:string,specFile:string):Promise<RollupEpochLeaves&{ecmul:number;pairs:number}> {
 const {stdout}=await promisify(execFile)(vmBinary,['-rollup-leaves',specFile],{maxBuffer:1<<20});
 const raw=JSON.parse(stdout) as {batch:string;batchJoin:string;batchRecover:string;reserve:string;renew:string;ecmul:number;pairs:number};
 const {batchRecover,...leaves}={batch:hex.decode(raw.batch),batchJoin:hex.decode(raw.batchJoin),...(raw.batchRecover?{batchRecover:hex.decode(raw.batchRecover)}:{}),reserve:hex.decode(raw.reserve),renew:hex.decode(raw.renew),ecmul:raw.ecmul,pairs:raw.pairs};
 if(!batchRecover?.length)throw new Error(`The covenant builder returned no recover leaf for ${specFile}: the spec lacks "epoch": true, or the covenant binary was built before f256b49; rebuild the covenant binary (npm run vm:build).`);
 return {...leaves,batchRecover};
}
