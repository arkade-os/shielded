import { createHash } from 'node:crypto';

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort()
    .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}

export function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function financialState(state: Record<string, any>): string {
  const activity = state.activity.map((item: Record<string, unknown>) => {
    const fields = Object.entries(item).filter(([key]) => ['boundary', 'checkpointWeights', 'commitments', 'id',
      'nativeWeight', 'nullifiers', 'proofBytes', 'proofTransport', 'statement', 'status', 'summary', 'txid', 'type'].includes(key));
    return Object.fromEntries(fields);
  });
  const wallets = state.wallets.map((wallet: Record<string, any>) => ({ id: wallet.id,
    publicBalance: wallet.publicBalance, notes: wallet.notes.map((note: Record<string, unknown>) => ({ id: note.id,
      asset: note.asset, amount: note.amount, status: note.status, commitment: note.commitment,
      index: note.index, owner: note.owner, ciphertext: note.ciphertext })) }));
  return JSON.stringify(canonical({ profileId: state.status.profileId, heads: state.native.heads,
    epoch: state.epoch, lanes: state.lanes, anchors: state.anchors,
    allocatedFunding: state.native.funding?.allocated, treasuryFunding: state.native.funding?.treasury,
    encryptedLog: state.encryptedLog?.map((entry: Record<string, unknown>) => ({ commitment: entry.commitment, ciphertext: entry.ciphertext })),
    nativeAssets: state.native.assets, genesis: state.native.genesis, activity, reserves: state.reserves, wallets }));
}
