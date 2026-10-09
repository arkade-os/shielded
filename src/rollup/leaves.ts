import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';
import {hex} from '@scure/base';
import type {RollupLeaves} from './covenant.ts';

export const DEFAULT_VM_BINARY=process.env.SHIELDED_VM_BIN??fileURLToPath(new URL(`../../bin/${process.platform==='win32'?'shielded-vm.exe':'shielded-vm'}`,import.meta.url));

export interface RollupLeavesSpec {clientKey:string;batchKey:string;clientJoinKey:string;batchJoinKey:string;slots:number;token:string;operator:string}

/** Builds the pool leaves with the Go covenant builder (`shielded-vm -rollup-leaves`); key paths resolve against the spec file. */
export async function loadRollupLeaves(vmBinary:string,specFile:string):Promise<RollupLeaves&{ecmul:number;pairs:number}> {
 const {stdout}=await promisify(execFile)(vmBinary,['-rollup-leaves',specFile],{maxBuffer:1<<20});
 const raw=JSON.parse(stdout) as {batch:string;batchJoin:string;reserve:string;renew:string;ecmul:number;pairs:number};
 return {batch:hex.decode(raw.batch),batchJoin:hex.decode(raw.batchJoin),reserve:hex.decode(raw.reserve),renew:hex.decode(raw.renew),ecmul:raw.ecmul,pairs:raw.pairs};
}
