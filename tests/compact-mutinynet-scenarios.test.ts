import assert from 'node:assert/strict';
import test from 'node:test';
import { digest, financialState } from '../tools/compact-mutinynet-evidence.ts';

function snapshot() {
  return { status: { profileId: 'a'.repeat(64), ready: true, refreshedAt: 'before' },
    native: { heads: { gate: { txid: 'b'.repeat(64) } }, assets: ['BTC', 'DEMO'], genesis: 'fixture-genesis',
      funding: { availableSats: 300_000, allocated: { BTC: 10, DEMO: 20 }, treasury: { BTC: 30, DEMO: 40 } } },
    epoch: 1, lanes: [{ noteRoot: 'root-1', nullifierRoot: 'nullifier-1' }],
    anchors: [{ root: 'root-1', count: 2 }],
    encryptedLog: [{ commitment: 'd'.repeat(64), ciphertext: 'encrypted-note' }],
    activity: [{ id: 'event-1', type: 'shield', status: 'accepted', txid: 'c'.repeat(64), timestamp: 'before',
      commitments: ['d'.repeat(64)] }],
    reserves: [{ asset: 'BTC', reserve: 10, liabilities: 10 }],
    wallets: [{ id: 'alice', publicBalance: { BTC: 0 }, notes: [{ id: 'note-1', asset: 'BTC', amount: 10,
      status: 'spendable', commitment: 'd'.repeat(64), index: 0, owner: 'alice', ciphertext: 'encrypted-note' }] }] };
}

test('financial replay fingerprint canonicalizes snapshots and binds parties, balances, anchors, funding and profile', () => {
  const initial = snapshot();
  const refreshed = structuredClone(initial);
  refreshed.status.refreshedAt = 'after';
  refreshed.activity[0]!.timestamp = 'after';
  refreshed.native.funding.availableSats++;
  assert.equal(financialState(refreshed), financialState(initial));
  assert.equal(digest(financialState(refreshed)), digest(financialState(initial)));
  const reordered = structuredClone(initial);
  reordered.native = Object.fromEntries(Object.entries(reordered.native).reverse()) as typeof reordered.native;
  reordered.native.funding = Object.fromEntries(Object.entries(reordered.native.funding).reverse()) as typeof reordered.native.funding;
  assert.equal(financialState(reordered), financialState(initial));

  const changed = structuredClone(initial);
  changed.wallets[0]!.notes[0]!.amount++;
  assert.notEqual(financialState(changed), financialState(initial));
  changed.wallets[0]!.notes[0]!.amount--;
  changed.wallets[0]!.publicBalance.BTC++;
  assert.notEqual(financialState(changed), financialState(initial));
  changed.wallets[0]!.publicBalance.BTC--;
  changed.lanes[0]!.nullifierRoot = 'nullifier-2';
  assert.notEqual(financialState(changed), financialState(initial));
  changed.lanes[0]!.nullifierRoot = 'nullifier-1';
  changed.reserves[0]!.reserve++;
  assert.notEqual(financialState(changed), financialState(initial));
  changed.reserves[0]!.reserve--;
  changed.anchors[0]!.count++;
  assert.notEqual(financialState(changed), financialState(initial));
  changed.anchors[0]!.count--;
  changed.native.funding.availableSats--;
  assert.equal(financialState(changed), financialState(initial), 'wallet availability is transient and excluded');
  changed.native.funding.allocated.BTC++;
  assert.notEqual(financialState(changed), financialState(initial));
  changed.native.funding.allocated.BTC--;
  changed.native.funding.treasury.DEMO++;
  assert.notEqual(financialState(changed), financialState(initial));
  changed.native.funding.treasury.DEMO--;
  changed.native.heads.gate.txid = 'e'.repeat(64);
  assert.notEqual(financialState(changed), financialState(initial));
  changed.native.heads.gate.txid = 'b'.repeat(64);
  changed.status.profileId = 'f'.repeat(64);
  assert.notEqual(financialState(changed), financialState(initial));
});
