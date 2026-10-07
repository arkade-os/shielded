package main

import (
	"bytes"
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
		w := newRollupWorld(t, 11, kind, 7)
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
	fresh := func() *rollupBatch { return rollupTransfers(newRollupWorld(t, 11, 0, 7)) }
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

	w := newRollupWorld(t, 11, 1, 9)
	b = rollupTransfers(w)
	b.batchKind = 0
	b.buildWitness()
	rollupExpectReject(t, "spend-kind statement on a join leaf", b, "OP_VERIFY")
}

func TestRollupBatchLeafKeepsTheHead(t *testing.T) {
	fresh := func() *rollupBatch { return rollupTransfers(newRollupWorld(t, 11, 0, 7)) }
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
