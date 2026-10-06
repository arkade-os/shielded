import {assertValidServerUnrollScript,MUTINYNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS} from '@arkade-os/sdk';
import {hex} from '@scure/base';
import {secp256k1} from '@noble/curves/secp256k1.js';
import type {CSVMultisigTapscript} from '@arkade-os/sdk';

/** Validate Arkade's separately advertised unilateral-forfeit checkpoint leaf. */
export function validateStockCheckpoint(checkpointTapscript:string,forfeitPubkey:string):CSVMultisigTapscript.Type{
 if(typeof forfeitPubkey!=='string'||! /^(02|03)[0-9a-f]{64}$/.test(forfeitPubkey))throw new Error('Operator forfeit public key is missing or malformed.');
 let canonical:string;
 try{canonical=hex.encode(secp256k1.Point.fromHex(forfeitPubkey).toBytes(true));}catch{throw new Error('Operator forfeit public key is not a valid secp256k1 point.');}
 if(canonical!==forfeitPubkey)throw new Error('Operator forfeit public key is not canonical compressed hex.');
 try{
  return assertValidServerUnrollScript(checkpointTapscript,{minSeconds:MUTINYNET_MIN_CHECKPOINT_EXIT_DELAY_SECONDS,requireSeconds:true,advertisedForfeitPubkey:hex.decode(forfeitPubkey.slice(2))});
 }catch(error){throw new Error(`Operator checkpoint policy is invalid: ${error instanceof Error?error.message:String(error)}`,{cause:error});}
}
