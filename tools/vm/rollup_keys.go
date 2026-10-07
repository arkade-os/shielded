package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
)

var rollupScalarField, _ = new(big.Int).SetString("21888242871839275222246405745257275088548364400416034343698204186575808495617", 10)

type rollupG1 [2]*big.Int

// rollupG2 is in pairing stack order: x.c1, x.c0, y.c1, y.c0.
type rollupG2 [4]*big.Int

type rollupKey struct {
	Alpha                       rollupG1
	NegBeta, NegGamma, NegDelta rollupG2
	IC                          []rollupG1
}

func loadRollupKey(path string, publicInputs int) (rollupKey, error) {
	var raw stockSnarkJSVerificationKey
	data, err := os.ReadFile(path)
	if err != nil {
		return rollupKey{}, err
	}
	if err := json.Unmarshal(data, &raw); err != nil {
		return rollupKey{}, err
	}
	return parseRollupKey(raw, publicInputs)
}

func parseRollupKey(raw stockSnarkJSVerificationKey, publicInputs int) (rollupKey, error) {
	if raw.Protocol != "groth16" || raw.Curve != "bn128" || raw.NPublic != publicInputs || len(raw.IC) != publicInputs+1 {
		return rollupKey{}, fmt.Errorf("rollup key must be Groth16 bn128 with %d public inputs", publicInputs)
	}
	var key rollupKey
	var err error
	if key.Alpha, err = rollupG1Of(raw.Alpha1, "vk_alpha_1"); err != nil {
		return rollupKey{}, err
	}
	for _, entry := range []struct {
		out   *rollupG2
		point [][]string
		name  string
	}{{&key.NegBeta, raw.Beta2, "vk_beta_2"}, {&key.NegGamma, raw.Gamma2, "vk_gamma_2"}, {&key.NegDelta, raw.Delta2, "vk_delta_2"}} {
		if *entry.out, err = rollupNegG2Of(entry.point, entry.name); err != nil {
			return rollupKey{}, err
		}
	}
	for i, point := range raw.IC {
		ic, err := rollupG1Of(point, fmt.Sprintf("IC[%d]", i))
		if err != nil {
			return rollupKey{}, err
		}
		key.IC = append(key.IC, ic)
	}
	return key, nil
}

func rollupG1Of(point []string, label string) (rollupG1, error) {
	if len(point) != 3 || point[2] != "1" {
		return rollupG1{}, fmt.Errorf("%s must be affine with z=1", label)
	}
	var out rollupG1
	for i := range out {
		v, err := stockCoordinate(point[i], stockBaseField, label)
		if err != nil {
			return rollupG1{}, err
		}
		out[i] = v
	}
	return out, nil
}

func rollupG2Of(point [][]string, label string, negate bool) (rollupG2, error) {
	if len(point) < 2 || len(point[0]) != 2 || len(point[1]) != 2 {
		return rollupG2{}, fmt.Errorf("%s must be a G2 point", label)
	}
	var c [4]*big.Int
	for i, text := range []string{point[0][0], point[0][1], point[1][0], point[1][1]} {
		v, err := stockCoordinate(text, stockBaseField, label)
		if err != nil {
			return rollupG2{}, err
		}
		if negate && i >= 2 && v.Sign() != 0 {
			v = new(big.Int).Sub(stockBaseField, v)
		}
		c[i] = v
	}
	return rollupG2{c[1], c[0], c[3], c[2]}, nil
}

func rollupNegG2Of(point [][]string, label string) (rollupG2, error) {
	if len(point) != 3 || len(point[2]) != 2 || point[2][0] != "1" || point[2][1] != "0" {
		return rollupG2{}, fmt.Errorf("%s must be affine with z=[1,0]", label)
	}
	return rollupG2Of(point, label, true)
}

// rollupSharedSetup holds when both keys come from one phase-1 file, which
// lets one pairing call check the client proofs and the batch proof together.
func rollupSharedSetup(client, batch rollupKey) error {
	same := func(a, b []*big.Int) bool {
		for i := range a {
			if a[i].Cmp(b[i]) != 0 {
				return false
			}
		}
		return true
	}
	if !same(client.Alpha[:], batch.Alpha[:]) || !same(client.NegBeta[:], batch.NegBeta[:]) || !same(client.NegGamma[:], batch.NegGamma[:]) {
		return errors.New("client and batch keys must share alpha, beta and gamma (one phase-1 file)")
	}
	return nil
}

// rollupProofItems encodes a snarkjs proof as the eight witness items the
// batch leaf consumes: A, B in pairing order, C.
func rollupProofItems(a []string, b [][]string, c []string) ([][]byte, error) {
	pa, err := rollupG1Of(a, "pi_a")
	if err != nil {
		return nil, err
	}
	pb, err := rollupG2Of(b, "pi_b", false)
	if err != nil {
		return nil, err
	}
	pc, err := rollupG1Of(c, "pi_c")
	if err != nil {
		return nil, err
	}
	var items [][]byte
	for _, v := range []*big.Int{pa[0], pa[1], pb[0], pb[1], pb[2], pb[3], pc[0], pc[1]} {
		items = append(items, stockScriptNumBytes(v))
	}
	return items, nil
}
