import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {hex} from '@scure/base';
import type {RollupLeaves} from './covenant.ts';

export interface RollupLeavesSpec {clientKey:string;batchKey:string;slots:number;kind:0|1;token:string;operator:string}

/** Builds the pool leaves with the Go covenant builder (`shielded-vm -rollup-leaves`); key paths resolve against the spec file. */
export async function loadRollupLeaves(vmBinary:string,specFile:string):Promise<RollupLeaves&{ecmul:number;pairs:number}> {
 const {stdout}=await promisify(execFile)(vmBinary,['-rollup-leaves',specFile],{maxBuffer:1<<20});
 const raw=JSON.parse(stdout) as {batch:string;reserve:string;renew:string;ecmul:number;pairs:number};
 return {batch:hex.decode(raw.batch),reserve:hex.decode(raw.reserve),renew:hex.decode(raw.renew),ecmul:raw.ecmul,pairs:raw.pairs};
}
