package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

func TestStockStatementScriptDerivesTheCanonicalScalar(t *testing.T) {
	for mode := byte(0); mode < 4; mode++ {
		mode := mode
		t.Run(stockModeName(mode), func(t *testing.T) {
			binding, tx, parent, prevOut := stockStatementFixture(t, mode)
			script, err := stockStatementScript(mode)
			if err != nil {
				t.Fatal(err)
			}
			b := txscript.NewScriptBuilder().AddData(stockScriptNumBytes(stockExpectedScalar(binding))).AddOp(txscript.OP_EQUALVERIFY).AddOp(txscript.OP_1)
			suffix, err := b.Script()
			if err != nil {
				t.Fatal(err)
			}
			script = append(script, suffix...)
			fetcher := &stagedPrevFetcher{PrevOutputFetcher: prevOut, parent: parent, parentPkScript: parent.TxOut[0].PkScript}
			engine, err := arkade.NewEngine(script, tx, 0, txscript.NewSigCache(2), txscript.NewTxSigHashes(tx, fetcher), 10, fetcher)
			if err != nil {
				t.Fatal(err)
			}
			var trace []string
			arkade.WithDebugCallback(func(step *arkade.StepInfo, _ *arkade.Engine) error {
				var top string
				if len(step.Stack) > 0 {
					top = fmt.Sprintf("%x", step.Stack[len(step.Stack)-1])
				}
				trace = append(trace, fmt.Sprintf("%d=%d:%s", step.OpcodeIndex, len(step.Stack), top))
				return nil
			})(engine)
			if err := engine.Execute(); err != nil {
				start := len(trace) - 16
				if start < 0 {
					start = 0
				}
				expected := stockScriptNumBytes(stockExpectedScalar(binding))
				t.Fatalf("stock statement script: %v; script bytes=%d expected=%d:%x tail=%v", err, len(script), len(expected), expected, trace[start:])
			}
			t.Logf("native binding mode=%d: binding=%dB; script=%dB", mode, len(binding), len(script)-len(suffix))
		})
	}
}

func TestStockStatementScriptRejectsWrongModeAndMissingBTCProfile(t *testing.T) {
	binding, tx, parent, prevOut := stockStatementFixture(t, 0)
	changed, err := extension.NewExtensionFromPackets(
		extension.UnknownPacket{PacketType: stockStatePacketType, Data: bytes.Repeat([]byte{0x44}, 32)},
		extension.UnknownPacket{PacketType: stockModePacketType, Data: []byte{0}},
	)
	if err != nil {
		t.Fatal(err)
	}
	changedOut, err := changed.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	wrongModeTx := *tx
	wrongModeTx.TxOut = append([]*wire.TxOut(nil), tx.TxOut...)
	wrongModeTx.TxOut[len(wrongModeTx.TxOut)-1] = changedOut
	assertStockBindingFails(t, 0, wrongModeTx, parent, prevOut, binding, "state packet changed")

	wrongMode, err := extension.NewExtensionFromPackets(
		extension.UnknownPacket{PacketType: stockStatePacketType, Data: bytes.Repeat([]byte{0x33}, 32)},
		extension.UnknownPacket{PacketType: stockModePacketType, Data: []byte{1}},
	)
	if err != nil {
		t.Fatal(err)
	}
	wrongModeOut, err := wrongMode.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	wrongModeTx.TxOut[len(wrongModeTx.TxOut)-1] = wrongModeOut
	assertStockBindingFails(t, 0, wrongModeTx, parent, prevOut, binding, "mode mismatch")

	assetExt, err := extension.NewExtensionFromPackets(
		extension.UnknownPacket{PacketType: 0, Data: []byte{1}},
		extension.UnknownPacket{PacketType: stockStatePacketType, Data: bytes.Repeat([]byte{0x33}, 32)},
		extension.UnknownPacket{PacketType: stockModePacketType, Data: []byte{0}},
	)
	if err != nil {
		t.Fatal(err)
	}
	assetOut, err := assetExt.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	assetTx := *tx
	assetTx.TxOut = append([]*wire.TxOut(nil), tx.TxOut...)
	assetTx.TxOut[len(assetTx.TxOut)-1] = assetOut
	assertStockBindingFails(t, 0, assetTx, parent, prevOut, binding, "asset packet in BTC profile")
}

func TestStockProofProgramIsWithinNativeProgramSizeBudget(t *testing.T) {
	fixture := stagedFixture(t)
	ic := stagedTransportICPacket(fixture)
	key := stagedTransportVKPacket(fixture)
	for mode := byte(0); mode < 4; mode++ {
		script, err := stockProofProgramScript(mode, ic, key)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("native mode=%d: statement=%dB; statement+8-coordinate Groth16 verifier=%dB", mode, stockStatementBytes(t, mode), len(script))
	}
	if _, err := stockProofProgramScript(0, ic[:127], key); err == nil {
		t.Fatal("accepted truncated IC packet")
	}
	if _, err := stockProofProgramScript(0, ic, key[:447]); err == nil {
		t.Fatal("accepted truncated fixed key packet")
	}
}

func TestStockBuilderEncodesSnarkJSVerificationKeyPackets(t *testing.T) {
	f := stagedFixture(t)
	key := stockSnarkJSVerificationKey{
		Protocol: "groth16", Curve: "bn128", NPublic: 1,
		Alpha1: stockTestG1(f.alpha),
		Beta2:  stockTestG2(f.betaNeg), Gamma2: stockTestG2(f.gammaNeg), Delta2: stockTestG2(f.deltaNeg),
		IC: [][]string{stockTestG1(stagedG1{x: f.ic0x, y: f.ic0y}), stockTestG1(stagedG1{x: f.ic1x, y: f.ic1y})},
	}
	raw, err := json.Marshal(key)
	if err != nil {
		t.Fatal(err)
	}
	path := t.TempDir() + "/vkey.json"
	if err := os.WriteFile(path, raw, 0600); err != nil {
		t.Fatal(err)
	}
	_, ic, fixed, err := loadStockSnarkJSKey(path)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(ic, stagedTransportICPacket(f)) || !bytes.Equal(fixed, stagedTransportVKPacket(f)) {
		t.Fatalf("snarkjs key packet encoding differs: IC=%x fixed=%x", ic, fixed)
	}
}

func TestStockCoordinateRequiresCanonicalDecimal(t *testing.T) {
	for _, text := range []string{"+1", "-0", "01", "", "1e2", " 1"} {
		if _, err := stockCoordinate(text, stockBaseField, "test"); err == nil {
			t.Errorf("accepted noncanonical coordinate %q", text)
		}
	}
	if value, err := stockCoordinate("1", stockBaseField, "test"); err != nil || value.Int64() != 1 {
		t.Fatalf("canonical coordinate rejected: value=%v err=%v", value, err)
	}
}

func TestStockProgramsHashUsesSortedCompactJSONPairs(t *testing.T) {
	programs := map[string]string{
		"abort": "00", "deposit": "51", "prepare": "52",
		"seal": "53", "transfer": "54", "withdraw": "55", "withdraw-funded": "56",
	}
	wantJSON := `[["abort","00"],["deposit","51"],["prepare","52"],["seal","53"],["transfer","54"],["withdraw","55"],["withdraw-funded","56"]]`
	want := sha256.Sum256([]byte(wantJSON))
	if got := stockProgramsHash(programs); got != hex.EncodeToString(want[:]) {
		t.Fatalf("programs hash mismatch: got %s, want %x", got, want)
	}
	delete(programs, "seal")
	if got := stockProgramsHash(programs); got != "" {
		t.Fatalf("accepted missing script: %s", got)
	}
}

func TestStockVerifierHashPreludeTuckEquivalent(t *testing.T) {
	var ic, fixed []byte
	if _, candidateIC, candidateFixed, err := loadStockSnarkJSKey("../../circuits/stock/build/compiled/stock-combined.vkey.json"); err == nil {
		ic, fixed = candidateIC, candidateFixed
	} else {
		f := stagedFixture(t)
		ic, fixed = stagedTransportICPacket(f), stagedTransportVKPacket(f)
	}
	combined := append(append([]byte(nil), ic...), fixed...)
	want := sha256.Sum256(combined)
	for name, sequence := range map[string][]byte{
		"dup-roll-swap": {txscript.OP_DUP, txscript.OP_2, txscript.OP_ROLL, txscript.OP_SWAP},
		"tuck":          {txscript.OP_TUCK},
	} {
		t.Run(name, func(t *testing.T) {
			if err := stockRunHashPinPrelude(t, ic, fixed, want[:], sequence); err != nil {
				t.Fatalf("valid combined key pin: %v", err)
			}
			wrongPin := append([]byte(nil), want[:]...)
			wrongPin[0] ^= 1
			if err := stockRunHashPinPrelude(t, ic, fixed, wrongPin, sequence); err == nil {
				t.Fatal("accepted a changed combined key pin")
			}
		})
	}
}

func stockRunHashPinPrelude(t *testing.T, ic, fixed, pin, sequence []byte) error {
	t.Helper()
	b := txscript.NewScriptBuilder().AddData(ic).AddOp(arkade.OP_SHA256INITIALIZE).AddData(fixed)
	for _, op := range sequence {
		b.AddOp(op)
	}
	b.AddOp(arkade.OP_SHA256FINALIZE).AddData(pin).AddOp(txscript.OP_EQUALVERIFY).AddOp(txscript.OP_DROP).AddOp(txscript.OP_1)
	script, err := b.Script()
	if err != nil {
		return err
	}
	tx := wire.NewMsgTx(2)
	prevout := wire.OutPoint{Hash: [32]byte{1}, Index: 0}
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: prevout, Sequence: 0xffffffff})
	tx.AddTxOut(wire.NewTxOut(1, []byte{txscript.OP_1}))
	fetcher := &stagedPrevFetcher{
		PrevOutputFetcher: txscript.NewMultiPrevOutFetcher(map[wire.OutPoint]*wire.TxOut{prevout: wire.NewTxOut(1, []byte{txscript.OP_1})}),
		parent:            tx,
		parentPkScript:    []byte{txscript.OP_1},
	}
	engine, err := arkade.NewEngine(script, tx, 0, txscript.NewSigCache(1), txscript.NewTxSigHashes(tx, fetcher), 1, fetcher)
	if err != nil {
		return err
	}
	return engine.Execute()
}

func stockTestG1(point stagedG1) []string {
	return []string{point.x.String(), point.y.String(), "1"}
}

func stockTestG2(point stagedG2) [][]string {
	positive := func(negative *big.Int) string {
		return new(big.Int).Sub(stockBaseField, negative).String()
	}
	return [][]string{
		{point.x0.String(), point.x1.String()},
		{positive(point.y0), positive(point.y1)},
		{"1", "0"},
	}
}

func stockStatementBytes(t *testing.T, mode byte) int {
	t.Helper()
	script, err := stockStatementScript(mode)
	if err != nil {
		t.Fatal(err)
	}
	return len(script)
}

func assertStockBindingFails(t *testing.T, mode byte, tx wire.MsgTx, parent *wire.MsgTx, prevOut *txscript.MultiPrevOutFetcher, binding []byte, label string) {
	t.Helper()
	script, err := stockStatementScript(mode)
	if err != nil {
		t.Fatal(err)
	}
	b := txscript.NewScriptBuilder().AddData(stockScriptNumBytes(stockExpectedScalar(binding))).AddOp(txscript.OP_EQUALVERIFY).AddOp(txscript.OP_1)
	suffix, err := b.Script()
	if err != nil {
		t.Fatal(err)
	}
	script = append(script, suffix...)
	fetcher := &stagedPrevFetcher{PrevOutputFetcher: prevOut, parent: parent, parentPkScript: parent.TxOut[0].PkScript}
	engine, err := arkade.NewEngine(script, &tx, 0, txscript.NewSigCache(2), txscript.NewTxSigHashes(&tx, fetcher), 10, fetcher)
	if err != nil {
		t.Fatal(err)
	}
	if err := engine.Execute(); err == nil {
		t.Fatalf("accepted %s", label)
	}
}

func stockStatementFixture(t *testing.T, mode byte) ([]byte, *wire.MsgTx, *wire.MsgTx, *txscript.MultiPrevOutFetcher) {
	t.Helper()
	oldState := bytes.Repeat([]byte{0x22}, 32)
	newState := bytes.Repeat([]byte{0x33}, 32)
	parent := stagedTransportParent(t, stagedP2TRScript(0x41), 10_000, []extension.Packet{
		extension.UnknownPacket{PacketType: stockStatePacketType, Data: oldState},
	})
	previous := wire.OutPoint{Hash: [32]byte{0xa1, 2, 3}, Index: 7}
	valueMap := map[wire.OutPoint]*wire.TxOut{previous: wire.NewTxOut(10_000, stagedP2TRScript(0x41))}
	inputs := []*wire.TxIn{{PreviousOutPoint: previous, Sequence: 0xfffffffe}}
	outputs := []*wire.TxOut{{Value: 9_900, PkScript: stagedP2TRScript(0x41)}}
	if mode == 1 {
		second := wire.OutPoint{Hash: [32]byte{0xb2}, Index: 2}
		inputs = append(inputs, &wire.TxIn{PreviousOutPoint: second, Sequence: 0xfffffffe})
		valueMap[second] = wire.NewTxOut(4_000, stagedP2TRScript(0x55))
		outputs[0].Value = 13_900
	}
	if mode == 2 {
		outputs = []*wire.TxOut{{Value: 500, PkScript: stagedP2TRScript(0x55)}, {Value: 9_400, PkScript: stagedP2TRScript(0x41)}}
	}
	current := wire.NewMsgTx(2)
	current.TxIn = inputs
	current.TxOut = outputs
	packets, err := extension.NewExtensionFromPackets(
		extension.UnknownPacket{PacketType: stockStatePacketType, Data: newState},
		extension.UnknownPacket{PacketType: stockModePacketType, Data: []byte{mode}},
	)
	if err != nil {
		t.Fatal(err)
	}
	extOut, err := packets.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	current.AddTxOut(extOut)
	binding := stockTestPreimage(mode, previous, oldState, newState, 10_000, continuationBTC(current, mode), externalBTC(mode), payoutBTC(mode), payoutProgram(mode))
	return binding, current, parent, txscript.NewMultiPrevOutFetcher(valueMap)
}

func continuationBTC(tx *wire.MsgTx, mode byte) uint64 {
	index := 0
	if mode == 2 {
		index = 1
	}
	return uint64(tx.TxOut[index].Value)
}
func externalBTC(mode byte) uint64 {
	if mode == 1 {
		return 4_000
	}
	return 0
}
func payoutBTC(mode byte) uint64 {
	if mode == 2 {
		return 500
	}
	return 0
}
func payoutProgram(mode byte) []byte {
	if mode == 2 {
		return bytes.Repeat([]byte{0x55}, 32)
	}
	return make([]byte, 32)
}

func stockTestPreimage(mode byte, checkpoint wire.OutPoint, oldState, newState []byte, poolInput, continuation, funding, payout uint64, program []byte) []byte {
	out := []byte{0x53, 0x48, 1, 0, mode}
	out = append(out, checkpoint.Hash[:]...)
	out = append(out, byte(checkpoint.Index), byte(checkpoint.Index>>8), byte(checkpoint.Index>>16), byte(checkpoint.Index>>24))
	out = append(out, oldState...)
	out = append(out, newState...)
	for _, value := range []uint64{poolInput, continuation, funding, payout} {
		for i := 0; i < 8; i++ {
			out = append(out, byte(value>>(8*i)))
		}
	}
	out = append(out, program...)
	empty := sha256.Sum256(nil)
	out = append(out, empty[:]...)
	return out
}
func stockExpectedScalar(preimage []byte) *big.Int {
	digest := sha256.Sum256(preimage)
	le := append([]byte(nil), digest[:31]...)
	for left, right := 0, len(le)-1; left < right; left, right = left+1, right-1 {
		le[left], le[right] = le[right], le[left]
	}
	return new(big.Int).SetBytes(le)
}
