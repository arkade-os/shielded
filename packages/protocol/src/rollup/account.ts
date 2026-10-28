import { hex } from '@scure/base';
import { ROLLUP_FIELD } from './constants.ts';
import type { ClientWitness } from './client.ts';
import type { RollupNote, RollupRecipient } from './wallet.ts';

export interface OwnedNote extends RollupNote { index: number; nullifier: bigint }
/** Without `ask` the account watches: it sees notes and spends but cannot build a spend. */
export interface RollupKeys { owner: bigint; nk: bigint; viewSecret: Uint8Array; ask?: bigint }
export interface SnapshotNote { amount: string; asset: string; rho: string; index: number; nullifier: string }
export interface SnapshotEntry { kind: 'shield' | 'receive' | 'send' | 'withdraw' | 'merge'; batch: number; txid?: string; at?: number; amounts: [string, string][]; spent: string[]; created: SnapshotNote[]; destination?: string; slots: number[] }
export interface SpendRequest { asset?: bigint; input?: OwnedNote; inputs?: [OwnedNote, OwnedNote]; to?: { recipient: RollupRecipient; amount: bigint }; deposit?: bigint; withdraw?: bigint; program?: Uint8Array; dummy?: { nk: bigint; rho: bigint } }
export interface BuiltSpend { witness: ClientWitness; ciphertext: Uint8Array; change: bigint }

export const randomField = () => BigInt('0x' + hex.encode(crypto.getRandomValues(new Uint8Array(32)))) % ROLLUP_FIELD;
