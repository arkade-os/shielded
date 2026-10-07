package main

import (
	"bytes"
	"math/big"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

// The honest asset batch: vin 0 head, vin 1 reserve, vin 2-3 deposits; vout 0
// head, vout 1 reserve, vout 2 BTC payout, vout 3 asset payout with its
// carrier, vout 4 BTC payout, vout 5 anchor.
func rollupBoundaryBatch(t *testing.T, mutate func([]rollupLeg)) *rollupBatch {
	t.Helper()
	w := newRollupWorld(t, 11, 0, 7)
	legs := w.honestLegs(true)
	if mutate != nil {
		mutate(legs)
	}
	return w.batchOf(legs, true)
}

func TestRollupBatchLeafAcceptsBoundaryBatches(t *testing.T) {
	w := newRollupWorld(t, 11, 0, 7)
	for _, c := range []struct {
		name    string
		legs    []rollupLeg
		reserve bool
	}{
		{"BTC and asset legs", w.honestLegs(true), true},
		{"BTC legs only", w.honestLegs(false), false},
		{"a reserve riding along a BTC batch", w.honestLegs(false), true},
	} {
		if err := w.batchOf(c.legs, c.reserve).execute(); err != nil {
			t.Fatalf("%s: rejected: %v", c.name, err)
		}
	}
	both := rollupBoundaryBatch(t, func(legs []rollupLeg) {
		legs[4] = rollupLeg{dep: 400, wd: 150, dest: rollupProgram(0xd4), inSats: 400}
	})
	if err := both.execute(); err != nil {
		t.Fatalf("deposit and withdrawal on one slot rejected: %v", err)
	}
}

func TestRollupBatchLeafRejectsBTCLegAttacks(t *testing.T) {
	b := rollupBoundaryBatch(t, nil)
	b.tx.TxOut[2].Value--
	rollupExpectReject(t, "BTC payout underpaid", b, "OP_NUMEQUALVERIFY")

	b = rollupBoundaryBatch(t, nil)
	b.tx.TxOut[2].PkScript = rollupP2TR(rollupProgram(0xdd))
	rollupExpectReject(t, "BTC payout redirected", b, "OP_EQUALVERIFY")

	b = rollupBoundaryBatch(t, nil)
	b.tx.TxOut[2], b.tx.TxOut[4] = b.tx.TxOut[4], b.tx.TxOut[2]
	rollupExpectReject(t, "payouts out of slot order", b, "OP_EQUALVERIFY")

	b = rollupBoundaryBatch(t, func(legs []rollupLeg) { legs[9] = rollupLeg{wd: 2500, dest: rollupProgram(0xa1)} })
	b.tx.TxOut = append(b.tx.TxOut[:4], b.tx.TxOut[5:]...)
	rollupExpectReject(t, "two equal payouts sharing one output", b, "OP_EQUALVERIFY")

	b = rollupBoundaryBatch(t, nil)
	b.zeroDest[9] = true
	b.prove()
	b.buildWitness()
	rollupExpectReject(t, "withdrawal proved with destination 0", b, "OP_EQUALVERIFY")

	b = rollupBoundaryBatch(t, func(legs []rollupLeg) {
		legs[4] = rollupLeg{dep: 400, wd: 150, dest: rollupProgram(0xd4), inSats: 400}
	})
	b.tx.TxOut[2].Value = 0
	rollupExpectReject(t, "both-legs slot paid nothing", b, "OP_NUMEQUALVERIFY")

	b = rollupBoundaryBatch(t, nil)
	b.tx.TxOut[0].Value--
	rollupExpectReject(t, "head credited one sat short", b, "OP_NUMEQUALVERIFY")

	// The proof binds deposit q-5; the witness encodes it as -5 to drain 5 sats.
	b = rollupBoundaryBatch(t, nil)
	b.depositAs[4] = new(big.Int).Sub(rollupScalarField, big.NewInt(5))
	b.prove()
	b.buildWitness()
	b.witness[b.slotItem(4, 9)] = []byte{0x85}
	b.tx.TxOut[0].Value -= 5
	rollupExpectReject(t, "negative deposit drains the head", b, "OP_VERIFY")
}

func TestRollupBatchLeafRejectsAssetAttacks(t *testing.T) {
	other := asset.AssetId{Txid: chainhash.Hash{0xee}, Index: 0}

	b := rollupBoundaryBatch(t, nil)
	x := b.group(b.w.x)
	rollupSetOutput(x, 3, 299)
	rollupSetOutput(x, 1, x.Outputs[0].Amount+1)
	rollupExpectReject(t, "asset payout short by one unit", b, "OP_NUMEQUALVERIFY")

	b = rollupBoundaryBatch(t, nil)
	x = b.group(b.w.x)
	rollupDropOutput(x, 3)
	rollupSetOutput(x, 1, x.Outputs[0].Amount+300)
	b.tx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: chainhash.Hash{0xef}}})
	b.prevouts[b.tx.TxIn[len(b.tx.TxIn)-1].PreviousOutPoint] = wire.NewTxOut(330, b.w.userSPK)
	b.assets = append(b.assets, asset.AssetGroup{AssetId: &other,
		Inputs:  []asset.AssetInput{{Type: asset.AssetInputTypeLocal, Vin: uint16(len(b.tx.TxIn) - 1), Amount: 300}},
		Outputs: []asset.AssetOutput{{Type: asset.AssetOutputTypeLocal, Vout: 3, Amount: 300}}})
	rollupExpectReject(t, "asset payout made in another asset", b, "OP_VERIFY")

	b = rollupBoundaryBatch(t, nil)
	b.assetAs[6] = rollupAssetField(other)
	b.prove()
	b.buildWitness()
	rollupExpectReject(t, "proof for another asset in this batch", b, "OP_EQUALVERIFY")

	// The operator pays the asset correctly but has no carrier slot after it.
	insertPayout := func(b *rollupBatch, at int) {
		b.tx.TxOut = append(b.tx.TxOut[:at], append([]*wire.TxOut{wire.NewTxOut(330, rollupP2TR(rollupProgram(0xb2)))}, b.tx.TxOut[at:]...)...)
		x := b.group(b.w.x)
		var keep []asset.AssetOutput
		for _, o := range x.Outputs {
			if o.Vout == 1 {
				keep = append(keep, o)
			}
		}
		x.Outputs = append(keep, asset.AssetOutput{Type: asset.AssetOutputTypeLocal, Vout: uint16(at), Amount: 300})
	}
	b = rollupBoundaryBatch(t, func(legs []rollupLeg) { legs[7] = rollupLeg{} })
	insertPayout(b, 3)
	rollupExpectReject(t, "asset payout without its carrier slot", b, "OP_VERIFY")

	b = rollupBoundaryBatch(t, func(legs []rollupLeg) { legs[10], legs[6], legs[7] = legs[6], rollupLeg{}, rollupLeg{} })
	insertPayout(b, 4)
	rollupExpectReject(t, "asset payout in the last slot", b, "script returned early")

	b = rollupBoundaryBatch(t, nil)
	x = b.group(b.w.x)
	rollupSetOutput(x, 1, x.Outputs[0].Amount-1)
	rollupSetOutput(x, 4, 1)
	rollupExpectReject(t, "reserve skimmed by one unit", b, "OP_NUMEQUALVERIFY")

	w := newRollupWorld(t, 11, 0, 7)
	b = w.batchOf(w.honestLegs(false), true)
	x = b.group(b.w.x)
	rollupSetOutput(x, 1, b.w.xIn-100)
	rollupSetOutput(x, 2, 100)
	rollupExpectReject(t, "reserve asset rerouted in a BTC batch", b, "OP_NUMEQUALVERIFY")

	b = w.batchOf(w.honestLegs(false), true)
	b.assets = b.assets[:1]
	rollupExpectReject(t, "plain pool-script coin as input 1", b, "asset index out of range")

	b = rollupBoundaryBatch(t, nil)
	for op, out := range b.prevouts {
		if bytes.Equal(out.PkScript, b.w.poolSPK) && op != b.tx.TxIn[0].PreviousOutPoint {
			b.prevouts[op] = wire.NewTxOut(out.Value, b.w.userSPK)
		}
	}
	b.reserve = false
	rollupExpectReject(t, "operator coin posing as the reserve", b, "OP_EQUALVERIFY")
}

func TestRollupReserveLeafRejectsAttacks(t *testing.T) {
	b := rollupBoundaryBatch(t, nil)
	b.tx.TxOut[1].PkScript = b.w.userSPK
	rollupExpectReject(t, "reserve script replaced", b, "vin 1")

	b = rollupBoundaryBatch(t, nil)
	b.tx.TxOut[1].Value = 1
	rollupExpectReject(t, "reserve carrier sats drained", b, "does not preserve source value")

	b = rollupBoundaryBatch(t, nil)
	b.assets = b.assets[1:]
	rollupExpectReject(t, "reserve beside a head without the token", b, "vin 1")

	b = rollupBoundaryBatch(t, nil)
	b.reserveVin = 2
	rollupExpectReject(t, "reserve leaf run at input 2", b, "vin 2")

	second := func() *rollupBatch {
		b := rollupBoundaryBatch(t, nil)
		z := asset.AssetId{Txid: chainhash.Hash{0xab}, Index: 4}
		b.assets = append(b.assets, asset.AssetGroup{AssetId: &z,
			Inputs:  []asset.AssetInput{{Type: asset.AssetInputTypeLocal, Vin: 1, Amount: 50}},
			Outputs: []asset.AssetOutput{{Type: asset.AssetOutputTypeLocal, Vout: 1, Amount: 50}}})
		return b
	}
	if err := second().execute(); err != nil {
		t.Fatalf("reserve holding a second asset rejected: %v", err)
	}
	b = second()
	b.assets[len(b.assets)-1].Outputs[0].Vout = 4
	rollupExpectReject(t, "reserve's second asset rerouted", b, "does not preserve source assets")
}
