import { sha256 } from '@noble/hashes/sha2.js';
import { GROUP_TAG } from './constants.ts';

export type Hash = (values: bigint[]) => bigint;

export const ownerOf = (hash: Hash, domain: bigint, spendSecret: bigint) => hash([domain, spendSecret]);
export const noteOf = (hash: Hash, domain: bigint, amount: bigint, asset: bigint, owner: bigint, rho: bigint) => hash([domain, amount, asset, owner, rho]);
export const nullifierOf = (hash: Hash, domain: bigint, spendSecret: bigint, rho: bigint) => hash([domain, spendSecret, rho]);
export const outputRhoOf = (hash: Hash, domain: bigint, random: bigint, nullifiers: bigint[], index: number) => hash([domain, random, ...nullifiers, BigInt(index)]);

export function groupIdOf(hash: Hash, firstNullifiers: bigint[]): bigint {
 if (firstNullifiers.length < 2 || firstNullifiers.length > 3) throw new Error('A group has two or three members.');
 return hash([GROUP_TAG, firstNullifiers[0], firstNullifiers[1], firstNullifiers[2] ?? 0n]);
}

export interface Statement { domain: bigint; root: bigint; nullifiers: bigint[]; commitments: [bigint, bigint]; ctDigest: bigint; groupId: bigint; groupSize: number }
export const statementOf = (hash: Hash, s: Statement) =>
 hash([s.domain, s.root, ...s.nullifiers, s.commitments[0], s.commitments[1], s.ctDigest, s.groupId, BigInt(s.groupSize)]);

export function sha256le248(bytes: Uint8Array): bigint {
 const digest = sha256(bytes);
 let value = 0n;
 for (let i = 30; i >= 0; i--) value = (value << 8n) | BigInt(digest[i]);
 return value;
}
export function assetFieldOf(assetId: Uint8Array): bigint {
 if (assetId.length !== 34) throw new Error('An Arkade AssetId is 34 bytes.');
 return sha256le248(assetId);
}
export function destinationFieldOf(p2trProgram: Uint8Array): bigint {
 if (p2trProgram.length !== 32) throw new Error('A P2TR program is 32 bytes.');
 return sha256le248(p2trProgram);
}
