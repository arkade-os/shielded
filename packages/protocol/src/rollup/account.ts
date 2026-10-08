import { hex } from '@scure/base';
import { BTC_ASSET, NOTE_DEPTH, ROLLUP_DOMAIN, ROLLUP_FIELD } from './constants.ts';
import { clientWitness, type ClientWitness } from './client.ts';
import { destinationFieldOf, groupIdOf, noteOf, nullifierOf, outputRhoOf, ownerOf, type Hash } from './notes.ts';
import { RollupState, type BatchSlot } from './state.ts';
import { ctDigestOf, openRollupNotes, sealRollupNotes, type RollupNote, type RollupRecipient } from './wallet.ts';

/** A slot as the operator publishes it: decimal field elements plus the hex note record. */
export interface PublishedSlot { root: string; nullifiers: string[]; commitments: [string, string]; ctDigest: string; groupId: string; groupSize: number; ciphertext?: string }
export interface PublishedBatch { kind: 'spend'; slots: PublishedSlot[] }
export interface OwnedNote extends RollupNote { index: number; nullifier: bigint }
export interface RollupKeys { spendSecret: bigint; viewSecret: Uint8Array }
export interface SpendRequest { asset?: bigint; input?: OwnedNote; to?: { recipient: RollupRecipient; amount: bigint }; deposit?: bigint; withdraw?: bigint; program?: Uint8Array; dummy?: { spendSecret: bigint; rho: bigint } }
export interface BuiltSpend { witness: ClientWitness; ciphertext: Uint8Array; change: bigint }

export const randomField = () => BigInt('0x' + hex.encode(crypto.getRandomValues(new Uint8Array(32)))) % ROLLUP_FIELD;
export const slotOf = (s: PublishedSlot): BatchSlot => ({ root: BigInt(s.root), nullifiers: s.nullifiers.map(BigInt), commitments: [BigInt(s.commitments[0]), BigInt(s.commitments[1])], ctDigest: BigInt(s.ctDigest), groupId: BigInt(s.groupId), groupSize: s.groupSize });

/** Replays every published batch into a full state replica and keeps the unspent notes this key opens. */
export class RollupAccount {
 readonly state: RollupState;
 readonly owner: bigint;
 private readonly owned = new Map<bigint, OwnedNote>();
 constructor(private readonly hash: Hash, private readonly keys: RollupKeys) {
  this.state = RollupState.genesis(hash);
  this.owner = ownerOf(hash, ROLLUP_DOMAIN, keys.spendSecret);
 }

 async apply(batch: PublishedBatch): Promise<OwnedNote[]> {
  const base = this.state.noteCount;
  this.state.apply(batch.kind, batch.slots.map(slotOf));
  for (const slot of batch.slots) for (const nf of slot.nullifiers) this.owned.delete(BigInt(nf));
  const found: OwnedNote[] = [];
  for (const [i, slot] of batch.slots.entries()) {
   if (!slot.ciphertext) continue;
   const opened = await openRollupNotes(hex.decode(slot.ciphertext), this.keys.viewSecret);
   opened.forEach((note, j) => {
    // A record can claim anything; only a note whose commitment is in the tree under our owner is ours.
    if (!note || note.amount === 0n || noteOf(this.hash, ROLLUP_DOMAIN, note.amount, note.asset, this.owner, note.rho) !== BigInt(slot.commitments[j])) return;
    const mine = { ...note, index: base + 2 * i + j, nullifier: nullifierOf(this.hash, ROLLUP_DOMAIN, this.keys.spendSecret, note.rho) };
    this.owned.set(mine.nullifier, mine); found.push(mine);
   });
  }
  return found;
 }

 notes(asset = BTC_ASSET): OwnedNote[] { return [...this.owned.values()].filter(n => n.asset === asset).sort((a, b) => a.index - b.index); }
 balance(asset = BTC_ASSET): bigint { return this.notes(asset).reduce((sum, n) => sum + n.amount, 0n); }

 spend(request: SpendRequest, self: RollupRecipient, random = randomField, group?: { id: bigint; size: number }): Promise<BuiltSpend> {
  const path = request.input ? this.state.notes.path(request.input.index) : undefined;
  return buildRollupSpend(this.hash, { root: this.state.latestRoot(), spendSecret: this.keys.spendSecret, self, request, ...(path ? { path } : {}), ...(group ? { group } : {}) }, random);
 }

 /**
  * Pays from one note when one covers the amount, else from up to three notes as one atomic group: the batch takes
  * every member or none. Members must be submitted in the returned order, the order the group id commits to.
  */
 async pay(recipient: RollupRecipient, amount: bigint, self: RollupRecipient, inFlight: ReadonlySet<bigint> = new Set(), asset = BTC_ASSET): Promise<BuiltSpend[]> {
  const notes = this.notes(asset).filter(n => !inFlight.has(n.nullifier)).sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
  const single = notes.filter(n => n.amount >= amount).pop();
  if (single) return [await this.spend({ asset, input: single, to: { recipient, amount } }, self)];
  const chosen: OwnedNote[] = [];
  for (const note of notes) { if (chosen.reduce((sum, n) => sum + n.amount, 0n) >= amount || chosen.length === 3) break; chosen.push(note); }
  if (chosen.length < 2 || chosen.reduce((sum, n) => sum + n.amount, 0n) < amount) throw new Error('No three notes together cover this amount.');
  const group = { id: groupIdOf(this.hash, chosen.map(n => n.nullifier)), size: chosen.length };
  let left = amount;
  const legs: BuiltSpend[] = [];
  for (const note of chosen) { const part = note.amount < left ? note.amount : left; left -= part; legs.push(await this.spend({ asset, input: note, to: { recipient, amount: part } }, self, randomField, group)); }
  return legs;
 }

 /** The asset slot carries the deposit coin's units; the BTC slot deposits that coin's sats, so one coin funds the group. */
 async depositAsset(asset: bigint, units: bigint, sats: bigint, self: RollupRecipient): Promise<[BuiltSpend, BuiltSpend]> {
  const dummies = [{ spendSecret: randomField(), rho: randomField() }, { spendSecret: randomField(), rho: randomField() }] as const;
  const group = { id: groupIdOf(this.hash, dummies.map(d => nullifierOf(this.hash, ROLLUP_DOMAIN, d.spendSecret, d.rho))), size: 2 };
  return [await this.spend({ asset, deposit: units, dummy: dummies[0] }, self, randomField, group), await this.spend({ deposit: sats, dummy: dummies[1] }, self, randomField, group)];
 }

 /** An asset payout is followed by its BTC carrier to the same program; the carrier pays the 330 sats the payout output holds. */
 async withdrawAsset(asset: bigint, units: bigint, program: Uint8Array, self: RollupRecipient, inFlight: ReadonlySet<bigint> = new Set()): Promise<[BuiltSpend, BuiltSpend]> {
  const smallest = (list: OwnedNote[], amount: bigint) => list.filter(n => !inFlight.has(n.nullifier) && n.amount >= amount).sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))[0];
  const note = smallest(this.notes(asset), units), carrier = smallest(this.notes(BTC_ASSET), CARRIER_SATS);
  if (!note) throw new Error('No single note of this asset covers the amount.');
  if (!carrier) throw new Error(`Withdrawing an asset needs a BTC note of at least ${CARRIER_SATS} sats for its carrier.`);
  const group = { id: groupIdOf(this.hash, [note.nullifier, carrier.nullifier]), size: 2 };
  return [await this.spend({ asset, input: note, withdraw: units, program }, self, randomField, group), await this.spend({ input: carrier, withdraw: CARRIER_SATS, program }, self, randomField, group)];
 }
}
const CARRIER_SATS = 330n;

/** One input (a dummy for a pure deposit or padding), two sealed outputs: the payment, then change to `self`. */
export async function buildRollupSpend(hash: Hash, o: { root: bigint; spendSecret: bigint; self: RollupRecipient; request: SpendRequest; path?: bigint[]; group?: { id: bigint; size: number } }, random = randomField): Promise<BuiltSpend> {
 const { request } = o, asset = request.asset ?? BTC_ASSET, deposit = request.deposit ?? 0n, withdraw = request.withdraw ?? 0n, paid = request.to?.amount ?? 0n;
 if (request.input && (!o.path || request.input.asset !== asset)) throw new Error('A note input needs its path and the asset it holds.');
 const input = request.input
  ? { amount: request.input.amount, spendSecret: o.spendSecret, rho: request.input.rho, index: request.input.index, path: o.path! }
  : { amount: 0n, spendSecret: request.dummy?.spendSecret ?? random(), rho: request.dummy?.rho ?? random(), index: 0, path: Array<bigint>(NOTE_DEPTH).fill(0n) };
 if ((withdraw > 0n) !== !!request.program) throw new Error('A withdrawal needs exactly one payout program.');
 const change = input.amount + deposit - withdraw - paid;
 if (change < 0n || paid < 0n || deposit < 0n || withdraw < 0n) throw new Error('The spend does not balance.');
 const outputs = request.to ? [{ amount: paid, to: request.to.recipient }, { amount: change, to: o.self }] : [{ amount: change, to: o.self }, { amount: 0n, to: o.self }];
 const randoms = [random(), random()], nullifiers = [nullifierOf(hash, ROLLUP_DOMAIN, input.spendSecret, input.rho)];
 const notes = outputs.map((out, j) => ({ amount: out.amount, asset, rho: outputRhoOf(hash, ROLLUP_DOMAIN, randoms[j]!, nullifiers, j) })) as [RollupNote, RollupNote];
 const ciphertext = await sealRollupNotes([outputs[0]!.to, outputs[1]!.to], notes);
 const witness = clientWitness(hash, {
  domain: ROLLUP_DOMAIN, root: o.root, asset, inputs: [input],
  outputs: [{ amount: outputs[0]!.amount, owner: outputs[0]!.to.owner, random: randoms[0]! }, { amount: outputs[1]!.amount, owner: outputs[1]!.to.owner, random: randoms[1]! }],
  deposit, withdraw, destination: request.program ? destinationFieldOf(request.program) : 0n, ctDigest: ctDigestOf(ciphertext), groupId: o.group?.id ?? 0n, groupSize: o.group?.size ?? 0,
 });
 return { witness, ciphertext, change };
}
