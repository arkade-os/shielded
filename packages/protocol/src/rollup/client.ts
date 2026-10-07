import { NOTE_DEPTH } from './constants.ts';
import { noteOf, nullifierOf, outputRhoOf, statementOf, type Hash } from './notes.ts';
import type { BatchSlot } from './state.ts';
import { pathBits } from './tree.ts';

export interface ClientInput { amount: bigint; spendSecret: bigint; rho: bigint; index: number; path: bigint[] }
export interface ClientOutput { amount: bigint; owner: bigint; random: bigint }
export interface ClientSpend {
 domain: bigint; root: bigint; asset: bigint;
 inputs: ClientInput[];
 outputs: [ClientOutput, ClientOutput];
 deposit: bigint; withdraw: bigint; destination: bigint; ctDigest: bigint; groupId: bigint; groupSize: number;
}
export interface ClientWitness { input: Record<string, unknown>; slot: BatchSlot; publicSignals: bigint[] }

// One input proves with circuits/rollup/spend.circom, two with join.circom; an amount-0 input is a dummy.
export function clientWitness(hash: Hash, spend: ClientSpend): ClientWitness {
 const m = spend.inputs.length;
 if (m !== 1 && m !== 2) throw new Error('A spend has one input and a join has two.');
 const nullifiers = spend.inputs.map(input => nullifierOf(hash, spend.domain, input.spendSecret, input.rho));
 const commitments = spend.outputs.map((output, index) => noteOf(hash, spend.domain, output.amount, spend.asset, output.owner, outputRhoOf(hash, spend.domain, output.random, nullifiers, index))) as [bigint, bigint];
 const slot: BatchSlot = { root: spend.root, nullifiers, commitments, ctDigest: spend.ctDigest, groupId: spend.groupId, groupSize: spend.groupSize };
 const pub = statementOf(hash, { domain: spend.domain, ...slot });
 const per = <T>(pick: (input: ClientInput) => T) => (m === 1 ? pick(spend.inputs[0]) : spend.inputs.map(pick));
 const input = {
  pub, deposit: spend.deposit, withdraw: spend.withdraw, asset: spend.asset, destination: spend.destination,
  domain: spend.domain, root: spend.root, ctDigest: spend.ctDigest, groupId: spend.groupId, groupSize: BigInt(spend.groupSize),
  inAmount: per(input => input.amount), inRho: per(input => input.rho), spendSecret: per(input => input.spendSecret),
  path: per(input => input.path), bits: per(input => pathBits(input.index, NOTE_DEPTH)),
  outAmount: spend.outputs.map(output => output.amount), outOwner: spend.outputs.map(output => output.owner), outRandom: spend.outputs.map(output => output.random),
 };
 return { input, slot, publicSignals: [pub, spend.deposit, spend.withdraw, spend.asset, spend.destination] };
}

export const toCircuitInput = (input: Record<string, unknown>) => JSON.parse(JSON.stringify(input, (_, value) => typeof value === 'bigint' ? value.toString() : value));
