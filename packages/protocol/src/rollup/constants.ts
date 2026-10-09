export const ROLLUP_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const ROLLUP_DOMAIN = 20261009000n;
export const DUMMY_NULLIFIER_TAG = 20261009301n;
export const STATE_TAG = 20261007001n;
export const NULLIFIER_TAG = 20261007301n;
export const GROUP_TAG = 20261007401n;
export const NOTE_DEPTH = 32;
export const NULLIFIER_DEPTH = 32;
export const WINDOW_DEPTH = 6;
export const SUBTREE_DEPTH = 5;
export const BATCH_SLOTS = 11;
export const BTC_ASSET = 0n;
export type BatchKind = 'spend' | 'join';
export const BATCH_KIND_BYTE: Record<BatchKind, number> = { spend: 0, join: 1 };

export type RejectionCode = 'slot-count' | 'slot-shape' | 'stale-root' | 'double-spend' | 'nullifier-range' | 'note-tree-full' | 'nullifier-tree-full' | 'group-invalid';
export class RollupRejection extends Error {
 constructor(readonly code: RejectionCode, message: string) { super(message); }
}
