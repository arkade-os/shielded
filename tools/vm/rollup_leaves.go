package main

import (
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
)

type rollupLeavesSpec struct {
	ClientKey     string `json:"clientKey"`
	BatchKey      string `json:"batchKey"`
	ClientJoinKey string `json:"clientJoinKey"`
	BatchJoinKey  string `json:"batchJoinKey"`
	Slots         int    `json:"slots"`
	Token         string `json:"token"`
	Operator      string `json:"operator"`
}

type rollupLeavesManifest struct {
	Batch     string `json:"batch"`
	BatchJoin string `json:"batchJoin"`
	Reserve   string `json:"reserve"`
	Renew     string `json:"renew"`
	ECMul     int    `json:"ecmul"`
	Pairs     int    `json:"pairs"`
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
	var leaves [2]rollupLeaf
	for kind, keys := range [2][3]string{{"", spec.ClientKey, spec.BatchKey}, {"join ", spec.ClientJoinKey, spec.BatchJoinKey}} {
		client, err := loadRollupKey(at(keys[1]), 5)
		if err != nil {
			return rollupLeavesManifest{}, fmt.Errorf("%sclient key: %w", keys[0], err)
		}
		batch, err := loadRollupKey(at(keys[2]), spec.Slots+1)
		if err != nil {
			return rollupLeavesManifest{}, fmt.Errorf("%sbatch key: %w", keys[0], err)
		}
		if leaves[kind], err = buildRollupBatchLeaf(rollupLeafConfig{Slots: spec.Slots, Kind: byte(kind), Client: client, Batch: batch}); err != nil {
			return rollupLeavesManifest{}, err
		}
	}
	if leaves[0].ECMul != leaves[1].ECMul || leaves[0].Pairs != leaves[1].Pairs {
		return rollupLeavesManifest{}, errors.New("the spend and join leaves differ in budget")
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
	return rollupLeavesManifest{Batch: hex.EncodeToString(leaves[0].Script), BatchJoin: hex.EncodeToString(leaves[1].Script), Reserve: hex.EncodeToString(reserve), Renew: hex.EncodeToString(renew), ECMul: leaves[0].ECMul, Pairs: leaves[0].Pairs}, nil
}
