package main

import (
	"context"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type assetFixture struct {
	previous   *wire.MsgTx
	checkpoint *psbt.Packet
	ark        *psbt.Packet
	packet     asset.Packet
}

func mustPacket(t *testing.T, tx *wire.MsgTx) *psbt.Packet {
	t.Helper()
	packet, err := psbt.NewFromUnsignedTx(tx)
	if err != nil {
		t.Fatal(err)
	}
	return packet
}

func attachPacket(t *testing.T, tx *wire.MsgTx, packet asset.Packet) {
	t.Helper()
	ext, err := extension.NewExtensionFromPackets(packet)
	if err != nil {
		t.Fatal(err)
	}
	output, err := ext.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	if len(tx.TxOut) > 1 {
		tx.TxOut = tx.TxOut[:len(tx.TxOut)-1]
	}
	tx.AddTxOut(output)
}

func fixture(t *testing.T, previousIndex uint32) assetFixture {
	t.Helper()
	previous := wire.NewMsgTx(2)
	previous.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: chainhash.Hash{9}}})
	for i := uint32(0); i <= previousIndex; i++ {
		previous.AddTxOut(&wire.TxOut{Value: 10_000, PkScript: []byte{0x51}})
	}
	issuance, err := asset.NewPacket([]asset.AssetGroup{{Outputs: []asset.AssetOutput{{Type: asset.AssetOutputTypeLocal, Vout: uint16(previousIndex), Amount: 7}}}})
	if err != nil {
		t.Fatal(err)
	}
	ext, err := extension.NewExtensionFromPackets(issuance)
	if err != nil {
		t.Fatal(err)
	}
	out, err := ext.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	previous.AddTxOut(out)
	checkpointTx := wire.NewMsgTx(2)
	checkpointTx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: previous.TxHash(), Index: previousIndex}})
	checkpointTx.AddTxOut(previous.TxOut[previousIndex])
	checkpointTx.AddTxOut(txutils.AnchorOutput())
	checkpoint := mustPacket(t, checkpointTx)
	checkpoint.Inputs[0].WitnessUtxo = previous.TxOut[previousIndex]
	arkTx := wire.NewMsgTx(2)
	arkTx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: checkpointTx.TxHash(), Index: 0}})
	arkTx.AddTxOut(&wire.TxOut{Value: 10_000, PkScript: []byte{0x51}})
	id := asset.AssetId{Txid: previous.TxHash(), Index: 0}
	packet, err := asset.NewPacket([]asset.AssetGroup{{AssetId: &id, Inputs: []asset.AssetInput{{Type: asset.AssetInputTypeLocal, Vin: 0, Amount: 7}}, Outputs: []asset.AssetOutput{{Type: asset.AssetOutputTypeLocal, Vout: 0, Amount: 7}}}})
	if err != nil {
		t.Fatal(err)
	}
	attachPacket(t, arkTx, packet)
	ark := mustPacket(t, arkTx)
	ark.Inputs[0].WitnessUtxo = checkpointTx.TxOut[0]
	if err := txutils.SetArkPsbtField(ark, 0, arkade.PrevArkTxField, *previous); err != nil {
		t.Fatal(err)
	}
	return assetFixture{previous, checkpoint, ark, packet}
}

func TestNativeAssetValidation(t *testing.T) {
	for _, tc := range []struct {
		name          string
		previousIndex uint32
		modify        func(*testing.T, *assetFixture)
		want          string
	}{
		{name: "genuine transfer"},
		{name: "original output index is not checkpoint output", previousIndex: 3},
		{name: "fabricated declared backing", modify: func(t *testing.T, f *assetFixture) {
			f.packet[0].Inputs[0].Amount = 8
			f.packet[0].Outputs[0].Amount = 8
			attachPacket(t, f.ark.UnsignedTx, f.packet)
		}, want: "amount mismatch"},
		{name: "omitted asset packet", modify: func(_ *testing.T, f *assetFixture) { f.ark.UnsignedTx.TxOut = f.ark.UnsignedTx.TxOut[:1] }, want: "asset packet not found"},
		{name: "asset identity substitution", modify: func(t *testing.T, f *assetFixture) {
			f.packet[0].AssetId = &asset.AssetId{Txid: chainhash.Hash{99}}
			attachPacket(t, f.ark.UnsignedTx, f.packet)
		}, want: "not present in the packet"},
		{name: "new issuance in settlement", modify: func(t *testing.T, f *assetFixture) {
			f.packet[0].AssetId = nil
			f.packet[0].Inputs = nil
			attachPacket(t, f.ark.UnsignedTx, f.packet)
		}, want: "cannot issue"},
		{name: "burning reserves", modify: func(t *testing.T, f *assetFixture) {
			f.packet[0].Outputs[0].Amount = 6
			attachPacket(t, f.ark.UnsignedTx, f.packet)
		}, want: "conserve"},
		{name: "reissuing reserves", modify: func(t *testing.T, f *assetFixture) {
			f.packet[0].Outputs[0].Amount = 8
			attachPacket(t, f.ark.UnsignedTx, f.packet)
		}, want: "cannot issue or reissue"},
		{name: "asset attached to extension output", modify: func(t *testing.T, f *assetFixture) {
			f.packet[0].Outputs[0].Vout = 1
			attachPacket(t, f.ark.UnsignedTx, f.packet)
		}, want: "OP_RETURN"},
		{name: "native BTC overspend", modify: func(_ *testing.T, f *assetFixture) { f.ark.UnsignedTx.TxOut[0].Value = 10_001 }, want: "BTC outputs exceed"},
		{name: "negative native output", modify: func(_ *testing.T, f *assetFixture) { f.ark.UnsignedTx.TxOut[0].Value = -1 }, want: "negative output"},
		{name: "substituted original transaction", modify: func(t *testing.T, f *assetFixture) {
			fake := f.previous.Copy()
			fake.LockTime = 1
			f.ark.Inputs[0].Unknowns = nil
			if err := txutils.SetArkPsbtField(f.ark, 0, arkade.PrevArkTxField, *fake); err != nil {
				t.Fatal(err)
			}
		}, want: "hash mismatch"},
		{name: "missing predecessor", modify: func(_ *testing.T, f *assetFixture) { f.ark.Inputs[0].Unknowns = nil }, want: "exactly one original"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := fixture(t, tc.previousIndex)
			if tc.modify != nil {
				tc.modify(t, &f)
			}
			err := validateNativeAssets(context.Background(), f.ark, []*psbt.Packet{f.checkpoint})
			if tc.want == "" {
				if err != nil {
					t.Fatal(err)
				}
				return
			}
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("expected %q, got %v", tc.want, err)
			}
		})
	}
}

func TestJSONRequestFailsClosed(t *testing.T) {
	for _, data := range []string{`{"arkTx":"x","checkpoints":[],"unexpected":true}`, `{"arkTx":"x"} {}`, `null garbage`} {
		if _, err := decodeRequest(strings.NewReader(data)); err == nil {
			t.Fatalf("accepted malformed envelope %s", data)
		}
	}
	b, err := newBridge()
	if err != nil {
		t.Fatal(err)
	}
	res := b.execute(context.Background(), request{ArkTx: "not PSBT"})
	if res.OK || res.ArkTx != "" || res.Error == "" {
		t.Fatalf("signed invalid request: %+v", res)
	}
}
