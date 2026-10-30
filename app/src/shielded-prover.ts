import type {RollupPoolStatus} from '../../src/shielded/pool.ts';
import {snarkjsProver} from '../../src/shielded/prover.ts';
import type {ShieldedProver} from '../../src/shielded/wallet.ts';
export {loadProvingFile,prefetchProvingKeys} from '../../src/shielded/prover.ts';

export const JOIN_READY='shielded-rollup-join-ready-v1';
export const browserProver=(status:()=>RollupPoolStatus):ShieldedProver=>
 snarkjsProver({status,joinReady:{get:()=>localStorage.getItem(JOIN_READY)==='1',set:()=>localStorage.setItem(JOIN_READY,'1')}});
