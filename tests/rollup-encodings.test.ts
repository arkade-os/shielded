import assert from 'node:assert/strict';
import test from 'node:test';
import { assetFieldOf, destinationFieldOf, sha256le248 } from '../packages/protocol/src/rollup/notes.ts';
import { bindingOf } from '../packages/protocol/src/rollup/state.ts';

// tools/vm/rollup_vectors_test.go pins the same values for the covenant.
test('asset, destination and statement encodings match the covenant', () => {
 const assetId = new Uint8Array(34);
 assetId.set([0xaa, 1]);
 assetId[32] = 2;
 assert.equal(assetFieldOf(assetId), 58731566653076399333433260003484838053367763420541586868126768447677655521n);
 assert.equal(destinationFieldOf(new Uint8Array(32).fill(0xa1)), 213773286175971319739518410551844573799594910049794260289782295570684116562n);
 assert.equal(sha256le248(bindingOf('spend', 1n, 2n, 3n)), 375285187782611973573682952704180456189630373407897304444805147226734494316n);
});
