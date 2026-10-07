package main

import (
	"math/big"
	"math/rand"
	"testing"
)

// rollupSnarkJSKey writes a key in snarkjs's JSON layout: G2 as
// [[x.c0, x.c1], [y.c0, y.c1], [1, 0]], not negated.
func rollupSnarkJSKey(k rollupKey) stockSnarkJSVerificationKey {
	g1 := func(p rollupG1) []string { return []string{p[0].String(), p[1].String(), "1"} }
	g2 := func(p rollupG2) [][]string {
		y1, y0 := new(big.Int).Sub(stockBaseField, p[2]), new(big.Int).Sub(stockBaseField, p[3])
		return [][]string{{p[1].String(), p[0].String()}, {y0.String(), y1.String()}, {"1", "0"}}
	}
	raw := stockSnarkJSVerificationKey{Protocol: "groth16", Curve: "bn128", NPublic: len(k.IC) - 1,
		Alpha1: g1(k.Alpha), Beta2: g2(k.NegBeta), Gamma2: g2(k.NegGamma), Delta2: g2(k.NegDelta)}
	for _, p := range k.IC {
		raw.IC = append(raw.IC, g1(p))
	}
	return raw
}

func TestRollupKeyParsesSnarkJSAndChecksSharedSetup(t *testing.T) {
	rng := rand.New(rand.NewSource(1))
	client := newRollupTrapdoor(rng, nil, 5)
	parsed, err := parseRollupKey(rollupSnarkJSKey(client.key), 5)
	if err != nil {
		t.Fatal(err)
	}
	for i := range parsed.NegDelta {
		if parsed.NegDelta[i].Cmp(client.key.NegDelta[i]) != 0 || parsed.NegBeta[i].Cmp(client.key.NegBeta[i]) != 0 {
			t.Fatal("G2 coordinates did not round-trip through the snarkjs layout")
		}
	}
	if _, err := parseRollupKey(rollupSnarkJSKey(client.key), 4); err == nil {
		t.Fatal("accepted a key with the wrong public input count")
	}
	if err := rollupSharedSetup(client.key, newRollupTrapdoor(rng, client, 12).key); err != nil {
		t.Fatal(err)
	}
	if err := rollupSharedSetup(client.key, newRollupTrapdoor(rng, nil, 12).key); err == nil {
		t.Fatal("accepted keys from different phase-1 files")
	}
}
