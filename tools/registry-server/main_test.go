package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type fakeIndexer struct{ txs map[string]*wire.MsgTx }

func (f fakeIndexer) FetchVirtualTxs(_ context.Context, ids []string) (map[string]*wire.MsgTx, error) {
	result := make(map[string]*wire.MsgTx, len(ids))
	for _, id := range ids {
		if tx := f.txs[id]; tx != nil {
			result[id] = tx
		}
	}
	return result, nil
}

func TestCanonicalRegistryHashUsesSortedCompactJSON(t *testing.T) {
	first := []byte{0x51}
	second := []byte{0x52}
	firstID := sha256.Sum256(first)
	secondID := sha256.Sum256(second)
	firstHex, secondHex := hex.EncodeToString(firstID[:]), hex.EncodeToString(secondID[:])
	input := []byte("{\"" + secondHex + "\":\"52\",\"" + firstHex + "\":\"51\"}")
	_, ids, got, err := canonicalRegistry(input)
	if err != nil {
		t.Fatal(err)
	}
	canonical := []byte("{\"" + firstHex + "\":\"51\",\"" + secondHex + "\":\"52\"}")
	expected := sha256.Sum256(canonical)
	if got != hex.EncodeToString(expected[:]) {
		t.Fatalf("unexpected registry hash: %s", got)
	}
	if len(ids) != 2 || ids[0] >= ids[1] {
		t.Fatalf("program IDs not sorted: %v", ids)
	}
}

func TestCanonicalRegistryRejectsDuplicateAndMismatchedIds(t *testing.T) {
	digest := sha256.Sum256([]byte{0x51})
	id := hex.EncodeToString(digest[:])
	_, _, _, err := canonicalRegistry([]byte("{\"" + id + "\":\"51\",\"" + id + "\":\"51\"}"))
	if err == nil {
		t.Fatal("accepted duplicate registry key")
	}
	_, _, _, err = canonicalRegistry([]byte("{\"" + strings.Repeat("0", 64) + "\":\"51\"}"))
	if err == nil {
		t.Fatal("accepted bytecode with the wrong program ID")
	}
}

func TestDecodeRequestRejectsUnknownAndDuplicateFields(t *testing.T) {
	valid := `{"arkTx":"a","checkpointTxs":["b"],"registrySidecar":"c"}`
	if _, err := decodeRequest(strings.NewReader(valid)); err != nil {
		t.Fatalf("valid envelope rejected: %v", err)
	}
	for _, invalid := range []string{
		`{"arkTx":"a","arkTx":"z","checkpointTxs":["b"],"registrySidecar":"c"}`,
		`{"arkTx":"a","checkpointTxs":["b"],"registrySidecar":"c","programs":{}}`,
		valid + ` {}`,
	} {
		if _, err := decodeRequest(strings.NewReader(invalid)); err == nil {
			t.Fatalf("accepted invalid envelope %s", invalid)
		}
	}
}

func TestAuthoritativePrevoutsReplaceCallerTransaction(t *testing.T) {
	prev := wire.NewMsgTx(2)
	prev.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Index: 0xffffffff}, SignatureScript: []byte{0x01}})
	prev.AddTxOut(&wire.TxOut{Value: 42000, PkScript: []byte{0x51}})
	checkpointTx := wire.NewMsgTx(2)
	checkpointTx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: prev.TxHash(), Index: 0}})
	checkpointTx.AddTxOut(&wire.TxOut{Value: 42000, PkScript: []byte{0x51}})
	checkpoint, err := psbt.NewFromUnsignedTx(checkpointTx)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint.Inputs[0].WitnessUtxo = &wire.TxOut{Value: 42000, PkScript: []byte{0x51}}

	arkTxWire := wire.NewMsgTx(2)
	arkTxWire.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: checkpointTx.TxHash(), Index: 0}})
	arkTx, err := psbt.NewFromUnsignedTx(arkTxWire)
	if err != nil {
		t.Fatal(err)
	}
	arkTx.Inputs[0].WitnessUtxo = &wire.TxOut{Value: 42000, PkScript: []byte{0x51}}
	attacker := wire.NewMsgTx(2)
	attacker.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Index: 0xffffffff}, SignatureScript: []byte{0x02}})
	attacker.AddTxOut(&wire.TxOut{Value: 1, PkScript: []byte{0x51}})
	if err := txutils.SetArkPsbtField(arkTx, 0, arkade.PrevArkTxField, *attacker); err != nil {
		t.Fatal(err)
	}

	s := &server{indexer: fakeIndexer{txs: map[string]*wire.MsgTx{prev.TxHash().String(): prev}}}
	if err := s.authoritativePrevouts(context.Background(), arkTx, []*psbt.Packet{checkpoint}); err != nil {
		t.Fatal(err)
	}
	fields, err := txutils.GetArkPsbtFields(arkTx, 0, arkade.PrevArkTxField)
	if err != nil || len(fields) != 1 || fields[0].TxHash() != prev.TxHash() {
		var diagnostics []string
		for _, field := range arkTx.Inputs[0].Unknowns {
			diagnostics = append(diagnostics, fmt.Sprintf("%x:%d", field.Key, len(field.Value)))
		}
		t.Fatalf("server did not replace caller prevout with indexer value: fields=%d err=%v unknowns=%v", len(fields), err, diagnostics)
	}
}

func TestAuthoritativePrevoutsFailsWhenIndexerMissesTx(t *testing.T) {
	prev := wire.NewMsgTx(2)
	prev.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Index: 0xffffffff}, SignatureScript: []byte{0x01}})
	prev.AddTxOut(&wire.TxOut{Value: 42000, PkScript: []byte{0x51}})
	checkpointTx := wire.NewMsgTx(2)
	checkpointTx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: prev.TxHash(), Index: 0}})
	checkpoint, _ := psbt.NewFromUnsignedTx(checkpointTx)
	checkpoint.Inputs[0].WitnessUtxo = &wire.TxOut{Value: 42000, PkScript: []byte{0x51}}
	arkTxWire := wire.NewMsgTx(2)
	arkTxWire.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: checkpointTx.TxHash(), Index: 0}})
	arkTx, _ := psbt.NewFromUnsignedTx(arkTxWire)
	s := &server{indexer: fakeIndexer{txs: map[string]*wire.MsgTx{}}}
	if err := s.authoritativePrevouts(context.Background(), arkTx, []*psbt.Packet{checkpoint}); err == nil {
		t.Fatal("accepted previous transaction absent from the trusted indexer")
	}
}

func TestBase64MustBeCanonical(t *testing.T) {
	canonical := "c2hpZWxkZWQ="
	if got, err := canonicalBase64(canonical, 32); err != nil || !bytes.Equal(got, []byte("shielded")) {
		t.Fatalf("canonical base64 rejected: %v", err)
	}
	for _, value := range []string{"c2hpZWxkZWQ", "c2hpZWxkZWQ=\n", "%%%"} {
		if _, err := canonicalBase64(value, 32); err == nil {
			t.Fatalf("accepted noncanonical base64 %q", value)
		}
	}
}

func TestInfoJSONHasStableCapabilityNames(t *testing.T) {
	info := capabilities{Version: serviceVersion, SignerPubkey: "compressed", RegistryProtocol: protocolName, RegistryHash: strings.Repeat("a", 64), RegisteredPrograms: []string{strings.Repeat("b", 64)}, MaxSidecarBytes: maxSidecarBytes}
	raw, err := json.Marshal(info)
	if err != nil {
		t.Fatal(err)
	}
	for _, field := range []string{`"version":"shielded-registry/1"`, `"signerPubkey":"compressed"`, `"registryProtocol":"shielded-registered-v1"`, `"registryHash"`, `"registeredPrograms"`, `"maxSidecarBytes":131072`} {
		if !bytes.Contains(raw, []byte(field)) {
			t.Fatalf("capability field missing from %s", raw)
		}
	}
}

func TestHTTPRejectsWhenVerifierSlotsAreFull(t *testing.T) {
	slots := make(chan struct{}, 1)
	slots <- struct{}{}
	request := httptest.NewRequest(http.MethodPost, "/v1/tx", strings.NewReader("not-json"))
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	(&server{slots: slots}).handler().ServeHTTP(response, request)
	if response.Code != http.StatusTooManyRequests {
		t.Fatalf("busy verifier status=%d body=%s", response.Code, response.Body.String())
	}
}
