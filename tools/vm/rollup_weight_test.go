package main

import (
	"bytes"
	"fmt"
	"testing"

	scriptlib "github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

const rollupMaxTxWeight = 40_000

// rollupLeafAndControl returns a two-key leaf and its control block in a tree
// of the given size: the pool tree has four leaves, a user VTXO two.
func rollupLeafAndControl(t *testing.T, leaves int) (leaf, control []byte) {
	t.Helper()
	server, _ := btcec.NewPrivateKey()
	key, _ := btcec.NewPrivateKey()
	leaf, err := (&scriptlib.MultisigClosure{PubKeys: []*btcec.PublicKey{key.PubKey(), server.PubKey()}}).Script()
	if err != nil {
		t.Fatal(err)
	}
	tree := []txscript.TapLeaf{txscript.NewBaseTapLeaf(leaf)}
	for i := 1; i < leaves; i++ {
		tree = append(tree, txscript.NewBaseTapLeaf(append(append([]byte(nil), leaf...), txscript.OP_NOP, byte(i))))
	}
	internal, _ := btcec.NewPrivateKey()
	block := txscript.AssembleTaprootScriptTree(tree...).LeafMerkleProofs[0].ToControlBlock(internal.PubKey())
	if control, err = block.ToBytes(); err != nil {
		t.Fatal(err)
	}
	return leaf, control
}

// signedWeight weighs the final Ark transaction with 64-byte signatures from
// the emulator or user and the server on every input.
func (b *rollupBatch) signedWeight(t *testing.T) int {
	t.Helper()
	tx := b.finalTx()
	headLeaf, headControl := rollupLeafAndControl(t, 4)
	userLeaf, userControl := rollupLeafAndControl(t, 2)
	for i := range tx.TxIn {
		leaf, control := userLeaf, userControl
		if i == 0 || (b.reserve && i == int(b.reserveVin)) {
			leaf, control = headLeaf, headControl
		}
		tx.TxIn[i].Witness = wire.TxWitness{make([]byte, 64), make([]byte, 64), leaf, control}
	}
	var stripped, full bytes.Buffer
	if err := tx.SerializeNoWitness(&stripped); err != nil {
		t.Fatal(err)
	}
	if err := tx.Serialize(&full); err != nil {
		t.Fatal(err)
	}
	return stripped.Len()*3 + full.Len()
}

// rollupReserveDepositInputs is the most deposit inputs a batch that carries
// the asset reserve can bring and still fit; the operator must enforce it.
const rollupReserveDepositInputs = 8

// rollupDeposits fills slots with 1 BTC deposits. With the reserve, the first
// input is an asset deposit whose carrier sats are credited in the next slot.
func rollupDeposits(inputs int, reserve bool) []rollupLeg {
	legs := make([]rollupLeg, 11)
	slot := 0
	if reserve {
		legs[0] = rollupLeg{dep: 1_000_000_000_000, asset: true, inSats: 330, inAsset: 1_000_000_000_000}
		legs[1] = rollupLeg{dep: 330}
		slot, inputs = 2, inputs-1
	}
	for ; inputs > 0; slot, inputs = slot+1, inputs-1 {
		legs[slot] = rollupLeg{dep: 100_000_000, inSats: 100_000_000}
	}
	return legs
}

func TestRollupBatchFitsTheLiveWeightLimit(t *testing.T) {
	w := newRollupWorld(t, 11, 0, 11)
	w.headIn = 10_000_000_000
	weigh := func(name string, legs []rollupLeg, reserve bool) int {
		b := w.batchOf(legs, reserve)
		if err := b.execute(); err != nil {
			t.Fatalf("%s: rejected: %v", name, err)
		}
		weight := b.signedWeight(t)
		t.Logf("%-40s %6d WU, headroom %5d", name, weight, rollupMaxTxWeight-weight)
		return weight
	}
	payouts := make([]rollupLeg, 11)
	for i := range payouts {
		payouts[i] = rollupLeg{wd: 100_000_000, dest: rollupProgram(byte(0x30 + i))}
	}
	for _, mix := range []struct {
		name    string
		legs    []rollupLeg
		reserve bool
	}{
		{"transfers only", make([]rollupLeg, 11), false},
		{"deposits, payouts and an asset", w.honestLegs(true), true},
		{"11 deposits of 1 BTC", rollupDeposits(11, false), false},
		{"11 payouts of 1 BTC", payouts, false},
		{fmt.Sprintf("reserve and %d deposit inputs", rollupReserveDepositInputs), rollupDeposits(rollupReserveDepositInputs, true), true},
	} {
		if weight := weigh(mix.name, mix.legs, mix.reserve); weight > rollupMaxTxWeight {
			t.Errorf("%s: %d WU is over the live %d WU limit", mix.name, weight, rollupMaxTxWeight)
		}
	}
	if next := rollupReserveDepositInputs + 1; next <= 10 {
		if weight := weigh(fmt.Sprintf("reserve and %d deposit inputs", next), rollupDeposits(next, true), true); weight <= rollupMaxTxWeight {
			t.Errorf("the reserve deposit budget is stale: %d inputs fit at %d WU", next, weight)
		}
	}
}
