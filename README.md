> The current local entry point is the [client-owned wallet lab](spec/NONCUSTODIAL-LAB.md). Run `npm run vm:registry:build`, `npm run build`, then `npm run server`, and open http://127.0.0.1:8789/wallet. Its real proofs and transactions use synthetic funding. Live registry deployment and production security gates remain open; the older demo below is retained for regression tests.

# Shielded Arkade PoC

**Legacy deployment security status:** the retained compact demo is custodial, not a
completed Shielded design. The compact verifier checks proofs offchain; the
ordinary Ark operator does not independently enforce them, so a malicious
Shielded verifier can seek a native-valid signature for an invalid Shielded
spend without operator collusion. The service holds the demo users' keys, and
note holders cannot independently exit their share of pooled funds if the
service disappears. The new local client-owned lab implements key separation and registered VM proof
enforcement; the larger architecture and production recovery gates remain incomplete. See [the security status](SECURITY.md) and
[replacement architecture gates](spec/COMPACT-ARCHITECTURE.md).

The retained inline showcase compiles the `.ark` contracts in `contracts/poc/`,
generates Groth16 proofs, builds transactions with the Arkade SDK, then submits
them to the Go emulator's real `Service.SubmitTx` VM. Both transports cover BTC
and a demonstration token through **shield → seal → private transfer → seal →
withdraw**. A Mutinynet container path is included for test-network operation;
this remains a bounded PoC, not production wallet software. See [the PoC
profile](spec/POC-PROFILE.md) for its design and security limits.

The additional `compact` transport keeps real proofs, verification keys and
verifier code off the native transaction. Transactions carry a 133-byte binding
packet plus actual native effects and signatures. This is a tested byte-saving
experiment; it does not solve the trust problem and is not an accepted
replacement architecture. Existing inline checkpoints are preserved and cannot
silently switch profiles.

Compact bootstrap now hands off automatically after the SDK has issued the
four assets and durably registered the verifier profile. The legacy runtime is
closed at the persisted `funding-programs` boundary, before it can send the
first resource-funding transaction. The continuation writes a fresh-start
marker and each exact funding request to the engine's encrypted checkpoint,
validates operator responses and native-asset change, and saves accepted
receipts before finalization. After a restart it validates the contiguous
receipt-backed prefix and funds only missing resources. If a Submit response is
lost, it queries the operator's pending-response endpoint using the saved input
outpoints; it never resubmits an unknown request. Unmarked partial legacy
funding fails closed for explicit recovery.

Ready restore requires the same registered profile and authenticated receipts
for all four resource heads. The funded Mutinynet lifecycle has now passed its
20-action two-user, two-asset run: Alice and Bob completed bidirectional BTC
and DEMO flows through shield, seal, transfer, and withdrawal. All 20
transactions were accepted and indexed; the report also records passing
negative scenarios. The largest native transaction was 3,436 WU against the
4,000 WU effective cap (the operator advertises 40,000 WU). See the
[funded validation report](validation/compact-mutinynet.json). The restart/replay
check also passed on the same container image and named volume: all 20 prior
actions replayed, no new financial actions were recorded, and the before/after
financial-state digests match. See the
[restart/replay report](validation/compact-mutinynet-restart-replay.json).
The authenticated browser UI run also passed: it replayed 20 cached accepted
receipts, inspected 20 public receipts, and verified authentication, logout,
privacy views, and reserves. It recorded zero new financial actions and an
unchanged financial-state digest. See the
[UI validation report](validation/compact-ui.json). This covers cached receipt
replay, not new funded transactions or a clean first funded bootstrap. The live
lifecycle used the already funded resource heads; the fresh-bootstrap
continuation is covered by controlled SDK transaction tests.
The registered profile, verifier sources, proving artifacts, and keys remain
unchanged. This is a treasury-funded operator PoC with service-owned demo keys;
it has no customer deposit rail or independent note-holder pool exit.

## Run on Windows

Install Node.js 24 or newer and Go 1.26.6 or newer. From this directory:

```sh
npm ci
npm run vm:build
npm run build
npm run server
```

Open <http://127.0.0.1:8787>. This serves the built app and API on loopback. For app hot reload, use `npm run dev` by itself; it starts both the API on port 8787 and Vite at <http://127.0.0.1:5173>.

`npm ci` applies the pinned SDK PUT-opcode compatibility patch. `npm run vm:build` builds the platform-specific VM binary from Go; binaries are local build outputs and are not committed. The compiled Programs and proving artifacts are included for normal runs. To recompile the PoC contracts on either platform, set `ARKADEC_PATH` or `ARKADEC` to a compiler you built from the pairing-product branch used by compiler PR 124; the compiler checkout under `.deps/` is local-only and is not included.

## Validate

```sh
npm test
npm run build
npm run test:primitives
npm run test:e2e
```

The unit suite covers SDK covenant construction, rejection cases, bootstrap
recovery, and the real ready adapter. The primitive smoke flow makes real
proofs and exercises stale-state rejection and rebase. The retained inline E2E
flow covers the compiler → SDK Program → proof → emulator path, accepted
transactions, withdrawal, replay/tamper rejection, and API key omission. To
run the Go bridge checks independently, use `cd tools/vm` then `go test ./...`.

## Run the container on Mutinynet

Install Docker Engine with Compose, copy `.env.example` to `.env`, and replace `SHIELDED_API_TOKEN` with a unique random value of at least 32 characters. Keep the published port on loopback unless a trusted TLS reverse proxy protects the service.

```sh
docker compose --project-name shielded-compact up --build -d
docker compose --project-name shielded-compact ps
docker compose --project-name shielded-compact logs -f shielded
```

The example uses a fresh project and volume for the compact profile. `.env.example` selects `SHIELDED_PROOF_TRANSPORT=compact`; an existing inline wallet cannot switch profiles. Compact mode uses `https://mutinynet.arkade.sh` and a dedicated verifier inside the service. Inline mode uses the configured public emulator. The UI asks for the API token and receives a signed HttpOnly session cookie; scripts can send `Authorization: Bearer <token>`. `/healthz` reports whether the server process is alive. `/readyz` remains unready until funding and bootstrap complete, while the UI exposes those steps. Each Ark transaction must fit the smaller of the operator limit and 4,000 WU. The UI reports the remaining test-funding requirement and fees. Bootstrap issues four native identities, pins their verifier profile, and automatically continues into four separately journaled resource-funding transactions. Use test coins only; operator acceptance is preconfirmation rather than Bitcoin finality.

Before any resource funding, compact bootstrap durably records its fresh-start
marker and exact `SubmitTx` request in the same encrypted engine checkpoint.
It validates the operator response—including transaction body, prevout
metadata, spend leaves, signatures, native-asset conservation, and wallet-owned
change—before saving the response and finalizing. After interruption, recovery
checks indexed acceptance first, then uses the exact saved wallet inputs to
query the read-only pending-response endpoint. Unknown outcomes are never
resubmitted; missing or ambiguous evidence blocks bootstrap. An unmarked legacy
partial funding state is not adopted automatically. See the
[compact profile](spec/COMPACT-PROFILE.md) for constraints.

This service is treasury-funded and keeps its demonstration wallet keys. The
displayed Ark and boarding addresses belong to the service; they are not an
external customer deposit rail. For local/test-network operation, send only
test coins. Boarding inputs are journaled before joining the shared Bitcoin
round, and ambiguous retries remain blocked. The server commands and image
enable Node 24's EventSource transport for Ark round events.

The named `shielded-data` volume holds an authenticated, encrypted SQLite checkpoint and the generated encryption key. Preserve the volume as a unit when moving or restoring it. To manage the key separately, set `SHIELDED_STORAGE_KEY` before starting Compose and back it up securely; a securely generated 64-character hex value is a suitable key string. The service uses one process per data volume; do not attach the same volume to multiple replicas. `docker compose down` preserves the volume; remove it separately only when intentionally discarding the wallet state.

For an isolated image smoke test, run `npm ci` followed by `npm run test:deployment`. Set `SHIELDED_SMOKE_TRANSPORT=compact` to test the offchain verifier; the default tests the retained inline proof/VM flow. Both exercise authentication, payments, withdrawal, idempotency and encrypted restart. The smoke removes only its own uniquely named image, container and volume. [Compact profile commands](spec/COMPACT-PROFILE.md) also describe the explicit funded Mutinynet smoke.

## Limits and older design

The local emulator uses synthetic genesis/funding, fixture signing keys, and single-party test proving keys. Mutinynet uses test-network requests and operator signatures, but operator acceptance is not Bitcoin confirmation. The observer view is a display filter. The profile is limited to one lane, depth-eight note/history trees, one asset boundary per settlement, and one process per encrypted data volume. It does not provide independent client-owned keys, a customer deposit rail, an independent note-holder pool exit, refresh/expiry handling, or emergency exits. It has no independent production security review. See [spec/POC-PROFILE.md](spec/POC-PROFILE.md), [tools/vm/README.md](tools/vm/README.md), and [HANDOFF.md](HANDOFF.md) before extending it.

The engine writes its checkpoint before and after native submission. A saved accepted receipt completes local state without another submission. An unknown submission outcome blocks spending; restart the service to reconcile the saved transaction against authoritative network evidence. Checkpoint-write failures also require restart. Back up the encryption key with the database: losing the key makes an intact checkpoint unrecoverable.

The retained inline profile remains blocked on Mutinynet: its conservative floor is 54,860 WU before the rest of the transaction, above the observed 40,000-WU operator cap. Compact mode removes programs, keys and proofs from the transaction and uses its own stricter weight preflight. Local compact validation is separate from funded network evidence; see the compact profile and recorded validation artifacts for the tested scope.

The earlier research design and fail-closed contract scaffold remain in [spec/protocol-design.md](spec/protocol-design.md) and `contracts/`. They are distinct from the runnable bounded profile under `contracts/poc/` and are not used by this showcase. Keep protocol-specific work private unless publication is explicitly approved.
