package main

// This direct-engine feasibility test checks packet pins/parsing, output
// introspection, and a real Groth16 proof in the stock pinned VM. Its test-only
// fetcher returns a synthetic parent regardless of outpoint; it does not test
// txid/checkpoint ancestry or registered-policy authorization. The separate
// Service harness covers those integration paths. The fixture proves Y*Y=X
// for X=9; it is not a Shielded note circuit.

import (
	"bytes"
	"crypto/sha256"
	"fmt"
	"math/big"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
	gnarkbn254 "github.com/consensys/gnark-crypto/ecc/bn254"
)

func TestStagedStockVMChecksOriginalPacketsAndGroth16(t *testing.T) {
	fixture := stagedFixture(t)
	icPacket := append(append([]byte{}, stagedBNBytes(fixture.ic0x)...), stagedBNBytes(fixture.ic0y)...)
	icPacket = append(icPacket, stagedBNBytes(fixture.ic1x)...)
	icPacket = append(icPacket, stagedBNBytes(fixture.ic1y)...)
	if len(icPacket) != 128 {
		t.Fatalf("IC packet size=%d, want 128", len(icPacket))
	}
	vkPacket := make([]byte, 0, 448)
	for _, point := range [][]*big.Int{
		{fixture.alpha.x, fixture.alpha.y},
		{fixture.betaNeg.x1, fixture.betaNeg.x0, fixture.betaNeg.y1, fixture.betaNeg.y0},
		{fixture.gammaNeg.x1, fixture.gammaNeg.x0, fixture.gammaNeg.y1, fixture.gammaNeg.y0},
		{fixture.deltaNeg.x1, fixture.deltaNeg.x0, fixture.deltaNeg.y1, fixture.deltaNeg.y0},
	} {
		for _, coordinate := range point {
			vkPacket = append(vkPacket, stagedBNBytes(coordinate)...)
		}
	}
	if len(vkPacket) != 448 {
		t.Fatalf("fixed VK packet size=%d, want 448", len(vkPacket))
	}

	prepared := wire.NewMsgTx(2)
	prepared.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Index: 0xffffffff}, Sequence: 0xffffffff})
	payoutScript := stagedP2TRScript(0x42)
	prepared.AddTxOut(wire.NewTxOut(10, payoutScript))
	ext, err := extension.NewExtensionFromPackets(
		extension.UnknownPacket{PacketType: 0x85, Data: icPacket},
		extension.UnknownPacket{PacketType: 0x86, Data: vkPacket},
	)
	if err != nil {
		t.Fatal(err)
	}
	extOut, err := ext.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	prepared.AddTxOut(extOut)

	spend := wire.NewMsgTx(2)
	preparedHash := prepared.TxHash()
	spend.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: preparedHash, Index: 0}, Sequence: 0xfffffffe})
	spend.AddTxOut(wire.NewTxOut(9, stagedP2TRScript(0x24)))
	prevOut := txscript.NewMultiPrevOutFetcher(map[wire.OutPoint]*wire.TxOut{
		spend.TxIn[0].PreviousOutPoint: prepared.TxOut[0],
	})
	fetcher := &stagedPrevFetcher{PrevOutputFetcher: prevOut, parent: prepared, parentPkScript: prepared.TxOut[0].PkScript}

	proofWitness := [][]byte{
		stagedScriptNumBig(fixture.proofAx), stagedScriptNumBig(fixture.proofAy),
		stagedScriptNumBig(fixture.proofBx1), stagedScriptNumBig(fixture.proofBx0),
		stagedScriptNumBig(fixture.proofBy1), stagedScriptNumBig(fixture.proofBy0),
		stagedScriptNumBig(fixture.proofCx), stagedScriptNumBig(fixture.proofCy),
		stagedScriptNum(9),
	}
	script := stagedVerifierScript(t, fixture, icPacket, vkPacket, spend.TxOut[0].PkScript)
	engine, err := arkade.NewEngine(
		script, spend, 0, txscript.NewSigCache(10),
		txscript.NewTxSigHashes(spend, fetcher), 10, fetcher,
	)
	if err != nil {
		t.Fatal(err)
	}
	engine.SetStack(proofWitness)
	var trace []string
	arkade.WithDebugCallback(func(step *arkade.StepInfo, _ *arkade.Engine) error {
		trace = append(trace, fmt.Sprintf("op=%d stack=%v", step.OpcodeIndex, stagedStackSummary(step.Stack)))
		return nil
	})(engine)
	if err := engine.Execute(); err != nil {
		start := len(trace) - 4
		if start < 0 {
			start = 0
		}
		t.Fatalf("stock VM rejected valid staged proof: %v; steps=%d; tail=%v; opcodes=%v", err, len(trace), trace[start:], stagedOpcodeNames(script, start))
	}

	// Negative checks exercise the bytecode and packet pins against the mock parent.
	badProof := append([][]byte(nil), proofWitness...)
	badProof[8] = stagedScriptNum(10)
	assertStagedRejected(t, script, spend, fetcher, badProof, "public input / payout mismatch")
	badProof = append([][]byte(nil), proofWitness...)
	badC := stagedG1Add(
		stagedG1{x: fixture.proofCx, y: fixture.proofCy},
		stagedG1{x: fixture.ic1x, y: fixture.ic1y},
	)
	badProof[6], badProof[7] = stagedScriptNumBig(badC.x), stagedScriptNumBig(badC.y)
	assertStagedRejected(t, script, spend, fetcher, badProof, "on-curve proof mutation rejected by pairing")

	wrongValueTx := *spend
	wrongValueTx.TxOut = append([]*wire.TxOut(nil), spend.TxOut...)
	wrongValueTx.TxOut[0] = wire.NewTxOut(10, spend.TxOut[0].PkScript)
	wrongInput := append([][]byte(nil), proofWitness...)
	wrongInput[8] = stagedScriptNum(10)
	assertStagedRejected(t, script, &wrongValueTx, fetcher, wrongInput, "pairing rejects a different correctly bound public input")

	wrongPayoutTx := *spend
	wrongPayoutTx.TxOut = append([]*wire.TxOut(nil), spend.TxOut...)
	wrongPayoutTx.TxOut[0] = wire.NewTxOut(9, stagedP2TRScript(0x25))
	assertStagedRejected(t, script, &wrongPayoutTx, fetcher, proofWitness, "wrong payout script")

	changedIC := append([]byte(nil), icPacket...)
	changedIC[0] ^= 1
	changedICParent := stagedParentWithPackets(t, prepared, changedIC, vkPacket)
	changedICFetcher := &stagedPrevFetcher{PrevOutputFetcher: prevOut, parent: changedICParent, parentPkScript: prepared.TxOut[0].PkScript}
	assertStagedRejected(t, script, spend, changedICFetcher, proofWitness, "changed IC packet")

	changedVK := append([]byte(nil), vkPacket...)
	changedVK[0] ^= 1
	changedVKParent := stagedParentWithPackets(t, prepared, icPacket, changedVK)
	changedVKFetcher := &stagedPrevFetcher{PrevOutputFetcher: prevOut, parent: changedVKParent, parentPkScript: prepared.TxOut[0].PkScript}
	assertStagedRejected(t, script, spend, changedVKFetcher, proofWitness, "changed fixed VK packet")

	wrongParent := *prepared
	wrongParent.TxOut = append([]*wire.TxOut(nil), prepared.TxOut...)
	wrongParent.TxOut[1] = &wire.TxOut{Value: 0, PkScript: []byte{txscript.OP_RETURN, 0}}
	wrongFetcher := &stagedPrevFetcher{PrevOutputFetcher: prevOut, parent: &wrongParent, parentPkScript: prepared.TxOut[0].PkScript}
	assertStagedRejected(t, script, spend, wrongFetcher, proofWitness, "altered original packet")

	t.Logf("staged stock VM result: proof=valid; icPacket=%dB; vkPacket=%dB; verifierScript=%dB; witnessItems=%d; witnessPayload=%dB (raw item bytes); prepareOutputs=%d; prepareExtensionScript=%dB; unsignedChildBaseSerialization=%dB (no witness/signature/Ark extension; not transaction weight)",
		len(icPacket), len(vkPacket), len(script), len(proofWitness), stagedWitnessBytes(proofWitness),
		len(prepared.TxOut), len(extOut.PkScript), spend.SerializeSize())
}

func stagedOpcodeNames(script []byte, start int) []string {
	tok := arkade.MakeScriptTokenizer(0, script)
	var names []string
	for i := 0; tok.Next(); i++ {
		if i >= start {
			names = append(names, fmt.Sprintf("%d:%x", i, tok.Opcode()))
		}
	}
	return names
}

func stagedVerifierScript(t *testing.T, f stagedGroth16Fixture, icPacket, vkPacket, payoutScript []byte) []byte {
	t.Helper()
	b := txscript.NewScriptBuilder()
	// The public input is the actual output value and the destination is fixed.
	b.AddOp(txscript.OP_DUP).AddInt64(0).AddOp(arkade.OP_INSPECTOUTPUTVALUE).AddOp(txscript.OP_EQUALVERIFY)
	b.AddInt64(0).AddOp(arkade.OP_INSPECTOUTPUTSCRIPTPUBKEY).AddOp(txscript.OP_1).AddOp(txscript.OP_EQUALVERIFY)
	b.AddData(payoutScript[2:]).AddOp(txscript.OP_EQUALVERIFY)
	// The VM opcode reads from the parent supplied by the test fetcher. Pin exact
	// sizes and bytes before parsing the two public-input IC points.
	b.AddInt64(0x85).AddInt64(0).AddOp(arkade.OP_INSPECTINPUTPACKET).AddOp(txscript.OP_VERIFY)
	b.AddOp(txscript.OP_SIZE).AddInt64(int64(len(icPacket))).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddOp(txscript.OP_DUP).AddOp(txscript.OP_SHA256).AddData(stagedHash(icPacket)).AddOp(txscript.OP_EQUALVERIFY)
	// Keep the pinned packet on stack and duplicate it for each coordinate slice.
	for _, offset := range []int64{0, 32, 64, 96} {
		stagedExtractTopPacket(b, offset)
	}
	b.AddOp(txscript.OP_DROP)
	// vk_x = IC0 + X*IC1. Existing Arkade BN254 operations perform the real
	// scalar multiplication and addition using the coordinates parsed above.
	b.AddOp(txscript.OP_4).AddOp(txscript.OP_ROLL).AddInt64(arkade.CurveAltBN128).AddOp(arkade.OP_ECMUL)
	b.AddInt64(arkade.CurveAltBN128).AddOp(arkade.OP_ECADD)
	// Preserve vk_x on the alternate stack while parsing the fixed key packet.
	b.AddOp(txscript.OP_TOALTSTACK).AddOp(txscript.OP_TOALTSTACK)

	// Pin the fixed VK packet once and retain it on the main stack. Extract
	// delta first, restore vk_x, then append gamma, alpha, and beta in pairing
	// order. Every parsed coordinate remains below the packet.
	b.AddInt64(0x86).AddInt64(0).AddOp(arkade.OP_INSPECTINPUTPACKET).AddOp(txscript.OP_VERIFY)
	b.AddOp(txscript.OP_SIZE).AddInt64(int64(len(vkPacket))).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddOp(txscript.OP_DUP).AddOp(txscript.OP_SHA256).AddData(stagedHash(vkPacket)).AddOp(txscript.OP_EQUALVERIFY)
	for _, offset := range []int64{320, 352, 384, 416} {
		stagedExtractTopPacket(b, offset)
	}
	b.AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_FROMALTSTACK)
	b.AddOp(txscript.OP_2).AddOp(txscript.OP_ROLL)
	for _, offset := range []int64{192, 224, 256, 288, 0, 32, 64, 96, 128, 160} {
		stagedExtractTopPacket(b, offset)
	}
	b.AddOp(txscript.OP_DROP)
	b.AddInt64(4).AddInt64(arkade.CurveAltBN128).AddOp(arkade.OP_ECPAIRING)
	script, err := b.Script()
	if err != nil {
		t.Fatal(err)
	}
	return script
}

func stagedExtractTopPacket(b *txscript.ScriptBuilder, start int64) {
	b.AddOp(txscript.OP_DUP).AddInt64(start).AddInt64(32).AddOp(txscript.OP_SUBSTR).AddOp(arkade.OP_BIN2NUM).AddOp(txscript.OP_SWAP)
}

func stagedParentWithPackets(t *testing.T, prepared *wire.MsgTx, icPacket, vkPacket []byte) *wire.MsgTx {
	t.Helper()
	parent := *prepared
	parent.TxOut = append([]*wire.TxOut(nil), prepared.TxOut...)
	ext, err := extension.NewExtensionFromPackets(
		extension.UnknownPacket{PacketType: 0x85, Data: icPacket},
		extension.UnknownPacket{PacketType: 0x86, Data: vkPacket},
	)
	if err != nil {
		t.Fatal(err)
	}
	parent.TxOut[1], err = ext.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	return &parent
}

func stagedG1Add(a, b stagedG1) stagedG1 {
	ga := stagedToGnarkG1(a)
	gb := stagedToGnarkG1(b)
	var out gnarkbn254.G1Affine
	out.Add(&ga, &gb)
	var x, y big.Int
	out.X.BigInt(&x)
	out.Y.BigInt(&y)
	return stagedG1{x: new(big.Int).Set(&x), y: new(big.Int).Set(&y)}
}

func stagedToGnarkG1(p stagedG1) gnarkbn254.G1Affine {
	var out gnarkbn254.G1Affine
	out.X.SetBigInt(p.x)
	out.Y.SetBigInt(p.y)
	return out
}

func stagedHash(b []byte) []byte { h := sha256.Sum256(b); return h[:] }

func stagedP2TRScript(fill byte) []byte {
	s := []byte{txscript.OP_1, 0x20}
	return append(s, bytes.Repeat([]byte{fill}, 32)...)
}

func stagedScriptNum(v int64) []byte {
	if v == 0 {
		return nil
	}
	if v < 0 || v > 16 {
		panic("staged fixture only uses small positive script numbers")
	}
	return []byte{byte(v)}
}

func stagedBNBytes(v *big.Int) []byte {
	if v.Sign() == 0 {
		return nil
	}
	b := v.Bytes()
	if len(b) > 32 {
		panic("BN254 coordinate exceeds 32 bytes")
	}
	out := make([]byte, 32)
	for i := range b {
		out[i] = b[len(b)-1-i]
	}
	return out
}

func stagedScriptNumBig(v *big.Int) []byte {
	out := stagedBNBytes(v)
	for len(out) > 0 && out[len(out)-1] == 0 {
		out = out[:len(out)-1]
	}
	if len(out) > 0 && out[len(out)-1]&0x80 != 0 {
		out = append(out, 0)
	}
	return out
}

func stagedWitnessBytes(items [][]byte) int {
	n := 0
	for _, item := range items {
		n += len(item)
	}
	return n
}

func stagedStackSummary(stack [][]byte) string {
	var b strings.Builder
	for i := len(stack) - 1; i >= 0 && i >= len(stack)-10; i-- {
		v := stack[i]
		if len(v) > 6 {
			v = v[:6]
		}
		fmt.Fprintf(&b, "%d:%x ", len(stack[i]), v)
	}
	return b.String()
}

func assertStagedRejected(t *testing.T, script []byte, tx *wire.MsgTx, fetcher *stagedPrevFetcher, witness [][]byte, label string) {
	t.Helper()
	engine, err := arkade.NewEngine(script, tx, 0, txscript.NewSigCache(10), txscript.NewTxSigHashes(tx, fetcher), 10, fetcher)
	if err != nil {
		t.Fatal(err)
	}
	engine.SetStack(witness)
	if err := engine.Execute(); err == nil {
		t.Fatalf("%s unexpectedly accepted", label)
	}
}

type stagedPrevFetcher struct {
	txscript.PrevOutputFetcher
	parent         *wire.MsgTx
	parentPkScript []byte
}

// This test-only fetcher intentionally ignores the outpoint; service-level
// parent resolution, checkpoint mapping, and policy checks are tested elsewhere.
func (f *stagedPrevFetcher) FetchPrevOutArkTx(_ wire.OutPoint) *wire.MsgTx { return f.parent }
func (f *stagedPrevFetcher) FetchVtxoPrevOutPkScript(wire.OutPoint) []byte { return f.parentPkScript }

type stagedG1 struct{ x, y *big.Int }
type stagedG2 struct{ x1, x0, y1, y0 *big.Int }
type stagedGroth16Fixture struct {
	ic0x, ic0y, ic1x, ic1y                                                     *big.Int
	alpha                                                                      stagedG1
	betaNeg, gammaNeg, deltaNeg                                                stagedG2
	proofAx, proofAy, proofBx1, proofBx0, proofBy1, proofBy0, proofCx, proofCy *big.Int
}

func stagedFixture(t *testing.T) stagedGroth16Fixture {
	t.Helper()
	return stagedGroth16Fixture{
		ic0x:     stagedHex(t, "214762f5e1b31936df442f16298fdc668254fe4d3c13f92d8c0b0988aabd869d"),
		ic0y:     stagedHex(t, "1413a9ea941737df505a163fe8469f445791833e637a0daaf82849deee477c9f"),
		ic1x:     stagedHex(t, "a671871e2e742344d42f7317f15020c8ffd06b9a6d5fc2604effb253ea63140"),
		ic1y:     stagedHex(t, "27b737a8668cf74d50fc8a41387b3d15de347cd6af0698b385c4f8611459faec"),
		alpha:    stagedG1{x: stagedHex(t, "84af1dd3073d98496ae82b47b686deeab8520d014edfb1d4b89c6bc9815e7e4"), y: stagedHex(t, "1baf84027fc4c511a8e6fde1bf178f7f4142c5847c7cf08be0ef48c3de402941")},
		betaNeg:  stagedG2{x1: stagedHex(t, "1efd2d59f1887688bd7eaa5e7fa318e3b7855916fdc7d28c219ea89b4fb6bbc3"), x0: stagedHex(t, "1d6e87de4fa9d755e73537d1016fa6bf5e6314154b1cc29c15f525fbc6b74ce"), y1: stagedHex(t, "16fe7eba648bf65b33187de2872b48c01f70b7d4c63292e7c9d882ee34e820a6"), y0: stagedHex(t, "467f0733b737da7d9de233a0c3461530a746263f1f4823fed0240d2ca313cc7")},
		gammaNeg: stagedG2{x1: stagedHex(t, "1e8f987221464dbe10ca749d5d30a012a8a29a88cc59dea49f198e412fc2bd7c"), x0: stagedHex(t, "1f66abcb6a97665b70301df80c6c117895bf0d805a4ec298159df4be9a9e4afd"), y1: stagedHex(t, "2c63398cabafdcf2ec24ef25190420153b5db9536f95bc98fbe2c4ebf4b7788a"), y0: stagedHex(t, "eb34da773a8038d2c0888b9516db9a3030999d84d5218eb93163293970eaa30")},
		deltaNeg: stagedG2{x1: stagedHex(t, "2cddd0828035c3469a02325690251bf93c962b04a2de6679a5c793802ce85795"), x0: stagedHex(t, "103420825ef79a5c489e93d5e686988fdd35565f906873a0a76d95feddd0e613"), y1: stagedHex(t, "1e125142c038ef6508779d59fc45bd0fe8a779656e090411b704373e7b708d30"), y0: stagedHex(t, "2e0ce45661beb79b08d8f6a50a505223a5b83e963afe98c65542bfaed2bb8c6d")},
		proofAx:  stagedHex(t, "288965af2fd92b46c200c6486f4d3d2d9853b43006a939487265ca003dae3d1a"),
		proofAy:  stagedHex(t, "0b74788ac234aab5cf97938435bc4a2e1038af3ecd6147c49d02a7621cc64491"),
		proofBx1: stagedHex(t, "decd8fba51fd1505cb39610ed8cc87918bb6e3d9aab7103b9ca1313d744b428"),
		proofBx0: stagedHex(t, "2614fad1fd4c641ef5b29564ec1b06a18bbeed7b0a8af8b1d646ba467dcff714"),
		proofBy1: stagedHex(t, "2ada81fd1ec597c95138d4ccecaf7d0355116e550043cd373b7fd711f7c96a14"),
		proofBy0: stagedHex(t, "05200fcb224cc519810eed7af57d6f58a57a49bc52aa43577e0dd5d79c8e8361"),
		proofCx:  stagedHex(t, "2776c430308e75b457828e0b5514b0ba6e99311a8509fa8673aad885714ab569"),
		proofCy:  stagedHex(t, "0078c80a2a5bbc6c24fc811086b1e021b1aa58a943006992ee23dc5214da3303"),
	}
}

func stagedHex(t *testing.T, value string) *big.Int {
	t.Helper()
	v, ok := new(big.Int).SetString(value, 16)
	if !ok {
		t.Fatalf("invalid hex integer %q", value)
	}
	return v
}
