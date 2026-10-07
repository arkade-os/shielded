package main

import (
	"math/big"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/btcsuite/btcd/chainhash/v2"
)

// tests/rollup-encodings.test.ts pins the same values for the TypeScript model.
func TestRollupEncodingVectors(t *testing.T) {
	binding := append([]byte{'S', 'H', 2, 0, 11}, rollupLE32(big.NewInt(1))...)
	binding = append(append(binding, rollupLE32(big.NewInt(2))...), rollupLE32(big.NewInt(3))...)
	for _, c := range []struct {
		name string
		got  *big.Int
		want string
	}{
		{"asset field", rollupAssetField(asset.AssetId{Txid: chainhash.Hash{0xaa, 1}, Index: 2}), "58731566653076399333433260003484838053367763420541586868126768447677655521"},
		{"destination field", rollupLE248(rollupProgram(0xa1)), "213773286175971319739518410551844573799594910049794260289782295570684116562"},
		{"statement", rollupLE248(binding), "375285187782611973573682952704180456189630373407897304444805147226734494316"},
	} {
		if c.got.String() != c.want {
			t.Errorf("%s = %s, want %s", c.name, c.got, c.want)
		}
	}
}
