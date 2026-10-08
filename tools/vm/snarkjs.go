package main

import (
	"fmt"
	"math/big"
)

var baseField, _ = new(big.Int).SetString("21888242871839275222246405745257275088696311157297823662689037894645226208583", 10)

type snarkJSVerificationKey struct {
	Protocol string     `json:"protocol"`
	Curve    string     `json:"curve"`
	NPublic  int        `json:"nPublic"`
	Alpha1   []string   `json:"vk_alpha_1"`
	Beta2    [][]string `json:"vk_beta_2"`
	Gamma2   [][]string `json:"vk_gamma_2"`
	Delta2   [][]string `json:"vk_delta_2"`
	IC       [][]string `json:"IC"`
}

func fieldCoordinate(text string, modulus *big.Int, label string) (*big.Int, error) {
	if text == "" || len(text) > 77 || (len(text) > 1 && text[0] == '0') {
		return nil, fmt.Errorf("%s has a noncanonical coordinate", label)
	}
	for _, digit := range text {
		if digit < '0' || digit > '9' {
			return nil, fmt.Errorf("%s has a noncanonical coordinate", label)
		}
	}
	value, ok := new(big.Int).SetString(text, 10)
	if !ok || value.Cmp(modulus) >= 0 {
		return nil, fmt.Errorf("%s has a coordinate outside the BN254 base field", label)
	}
	return value, nil
}

func fieldLE(value *big.Int) []byte {
	out := make([]byte, 32)
	value.FillBytes(out)
	for left, right := 0, len(out)-1; left < right; left, right = left+1, right-1 {
		out[left], out[right] = out[right], out[left]
	}
	return out
}

func scriptNumBytes(value *big.Int) []byte {
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
