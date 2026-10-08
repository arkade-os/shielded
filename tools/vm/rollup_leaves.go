package main

import (
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
)

type rollupLeavesSpec struct {
	ClientKey string `json:"clientKey"`
	BatchKey  string `json:"batchKey"`
	Slots     int    `json:"slots"`
	Kind      byte   `json:"kind"`
	Token     string `json:"token"`
	Operator  string `json:"operator"`
}

type rollupLeavesManifest struct {
	Batch   string `json:"batch"`
	Reserve string `json:"reserve"`
	Renew   string `json:"renew"`
	ECMul   int    `json:"ecmul"`
	Pairs   int    `json:"pairs"`
}

// buildRollupLeaves reads a spec whose key paths are relative to the spec file.
func buildRollupLeaves(specFile string) (rollupLeavesManifest, error) {
	raw, err := os.ReadFile(specFile)
	if err != nil {
		return rollupLeavesManifest{}, err
	}
	var spec rollupLeavesSpec
	if err := json.Unmarshal(raw, &spec); err != nil {
		return rollupLeavesManifest{}, fmt.Errorf("rollup leaves spec: %w", err)
	}
	at := func(path string) string {
		if filepath.IsAbs(path) {
			return path
		}
		return filepath.Join(filepath.Dir(specFile), path)
	}
	client, err := loadRollupKey(at(spec.ClientKey), 5)
	if err != nil {
		return rollupLeavesManifest{}, fmt.Errorf("client key: %w", err)
	}
	batch, err := loadRollupKey(at(spec.BatchKey), spec.Slots+1)
	if err != nil {
		return rollupLeavesManifest{}, fmt.Errorf("batch key: %w", err)
	}
	leaf, err := buildRollupBatchLeaf(rollupLeafConfig{Slots: spec.Slots, Kind: spec.Kind, Client: client, Batch: batch})
	if err != nil {
		return rollupLeavesManifest{}, err
	}
	token, err := asset.NewAssetIdFromString(spec.Token)
	if err != nil {
		return rollupLeavesManifest{}, fmt.Errorf("pool token: %w", err)
	}
	reserve, err := buildRollupReserveLeaf(*token)
	if err != nil {
		return rollupLeavesManifest{}, err
	}
	operator, err := hex.DecodeString(spec.Operator)
	if err != nil {
		return rollupLeavesManifest{}, fmt.Errorf("renewal operator: %w", err)
	}
	renew, err := buildRollupRenewalLeaf(*token, operator)
	if err != nil {
		return rollupLeavesManifest{}, err
	}
	return rollupLeavesManifest{Batch: hex.EncodeToString(leaf.Script), Reserve: hex.EncodeToString(reserve), Renew: hex.EncodeToString(renew), ECMul: leaf.ECMul, Pairs: leaf.Pairs}, nil
}
