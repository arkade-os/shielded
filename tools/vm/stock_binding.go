package main

import (
	"errors"
	"math/big"

	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
)

const (
	stockStatePacketType = 0x87
	stockModePacketType  = 0x89
)

// stockStatementScript derives the Groth16 public scalar from native Ark
// transaction facts. It is specialized per operation, and checks packet 0x89.
func stockStatementScript(mode byte) ([]byte, error) {
	return stockStatementScriptModePacket(mode, true)
}

func stockStatementScriptModePacket(mode byte, checkModePacket bool) ([]byte, error) {
	return stockStatementScriptFunding(mode, checkModePacket, false)
}

func stockStatementScriptFunding(mode byte, checkModePacket, fundedWithdraw bool) ([]byte, error) {
	if mode > 3 {
		return nil, errors.New("unknown stock operation mode")
	}
	if fundedWithdraw && mode != 2 {
		return nil, errors.New("external funding is only valid for a withdrawal leaf")
	}
	b := txscript.NewScriptBuilder()
	if checkModePacket {
		b.AddInt64(stockModePacketType).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_VERIFY)
		b.AddOp(txscript.OP_SIZE).AddInt64(1).AddOp(txscript.OP_NUMEQUALVERIFY)
		b.AddOp(arkade.OP_BIN2NUM).AddInt64(int64(mode)).AddOp(txscript.OP_NUMEQUALVERIFY)
	}

	b.AddData([]byte{0x53, 0x48, 0x01, 0x00, mode})
	b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTOUTPOINT).AddInt64(4).AddOp(arkade.OP_NUM2BIN).AddOp(arkade.OP_CAT).AddOp(txscript.OP_CAT)
	stockAppendPacket(b, stockStatePacketType, true)
	stockAppendPacket(b, stockStatePacketType, false)
	stockAppendValue(b, true, 0, true)
	stockAppendValue(b, false, stockContinuationIndex(mode), true)
	switch mode {
	case 0, 3:
		stockAppendZeros(b, 48)
	case 1:
		stockAppendValue(b, true, 1, true)
		stockAppendZeros(b, 40)
	case 2:
		if fundedWithdraw {
			stockAppendValue(b, true, 1, true)
		} else {
			stockAppendZeros(b, 8)
		}
		stockAppendValue(b, false, 0, true)
		b.AddInt64(0).AddOp(arkade.OP_INSPECTOUTPUTSCRIPTPUBKEY)
		b.AddOp(txscript.OP_1).AddOp(txscript.OP_EQUALVERIFY)
		b.AddOp(txscript.OP_SIZE).AddInt64(32).AddOp(txscript.OP_NUMEQUALVERIFY).AddOp(txscript.OP_CAT)
	}
	b.AddInt64(0).AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_NOT).AddOp(txscript.OP_VERIFY)
	b.AddOp(arkade.OP_SHA256).AddOp(txscript.OP_CAT)
	b.AddOp(txscript.OP_SHA256).AddInt64(31).AddOp(txscript.OP_LEFT)
	b.AddOp(txscript.OP_0).AddOp(txscript.OP_1).AddOp(arkade.OP_NUM2BIN).AddOp(txscript.OP_CAT)
	b.AddOp(arkade.OP_BIN2NUM)
	return b.Script()
}

func stockContinuationIndex(mode byte) int64 {
	if mode == 2 {
		return 1
	}
	return 0
}

func stockModeName(mode byte) string {
	switch mode {
	case 0:
		return "transfer"
	case 1:
		return "deposit"
	case 2:
		return "withdraw"
	default:
		return "seal"
	}
}

func stockAppendZeros(b *txscript.ScriptBuilder, size int64) {
	b.AddOp(txscript.OP_0).AddInt64(size).AddOp(arkade.OP_NUM2BIN).AddOp(txscript.OP_CAT)
}

func stockAppendPacket(b *txscript.ScriptBuilder, packetType byte, parent bool) {
	b.AddInt64(int64(packetType))
	if parent {
		b.AddInt64(0).AddOp(arkade.OP_INSPECTINPUTPACKET).AddOp(txscript.OP_VERIFY)
	} else {
		b.AddOp(arkade.OP_INSPECTPACKET).AddOp(txscript.OP_VERIFY)
	}
	b.AddOp(txscript.OP_SIZE).AddInt64(32).AddOp(txscript.OP_NUMEQUALVERIFY).AddOp(txscript.OP_CAT)
}

func stockAppendValue(b *txscript.ScriptBuilder, input bool, index int64, include bool) {
	if !include {
		b.AddData(make([]byte, 8)).AddOp(txscript.OP_CAT)
		return
	}
	b.AddInt64(index)
	if input {
		b.AddOp(arkade.OP_INSPECTINPUTVALUE)
	} else {
		b.AddOp(arkade.OP_INSPECTOUTPUTVALUE)
	}
	b.AddInt64(8).AddOp(arkade.OP_NUM2BIN).AddOp(txscript.OP_CAT)
}

func stockScriptNumBytes(value *big.Int) []byte {
	if value.Sign() == 0 {
		return nil
	}
	encoded := make([]byte, (value.BitLen()+7)/8)
	value.FillBytes(encoded)
	for left, right := 0, len(encoded)-1; left < right; left, right = left+1, right-1 {
		encoded[left], encoded[right] = encoded[right], encoded[left]
	}
	if encoded[len(encoded)-1]&0x80 != 0 {
		encoded = append(encoded, 0)
	}
	return encoded
}
