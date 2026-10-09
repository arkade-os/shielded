import { hex } from '@scure/base';
import { BTC_ASSET, NOTE_DEPTH, ROLLUP_DOMAIN, ROLLUP_FIELD, type BatchKind } from './constants.ts';
import { clientWitness, inputNullifierOf, type ClientWitness } from './client.ts';
import { akOf, destinationFieldOf, groupIdOf, noteOf, nullifierOf, outputRhoOf, ownerOf, type Hash } from './notes.ts';
import { NoteFrontier } from './frontier.ts';
import { RollupState, type BatchSlot } from './state.ts';
import { ctDigestOf, openRollupNotes, sealRollupNotes, viewEcdh, type Ecdh, type RollupNote, type RollupRecipient } from './wallet.ts';

/** A slot as the operator publishes it: decimal field elements plus the hex note record. */
export interface PublishedSlot { root: string; nullifiers: string[]; commitments: [string, string]; ctDigest: string; groupId: string; groupSize: number; publics?: string[]; ciphertext?: string }
export interface PublishedBatch { kind: BatchKind; slots: PublishedSlot[]; txid?: string; at?: number }
export interface OwnedNote extends RollupNote { index: number; nullifier: bigint }
/** One slot, or one whole group, that moved this wallet's notes. Amounts are per asset field, BTC being 0. */
export interface HistoryEntry { kind: 'shield' | 'receive' | 'send' | 'withdraw' | 'merge'; batch: number; txid?: string; at?: number; amounts: { asset: bigint; amount: bigint }[]; spent: bigint[]; created: OwnedNote[]; destination?: bigint; slots: number[] }
/** Without `ask` the account watches: it sees notes and spends but cannot build a spend. */
export interface RollupKeys { owner: bigint; nk: bigint; viewSecret: Uint8Array; ask?: bigint }
export interface SpendRequest { asset?: bigint; input?: OwnedNote; inputs?: [OwnedNote, OwnedNote]; to?: { recipient: RollupRecipient; amount: bigint }; deposit?: bigint; withdraw?: bigint; program?: Uint8Array; dummy?: { nk: bigint; rho: bigint } }
export interface BuiltSpend { witness: ClientWitness; ciphertext: Uint8Array; change: bigint }

export const randomField = () => BigInt('0x' + hex.encode(crypto.getRandomValues(new Uint8Array(32)))) % ROLLUP_FIELD;
export const slotOf = (s: PublishedSlot): BatchSlot => ({ root: BigInt(s.root), nullifiers: s.nullifiers.map(BigInt), commitments: [BigInt(s.commitments[0]), BigInt(s.commitments[1])], ctDigest: BigInt(s.ctDigest), groupId: BigInt(s.groupId), groupSize: s.groupSize });

/**
 * Replays every published batch and keeps the unspent notes this key opens. The full replica can also build a batch; a wallet
 * only needs the note frontier, which keeps sync fast at scale.
 */
export class RollupAccount {
 readonly state: RollupState;
 readonly owner: bigint;
 private readonly owned = new Map<bigint, OwnedNote>();
 readonly history: HistoryEntry[] = [];
 /** Every published batch txid, so the wallet can tell pool payouts from outside funding. */
 readonly txids = new Set<string>();
 private readonly frontier?: NoteFrontier;
 private blocks = 0;
 private ecdh?: Promise<Ecdh>;
 private readonly bornAt: number;
 /** bornAt: the first batch that can hold this wallet's notes; a new wallet skips opening every record before it. */
 constructor(private readonly hash: Hash, private readonly keys: RollupKeys, options: { frontier?: boolean; bornAt?: number } = {}) {
  this.bornAt = options.bornAt ?? 0;
  this.state = RollupState.genesis(hash);
  if (options.frontier) this.frontier = new NoteFrontier(hash);
  this.owner = keys.owner;
 }
 static owning(hash: Hash, keys: { ask: bigint; nk: bigint; viewSecret: Uint8Array }, options: { frontier?: boolean; bornAt?: number } = {}): RollupAccount {
  return new RollupAccount(hash, { ...keys, owner: ownerOf(hash, ROLLUP_DOMAIN, akOf(hash, keys.ask), keys.nk) }, options);
 }

 async apply(batch: PublishedBatch): Promise<OwnedNote[]> {
  const number = this.batchCount, base = number * 32;
  if (batch.txid) this.txids.add(batch.txid);
  if (!this.frontier) this.state.apply(batch.kind, batch.slots.map(slotOf));
  const spent = batch.slots.map(slot => slot.nullifiers.flatMap(nf => { const note = this.owned.get(BigInt(nf)); this.owned.delete(BigInt(nf)); return note ? [note] : []; }));
  const created: OwnedNote[][] = batch.slots.map(() => []);
  for (const [i, slot] of batch.slots.entries()) {
   if (!slot.ciphertext || number < this.bornAt) continue;
   const opened = await openRollupNotes(hex.decode(slot.ciphertext), this.keys.viewSecret, await (this.ecdh ??= viewEcdh(this.keys.viewSecret)));
   opened.forEach((note, j) => {
    // A record can claim anything; only a note whose commitment is in the tree under our owner is ours.
    if (!note || note.amount === 0n || noteOf(this.hash, ROLLUP_DOMAIN, note.amount, note.asset, this.owner, note.rho) !== BigInt(slot.commitments[j])) return;
    const mine = { ...note, index: base + 2 * i + j, nullifier: nullifierOf(this.hash, ROLLUP_DOMAIN, this.keys.nk, note.rho) };
    this.owned.set(mine.nullifier, mine); created[i]!.push(mine);
   });
  }
  if (this.frontier) {
   this.frontier.append(batch.slots.flatMap(slot => slot.commitments.map(BigInt)), created.flat().map(n => n.index - base));
   for (const note of spent.flat()) this.frontier.untrack(note.index);
   this.blocks++;
  }
  for (let i = 0; i < batch.slots.length;) {
   let end = i + 1;
   while (batch.slots[i]!.groupId !== '0' && batch.slots[end]?.groupId === batch.slots[i]!.groupId) end++;
   const entry = this.entryOf(batch, number, i, end, spent.slice(i, end).flat(), created.slice(i, end).flat());
   if (entry) this.history.push(entry);
   i = end;
  }
  return created.flat();
 }

 private entryOf(batch: PublishedBatch, number: number, from: number, to: number, spent: OwnedNote[], created: OwnedNote[]): HistoryEntry | undefined {
  const legs = batch.slots.slice(from, to).map(slot => (slot.publics ?? []).map(v => BigInt(v)));
  const sum = (items: { asset: bigint; amount: bigint }[]) => {
   const totals = new Map<bigint, bigint>();
   for (const { asset, amount } of items) totals.set(asset, (totals.get(asset) ?? 0n) + amount);
   return [...totals].filter(([, amount]) => amount > 0n).map(([asset, amount]) => ({ asset, amount }));
  };
  const base = { batch: number, slots: Array.from({ length: to - from }, (_, i) => from + i), ...(batch.txid ? { txid: batch.txid } : {}), ...(batch.at !== undefined ? { at: batch.at } : {}), spent: spent.map(n => n.nullifier), created };
  if (created.length && legs.some(p => (p[1] ?? 0n) > 0n)) return { kind: 'shield', ...base, amounts: sum(legs.map(p => ({ asset: p[3] ?? 0n, amount: p[1] ?? 0n }))) };
  const payout = legs.find(p => (p[2] ?? 0n) > 0n);
  if (spent.length && payout) return { kind: 'withdraw', ...base, amounts: sum(legs.map(p => ({ asset: p[3] ?? 0n, amount: p[2] ?? 0n }))), destination: payout[4] ?? 0n };
  if (spent.length) {
   const amounts = sum([...spent.map(n => ({ asset: n.asset, amount: n.amount })), ...created.map(n => ({ asset: n.asset, amount: -n.amount }))]);
   if (amounts.length) return { kind: 'send', ...base, amounts };
   return batch.kind === 'join' ? { kind: 'merge', ...base, amounts: [] } : undefined;
  }
  return created.length ? { kind: 'receive', ...base, amounts: sum(created.map(n => ({ asset: n.asset, amount: n.amount }))) } : undefined;
 }

 get batchCount(): number { return this.frontier ? this.blocks : this.state.batchCount; }
 /** The root new spends prove against: the note tree after the latest batch, 0 before the first. */
 latestRoot(): bigint { return this.frontier ? (this.blocks ? this.frontier.root() : 0n) : this.state.latestRoot(); }
 notes(asset = BTC_ASSET): OwnedNote[] { return [...this.owned.values()].filter(n => n.asset === asset).sort((a, b) => a.index - b.index); }
 balance(asset = BTC_ASSET): bigint { return this.notes(asset).reduce((sum, n) => sum + n.amount, 0n); }
 /** A note's leaf index, found by its commitment; -1 until its batch is replayed. */
 locate(note: RollupNote, owner: bigint): number {
  if (this.frontier) throw new Error('Locating a note by scanning needs the full replica.');
  const commitment = noteOf(this.hash, ROLLUP_DOMAIN, note.amount, note.asset, owner, note.rho);
  for (let k = 0; k < this.state.noteCount; k++) if (this.state.notes.node(0, k) === commitment) return k;
  return -1;
 }

 spend(request: SpendRequest, self: RollupRecipient, random = randomField, group?: { id: bigint; size: number }): Promise<BuiltSpend> {
  if (this.keys.ask === undefined) return Promise.reject(new Error('This wallet holds a full viewing key, not the spend authority.'));
  const paths = (request.inputs ?? (request.input ? [request.input] : [])).map(n => this.frontier ? this.frontier.path(n.index) : this.state.notes.path(n.index));
  return buildRollupTransfer(this.hash, { root: this.latestRoot(), ask: this.keys.ask, nk: this.keys.nk, self, request, paths, ...(group ? { group } : {}) }, random);
 }

 /** Two notes into one: output 0 pays `to`, or without it holds the whole sum for `self`. */
 join(inputs: [OwnedNote, OwnedNote], self: RollupRecipient, to?: SpendRequest['to']): Promise<BuiltSpend> {
  return this.spend({ asset: inputs[0].asset, inputs, ...(to ? { to } : {}) }, self);
 }

 /** Above `above` unspent notes of an asset, joins the two smallest. */
 async consolidate(self: RollupRecipient, asset = BTC_ASSET, inFlight: ReadonlySet<bigint> = new Set(), above = CONSOLIDATE_ABOVE): Promise<{ inputs: [OwnedNote, OwnedNote]; built: BuiltSpend } | undefined> {
  const notes = this.notes(asset).filter(n => !inFlight.has(n.nullifier)).sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
  if (notes.length <= above) return undefined;
  const inputs: [OwnedNote, OwnedNote] = [notes[0]!, notes[1]!];
  return { inputs, built: await this.join(inputs, self) };
 }

 /**
  * Pays from one note when one covers the amount, else from the two largest in one join when `prefer.join`, else from up
  * to three notes as one atomic group: the batch takes every member or none. Members must be submitted in the returned
  * order, the order the group id commits to.
  */
 async pay(recipient: RollupRecipient, amount: bigint, self: RollupRecipient, inFlight: ReadonlySet<bigint> = new Set(), asset = BTC_ASSET, prefer: { join?: boolean } = {}): Promise<{ kind: BatchKind; spends: BuiltSpend[] }> {
  const notes = this.notes(asset).filter(n => !inFlight.has(n.nullifier)).sort((a, b) => (a.amount < b.amount ? 1 : a.amount > b.amount ? -1 : 0));
  const single = notes.filter(n => n.amount >= amount).pop();
  if (single) return { kind: 'spend', spends: [await this.spend({ asset, input: single, to: { recipient, amount } }, self)] };
  if (prefer.join && notes.length > 1 && notes[0]!.amount + notes[1]!.amount >= amount) return { kind: 'join', spends: [await this.join([notes[0]!, notes[1]!], self, { recipient, amount })] };
  const chosen: OwnedNote[] = [];
  for (const note of notes) { if (chosen.reduce((sum, n) => sum + n.amount, 0n) >= amount || chosen.length === 3) break; chosen.push(note); }
  if (chosen.length < 2 || chosen.reduce((sum, n) => sum + n.amount, 0n) < amount) throw new Error('No three notes together cover this amount.');
  const group = { id: groupIdOf(this.hash, chosen.map(n => n.nullifier)), size: chosen.length };
  let left = amount;
  const legs: BuiltSpend[] = [];
  for (const note of chosen) { const part = note.amount < left ? note.amount : left; left -= part; legs.push(await this.spend({ asset, input: note, to: { recipient, amount: part } }, self, randomField, group)); }
  return { kind: 'spend', spends: legs };
 }

 /** The asset slot carries the deposit coin's units; the BTC slot deposits that coin's sats, so one coin funds the group. */
 async depositAsset(asset: bigint, units: bigint, sats: bigint, self: RollupRecipient): Promise<[BuiltSpend, BuiltSpend]> {
  const dummies = [{ nk: randomField(), rho: randomField() }, { nk: randomField(), rho: randomField() }] as const;
  const group = { id: groupIdOf(this.hash, dummies.map(d => nullifierOf(this.hash, ROLLUP_DOMAIN, d.nk, d.rho, true))), size: 2 };
  return [await this.spend({ asset, deposit: units, dummy: dummies[0] }, self, randomField, group), await this.spend({ deposit: sats, dummy: dummies[1] }, self, randomField, group)];
 }

 /** An asset payout is followed by its BTC carrier to the same program; the carrier pays the 330 sats the payout output holds. */
 async withdrawAsset(asset: bigint, units: bigint, program: Uint8Array, self: RollupRecipient, inFlight: ReadonlySet<bigint> = new Set(), sats = CARRIER_SATS): Promise<[BuiltSpend, BuiltSpend]> {
  if (sats < CARRIER_SATS) throw new Error(`An asset payout carries at least ${CARRIER_SATS} sats.`);
  const smallest = (list: OwnedNote[], amount: bigint) => list.filter(n => !inFlight.has(n.nullifier) && n.amount >= amount).sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0))[0];
  const note = smallest(this.notes(asset), units), carrier = smallest(this.notes(BTC_ASSET), sats);
  if (!note) throw new Error('No single note of this asset covers the amount.');
  if (!carrier) throw new Error(`Withdrawing an asset needs a BTC note of at least ${sats} sats for its carrier.`);
  const group = { id: groupIdOf(this.hash, [note.nullifier, carrier.nullifier]), size: 2 };
  return [await this.spend({ asset, input: note, withdraw: units, program }, self, randomField, group), await this.spend({ input: carrier, withdraw: sats, program }, self, randomField, group)];
 }
}
const CARRIER_SATS = 330n, CONSOLIDATE_ABOVE = 8;

/**
 * One input (spend circuit) or two (join circuit); dummies fill a pure deposit or a padding slot of `width`. Two sealed
 * outputs: the payment, then change to `self`.
 */
export async function buildRollupTransfer(hash: Hash, o: { root: bigint; ask: bigint; nk: bigint; self: RollupRecipient; request: SpendRequest; paths?: bigint[][]; width?: 1 | 2; group?: { id: bigint; size: number } }, random = randomField): Promise<BuiltSpend> {
 const { request } = o, asset = request.asset ?? BTC_ASSET, deposit = request.deposit ?? 0n, withdraw = request.withdraw ?? 0n, paid = request.to?.amount ?? 0n;
 const owned = request.inputs ?? (request.input ? [request.input] : []), width = o.width ?? (owned.length === 2 ? 2 : 1);
 if (owned.length > width || owned.some((n, k) => !o.paths?.[k] || n.asset !== asset)) throw new Error('A note input needs its path and the asset it holds.');
 if (width === 2 && (deposit || withdraw || o.group)) throw new Error('A join carries no deposit, withdrawal or group.');
 if (owned.length === 2 && owned[0]!.index === owned[1]!.index) throw new Error('A join spends two different notes.');
 const inputs = Array.from({ length: width }, (_, k) => owned[k]
  ? { amount: owned[k]!.amount, ask: o.ask, nk: o.nk, rho: owned[k]!.rho, index: owned[k]!.index, path: o.paths![k]! }
  : { amount: 0n, ask: random(), nk: request.dummy?.nk ?? random(), rho: request.dummy?.rho ?? random(), index: 0, path: Array<bigint>(NOTE_DEPTH).fill(0n) });
 if ((withdraw > 0n) !== !!request.program) throw new Error('A withdrawal needs exactly one payout program.');
 const change = inputs.reduce((sum, i) => sum + i.amount, 0n) + deposit - withdraw - paid;
 if (change < 0n || paid < 0n || deposit < 0n || withdraw < 0n) throw new Error('The spend does not balance.');
 const outputs = request.to ? [{ amount: paid, to: request.to.recipient }, { amount: change, to: o.self }] : [{ amount: change, to: o.self }, { amount: 0n, to: o.self }];
 const randoms = [random(), random()], nullifiers = inputs.map(i => inputNullifierOf(hash, ROLLUP_DOMAIN, i));
 const notes = outputs.map((out, j) => ({ amount: out.amount, asset, rho: outputRhoOf(hash, ROLLUP_DOMAIN, randoms[j]!, nullifiers, j) })) as [RollupNote, RollupNote];
 const ciphertext = await sealRollupNotes([outputs[0]!.to, outputs[1]!.to], notes);
 const witness = clientWitness(hash, {
  domain: ROLLUP_DOMAIN, root: o.root, asset, inputs,
  outputs: [{ amount: outputs[0]!.amount, owner: outputs[0]!.to.owner, random: randoms[0]! }, { amount: outputs[1]!.amount, owner: outputs[1]!.to.owner, random: randoms[1]! }],
  deposit, withdraw, destination: request.program ? destinationFieldOf(request.program) : 0n, ctDigest: ctDigestOf(ciphertext), groupId: o.group?.id ?? 0n, groupSize: o.group?.size ?? 0,
 });
 return { witness, ciphertext, change };
}
export const buildRollupSpend = buildRollupTransfer;
