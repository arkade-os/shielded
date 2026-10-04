package arkade

import (
	"bytes"
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"fmt"
	"github.com/btcsuite/btcd/txscript/v2"
	"io"
)

const RegistryOpcode byte = OP_RETURN
const RegistryPacketType byte = 0x84
const maxRegistrySidecar = 128 * 1024

type ProgramRegistry struct{ programs map[[32]byte][]byte }
type registryEntry struct {
	profile [32]byte
	witness [][]byte
}
type registrySidecar struct {
	packets  [4][]byte
	oldState []byte
	entries  map[int]registryEntry
}

func NewProgramRegistry(programs map[string]string) (*ProgramRegistry, error) {
	if len(programs) == 0 || len(programs) > 32 {
		return nil, fmt.Errorf("invalid registry size")
	}
	registry := &ProgramRegistry{programs: make(map[[32]byte][]byte)}
	for id, value := range programs {
		key, err := hex.DecodeString(id)
		if err != nil || len(key) != 32 || hex.EncodeToString(key) != id {
			return nil, fmt.Errorf("invalid registry profile")
		}
		program, err := hex.DecodeString(value)
		if err != nil || len(program) == 0 || len(program) > txscript.MaxScriptSize || hex.EncodeToString(program) != value {
			return nil, fmt.Errorf("invalid registered program")
		}
		digest := sha256.Sum256(program)
		if !bytes.Equal(digest[:], key) {
			return nil, fmt.Errorf("registry program hash mismatch")
		}
		tokenizer := MakeScriptTokenizer(0, program)
		for tokenizer.Next() {
			if tokenizer.Opcode() == RegistryOpcode || tokenizer.Opcode() == OP_PUSHEXPIRY {
				return nil, fmt.Errorf("recursive registry or unsupported expiry")
			}
		}
		if err := tokenizer.Err(); err != nil {
			return nil, err
		}
		registry.programs[digest] = append([]byte(nil), program...)
	}
	return registry, nil
}

func WithRegisteredPrograms(registry *ProgramRegistry, sidecar []byte) ExecuteOption {
	return func(vm *Engine) { vm.programRegistry = registry; vm.registryRaw = append([]byte(nil), sidecar...) }
}

func readRegistrySidecar(raw []byte) (*registrySidecar, error) {
	if len(raw) > maxRegistrySidecar {
		return nil, fmt.Errorf("registry sidecar too large")
	}
	reader := bytes.NewReader(raw)
	var header [2]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil || header != [2]byte{0x53, 1} {
		return nil, fmt.Errorf("invalid registry sidecar version")
	}
	read16 := func() (uint16, error) {
		var n uint16
		err := binary.Read(reader, binary.LittleEndian, &n)
		return n, err
	}
	result := &registrySidecar{entries: make(map[int]registryEntry)}
	for i := range result.packets {
		size, err := read16()
		if err != nil || size > 520 {
			return nil, fmt.Errorf("invalid virtual packet size")
		}
		result.packets[i] = make([]byte, int(size))
		if _, err := io.ReadFull(reader, result.packets[i]); err != nil {
			return nil, err
		}
	}
	size, err := read16()
	if err != nil || size != 160 {
		return nil, fmt.Errorf("invalid old state packet size")
	}
	result.oldState = make([]byte, int(size))
	if _, err := io.ReadFull(reader, result.oldState); err != nil {
		return nil, err
	}
	count, err := reader.ReadByte()
	if err != nil || count == 0 || count > 4 {
		return nil, fmt.Errorf("invalid registry entry count")
	}
	previous := -1
	for i := 0; i < int(count); i++ {
		vin, err := read16()
		if err != nil || int(vin) <= previous {
			return nil, fmt.Errorf("registry entries must have unique increasing inputs")
		}
		previous = int(vin)
		var entry registryEntry
		if _, err := io.ReadFull(reader, entry.profile[:]); err != nil {
			return nil, err
		}
		items, err := read16()
		if err != nil || items > 1000 {
			return nil, fmt.Errorf("invalid registry witness count")
		}
		entry.witness = make([][]byte, int(items))
		total := 0
		for j := range entry.witness {
			size, err := read16()
			if err != nil || size > 520 {
				return nil, fmt.Errorf("invalid registry witness element")
			}
			total += int(size)
			if total > maxCombinedStackByteSize {
				return nil, fmt.Errorf("registry witness exceeds stack budget")
			}
			entry.witness[j] = make([]byte, int(size))
			if _, err := io.ReadFull(reader, entry.witness[j]); err != nil {
				return nil, err
			}
		}
		result.entries[int(vin)] = entry
	}
	if reader.Len() != 0 {
		return nil, fmt.Errorf("trailing registry sidecar bytes")
	}
	return result, nil
}

func (vm *Engine) resolveRegisteredProgram() error {
	script := vm.scripts[len(vm.scripts)-1]
	if len(script) != 34 || script[0] != 32 || script[33] != RegistryOpcode {
		return nil
	}
	if vm.programRegistry == nil {
		return fmt.Errorf("registered-program capability unavailable")
	}
	if len(vm.tx.TxIn[vm.txIdx].SignatureScript) != 0 || vm.dstack.Depth() != 0 {
		return fmt.Errorf("registered program requires an empty native witness")
	}
	digest, err := findPacketByType(&vm.tx, RegistryPacketType)
	if err != nil || len(digest) != 32 {
		return fmt.Errorf("missing registry sidecar commitment")
	}
	actual := sha256.Sum256(vm.registryRaw)
	if !bytes.Equal(actual[:], digest) {
		return fmt.Errorf("registry sidecar commitment mismatch")
	}
	sidecar, err := readRegistrySidecar(vm.registryRaw)
	if err != nil {
		return err
	}
	var profile [32]byte
	copy(profile[:], script[1:33])
	entry, ok := sidecar.entries[vm.txIdx]
	if !ok || entry.profile != profile {
		return fmt.Errorf("registry input/profile mismatch")
	}
	program, ok := vm.programRegistry.programs[profile]
	if !ok {
		return fmt.Errorf("unknown registered program")
	}
	for i := 0; i < 3; i++ {
		data, err := findPacketByType(&vm.tx, byte(0x80+i))
		if err != nil || data != nil {
			return fmt.Errorf("native packet shadows registry public inputs")
		}
	}
	if vm.scriptIdx != len(vm.scripts)-1 {
		return fmt.Errorf("invalid registry execution position")
	}
	vm.scripts[vm.scriptIdx] = program
	vm.tokenizer = MakeScriptTokenizer(vm.version, program)
	vm.SetStack(entry.witness)
	vm.registryPackets = &sidecar.packets
	vm.registryOldState = sidecar.oldState
	return nil
}

func (vm *Engine) registryState(content []byte, previous bool) ([]byte, error) {
	if vm.registryPackets == nil {
		return content, nil
	}
	state := vm.registryPackets[3]
	if previous {
		state = vm.registryOldState
	}
	if len(content) != 32 || len(state) != 160 {
		return nil, fmt.Errorf("invalid registered state encoding")
	}
	digest := sha256.Sum256(state)
	if !bytes.Equal(content, digest[:]) {
		return nil, fmt.Errorf("registered state hash mismatch")
	}
	return state, nil
}
