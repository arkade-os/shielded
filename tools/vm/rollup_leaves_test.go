package main

import (
	"bytes"
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
	spec.ClientJoinKey, spec.BatchJoinKey = "client.vkey.json", "batch.vkey.json"
	encoded, _ := json.Marshal(spec)
	path := filepath.Join(dir, "spec.json")
	if err := os.WriteFile(path, encoded, 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// rollupFixtureKeys parses the snarkjs fixture's client and batch keys.
func rollupFixtureKeys(t *testing.T) (client, batch rollupKey) {
	t.Helper()
	raw, err := os.ReadFile(rollupSnarkJSFixturePath)
	if err != nil {
		t.Fatal(err)
	}
	var f rollupSnarkJSFixture
	if err := json.Unmarshal(raw, &f); err != nil {
		t.Fatal(err)
	}
	if client, err = parseRollupKey(f.ClientKey, 7); err != nil {
		t.Fatal(err)
	}
	if batch, err = parseRollupKey(f.BatchKey, 11); err != nil {
		t.Fatal(err)
	}
	return client, batch
}

// The join leaf is the spend leaf with another kind byte: same length, same budgets.
func TestRollupJoinLeafMatchesTheSpendLeafShape(t *testing.T) {
	client, batch := rollupFixtureKeys(t)
	spend, err := buildRollupBatchLeaf(rollupLeafConfig{Slots: 10, Kind: 0, Version: 2, Client: client, Batch: batch})
	if err != nil {
		t.Fatal(err)
	}
	join, err := buildRollupBatchLeaf(rollupLeafConfig{Slots: 10, Kind: 1, Version: 2, Client: client, Batch: batch})
	if err != nil {
		t.Fatal(err)
	}
	if spend.Pairs != join.Pairs || spend.ECMul != join.ECMul {
		t.Fatalf("budgets differ: %d/%d vs %d/%d", spend.Pairs, spend.ECMul, join.Pairs, join.ECMul)
	}
	if len(join.Script) != len(spend.Script) || bytes.Equal(join.Script, spend.Script) {
		t.Fatalf("join leaf %d B vs spend leaf %d B; they must differ only in the kind byte", len(join.Script), len(spend.Script))
	}
}

func TestRollupLeavesManifest(t *testing.T) {
	token := asset.AssetId{Index: 0}
	token.Txid[0] = 0xcc
	operator := schnorr.SerializePubKey(rollupRenewalOperator.PubKey())
	spec := rollupLeavesSpec{Slots: 10, Token: token.String(), Operator: hex.EncodeToString(operator)}
	got, err := buildRollupLeaves(writeRollupLeavesSpec(t, spec))
	if err != nil {
		t.Fatal(err)
	}
	client, batch := rollupFixtureKeys(t)
	leaf, _ := buildRollupBatchLeaf(rollupLeafConfig{Slots: 10, Version: 2, Client: client, Batch: batch})
	joinLeaf, _ := buildRollupBatchLeaf(rollupLeafConfig{Slots: 10, Kind: 1, Version: 2, Client: client, Batch: batch})
	reserve, _ := buildRollupReserveLeaf(token)
	renew, _ := buildRollupRenewalLeaf(token, operator)
	want := rollupLeavesManifest{Batch: hex.EncodeToString(leaf.Script), BatchJoin: hex.EncodeToString(joinLeaf.Script), BatchRecover: "", Reserve: hex.EncodeToString(reserve), Renew: hex.EncodeToString(renew), ECMul: 40, Pairs: 15}
	if got != want {
		t.Fatalf("manifest differs from the direct builds: ecmul %d pairs %d", got.ECMul, got.Pairs)
	}
	for name, bad := range map[string]rollupLeavesSpec{
		"batch key for another slot count": {Slots: 11, Token: spec.Token, Operator: spec.Operator},
		"malformed token":                  {Slots: 10, Token: "zz", Operator: spec.Operator},
		"short operator key":               {Slots: 10, Token: spec.Token, Operator: "02"},
	} {
		if _, err := buildRollupLeaves(writeRollupLeavesSpec(t, bad)); err == nil {
			t.Errorf("%s: leaves built", name)
		}
	}
}

func TestRollupEpochLeavesManifest(t *testing.T) {
	f := readRollupSnarkJSFixture(t, rollupEpochSnarkJSFixturePath)
	// rollupSharedSetup needs every key on one phase-1 setup, and the dev keys cover only epoch-spend and epoch-batch-recover: the join
	// client is the spend key with another delta, as a second phase-2 contribution gives, and the 11-public batch key is the recover key widened.
	joinClient, wide := f.ClientKey, f.BatchKey
	joinClient.Delta2 = f.BatchKey.Delta2
	wide.NPublic = 11
	for len(wide.IC) < 12 {
		wide.IC = append(wide.IC, wide.IC[len(wide.IC)-1])
	}
	dir := t.TempDir()
	for name, key := range map[string]snarkJSVerificationKey{"spend.json": f.ClientKey, "join.json": joinClient, "batch.json": wide, "recover.json": f.BatchKey} {
		encoded, _ := json.Marshal(key)
		if err := os.WriteFile(filepath.Join(dir, name), encoded, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	token := asset.AssetId{Index: 0}
	token.Txid[0] = 0xcc
	operator := hex.EncodeToString(schnorr.SerializePubKey(rollupRenewalOperator.PubKey()))
	spec, _ := json.Marshal(rollupLeavesSpec{ClientKey: "spend.json", BatchKey: "batch.json", ClientJoinKey: "join.json", BatchJoinKey: "batch.json", BatchRecoverKey: "recover.json", Slots: 10, Token: token.String(), Operator: operator, Epoch: true})
	if err := os.WriteFile(filepath.Join(dir, "spec.json"), spec, 0o644); err != nil {
		t.Fatal(err)
	}
	got, err := buildRollupLeaves(filepath.Join(dir, "spec.json"))
	if err != nil {
		t.Fatal(err)
	}
	recoverLeaf := func(client snarkJSVerificationKey) string {
		c, err := parseRollupKey(client, 7)
		if err != nil {
			t.Fatal(err)
		}
		b, err := parseRollupKey(f.BatchKey, 2)
		if err != nil {
			t.Fatal(err)
		}
		leaf, err := buildRollupBatchLeaf(rollupLeafConfig{Slots: 1, Kind: 2, Version: 4, Client: c, Batch: b})
		if err != nil {
			t.Fatal(err)
		}
		return hex.EncodeToString(leaf.Script)
	}
	if got.BatchRecover == "" || got.Batch == got.BatchJoin || got.BatchRecover == got.Batch || got.BatchRecover == got.BatchJoin {
		t.Fatal("an epoch manifest needs three distinct leaves")
	}
	if got.BatchRecover != recoverLeaf(f.ClientKey) {
		t.Error("batchRecover is not the kind-2, version-4 leaf over the spend client key")
	}
	if got.BatchRecover == recoverLeaf(joinClient) {
		t.Error("batchRecover was built over the join client key")
	}
	for leaf, push := range map[string][]byte{got.Batch: {5, 'S', 'H', 4, 0, 10}, got.BatchJoin: {5, 'S', 'H', 4, 1, 10}} {
		if script, _ := hex.DecodeString(leaf); !bytes.Contains(script, push) {
			t.Errorf("epoch leaf lacks the pushdata %x", push)
		}
	}
}
