package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	scriptlib "github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

const rollupRegisterMessage = `{"type":"register","onchain_output_indexes":[],"valid_at":0,"expire_at":0,"cosigners_public_keys":["02aa"]}`

var rollupRenewalOperator, _ = btcec.PrivKeyFromBytes(bytes.Repeat([]byte{0x42}, 32))

type rollupRenewal struct {
	message         string
	swap            bool
	statePacket     []byte
	headOut         *wire.TxOut
	reserveOutAsset uint64
	signedCosigners string
	signedVout      uint32
	signer          byte
	unsigned        bool
}

// rollupRenewalDigest is what the operator signs: tests/rollup-renewal.test.ts pins the same vector.
func rollupRenewalDigest(cosigners string, head wire.OutPoint) [32]byte {
	return sha256.Sum256(append(append([]byte(cosigners), head.Hash[:]...), rollupScriptNum(head.Index)...))
}

func TestRollupRenewalDigestVector(t *testing.T) {
	txid, err := chainhash.NewHashFromStr(strings.Repeat("11", 31) + "22")
	if err != nil {
		t.Fatal(err)
	}
	digest := rollupRenewalDigest(`["02aa"]`, wire.OutPoint{Hash: *txid, Index: 1})
	if got := hex.EncodeToString(digest[:]); got != "6944d7770653359361fe902a84dbbc6c04215166753f1e9001da525711c4906e" {
		t.Fatalf("renewal digest %s", got)
	}
}

func rollupScriptNum(v uint32) []byte {
	var out []byte
	for ; v > 0; v >>= 8 {
		out = append(out, byte(v))
	}
	if len(out) > 0 && out[len(out)-1]&0x80 != 0 {
		out = append(out, 0)
	}
	return out
}

// run builds the intent proof [message, head, reserve] -> [head', reserve',
// extension] and executes the renewal leaf on inputs 1 and 2.
func (c rollupRenewal) run(t *testing.T) error {
	t.Helper()
	w := newRollupWorld(t, 11, 0, 9)
	leaf, err := buildRollupRenewalLeaf(w.token, schnorr.SerializePubKey(rollupRenewalOperator.PubKey()))
	if err != nil {
		t.Fatal(err)
	}
	parent := wire.NewMsgTx(3)
	parent.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: chainhash.Hash{0x70}}})
	parent.AddTxOut(wire.NewTxOut(w.headIn, w.poolSPK))
	parent.AddTxOut(wire.NewTxOut(330, w.poolSPK))
	parentExt, err := extension.NewExtensionFromPackets(extension.UnknownPacket{PacketType: rollupStatePacket, Data: w.oldPacket})
	if err != nil {
		t.Fatal(err)
	}
	parentOut, err := parentExt.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	parent.AddTxOut(parentOut)

	head, reserve := wire.OutPoint{Hash: parent.TxHash(), Index: 0}, wire.OutPoint{Hash: parent.TxHash(), Index: 1}
	headOut, reserveOut := wire.NewTxOut(w.headIn, w.poolSPK), wire.NewTxOut(330, w.poolSPK)
	if c.headOut != nil {
		headOut = c.headOut
	}
	ins, outs := []wire.OutPoint{head, reserve}, []*wire.TxOut{headOut, reserveOut}
	pVin, xVin, pVout, xVout := uint16(1), uint16(2), uint16(0), uint16(1)
	if c.swap {
		ins, outs = []wire.OutPoint{reserve, head}, []*wire.TxOut{reserveOut, headOut}
		pVin, xVin, pVout, xVout = 2, 1, 1, 0
	}
	xOut := w.xIn
	if c.reserveOutAsset != 0 {
		xOut = c.reserveOutAsset
	}
	local := asset.AssetInputTypeLocal
	assets := asset.Packet{
		{AssetId: &w.token, Inputs: []asset.AssetInput{{Type: local, Vin: pVin, Amount: 1}}, Outputs: []asset.AssetOutput{{Type: asset.AssetOutputTypeLocal, Vout: pVout, Amount: 1}}},
		{AssetId: &w.x, Inputs: []asset.AssetInput{{Type: local, Vin: xVin, Amount: w.xIn}}, Outputs: []asset.AssetOutput{{Type: asset.AssetOutputTypeLocal, Vout: xVout, Amount: xOut}}},
	}
	state := w.oldPacket
	if c.statePacket != nil {
		state = c.statePacket
	}
	ext, err := extension.NewExtensionFromPackets(assets, extension.UnknownPacket{PacketType: rollupStatePacket, Data: state})
	if err != nil {
		t.Fatal(err)
	}
	extOut, err := ext.TxOut()
	if err != nil {
		t.Fatal(err)
	}

	tx := wire.NewMsgTx(2)
	message := wire.OutPoint{Hash: chainhash.Hash{0x99}}
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: message})
	prevouts := map[wire.OutPoint]*wire.TxOut{message: wire.NewTxOut(0, w.poolSPK)}
	parents := map[wire.OutPoint]*wire.MsgTx{}
	for _, in := range ins {
		tx.AddTxIn(&wire.TxIn{PreviousOutPoint: in})
		prevouts[in], parents[in] = parent.TxOut[in.Index], parent
	}
	for _, out := range outs {
		tx.AddTxOut(out)
	}
	tx.AddTxOut(extOut)

	var witness wire.TxWitness
	if !c.unsigned {
		cosigners := c.signedCosigners
		if cosigners == "" {
			cosigners = `["02aa"]`
		}
		first := tx.TxIn[1].PreviousOutPoint
		first.Index += c.signedVout
		digest := rollupRenewalDigest(cosigners, first)
		signer := rollupRenewalOperator
		if c.signer != 0 {
			signer, _ = btcec.PrivKeyFromBytes(bytes.Repeat([]byte{c.signer}, 32))
		}
		sig, err := schnorr.Sign(signer, digest[:])
		if err != nil {
			t.Fatal(err)
		}
		witness = wire.TxWitness{sig.Serialize()}
	}
	key := w.emulatorSigningKey.PubKey()
	tweaked := arkade.ComputeArkadeScriptPublicKey(key, arkade.ArkadeScriptHash(leaf))
	closure, err := (&scriptlib.MultisigClosure{PubKeys: []*btcec.PublicKey{tweaked}}).Script()
	if err != nil {
		t.Fatal(err)
	}
	ptx := &psbt.Packet{UnsignedTx: tx, Inputs: make([]psbt.PInput, len(tx.TxIn))}
	fetch := rollupFetcher{txscript.NewMultiPrevOutFetcher(prevouts), prevouts, parents}
	for vin := 1; vin <= 2; vin++ {
		ptx.Inputs[vin] = psbt.PInput{TaprootLeafScript: []*psbt.TaprootTapLeafScript{{Script: closure, LeafVersion: txscript.BaseLeafVersion}}}
		program, err := arkade.ReadArkadeScript(ptx, key, arkade.EmulatorEntry{Vin: uint16(vin), Script: leaf, Witness: witness})
		if err != nil {
			return err
		}
		var opts []arkade.ExecuteOption
		if c.message != "" {
			opts = append(opts, arkade.WithIntentMessage(c.message))
		}
		if err := program.Execute(tx, fetch, vin, opts...); err != nil {
			return fmt.Errorf("vin %d: %w", vin, err)
		}
	}
	return nil
}

func TestRollupRenewalLeaf(t *testing.T) {
	if err := (rollupRenewal{message: rollupRegisterMessage}).run(t); err != nil {
		t.Fatalf("operator renewal rejected: %v", err)
	}
	w := newRollupWorld(t, 11, 0, 9)
	changed := bytes.Clone(w.oldPacket)
	changed[0] ^= 1
	for name, c := range map[string]rollupRenewal{
		"outside an intent":        {},
		"delete message":           {message: `{"type":"delete","expire_at":0}`},
		"state changed":            {message: rollupRegisterMessage, statePacket: changed},
		"head not at input 1":      {message: rollupRegisterMessage, swap: true},
		"head value skimmed":       {message: rollupRegisterMessage, headOut: wire.NewTxOut(w.headIn-1, w.poolSPK)},
		"head script replaced":     {message: rollupRegisterMessage, headOut: wire.NewTxOut(w.headIn, w.userSPK)},
		"reserve asset skimmed":    {message: rollupRegisterMessage, reserveOutAsset: w.xIn - 1},
		"no operator signature":    {message: rollupRegisterMessage, unsigned: true},
		"signature by another key": {message: rollupRegisterMessage, signer: 0x43},
		"signed for another head":  {message: rollupRegisterMessage, signedVout: 1},
		"cosigners swapped":        {message: rollupRegisterMessage, signedCosigners: `["02bb"]`},
	} {
		if err := c.run(t); err == nil {
			t.Errorf("%s: renewal accepted", name)
		}
	}
	if _, err := buildRollupRenewalLeaf(w.token, make([]byte, 33)); err == nil {
		t.Error("a 33-byte operator key built a renewal leaf")
	}
}
