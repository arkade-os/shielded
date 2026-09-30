package main

import (
	"bytes"
	"encoding/hex"
	"fmt"

	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

type tracePrevouts struct {
	txscript.PrevOutputFetcher
	originals map[wire.OutPoint]*wire.MsgTx
	indices   map[wire.OutPoint]uint32
}

func (f *tracePrevouts) FetchPrevOutArkTx(point wire.OutPoint) *wire.MsgTx { return f.originals[point] }
func (f *tracePrevouts) FetchVtxoPrevOutPkScript(point wire.OutPoint) []byte {
	tx, index := f.originals[point], f.indices[point]
	if tx == nil || int(index) >= len(tx.TxOut) {
		return nil
	}
	return tx.TxOut[index].PkScript
}

type traceOpcode struct {
	Ordinal int    `json:"ordinal"`
	PC      int32  `json:"pc"`
	Op      string `json:"op"`
}
type traceStep struct {
	Next       traceOpcode `json:"next"`
	StackDepth int         `json:"stackDepth"`
	Top        []string    `json:"top"`
}
type inputTrace struct {
	Vin   uint16      `json:"vin"`
	Error string      `json:"error,omitempty"`
	Last  []traceStep `json:"last"`
}

// Diagnostic execution does not sign anything or override any acceptance rule.
// It reconstructs the same checkpoint/original-transaction mapping used by
// SubmitTx and keeps the canonical per-input/request compute budgets.
func diagnose(req request) (result any) {
	defer func() {
		if recovered := recover(); recovered != nil {
			result = map[string]any{"diagnosticOnly": true, "traceError": fmt.Sprintf("malformed diagnostic request: %v", recovered)}
		}
	}()
	ark, err := decodePSBT(req.ArkTx)
	if err != nil {
		return map[string]string{"traceError": err.Error()}
	}
	checkpoints := make(map[string]*wire.MsgTx)
	for _, value := range req.Checkpoints {
		cp, e := decodePSBT(value)
		if e != nil {
			return map[string]string{"traceError": e.Error()}
		}
		checkpoints[cp.UnsignedTx.TxID()] = cp.UnsignedTx
	}
	prevouts := make(map[wire.OutPoint]*wire.TxOut)
	fetcher := &tracePrevouts{originals: make(map[wire.OutPoint]*wire.MsgTx), indices: make(map[wire.OutPoint]uint32)}
	for vin, input := range ark.Inputs {
		point := ark.UnsignedTx.TxIn[vin].PreviousOutPoint
		prevouts[point] = input.WitnessUtxo
		fields, e := txutils.GetArkPsbtFields(ark, vin, arkade.PrevArkTxField)
		cp := checkpoints[point.Hash.String()]
		if e != nil || len(fields) != 1 || cp == nil || len(cp.TxIn) != 1 {
			return map[string]string{"traceError": fmt.Sprintf("missing predecessor for vin %d", vin)}
		}
		original := fields[0]
		fetcher.originals[point] = &original
		fetcher.indices[point] = cp.TxIn[0].PreviousOutPoint.Index
	}
	fetcher.PrevOutputFetcher = txscript.NewMultiPrevOutFetcher(prevouts)
	expiries := make(map[wire.OutPoint]int64)
	for _, value := range req.VtxoExpiries {
		hash, e := chainhash.NewHashFromStr(value.TxID)
		if e != nil {
			return map[string]string{"traceError": "invalid expiry transaction ID"}
		}
		expiries[wire.OutPoint{Hash: *hash, Index: value.Vout}] = value.Expiry
	}
	packet, err := arkade.FindEmulatorPacket(ark.UnsignedTx)
	if err != nil {
		return map[string]string{"traceError": err.Error()}
	}
	key, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	budget := arkade.NewComputeBudget()
	traces := make([]inputTrace, 0, len(packet))
	for _, entry := range packet {
		trace := inputTrace{Vin: entry.Vin}
		script, e := arkade.ReadArkadeScript(ark, key.PubKey(), entry)
		if e != nil {
			trace.Error = e.Error()
			traces = append(traces, trace)
			break
		}
		tokenizer := arkade.MakeScriptTokenizer(0, script.Script())
		ops := make([]traceOpcode, 0)
		needsExpiry := false
		for tokenizer.Next() {
			needsExpiry = needsExpiry || tokenizer.Opcode() == arkade.OP_PUSHEXPIRY
			name := ""
			for n, code := range arkade.OpcodeByName {
				if code == tokenizer.Opcode() {
					name = n
					break
				}
			}
			if name == "" {
				name = fmt.Sprintf("PUSH:%s", hex.EncodeToString(tokenizer.Data()))
			}
			ops = append(ops, traceOpcode{Ordinal: len(ops), PC: tokenizer.ByteIndex(), Op: name})
		}
		if tokenizer.Err() != nil {
			trace.Error = tokenizer.Err().Error()
			traces = append(traces, trace)
			break
		}
		var scriptExpiry int64
		if needsExpiry {
			point := ark.UnsignedTx.TxIn[entry.Vin].PreviousOutPoint
			original := fetcher.originals[point]
			originalPoint := wire.OutPoint{Hash: original.TxHash(), Index: fetcher.indices[point]}
			var exists bool
			scriptExpiry, exists = expiries[originalPoint]
			if !exists || scriptExpiry <= 0 {
				trace.Error = fmt.Sprintf("vtxo %s has no provided positive expiry", originalPoint)
				traces = append(traces, trace)
				break
			}
		}
		callback := func(step *arkade.StepInfo, _ *arkade.Engine) error {
			index := step.OpcodeIndex
			next := traceOpcode{Ordinal: index, Op: "end"}
			if index >= 0 && index < len(ops) {
				next = ops[index]
			}
			top := make([]string, 0, 8)
			for i := len(step.Stack) - 1; i >= 0 && len(top) < 8; i-- {
				value := step.Stack[i]
				if len(value) > 48 {
					top = append(top, fmt.Sprintf("%s... (%d bytes)", hex.EncodeToString(value[:48]), len(value)))
				} else {
					top = append(top, hex.EncodeToString(value))
				}
			}
			trace.Last = append(trace.Last, traceStep{Next: next, StackDepth: len(step.Stack), Top: top})
			if len(trace.Last) > 12 {
				trace.Last = trace.Last[1:]
			}
			return nil
		}
		e = script.Execute(ark.UnsignedTx, fetcher, int(entry.Vin), arkade.WithComputeBudget(budget), arkade.WithExactComputeLimits(arkade.DefaultComputeLimits()), arkade.WithExpiry(scriptExpiry), arkade.WithDebugCallback(callback))
		if e != nil {
			trace.Error = e.Error()
		}
		traces = append(traces, trace)
		if e != nil {
			break
		}
	}
	return map[string]any{"diagnosticOnly": true, "inputs": traces}
}
