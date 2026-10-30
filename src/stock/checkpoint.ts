import {assertValidServerUnrollScript,networks} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {secp256k1} from '@noble/curves/secp256k1.js';
import type {CSVMultisigTapscript} from '@arkade-os/sdk';

// The SDK floor is 512 s since 0.5.0-rc.31; the hosted Mutinynet operator advertises 4096 s (8 × 512), and anything shorter lets it sweep an in-flight checkpoint sooner.
const MIN_EXIT_DELAY_SECONDS=4096n;

/** Validate Arkade's separately advertised unilateral-forfeit checkpoint leaf. */
export function validateStockCheckpoint(checkpointTapscript:string,forfeitPubkey:string):CSVMultisigTapscript.Type{
 if(typeof forfeitPubkey!=='string'||! /^(02|03)[0-9a-f]{64}$/.test(forfeitPubkey))throw new Error('Operator forfeit public key is missing or malformed.');
 let canonical:string;
 try{canonical=hex.encode(secp256k1.Point.fromHex(forfeitPubkey).toBytes(true));}catch{throw new Error('Operator forfeit public key is not a valid secp256k1 point.');}
 if(canonical!==forfeitPubkey)throw new Error('Operator forfeit public key is not canonical compressed hex.');
 try{
  const script=assertValidServerUnrollScript(checkpointTapscript,networks.mutinynet,hex.decode(forfeitPubkey.slice(2)));
  if(BigInt(script.params.timelock.value)<MIN_EXIT_DELAY_SECONDS)throw new Error(`the checkpoint exit delay is ${script.params.timelock.value} s, below ${MIN_EXIT_DELAY_SECONDS} s`);
  return script;
 }catch(error){throw new Error(`Operator checkpoint policy is invalid: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
}
