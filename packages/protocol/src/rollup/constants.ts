export const ROLLUP_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;
export const ROLLUP_DOMAIN = 20261017000n;
export const DUMMY_NULLIFIER_TAG = 20261009301n;
export const AK_TAG = 20261009101n;
export const STATE_TAG = 20261007001n;
export const NULLIFIER_TAG = 20261007301n;
export const GROUP_TAG = 20261007401n;
export const WIN_TAG = 20261020001n;
export const ER_TAG = 20261020101n;
export const EPOCH_TAG = 20261020201n;
export const RS_TAG = 20261020301n;
export const ANCHOR_TAG = 20261020401n;
export const NOTE_DEPTH = 32;
export const NULLIFIER_DEPTH = 32;
export const WINDOW_DEPTH = 6;
export const EPOCH_NULLIFIER_DEPTH = 25;
/** A power of two, so the epochR range check has a power-of-two width, and one epoch's 32-leaf blocks fit a depth-25 note tree. */
export const MAX_EPOCH_LEN = 2 ** 20;
export const ARCHIVE_DEPTH = 20;
export const RECOVERED_DEPTH = 32;
export const SUBTREE_DEPTH = 5;
/** The pool serves the note frontier at every multiple of this many batches. */
export const CHECKPOINT_EVERY = 64;
export const BATCH_SLOTS = 10;
export const BTC_ASSET = 0n;
export type BatchKind = 'spend' | 'join';
export const BATCH_KIND_BYTE: Record<BatchKind, number> = { spend: 0, join: 1 };
export type EpochBatchKind = 'spend' | 'join' | 'recover';
export const EPOCH_KIND_BYTE: Record<EpochBatchKind, number> = { spend: 0, join: 1, recover: 2 };
export const EPOCH_SLOTS: Record<EpochBatchKind, number> = { spend: BATCH_SLOTS, join: BATCH_SLOTS, recover: 1 };
export const EPOCH_NULLIFIERS: Record<EpochBatchKind, number> = { spend: 1, join: 2, recover: 1 };

export type RejectionCode = 'slot-count' | 'slot-shape' | 'stale-root' | 'double-spend' | 'nullifier-range' | 'note-tree-full' | 'nullifier-tree-full' | 'group-invalid' | 'stale-anchor' | 'window-tag' | 'epoch-length' | 'recover-unarchived' | 'archive-full';
export class RollupRejection extends Error {
 constructor(readonly code: RejectionCode, message: string) { super(message); }
}
