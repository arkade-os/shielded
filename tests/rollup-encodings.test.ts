import assert from 'node:assert/strict';
import test from 'node:test';
import { assetFieldOf, assetFieldOfId, destinationFieldOf, sha256le248 } from '../packages/protocol/src/rollup/notes.ts';
import { bindingOf } from '../packages/protocol/src/rollup/state.ts';
import { epochBindingOf } from '../packages/protocol/src/rollup/epoch.ts';

// tools/vm/rollup_vectors_test.go pins the same values for the covenant.
test('asset, destination and statement encodings match the covenant', () => {
 const assetId = new Uint8Array(34);
 assetId.set([0xaa, 1]);
 assetId[32] = 2;
 assert.equal(assetFieldOf(assetId), 58731566653076399333433260003484838053367763420541586868126768447677655521n);
 assert.equal(assetFieldOfId('00'.repeat(30) + '01aa' + '0200'), 58731566653076399333433260003484838053367763420541586868126768447677655521n, 'arkd AssetId strings put the txid in display order');
 assert.equal(destinationFieldOf(new Uint8Array(32).fill(0xa1)), 213773286175971319739518410551844573799594910049794260289782295570684116562n);
 assert.equal(sha256le248(bindingOf('spend', 1n, 2n, 3n, 4n)), 4077123497558877436904460607128046157987782203324772085226874209345128081n);
 assert.deepEqual([...epochBindingOf('recover', 1n, 2n, 3n, 4n).subarray(0, 5)], [0x53, 0x48, 4, 2, 1]);
 assert.equal(sha256le248(epochBindingOf('recover', 1n, 2n, 3n, 4n)), 300214249489708569831815261450252485039625889763785823429463711437391864693n);
});
