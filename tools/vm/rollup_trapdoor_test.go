package main

import (
	"math/big"
	"math/rand"

	gnarkbn254 "github.com/consensys/gnark-crypto/ecc/bn254"
)

// Test-only Groth16 keys with a known trapdoor, so a test can mint a valid
// proof for any public input. Client and batch keys share alpha, beta and
// gamma, as snarkjs keys from one phase-1 file do.
type rollupTrapdoor struct {
	alpha, beta, gamma, delta *big.Int
	ic                        []*big.Int
	key                       rollupKey
}

type rollupProof struct {
	A, C rollupG1
	B    rollupG2
}

var _, _, rollupGen1, rollupGen2 = gnarkbn254.Generators()

func rollupMulG1(k *big.Int) rollupG1 {
	var p gnarkbn254.G1Affine
	p.ScalarMultiplication(&rollupGen1, k)
	return rollupG1{p.X.BigInt(new(big.Int)), p.Y.BigInt(new(big.Int))}
}

func rollupMulG2(k *big.Int, negate bool) rollupG2 {
	var p gnarkbn254.G2Affine
	p.ScalarMultiplication(&rollupGen2, k)
	if negate {
		p.Neg(&p)
	}
	return rollupG2{p.X.A1.BigInt(new(big.Int)), p.X.A0.BigInt(new(big.Int)), p.Y.A1.BigInt(new(big.Int)), p.Y.A0.BigInt(new(big.Int))}
}

func newRollupTrapdoor(rng *rand.Rand, shared *rollupTrapdoor, publicInputs int) *rollupTrapdoor {
	k := func() *big.Int { return new(big.Int).Rand(rng, rollupScalarField) }
	t := &rollupTrapdoor{delta: k()}
	if shared != nil {
		t.alpha, t.beta, t.gamma = shared.alpha, shared.beta, shared.gamma
	} else {
		t.alpha, t.beta, t.gamma = k(), k(), k()
	}
	t.key = rollupKey{Alpha: rollupMulG1(t.alpha), NegBeta: rollupMulG2(t.beta, true), NegGamma: rollupMulG2(t.gamma, true), NegDelta: rollupMulG2(t.delta, true)}
	for i := 0; i <= publicInputs; i++ {
		t.ic = append(t.ic, k())
		t.key.IC = append(t.key.IC, rollupMulG1(t.ic[i]))
	}
	return t
}

func (t *rollupTrapdoor) prove(rng *rand.Rand, x []*big.Int) rollupProof {
	if len(x)+1 != len(t.ic) {
		panic("public input count does not match the trapdoor key")
	}
	a, b := new(big.Int).Rand(rng, rollupScalarField), new(big.Int).Rand(rng, rollupScalarField)
	l := new(big.Int).Set(t.ic[0])
	for i, v := range x {
		l.Add(l, new(big.Int).Mul(v, t.ic[i+1]))
	}
	c := new(big.Int).Mul(a, b)
	c.Sub(c, new(big.Int).Mul(t.alpha, t.beta))
	c.Sub(c, new(big.Int).Mul(t.gamma, l))
	c.Mul(c, new(big.Int).ModInverse(t.delta, rollupScalarField))
	c.Mod(c, rollupScalarField)
	return rollupProof{A: rollupMulG1(a), B: rollupMulG2(b, false), C: rollupMulG1(c)}
}

func (p rollupProof) items() [][]byte {
	var out [][]byte
	for _, v := range []*big.Int{p.A[0], p.A[1], p.B[0], p.B[1], p.B[2], p.B[3], p.C[0], p.C[1]} {
		out = append(out, stockScriptNumBytes(v))
	}
	return out
}
