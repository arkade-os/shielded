"""Transparent executable semantics for the proposed Arkade shielded design.

NOT cryptography, a wallet, an emulator integration, or a production implementation.
Owners/openings are visible here. Proof verification is modeled by checking the
relation directly. Native outpoints are modeled by compare-and-swap revisions.
A per-asset reserve abstracts the proposal's multiple real vault UTXOs.

Run: python reference_model.py
"""
from __future__ import annotations
import copy
import hashlib
import json
import unittest
from collections import Counter
from dataclasses import dataclass, field, replace


def h(value: object) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(",", ":")).encode()).hexdigest()


class Invalid(ValueError):
    pass


@dataclass(frozen=True)
class Note:
    owner: str
    asset: str
    value: int
    nonce: str

    @property
    def commitment(self) -> str:
        return h(("note", self.owner, self.asset, self.value, self.nonce))


@dataclass
class Lane:
    revision: int = 0
    notes: list[Note] = field(default_factory=list)
    nullifiers: set[str] = field(default_factory=set)


@dataclass(frozen=True)
class Intent:
    owner: str
    anchor: str
    inputs: tuple[tuple[int, int], ...]
    outputs: tuple[Note, ...]
    deposits: tuple[str, ...] = ()  # Native external-coin identifiers.
    withdrawals: tuple[tuple[str, int, str], ...] = ()  # asset, quantity, destination


@dataclass(frozen=True)
class Plan:
    intents: tuple[Intent, ...]
    writer: int
    lane_revisions: tuple[tuple[int, int], ...]
    vault_revisions: tuple[tuple[str, int], ...]


class World:
    def __init__(self, lane_count: int = 4):
        if lane_count < 1 or lane_count & (lane_count - 1):
            raise ValueError("lane_count must be a positive power of two")
        self.lanes = [Lane() for _ in range(lane_count)]
        self.reserves: Counter[str] = Counter()
        self.vault_revisions: Counter[str] = Counter()
        self.external: dict[str, Note] = {}
        self.payouts: list[tuple[str, int, str]] = []
        self.anchors: dict[str, tuple[tuple[str, ...], ...]] = {}
        self.latest_anchor = self._record_anchor()

    def _record_anchor(self) -> str:
        snapshot = tuple(tuple(n.commitment for n in lane.notes) for lane in self.lanes)
        anchor = h(("forest", snapshot))
        self.anchors[anchor] = snapshot
        return anchor

    def seal(self) -> str:
        # Models ONE atomic transaction consuming/recreating EVERY lane head.
        # No note/nullifier/reserve is reset or moved.
        for lane in self.lanes:
            lane.revision += 1
        self.latest_anchor = self._record_anchor()
        return self.latest_anchor

    def nullifier(self, loc: tuple[int, int]) -> str:
        lane, index = loc
        note = self.lanes[lane].notes[index]
        # An actual protocol uses secret-derived PRF material, not owner labels.
        return h(("nullifier", "fixed-system-domain", note.owner, lane, index, note.commitment))

    def route(self, nf: str) -> int:
        return int(nf, 16) % len(self.lanes)

    @staticmethod
    def _check_note(note: Note) -> None:
        if not note.owner or not note.asset or not 0 <= note.value < 2**64:
            raise Invalid("invalid note encoding/range")

    def _check_intent_relation(self, intent: Intent) -> None:
        if intent.anchor not in self.anchors:
            raise Invalid("unrecognized anchor")
        if len(set(intent.inputs)) != len(intent.inputs):
            raise Invalid("duplicate note input")
        if len(set(intent.deposits)) != len(intent.deposits):
            raise Invalid("duplicate deposit")
        balance: Counter[str] = Counter()
        snapshot = self.anchors[intent.anchor]
        for lane, index in intent.inputs:
            if not (0 <= lane < len(self.lanes) and 0 <= index < len(snapshot[lane])):
                raise Invalid("input not in selected anchor")
            note = self.lanes[lane].notes[index]
            if snapshot[lane][index] != note.commitment or note.owner != intent.owner:
                raise Invalid("membership/ownership failure")
            balance[note.asset] += note.value
        for ext_id in intent.deposits:
            if ext_id not in self.external:
                raise Invalid("deposit input already spent or missing")
            note = self.external[ext_id]
            if note.owner != intent.owner:
                raise Invalid("external deposit not authorized")
            self._check_note(note)
            balance[note.asset] += note.value
        for note in intent.outputs:
            self._check_note(note)
            balance[note.asset] -= note.value
        for asset, value, destination in intent.withdrawals:
            if not asset or not destination or not 0 < value < 2**64:
                raise Invalid("invalid withdrawal")
            balance[asset] -= value
        if any(value != 0 for value in balance.values()):
            raise Invalid("asset-by-asset balance failure")

    def _required_resources(self, intents: tuple[Intent, ...], writer: int) -> tuple[set[int], set[str]]:
        if not 0 <= writer < len(self.lanes):
            raise Invalid("writer out of range")
        lane_ids = {writer}
        asset_ids: set[str] = set()
        for intent in intents:
            self._check_intent_relation(intent)
            lane_ids.update(self.route(self.nullifier(loc)) for loc in intent.inputs)
            asset_ids.update(self.external[k].asset for k in intent.deposits)
            asset_ids.update(a for a, _, _ in intent.withdrawals)
        return lane_ids, asset_ids

    def plan(self, *intents: Intent, writer: int = 0) -> Plan:
        if not intents:
            raise Invalid("empty transfer batch")
        lanes, assets = self._required_resources(intents, writer)
        return Plan(intents, writer,
                    tuple((i, self.lanes[i].revision) for i in sorted(lanes)),
                    tuple((a, self.vault_revisions[a]) for a in sorted(assets)))

    def commit(self, plan: Plan) -> None:
        lanes, assets = self._required_resources(plan.intents, plan.writer)
        expected_lanes = tuple((i, self.lanes[i].revision) for i in sorted(lanes))
        expected_vaults = tuple((a, self.vault_revisions[a]) for a in sorted(assets))
        if plan.lane_revisions != expected_lanes or plan.vault_revisions != expected_vaults:
            raise Invalid("missing, substituted, or stale native resource")
        nfs: set[str] = set()
        deposits: set[str] = set()
        for intent in plan.intents:
            for loc in intent.inputs:
                nf = self.nullifier(loc)
                if nf in nfs or nf in self.lanes[self.route(nf)].nullifiers:
                    raise Invalid("double spend")
                nfs.add(nf)
            for ext_id in intent.deposits:
                if ext_id in deposits:
                    raise Invalid("duplicate deposit across batch")
                deposits.add(ext_id)
        # Stage every effect; a failure never partially mutates accepted state.
        staged = copy.deepcopy(self)
        for intent in plan.intents:
            for ext_id in intent.deposits:
                coin = staged.external.pop(ext_id)
                staged.reserves[coin.asset] += coin.value
            for asset, value, destination in intent.withdrawals:
                staged.reserves[asset] -= value
                if staged.reserves[asset] < 0:
                    raise Invalid("insufficient backing liquidity")
                staged.payouts.append((asset, value, destination))
            staged.lanes[plan.writer].notes.extend(intent.outputs)
        for nf in nfs:
            staged.lanes[staged.route(nf)].nullifiers.add(nf)
        for lane in lanes:
            staged.lanes[lane].revision += 1
        for asset in assets:
            staged.vault_revisions[asset] += 1
        self.__dict__.update(staged.__dict__)

    def assert_solvency(self) -> None:
        liabilities: Counter[str] = Counter()
        for i, lane in enumerate(self.lanes):
            for j, note in enumerate(lane.notes):
                nf = self.nullifier((i, j))
                if nf not in self.lanes[self.route(nf)].nullifiers:
                    liabilities[note.asset] += note.value
        assert all(self.reserves[a] >= value for a, value in liabilities.items())


def funded_world() -> World:
    world = World(4)
    world.external["native:A"] = Note("alice", "A", 10, "fundA")
    world.external["native:B"] = Note("alice", "B", 20, "fundB")
    for asset, amount in (("A", 10), ("B", 20)):
        intent = Intent("alice", world.latest_anchor, (),
                        (Note("alice", asset, amount, "first" + asset),),
                        ("native:" + asset,))
        world.commit(world.plan(intent))
    world.seal()
    return world


class SemanticsTests(unittest.TestCase):
    def payment(self, w: World, loc=(0, 0), receiver="bob", nonce="payment") -> Intent:
        note = w.lanes[loc[0]].notes[loc[1]]
        return Intent(note.owner, w.latest_anchor, (loc,),
                      (Note(receiver, note.asset, note.value, nonce),))

    def test_internal_transfer_does_not_touch_vault(self):
        w = funded_world()
        before = dict(w.vault_revisions), dict(w.reserves)
        p = w.plan(self.payment(w))
        self.assertEqual(p.vault_revisions, ())
        w.commit(p)
        self.assertEqual(before, (dict(w.vault_revisions), dict(w.reserves)))
        w.assert_solvency()

    def test_double_spend_rejected_after_rebase(self):
        w = funded_world()
        intent = self.payment(w)
        w.commit(w.plan(intent))
        with self.assertRaisesRegex(Invalid, "double spend"):
            w.commit(w.plan(intent))

    def test_stale_native_outpoint_rejected(self):
        w = funded_world()
        p = w.plan(self.payment(w))
        w.seal()
        with self.assertRaisesRegex(Invalid, "stale native"):
            w.commit(p)

    def test_old_anchor_still_usable(self):
        w = funded_world()
        intent = self.payment(w)
        for _ in range(5):
            w.seal()
        w.commit(w.plan(intent))
        w.assert_solvency()

    def test_sealing_never_resets_nullifiers(self):
        w = funded_world()
        intent = self.payment(w)
        w.commit(w.plan(intent))
        for _ in range(3):
            w.seal()
        with self.assertRaisesRegex(Invalid, "double spend"):
            w.commit(w.plan(intent))

    def test_equal_numeric_sum_cannot_exchange_asset_ids(self):
        w = funded_world()
        bad = Intent("alice", w.latest_anchor, ((0, 0),), (Note("bob", "B", 10, "bad"),))
        with self.assertRaisesRegex(Invalid, "asset-by-asset"):
            w.plan(bad)

    def test_unsealed_note_cannot_be_spent(self):
        w = funded_world()
        w.commit(w.plan(self.payment(w)))
        unsealed = Intent("bob", w.latest_anchor, ((0, 2),), (Note("carol", "A", 10, "next"),))
        with self.assertRaisesRegex(Invalid, "selected anchor"):
            w.plan(unsealed)

    def test_wrong_nullifier_shard_cannot_be_substituted(self):
        w = funded_world()
        p = w.plan(self.payment(w))
        wrong = replace(p, lane_revisions=())
        with self.assertRaisesRegex(Invalid, "native resource"):
            w.commit(wrong)

    def test_unauthorized_owner_rejected(self):
        w = funded_world()
        bad = replace(self.payment(w), owner="mallory")
        with self.assertRaisesRegex(Invalid, "ownership"):
            w.plan(bad)

    def test_deposit_replay_rejected(self):
        w = World()
        w.external["deposit"] = Note("alice", "A", 10, "native")
        d = Intent("alice", w.latest_anchor, (), (Note("alice", "A", 10, "shielded"),), ("deposit",))
        w.commit(w.plan(d))
        with self.assertRaisesRegex(Invalid, "deposit input"):
            w.plan(d)

    def test_invalid_batch_is_atomic(self):
        w = funded_world()
        intent = self.payment(w)
        p = w.plan(intent, intent)
        before = copy.deepcopy(w.__dict__)
        with self.assertRaisesRegex(Invalid, "double spend"):
            w.commit(p)
        self.assertEqual(w.__dict__, before)

    def test_withdrawal_burn_and_native_payout_are_atomic(self):
        w = funded_world()
        out = Intent("alice", w.latest_anchor, ((0, 0),),
                     (Note("alice", "A", 6, "change"),), (), (("A", 4, "alice-native-script"),))
        w.commit(w.plan(out))
        self.assertEqual(w.reserves["A"], 6)
        self.assertEqual(w.payouts, [("A", 4, "alice-native-script")])
        w.assert_solvency()

    def test_disjoint_lane_transactions_can_commit_from_same_snapshot(self):
        w = World(4)
        w.external["funding"] = Note("alice", "A", 100, "native")
        d = Intent("alice", w.latest_anchor, (), tuple(Note("alice", "A", 1, str(i)) for i in range(100)), ("funding",))
        w.commit(w.plan(d))
        w.seal()
        by_lane = {}
        for index in range(100):
            by_lane.setdefault(w.route(w.nullifier((0, index))), (0, index))
        self.assertEqual(len(by_lane), 4)
        lane_a, lane_b = sorted(by_lane)[:2]
        p = w.plan(self.payment(w, by_lane[lane_a], nonce="a"), writer=lane_a)
        q = w.plan(self.payment(w, by_lane[lane_b], nonce="b"), writer=lane_b)
        w.commit(p)
        w.commit(q)
        w.assert_solvency()


if __name__ == "__main__":
    unittest.main(verbosity=2)
