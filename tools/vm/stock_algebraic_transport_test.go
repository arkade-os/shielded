package main

import (
	"bytes"
	"math/big"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/extension"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
	gnarkbn254 "github.com/consensys/gnark-crypto/ecc/bn254"
)

var stockTransportScalarModulus, _ = new(big.Int).SetString("21888242871839275222246405745257275088548364400416034343698204186575808495617", 10)

// This algebraic fixture only exercises the native Groth16 transport and VM
// pairing path. It is not a proof for the Shielded circuit or statement.
func TestStockCommitLeavesAcceptSignalArbitraryTransportProof(t *testing.T) {
	icPacket, fixedKeyPacket, g1, g2 := stockTransportAlgebraicKey(t)
	for mode := byte(0); mode < 4; mode++ {
		t.Run(stockModeName(mode), func(t *testing.T) {
			binding, tx, parent, prevOut := stockStatementFixture(t, mode)
			oldState := bytes.Repeat([]byte{0x22}, 32)
			newState := bytes.Repeat([]byte{0x33}, 32)
			parentExt, err := extension.NewExtensionFromPackets(
				extension.UnknownPacket{PacketType: stockStatePacketType, Data: oldState},
				extension.UnknownPacket{PacketType: 0x88, Data: []byte{18}},
				extension.UnknownPacket{PacketType: 0x85, Data: icPacket},
				extension.UnknownPacket{PacketType: 0x86, Data: fixedKeyPacket},
			)
			if err != nil {
				t.Fatal(err)
			}
			parentOut, err := parentExt.TxOut()
			if err != nil {
				t.Fatal(err)
			}
			parent.TxOut[len(parent.TxOut)-1] = parentOut
			var userOutputs []*wire.TxOut
			for _, output := range tx.TxOut[:len(tx.TxOut)-1] {
				userOutputs = append(userOutputs, output)
			}
			wantOutputs := 2
			if mode == 2 {
				wantOutputs = 3
			}
			for len(userOutputs) < wantOutputs {
				userOutputs = append(userOutputs, wire.NewTxOut(0, stagedP2TRScript(0x77)))
			}
			currentExt, err := extension.NewExtensionFromPackets(
				extension.UnknownPacket{PacketType: stockStatePacketType, Data: newState},
				extension.UnknownPacket{PacketType: 0x88, Data: []byte{17}},
				extension.UnknownPacket{PacketType: stockModePacketType, Data: []byte{mode}},
			)
			if err != nil {
				t.Fatal(err)
			}
			currentOut, err := currentExt.TxOut()
			if err != nil {
				t.Fatal(err)
			}
			tx.TxOut = append(userOutputs, currentOut)
			publicScalar := stockExpectedScalar(binding)
			proof := stockAlgebraicProof(g1, g2, publicScalar)
			script, err := stockCommitLeafScript(mode, icPacket, fixedKeyPacket)
			if err != nil {
				t.Fatal(err)
			}
			fetcher := &stagedPrevFetcher{PrevOutputFetcher: prevOut, parent: parent, parentPkScript: parent.TxOut[0].PkScript}
			engine, err := arkade.NewEngine(script, tx, 0, txscript.NewSigCache(2), txscript.NewTxSigHashes(tx, fetcher), 10, fetcher)
			if err != nil {
				t.Fatal(err)
			}
			engine.SetStack(proof)
			if err := engine.Execute(); err != nil {
				t.Fatalf("stock commit leaf rejected signal-arbitrary algebraic transport proof: %v", err)
			}
		})
	}
}

func stockTransportAlgebraicKey(t *testing.T) ([]byte, []byte, gnarkbn254.G1Affine, gnarkbn254.G2Affine) {
	t.Helper()
	_, _, g1, g2 := gnarkbn254.Generators()
	g1x, g1y := g1.X.BigInt(new(big.Int)), g1.Y.BigInt(new(big.Int))
	ic := append(append(stockFieldLE(g1x), stockFieldLE(g1y)...), append(stockFieldLE(g1x), stockFieldLE(g1y)...)...)
	negY0 := new(big.Int).Sub(stockBaseField, g2.Y.A0.BigInt(new(big.Int)))
	negY1 := new(big.Int).Sub(stockBaseField, g2.Y.A1.BigInt(new(big.Int)))
	g2Coordinates := []*big.Int{g2.X.A1.BigInt(new(big.Int)), g2.X.A0.BigInt(new(big.Int)), negY1, negY0}
	coordinates := []*big.Int{
		g2Coordinates[0], g2Coordinates[1], g2Coordinates[2], g2Coordinates[3],
		g2Coordinates[0], g2Coordinates[1], g2Coordinates[2], g2Coordinates[3],
		g1x, g1y,
		g2.X.A1.BigInt(new(big.Int)), g2.X.A0.BigInt(new(big.Int)), negY1, negY0,
	}
	fixed := make([]byte, 0, 448)
	for _, coordinate := range coordinates {
		fixed = append(fixed, stockFieldLE(coordinate)...)
	}
	if len(ic) != 128 || len(fixed) != 448 {
		t.Fatalf("test key packet sizes: IC=%d fixed=%d", len(ic), len(fixed))
	}
	return ic, fixed, g1, g2
}

func stockAlgebraicProof(g1 gnarkbn254.G1Affine, g2 gnarkbn254.G2Affine, publicScalar *big.Int) [][]byte {
	var a gnarkbn254.G1Affine
	var c gnarkbn254.G1Affine
	aCoefficient := new(big.Int).Lsh(big.NewInt(1), 253)
	a.ScalarMultiplication(&g1, aCoefficient)
	coefficient := new(big.Int).Add(publicScalar, big.NewInt(2))
	coefficient.Sub(aCoefficient, coefficient).Mod(coefficient, stockTransportScalarModulus)
	c.ScalarMultiplication(&g1, coefficient)
	witness := [][]byte{
		stagedScriptNumBig(a.X.BigInt(new(big.Int))), stagedScriptNumBig(a.Y.BigInt(new(big.Int))),
		stagedScriptNumBig(g2.X.A1.BigInt(new(big.Int))), stagedScriptNumBig(g2.X.A0.BigInt(new(big.Int))),
		stagedScriptNumBig(g2.Y.A1.BigInt(new(big.Int))), stagedScriptNumBig(g2.Y.A0.BigInt(new(big.Int))),
		stagedScriptNumBig(c.X.BigInt(new(big.Int))), stagedScriptNumBig(c.Y.BigInt(new(big.Int))),
	}
	for _, coordinate := range witness {
		if len(coordinate) != 32 {
			panic("test-only algebraic proof must use full-width coordinates")
		}
	}
	return witness
}
