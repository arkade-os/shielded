package main

import (
	"crypto/sha256"
	"errors"

	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
)

func stockProofProgramScript(mode byte, icPacket, fixedKeyPacket []byte) ([]byte, error) {
	return stockProofProgramScriptFunding(mode, icPacket, fixedKeyPacket, false)
}

func stockProofProgramScriptFunding(mode byte, icPacket, fixedKeyPacket []byte, fundedWithdraw bool) ([]byte, error) {
	if len(icPacket) != 128 || len(fixedKeyPacket) != 448 {
		return nil, errors.New("Groth16 parent packets must be 128 and 448 bytes")
	}
	statement, err := stockStatementScriptFunding(mode, false, fundedWithdraw)
	if err != nil {
		return nil, err
	}
	parentNoAssets, err := stockNoAssetsScript(true)
	if err != nil {
		return nil, err
	}
	keyBytes := append(append([]byte(nil), icPacket...), fixedKeyPacket...)
	keyHash := sha256.Sum256(keyBytes)
	verifier, err := stockGroth16VerifierScriptPinned(keyHash[:], icPacket, fixedKeyPacket)
	if err != nil {
		return nil, err
	}
	return append(stockConcat(parentNoAssets, statement), verifier...), nil
}

func stockCommitLeafScript(mode byte, icPacket, fixedKeyPacket []byte) ([]byte, error) {
	return stockCommitLeafScriptFunding(mode, icPacket, fixedKeyPacket, false)
}

func stockCommitLeafScriptFunding(mode byte, icPacket, fixedKeyPacket []byte, fundedWithdraw bool) ([]byte, error) {
	proof, err := stockProofProgramScriptFunding(mode, icPacket, fixedKeyPacket, fundedWithdraw)
	if err != nil {
		return nil, err
	}
	inputs := int64(0)
	if fundedWithdraw {
		inputs = 2
	}
	shape, err := stockCommitShapeAndPolicyScriptInputs(mode, inputs)
	if err != nil {
		return nil, err
	}
	script, err := stockPhaseScript(18, 17)
	if err != nil {
		return nil, err
	}
	script = append(script, proof...)
	script = append(script, txscript.OP_VERIFY)
	script = append(script, shape...)
	return append(script, txscript.OP_1), nil
}

func stockPrepareLeafScript(icPacket, fixedKeyPacket []byte) ([]byte, error) {
	if len(icPacket) != 128 || len(fixedKeyPacket) != 448 {
		return nil, errors.New("Groth16 parent packets must be 128 and 448 bytes")
	}
	preserve, err := stockPreserveScript(3, 0)
	if err != nil {
		return nil, err
	}
	phase, err := stockPhaseScript(17, 18)
	if err != nil {
		return nil, err
	}
	keyBytes := append(append([]byte(nil), icPacket...), fixedKeyPacket...)
	keyHash := sha256.Sum256(keyBytes)
	keys, err := stockRequireCombinedKey(keyHash[:])
	if err != nil {
		return nil, err
	}
	noAssets, err := stockNoAssetsScript(true)
	if err != nil {
		return nil, err
	}
	currentNoAssets, err := stockNoAssetsScript(false)
	if err != nil {
		return nil, err
	}
	root, err := stockSameStateScript()
	if err != nil {
		return nil, err
	}
	return stockConcat(preserve, root, phase, keys, noAssets, currentNoAssets, []byte{txscript.OP_1}), nil
}

func stockAbortLeafScript() ([]byte, error) {
	preserve, err := stockPreserveScript(3, 0)
	if err != nil {
		return nil, err
	}
	root, err := stockSameStateScript()
	if err != nil {
		return nil, err
	}
	phase, err := stockPhaseScript(18, 17)
	if err != nil {
		return nil, err
	}
	missingIC, err := stockRequirePacketAbsent(0x85)
	if err != nil {
		return nil, err
	}
	missingVK, err := stockRequirePacketAbsent(0x86)
	if err != nil {
		return nil, err
	}
	parentNoAssets, err := stockNoAssetsScript(true)
	if err != nil {
		return nil, err
	}
	currentNoAssets, err := stockNoAssetsScript(false)
	if err != nil {
		return nil, err
	}
	return stockConcat(preserve, root, phase, missingIC, missingVK, parentNoAssets, currentNoAssets, []byte{txscript.OP_1}), nil
}

func stockShapeAndPolicyScript(mode byte) ([]byte, error) {
	return stockShapeAndPolicyScriptInputs(mode, 0)
}

func stockShapeAndPolicyScriptInputs(mode byte, inputOverride int64) ([]byte, error) {
	return stockShapeAndPolicyScriptInputsAux(mode, inputOverride, true)
}

func stockCommitShapeAndPolicyScriptInputs(mode byte, inputOverride int64) ([]byte, error) {
	return stockShapeAndPolicyScriptInputsAux(mode, inputOverride, false)
}

func stockShapeAndPolicyScriptInputsAux(mode byte, inputOverride int64, enforceAuxZero bool) ([]byte, error) {
	inputs, outputs, continuation := int64(1), int64(3), int64(0)
	if mode == 1 {
		inputs = 2
	} else if mode == 2 {
		outputs, continuation = 4, 1
	} else if mode > 3 {
		return nil, errors.New("unknown stock operation mode")
	}
	if inputOverride > 0 {
		inputs = inputOverride
	}
	b := txscript.NewScriptBuilder()
	b.AddOp(arkade.OP_INSPECTNUMINPUTS).AddInt64(inputs).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddOp(arkade.OP_INSPECTNUMOUTPUTS).AddInt64(outputs).AddOp(txscript.OP_NUMEQUALVERIFY)
	if enforceAuxZero {
		for i := int64(1); i < outputs; i++ {
			if mode == 2 && i == 1 {
				continue
			}
			b.AddInt64(i).AddOp(arkade.OP_INSPECTOUTPUTVALUE).AddInt64(0).AddOp(txscript.OP_NUMEQUALVERIFY)
		}
	}
	b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTSCRIPTPUBKEY)
	b.AddInt64(continuation).AddOp(arkade.OP_INSPECTOUTPUTSCRIPTPUBKEY)
	b.AddOp(txscript.OP_ROT).AddOp(txscript.OP_NUMEQUALVERIFY).AddOp(txscript.OP_EQUALVERIFY)
	return b.Script()
}

func stockPreserveScript(outputs, continuation int64) ([]byte, error) {
	b := txscript.NewScriptBuilder()
	b.AddOp(arkade.OP_INSPECTNUMINPUTS).AddInt64(1).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddOp(arkade.OP_INSPECTNUMOUTPUTS).AddInt64(outputs).AddOp(txscript.OP_NUMEQUALVERIFY)
	for i := int64(1); i < outputs; i++ {
		b.AddInt64(i).AddOp(arkade.OP_INSPECTOUTPUTVALUE).AddInt64(0).AddOp(txscript.OP_NUMEQUALVERIFY)
	}
	b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTVALUE)
	b.AddInt64(continuation).AddOp(arkade.OP_INSPECTOUTPUTVALUE).AddOp(txscript.OP_EQUALVERIFY)
	b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTSCRIPTPUBKEY).AddOp(txscript.OP_TOALTSTACK)
	b.AddInt64(continuation).AddOp(arkade.OP_INSPECTOUTPUTSCRIPTPUBKEY).AddOp(txscript.OP_TOALTSTACK)
	b.AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_NUMEQUALVERIFY).AddOp(txscript.OP_EQUALVERIFY)
	return b.Script()
}

func stockSameStateScript() ([]byte, error) {
	b := txscript.NewScriptBuilder()
	stockReadPacket(b, 0x87, true)
	stockReadPacket(b, 0x87, false)
	b.AddOp(txscript.OP_EQUALVERIFY)
	return b.Script()
}

func stockPhaseScript(oldPhase, newPhase byte) ([]byte, error) {
	b := txscript.NewScriptBuilder()
	stockReadPacket(b, 0x88, true)
	b.AddData([]byte{oldPhase}).AddOp(txscript.OP_EQUALVERIFY)
	stockReadPacket(b, 0x88, false)
	b.AddData([]byte{newPhase}).AddOp(txscript.OP_EQUALVERIFY)
	return b.Script()
}

func stockReadPacket(b *txscript.ScriptBuilder, packetType byte, parent bool) {
	b.AddInt64(int64(packetType))
	if parent {
		b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTPACKET).AddOp(txscript.OP_VERIFY)
	} else {
		b.AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_VERIFY)
	}
	if packetType == stockStatePacketType {
		b.AddOp(txscript.OP_SIZE).AddInt64(32).AddOp(txscript.OP_NUMEQUALVERIFY)
	}
}

func stockRequireCombinedKey(hash []byte) ([]byte, error) {
	if len(hash) != 32 {
		return nil, errors.New("combined key packet pin must be 32 bytes")
	}
	b := txscript.NewScriptBuilder()
	b.AddInt64(0x85).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_VERIFY)
	b.AddOp(txscript.OP_SIZE).AddInt64(128).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddOp(txscript.OP_DUP).AddOp(arkade.OP_SHA256INITIALIZE).AddOp(txscript.OP_SWAP).AddOp(txscript.OP_DROP)
	b.AddInt64(0x86).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_VERIFY)
	b.AddOp(txscript.OP_TUCK).AddOp(arkade.OP_SHA256FINALIZE)
	b.AddData(hash).AddOp(txscript.OP_EQUALVERIFY).AddOp(txscript.OP_DROP)
	return b.Script()
}

func stockRequirePacketAbsent(packetType byte) ([]byte, error) {
	b := txscript.NewScriptBuilder()
	b.AddInt64(int64(packetType)).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_NOT).AddOp(txscript.OP_VERIFY).AddOp(txscript.OP_DROP)
	return b.Script()
}

func stockNoAssetsScript(parent bool) ([]byte, error) {
	b := txscript.NewScriptBuilder()
	b.AddInt64(0)
	if parent {
		b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTPACKET)
	} else {
		b.AddOp(arkade.OP_INSPECTPACKET)
	}
	b.AddOp(txscript.OP_NOT).AddOp(txscript.OP_VERIFY).AddOp(txscript.OP_DROP)
	return b.Script()
}

func stockConcat(parts ...[]byte) []byte {
	var script []byte
	for _, part := range parts {
		script = append(script, part...)
	}
	return script
}

// stockGroth16VerifierScript verifies a BN254 Groth16 proof using the pinned
// IC and fixed-key packet hashes. The stack begins A, B, C coordinates, then
// the public scalar; a caller must derive that scalar from native tx facts.
func stockGroth16VerifierScript(combinedHash []byte) ([]byte, error) {
	return stockGroth16VerifierScriptPinned(combinedHash, nil, nil)
}

func stockGroth16VerifierScriptPinned(combinedHash, icPacket, fixedKeyPacket []byte) ([]byte, error) {
	if len(combinedHash) != 32 {
		return nil, errors.New("combined Groth16 packet hash must be 32 bytes")
	}

	b := txscript.NewScriptBuilder()
	b.AddInt64(0x85).AddInt64(0).AddOp(arkade.OP_INSPECTINPUTPACKET).AddOp(txscript.OP_VERIFY)
	b.AddOp(txscript.OP_SIZE).AddInt64(128).AddOp(txscript.OP_NUMEQUALVERIFY)
	b.AddOp(txscript.OP_DUP).AddOp(arkade.OP_SHA256INITIALIZE).AddOp(txscript.OP_SWAP)
	for _, offset := range []int64{0, 32, 64, 96} {
		stockExtractPinnedKeyCoordinate(b, offset, icPacket)
	}
	b.AddOp(txscript.OP_DROP)
	b.AddOp(txscript.OP_5).AddOp(txscript.OP_ROLL).AddInt64(arkade.CurveAltBN128).AddOp(arkade.OP_ECMUL)
	b.AddInt64(arkade.CurveAltBN128).AddOp(arkade.OP_ECADD)
	b.AddOp(txscript.OP_TOALTSTACK).AddOp(txscript.OP_TOALTSTACK)

	b.AddInt64(0x86).AddInt64(0).AddOp(arkade.OP_INSPECTINPUTPACKET).AddOp(txscript.OP_VERIFY)
	b.AddOp(txscript.OP_DUP).AddOp(txscript.OP_2).AddOp(txscript.OP_ROLL).AddOp(txscript.OP_SWAP).AddOp(arkade.OP_SHA256FINALIZE).AddData(combinedHash).AddOp(txscript.OP_EQUALVERIFY)
	for _, offset := range []int64{0, 32, 64, 96} {
		stockExtractPinnedKeyCoordinate(b, offset, fixedKeyPacket)
	}
	b.AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_FROMALTSTACK).AddOp(txscript.OP_2).AddOp(txscript.OP_ROLL)
	for _, offset := range []int64{128, 160, 192, 224, 256, 288, 320, 352, 384, 416} {
		stockExtractPinnedKeyCoordinate(b, offset, fixedKeyPacket)
	}
	b.AddOp(txscript.OP_DROP)
	b.AddInt64(4).AddInt64(arkade.CurveAltBN128).AddOp(arkade.OP_ECPAIRING)
	return b.Script()
}

func stockExtractTopPacket(b *txscript.ScriptBuilder, start int64) {
	b.AddOp(txscript.OP_DUP).AddInt64(start).AddInt64(32).AddOp(arkade.OP_SUBSTR).AddOp(arkade.OP_BIN2NUM).AddOp(txscript.OP_SWAP)
}

func stockExtractPinnedKeyCoordinate(b *txscript.ScriptBuilder, start int64, packet []byte) {
	b.AddOp(txscript.OP_DUP).AddInt64(start).AddInt64(32).AddOp(arkade.OP_SUBSTR)
	if !stockMinimalPositiveScriptNum(packet, start) {
		b.AddOp(arkade.OP_BIN2NUM)
	}
	b.AddOp(txscript.OP_SWAP)
}

func stockMinimalPositiveScriptNum(packet []byte, start int64) bool {
	if start < 0 || int(start)+32 > len(packet) {
		return false
	}
	coordinate := packet[start : start+32]
	return coordinate[31] > 0 && coordinate[31] < 0x80
}
