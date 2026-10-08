package main

import (
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
)

func writeRollupLeavesSpec(t *testing.T, spec rollupLeavesSpec) string {
	t.Helper()
	raw, err := os.ReadFile(rollupSnarkJSFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var fixture struct{ ClientKey, BatchKey json.RawMessage }
	if err := json.Unmarshal(raw, &fixture); err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	for name, key := range map[string]json.RawMessage{"client.vkey.json": fixture.ClientKey, "batch.vkey.json": fixture.BatchKey} {
		if err := os.WriteFile(filepath.Join(dir, name), key, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	spec.ClientKey, spec.BatchKey = "client.vkey.json", "batch.vkey.json"
	encoded, _ := json.Marshal(spec)
	path := filepath.Join(dir, "spec.json")
	if err := os.WriteFile(path, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func TestRollupLeavesManifest(t *testing.T) {
	token := asset.AssetId{Index: 0}
	token.Txid[0] = 0xcc
	operator := schnorr.SerializePubKey(rollupRenewalOperator.PubKey())
	spec := rollupLeavesSpec{Slots: 11, Token: token.String(), Operator: hex.EncodeToString(operator)}
	got, err := buildRollupLeaves(writeRollupLeavesSpec(t, spec))
	if err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(rollupSnarkJSFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var f rollupSnarkJSFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	client, err := parseRollupKey(f.ClientKey, 5)
	if err != nil {
		t.Fatal(err)
	}
	batch, err := parseRollupKey(f.BatchKey, 12)
	if err != nil {
		t.Fatal(err)
	}
	leaf, _ := buildRollupBatchLeaf(rollupLeafConfig{Slots: 11, Client: client, Batch: batch})
	reserve, _ := buildRollupReserveLeaf(token)
	renew, _ := buildRollupRenewalLeaf(token, operator)
	want := rollupLeavesManifest{Batch: hex.EncodeToString(leaf.Script), Reserve: hex.EncodeToString(reserve), Renew: hex.EncodeToString(renew), ECMul: 41, Pairs: 16}
	if got != want {
		t.Fatalf("manifest differs from the direct builds: ecmul %d pairs %d", got.ECMul, got.Pairs)
	}
	for name, bad := range map[string]rollupLeavesSpec{
		"batch key for another slot count": {Slots: 10, Token: spec.Token, Operator: spec.Operator},
		"malformed token":                  {Slots: 11, Token: "zz", Operator: spec.Operator},
		"short operator key":               {Slots: 11, Token: spec.Token, Operator: "02"},
	} {
		if _, err := buildRollupLeaves(writeRollupLeavesSpec(t, bad)); err == nil {
			t.Errorf("%s: leaves built", name)
		}
	}
}
