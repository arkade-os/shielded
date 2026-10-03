# Shielded Arkade PoC

This private, experimental workspace contains a runnable proof of concept. The retained inline showcase compiles the `.ark` contracts in `contracts/poc/`, generates Groth16 proofs, builds transactions with the Arkade SDK, then submits them to the Go emulator's real `Service.SubmitTx` VM. Both transports cover BTC and a demonstration token through **shield → seal → private transfer → seal → withdraw**. A Mutinynet container path is included for test-network operation; this remains a bounded PoC, not production wallet software. See [the PoC profile](spec/POC-PROFILE.md) for its design and security limits.

The additional `compact` transport keeps real proofs, verification keys and
verifier code off the native transaction. Transactions carry a 133-byte binding
packet plus actual native effects and signatures. A dedicated verifier checks
the full sidecar before signing; it retains an operator trust and liveness
dependency. See [the compact profile](spec/COMPACT-PROFILE.md) for its authority,
exit limits, startup and validation commands. Existing inline checkpoints are
preserved and cannot silently switch profiles.

The compact Docker test records 2,370–3,376 WU for main transactions and 732 WU
per checkpoint in [validation/compact-deployment.json](validation/compact-deployment.json).
That is local fixture evidence. The monitored Mutinynet service has received
funds, registered its verifier profile, and reached the program-funding phase.
No resource heads are recorded, readiness remains false, and the funding result
is under investigation after an output-mismatch response. The funded transaction
lifecycle remains unverified. The [saved network
preflight](validation/compact-mutinynet-preflight.json) predates funding and is
historical evidence, not the current wallet state. The showcase holds its demo
wallet keys and uses treasury backing; an external customer deposit rail and
independent note-holder pool exit are not implemented.

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

The unit suite covers SDK covenant construction and rejection cases. The primitive smoke flow makes real proofs and exercises stale-state rejection and rebase. The end-to-end report in [validation/e2e.json](validation/e2e.json) records the actual compiler → SDK Program → proof → emulator path, including accepted transactions, withdrawal, replay/tamper rejection, and key omission from the API. To run the Go bridge checks independently, use `cd tools/vm` then `go test ./...`.

## Run the container on Mutinynet

Install Docker Engine with Compose, copy `.env.example` to `.env`, and replace `SHIELDED_API_TOKEN` with a unique random value of at least 32 characters. Keep the published port on loopback unless a trusted TLS reverse proxy protects the service.

```sh
docker compose --project-name shielded-compact up --build -d
docker compose --project-name shielded-compact ps
docker compose --project-name shielded-compact logs -f shielded
```

The example uses a fresh project and volume for the compact profile. `.env.example` selects `SHIELDED_PROOF_TRANSPORT=compact`; an existing inline wallet cannot switch profiles. Compact mode uses `https://mutinynet.arkade.sh` and a dedicated verifier inside the service. Inline mode uses the configured public emulator. The UI asks for the API token and receives a signed HttpOnly session cookie; scripts can send `Authorization: Bearer <token>`. `/healthz` reports whether the server process is alive. `/readyz` remains unready until funding and bootstrap complete, while the UI exposes those steps. Each Ark transaction must fit the smaller of the operator limit and 4,000 WU. The live wallet requires at least 203,330 Mutinynet test sats initially; fees can require additional funds. Bootstrap issues four native identities, pins their verifier profile, and funds four resource heads in separate resumable transactions. Use test coins only; operator acceptance is preconfirmation rather than Bitcoin finality.

Compact bootstrap journals each exact `SubmitTx` request before contacting the
operator. It validates the operator-only response—including the transaction
body, previous-output metadata, expected checkpoint leaves, and pinned operator
signatures—before the SDK wallet signs the checkpoints. The validated response
is saved before `FinalizeTx`. After interruption, recovery first checks indexed
acceptance, then queries the read-only pending-response endpoint using the exact
saved inputs; it never retries `SubmitTx` for an unknown outcome. If no matching
response can be recovered, bootstrap remains blocked. The indexer returns
base64-encoded PSBTs with body/output evidence, but Arkd strips operator
signature fields, so an indexed PSBT is not a complete signed receipt. A
finalized-transaction recovery can restore signature fields only when the exact
final witness still contains matching signatures and the expected leaf and
control block; otherwise it fails closed. Recovery of a finalized transaction
without its journal has not been verified. The read-only pending-response
endpoint is the path for recovering a full, unfinalized operator response.

Fund the displayed Ark address directly, or send on-chain coins to the boarding address and use **Board confirmed funds** after confirmation. Sync only refreshes balances. The service journals boarding inputs before joining the shared Bitcoin round and blocks ambiguous retries. The server commands and image enable Node 24's EventSource transport for Ark round events.

The named `shielded-data` volume holds an authenticated, encrypted SQLite checkpoint and the generated encryption key. Preserve the volume as a unit when moving or restoring it. To manage the key separately, set `SHIELDED_STORAGE_KEY` before starting Compose and back it up securely; a securely generated 64-character hex value is a suitable key string. The service uses one process per data volume; do not attach the same volume to multiple replicas. `docker compose down` preserves the volume; remove it separately only when intentionally discarding the wallet state.

For an isolated image smoke test, run `npm ci` followed by `npm run test:deployment`. Set `SHIELDED_SMOKE_TRANSPORT=compact` to test the offchain verifier; the default tests the retained inline proof/VM flow. Both exercise authentication, payments, withdrawal, idempotency and encrypted restart. The smoke removes only its own uniquely named image, container and volume. [Compact profile commands](spec/COMPACT-PROFILE.md) also describe the explicit funded Mutinynet smoke.

## Limits and older design

The local emulator uses synthetic genesis/funding, fixture signing keys, and single-party test proving keys. Mutinynet uses real test-network requests and operator signatures, but operator acceptance is not Bitcoin confirmation. The observer view is a display filter. The profile is limited to one lane, bounded note/history trees, one asset boundary per settlement, and one process per encrypted data volume; it does not provide refresh/expiry handling, emergency exits, or independent production security review. See [spec/POC-PROFILE.md](spec/POC-PROFILE.md), [tools/vm/README.md](tools/vm/README.md), and [HANDOFF.md](HANDOFF.md) before extending it.

The engine writes its checkpoint before and after native submission. A saved accepted receipt completes local state without another submission. An unknown submission outcome blocks spending; restart the service to reconcile the saved transaction against authoritative network evidence. Checkpoint-write failures also require restart. Back up the encryption key with the database: losing the key makes an intact checkpoint unrecoverable.

The retained inline profile remains blocked on Mutinynet: its conservative floor is 54,860 WU before the rest of the transaction, above the observed 40,000-WU operator cap. Compact mode removes programs, keys and proofs from the transaction and uses its own stricter weight preflight. Local compact validation is separate from funded network evidence; see the compact profile and recorded validation artifacts for the tested scope.

The earlier research design and fail-closed contract scaffold remain in [spec/protocol-design.md](spec/protocol-design.md) and `contracts/`. They are distinct from the runnable bounded profile under `contracts/poc/` and are not used by this showcase. Keep protocol-specific work private unless publication is explicitly approved.
