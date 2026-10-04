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

func makeAssetFixture(t *testing.T) assetFixture {
	t.Helper()
	previous := wire.NewMsgTx(2)
	previous.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: chainhash.Hash{9}}})
	previous.AddTxOut(&wire.TxOut{Value: 10_000, PkScript: []byte{0x51}})
	issuance, err := asset.NewPacket([]asset.AssetGroup{{Outputs: []asset.AssetOutput{{Type: asset.AssetOutputTypeLocal, Vout: 0, Amount: 7}}}})
	if err != nil {
		t.Fatal(err)
	}
	attachPacket(t, previous, issuance)
	assetID := asset.AssetId{Txid: previous.TxHash(), Index: 0}
	checkpointTx := wire.NewMsgTx(2)
	checkpointTx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: previous.TxHash(), Index: 0}})
	checkpointTx.AddTxOut(previous.TxOut[0])
	checkpointTx.AddTxOut(txutils.AnchorOutput())
	checkpoint := mustPacket(t, checkpointTx)
	checkpoint.Inputs[0].WitnessUtxo = previous.TxOut[0]
	askWire := wire.NewMsgTx(2)
	askWire.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: checkpointTx.TxHash(), Index: 0}})
	askWire.AddTxOut(&wire.TxOut{Value: 10_000, PkScript: []byte{0x51}})
	transfer, err := asset.NewPacket([]asset.AssetGroup{{AssetId: &assetID, Inputs: []asset.AssetInput{{Type: asset.AssetInputTypeLocal, Vin: 0, Amount: 7}}, Outputs: []asset.AssetOutput{{Type: asset.AssetOutputTypeLocal, Vout: 0, Amount: 7}}}})
	if err != nil {
		t.Fatal(err)
	}
	attachPacket(t, askWire, transfer)
	ask := mustPacket(t, askWire)
	ask.Inputs[0].WitnessUtxo = checkpointTx.TxOut[0]
	if err := txutils.SetArkPsbtField(ask, 0, arkade.PrevArkTxField, *previous); err != nil {
		t.Fatal(err)
	}
	return assetFixture{previous: previous, checkpoint: checkpoint, ark: ask, packet: transfer}
}

func TestNativeAssetValidationUsesPreviousOutputPacket(t *testing.T) {
	f := makeAssetFixture(t)
	if err := validateNativeAssets(context.Background(), f.ark, []*psbt.Packet{f.checkpoint}); err != nil {
		t.Fatalf("valid local asset transfer rejected: %v", err)
	}
	f.packet[0].Inputs[0].Amount = 8
	f.packet[0].Outputs[0].Amount = 8
	attachPacket(t, f.ark.UnsignedTx, f.packet)
	if err := validateNativeAssets(context.Background(), f.ark, []*psbt.Packet{f.checkpoint}); err == nil || !strings.Contains(err.Error(), "amount mismatch") {
		t.Fatalf("fabricated asset backing was not rejected: %v", err)
	}
}
