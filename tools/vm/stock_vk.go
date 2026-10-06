package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math/big"
	"os"
)

var stockBaseField, _ = new(big.Int).SetString("21888242871839275222246405745257275088696311157297823662689037894645226208583", 10)

type stockSnarkJSVerificationKey struct {
	Protocol string     `json:"protocol"`
	Curve    string     `json:"curve"`
	NPublic  int        `json:"nPublic"`
	Alpha1   []string   `json:"vk_alpha_1"`
	Beta2    [][]string `json:"vk_beta_2"`
	Gamma2   [][]string `json:"vk_gamma_2"`
	Delta2   [][]string `json:"vk_delta_2"`
	IC       [][]string `json:"IC"`
}

type stockBuildManifest struct {
	Version         int               `json:"version"`
	Profile         string            `json:"profile"`
	Domain          string            `json:"domain"`
	PublicInputs    int               `json:"publicInputs"`
	ICPacketHex     string            `json:"icPacketHex"`
	FixedKeyHex     string            `json:"fixedKeyPacketHex"`
	ICHashHex       string            `json:"icHashHex"`
	FixedKeyHashHex string            `json:"fixedKeyHashHex"`
	CombinedKeyHash string            `json:"combinedKeyHashHex"`
	ProgramsHash    string            `json:"programsHashHex"`
	Programs        map[string]string `json:"programs"`
}

func loadStockSnarkJSKey(path string) (stockSnarkJSVerificationKey, []byte, []byte, error) {
	var key stockSnarkJSVerificationKey
	raw, err := os.ReadFile(path)
	if err != nil {
		return key, nil, nil, err
	}
	decoderErr := json.Unmarshal(raw, &key)
	if decoderErr != nil {
		return key, nil, nil, decoderErr
	}
	if key.Protocol != "groth16" || key.Curve != "bn128" || key.NPublic != 1 || len(key.IC) != 2 {
		return key, nil, nil, errors.New("stock builder requires a Groth16 bn128 key with exactly one public input")
	}
	icPacket := make([]byte, 0, 128)
	for i, point := range key.IC {
		coords, err := stockG1(point, fmt.Sprintf("IC[%d]", i))
		if err != nil {
			return key, nil, nil, err
		}
		icPacket = append(icPacket, coords...)
	}
	alpha, err := stockG1(key.Alpha1, "vk_alpha_1")
	if err != nil {
		return key, nil, nil, err
	}
	vkPacket := make([]byte, 0, 448)
	for _, entry := range []struct {
		name  string
		point [][]string
	}{{"vk_delta_2", key.Delta2}, {"vk_gamma_2", key.Gamma2}} {
		coords, err := stockNegativeG2(entry.point, entry.name)
		if err != nil {
			return key, nil, nil, err
		}
		vkPacket = append(vkPacket, coords...)
	}
	vkPacket = append(vkPacket, alpha...)
	beta, err := stockNegativeG2(key.Beta2, "vk_beta_2")
	if err != nil {
		return key, nil, nil, err
	}
	vkPacket = append(vkPacket, beta...)
	if len(icPacket) != 128 || len(vkPacket) != 448 {
		return key, nil, nil, errors.New("internal Groth16 key packet size mismatch")
	}
	return key, icPacket, vkPacket, nil
}

func stockG1(point []string, label string) ([]byte, error) {
	if len(point) != 3 || point[2] != "1" {
		return nil, fmt.Errorf("%s must be affine with z=1", label)
	}
	out := make([]byte, 0, 64)
	for _, text := range point[:2] {
		coordinate, err := stockCoordinate(text, stockBaseField, label)
		if err != nil {
			return nil, err
		}
		out = append(out, stockFieldLE(coordinate)...)
	}
	return out, nil
}

func stockNegativeG2(point [][]string, label string) ([]byte, error) {
	if len(point) != 3 || len(point[0]) != 2 || len(point[1]) != 2 || len(point[2]) != 2 || point[2][0] != "1" || point[2][1] != "0" {
		return nil, fmt.Errorf("%s must be affine with z=[1,0]", label)
	}
	values := make([]*big.Int, 4)
	for i, pair := range [][]string{point[0], point[1]} {
		for j, text := range pair {
			coordinate, err := stockCoordinate(text, stockBaseField, label)
			if err != nil {
				return nil, err
			}
			if i == 1 && coordinate.Sign() != 0 {
				coordinate = new(big.Int).Sub(stockBaseField, coordinate)
			}
			values[i*2+j] = coordinate
		}
	}
	out := make([]byte, 0, 128)
	for _, index := range []int{1, 0, 3, 2} {
		out = append(out, stockFieldLE(values[index])...)
	}
	return out, nil
}

func stockCoordinate(text string, modulus *big.Int, label string) (*big.Int, error) {
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

func stockFieldLE(value *big.Int) []byte {
	out := make([]byte, 32)
	value.FillBytes(out)
	for left, right := 0, len(out)-1; left < right; left, right = left+1, right-1 {
		out[left], out[right] = out[right], out[left]
	}
	return out
}

func buildStockManifest(keyPath string) (stockBuildManifest, error) {
	var manifest stockBuildManifest
	_, icPacket, fixedKeyPacket, err := loadStockSnarkJSKey(keyPath)
	if err != nil {
		return manifest, err
	}
	programs := make(map[string]string, 7)
	prepare, err := stockPrepareLeafScript(icPacket, fixedKeyPacket)
	if err != nil {
		return manifest, err
	}
	abort, err := stockAbortLeafScript()
	if err != nil {
		return manifest, err
	}
	programs["prepare"], err = encodeStockProgramHex(prepare)
	if err != nil {
		return manifest, err
	}
	programs["abort"], err = encodeStockProgramHex(abort)
	if err != nil {
		return manifest, err
	}
	for _, mode := range []byte{0, 1, 2, 3} {
		script, err := stockCommitLeafScript(mode, icPacket, fixedKeyPacket)
		if err != nil {
			return manifest, err
		}
		programs[stockModeName(mode)], err = encodeStockProgramHex(script)
		if err != nil {
			return manifest, err
		}
	}
	fundedWithdraw, err := stockCommitLeafScriptFunding(2, icPacket, fixedKeyPacket, true)
	if err != nil {
		return manifest, err
	}
	programs["withdraw-funded"], err = encodeStockProgramHex(fundedWithdraw)
	if err != nil {
		return manifest, err
	}
	icHash, keyHash := sha256.Sum256(icPacket), sha256.Sum256(fixedKeyPacket)
	combinedKeyHash := sha256.Sum256(append(append([]byte(nil), icPacket...), fixedKeyPacket...))
	manifest = stockBuildManifest{
		Version: 1, Profile: "shielded-stock-btc-v1", Domain: "20260930001", PublicInputs: 1,
		ICPacketHex: hex.EncodeToString(icPacket), FixedKeyHex: hex.EncodeToString(fixedKeyPacket),
		ICHashHex: hex.EncodeToString(icHash[:]), FixedKeyHashHex: hex.EncodeToString(keyHash[:]),
		CombinedKeyHash: hex.EncodeToString(combinedKeyHash[:]), ProgramsHash: stockProgramsHash(programs), Programs: programs,
	}
	return manifest, nil
}

func stockProgramsHash(programs map[string]string) string {
	input := make([][2]string, 0, 7)
	for _, name := range []string{"abort", "deposit", "prepare", "seal", "transfer", "withdraw", "withdraw-funded"} {
		if _, err := hex.DecodeString(programs[name]); err != nil || programs[name] == "" {
			return ""
		}
		input = append(input, [2]string{name, programs[name]})
	}
	encoded, err := json.Marshal(input)
	if err != nil {
		return ""
	}
	hash := sha256.Sum256(encoded)
	return hex.EncodeToString(hash[:])
}

func encodeStockProgramHex(script []byte) (string, error) {
	if len(script) == 0 || len(script) > 10_000 {
		return "", errors.New("stock program has an invalid byte length")
	}
	return hex.EncodeToString(script), nil
}
