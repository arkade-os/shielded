package main

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/arkade-os/emulator/pkg/emulator"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

const stockOnchainGateEnv = "SHIELDED_STOCK_ONCHAIN_GATE_INPUT"

type stockOnchainGateInput struct {
	Cases []stockOnchainGateCase `json:"cases"`
}

type stockOnchainGateCase struct {
	Name string `json:"name"`
	PSBT string `json:"psbt"`
}

type stockOnchainGateCaseResult struct {
	Name       string `json:"name"`
	OK         bool   `json:"ok"`
	SignedPSBT string `json:"signedPsbt,omitempty"`
	Error      string `json:"error,omitempty"`
}

type stockOnchainGateResult struct {
	Version int                          `json:"version"`
	Backend string                       `json:"backend"`
	Cases   []stockOnchainGateCaseResult `json:"cases"`
}

// TestStockOnchainGateHarness executes caller-built, proof-bearing CSV exit
// PSBTs through the exact pinned emulator Service.SubmitOnchainTx. Its keys
// are deterministic public test fixtures; this test does not broadcast.
func TestStockOnchainGateHarness(t *testing.T) {
	path := os.Getenv(stockOnchainGateEnv)
	if path == "" {
		assertStockOnchainRejectsMissingEmulatorPacket(t)
		return
	}

	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read stock onchain gate input: %v", err)
	}
	if len(data) == 0 || len(data) > 64<<20 {
		t.Fatalf("stock onchain gate input size must be 1..%d bytes", 64<<20)
	}
	var input stockOnchainGateInput
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&input); err != nil {
		t.Fatalf("decode stock onchain gate input: %v", err)
	}
	if len(input.Cases) != 3 {
		t.Fatalf("stock onchain gate requires exactly three exit cases, got %d", len(input.Cases))
	}

	emulatorKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	serverKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	service, err := emulator.New(emulatorKey, nil, nil, serverKey.PubKey(), arkade.DefaultComputeLimits())
	if err != nil {
		t.Fatalf("construct pinned emulator service: %v", err)
	}

	result := stockOnchainGateResult{
		Version: 1,
		Backend: "pinned-emulator-Service.SubmitOnchainTx",
		Cases:   make([]stockOnchainGateCaseResult, 0, len(input.Cases)),
	}
	seen := make(map[string]bool, len(input.Cases))
	for _, item := range input.Cases {
		if item.Name == "" || seen[item.Name] {
			t.Fatalf("stock onchain gate case names must be non-empty and unique")
		}
		seen[item.Name] = true
		decoded, err := base64.StdEncoding.DecodeString(item.PSBT)
		if err != nil {
			t.Fatalf("decode case %q PSBT base64: %v", item.Name, err)
		}
		packet, err := psbt.NewFromRawBytes(bytes.NewReader(decoded), false)
		if err != nil {
			t.Fatalf("parse case %q PSBT: %v", item.Name, err)
		}
		signed, err := service.SubmitOnchainTx(context.Background(), emulator.OnchainTx{Tx: packet})
		if err != nil {
			t.Fatalf("pinned Service.SubmitOnchainTx rejected case %q: %v", item.Name, err)
		}
		encoded, err := signed.B64Encode()
		if err != nil {
			t.Fatalf("encode signed case %q PSBT: %v", item.Name, err)
		}
		result.Cases = append(result.Cases, stockOnchainGateCaseResult{Name: item.Name, OK: true, SignedPSBT: encoded})
	}

	encoded, err := json.Marshal(result)
	if err != nil {
		t.Fatal(err)
	}
	fmt.Printf("STOCK_ONCHAIN_GATE_RESULT=%s\n", encoded)
}

// The ordinary test suite proves that the pinned service rejects an onchain
// transaction before the gate supplies real CSV-path fixtures. This is an
// actual service call, not a skipped or passing stub.
func assertStockOnchainRejectsMissingEmulatorPacket(t *testing.T) {
	t.Helper()
	emulatorKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	serverKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	service, err := emulator.New(emulatorKey, nil, nil, serverKey.PubKey(), arkade.DefaultComputeLimits())
	if err != nil {
		t.Fatal(err)
	}
	prevTx := wire.NewMsgTx(2)
	prevTx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Index: 1}})
	prevTx.AddTxOut(&wire.TxOut{Value: 10_000, PkScript: []byte{txscript.OP_TRUE}})
	tx := wire.NewMsgTx(2)
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: prevTx.TxHash(), Index: 0}})
	tx.AddTxOut(&wire.TxOut{Value: 9_000, PkScript: []byte{txscript.OP_TRUE}})
	packet, err := psbt.NewFromUnsignedTx(tx)
	if err != nil {
		t.Fatal(err)
	}
	packet.Inputs[0].WitnessUtxo = prevTx.TxOut[0]
	if err := txutils.SetArkPsbtField(packet, 0, arkade.PrevoutTxField, *prevTx); err != nil {
		t.Fatal(err)
	}
	_, err = service.SubmitOnchainTx(context.Background(), emulator.OnchainTx{Tx: packet})
	if err == nil || !strings.Contains(err.Error(), "no emulator packet found") {
		t.Fatalf("expected pinned service to reject missing emulator packet, got %v", err)
	}
}
