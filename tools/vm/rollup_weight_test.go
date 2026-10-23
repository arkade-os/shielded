package main

import (
	"bytes"
	"encoding/hex"
	"fmt"
	"testing"

	arklib "github.com/arkade-os/arkd/pkg/ark-lib"
	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	scriptlib "github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

const rollupMaxTxWeight = 40_000

// rollupLeafAndControl returns a two-key leaf and the control block of the
// leaf at index in a tree of the given size: the epoch pool tree has six leaves, a
// user VTXO two. Every pool leaf is a two-key script, so only the depth varies.
func rollupLeafAndControl(t *testing.T, leaves, index int) (leaf, control []byte) {
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
	block := txscript.AssembleTaprootScriptTree(tree...).LeafMerkleProofs[index].ToControlBlock(internal.PubKey())
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
	// Indices follow rollupEpochPoolTree in src/rollup/covenant.ts: [exit, renew, reserve, batchRecover, batch, batchJoin].
	headLeaf, headControl := rollupLeafAndControl(t, 6, [...]int{4, 5, 3}[b.batchKind])
	reserveLeaf, reserveControl := rollupLeafAndControl(t, 6, 2)
	userLeaf, userControl := rollupLeafAndControl(t, 2, 0)
	for i := range tx.TxIn {
		leaf, control := userLeaf, userControl
		if i == 0 {
			leaf, control = headLeaf, headControl
		} else if b.reserve && i == int(b.reserveVin) {
			leaf, control = reserveLeaf, reserveControl
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
const rollupReserveDepositInputs = 7

// rollupDeposits fills slots with 1 BTC deposits. With the reserve, the first
// input is an asset deposit whose carrier sats are credited in the next slot.
func rollupDeposits(inputs int, reserve bool) []rollupLeg {
	legs := make([]rollupLeg, 10)
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
	w := newRollupWorld(t, 10, 0, 11)
	w.headIn = 10_000_000_000
	weigh := func(w *rollupWorld, name string, legs []rollupLeg, reserve bool) int {
		b := w.batchOf(legs, reserve)
		if err := b.execute(); err != nil {
			t.Fatalf("%s: rejected: %v", name, err)
		}
		weight := b.signedWeight(t)
		t.Logf("%-40s %6d WU, headroom %5d", name, weight, rollupMaxTxWeight-weight)
		return weight
	}
	payouts := make([]rollupLeg, 10)
	for i := range payouts {
		payouts[i] = rollupLeg{wd: 100_000_000, dest: rollupProgram(byte(0x30 + i))}
	}
	baseline := map[string]int{"transfers only": 35392, "deposits, payouts and an asset": 38710,
		"10 deposits of 1 BTC": 39856, "10 payouts of 1 BTC": 38560, "reserve and 7 deposit inputs": 39792}
	for _, mix := range []struct {
		name    string
		legs    []rollupLeg
		reserve bool
	}{
		{"transfers only", make([]rollupLeg, 10), false},
		{"deposits, payouts and an asset", w.honestLegs(true), true},
		{"10 deposits of 1 BTC", rollupDeposits(10, false), false},
		{"10 payouts of 1 BTC", payouts, false},
		{fmt.Sprintf("reserve and %d deposit inputs", rollupReserveDepositInputs), rollupDeposits(rollupReserveDepositInputs, true), true},
	} {
		weight := weigh(w, mix.name, mix.legs, mix.reserve)
		if weight > rollupMaxTxWeight {
			t.Errorf("%s: %d WU is over the live %d WU limit", mix.name, weight, rollupMaxTxWeight)
		}
		if want, ok := baseline[mix.name]; ok && weight != want {
			t.Errorf("%s: %d WU, was %d with six pool leaves", mix.name, weight, want)
		}
	}
	join := newRollupWorld(t, 10, 1, 11)
	join.headIn = w.headIn
	// A join batch carries no boundary leg, so it needs less headroom than a spend.
	if weight := weigh(join, "join batch, no legs", make([]rollupLeg, 10), false); weight > rollupMaxTxWeight-3_000 {
		t.Errorf("join batch: %d WU leaves under 3,000 WU of headroom", weight)
	}
	recovery := newRollupWorldAt(t, 1, 2, 4, 11)
	if weight := weigh(recovery, "recover batch, width 1, no legs", make([]rollupLeg, 1), false); weight > rollupMaxTxWeight-20_000 {
		t.Errorf("recover batch: %d WU leaves under 20,000 WU of headroom", weight)
	}
	if next := rollupReserveDepositInputs + 1; next <= 9 {
		if weight := weigh(w, fmt.Sprintf("reserve and %d deposit inputs", next), rollupDeposits(next, true), true); weight <= rollupMaxTxWeight {
			t.Errorf("the reserve deposit budget is stale: %d inputs fit at %d WU", next, weight)
		}
	}
}

// The leaves, keys and exit delay are those of world() in tests/rollup-batch-tx.test.ts, whose epoch tree pins the same key.
func TestRollupEpochTreeDerivesTheSameTaprootKeyAsTheSDK(t *testing.T) {
	var token asset.AssetId
	copy(token.Txid[:], bytes.Repeat([]byte{0xcc}, 32))
	manifest, err := buildRollupLeaves(writeRollupLeavesSpec(t, rollupLeavesSpec{Slots: 10, Token: token.String(), Operator: hex.EncodeToString(bytes.Repeat([]byte{0xaa}, 32))}))
	if err != nil {
		t.Fatal(err)
	}
	program := func(text string) []byte {
		b, err := hex.DecodeString(text)
		if err != nil {
			t.Fatal(err)
		}
		return b
	}
	server, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	emulator, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	tweak := func(leaf []byte) *btcec.PublicKey {
		return arkade.ComputeArkadeScriptPublicKey(emulator.PubKey(), arkade.ArkadeScriptHash(leaf))
	}
	collab := func(leaf []byte) scriptlib.Closure {
		return &scriptlib.MultisigClosure{PubKeys: []*btcec.PublicKey{server.PubKey(), tweak(leaf)}}
	}
	batch := program(manifest.Batch)
	exit := &scriptlib.CSVMultisigClosure{
		MultisigClosure: scriptlib.MultisigClosure{PubKeys: []*btcec.PublicKey{tweak(batch)}},
		Locktime:        arklib.RelativeLocktime{Type: arklib.LocktimeTypeSecond, Value: 2048},
	}
	closures := []scriptlib.Closure{exit, collab(program(manifest.Renew)), collab(program(manifest.Reserve)), collab([]byte{0x52}), collab(batch), collab(program(manifest.BatchJoin))}
	scripts := make([]string, len(closures))
	for i, closure := range closures {
		script, err := closure.Script()
		if err != nil {
			t.Fatal(err)
		}
		scripts[i] = hex.EncodeToString(script)
	}
	vtxo, err := scriptlib.ParseVtxoScript(scripts)
	if err != nil {
		t.Fatal(err)
	}
	key, _, err := vtxo.TapTree()
	if err != nil {
		t.Fatal(err)
	}
	const sdkKey = "2a7b49273f971b6160f9430e044d2e3498531f5bfd97fa5cd5bb8f225e22d7ce"
	if got := hex.EncodeToString(schnorr.SerializePubKey(key)); got != sdkKey {
		t.Errorf("arkd derives %s from the six epoch leaves, the SDK test pins %s", got, sdkKey)
	}
}
