// Command shielded-vm executes SDK-built Ark transactions through the real
// Arkade emulator service, including checkpoint validation and cosigning.
// The embedded signer is a PUBLIC PoC key. Never fund its programs.
package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/arkade-os/emulator/pkg/emulator"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/btcec/v2/schnorr"
	"github.com/btcsuite/btcd/chainhash/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

const maxRequestBytes = 16 << 20

type expiry struct {
	TxID   string `json:"txid"`
	Vout   uint32 `json:"vout"`
	Expiry int64  `json:"expiry"`
}

type request struct {
	Sidecar      string   `json:"sidecar,omitempty"`
	ID           string   `json:"id,omitempty"`
	ArkTx        string   `json:"arkTx"`
	Checkpoints  []string `json:"checkpoints"`
	VtxoExpiries []expiry `json:"vtxoExpiries,omitempty"`
}

type response struct {
	ID             string   `json:"id,omitempty"`
	OK             bool     `json:"ok"`
	Error          string   `json:"error,omitempty"`
	ArkTx          string   `json:"arkTx,omitempty"`
	Checkpoints    []string `json:"checkpoints,omitempty"`
	TxID           string   `json:"txid,omitempty"`
	ExecutedInputs int      `json:"executedInputs,omitempty"`
	SignatureCount int      `json:"signatureCount,omitempty"`
	DurationMS     float64  `json:"durationMs"`
	Backend        string   `json:"backend"`
}

type bridge struct{ service emulator.Service }

func newBridge() (*bridge, error) {
	emulatorKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	serverKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	service, err := emulator.New(emulatorKey, nil, nil, serverKey.PubKey(), arkade.DefaultComputeLimits())
	if err != nil {
		return nil, err
	}
	return &bridge{service: service}, nil
}

func decodePSBT(encoded string) (*psbt.Packet, error) {
	if encoded == "" {
		return nil, errors.New("missing base64 PSBT")
	}
	return psbt.NewFromRawBytes(strings.NewReader(encoded), true)
}

func (b *bridge) execute(ctx context.Context, req request) (res response) {
	start := time.Now()
	res.ID, res.Backend = req.ID, "arkade-emulator-Service.SubmitTx"
	defer func() {
		res.DurationMS = float64(time.Since(start).Microseconds()) / 1000
		if recovered := recover(); recovered != nil {
			res.OK = false
			res.Error = fmt.Sprintf("malformed request rejected: %v", recovered)
		}
		if !res.OK {
			res.ArkTx, res.Checkpoints, res.TxID = "", nil, ""
			res.ExecutedInputs, res.SignatureCount = 0, 0
		}
	}()
	arkTx, err := decodePSBT(req.ArkTx)
	if err != nil {
		res.Error = fmt.Sprintf("decode ark transaction: %v", err)
		return
	}
	checkpoints := make([]*psbt.Packet, len(req.Checkpoints))
	for i, value := range req.Checkpoints {
		checkpoints[i], err = decodePSBT(value)
		if err != nil {
			res.Error = fmt.Sprintf("decode checkpoint %d: %v", i, err)
			return
		}
	}
	data := emulator.OffchainData{VtxoExpiries: make(map[wire.OutPoint]int64)}
	for _, value := range req.VtxoExpiries {
		hash, hashErr := chainhash.NewHashFromStr(value.TxID)
		if hashErr != nil {
			res.Error = "invalid expiry transaction ID"
			return
		}
		data.VtxoExpiries[wire.OutPoint{Hash: *hash, Index: value.Vout}] = value.Expiry
	}
	if err := configureRegistryData(&data, req); err != nil {
		res.Error = err.Error()
		return
	}
	packet, err := arkade.FindEmulatorPacket(arkTx.UnsignedTx)
	if err != nil {
		res.Error = fmt.Sprintf("decode emulator packet: %v", err)
		return
	}
	if err := validateNativeAssets(ctx, arkTx, checkpoints); err != nil {
		res.Error = fmt.Sprintf("native backing validation: %v", err)
		return
	}
	emulatorKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	for _, entry := range packet {
		if _, err := arkade.ReadArkadeScript(arkTx, emulatorKey.PubKey(), entry); err != nil {
			res.Error = fmt.Sprintf("unrecognized PoC program for input %d: %v", entry.Vin, err)
			return
		}
	}
	signed, err := b.service.SubmitTx(ctx, emulator.OffchainTx{ArkTx: arkTx, Checkpoints: checkpoints}, data)
	if err != nil {
		res.Error = err.Error()
		return
	}
	res.ArkTx, err = signed.ArkTx.B64Encode()
	if err != nil {
		res.Error = fmt.Sprintf("encode signed ark transaction: %v", err)
		return
	}
	res.Checkpoints = make([]string, len(signed.Checkpoints))
	for i, checkpoint := range signed.Checkpoints {
		res.Checkpoints[i], err = checkpoint.B64Encode()
		if err != nil {
			res.Error = fmt.Sprintf("encode signed checkpoint %d: %v", i, err)
			return
		}
		for _, input := range checkpoint.Inputs {
			res.SignatureCount += len(input.TaprootScriptSpendSig)
		}
	}
	for _, input := range signed.ArkTx.Inputs {
		res.SignatureCount += len(input.TaprootScriptSpendSig)
	}
	res.OK, res.TxID, res.ExecutedInputs = true, signed.ArkTx.UnsignedTx.TxID(), len(packet)
	return
}

func decodeRequest(reader io.Reader) (request, error) {
	var req request
	decoder := json.NewDecoder(io.LimitReader(reader, maxRequestBytes+1))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&req); err != nil {
		return req, err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return req, errors.New("expected one JSON request")
	}
	return req, nil
}

func info() map[string]any {
	emulatorKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{2}, 32))
	serverKey, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{1}, 32))
	return map[string]any{
		"backend": "arkade-emulator-Service.SubmitTx", "poc": true,
		"emulatorPublicKey": hex.EncodeToString(schnorr.SerializePubKey(emulatorKey.PubKey())),
		"serverPublicKey":   hex.EncodeToString(schnorr.SerializePubKey(serverKey.PubKey())),
		"nativeValidation":  "checkpoint lineage, native asset provenance/conservation, native BTC conservation, tapleaf commitment, actual VM, default compute budgets, cosigning",
	}
}

func (b *bridge) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(info())
	})
	mux.HandleFunc("POST /execute", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		req, err := decodeRequest(http.MaxBytesReader(w, r.Body, maxRequestBytes))
		if err != nil {
			w.WriteHeader(http.StatusBadRequest)
			_ = json.NewEncoder(w).Encode(response{Error: err.Error(), Backend: "arkade-emulator-Service.SubmitTx"})
			return
		}
		_ = json.NewEncoder(w).Encode(b.execute(r.Context(), req))
	})
	return mux
}

func main() {
	listen := flag.String("listen", "", "serve HTTP on loopback address, e.g. 127.0.0.1:8788; default is JSONL stdin/stdout")
	registryFile := flag.String("registry", "", "immutable local program registry file; registered profiles cannot be provided in a request")
	stockBuildFile := flag.String("stock-build", "", "build six stock-opcode program leaves from a one-public-input snarkjs Groth16 verification key and print JSON")
	rollupLeavesFile := flag.String("rollup-leaves", "", "build the rollup pool's batch, reserve and renewal leaves from a spec JSON and print JSON")
	printInfo := flag.Bool("info", false, "print bridge profile and deterministic PoC public keys")
	trace := flag.Bool("trace", false, "print local diagnostic opcode trace to stderr on JSONL failure")
	flag.Parse()
	if *stockBuildFile != "" {
		manifest, err := buildStockManifest(*stockBuildFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := json.NewEncoder(os.Stdout).Encode(manifest); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if *rollupLeavesFile != "" {
		manifest, err := buildRollupLeaves(*rollupLeavesFile)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		if err := json.NewEncoder(os.Stdout).Encode(manifest); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if *printInfo {
		_ = json.NewEncoder(os.Stdout).Encode(info())
		return
	}
	b, err := newConfiguredBridge(*registryFile)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if *listen != "" {
		if !strings.HasPrefix(*listen, "127.0.0.1:") && !strings.HasPrefix(*listen, "localhost:") {
			fmt.Fprintln(os.Stderr, "PoC bridge must listen on loopback only")
			os.Exit(1)
		}
		server := &http.Server{Addr: *listen, Handler: b.handler(), ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 60 * time.Second, WriteTimeout: 60 * time.Second}
		fmt.Fprintln(os.Stderr, "Arkade PoC emulator bridge listening on", *listen)
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64<<10), maxRequestBytes)
	encoder := json.NewEncoder(os.Stdout)
	for scanner.Scan() {
		req, err := decodeRequest(bytes.NewReader(scanner.Bytes()))
		if err != nil {
			_ = encoder.Encode(response{Error: err.Error(), Backend: "arkade-emulator-Service.SubmitTx"})
			continue
		}
		res := b.execute(context.Background(), req)
		if *trace && !res.OK {
			_ = json.NewEncoder(os.Stderr).Encode(diagnose(req))
		}
		_ = encoder.Encode(res)
	}
	if err := scanner.Err(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
