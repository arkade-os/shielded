package main

import (
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math/big"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/arkade-os/arkd/pkg/ark-lib/asset"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/btcsuite/btcd/txscript/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

func compilerVariantEnabled() bool { return os.Getenv("SHIELDED_COMPILER_VARIANT") == "1" }

func compilerBindings(client, batch rollupKey) map[string]map[string]string {
	values := map[string]*big.Int{"alpha.x": client.Alpha[0], "alpha.y": client.Alpha[1]}
	for i, p := range client.IC {
		values[fmt.Sprintf("clientIC.%d.x", i)], values[fmt.Sprintf("clientIC.%d.y", i)] = p[0], p[1]
	}
	for i, p := range batch.IC {
		values[fmt.Sprintf("batchIC.%d.x", i)], values[fmt.Sprintf("batchIC.%d.y", i)] = p[0], p[1]
	}
	for name, g := range map[string]rollupG2{"negBeta": client.NegBeta, "negGamma": client.NegGamma, "negDeltaClient": client.NegDelta, "negDeltaBatch": batch.NegDelta} {
		for j, f := range []string{"xC1", "xC0", "yC1", "yC0"} {
			values[name+"."+f] = g[j]
		}
	}
	bindings := map[string]map[string]string{}
	for name, v := range values {
		bindings[name] = map[string]string{"int": v.String()}
	}
	return bindings
}

func compilerAssemble(tokens []string, bindings map[string]string) ([]byte, error) {
	b := txscript.NewScriptBuilder()
	for i, tok := range tokens {
		if op, ok := arkade.OpcodeByName[tok]; ok {
			b.AddOp(op)
			continue
		}
		if strings.HasPrefix(tok, "<") && strings.HasSuffix(tok, ">") {
			value, ok := bindings[tok[1:len(tok)-1]]
			if !ok {
				return nil, fmt.Errorf("token %d: unbound placeholder %s", i, tok)
			}
			tok = value
		}
		if strings.HasPrefix(tok, "0x") {
			data, err := hex.DecodeString(tok[2:])
			if err != nil {
				return nil, fmt.Errorf("token %d: %w", i, err)
			}
			if len(data) == 1 && data[0] == 0 {
				b.AddOps([]byte{txscript.OP_DATA_1, 0})
			} else {
				b.AddData(data)
			}
			continue
		}
		v, ok := new(big.Int).SetString(tok, 10)
		if !ok {
			return nil, fmt.Errorf("token %d: unknown %q", i, tok)
		}
		if v.IsInt64() {
			b.AddInt64(v.Int64())
		} else {
			b.AddData(scriptNumBytes(v))
		}
	}
	return b.Script()
}

func compilerArtifact(raw []byte, name string) ([]string, error) {
	var art struct {
		FormatVersion int `json:"formatVersion"`
		Functions     []struct {
			Name   string `json:"name"`
			Arkade *struct {
				ASM []string `json:"asm"`
			} `json:"arkade"`
		} `json:"functions"`
	}
	if err := json.Unmarshal(raw, &art); err != nil {
		return nil, err
	}
	if art.FormatVersion != 1 {
		return nil, fmt.Errorf("unsupported compiler artifact version %d", art.FormatVersion)
	}
	var asm []string
	for _, f := range art.Functions {
		if f.Name == name {
			if asm != nil || f.Arkade == nil || len(f.Arkade.ASM) == 0 {
				return nil, fmt.Errorf("invalid or duplicate %s covenant", name)
			}
			asm = f.Arkade.ASM
		}
	}
	if asm == nil {
		return nil, fmt.Errorf("artifact has no %s covenant", name)
	}
	return asm, nil
}

func compilerCommand(t testing.TB, args ...string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	if output, err := exec.CommandContext(ctx, args[0], args[1:]...).CombinedOutput(); err != nil {
		t.Fatalf("%v: %v\n%s", args, err, output)
	}
}

func compilerCompile(t testing.TB, source, name, out string) []string {
	t.Helper()
	compiler := os.Getenv("SHIELDED_ARKADEC")
	if compiler == "" {
		t.Fatal("compiler variant requires SHIELDED_ARKADEC")
	}
	compilerCommand(t, compiler, source, "-o", out)
	raw, err := os.ReadFile(out)
	if err != nil {
		t.Fatal(err)
	}
	asm, err := compilerArtifact(raw, name)
	if err != nil {
		t.Fatal(err)
	}
	return asm
}

func compilerBatchLeaf(t testing.TB, slots int, kind byte, client, batch rollupKey) rollupLeaf {
	return compilerBatchLeafExport(t, slots, kind, client, batch, "")
}

func compilerLiteral(tok string) (int, error) {
	if strings.HasPrefix(tok, "OP_") {
		tok = strings.TrimPrefix(tok, "OP_")
	}
	return strconv.Atoi(tok)
}

func compilerMetadata(asm []string) (rollupLeaf, error) {
	leaf := rollupLeaf{}
	for i, tok := range asm {
		if tok == "OP_ECMUL" {
			leaf.ECMul++
		}
		if tok == "OP_ECPAIRING" {
			if i < 2 {
				return leaf, fmt.Errorf("pairing has no literal count and curve")
			}
			pairs, err := compilerLiteral(asm[i-2])
			curve, curveErr := compilerLiteral(asm[i-1])
			if err != nil || pairs < 1 || pairs > 16 || curveErr != nil || curve != 2 {
				return leaf, fmt.Errorf("invalid pairing count or BN254 curve")
			}
			leaf.Pairs += pairs
		}
	}
	return leaf, nil
}

func compilerBatchLeafExport(t testing.TB, slots int, kind byte, client, batch rollupKey, export string) rollupLeaf {
	t.Helper()
	if slots != 11 || kind > 1 {
		t.Fatal("compiler variant requires 11 slots and kind 0 or 1")
	}
	dir := t.TempDir()
	bindPath, source, out := filepath.Join(dir, "binds.json"), filepath.Join(dir, "batch.ark"), filepath.Join(dir, "batch.json")
	raw, err := json.Marshal(compilerBindings(client, batch))
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bindPath, raw, 0o600); err != nil {
		t.Fatal(err)
	}
	python := os.Getenv("SHIELDED_PYTHON")
	if python == "" {
		python = "python3"
	}
	compilerCommand(t, python, "-I", "../../contracts/compiler/generate.py", bindPath, fmt.Sprint(kind), source)
	asm := compilerCompile(t, source, "batch", out)
	leaf, err := compilerMetadata(asm)
	if err != nil {
		t.Fatal(err)
	}
	if leaf.Script, err = compilerAssemble(asm, nil); err != nil {
		t.Fatal(err)
	}
	if export != "" {
		for name, path := range map[string]string{"batch.ark": source, "public-vk-bindings.json": bindPath, "batch.raw.json": out} {
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			compilerWrite(t, export, name, data)
		}
	}
	return leaf
}

func compilerWrite(t testing.TB, dir, name string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(dir, 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
		t.Fatal(err)
	}
}

func compilerWriteJSON(t testing.TB, dir, name string, value any) {
	t.Helper()
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	compilerWrite(t, dir, name, append(data, '\n'))
}

func compilerReserveLeaf(t testing.TB, token asset.AssetId) []byte {
	t.Helper()
	asm := compilerCompile(t, "../../contracts/compiler/reserve.ark", "reserve", filepath.Join(t.TempDir(), "reserve.json"))
	script, err := compilerAssemble(asm, map[string]string{"tokenTxid": "0x" + hex.EncodeToString(token.Txid[:]), "tokenGidx": fmt.Sprint(token.Index)})
	if err != nil {
		t.Fatal(err)
	}
	return script
}

// The compiler ABI expands bp, then slots[0..10], with the first field on top.
func compilerWitness(wit wire.TxWitness, slots int) wire.TxWitness {
	expanded := append([][]byte{}, wit[:8]...)
	for i := 0; i < slots; i++ {
		k := slots - 1 - i
		expanded = append(expanded, wit[8+k*13:8+(k+1)*13]...)
	}
	out := make(wire.TxWitness, len(expanded))
	for i := range expanded {
		out[len(expanded)-1-i] = expanded[i]
	}
	return out
}

func TestCompilerAssembler(t *testing.T) {
	wide := new(big.Int).Lsh(big.NewInt(1), 200)
	got, err := compilerAssemble([]string{"0x00", wide.String(), "<index>", "OP_DROP"}, map[string]string{"index": "2"})
	if err != nil {
		t.Fatal(err)
	}
	want, _ := txscript.NewScriptBuilder().AddOps([]byte{txscript.OP_DATA_1, 0}).AddData(scriptNumBytes(wide)).AddInt64(2).AddOp(txscript.OP_DROP).Script()
	if hex.EncodeToString(got) != hex.EncodeToString(want) {
		t.Fatalf("assembled %x, want %x", got, want)
	}
	for _, tok := range []string{"<missing>", "OP_UNKNOWN", "0xzz", "not-a-number"} {
		if _, err := compilerAssemble([]string{tok}, nil); err == nil {
			t.Errorf("accepted %q", tok)
		}
	}
	for _, raw := range []string{`{"formatVersion":1,"functions":[{"name":"wrong","arkade":{"asm":["1"]}}]}`, `{"formatVersion":1,"functions":[{"name":"batch"}]}`, `{"formatVersion":2}`} {
		if _, err := compilerArtifact([]byte(raw), "batch"); err == nil {
			t.Errorf("accepted artifact %s", raw)
		}
	}
}

func TestCompilerPairingMetadata(t *testing.T) {
	for _, literals := range [][]string{{"OP_16", "OP_2"}, {"16", "2"}, {"OP_16", "2"}} {
		asm := append([]string{"OP_ECMUL", "OP_ECMUL"}, literals...)
		leaf, err := compilerMetadata(append(asm, "OP_ECPAIRING"))
		if err != nil || leaf.ECMul != 2 || leaf.Pairs != 16 {
			t.Fatalf("%v: metadata %+v, error %v", literals, leaf, err)
		}
	}
	for _, asm := range [][]string{{"OP_ECPAIRING"}, {"2", "OP_ECPAIRING"}, {"0", "2", "OP_ECPAIRING"}, {"17", "2", "OP_ECPAIRING"}, {"16", "1", "OP_ECPAIRING"}, {"OP_PICK", "2", "OP_ECPAIRING"}} {
		if _, err := compilerMetadata(asm); err == nil {
			t.Errorf("accepted invalid pairing metadata %v", asm)
		}
	}
}

type compilerWeightVector struct {
	Name                string `json:"name"`
	Kind                byte   `json:"kind"`
	GoWeight            int    `json:"goWeightWU"`
	CompilerWeight      int    `json:"compilerWeightWU"`
	Limit               int    `json:"limitWU"`
	GoFits              bool   `json:"goFits"`
	CompilerFits        bool   `json:"compilerFits"`
	GoScriptBytes       int    `json:"goScriptBytes"`
	CompilerScriptBytes int    `json:"compilerScriptBytes"`
	Reserve             bool   `json:"reserve"`
}

func compilerExportScripts(t testing.TB, dir string, hand, compiled *rollupWorld) {
	t.Helper()
	if dir == "" {
		return
	}
	leaf := compilerBatchLeafExport(t, compiled.slots, compiled.kind, compiled.client.key, compiled.batch.key, dir)
	if !bytes.Equal(leaf.Script, compiled.leaf.Script) {
		t.Fatal("exported compiler script differs from executed script")
	}
	for name, script := range map[string][]byte{"batch.go.hex": hand.leaf.Script, "batch.compiled.hex": compiled.leaf.Script, "reserve.go.hex": hand.reserveLeaf, "reserve.compiled.hex": compiled.reserveLeaf} {
		compilerWrite(t, dir, name, []byte(hex.EncodeToString(script)+"\n"))
	}
	compilerWriteJSON(t, dir, "metadata.json", map[string]any{"slots": compiled.slots, "kind": compiled.kind, "ecMul": compiled.leaf.ECMul, "pairingPairs": compiled.leaf.Pairs})
}

func compilerExportTransaction(t *testing.T, dir string, batch *rollupBatch) {
	t.Helper()
	if dir == "" {
		return
	}
	var raw bytes.Buffer
	if err := batch.finalTx().Serialize(&raw); err != nil {
		t.Fatal(err)
	}
	witness := make([]string, len(batch.witness))
	for i, item := range batch.witness {
		witness[i] = hex.EncodeToString(item)
	}
	prevouts := make([]map[string]any, 0, len(batch.tx.TxIn))
	for _, input := range batch.tx.TxIn {
		op := input.PreviousOutPoint
		prev := batch.prevouts[op]
		entry := map[string]any{"txid": op.Hash.String(), "vout": op.Index, "valueSats": prev.Value, "scriptHex": hex.EncodeToString(prev.PkScript)}
		if parent := batch.parents[op]; parent != nil {
			var parentRaw bytes.Buffer
			if err := parent.Serialize(&parentRaw); err != nil {
				t.Fatal(err)
			}
			entry["parentTransactionHex"] = hex.EncodeToString(parentRaw.Bytes())
		}
		prevouts = append(prevouts, entry)
	}
	compilerWriteJSON(t, dir, "transfer-vector.json", map[string]any{
		"fixtureSeed": 11, "kind": batch.w.kind, "transactionHex": hex.EncodeToString(raw.Bytes()),
		"witnessHex": witness, "witnessOrder": "bottom to top", "prevouts": prevouts,
		"transactionForm": "unsigned full transaction including emulator extension; signedWeightWU adds two 64-byte signature placeholders, leaf and control block per input",
		"signedWeightWU":  batch.signedWeight(t), "fixtureOnly": "synthetic public test VK and proofs; not production setup or signing material",
	})
}

func TestCompilerReferenceSources(t *testing.T) {
	if !compilerVariantEnabled() {
		return
	}
	for _, source := range []struct{ file, function string }{{"rollup.ark", "batch"}, {"reserve.ark", "reserve"}, {"renew.ark", "renew"}} {
		compilerCompile(t, "../../contracts/compiler/"+source.file, source.function, filepath.Join(t.TempDir(), "reference.json"))
	}
}

func TestCompilerBatchWeightComparison(t *testing.T) {
	if !compilerVariantEnabled() {
		return
	}
	hand := newRollupWorldVariant(t, 11, 0, 11, false)
	compiled := newRollupWorldVariant(t, 11, 0, 11, true)
	candidate := os.Getenv("SHIELDED_COMPILER_CANDIDATE") == "1"
	output := os.Getenv("SHIELDED_COMPILER_OUTPUT")
	if output != "" && !filepath.IsAbs(output) {
		t.Fatal("SHIELDED_COMPILER_OUTPUT must be absolute")
	}
	kindDir := func(kind byte) string {
		if output == "" {
			return ""
		}
		return filepath.Join(output, fmt.Sprintf("kind-%d", kind))
	}
	compilerExportScripts(t, kindDir(0), hand, compiled)
	var weights []compilerWeightVector
	hand.headIn, compiled.headIn = 10_000_000_000, 10_000_000_000
	leafDelta, reserveDelta := len(compiled.leaf.Script)-len(hand.leaf.Script), len(compiled.reserveLeaf)-len(hand.reserveLeaf)
	t.Logf("batch: Go %d B, compiler %d B; reserve: Go %d B, compiler %d B", len(hand.leaf.Script), len(compiled.leaf.Script), len(hand.reserveLeaf), len(compiled.reserveLeaf))
	if !candidate && (leafDelta <= 0 || reserveDelta != 2) {
		t.Fatalf("unexpected compiler deltas: batch %+d B, reserve %+d B", leafDelta, reserveDelta)
	}
	payouts := make([]rollupLeg, 11)
	for i := range payouts {
		payouts[i] = rollupLeg{wd: 100_000_000, dest: rollupProgram(byte(0x30 + i))}
	}
	for _, mix := range []struct {
		name             string
		legs             []rollupLeg
		reserve, blocked bool
	}{
		{"transfers only", make([]rollupLeg, 11), false, false},
		{"deposits, payouts and an asset", hand.honestLegs(true), true, true},
		{"11 deposits of 1 BTC", rollupDeposits(11, false), false, true},
		{"11 payouts of 1 BTC", payouts, false, true},
		{"reserve and 8 deposit inputs", rollupDeposits(8, true), true, true},
	} {
		oldBatch, newBatch := hand.batchOf(mix.legs, mix.reserve), compiled.batchOf(mix.legs, mix.reserve)
		for _, b := range []*rollupBatch{oldBatch, newBatch} {
			if err := b.execute(); err != nil {
				t.Fatalf("%s (compiled=%t): %v", mix.name, b.w.compiled, err)
			}
		}
		oldWeight, newWeight := oldBatch.signedWeight(t), newBatch.signedWeight(t)
		wantDelta := 4 * leafDelta
		if mix.reserve {
			wantDelta += 4 * reserveDelta
		}
		if oldWeight > rollupMaxTxWeight || newWeight-oldWeight != wantDelta {
			t.Errorf("%s: Go %d WU, compiler %d WU, wanted delta %d", mix.name, oldWeight, newWeight, wantDelta)
		}
		if !candidate && (newWeight > rollupMaxTxWeight) != mix.blocked {
			t.Errorf("%s: compiler %d WU; expected blocked=%t", mix.name, newWeight, mix.blocked)
		}
		t.Logf("%s: Go %d WU, compiler %d WU; blocked=%t", mix.name, oldWeight, newWeight, newWeight > rollupMaxTxWeight)
		weights = append(weights, compilerWeightVector{mix.name, 0, oldWeight, newWeight, rollupMaxTxWeight, oldWeight <= rollupMaxTxWeight, newWeight <= rollupMaxTxWeight, len(hand.leaf.Script), len(compiled.leaf.Script), mix.reserve})
		if mix.name == "transfers only" {
			compilerExportTransaction(t, kindDir(0), newBatch)
		}
	}
	handJoin := newRollupWorldVariant(t, 11, 1, 11, false)
	join := newRollupWorldVariant(t, 11, 1, 11, true)
	handJoin.headIn, join.headIn = hand.headIn, hand.headIn
	compilerExportScripts(t, kindDir(1), handJoin, join)
	oldJoin := rollupTransfers(handJoin)
	b := rollupTransfers(join)
	if err := oldJoin.execute(); err != nil {
		t.Fatal(err)
	}
	if err := b.execute(); err != nil {
		t.Fatal(err)
	}
	oldWeight, newWeight := oldJoin.signedWeight(t), b.signedWeight(t)
	if oldWeight > rollupMaxTxWeight || newWeight-oldWeight != 4*(len(join.leaf.Script)-len(handJoin.leaf.Script)) {
		t.Fatalf("join weight delta differs from script delta: Go %d WU, compiler %d WU", oldWeight, newWeight)
	}
	if !candidate && newWeight > rollupMaxTxWeight {
		t.Fatalf("compiled join transfer %d WU", newWeight)
	}
	t.Logf("compiled join transfer: Go %d WU, compiler %d WU; blocked=%t", oldWeight, newWeight, newWeight > rollupMaxTxWeight)
	weights = append(weights, compilerWeightVector{"join transfers only", 1, oldWeight, newWeight, rollupMaxTxWeight, oldWeight <= rollupMaxTxWeight, newWeight <= rollupMaxTxWeight, len(handJoin.leaf.Script), len(join.leaf.Script), false})
	compilerExportTransaction(t, kindDir(1), b)
	if output != "" {
		compilerWriteJSON(t, output, "weights.json", weights)
		compilerWriteJSON(t, output, "reproducibility.json", map[string]any{
			"fixtureSeed": 11, "stable": []string{"batch.ark", "public-vk-bindings.json", "*.hex", "metadata.json", "transfer-vector.json", "weights.json"},
			"excluded": map[string]string{"batch.raw.json": "raw compiler artifact retains createdAt and temporary source path metadata", "toolchain.json": "compiler binary hash and local candidate provenance vary by build"},
		})
	}
}
