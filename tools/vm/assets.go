package main

import (
	"context"
	"errors"
	"fmt"
	"math/big"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

func assetsInTx(tx *wire.MsgTx) (asset.Packet, error) {
	ext, err := extension.NewExtensionFromTx(tx)
	if errors.Is(err, extension.ErrExtensionNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return ext.GetAssetPacket(), nil
}

// validateNativeAssets uses the actual Ark asset validator with allocations
// recovered from the original Ark transactions authenticated by checkpoint
// input hashes. Witness-declared OP_INSPECTINASSET quantities are insufficient.
// Service.SubmitTx subsequently checks the checkpoint's values, script and
// tapleaf, and the same original-transaction relation before VM execution.
func validateNativeAssets(ctx context.Context, arkTx *psbt.Packet, checkpoints []*psbt.Packet) error {
	if arkTx == nil || arkTx.UnsignedTx == nil {
		return errors.New("missing Ark transaction")
	}
	if len(arkTx.Inputs) != len(arkTx.UnsignedTx.TxIn) {
		return errors.New("malformed Ark PSBT")
	}
	if len(checkpoints) != len(arkTx.Inputs) {
		return errors.New("checkpoint count does not match inputs")
	}
	byID := make(map[string]*psbt.Packet, len(checkpoints))
	for _, checkpoint := range checkpoints {
		if checkpoint == nil || checkpoint.UnsignedTx == nil || len(checkpoint.UnsignedTx.TxIn) != 1 {
			return errors.New("checkpoint must have exactly one input")
		}
		id := checkpoint.UnsignedTx.TxID()
		if _, duplicate := byID[id]; duplicate {
			return errors.New("duplicate checkpoint")
		}
		byID[id] = checkpoint
	}
	prevouts := make(map[int][]asset.Asset)
	inputSats := new(big.Int)
	seen := make(map[wire.OutPoint]struct{})
	for vin, txIn := range arkTx.UnsignedTx.TxIn {
		checkpoint, ok := byID[txIn.PreviousOutPoint.Hash.String()]
		if !ok {
			return fmt.Errorf("missing checkpoint for input %d", vin)
		}
		if txIn.PreviousOutPoint.Index != 0 {
			return fmt.Errorf("input %d must spend checkpoint output 0", vin)
		}
		originalOutpoint := checkpoint.UnsignedTx.TxIn[0].PreviousOutPoint
		if _, duplicate := seen[originalOutpoint]; duplicate {
			return errors.New("duplicate original VTXO input")
		}
		seen[originalOutpoint] = struct{}{}
		fields, err := txutils.GetArkPsbtFields(arkTx, vin, arkade.PrevArkTxField)
		if err != nil || len(fields) != 1 {
			return fmt.Errorf("input %d needs exactly one original Ark transaction", vin)
		}
		original := &fields[0]
		if original.TxHash() != originalOutpoint.Hash {
			return fmt.Errorf("input %d original Ark transaction hash mismatch", vin)
		}
		if int(originalOutpoint.Index) >= len(original.TxOut) {
			return fmt.Errorf("input %d original output out of range", vin)
		}
		previousOutput := original.TxOut[originalOutpoint.Index]
		if previousOutput.Value < 0 {
			return errors.New("negative input value")
		}
		inputSats.Add(inputSats, big.NewInt(previousOutput.Value))
		previousPacket, err := assetsInTx(original)
		if err != nil {
			return fmt.Errorf("input %d original asset packet: %w", vin, err)
		}
		for groupIndex, group := range previousPacket {
			id := group.AssetId
			if id == nil {
				id = &asset.AssetId{Txid: original.TxHash(), Index: uint16(groupIndex)}
			}
			for _, allocation := range group.Outputs {
				if allocation.Type == asset.AssetOutputTypeLocal && uint32(allocation.Vout) == originalOutpoint.Index {
					prevouts[vin] = append(prevouts[vin], asset.Asset{AssetId: id.String(), Amount: allocation.Amount})
				}
			}
		}
	}
	outputSats := new(big.Int)
	for _, output := range arkTx.UnsignedTx.TxOut {
		if output.Value < 0 {
			return errors.New("negative output value")
		}
		outputSats.Add(outputSats, big.NewInt(output.Value))
	}
	if outputSats.Cmp(inputSats) > 0 {
		return errors.New("native BTC outputs exceed authenticated inputs")
	}
	packet, err := assetsInTx(arkTx.UnsignedTx)
	if err != nil {
		return fmt.Errorf("current asset packet: %w", err)
	}
	for _, group := range packet {
		if group.IsIssuance() || group.IsReissuance() {
			return errors.New("settlement cannot issue or reissue assets")
		}
		inputs, outputs := new(big.Int), new(big.Int)
		for _, input := range group.Inputs {
			inputs.Add(inputs, new(big.Int).SetUint64(input.Amount))
		}
		for _, output := range group.Outputs {
			outputs.Add(outputs, new(big.Int).SetUint64(output.Amount))
		}
		if inputs.Cmp(outputs) != 0 {
			return errors.New("settlement must conserve every native asset exactly")
		}
	}
	if err := asset.ValidateAssetTransaction(ctx, arkTx.UnsignedTx, packet, prevouts, nil); err != nil {
		return err
	}
	return nil
}
