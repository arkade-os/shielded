package main

import (
	"bytes"
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

func TestRollupBatchFitsTheLiveWeightLimit(t *testing.T) {
	everySlot := func(leg func(i int) rollupLeg) []rollupLeg {
		legs := make([]rollupLeg, 11)
		for i := range legs {
			legs[i] = leg(i)
		}
		return legs
	}
	w := newRollupWorld(t, 11, 0, 11)
	for _, mix := range []struct {
		name    string
		legs    []rollupLeg
		reserve bool
	}{
		{"transfers only", make([]rollupLeg, 11), false},
		{"deposits, payouts and an asset", w.honestLegs(true), true},
		{"every slot a BTC deposit", everySlot(func(int) rollupLeg { return rollupLeg{dep: 1000, inSats: 1000} }), false},
		{"every slot a BTC payout", everySlot(func(i int) rollupLeg { return rollupLeg{wd: 1000, dest: rollupProgram(byte(0x30 + i))} }), false},
	} {
		b := w.batchOf(mix.legs, mix.reserve)
		if err := b.execute(); err != nil {
			t.Fatalf("%s: rejected: %v", mix.name, err)
		}
		weight := b.signedWeight(t)
		t.Logf("%-32s %6d WU, headroom %5d", mix.name, weight, rollupMaxTxWeight-weight)
		if weight > rollupMaxTxWeight {
			t.Errorf("%s: %d WU is over the live %d WU limit", mix.name, weight, rollupMaxTxWeight)
		}
	}
}
