# Shielded Arkade PoC

This private, experimental workspace contains a runnable proof of concept. The showcase compiles the `.ark` contracts in `contracts/poc/`, generates Groth16 proofs, builds transactions with the Arkade SDK, then submits them to the Go emulator's real `Service.SubmitTx` VM. It covers BTC and a demonstration token through **shield → seal → private transfer → seal → withdraw**. A Mutinynet container path is included for test-network operation; this remains a bounded PoC, not production wallet software. See [the PoC profile](spec/POC-PROFILE.md) for its design and security limits.

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
docker compose up --build -d
docker compose ps
docker compose logs -f shielded
```

Compose defaults to `https://mutinynet.arkade.sh` and `https://emulator.mutinynet.arkade.sh`. The UI asks for the API token and receives a signed HttpOnly session cookie; scripts can send `Authorization: Bearer <token>`. `/healthz` reports whether the server process is alive. `/readyz` reports whether the engine can accept operations; a Mutinynet instance can remain unready until its bootstrap/funding setup is complete while the UI remains available to perform that setup. Bootstrap first checks the current proof profile against the operator's transaction-weight limit and stops before funding if it cannot fit. If it passes, the live wallet displays its funding address and requires at least 203,330 Mutinynet test sats before issuing identities; transaction fees can require additional funds. Use test coins only, and treat operator acceptance as preconfirmation rather than Bitcoin finality.

The named `shielded-data` volume holds an authenticated, encrypted SQLite checkpoint and the generated encryption key. Preserve the volume as a unit when moving or restoring it. To manage the key separately, set `SHIELDED_STORAGE_KEY` before starting Compose and back it up securely; a securely generated 64-character hex value is a suitable key string. The service uses one process per data volume; do not attach the same volume to multiple replicas. `docker compose down` preserves the volume; remove it separately only when intentionally discarding the wallet state.

For an isolated image smoke test against the bundled local emulator, run `npm ci` followed by `npm run test:deployment`. It builds and starts the actual image, exercises authentication and proof/VM shield, seal, transfer, and withdrawal actions, then restarts the container and checks that wallet state and native heads survived. The smoke test creates and removes only its own uniquely named image, container, and volume.

## Limits and older design

The local emulator uses synthetic genesis/funding, fixture signing keys, and single-party test proving keys. Mutinynet uses real test-network requests and operator signatures, but operator acceptance is not Bitcoin confirmation. The observer view is a display filter. The profile is limited to one lane, bounded note/history trees, one asset boundary per settlement, and one process per encrypted data volume; it does not provide refresh/expiry handling, emergency exits, or independent production security review. See [spec/POC-PROFILE.md](spec/POC-PROFILE.md), [tools/vm/README.md](tools/vm/README.md), and [HANDOFF.md](HANDOFF.md) before extending it.

The engine writes its checkpoint before and after native submission. A saved accepted receipt completes local state without another submission. An unknown submission outcome blocks spending; restart the service to reconcile the saved transaction against authoritative network evidence. Checkpoint-write failures also require restart. Back up the encryption key with the database: losing the key makes an intact checkpoint unrecoverable.

The deployment smoke validates the bundled local emulator. Mutinynet connectivity, signer policy, funding discovery, and encrypted restart have been checked, but live pool transactions remain unverified: the connected operator currently permits 40,000 weight units and the proof profile has a conservative floor of 54,860 before the rest of the transaction. Bootstrap refuses to fund an incompatible pool. A smaller proof profile or a compatible operator limit is required before live transaction testing.

The earlier research design and fail-closed contract scaffold remain in [spec/protocol-design.md](spec/protocol-design.md) and `contracts/`. They are distinct from the runnable bounded profile under `contracts/poc/` and are not used by this showcase. Keep protocol-specific work private unless publication is explicitly approved.
