//go:build registry

package main

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/arkade-os/emulator/pkg/emulator"
	"github.com/btcsuite/btcd/btcec/v2"
	"os"
)

func newConfiguredBridge(path string) (*bridge, error) {
	if path == "" {
		return newBridge()
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	if len(raw) > 2<<20 {
		return nil, fmt.Errorf("registry configuration too large")
	}
	var programs map[string]string
	if err = json.Unmarshal(raw, &programs); err != nil {
		return nil, err
	}
	registry, err := arkade.NewProgramRegistry(programs)
	if err != nil {
		return nil, err
	}
	emulatorKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	serverKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	service, err := emulator.NewWithProgramRegistry(emulatorKey, nil, nil, serverKey.PubKey(), arkade.DefaultComputeLimits(), registry)
	return &bridge{service: service}, err
}
func configureRegistryData(data *emulator.OffchainData, req request) error {
	if req.Sidecar == "" {
		return nil
	}
	raw, err := base64.StdEncoding.Strict().DecodeString(req.Sidecar)
	if err != nil || len(raw) > 128*1024 {
		return fmt.Errorf("invalid registry sidecar encoding")
	}
	data.RegistrySidecar = raw
	return nil
}
