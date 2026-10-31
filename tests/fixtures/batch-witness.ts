import {EmulatorPacket,Extension} from '@arkade-os/sdk';
import {RawWitness} from '@scure/btc-signer';
import {rollupPublicItems} from '../../src/rollup/covenant.ts';

/** An extension output whose pool-head (vin 0) emulator entry carries `items` as its witness. */
export const witnessOutput=(items:Uint8Array[])=>Extension.create([EmulatorPacket.create([{vin:0,script:Uint8Array.of(0x51),witness:RawWitness.encode(items)}])]).txOut();

/** A batch's extension output whose pool-head witness has one slot per statement, with stand-in proof items. */
export function batchWitnessOutput(statements:readonly bigint[]){
 const proof=Array.from({length:8},()=>Uint8Array.of(1));
 return witnessOutput([...proof,...statements.flatMap(s=>[...proof,...rollupPublicItems([s,1n,0n,1000n,0n,0n,0n])])]);
}
