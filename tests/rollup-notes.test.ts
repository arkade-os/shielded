import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { buildPoseidon } from 'circomlibjs';
import { GROUP_TAG, ROLLUP_DOMAIN } from '../packages/protocol/src/rollup/constants.ts';
import { assetFieldOf, destinationFieldOf, groupIdOf, nullifierOf, ownerOf, sha256le248, statementOf } from '../packages/protocol/src/rollup/notes.ts';

const poseidon = await buildPoseidon();
const hash = (values: bigint[]) => BigInt(poseidon.F.toObject(poseidon(values)));

test('a note\'s nullifier is unique in its rho and separated from dummy nullifiers', () => {
 const nk = 5n, rho = 9n;
 assert.notEqual(nullifierOf(hash, ROLLUP_DOMAIN, nk, rho), nullifierOf(hash, ROLLUP_DOMAIN, nk, rho, true));
 assert.notEqual(nullifierOf(hash, ROLLUP_DOMAIN, nk, rho), nullifierOf(hash, ROLLUP_DOMAIN, nk + 1n, rho));
 assert.notEqual(ownerOf(hash, ROLLUP_DOMAIN, 1n, 2n), ownerOf(hash, ROLLUP_DOMAIN, 2n, 1n));
});

test('sha256-le-248 reads the first 31 digest bytes little-endian', () => {
 const bytes = new TextEncoder().encode('rollup');
 const digest = createHash('sha256').update(bytes).digest();
 const expected = BigInt('0x' + Buffer.from(digest.subarray(0, 31)).reverse().toString('hex'));
 assert.equal(sha256le248(bytes), expected);
 assert.ok(expected < 2n ** 248n);
});

test('asset and destination fields reject malformed lengths and separate distinct ids', () => {
 assert.throws(() => assetFieldOf(new Uint8Array(32)), /34 bytes/);
 assert.throws(() => destinationFieldOf(new Uint8Array(33)), /32 bytes/);
 const a = new Uint8Array(34).fill(1), b = a.slice();
 b[33] = 2;
 assert.notEqual(assetFieldOf(a), assetFieldOf(b));
});

test('group ids commit to two or three ordered first nullifiers', () => {
 assert.equal(groupIdOf(hash, [5n, 6n]), hash([GROUP_TAG, 5n, 6n, 0n]));
 assert.notEqual(groupIdOf(hash, [5n, 6n]), groupIdOf(hash, [6n, 5n]));
 assert.throws(() => groupIdOf(hash, [5n]), /two or three/);
 assert.throws(() => groupIdOf(hash, [1n, 2n, 3n, 4n]), /two or three/);
});

test('the statement hashes every field in circuit order', () => {
 const base = { domain: ROLLUP_DOMAIN, root: 1n, nullifiers: [2n], commitments: [3n, 4n] as [bigint, bigint], ctDigest: 5n, groupId: 0n, groupSize: 0 };
 assert.equal(statementOf(hash, base), hash([ROLLUP_DOMAIN, 1n, 2n, 3n, 4n, 5n, 0n, 0n]));
 assert.notEqual(statementOf(hash, base), statementOf(hash, { ...base, ctDigest: 6n }));
});
