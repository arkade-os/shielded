package main

import (
	"bytes"
	"context"
	"fmt"
	"math/big"
	"sort"
	"strings"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	arkscript "github.com/arkade-os/arkd/pkg/ark-lib/script"
	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/arkade-os/emulator/pkg/emulator"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

const stagedTransportCapWU = 4000

type stagedTransportPhase struct {
	vmScript []byte
	leaf     *psbt.TaprootTapLeafScript
}

type stagedTransportTree struct {
	pkScript []byte
	phases   map[string]stagedTransportPhase
}

func TestStagedStockServiceSubmitTxTransportAndWeight(t *testing.T) {
	fixture := stagedFixture(t)
	icPacket := stagedTransportICPacket(fixture)
	vkPacket := stagedTransportVKPacket(fixture)
	stateRoot := extension.UnknownPacket{PacketType: 0x87, Data: bytes.Repeat([]byte{0x31}, 32)}
	phase0 := extension.UnknownPacket{PacketType: 0x88, Data: []byte{17}}
	phase1 := extension.UnknownPacket{PacketType: 0x88, Data: []byte{18}}
	payoutScript := stagedP2TRScript(0x24)

	prepareScript := stagedTransportPrepareScript()
	abortScript := stagedTransportAbortScript()
	commitScript := stagedVerifierScript(t, fixture, icPacket, vkPacket, payoutScript)
	commitScript = append(commitScript, stagedTransportRootScript()...)
	commitScript = append(commitScript, stagedTransportPhaseScript(18, 17)...)
	commitScript = append(commitScript, stagedTransportCommitRemainderScript()...)
	commitScript = append(commitScript, stagedTransportShapeScript(1, 4)...)
	commitScript = append(commitScript, txscript.OP_1)
	tree := stagedTransportMakeTree(t, map[string][]byte{
		"prepare": prepareScript,
		"commit":  commitScript,
		"abort":   abortScript,
	})

	service, serverKey := stagedTransportService(t)
	previous := stagedTransportParent(t, tree.pkScript, 10_000, []extension.Packet{stateRoot, phase0})
	prepared, preparedTx := stagedTransportSubmit(t, service, serverKey, tree, "prepare", previous, 0,
		[]*wire.TxOut{{Value: 10_000, PkScript: tree.pkScript}},
		nil,
		[]extension.Packet{stateRoot, phase1, extension.UnknownPacket{PacketType: 0x85, Data: icPacket}, extension.UnknownPacket{PacketType: 0x86, Data: vkPacket}},
	)
	if got := len(prepared.ArkTx.Inputs[0].TaprootScriptSpendSig); got != 2 {
		t.Fatalf("prepare should collect emulator and Arkade signatures, got %d", got)
	}

	proof := [][]byte{
		stagedScriptNumBig(fixture.proofAx), stagedScriptNumBig(fixture.proofAy),
		stagedScriptNumBig(fixture.proofBx1), stagedScriptNumBig(fixture.proofBx0),
		stagedScriptNumBig(fixture.proofBy1), stagedScriptNumBig(fixture.proofBy0),
		stagedScriptNumBig(fixture.proofCx), stagedScriptNumBig(fixture.proofCy), stagedScriptNum(9),
	}
	commit, committedTx := stagedTransportSubmit(t, service, serverKey, tree, "commit", preparedTx, 0,
		[]*wire.TxOut{
			{Value: 9, PkScript: payoutScript},
			{Value: 9_991, PkScript: tree.pkScript},
		},
		proof,
		[]extension.Packet{stateRoot, phase0},
	)
	if got := len(commit.ArkTx.Inputs[0].TaprootScriptSpendSig); got != 2 {
		t.Fatalf("commit should collect emulator and Arkade signatures, got %d", got)
	}
	badProof := cloneStagedWitness(proof)
	badProof[6] = stagedScriptNumBig(new(big.Int).Add(fixture.proofCx, big.NewInt(1)))
	assertStagedServiceReject(t, service, tree, "commit", preparedTx, 0,
		[]*wire.TxOut{{Value: 9, PkScript: payoutScript}, {Value: 9_991, PkScript: tree.pkScript}}, badProof,
		[]extension.Packet{stateRoot, phase0}, nil, "altered proof")
	wrongPayout := []*wire.TxOut{{Value: 8, PkScript: payoutScript}, {Value: 9_992, PkScript: tree.pkScript}}
	assertStagedServiceReject(t, service, tree, "commit", preparedTx, 0, wrongPayout, proof,
		[]extension.Packet{stateRoot, phase0}, nil, "wrong payout amount")
	wrongScriptPayout := []*wire.TxOut{{Value: 9, PkScript: stagedP2TRScript(0x25)}, {Value: 9_991, PkScript: tree.pkScript}}
	assertStagedServiceReject(t, service, tree, "commit", preparedTx, 0, wrongScriptPayout, proof,
		[]extension.Packet{stateRoot, phase0}, nil, "wrong payout script")
	wrongRoot := extension.UnknownPacket{PacketType: 0x87, Data: bytes.Repeat([]byte{0x44}, 32)}
	assertStagedServiceReject(t, service, tree, "commit", preparedTx, 0,
		[]*wire.TxOut{{Value: 9, PkScript: payoutScript}, {Value: 9_991, PkScript: tree.pkScript}}, proof,
		[]extension.Packet{wrongRoot, phase0}, nil, "changed state root")
	wrongPhaseParent := stagedTransportParent(t, tree.pkScript, 10_000, []extension.Packet{
		stateRoot, phase0, extension.UnknownPacket{PacketType: 0x85, Data: icPacket}, extension.UnknownPacket{PacketType: 0x86, Data: vkPacket},
	})
	assertStagedServiceReject(t, service, tree, "commit", wrongPhaseParent, 0,
		[]*wire.TxOut{{Value: 9, PkScript: payoutScript}, {Value: 9_991, PkScript: tree.pkScript}}, proof,
		[]extension.Packet{stateRoot, phase0}, nil, "illegal phase")
	badVK := append([]byte(nil), vkPacket...)
	badVK[0] ^= 1
	wrongKeyParent := stagedTransportParent(t, tree.pkScript, 10_000, []extension.Packet{
		stateRoot, phase1, extension.UnknownPacket{PacketType: 0x85, Data: icPacket}, extension.UnknownPacket{PacketType: 0x86, Data: badVK},
	})
	assertStagedServiceReject(t, service, tree, "commit", wrongKeyParent, 0,
		[]*wire.TxOut{{Value: 9, PkScript: payoutScript}, {Value: 9_991, PkScript: tree.pkScript}}, proof,
		[]extension.Packet{stateRoot, phase0}, nil, "changed key packet")
	malformedKeyAbort, _ := stagedTransportSubmit(t, service, serverKey, tree, "abort", wrongKeyParent, 0,
		[]*wire.TxOut{{Value: 10_000, PkScript: tree.pkScript}}, nil,
		[]extension.Packet{stateRoot, phase0},
	)
	extraOutput := []*wire.TxOut{
		{Value: 9, PkScript: payoutScript}, {Value: 9_991, PkScript: tree.pkScript}, {Value: 0, PkScript: payoutScript},
	}
	assertStagedServiceReject(t, service, tree, "commit", preparedTx, 0, extraOutput, proof,
		[]extension.Packet{stateRoot, phase0}, nil, "extra output")
	assertStagedServiceReject(t, service, tree, "commit", preparedTx, 0,
		[]*wire.TxOut{{Value: 9, PkScript: payoutScript}, {Value: 9_990, PkScript: tree.pkScript}}, proof,
		[]extension.Packet{stateRoot, phase0}, nil, "BTC remainder loss")
	wrongProgram := stagedTransportRequest(t, tree, "commit", preparedTx, 0,
		[]*wire.TxOut{{Value: 9, PkScript: payoutScript}, {Value: 9_991, PkScript: tree.pkScript}}, proof,
		[]extension.Packet{stateRoot, phase0}, []byte{txscript.OP_1})
	if _, err := service.SubmitTx(context.Background(), wrongProgram, emulator.OffchainData{VtxoExpiries: map[wire.OutPoint]int64{}}); err == nil || !strings.Contains(err.Error(), "tweaked") {
		t.Fatalf("stock service accepted VM bytecode without a matching Taproot leaf: %v", err)
	}

	missingKeysParent := stagedTransportParent(t, tree.pkScript, 10_000, []extension.Packet{stateRoot, phase1})
	missingKeyAbort, _ := stagedTransportSubmit(t, service, serverKey, tree, "abort", missingKeysParent, 0,
		[]*wire.TxOut{{Value: 10_000, PkScript: tree.pkScript}},
		nil,
		[]extension.Packet{stateRoot, phase0},
	)
	secondPrepare, secondPreparedTx := stagedTransportSubmit(t, service, serverKey, tree, "prepare", committedTx, 1,
		[]*wire.TxOut{{Value: 9_991, PkScript: tree.pkScript}},
		nil,
		[]extension.Packet{stateRoot, phase1, extension.UnknownPacket{PacketType: 0x85, Data: icPacket}, extension.UnknownPacket{PacketType: 0x86, Data: vkPacket}},
	)
	aborted, _ := stagedTransportSubmit(t, service, serverKey, tree, "abort", secondPreparedTx, 0,
		[]*wire.TxOut{{Value: 9_991, PkScript: tree.pkScript}},
		nil,
		[]extension.Packet{stateRoot, phase0},
	)
	if got := len(aborted.ArkTx.Inputs[0].TaprootScriptSpendSig); got != 2 {
		t.Fatalf("abort should collect emulator and Arkade signatures, got %d", got)
	}
	if got := missingKeyAbort.ArkTx.UnsignedTx.TxIn[0].PreviousOutPoint.Index; got != 0 {
		t.Fatalf("missing-key abort checkpoint input index=%d, want checkpoint output 0", got)
	}

	for _, result := range []struct {
		name string
		tx   *psbt.Packet
		cp   *psbt.Packet
	}{
		{"prepare", prepared.ArkTx, prepared.Checkpoints[0]},
		{"commit", commit.ArkTx, commit.Checkpoints[0]},
		{"prepare-after-output-1", secondPrepare.ArkTx, secondPrepare.Checkpoints[0]},
		{"abort", aborted.ArkTx, aborted.Checkpoints[0]},
		{"abort-missing-key", missingKeyAbort.ArkTx, missingKeyAbort.Checkpoints[0]},
		{"abort-malformed-key", malformedKeyAbort.ArkTx, malformedKeyAbort.Checkpoints[0]},
	} {
		arkWU, arkStripped, arkTotal := stagedTransportFinalizeWeight(t, result.tx)
		cpWU, cpStripped, cpTotal := stagedTransportFinalizeWeight(t, result.cp)
		t.Logf("%s finalized bytes: ark stripped=%d total=%d weight=%dWU; checkpoint stripped=%d total=%d weight=%dWU; pair=%dWU cap=%dWU",
			result.name, arkStripped, arkTotal, arkWU, cpStripped, cpTotal, cpWU, arkWU+cpWU, stagedTransportCapWU)
		if result.name == "commit" {
			productionSignalEstimate := arkWU + 128
			t.Logf("commit production 32-byte scalar estimate: at least %dWU after +31 payload bytes and one framing byte; remaining cap headroom=%dWU before full Shielded relation checks",
				productionSignalEstimate, stagedTransportCapWU-productionSignalEstimate)
		}
		if arkWU > stagedTransportCapWU {
			t.Errorf("%s Ark transaction is %d WU above the illustrative %d-WU cap", result.name, arkWU-stagedTransportCapWU, stagedTransportCapWU)
		}
		if cpWU > stagedTransportCapWU {
			t.Errorf("%s checkpoint transaction is %d WU above the illustrative %d-WU cap", result.name, cpWU-stagedTransportCapWU, stagedTransportCapWU)
		}
	}
}

func assertStagedServiceReject(
	t *testing.T,
	service emulator.Service,
	tree stagedTransportTree,
	phaseName string,
	parent *wire.MsgTx,
	parentIndex uint32,
	outputs []*wire.TxOut,
	witness [][]byte,
	packets []extension.Packet,
	scriptOverride []byte,
	label string,
) {
	t.Helper()
	request := stagedTransportRequest(t, tree, phaseName, parent, parentIndex, outputs, witness, packets, scriptOverride)
	if _, err := service.SubmitTx(context.Background(), request, emulator.OffchainData{VtxoExpiries: map[wire.OutPoint]int64{}}); err == nil {
		t.Fatalf("stock Service.SubmitTx accepted %s", label)
	}
}

func cloneStagedWitness(witness [][]byte) [][]byte {
	copyOfWitness := make([][]byte, len(witness))
	for i := range witness {
		copyOfWitness[i] = append([]byte(nil), witness[i]...)
	}
	return copyOfWitness
}

func stagedTransportService(t *testing.T) (emulator.Service, *btcec.PrivateKey) {
	t.Helper()
	emulatorKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	serverKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	service, err := emulator.New(emulatorKey, nil, nil, serverKey.PubKey(), arkade.DefaultComputeLimits())
	if err != nil {
		t.Fatal(err)
	}
	return service, serverKey
}

func stagedTransportMakeTree(t *testing.T, vmScripts map[string][]byte) stagedTransportTree {
	t.Helper()
	emulatorKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	serverKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	phaseNames := make([]string, 0, len(vmScripts))
	for name := range vmScripts {
		phaseNames = append(phaseNames, name)
	}
	sort.Strings(phaseNames)
	closures := make([]*arkscript.MultisigClosure, 0, len(vmScripts))
	closureScripts := make(map[string][]byte, len(vmScripts))
	for _, name := range phaseNames {
		vmScript := vmScripts[name]
		tweaked := arkade.ComputeArkadeScriptPublicKey(emulatorKey.PubKey(), arkade.ArkadeScriptHash(vmScript))
		closure := &arkscript.MultisigClosure{PubKeys: []*btcec.PublicKey{serverKey.PubKey(), tweaked}}
		closureScript, err := closure.Script()
		if err != nil {
			t.Fatal(err)
		}
		closures = append(closures, closure)
		closureScripts[name] = closureScript
	}
	vtxoScript := arkscript.TapscriptsVtxoScript{Closures: make([]arkscript.Closure, len(closures))}
	for i, closure := range closures {
		vtxoScript.Closures[i] = closure
	}
	tapKey, tree, err := vtxoScript.TapTree()
	if err != nil {
		t.Fatal(err)
	}
	pkScript, err := arkscript.P2TRScript(tapKey)
	if err != nil {
		t.Fatal(err)
	}
	phases := make(map[string]stagedTransportPhase, len(vmScripts))
	for name, vmScript := range vmScripts {
		leaf := txscript.NewBaseTapLeaf(closureScripts[name])
		proof, err := tree.GetTaprootMerkleProof(leaf.TapHash())
		if err != nil {
			t.Fatal(err)
		}
		phases[name] = stagedTransportPhase{
			vmScript: vmScript,
			leaf:     &psbt.TaprootTapLeafScript{ControlBlock: proof.ControlBlock, Script: proof.Script, LeafVersion: txscript.BaseLeafVersion},
		}
	}
	return stagedTransportTree{pkScript: pkScript, phases: phases}
}

func stagedTransportParent(t *testing.T, pkScript []byte, value int64, packets []extension.Packet) *wire.MsgTx {
	t.Helper()
	tx := wire.NewMsgTx(2)
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: [32]byte{0xa1}, Index: 0}, Sequence: 0xffffffff})
	tx.AddTxOut(&wire.TxOut{Value: value, PkScript: append([]byte(nil), pkScript...)})
	if len(packets) > 0 {
		ext, err := extension.NewExtensionFromPackets(packets...)
		if err != nil {
			t.Fatal(err)
		}
		out, err := ext.TxOut()
		if err != nil {
			t.Fatal(err)
		}
		tx.AddTxOut(out)
	}
	return tx
}

func stagedTransportSubmit(
	t *testing.T,
	service emulator.Service,
	serverKey *btcec.PrivateKey,
	tree stagedTransportTree,
	phaseName string,
	parent *wire.MsgTx,
	parentIndex uint32,
	outputs []*wire.TxOut,
	witness [][]byte,
	packets []extension.Packet,
) (*emulator.OffchainTx, *wire.MsgTx) {
	t.Helper()
	request := stagedTransportRequest(t, tree, phaseName, parent, parentIndex, outputs, witness, packets, nil)
	if err := validateNativeAssets(context.Background(), request.ArkTx, request.Checkpoints); err != nil {
		t.Fatalf("%s native value/asset preflight: %v", phaseName, err)
	}
	result, err := service.SubmitTx(context.Background(), request, emulator.OffchainData{VtxoExpiries: map[wire.OutPoint]int64{}})
	if err != nil {
		phase := tree.phases[phaseName]
		fetcher := &stagedPrevFetcher{PrevOutputFetcher: txscript.NewMultiPrevOutFetcher(map[wire.OutPoint]*wire.TxOut{
			request.ArkTx.UnsignedTx.TxIn[0].PreviousOutPoint: request.ArkTx.Inputs[0].WitnessUtxo,
		}), parent: parent, parentPkScript: parent.TxOut[parentIndex].PkScript}
		engine, engineErr := arkade.NewEngine(phase.vmScript, request.ArkTx.UnsignedTx, 0, txscript.NewSigCache(2), txscript.NewTxSigHashes(request.ArkTx.UnsignedTx, fetcher), 10, fetcher)
		trace := make([]string, 0, 32)
		if engineErr == nil {
			entryWitness := make(wire.TxWitness, len(witness))
			for i := range witness {
				entryWitness[i] = append([]byte(nil), witness[i]...)
			}
			engine.SetStack(entryWitness)
			arkade.WithDebugCallback(func(step *arkade.StepInfo, _ *arkade.Engine) error {
				trace = append(trace, fmt.Sprintf("%d: %s", step.OpcodeIndex, stagedStackSummary(step.Stack)))
				return nil
			})(engine)
			_ = engine.Execute()
		}
		t.Fatalf("%s Service.SubmitTx: %v; script trace=%v", phaseName, err, trace)
	}
	addStagedTransportServerSignature(t, result.ArkTx, serverKey)
	for _, cp := range result.Checkpoints {
		addStagedTransportServerSignature(t, cp, serverKey)
	}
	return result, result.ArkTx.UnsignedTx
}

func stagedTransportRequest(
	t *testing.T,
	tree stagedTransportTree,
	phaseName string,
	parent *wire.MsgTx,
	parentIndex uint32,
	outputs []*wire.TxOut,
	witness [][]byte,
	packets []extension.Packet,
	scriptOverride []byte,
) emulator.OffchainTx {
	t.Helper()
	phase, ok := tree.phases[phaseName]
	if !ok {
		t.Fatalf("unknown phase %q", phaseName)
	}
	parentOutput := parent.TxOut[parentIndex]
	checkpointTx := wire.NewMsgTx(2)
	checkpointTx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: parent.TxHash(), Index: parentIndex}, Sequence: 0xfffffffe})
	checkpointTx.AddTxOut(&wire.TxOut{Value: parentOutput.Value, PkScript: append([]byte(nil), parentOutput.PkScript...)})
	checkpointTx.AddTxOut(txutils.AnchorOutput())
	checkpoint, err := psbt.NewFromUnsignedTx(checkpointTx)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint.Inputs[0].WitnessUtxo = parentOutput
	checkpoint.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{phase.leaf}

	arkTx := wire.NewMsgTx(2)
	arkTx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: checkpointTx.TxHash(), Index: 0}, Sequence: 0xfffffffe})
	for _, output := range outputs {
		arkTx.AddTxOut(output)
	}
	arkTx.AddTxOut(txutils.AnchorOutput())
	entryWitness := make(wire.TxWitness, len(witness))
	for i := range witness {
		entryWitness[i] = append([]byte(nil), witness[i]...)
	}
	vmScript := phase.vmScript
	if scriptOverride != nil {
		vmScript = scriptOverride
	}
	emulatorPacket, err := arkade.NewPacket(arkade.EmulatorEntry{Vin: 0, Script: vmScript, Witness: entryWitness})
	if err != nil {
		t.Fatal(err)
	}
	allPackets := make([]extension.Packet, 0, len(packets)+1)
	allPackets = append(allPackets, emulatorPacket)
	allPackets = append(allPackets, packets...)
	ext, err := extension.NewExtensionFromPackets(allPackets...)
	if err != nil {
		t.Fatal(err)
	}
	extOut, err := ext.TxOut()
	if err != nil {
		t.Fatal(err)
	}
	arkTx.AddTxOut(extOut)
	arkPtx, err := psbt.NewFromUnsignedTx(arkTx)
	if err != nil {
		t.Fatal(err)
	}
	arkPtx.Inputs[0].WitnessUtxo = checkpointTx.TxOut[0]
	arkPtx.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{phase.leaf}
	if err := txutils.SetArkPsbtField(arkPtx, 0, arkade.PrevArkTxField, *parent); err != nil {
		t.Fatal(err)
	}
	return emulator.OffchainTx{ArkTx: arkPtx, Checkpoints: []*psbt.Packet{checkpoint}}
}

func addStagedTransportServerSignature(t *testing.T, packet *psbt.Packet, key *btcec.PrivateKey) {
	t.Helper()
	prevouts := make(map[wire.OutPoint]*wire.TxOut, len(packet.Inputs))
	for inputIndex, input := range packet.Inputs {
		if input.WitnessUtxo == nil {
			t.Fatalf("input %d has no witness UTXO", inputIndex)
		}
		prevouts[packet.UnsignedTx.TxIn[inputIndex].PreviousOutPoint] = input.WitnessUtxo
	}
	fetcher := txscript.NewMultiPrevOutFetcher(prevouts)
	hashes := txscript.NewTxSigHashes(packet.UnsignedTx, fetcher)
	for inputIndex := range packet.Inputs {
		input := &packet.Inputs[inputIndex]
		if input.WitnessUtxo == nil {
			t.Fatalf("input %d lacks one leaf and witness UTXO", inputIndex)
		}
		if len(input.TaprootLeafScript) == 0 && len(input.TaprootKeySpendSig) > 0 {
			continue
		}
		if len(input.TaprootLeafScript) != 1 {
			t.Fatalf("input %d lacks one leaf and witness UTXO", inputIndex)
		}
		leaf := txscript.NewBaseTapLeaf(input.TaprootLeafScript[0].Script)
		signature, err := txscript.RawTxInTapscriptSignature(
			packet.UnsignedTx, hashes, inputIndex, input.WitnessUtxo.Value,
			input.WitnessUtxo.PkScript, leaf, input.SighashType, key,
		)
		if err != nil {
			t.Fatal(err)
		}
		leafHash := leaf.TapHash()
		input.TaprootScriptSpendSig = append(input.TaprootScriptSpendSig, &psbt.TaprootScriptSpendSig{
			Signature:   append([]byte(nil), signature[:schnorr.SignatureSize]...),
			XOnlyPubKey: schnorr.SerializePubKey(key.PubKey()),
			LeafHash:    leafHash[:],
			SigHash:     input.SighashType,
		})
	}
}

func stagedTransportFinalizeWeight(t *testing.T, packet *psbt.Packet) (weight, strippedBytes, totalBytes int) {
	t.Helper()
	prevOutputs := make(map[wire.OutPoint]*wire.TxOut, len(packet.Inputs))
	for inputIndex := range packet.Inputs {
		input := packet.Inputs[inputIndex]
		if input.WitnessUtxo == nil {
			t.Fatalf("input %d has no witness UTXO", inputIndex)
		}
		prevOutputs[packet.UnsignedTx.TxIn[inputIndex].PreviousOutPoint] = input.WitnessUtxo
	}
	fetcher := txscript.NewMultiPrevOutFetcher(prevOutputs)
	for inputIndex := range packet.Inputs {
		if err := psbt.Finalize(packet, inputIndex); err != nil {
			t.Fatalf("finalize input %d: %v", inputIndex, err)
		}
	}
	tx, err := psbt.Extract(packet)
	if err != nil {
		t.Fatal(err)
	}
	for inputIndex := range packet.Inputs {
		input := packet.Inputs[inputIndex]
		engine, err := txscript.NewEngine(
			input.WitnessUtxo.PkScript, tx, inputIndex, txscript.StandardVerifyFlags,
			txscript.NewSigCache(2), txscript.NewTxSigHashes(tx, fetcher), input.WitnessUtxo.Value, fetcher,
		)
		if err != nil {
			t.Fatalf("construct finalized Bitcoin script engine: %v", err)
		}
		if err := engine.Execute(); err != nil {
			t.Fatalf("finalized Taproot witness for input %d is invalid: %v", inputIndex, err)
		}
	}
	var stripped, total bytes.Buffer
	if err := tx.SerializeNoWitness(&stripped); err != nil {
		t.Fatal(err)
	}
	if err := tx.Serialize(&total); err != nil {
		t.Fatal(err)
	}
	strippedBytes, totalBytes = stripped.Len(), total.Len()
	return strippedBytes*3 + totalBytes, strippedBytes, totalBytes
}

func stagedTransportICPacket(f stagedGroth16Fixture) []byte {
	packet := make([]byte, 0, 128)
	for _, coordinate := range []*big.Int{f.ic0x, f.ic0y, f.ic1x, f.ic1y} {
		packet = append(packet, stagedBNBytes(coordinate)...)
	}
	return packet
}

func stagedTransportVKPacket(f stagedGroth16Fixture) []byte {
	packet := make([]byte, 0, 448)
	for _, coordinate := range []*big.Int{
		f.deltaNeg.x1, f.deltaNeg.x0, f.deltaNeg.y1, f.deltaNeg.y0,
		f.gammaNeg.x1, f.gammaNeg.x0, f.gammaNeg.y1, f.gammaNeg.y0,
		f.alpha.x, f.alpha.y,
		f.betaNeg.x1, f.betaNeg.x0, f.betaNeg.y1, f.betaNeg.y0,
	} {
		packet = append(packet, stagedBNBytes(coordinate)...)
	}
	return packet
}

func stagedTransportPreserveScript() []byte {
	b := txscript.NewScriptBuilder()
	b.AddOp(arkade.OP_INSPECTNUMINPUTS).AddInt64(1).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddOp(arkade.OP_INSPECTNUMOUTPUTS).AddInt64(3).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddInt64(1).AddOp(arkade.OP_INSPECTOUTPUTVALUE).AddInt64(0).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddInt64(2).AddOp(arkade.OP_INSPECTOUTPUTVALUE).AddInt64(0).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTVALUE)
	b.AddInt64(0).AddOp(arkade.OP_INSPECTOUTPUTVALUE).AddOp(txscript.OP_EQUALVERIFY)
	b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTSCRIPTPUBKEY).AddOp(txscript.OP_TOALTSTACK)
	b.AddInt64(0).AddOp(arkade.OP_INSPECTOUTPUTSCRIPTPUBKEY).AddOp(txscript.OP_TOALTSTACK)
	b.AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_NUMEQUALVERIFY).AddOp(txscript.OP_EQUALVERIFY)
	b.AddInt64(0x87).AddInt64(0).AddOp(arkade.OP_INSPECTINPUTPACKET).AddOp(txscript.OP_VERIFY).AddOp(txscript.OP_TOALTSTACK)
	b.AddInt64(0x87).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_VERIFY).AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_EQUALVERIFY)
	script, _ := b.Script()
	return script
}

func stagedTransportPrepareScript() []byte {
	b := txscript.NewScriptBuilder()
	for _, key := range []struct {
		packet int64
		size   int64
	}{{0x85, 128}, {0x86, 448}} {
		b.AddInt64(key.packet).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_VERIFY)
		b.AddOp(txscript.OP_SIZE).AddInt64(key.size).AddOp(txscript.OP_NUMEQUALVERIFY).AddOp(txscript.OP_DROP)
	}
	suffix, _ := b.Script()
	script := append(append(stagedTransportPreserveScript(), stagedTransportPhaseScript(17, 18)...), suffix...)
	return append(script, txscript.OP_1)
}

func stagedTransportAbortScript() []byte {
	b := txscript.NewScriptBuilder()
	for _, packetType := range []int64{0x85, 0x86} {
		b.AddInt64(packetType).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_NOT).AddOp(txscript.OP_SWAP).AddOp(txscript.OP_DROP).AddOp(txscript.OP_VERIFY)
	}
	suffix, _ := b.Script()
	script := append(append(stagedTransportPreserveScript(), stagedTransportPhaseScript(18, 17)...), suffix...)
	return append(script, txscript.OP_1)
}

func stagedTransportCommitRemainderScript() []byte {
	b := txscript.NewScriptBuilder()
	b.AddOp(txscript.OP_VERIFY)
	b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTVALUE).AddInt64(9).AddOp(txscript.OP_SUB)
	b.AddInt64(1).AddOp(arkade.OP_INSPECTOUTPUTVALUE).AddOp(txscript.OP_EQUALVERIFY)
	b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTSCRIPTPUBKEY).AddOp(txscript.OP_TOALTSTACK)
	b.AddInt64(1).AddOp(arkade.OP_INSPECTOUTPUTSCRIPTPUBKEY).AddOp(txscript.OP_TOALTSTACK)
	b.AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_NUMEQUALVERIFY).AddOp(txscript.OP_EQUALVERIFY)
	script, _ := b.Script()
	return script
}

func stagedTransportPhaseScript(oldPhase, newPhase byte) []byte {
	b := txscript.NewScriptBuilder()
	b.AddInt64(0x88).AddInt64(0).AddOp(arkade.OP_INSPECTINPUTPACKET).AddOp(txscript.OP_VERIFY)
	b.AddData([]byte{oldPhase}).AddOp(txscript.OP_EQUALVERIFY)
	b.AddInt64(0x88).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_VERIFY)
	b.AddData([]byte{newPhase}).AddOp(txscript.OP_EQUALVERIFY)
	script, _ := b.Script()
	return script
}

func stagedTransportShapeScript(inputs, outputs int64) []byte {
	b := txscript.NewScriptBuilder()
	b.AddOp(arkade.OP_INSPECTNUMINPUTS).AddInt64(inputs).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddOp(arkade.OP_INSPECTNUMOUTPUTS).AddInt64(outputs).AddOp(txscript.OP_NUMEQUALVERIFY)
	if outputs > 3 {
		for _, output := range []int64{2, 3} {
			b.AddInt64(output).AddOp(arkade.OP_INSPECTOUTPUTVALUE).AddInt64(0).AddOp(txscript.OP_NUMEQUALVERIFY)
		}
	}
	script, _ := b.Script()
	return script
}

func stagedTransportRootScript() []byte {
	b := txscript.NewScriptBuilder()
	b.AddInt64(0x87).AddInt64(0).AddOp(arkade.OP_INSPECTINPUTPACKET).AddOp(txscript.OP_VERIFY).AddOp(txscript.OP_TOALTSTACK)
	b.AddInt64(0x87).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_VERIFY).AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_EQUALVERIFY)
	script, _ := b.Script()
	return script
}
