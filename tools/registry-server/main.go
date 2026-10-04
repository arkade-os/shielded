package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/arkade-os/arkd/pkg/ark-lib/txutils"
	"github.com/arkade-os/emulator/pkg/arkade"
	"github.com/arkade-os/emulator/pkg/emulator"
	"github.com/btcsuite/btcd/btcec/v2"
	"github.com/btcsuite/btcd/psbt/v2"
	"github.com/btcsuite/btcd/wire/v2"
)

const (
	maxRequestBytes = 4 << 20
	maxIndexBytes   = 9 << 20
	maxPrevTxBytes  = 1 << 20
	maxSidecarBytes = 128 << 10
	maxInputs       = 4
	maxConcurrentVM = 2
	protocolName    = "shielded-registered-v1"
	serviceVersion  = "shielded-registry/1"
)

type request struct {
	ArkTx           string   `json:"arkTx"`
	CheckpointTxs   []string `json:"checkpointTxs"`
	RegistrySidecar string   `json:"registrySidecar"`
}

type response struct {
	SignedArkTx         string   `json:"signedArkTx,omitempty"`
	SignedCheckpointTxs []string `json:"signedCheckpointTxs,omitempty"`
	Error               string   `json:"error,omitempty"`
}

type capabilities struct {
	Version            string   `json:"version"`
	SignerPubkey       string   `json:"signerPubkey"`
	RegistryProtocol   string   `json:"registryProtocol"`
	RegistryHash       string   `json:"registryHash"`
	RegisteredPrograms []string `json:"registeredPrograms"`
	MaxSidecarBytes    int      `json:"maxSidecarBytes"`
}

type virtualTxSource interface {
	FetchVirtualTxs(context.Context, []string) (map[string]*wire.MsgTx, error)
}

type indexerSource struct {
	base   *url.URL
	client *http.Client
}

func newIndexerSource(raw string) (*indexerSource, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || (u.Path != "" && u.Path != "/") {
		return nil, errors.New("indexer URL must be an HTTPS origin without credentials, path, query, or fragment")
	}
	u.Path = ""
	return &indexerSource{base: u, client: &http.Client{Timeout: 8 * time.Second}}, nil
}

func (s *indexerSource) FetchVirtualTxs(ctx context.Context, txids []string) (map[string]*wire.MsgTx, error) {
	if len(txids) == 0 || len(txids) > maxInputs {
		return nil, errors.New("invalid previous transaction request count")
	}
	for _, txid := range txids {
		if len(txid) != 64 {
			return nil, errors.New("invalid previous transaction id")
		}
		if _, err := hex.DecodeString(txid); err != nil || strings.ToLower(txid) != txid {
			return nil, errors.New("invalid previous transaction id")
		}
	}
	u := *s.base
	u.Path = "/v1/indexer/virtualTx/" + strings.Join(txids, ",")
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	resp, err := s.client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("trusted indexer request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("trusted indexer returned HTTP %d", resp.StatusCode)
	}
	var payload struct {
		Txs []string `json:"txs"`
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, maxIndexBytes+1))
	if err := decoder.Decode(&payload); err != nil || payload.Txs == nil {
		return nil, errors.New("trusted indexer returned invalid transaction data")
	}
	var trailing any
	if err := decoder.Decode(&trailing); err != io.EOF {
		return nil, errors.New("trusted indexer returned trailing data")
	}
	if len(payload.Txs) > maxInputs {
		return nil, errors.New("trusted indexer returned too many transactions")
	}
	result := make(map[string]*wire.MsgTx, len(payload.Txs))
	for _, encoded := range payload.Txs {
		if encoded == "" || len(encoded) > maxPrevTxBytes*2 {
			return nil, errors.New("trusted indexer returned an invalid transaction")
		}
		raw, err := hex.DecodeString(encoded)
		if err != nil || hex.EncodeToString(raw) != encoded {
			return nil, errors.New("trusted indexer transaction is not canonical lowercase hex")
		}
		r := bytes.NewReader(raw)
		tx := wire.NewMsgTx(wire.TxVersion)
		if err := tx.Deserialize(r); err != nil || r.Len() != 0 {
			return nil, errors.New("trusted indexer transaction is malformed")
		}
		txid := tx.TxHash().String()
		if _, duplicate := result[txid]; duplicate {
			return nil, errors.New("trusted indexer returned duplicate transactions")
		}
		result[txid] = tx
	}
	for _, txid := range txids {
		if result[txid] == nil {
			return nil, fmt.Errorf("trusted indexer has no virtual transaction %s", txid)
		}
	}
	return result, nil
}

type server struct {
	service  emulator.Service
	indexer  virtualTxSource
	info     capabilities
	apiToken []byte
	slots    chan struct{}
}

// The hash is SHA256 over UTF-8 compact JSON for the map. Go's JSON encoder
// sorts string map keys; registry keys are lowercase ASCII hex, so this is the
// required lexical byte ordering. Program values are canonical lowercase hex.
func canonicalRegistry(raw []byte) (map[string]string, []string, string, error) {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return nil, nil, "", errors.New("invalid registered program map")
	}
	programs := make(map[string]string)
	seenIDs := make(map[string]struct{})
	for decoder.More() {
		keyToken, err := decoder.Token()
		id, ok := keyToken.(string)
		if err != nil || !ok {
			return nil, nil, "", errors.New("invalid or duplicate registered program id")
		}
		if _, exists := seenIDs[id]; exists {
			return nil, nil, "", errors.New("invalid or duplicate registered program id")
		}
		seenIDs[id] = struct{}{}
		var value string
		if err := decoder.Decode(&value); err != nil {
			return nil, nil, "", errors.New("registered program bytecode must be a string")
		}
		programs[id] = value
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return nil, nil, "", errors.New("invalid registered program map")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return nil, nil, "", errors.New("registered program map must contain one JSON object")
	}
	if len(programs) == 0 || len(programs) > 32 {
		return nil, nil, "", errors.New("registered program count must be between 1 and 32")
	}
	ids := make([]string, 0, len(programs))
	for id, value := range programs {
		key, err := hex.DecodeString(id)
		program, programErr := hex.DecodeString(value)
		if err != nil || len(key) != 32 || hex.EncodeToString(key) != id || programErr != nil || len(program) == 0 || hex.EncodeToString(program) != value {
			return nil, nil, "", errors.New("registered program map must use lowercase canonical hex")
		}
		digest := sha256.Sum256(program)
		if !bytes.Equal(key, digest[:]) {
			return nil, nil, "", fmt.Errorf("registered program hash mismatch for %s", id)
		}
		ids = append(ids, id)
	}
	sort.Strings(ids)
	canonical, err := json.Marshal(programs)
	if err != nil {
		return nil, nil, "", err
	}
	digest := sha256.Sum256(canonical)
	return programs, ids, hex.EncodeToString(digest[:]), nil
}

func loadServer(registryPath, keyPath, arkSignerHex, indexerURL, tokenPath string, indexer virtualTxSource) (*server, error) {
	registryRaw, err := os.ReadFile(registryPath)
	if err != nil {
		return nil, fmt.Errorf("read immutable registry: %w", err)
	}
	if len(registryRaw) > 2<<20 {
		return nil, errors.New("registered program map exceeds 2 MiB")
	}
	programs, ids, registryHash, err := canonicalRegistry(registryRaw)
	if err != nil {
		return nil, err
	}
	registry, err := arkade.NewProgramRegistry(programs)
	if err != nil {
		return nil, fmt.Errorf("validate registered programs: %w", err)
	}
	keyRaw, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, errors.New("read mounted emulator signer key")
	}
	keyHex := strings.TrimSpace(string(keyRaw))
	keyBytes, err := hex.DecodeString(keyHex)
	if err != nil || len(keyBytes) != 32 || hex.EncodeToString(keyBytes) != keyHex {
		return nil, errors.New("mounted emulator key must be a 32-byte lowercase hex scalar")
	}
	var secretScalar btcec.ModNScalar
	if secretScalar.SetByteSlice(keyBytes) || secretScalar.IsZero() {
		return nil, errors.New("mounted emulator key is not a valid secp256k1 scalar")
	}
	for _, marker := range []byte{1, 2, 3, 4} {
		if bytes.Equal(keyBytes, bytes.Repeat([]byte{marker}, 32)) {
			return nil, errors.New("public PoC fixture key is forbidden")
		}
	}
	emulatorKey, _ := btcec.PrivKeyFromBytes(keyBytes)
	arkSignerBytes, err := hex.DecodeString(arkSignerHex)
	if err != nil || len(arkSignerBytes) != 33 || hex.EncodeToString(arkSignerBytes) != arkSignerHex {
		return nil, errors.New("pinned Ark operator signer must be canonical compressed hex")
	}
	arkSigner, err := btcec.ParsePubKey(arkSignerBytes)
	if err != nil {
		return nil, errors.New("invalid pinned Ark operator signer")
	}
	for _, marker := range []byte{1, 2, 3, 4} {
		fixture, _ := btcec.PrivKeyFromBytes(bytes.Repeat([]byte{marker}, 32))
		if arkSigner.IsEqual(fixture.PubKey()) {
			return nil, errors.New("public PoC fixture key is forbidden as Ark operator signer")
		}
	}
	if indexer == nil {
		indexer, err = newIndexerSource(indexerURL)
		if err != nil {
			return nil, err
		}
	}
	service, err := emulator.NewWithProgramRegistry(emulatorKey, nil, nil, arkSigner, arkade.DefaultComputeLimits(), registry)
	if err != nil {
		return nil, err
	}
	var token []byte
	if tokenPath != "" {
		token, err = os.ReadFile(tokenPath)
		if err != nil {
			return nil, errors.New("read mounted API token")
		}
		token = bytes.TrimSpace(token)
		if len(token) < 32 {
			return nil, errors.New("API token must contain at least 32 bytes")
		}
	}
	return &server{service: service, indexer: indexer, apiToken: token, info: capabilities{
		Version: serviceVersion, SignerPubkey: hex.EncodeToString(emulatorKey.PubKey().SerializeCompressed()),
		RegistryProtocol: protocolName, RegistryHash: registryHash, RegisteredPrograms: ids,
		MaxSidecarBytes: maxSidecarBytes,
	}, slots: make(chan struct{}, maxConcurrentVM)}, nil
}

func canonicalBase64(value string, max int) ([]byte, error) {
	if value == "" || len(value) > base64.StdEncoding.EncodedLen(max) {
		return nil, errors.New("invalid base64 field size")
	}
	decoded, err := base64.StdEncoding.Strict().DecodeString(value)
	if err != nil || len(decoded) > max || base64.StdEncoding.EncodeToString(decoded) != value {
		return nil, errors.New("field must use canonical padded base64")
	}
	return decoded, nil
}

func removePrevArkTxFields(packet *psbt.Packet) {
	key := append([]byte{txutils.ArkPsbtFieldKeyType}, arkade.ArkFieldPrevArkTx...)
	for i := range packet.Inputs {
		unknowns := packet.Inputs[i].Unknowns[:0]
		for _, field := range packet.Inputs[i].Unknowns {
			if !bytes.Equal(field.Key, key) {
				unknowns = append(unknowns, field)
			}
		}
		packet.Inputs[i].Unknowns = unknowns
	}
}

func (s *server) authoritativePrevouts(ctx context.Context, arkTx *psbt.Packet, checkpoints []*psbt.Packet) error {
	if arkTx.UnsignedTx == nil || len(arkTx.UnsignedTx.TxIn) == 0 || len(arkTx.UnsignedTx.TxIn) > maxInputs || len(arkTx.Inputs) != len(arkTx.UnsignedTx.TxIn) || len(checkpoints) != len(arkTx.UnsignedTx.TxIn) {
		return errors.New("registered transaction requires 1 to 4 matched checkpoints")
	}
	checkpointsByID := make(map[string]*psbt.Packet, len(checkpoints))
	for _, checkpoint := range checkpoints {
		if checkpoint == nil || checkpoint.UnsignedTx == nil || len(checkpoint.UnsignedTx.TxIn) != 1 || len(checkpoint.Inputs) != 1 || checkpoint.Inputs[0].WitnessUtxo == nil {
			return errors.New("invalid checkpoint input")
		}
		id := checkpoint.UnsignedTx.TxHash().String()
		if checkpointsByID[id] != nil {
			return errors.New("duplicate checkpoint transaction")
		}
		checkpointsByID[id] = checkpoint
	}
	needed := make([]string, 0, len(checkpoints))
	for vin, input := range arkTx.UnsignedTx.TxIn {
		checkpoint := checkpointsByID[input.PreviousOutPoint.Hash.String()]
		if checkpoint == nil || input.PreviousOutPoint.Index != 0 {
			return fmt.Errorf("input %d has no exact checkpoint output", vin)
		}
		txid := checkpoint.UnsignedTx.TxIn[0].PreviousOutPoint.Hash.String()
		if len(txid) != 64 {
			return errors.New("invalid checkpoint previous transaction id")
		}
		needed = append(needed, txid)
	}
	unique := make([]string, 0, len(needed))
	seen := map[string]bool{}
	for _, id := range needed {
		if !seen[id] {
			seen[id] = true
			unique = append(unique, id)
		}
	}
	transactions, err := s.indexer.FetchVirtualTxs(ctx, unique)
	if err != nil {
		return err
	}
	removePrevArkTxFields(arkTx)
	for vin, input := range arkTx.UnsignedTx.TxIn {
		checkpoint := checkpointsByID[input.PreviousOutPoint.Hash.String()]
		id := checkpoint.UnsignedTx.TxIn[0].PreviousOutPoint.Hash.String()
		previous := transactions[id]
		if previous == nil {
			return fmt.Errorf("trusted indexer lacks previous transaction for input %d", vin)
		}
		prevout := checkpoint.UnsignedTx.TxIn[0].PreviousOutPoint
		if int(prevout.Index) >= len(previous.TxOut) {
			return fmt.Errorf("previous transaction output index out of range for input %d", vin)
		}
		indexedOutput := previous.TxOut[prevout.Index]
		witnessOutput := checkpoint.Inputs[0].WitnessUtxo
		if indexedOutput.Value != witnessOutput.Value || !bytes.Equal(indexedOutput.PkScript, witnessOutput.PkScript) {
			return fmt.Errorf("indexer previous output does not match checkpoint input %d", vin)
		}
		if err := txutils.SetArkPsbtField(arkTx, vin, arkade.PrevArkTxField, *previous); err != nil {
			return fmt.Errorf("attach trusted previous transaction for input %d: %w", vin, err)
		}
	}
	return nil
}

func (s *server) authorized(r *http.Request) bool {
	if len(s.apiToken) == 0 {
		return true
	}
	value := strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ") || len(value) != len(s.apiToken) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(value), s.apiToken) == 1
}

func (s *server) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /v1/info", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, s.info)
	})
	mux.HandleFunc("POST /v1/tx", func(w http.ResponseWriter, r *http.Request) {
		if !s.authorized(r) {
			writeJSON(w, http.StatusUnauthorized, response{Error: "unauthorized"})
			return
		}
		if s.slots != nil {
			select {
			case s.slots <- struct{}{}:
				defer func() { <-s.slots }()
			default:
				writeJSON(w, http.StatusTooManyRequests, response{Error: "registered verifier is busy"})
				return
			}
		}
		if r.Header.Get("Content-Type") != "application/json" {
			writeJSON(w, http.StatusUnsupportedMediaType, response{Error: "application/json required"})
			return
		}
		requestBody, err := decodeRequest(http.MaxBytesReader(w, r.Body, maxRequestBytes))
		if err != nil {
			writeJSON(w, http.StatusBadRequest, response{Error: err.Error()})
			return
		}
		arkRaw, err := canonicalBase64(requestBody.ArkTx, maxRequestBytes)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, response{Error: "invalid Ark PSBT encoding"})
			return
		}
		sidecar, err := canonicalBase64(requestBody.RegistrySidecar, maxSidecarBytes)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, response{Error: "invalid registry sidecar encoding"})
			return
		}
		arkTx, err := psbt.NewFromRawBytes(bytes.NewReader(arkRaw), false)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, response{Error: "invalid Ark PSBT"})
			return
		}
		if len(requestBody.CheckpointTxs) == 0 || len(requestBody.CheckpointTxs) > maxInputs {
			writeJSON(w, http.StatusBadRequest, response{Error: "one to four checkpoint PSBTs required"})
			return
		}
		checkpoints := make([]*psbt.Packet, len(requestBody.CheckpointTxs))
		for i, encoded := range requestBody.CheckpointTxs {
			raw, decodeErr := canonicalBase64(encoded, maxRequestBytes)
			if decodeErr != nil {
				writeJSON(w, http.StatusBadRequest, response{Error: fmt.Sprintf("invalid checkpoint %d encoding", i)})
				return
			}
			checkpoints[i], err = psbt.NewFromRawBytes(bytes.NewReader(raw), false)
			if err != nil {
				writeJSON(w, http.StatusBadRequest, response{Error: fmt.Sprintf("invalid checkpoint %d PSBT", i)})
				return
			}
		}
		if err := s.authoritativePrevouts(r.Context(), arkTx, checkpoints); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, response{Error: "previous transaction validation failed"})
			return
		}
		if err := validateNativeAssets(r.Context(), arkTx, checkpoints); err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, response{Error: "native asset validation failed"})
			return
		}
		arkTxID := arkTx.UnsignedTx.TxID()
		checkpointIDs := make([]string, len(checkpoints))
		for i := range checkpoints {
			checkpointIDs[i] = checkpoints[i].UnsignedTx.TxID()
		}
		signed, err := s.service.SubmitTx(r.Context(), emulator.OffchainTx{ArkTx: arkTx, Checkpoints: checkpoints}, emulator.OffchainData{RegistrySidecar: sidecar})
		if err != nil {
			writeJSON(w, http.StatusUnprocessableEntity, response{Error: "registered transaction rejected"})
			return
		}
		if signed == nil || signed.ArkTx == nil || signed.ArkTx.UnsignedTx.TxID() != arkTxID || len(signed.Checkpoints) != len(checkpointIDs) {
			writeJSON(w, http.StatusInternalServerError, response{Error: "emulator changed the submitted transaction set"})
			return
		}
		signedArk, err := signed.ArkTx.B64Encode()
		if err != nil {
			writeJSON(w, http.StatusInternalServerError, response{Error: "failed to encode signed Ark PSBT"})
			return
		}
		signedCheckpoints := make([]string, len(signed.Checkpoints))
		for i, checkpoint := range signed.Checkpoints {
			if checkpoint == nil || checkpoint.UnsignedTx == nil || checkpoint.UnsignedTx.TxID() != checkpointIDs[i] {
				writeJSON(w, http.StatusInternalServerError, response{Error: "emulator changed a checkpoint transaction"})
				return
			}
			signedCheckpoints[i], err = checkpoint.B64Encode()
			if err != nil {
				writeJSON(w, http.StatusInternalServerError, response{Error: "failed to encode signed checkpoint"})
				return
			}
		}
		writeJSON(w, http.StatusOK, response{SignedArkTx: signedArk, SignedCheckpointTxs: signedCheckpoints})
	})
	return mux
}

func decodeRequest(reader io.Reader) (request, error) {
	var req request
	decoder := json.NewDecoder(io.LimitReader(reader, maxRequestBytes+1))
	opening, err := decoder.Token()
	if err != nil || opening != json.Delim('{') {
		return req, errors.New("invalid request JSON")
	}
	seen := make(map[string]bool, 3)
	for decoder.More() {
		keyToken, err := decoder.Token()
		key, ok := keyToken.(string)
		if err != nil || !ok || seen[key] {
			return req, errors.New("invalid or duplicate request field")
		}
		seen[key] = true
		switch key {
		case "arkTx":
			err = decoder.Decode(&req.ArkTx)
		case "checkpointTxs":
			err = decoder.Decode(&req.CheckpointTxs)
		case "registrySidecar":
			err = decoder.Decode(&req.RegistrySidecar)
		default:
			return req, errors.New("unknown request field")
		}
		if err != nil {
			return req, errors.New("invalid request field value")
		}
	}
	closing, err := decoder.Token()
	if err != nil || closing != json.Delim('}') {
		return req, errors.New("invalid request JSON")
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return req, errors.New("expected one JSON object")
	}
	if req.ArkTx == "" || req.RegistrySidecar == "" || len(req.CheckpointTxs) == 0 {
		return req, errors.New("arkTx, checkpointTxs, and registrySidecar are required")
	}
	return req, nil
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}

func run() error {
	listen := flag.String("listen", "127.0.0.1:8790", "listen address; public use must sit behind a TLS-terminating proxy")
	registryPath := flag.String("registry", "/etc/shielded/registry.json", "immutable registered program map")
	keyPath := flag.String("emulator-key-file", "/run/secrets/emulator-key", "mounted emulator signer key, lowercase 32-byte hex")
	arkSigner := flag.String("ark-signer", "", "pinned trusted Ark operator signer public key, compressed hex")
	indexerURL := flag.String("indexer-url", "", "trusted HTTPS Arkade indexer origin")
	tokenPath := flag.String("api-token-file", "", "mounted bearer token required for nonloopback listener")
	flag.Parse()
	address := *listen
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return fmt.Errorf("invalid listen address: %w", err)
	}
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() {
		if *tokenPath == "" {
			return errors.New("nonloopback listeners require --api-token-file; use a TLS reverse proxy and rate limits")
		}
	}
	s, err := loadServer(*registryPath, *keyPath, *arkSigner, *indexerURL, *tokenPath, nil)
	if err != nil {
		return err
	}
	server := &http.Server{Addr: address, Handler: s.handler(), ReadHeaderTimeout: 3 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 10 * time.Second, IdleTimeout: 30 * time.Second, MaxHeaderBytes: 16 << 10}
	fmt.Fprintf(os.Stderr, "registered verifier service listening on %s protocol=%s registry=%s\n", address, s.info.RegistryProtocol, s.info.RegistryHash)
	return server.ListenAndServe()
}

func main() {
	if err := run(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
