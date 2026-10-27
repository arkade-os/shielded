import { BATCH_SLOTS, EPOCH_KIND_BYTE, RollupRejection } from './constants.ts';
import { groupIdOf, type Hash } from './notes.ts';

export interface BatchSlot { root: bigint; nullifiers: bigint[]; commitments: [bigint, bigint]; ctDigest: bigint; groupId: bigint; groupSize: number }

const le32 = (value: bigint) => Uint8Array.from({ length: 32 }, (_, i) => Number((value >> BigInt(8 * i)) & 255n));
export const bindingOf = (kind: 'spend' | 'join', oldCommitment: bigint, newCommitment: bigint, daRoot: bigint, blockRoot: bigint) =>
 Uint8Array.from([0x53, 0x48, 2, EPOCH_KIND_BYTE[kind], BATCH_SLOTS, ...le32(oldCommitment), ...le32(newCommitment), ...le32(daRoot), ...le32(blockRoot)]);

export function validateGroups(hash: Hash, slots: Pick<BatchSlot, 'nullifiers' | 'groupId' | 'groupSize'>[]): void {
 const bad = (why: string) => new RollupRejection('group-invalid', why);
 for (let i = 0; i < slots.length; i++) {
  const { groupId, groupSize } = slots[i];
  if (![0, 2, 3].includes(groupSize) || (groupId === 0n) !== (groupSize === 0)) throw bad('A group has two or three members and a nonzero id.');
  if (groupId === 0n || (i > 0 && slots[i - 1].groupId === groupId)) continue;
  const members = slots.slice(i, i + groupSize);
  if (members.length !== groupSize || members.some(member => member.groupId !== groupId || member.groupSize !== groupSize) || slots[i + groupSize]?.groupId === groupId) throw bad('Group members must fill consecutive slots exactly.');
  if (groupIdOf(hash, members.map(member => member.nullifiers[0])) !== groupId) throw bad('The group id does not commit to its members.');
 }
}
