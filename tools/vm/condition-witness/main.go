package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"

	"github.com/arkade-os/arkd/pkg/ark-lib/intent"
	"github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type verifyIntentRequest struct {
	Proof       string   `json:"proof"`
	Message     string   `json:"message"`
	SkipPubkeys []string `json:"skipPubkeys"`
	RequireSkip bool     `json:"requireSkip"`
}

func verifyIntentRequestJSON(input io.Reader) error {
	var request verifyIntentRequest
	if err := json.NewDecoder(io.LimitReader(input, 2<<20)).Decode(&request); err != nil {
		return fmt.Errorf("decode intent proof request: %w", err)
	}
	if request.Proof == "" || request.Message == "" {
		return fmt.Errorf("intent proof and message are required")
	}
	skip := make([]*btcec.PublicKey, 0, len(request.SkipPubkeys))
	for _, encoded := range request.SkipPubkeys {
		rawKey, err := hex.DecodeString(encoded)
		if err != nil {
			return fmt.Errorf("parse skipped signer key: %w", err)
		}
		key, err := btcec.ParsePubKey(rawKey)
		if err != nil {
			return fmt.Errorf("parse skipped signer key: %w", err)
		}
		skip = append(skip, key)
	}
	if err := intent.Verify(request.Proof, request.Message, skip); err != nil {
		return err
	}
	if request.RequireSkip && intent.Verify(request.Proof, request.Message, nil) == nil {
		return errors.New("intent proof unexpectedly verifies without the configured operator-key skip")
	}
	return nil
}

type witnessMode int

const (
	missing witnessMode = iota
	empty
	nonEmpty
	duplicate
)

func finalizeCondition(mode witnessMode) error {
	_, serverKey := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	_, emulatorKey := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	profile := bytes.Repeat([]byte{3}, 32)
	condition := append([]byte{32}, profile...)
	condition = append(condition, 0x75, 0x51)
	closure := &script.ConditionMultisigClosure{MultisigClosure: script.MultisigClosure{
		PubKeys: []*btcec.PublicKey{serverKey, emulatorKey}, Type: script.MultisigTypeChecksig,
	}, Condition: condition}
	leaf, err := closure.Script()
	if err != nil {
		return err
	}

	input := psbt.NewPsbtInput(nil, nil)
	input.TaprootLeafScript = []*psbt.TaprootTapLeafScript{{ControlBlock: []byte{0xc0}, Script: leaf, LeafVersion: txscript.BaseLeafVersion}}
	for _, key := range []*btcec.PublicKey{serverKey, emulatorKey} {
		input.TaprootScriptSpendSig = append(input.TaprootScriptSpendSig, &psbt.TaprootScriptSpendSig{
			XOnlyPubKey: schnorr.SerializePubKey(key), LeafHash: bytes.Repeat([]byte{1}, 32), Signature: bytes.Repeat([]byte{2}, 64),
		})
	}
	packet := &psbt.Packet{UnsignedTx: &wire.MsgTx{Version: 2, TxIn: []*wire.TxIn{{Sequence: 0xffffffff}}, TxOut: []*wire.TxOut{{Value: 1}}},
		Inputs: []psbt.PInput{*input}, Outputs: []psbt.POutput{{}}}
	if mode == empty || mode == duplicate {
		if err := txutils.SetArkPsbtField(packet, 0, txutils.ConditionWitnessField, wire.TxWitness{}); err != nil {
			return err
		}
	}
	if mode == nonEmpty {
		if err := txutils.SetArkPsbtField(packet, 0, txutils.ConditionWitnessField, wire.TxWitness{[]byte{1}}); err != nil {
			return err
		}
	}
	if mode == duplicate {
		if err := txutils.SetArkPsbtField(packet, 0, txutils.ConditionWitnessField, wire.TxWitness{}); err != nil {
			return err
		}
	}
	return script.FinalizeVtxoScript(packet, 0)
}

func main() {
	if len(os.Args) > 1 && os.Args[1] == "verify-intent" {
		if err := verifyIntentRequestJSON(os.Stdin); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("verified")
		return
	}
	for _, test := range []struct {
		name string
		mode witnessMode
	}{{"missing", missing}, {"encoded-empty", empty}, {"non-empty", nonEmpty}, {"duplicate", duplicate}} {
		err := finalizeCondition(test.mode)
		fmt.Printf("%s: %v\n", test.name, err)
	}
}
