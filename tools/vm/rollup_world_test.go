package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"fmt"
	"math/big"
	"math/rand"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	scriptlib "github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

func rollupLE248(b []byte) *big.Int {
	h := sha256.Sum256(b)
	v := new(big.Int)
	for i := 30; i >= 0; i-- {
		v.Lsh(v, 8).Or(v, big.NewInt(int64(h[i])))
	}
	return v
}

func rollupAssetField(id asset.AssetId) *big.Int {
	var index [2]byte
	binary.LittleEndian.PutUint16(index[:], id.Index)
	return rollupLE248(append(append([]byte{}, id.Txid[:]...), index[:]...))
}

func rollupProgram(tag byte) []byte { return bytes.Repeat([]byte{tag}, 32) }

func rollupP2TR(program []byte) []byte { return append([]byte{txscript.OP_1, 0x20}, program...) }

func rollupLE32(v *big.Int) []byte { return stockFieldLE(v) }

// rollupLeg is one slot. inSats/inAsset describe the deposit input the slot
// brings; an asset payout's carrier sats come from the next slot.
type rollupLeg struct {
	dep, wd uint64
	asset   bool
	dest    []byte
	inSats  int64
	inAsset uint64
}

type rollupWorld struct {
	slots              int
	kind               byte
	rng                *rand.Rand
	client, batch      *rollupTrapdoor
	leaf               rollupLeaf
	reserveLeaf        []byte
	x, token           asset.AssetId
	headIn             int64
	xIn                uint64
	oldPacket          []byte
	newState, newDA    []byte
	poolSPK, userSPK   []byte
	emulatorSigningKey *btcec.PrivateKey
}

func newRollupWorld(t *testing.T, slots int, kind byte, seed int64) *rollupWorld {
	t.Helper()
	rng := rand.New(rand.NewSource(seed))
	client := newRollupTrapdoor(rng, nil, 5)
	batch := newRollupTrapdoor(rng, client, slots+1)
	w := &rollupWorld{slots: slots, kind: kind, rng: rng, client: client, batch: batch}
	leaf, err := buildRollupBatchLeaf(rollupLeafConfig{Slots: slots, Kind: kind, Client: client.key, Batch: batch.key})
	if err != nil {
		t.Fatal(err)
	}
	w.leaf = leaf
	w.x = asset.AssetId{Txid: chainhash.Hash{0xaa, 1}, Index: 2}
	w.token = asset.AssetId{Txid: chainhash.Hash{0xcc, 3}, Index: 0}
	if w.reserveLeaf, err = buildRollupReserveLeaf(w.token); err != nil {
		t.Fatal(err)
	}
	w.headIn, w.xIn = 100_330, 10_000
	state := func() []byte { b := make([]byte, 32); rng.Read(b[:31]); return b }
	w.oldPacket = append(state(), state()...)
	w.newState, w.newDA = state(), state()
	w.poolSPK = rollupP2TR(bytes.Repeat([]byte{0x11}, 32))
	w.userSPK = rollupP2TR(bytes.Repeat([]byte{0x22}, 32))
	if w.emulatorSigningKey, err = btcec.NewPrivateKey(); err != nil {
		t.Fatal(err)
	}
	return w
}

// honestLegs: a BTC deposit, an asset deposit whose carrier sats are credited
// as BTC, a BTC payout, an asset payout with its carrier, another BTC payout.
func (w *rollupWorld) honestLegs(withAsset bool) []rollupLeg {
	legs := []rollupLeg{
		{},
		{dep: 5000, inSats: 5000},
		{dep: 700, asset: true, inSats: 330, inAsset: 700},
		{dep: 330},
		{},
		{wd: 2500, dest: rollupProgram(0xa1)},
		{wd: 300, asset: true, dest: rollupProgram(0xb2)},
		{wd: 330, dest: rollupProgram(0xb2)},
		{},
		{wd: 777, dest: rollupProgram(0xc3)},
		{},
	}
	if !withAsset {
		legs[2] = rollupLeg{dep: 700, inSats: 1030}
		legs[6] = rollupLeg{wd: 300, dest: rollupProgram(0xb2)}
	}
	for len(legs) < w.slots {
		legs = append(legs, rollupLeg{})
	}
	return legs[:w.slots]
}

type rollupBatch struct {
	w          *rollupWorld
	legs       []rollupLeg
	reserve    bool
	pubs       []*big.Int
	proofs     []rollupProof
	assetAs    map[int]*big.Int
	zeroDest   map[int]bool
	tx         *wire.MsgTx
	assets     asset.Packet
	prevouts   map[wire.OutPoint]*wire.TxOut
	parents    map[wire.OutPoint]*wire.MsgTx
	newPacket  []byte
	witness    wire.TxWitness
	reserveVin uint16
	batchKind  byte
}

func (w *rollupWorld) batchOf(legs []rollupLeg, reserve bool) *rollupBatch {
	b := &rollupBatch{w: w, legs: legs, reserve: reserve, assetAs: map[int]*big.Int{}, zeroDest: map[int]bool{}, reserveVin: 1, batchKind: w.kind}
	for range legs {
		b.pubs = append(b.pubs, new(big.Int).Rand(w.rng, new(big.Int).Lsh(big.NewInt(1), 248)))
	}
	b.prove()
	b.buildTx()
	b.buildWitness()
	return b
}

func (b *rollupBatch) publics(i int) []*big.Int {
	l := b.legs[i]
	a, d := big.NewInt(0), big.NewInt(0)
	if l.asset && l.dep+l.wd > 0 {
		a = rollupAssetField(b.w.x)
	}
	if v, ok := b.assetAs[i]; ok {
		a = v
	}
	if l.wd > 0 && !b.zeroDest[i] {
		d = rollupLE248(l.dest)
	}
	return []*big.Int{b.pubs[i], new(big.Int).SetUint64(l.dep), new(big.Int).SetUint64(l.wd), a, d}
}

func (b *rollupBatch) prove() {
	b.proofs = nil
	for i := range b.legs {
		b.proofs = append(b.proofs, b.w.client.prove(b.w.rng, b.publics(i)))
	}
}

func (b *rollupBatch) binding() []byte {
	out := []byte{'S', 'H', 2, b.batchKind, byte(b.w.slots)}
	out = append(out, b.w.oldPacket[:32]...)
	return append(out, b.newPacket...)
}

func (b *rollupBatch) buildWitness() {
	st := rollupLE248(b.binding())
	wit := wire.TxWitness(b.w.batch.prove(b.w.rng, append(append([]*big.Int{}, b.pubs...), st)).items())
	for i := len(b.legs) - 1; i >= 0; i-- {
		wit = append(wit, b.proofs[i].items()...)
		wit = append(wit, rollupPublicItems(b.publics(i))...)
	}
	b.witness = wit
}

// rollupPublicItems encodes pub, deposit and withdraw as script numbers, and
// boundaryAsset and destination as 32-byte little-endian; zero is empty.
func rollupPublicItems(x []*big.Int) [][]byte {
	optional := func(v *big.Int, fixed bool) []byte {
		if v.Sign() == 0 {
			return nil
		}
		if fixed {
			return rollupLE32(v)
		}
		return stockScriptNumBytes(v)
	}
	return [][]byte{stockScriptNumBytes(x[0]), optional(x[1], false), optional(x[2], false), optional(x[3], true), optional(x[4], true)}
}

func (b *rollupBatch) buildTx() {
	w := b.w
	b.newPacket = append(append([]byte{}, w.newState...), w.newDA...)
	parent := wire.NewMsgTx(3)
	parent.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: chainhash.Hash{0x70}}})
	parent.AddTxOut(wire.NewTxOut(w.headIn, w.poolSPK))
	oldExt, err := extension.NewExtensionFromPackets(extension.UnknownPacket{PacketType: rollupStatePacket, Data: w.oldPacket})
	if err != nil {
		panic(err)
	}
	oldOut, err := oldExt.TxOut()
	if err != nil {
		panic(err)
	}
	parent.AddTxOut(oldOut)

	tx := wire.NewMsgTx(3)
	b.prevouts = map[wire.OutPoint]*wire.TxOut{}
	b.parents = map[wire.OutPoint]*wire.MsgTx{}
	head := wire.OutPoint{Hash: parent.TxHash()}
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: head, Sequence: wire.MaxTxInSequenceNum - 1})
	b.prevouts[head], b.parents[head] = parent.TxOut[0], parent
	addIn := func(tag byte, out *wire.TxOut) uint16 {
		op := wire.OutPoint{Hash: chainhash.Hash{tag, byte(len(tx.TxIn))}}
		tx.AddTxIn(&wire.TxIn{PreviousOutPoint: op, Sequence: wire.MaxTxInSequenceNum - 1})
		b.prevouts[op] = out
		return uint16(len(tx.TxIn) - 1)
	}
	var nbtc, nx int64
	for _, l := range b.legs {
		if net := int64(l.dep) - int64(l.wd); l.asset {
			nx += net
		} else {
			nbtc += net
		}
	}
	local := asset.AssetInputTypeLocal
	xGroup := asset.AssetGroup{AssetId: &w.x}
	if b.reserve {
		vin := addIn(0x52, wire.NewTxOut(330, w.poolSPK))
		xGroup.Inputs = append(xGroup.Inputs, asset.AssetInput{Type: local, Vin: vin, Amount: w.xIn})
	}
	for _, l := range b.legs {
		if l.inSats == 0 {
			continue
		}
		vin := addIn(0x64, wire.NewTxOut(l.inSats, w.userSPK))
		if l.inAsset > 0 {
			xGroup.Inputs = append(xGroup.Inputs, asset.AssetInput{Type: local, Vin: vin, Amount: l.inAsset})
		}
	}
	tx.AddTxOut(wire.NewTxOut(w.headIn+nbtc, w.poolSPK))
	if b.reserve {
		tx.AddTxOut(wire.NewTxOut(330, w.poolSPK))
		if amount := int64(w.xIn) + nx; amount > 0 {
			xGroup.Outputs = append(xGroup.Outputs, asset.AssetOutput{Type: asset.AssetOutputTypeLocal, Vout: 1, Amount: uint64(amount)})
		}
	}
	var pending uint64
	for _, l := range b.legs {
		switch {
		case l.wd == 0:
		case l.asset:
			pending = l.wd
		default:
			tx.AddTxOut(wire.NewTxOut(int64(l.wd), rollupP2TR(l.dest)))
			if pending > 0 {
				xGroup.Outputs = append(xGroup.Outputs, asset.AssetOutput{Type: asset.AssetOutputTypeLocal, Vout: uint16(len(tx.TxOut) - 1), Amount: pending})
				pending = 0
			}
		}
	}
	tx.AddTxOut(txutils.AnchorOutput())
	b.tx = tx
	b.assets = asset.Packet{{AssetId: &w.token,
		Inputs:  []asset.AssetInput{{Type: local, Vin: 0, Amount: 1}},
		Outputs: []asset.AssetOutput{{Type: asset.AssetOutputTypeLocal, Vout: 0, Amount: 1}}}}
	if len(xGroup.Inputs) > 0 || len(xGroup.Outputs) > 0 {
		b.assets = append(b.assets, xGroup)
	}
}

func (b *rollupBatch) entries() []arkade.EmulatorEntry {
	es := []arkade.EmulatorEntry{{Vin: 0, Script: b.w.leaf.Script, Witness: b.witness}}
	if b.reserve {
		es = append(es, arkade.EmulatorEntry{Vin: b.reserveVin, Script: b.w.reserveLeaf})
	}
	return es
}

func (b *rollupBatch) finalTx() *wire.MsgTx {
	packet, err := arkade.NewPacket(b.entries()...)
	if err != nil {
		panic(err)
	}
	ext, err := extension.NewExtensionFromPackets(packet, extension.UnknownPacket{PacketType: rollupStatePacket, Data: b.newPacket}, b.assets)
	if err != nil {
		panic(err)
	}
	out, err := ext.TxOut()
	if err != nil {
		panic(err)
	}
	tx := b.tx.Copy()
	tx.AddTxOut(out)
	return tx
}

// rollupFetcher answers the original transaction and the logical VTXO script,
// which the live service resolves through each input's checkpoint.
type rollupFetcher struct {
	*txscript.MultiPrevOutFetcher
	prevouts map[wire.OutPoint]*wire.TxOut
	parents  map[wire.OutPoint]*wire.MsgTx
}

func (f rollupFetcher) FetchPrevOutArkTx(o wire.OutPoint) *wire.MsgTx { return f.parents[o] }

func (f rollupFetcher) FetchVtxoPrevOutPkScript(o wire.OutPoint) []byte {
	if out := f.prevouts[o]; out != nil {
		return out.PkScript
	}
	return nil
}

func (b *rollupBatch) execute() error {
	tx := b.finalTx()
	ptx := &psbt.Packet{UnsignedTx: tx, Inputs: make([]psbt.PInput, len(tx.TxIn))}
	key := b.w.emulatorSigningKey.PubKey()
	for _, e := range b.entries() {
		tweaked := arkade.ComputeArkadeScriptPublicKey(key, arkade.ArkadeScriptHash(e.Script))
		leaf, err := (&scriptlib.MultisigClosure{PubKeys: []*btcec.PublicKey{tweaked}}).Script()
		if err != nil {
			return err
		}
		ptx.Inputs[e.Vin] = psbt.PInput{TaprootLeafScript: []*psbt.TaprootTapLeafScript{{Script: leaf, LeafVersion: txscript.BaseLeafVersion}}}
	}
	fetch := rollupFetcher{txscript.NewMultiPrevOutFetcher(b.prevouts), b.prevouts, b.parents}
	for _, e := range b.entries() {
		program, err := arkade.ReadArkadeScript(ptx, key, e)
		if err != nil {
			return fmt.Errorf("vin %d: %w", e.Vin, err)
		}
		if err := program.Execute(tx, fetch, int(e.Vin)); err != nil {
			return fmt.Errorf("vin %d: %w", e.Vin, err)
		}
	}
	return nil
}

func (b *rollupBatch) group(id asset.AssetId) *asset.AssetGroup {
	for i := range b.assets {
		if b.assets[i].AssetId != nil && *b.assets[i].AssetId == id {
			return &b.assets[i]
		}
	}
	return nil
}

func rollupSetOutput(g *asset.AssetGroup, vout uint16, amount uint64) {
	for i := range g.Outputs {
		if g.Outputs[i].Vout == vout {
			g.Outputs[i].Amount = amount
			return
		}
	}
	g.Outputs = append(g.Outputs, asset.AssetOutput{Type: asset.AssetOutputTypeLocal, Vout: vout, Amount: amount})
}

func rollupDropOutput(g *asset.AssetGroup, vout uint16) {
	var keep []asset.AssetOutput
	for _, o := range g.Outputs {
		if o.Vout != vout {
			keep = append(keep, o)
		}
	}
	g.Outputs = keep
}
