package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	arkscript "github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/arkade-os/emulator/pkg/emulator"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

func TestHTTPRegisteredVMSignsWithAuthoritativePrevout(t *testing.T) {
	program := []byte{txscript.OP_TRUE}
	programHash := sha256.Sum256(program)
	programID := hex.EncodeToString(programHash[:])
	registry, err := arkade.NewProgramRegistry(map[string]string{programID: hex.EncodeToString(program)})
	if err != nil {
		t.Fatal(err)
	}
	emulatorKey, err := btcec.NewPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	arkSigner, err := btcec.NewPrivateKey()
	if err != nil {
		t.Fatal(err)
	}
	service, err := emulator.NewWithProgramRegistry(emulatorKey, nil, nil, arkSigner.PubKey(), arkade.DefaultComputeLimits(), registry)
	if err != nil {
		t.Fatal(err)
	}
	marker := append([]byte{32}, programHash[:]...)
	marker = append(marker, txscript.OP_RETURN)
	tweaked := arkade.ComputeArkadeScriptPublicKey(emulatorKey.PubKey(), arkade.ArkadeScriptHash(marker))
	leaf, vtxoScript := registryTaprootLeaf(t, tweaked, arkSigner.PubKey())
	previous := wire.NewMsgTx(2)
	previous.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: chainhash.Hash{0xaa}}})
	previous.AddTxOut(&wire.TxOut{Value: 5_000, PkScript: vtxoScript})
	checkpointWire := wire.NewMsgTx(2)
	checkpointWire.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: previous.TxHash(), Index: 0}})
	checkpointWire.AddTxOut(&wire.TxOut{Value: 5_000, PkScript: vtxoScript})
	checkpointWire.AddTxOut(txutils.AnchorOutput())
	checkpoint, err := psbt.NewFromUnsignedTx(checkpointWire)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint.Inputs[0].WitnessUtxo = previous.TxOut[0]
	checkpoint.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{leaf}
	sidecar := registryTestSidecar(programHash)
	sidecarHash := sha256.Sum256(sidecar)
	askWire := wire.NewMsgTx(2)
	askWire.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: checkpointWire.TxHash(), Index: 0}})
	askWire.AddTxOut(&wire.TxOut{Value: 4_800, PkScript: vtxoScript})
	emulatorPacket, err := arkade.NewPacket(arkade.EmulatorEntry{Vin: 0, Script: marker})
	if err != nil {
		t.Fatal(err)
	}
	ext, err := extension.NewExtensionFromPackets(emulatorPacket, extension.UnknownPacket{PacketType: arkade.RegistryPacketType, Data: sidecarHash[:]})
	if err != nil {
		t.Fatal(err)
	}
	opReturn, err := ext.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	askWire.AddTxOut(opReturn)
	askTx, err := psbt.NewFromUnsignedTx(askWire)
	if err != nil {
		t.Fatal(err)
	}
	askTx.Inputs[0].WitnessUtxo = checkpointWire.TxOut[0]
	askTx.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{leaf}
	if err := txutils.SetArkPsbtField(askTx, 0, arkade.PrevArkTxField, *previous); err != nil {
		t.Fatal(err)
	}
	s := &server{service: service, indexer: fakeIndexer{txs: map[string]*wire.MsgTx{previous.TxHash().String(): previous}}}
	handler := s.handler()
	requestBody := func(rawSidecar []byte) []byte {
		arkRaw, err := askTx.B64Encode()
		if err != nil {
			t.Fatal(err)
		}
		decoded, err := base64.StdEncoding.DecodeString(arkRaw)
		if err != nil {
			t.Fatalf("B64Encode returned %q: %v", arkRaw[:min(20, len(arkRaw))], err)
		}
		if _, err := psbt.NewFromRawBytes(bytes.NewReader(decoded), false); err != nil {
			t.Fatalf("fixture Ark PSBT failed to roundtrip: %v", err)
		}
		checkpointRaw, err := checkpoint.B64Encode()
		if err != nil {
			t.Fatal(err)
		}
		body, err := json.Marshal(request{ArkTx: arkRaw, CheckpointTxs: []string{checkpointRaw}, RegistrySidecar: base64.StdEncoding.EncodeToString(rawSidecar)})
		if err != nil {
			t.Fatal(err)
		}
		return body
	}
	post := func(body []byte) *httptest.ResponseRecorder {
		req := httptest.NewRequest(http.MethodPost, "/v1/tx", bytes.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		res := httptest.NewRecorder()
		handler.ServeHTTP(res, req)
		return res
	}
	bad := append([]byte(nil), sidecar...)
	bad[len(bad)-1] ^= 1
	if res := post(requestBody(bad)); res.Code != http.StatusUnprocessableEntity {
		t.Fatalf("tampered sidecar status=%d body=%s", res.Code, res.Body.String())
	}
	res := post(requestBody(sidecar))
	if res.Code != http.StatusOK {
		t.Fatalf("registered transaction rejected: status=%d body=%s", res.Code, res.Body.String())
	}
	var signed response
	if err := json.Unmarshal(res.Body.Bytes(), &signed); err != nil {
		t.Fatal(err)
	}
	signedArk, err := psbt.NewFromRawBytes(bytes.NewReader(mustDecodeB64(t, signed.SignedArkTx)), false)
	if err != nil {
		t.Fatal(err)
	}
	signedCheckpoint, err := psbt.NewFromRawBytes(bytes.NewReader(mustDecodeB64(t, signed.SignedCheckpointTxs[0])), false)
	if err != nil {
		t.Fatal(err)
	}
	if len(signedArk.Inputs[0].TaprootScriptSpendSig) == 0 || len(signedCheckpoint.Inputs[0].TaprootScriptSpendSig) == 0 {
		t.Fatal("HTTP response did not contain both real emulator signatures")
	}
}

func registryTestSidecar(profile [32]byte) []byte {
	var sidecar bytes.Buffer
	sidecar.Write([]byte{0x53, 1})
	for i := 0; i < 4; i++ {
		_ = binary.Write(&sidecar, binary.LittleEndian, uint16(0))
	}
	_ = binary.Write(&sidecar, binary.LittleEndian, uint16(160))
	sidecar.Write(make([]byte, 160))
	sidecar.WriteByte(1)
	_ = binary.Write(&sidecar, binary.LittleEndian, uint16(0))
	sidecar.Write(profile[:])
	_ = binary.Write(&sidecar, binary.LittleEndian, uint16(0))
	return sidecar.Bytes()
}

func registryTaprootLeaf(t *testing.T, emulatorKey, arkSigner *btcec.PublicKey) (*psbt.TaprootTapLeafScript, []byte) {
	t.Helper()
	closure := arkscript.MultisigClosure{PubKeys: []*btcec.PublicKey{emulatorKey, arkSigner}}
	vtxoScript := arkscript.TapscriptsVtxoScript{Closures: []arkscript.Closure{&closure}}
	tapKey, tree, err := vtxoScript.TapTree()
	if err != nil {
		t.Fatal(err)
	}
	leafScript, err := closure.Script()
	if err != nil {
		t.Fatal(err)
	}
	proof, err := tree.GetTaprootMerkleProof(txscript.NewBaseTapLeaf(leafScript).TapHash())
	if err != nil {
		t.Fatal(err)
	}
	pkScript, err := arkscript.P2TRScript(tapKey)
	if err != nil {
		t.Fatal(err)
	}
	return &psbt.TaprootTapLeafScript{ControlBlock: proof.ControlBlock, Script: proof.Script, LeafVersion: txscript.BaseLeafVersion}, pkScript
}

func mustDecodeB64(t *testing.T, value string) []byte {
	t.Helper()
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil {
		t.Fatal(err)
	}
	return decoded
}
