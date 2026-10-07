export interface BatchSlot { root: bigint; nullifiers: bigint[]; commitments: [bigint, bigint]; ctDigest: bigint; groupId: bigint; groupSize: number }
