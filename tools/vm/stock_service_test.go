package main

import (
	"bytes"
	"context"
	"sort"
	"testing"

	arklib "github.com/arkade-os/arkd/pkg/ark-lib"
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

func TestStockProductionPrepareAbortThroughService(t *testing.T) {
	fixture := stagedFixture(t)
	ic, key := stagedTransportICPacket(fixture), stagedTransportVKPacket(fixture)
	service, serverKey := stagedTransportService(t)
	prepare, err := stockPrepareLeafScript(ic, key)
	if err != nil {
		t.Fatal(err)
	}
	abort, err := stockAbortLeafScript()
	if err != nil {
		t.Fatal(err)
	}
	programs := map[string][]byte{"prepare": prepare, "abort": abort}
	for mode := byte(0); mode < 4; mode++ {
		programs[stockModeName(mode)], err = stockCommitLeafScript(mode, ic, key)
		if err != nil {
			t.Fatal(err)
		}
	}
	programs["withdraw-funded"], err = stockCommitLeafScriptFunding(2, ic, key, true)
	if err != nil {
		t.Fatal(err)
	}
	tree := stockPolicyTransportTree(t, programs)
	state := extension.UnknownPacket{PacketType: stockStatePacketType, Data: bytes.Repeat([]byte{0x31}, 32)}
	phase17 := extension.UnknownPacket{PacketType: 0x88, Data: []byte{17}}
	phase18 := extension.UnknownPacket{PacketType: 0x88, Data: []byte{18}}
	parent := stagedTransportParent(t, tree.pkScript, 10_000, []extension.Packet{state, phase17})
	prepared, preparedTx := stagedTransportSubmit(t, service, serverKey, tree, "prepare", parent, 0,
		[]*wire.TxOut{{Value: 10_000, PkScript: tree.pkScript}}, nil,
		[]extension.Packet{state, phase18, extension.UnknownPacket{PacketType: 0x85, Data: ic}, extension.UnknownPacket{PacketType: 0x86, Data: key}},
	)
	if len(prepared.ArkTx.Inputs[0].TaprootScriptSpendSig) != 2 {
		t.Fatal("prepare did not receive both signatures")
	}
	aborted, _ := stagedTransportSubmit(t, service, serverKey, tree, "abort", preparedTx, 0,
		[]*wire.TxOut{{Value: 10_000, PkScript: tree.pkScript}}, nil,
		[]extension.Packet{state, phase17},
	)
	if len(aborted.ArkTx.Inputs[0].TaprootScriptSpendSig) != 2 {
		t.Fatal("abort did not receive both signatures")
	}
	for _, item := range []struct {
		name            string
		ark, checkpoint *psbt.Packet
	}{{"prepare", prepared.ArkTx, prepared.Checkpoints[0]}, {"abort", aborted.ArkTx, aborted.Checkpoints[0]}} {
		ark, _, _ := stagedTransportFinalizeWeight(t, item.ark)
		checkpoint, _, _ := stagedTransportFinalizeWeight(t, item.checkpoint)
		t.Logf("stock %s signed ten-leaf Service transport: ark=%dWU checkpoint=%dWU", item.name, ark, checkpoint)
	}
}

func TestStockProductionTransferWithdrawSealThroughServiceTransport(t *testing.T) {
	ic, fixed, g1, g2 := stockTransportAlgebraicKey(t)
	service, serverKey := stagedTransportService(t)
	oldState := bytes.Repeat([]byte{0x31}, 32)
	prepareScript, err := stockPrepareLeafScript(ic, fixed)
	if err != nil {
		t.Fatal(err)
	}
	abortScript, err := stockAbortLeafScript()
	if err != nil {
		t.Fatal(err)
	}
	programs := map[string][]byte{"prepare": prepareScript, "abort": abortScript}
	for mode := byte(0); mode < 4; mode++ {
		programs[stockModeName(mode)], err = stockCommitLeafScript(mode, ic, fixed)
		if err != nil {
			t.Fatal(err)
		}
	}
	programs["withdraw-funded"], err = stockCommitLeafScriptFunding(2, ic, fixed, true)
	if err != nil {
		t.Fatal(err)
	}
	tree := stockPolicyTransportTree(t, programs)
	parent := stagedTransportParent(t, tree.pkScript, 10_000, []extension.Packet{
		extension.UnknownPacket{PacketType: stockStatePacketType, Data: oldState},
		extension.UnknownPacket{PacketType: 0x88, Data: []byte{17}},
	})
	_, preparedTx := stagedTransportSubmit(t, service, serverKey, tree, "prepare", parent, 0,
		[]*wire.TxOut{{Value: 10_000, PkScript: tree.pkScript}}, nil,
		[]extension.Packet{
			extension.UnknownPacket{PacketType: stockStatePacketType, Data: oldState},
			extension.UnknownPacket{PacketType: 0x88, Data: []byte{18}},
			extension.UnknownPacket{PacketType: 0x85, Data: ic},
			extension.UnknownPacket{PacketType: 0x86, Data: fixed},
		},
	)
	for _, mode := range []byte{0, 2, 3} {
		mode := mode
		t.Run(stockModeName(mode), func(t *testing.T) {
			newState := bytes.Repeat([]byte{byte(0x41 + mode)}, 32)
			outputs := []*wire.TxOut{{Value: 9_900, PkScript: tree.pkScript}}
			payout, payoutProgram := uint64(0), make([]byte, 32)
			if mode == 2 {
				payout, payoutProgram = 500, bytes.Repeat([]byte{0x55}, 32)
				outputs = []*wire.TxOut{{Value: int64(payout), PkScript: stagedP2TRScript(0x55)}, {Value: 9_400, PkScript: tree.pkScript}}
			}
			packets := []extension.Packet{
				extension.UnknownPacket{PacketType: stockStatePacketType, Data: newState},
				extension.UnknownPacket{PacketType: 0x88, Data: []byte{17}},
				extension.UnknownPacket{PacketType: stockModePacketType, Data: []byte{mode}},
			}
			request := stagedTransportRequest(t, tree, stockModeName(mode), preparedTx, 0, outputs, nil, packets, nil)
			checkpoint := request.ArkTx.UnsignedTx.TxIn[0].PreviousOutPoint
			continuation := uint64(outputs[0].Value)
			if mode == 2 {
				continuation = uint64(outputs[1].Value)
			}
			binding := stockTestPreimage(mode, checkpoint, oldState, newState, 10_000, continuation, 0, payout, payoutProgram)
			request = stagedTransportRequest(t, tree, stockModeName(mode), preparedTx, 0, outputs,
				stockAlgebraicProof(g1, g2, stockExpectedScalar(binding)), packets, nil)
			if err := validateNativeAssets(context.Background(), request.ArkTx, request.Checkpoints); err != nil {
				t.Fatalf("%s native preflight: %v", stockModeName(mode), err)
			}
			result, err := service.SubmitTx(context.Background(), request, emulator.OffchainData{VtxoExpiries: map[wire.OutPoint]int64{}})
			if err != nil {
				t.Fatalf("%s production Service.SubmitTx rejected transport-only algebraic proof: %v", stockModeName(mode), err)
			}
			addStagedTransportServerSignature(t, result.ArkTx, serverKey)
			for _, cp := range result.Checkpoints {
				addStagedTransportServerSignature(t, cp, serverKey)
			}
			arkWU, _, _ := stagedTransportFinalizeWeight(t, result.ArkTx)
			cpWU, _, _ := stagedTransportFinalizeWeight(t, result.Checkpoints[0])
			t.Logf("transport-only algebraic proof: full-ten-leaf %s signed Ark=%dWU checkpoint=%dWU", stockModeName(mode), arkWU, cpWU)
		})
	}
}

func TestStockProductionDepositThroughServiceTransport(t *testing.T) {
	ic, fixed, g1, g2 := stockTransportAlgebraicKey(t)
	service, serverKey := stagedTransportService(t)
	oldState := bytes.Repeat([]byte{0x31}, 32)
	prepareScript, err := stockPrepareLeafScript(ic, fixed)
	if err != nil {
		t.Fatal(err)
	}
	abortScript, err := stockAbortLeafScript()
	if err != nil {
		t.Fatal(err)
	}
	programs := map[string][]byte{"prepare": prepareScript, "abort": abortScript}
	for mode := byte(0); mode < 4; mode++ {
		programs[stockModeName(mode)], err = stockCommitLeafScript(mode, ic, fixed)
		if err != nil {
			t.Fatal(err)
		}
	}
	programs["withdraw-funded"], err = stockCommitLeafScriptFunding(2, ic, fixed, true)
	if err != nil {
		t.Fatal(err)
	}
	tree := stockPolicyTransportTree(t, programs)
	parent := stagedTransportParent(t, tree.pkScript, 10_000, []extension.Packet{
		extension.UnknownPacket{PacketType: stockStatePacketType, Data: oldState},
		extension.UnknownPacket{PacketType: 0x88, Data: []byte{17}},
	})
	_, preparedTx := stagedTransportSubmit(t, service, serverKey, tree, "prepare", parent, 0,
		[]*wire.TxOut{{Value: 10_000, PkScript: tree.pkScript}}, nil,
		[]extension.Packet{
			extension.UnknownPacket{PacketType: stockStatePacketType, Data: oldState},
			extension.UnknownPacket{PacketType: 0x88, Data: []byte{18}},
			extension.UnknownPacket{PacketType: 0x85, Data: ic},
			extension.UnknownPacket{PacketType: 0x86, Data: fixed},
		},
	)
	newState := bytes.Repeat([]byte{0x51}, 32)
	packets := []extension.Packet{
		extension.UnknownPacket{PacketType: stockStatePacketType, Data: newState},
		extension.UnknownPacket{PacketType: 0x88, Data: []byte{17}},
		extension.UnknownPacket{PacketType: stockModePacketType, Data: []byte{1}},
	}
	outputs := []*wire.TxOut{{Value: 13_900, PkScript: tree.pkScript}}
	userKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{3}, 32))
	userScript, userLeaf := stockExternalVtxoScript(t, serverKey, userKey)
	extUtxo := wire.NewTxOut(4_000, userScript)
	fundingTx := wire.NewMsgTx(2)
	fundingTx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: [32]byte{0xef}, Index: 0}, Sequence: 0xffffffff})
	fundingTx.AddTxOut(extUtxo)
	extOutpoint := wire.OutPoint{Hash: fundingTx.TxHash(), Index: 0}
	dummy := stagedTransportRequest(t, tree, "deposit", preparedTx, 0, outputs, nil, packets, nil)
	addStockExternalVtxo(t, &dummy, fundingTx, extOutpoint, extUtxo, userKey, userLeaf)
	checkpoint := dummy.ArkTx.UnsignedTx.TxIn[0].PreviousOutPoint
	binding := stockTestPreimage(1, checkpoint, oldState, newState, 10_000, 13_900, 4_000, 0, make([]byte, 32))
	request := stagedTransportRequest(t, tree, "deposit", preparedTx, 0, outputs,
		stockAlgebraicProof(g1, g2, stockExpectedScalar(binding)), packets, nil)
	addStockExternalVtxo(t, &request, fundingTx, extOutpoint, extUtxo, userKey, userLeaf)
	if err := validateNativeAssets(context.Background(), request.ArkTx, request.Checkpoints); err != nil {
		t.Fatalf("deposit native preflight: %v", err)
	}
	result, err := service.SubmitTx(context.Background(), request, emulator.OffchainData{VtxoExpiries: map[wire.OutPoint]int64{}})
	if err != nil {
		t.Fatalf("production Service.SubmitTx rejected two-input deposit: %v", err)
	}
	addStagedTransportServerSignature(t, result.ArkTx, serverKey)
	for _, cp := range result.Checkpoints {
		addStagedTransportServerSignature(t, cp, serverKey)
	}
	arkWU, _, _ := stagedTransportFinalizeWeight(t, result.ArkTx)
	cpWU, _, _ := stagedTransportFinalizeWeight(t, result.Checkpoints[0])
	t.Logf("transport-only algebraic proof: full-ten-leaf deposit with default customer VTXO Ark=%dWU checkpoint=%dWU", arkWU, cpWU)
}

func TestStockProductionFundedWithdrawThroughFullPolicyServiceTransport(t *testing.T) {
	ic, fixed, g1, g2 := stockTransportAlgebraicKey(t)
	service, serverKey := stagedTransportService(t)
	oldState := bytes.Repeat([]byte{0x31}, 32)
	prepareScript, err := stockPrepareLeafScript(ic, fixed)
	if err != nil {
		t.Fatal(err)
	}
	abortScript, err := stockAbortLeafScript()
	if err != nil {
		t.Fatal(err)
	}
	programs := map[string][]byte{"prepare": prepareScript, "abort": abortScript}
	for mode := byte(0); mode < 4; mode++ {
		programs[stockModeName(mode)], err = stockCommitLeafScript(mode, ic, fixed)
		if err != nil {
			t.Fatal(err)
		}
	}
	programs["withdraw-funded"], err = stockCommitLeafScriptFunding(2, ic, fixed, true)
	if err != nil {
		t.Fatal(err)
	}
	tree := stockPolicyTransportTree(t, programs)
	parent := stagedTransportParent(t, tree.pkScript, 10_000, []extension.Packet{
		extension.UnknownPacket{PacketType: stockStatePacketType, Data: oldState},
		extension.UnknownPacket{PacketType: 0x88, Data: []byte{17}},
	})
	_, preparedTx := stagedTransportSubmit(t, service, serverKey, tree, "prepare", parent, 0,
		[]*wire.TxOut{{Value: 10_000, PkScript: tree.pkScript}}, nil,
		[]extension.Packet{
			extension.UnknownPacket{PacketType: stockStatePacketType, Data: oldState},
			extension.UnknownPacket{PacketType: 0x88, Data: []byte{18}},
			extension.UnknownPacket{PacketType: 0x85, Data: ic},
			extension.UnknownPacket{PacketType: 0x86, Data: fixed},
		},
	)
	newState := bytes.Repeat([]byte{0x52}, 32)
	packets := []extension.Packet{
		extension.UnknownPacket{PacketType: stockStatePacketType, Data: newState},
		extension.UnknownPacket{PacketType: 0x88, Data: []byte{17}},
		extension.UnknownPacket{PacketType: stockModePacketType, Data: []byte{2}},
	}
	const funding, payout, continuation = uint64(2_500), uint64(3_000), uint64(9_500)
	outputs := []*wire.TxOut{
		{Value: int64(payout), PkScript: stagedP2TRScript(0x55)},
		{Value: int64(continuation), PkScript: tree.pkScript},
	}
	userKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{4}, 32))
	userScript, userLeaf := stockExternalVtxoScript(t, serverKey, userKey)
	extUtxo := wire.NewTxOut(int64(funding), userScript)
	fundingTx := wire.NewMsgTx(2)
	fundingTx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: [32]byte{0xef}, Index: 1}, Sequence: 0xffffffff})
	fundingTx.AddTxOut(extUtxo)
	extOutpoint := wire.OutPoint{Hash: fundingTx.TxHash(), Index: 0}
	request := stagedTransportRequest(t, tree, "withdraw-funded", preparedTx, 0, outputs, nil, packets, nil)
	addStockExternalVtxo(t, &request, fundingTx, extOutpoint, extUtxo, userKey, userLeaf)
	checkpoint := request.ArkTx.UnsignedTx.TxIn[0].PreviousOutPoint
	binding := stockTestPreimage(2, checkpoint, oldState, newState, 10_000, continuation, funding, payout, bytes.Repeat([]byte{0x55}, 32))
	request = stagedTransportRequest(t, tree, "withdraw-funded", preparedTx, 0, outputs,
		stockAlgebraicProof(g1, g2, stockExpectedScalar(binding)), packets, nil)
	addStockExternalVtxo(t, &request, fundingTx, extOutpoint, extUtxo, userKey, userLeaf)
	if err := validateNativeAssets(context.Background(), request.ArkTx, request.Checkpoints); err != nil {
		t.Fatalf("funded withdrawal native preflight: %v", err)
	}
	result, err := service.SubmitTx(context.Background(), request, emulator.OffchainData{VtxoExpiries: map[wire.OutPoint]int64{}})
	if err != nil {
		t.Fatalf("production Service.SubmitTx rejected two-input funded withdrawal: %v", err)
	}
	addStagedTransportServerSignature(t, result.ArkTx, serverKey)
	for _, cp := range result.Checkpoints {
		addStagedTransportServerSignature(t, cp, serverKey)
	}
	arkWU, _, _ := stagedTransportFinalizeWeight(t, result.ArkTx)
	cpWU, _, _ := stagedTransportFinalizeWeight(t, result.Checkpoints[0])
	t.Logf("transport-only algebraic proof: full-ten-leaf funded withdraw with default customer VTXO Ark=%dWU checkpoint=%dWU", arkWU, cpWU)
}

func stockExternalVtxoScript(t *testing.T, serverKey, userKey *btcec.PrivateKey) ([]byte, *psbt.TaprootTapLeafScript) {
	t.Helper()
	closure := &arkscript.MultisigClosure{PubKeys: []*btcec.PublicKey{serverKey.PubKey(), userKey.PubKey()}}
	closureScript, err := closure.Script()
	if err != nil {
		t.Fatal(err)
	}
	exit := &arkscript.CSVMultisigClosure{
		MultisigClosure: arkscript.MultisigClosure{PubKeys: []*btcec.PublicKey{userKey.PubKey()}},
		Locktime:        arklib.RelativeLocktime{Type: arklib.LocktimeTypeSecond, Value: 2048},
	}
	vtxoScript := arkscript.TapscriptsVtxoScript{Closures: []arkscript.Closure{exit, closure}}
	tapKey, tree, err := vtxoScript.TapTree()
	if err != nil {
		t.Fatal(err)
	}
	pkScript, err := arkscript.P2TRScript(tapKey)
	if err != nil {
		t.Fatal(err)
	}
	leaf := txscript.NewBaseTapLeaf(closureScript)
	proof, err := tree.GetTaprootMerkleProof(leaf.TapHash())
	if err != nil {
		t.Fatal(err)
	}
	return pkScript, &psbt.TaprootTapLeafScript{ControlBlock: proof.ControlBlock, Script: proof.Script, LeafVersion: txscript.BaseLeafVersion}
}

func stockPolicyTransportTree(t *testing.T, vmScripts map[string][]byte) stagedTransportTree {
	t.Helper()
	emulatorKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	serverKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	closures := make(map[string]arkscript.Closure, len(vmScripts)+3)
	for name, vmScript := range vmScripts {
		tweaked := arkade.ComputeArkadeScriptPublicKey(emulatorKey.PubKey(), arkade.ArkadeScriptHash(vmScript))
		closures[name] = &arkscript.MultisigClosure{PubKeys: []*btcec.PublicKey{serverKey.PubKey(), tweaked}}
	}
	for _, name := range []string{"prepare", "withdraw", "withdraw-funded"} {
		vmScript, ok := vmScripts[name]
		if !ok {
			t.Fatalf("missing script %q for its exit leaf", name)
		}
		tweaked := arkade.ComputeArkadeScriptPublicKey(emulatorKey.PubKey(), arkade.ArkadeScriptHash(vmScript))
		closures["exit-"+name] = &arkscript.CSVMultisigClosure{
			MultisigClosure: arkscript.MultisigClosure{PubKeys: []*btcec.PublicKey{tweaked}},
			Locktime:        arklib.RelativeLocktime{Type: arklib.LocktimeTypeSecond, Value: 2048},
		}
	}
	names := make([]string, 0, len(closures))
	for name := range closures {
		names = append(names, name)
	}
	sort.Strings(names)
	allClosures := make([]arkscript.Closure, 0, len(names))
	closureScripts := make(map[string][]byte, len(names))
	for _, name := range names {
		closure := closures[name]
		encoded, err := closure.Script()
		if err != nil {
			t.Fatal(err)
		}
		allClosures = append(allClosures, closure)
		closureScripts[name] = encoded
	}
	vtxoScript := arkscript.TapscriptsVtxoScript{Closures: allClosures}
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
		phases[name] = stagedTransportPhase{vmScript: vmScript, leaf: &psbt.TaprootTapLeafScript{
			ControlBlock: proof.ControlBlock, Script: proof.Script, LeafVersion: txscript.BaseLeafVersion,
		}}
	}
	return stagedTransportTree{pkScript: pkScript, phases: phases}
}

func addStockExternalVtxo(t *testing.T, request *emulator.OffchainTx, fundingTx *wire.MsgTx, outpoint wire.OutPoint, utxo *wire.TxOut, key *btcec.PrivateKey, leaf *psbt.TaprootTapLeafScript) {
	t.Helper()
	checkpointTx := wire.NewMsgTx(2)
	checkpointTx.AddTxIn(&wire.TxIn{PreviousOutPoint: outpoint, Sequence: 0xfffffffe})
	checkpointTx.AddTxOut(utxo)
	checkpointTx.AddTxOut(txutils.AnchorOutput())
	checkpoint, err := psbt.NewFromUnsignedTx(checkpointTx)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint.Inputs[0].WitnessUtxo = fundingTx.TxOut[outpoint.Index]
	checkpoint.Inputs[0].SighashType = txscript.SigHashDefault
	checkpoint.Inputs[0].TaprootLeafScript = []*psbt.TaprootTapLeafScript{leaf}
	checkpointFetcher := txscript.NewMultiPrevOutFetcher(map[wire.OutPoint]*wire.TxOut{outpoint: fundingTx.TxOut[outpoint.Index]})
	checkpointSig, err := txscript.RawTxInTapscriptSignature(checkpointTx,
		txscript.NewTxSigHashes(checkpointTx, checkpointFetcher), 0, checkpoint.Inputs[0].WitnessUtxo.Value,
		checkpoint.Inputs[0].WitnessUtxo.PkScript, txscript.NewBaseTapLeaf(leaf.Script), txscript.SigHashDefault, key)
	if err != nil {
		t.Fatal(err)
	}
	checkpoint.Inputs[0].TaprootScriptSpendSig = append(checkpoint.Inputs[0].TaprootScriptSpendSig,
		stockTapScriptSpendSig(checkpointSig, key, leaf))
	request.Checkpoints = append(request.Checkpoints, checkpoint)
	tx := request.ArkTx.UnsignedTx
	tx.AddTxIn(&wire.TxIn{PreviousOutPoint: wire.OutPoint{Hash: checkpointTx.TxHash(), Index: 0}, Sequence: 0xfffffffe})
	request.ArkTx.Inputs = append(request.ArkTx.Inputs, psbt.PInput{
		WitnessUtxo: utxo, SighashType: txscript.SigHashDefault, TaprootLeafScript: []*psbt.TaprootTapLeafScript{leaf},
	})
	if err := txutils.SetArkPsbtField(request.ArkTx, 1, arkade.PrevArkTxField, *fundingTx); err != nil {
		t.Fatal(err)
	}
	prevouts := make(map[wire.OutPoint]*wire.TxOut, len(request.ArkTx.Inputs))
	for i, input := range request.ArkTx.Inputs {
		prevouts[tx.TxIn[i].PreviousOutPoint] = input.WitnessUtxo
	}
	fetcher := txscript.NewMultiPrevOutFetcher(prevouts)
	hashes := txscript.NewTxSigHashes(tx, fetcher)
	sig, err := txscript.RawTxInTapscriptSignature(tx, hashes, 1, utxo.Value, utxo.PkScript, txscript.NewBaseTapLeaf(leaf.Script), txscript.SigHashDefault, key)
	if err != nil {
		t.Fatal(err)
	}
	request.ArkTx.Inputs[1].TaprootScriptSpendSig = append(request.ArkTx.Inputs[1].TaprootScriptSpendSig,
		stockTapScriptSpendSig(sig, key, leaf))
}

func stockTapScriptSpendSig(sig []byte, key *btcec.PrivateKey, leaf *psbt.TaprootTapLeafScript) *psbt.TaprootScriptSpendSig {
	leafHash := txscript.NewBaseTapLeaf(leaf.Script).TapHash()
	return &psbt.TaprootScriptSpendSig{
		Signature: sig, XOnlyPubKey: schnorr.SerializePubKey(key.PubKey()), LeafHash: leafHash[:], SigHash: txscript.SigHashDefault,
	}
}
