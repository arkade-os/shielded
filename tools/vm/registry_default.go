//go:build !registry

package main

import (
	"fmt"
	"github.com/arkade-os/emulator/pkg/emulator"
)

func newConfiguredBridge(path string) (*bridge, error) {
	if path != "" {
		return nil, fmt.Errorf("registry capability requires shielded-registry-vm")
	}
	return newBridge()
}
func configureRegistryData(data *emulator.OffchainData, req request) error {
	if req.Sidecar != "" {
		return fmt.Errorf("registry capability unavailable")
	}
	return nil
}
