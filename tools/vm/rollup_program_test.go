package main

import (
	"bytes"
	"fmt"
	"math/big"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
)

func rollupExpectReject(t *testing.T, label string, b *rollupBatch, want string) {
	t.Helper()
	err := b.execute()
	if err == nil {
		t.Errorf("%s: accepted", label)
		return
	}
	if !strings.Contains(err.Error(), want) {
		t.Errorf("%s: rejected for another reason: %v", label, err)
	}
}

func rollupTransfers(w *rollupWorld) *rollupBatch {
	return w.batchOf(make([]rollupLeg, w.slots), false)
}

func TestRollupBatchLeafAcceptsTransferBatches(t *testing.T) {
	for _, kind := range []byte{0, 1} {
		w := newRollupWorld(t, 10, kind, 7)
		if w.leaf.ECMul > 50 || w.leaf.Pairs > 16 {
			t.Fatalf("leaf exceeds the per-input caps: %d OP_ECMUL, %d pairs", w.leaf.ECMul, w.leaf.Pairs)
		}
		if err := rollupTransfers(w).execute(); err != nil {
			t.Fatalf("kind %d: transfer batch rejected: %v", kind, err)
		}
		t.Logf("kind %d leaf: %d B, %d OP_ECMUL, %d pairs", kind, len(w.leaf.Script), w.leaf.ECMul, w.leaf.Pairs)
	}
}

func TestRollupBatchLeafRejectsProofAndStateAttacks(t *testing.T) {
	fresh := func() *rollupBatch { return rollupTransfers(newRollupWorld(t, 10, 0, 7)) }
	b := fresh()
	b.proofs[0].A = b.proofs[1].A
	b.buildWitness()
	rollupExpectReject(t, "forged client proof", b, "OP_VERIFY")

	b = fresh()
	b.pubs[3] = new(big.Int).Add(b.pubs[3], big.NewInt(1))
	b.buildWitness()
	rollupExpectReject(t, "batch proof over another pub", b, "OP_VERIFY")

	b = fresh()
	b.newPacket[0] ^= 1
	rollupExpectReject(t, "new state edited after proving", b, "OP_VERIFY")

	b = fresh()
	b.newPacket[64] ^= 1
	rollupExpectReject(t, "note-block root edited after proving", b, "OP_VERIFY")

	b = fresh()
	for op, parent := range b.parents {
		stale := parent.Copy()
		ext, _ := extension.NewExtensionFromPackets(extension.UnknownPacket{PacketType: rollupStatePacket, Data: append(bytes.Repeat([]byte{9}, 32), b.w.oldPacket[32:]...)})
		stale.TxOut[1], _ = ext.TxOut()
		b.parents[op] = stale
	}
	rollupExpectReject(t, "proved against another old state", b, "OP_VERIFY")

	b = fresh()
	b.batchKind = 1
	b.buildWitness()
	rollupExpectReject(t, "join-kind statement on a spend leaf", b, "OP_VERIFY")

	w := newRollupWorld(t, 10, 1, 9)
	b = rollupTransfers(w)
	b.batchKind = 0
	b.buildWitness()
	rollupExpectReject(t, "spend-kind statement on a join leaf", b, "OP_VERIFY")
}

func TestRollupBatchLeafSeparatesBindingVersions(t *testing.T) {
	// A version-4 leaf must refuse a batch whose proofs signed the version-2 statement, and the reverse.
	// Same Kind and Slots in both directions, so only magic[2] differs.
	for _, v := range [][2]byte{{4, 2}, {2, 4}} {
		w := newRollupWorldAt(t, 10, 0, v[0], 7)
		if push := []byte{5, 'S', 'H', v[0], 0, 10}; !bytes.Contains(w.leaf.Script, push) {
			t.Errorf("version %d leaf lacks the pushdata %x", v[0], push)
		}
		b := rollupTransfers(w)
		if err := b.execute(); err != nil {
			t.Fatalf("version %d: honest batch rejected: %v", v[0], err)
		}
		w.version = v[1]
		b.prove()
		b.buildWitness()
		rollupExpectReject(t, fmt.Sprintf("version-%d statement on a version-%d leaf", v[1], v[0]), b, "OP_VERIFY")
	}
	if push := []byte{5, 'S', 'H', 4, 2, 1}; !bytes.Contains(newRollupWorldAt(t, 1, 2, 4, 13).leaf.Script, push) {
		t.Errorf("recover leaf lacks the pushdata %x", push)
	}
	client, batch := rollupFixtureKeys(t)
	for version := byte(0); version < 6; version++ {
		_, err := buildRollupBatchLeaf(rollupLeafConfig{Slots: 10, Version: version, Client: client, Batch: batch})
		if (err == nil) != (version == 2 || version == 4) {
			t.Errorf("version %d: %v", version, err)
		}
	}
}

func TestRollupBatchLeafKeepsTheHead(t *testing.T) {
	fresh := func() *rollupBatch { return rollupTransfers(newRollupWorld(t, 10, 0, 7)) }
	b := fresh()
	b.tx.TxOut[0].Value++
	rollupExpectReject(t, "head value off by one", b, "OP_NUMEQUALVERIFY")

	b = fresh()
	b.tx.TxOut[0].PkScript = b.w.userSPK
	rollupExpectReject(t, "head script replaced", b, "does not preserve source script")

	b = fresh()
	b.group(b.w.token).Outputs[0].Vout = 1
	rollupExpectReject(t, "pool token moved off the head", b, "does not preserve source assets")
}

func TestRollupRecoverLeafAcceptsAWidthOneBatch(t *testing.T) {
	w := newRollupWorldAt(t, 1, 2, 4, 13)
	b := w.batchOf([]rollupLeg{{}}, false)
	if err := b.execute(); err != nil {
		t.Fatalf("width-1 recover batch rejected: %v", err)
	}
}

func TestRollupRecoverProofIsNotSpendableThroughAnotherLeaf(t *testing.T) {
	// The binding's KIND byte is the separation (epoch.circom:262, constants.ts EPOCH_KIND_BYTE).
	var w *rollupWorld
	for _, k := range [][2]byte{{1, 2}, {2, 0}} {
		w = newRollupWorldAt(t, 1, k[0], 4, 13)
		b := w.batchOf([]rollupLeg{{}}, false)
		if err := b.execute(); err != nil {
			t.Fatalf("kind %d: honest batch rejected: %v", k[0], err)
		}
		b.batchKind = k[1]
		b.buildWitness()
		rollupExpectReject(t, fmt.Sprintf("kind-%d statement on a kind-%d leaf", k[1], k[0]), b, "OP_VERIFY")
	}
	cfg := rollupLeafConfig{Slots: 1, Kind: 3, Version: 4, Client: w.client.key, Batch: w.batch.key}
	if _, err := buildRollupBatchLeaf(cfg); err == nil || !strings.Contains(err.Error(), "kind 0, 1 or 2") {
		t.Errorf("kind-3 leaf: %v", err)
	}
	cfg.Slots, cfg.Kind = 10, 2
	if _, err := buildRollupBatchLeaf(cfg); err == nil || !strings.Contains(err.Error(), "batch public inputs") {
		t.Errorf("kind-2 leaf at 10 slots on a 2-public batch key: %v", err)
	}
}
