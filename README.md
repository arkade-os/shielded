# Shielded Arkade PoC

This private, experimental workspace contains a runnable local proof of concept. The current showcase compiles the `.ark` contracts in `contracts/poc/`, generates Groth16 proofs, builds transactions with the Arkade SDK, then submits them to the Go emulator's real `Service.SubmitTx` VM. It covers BTC and a demonstration token through **shield → seal → private transfer → seal → withdraw**. It is not deployable software; see [the PoC profile](spec/POC-PROFILE.md) for its bounded design and security limits.

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

## Limits and older design

The showcase uses synthetic genesis/funding, deterministic test signing keys, and single-party test proving keys. Do not fund these programs or treat emulator signatures as Bitcoin confirmations. The observer view is a display filter, and wallet state is local to one process. The profile is limited to one lane, bounded note/history trees, and one asset boundary per settlement; it does not provide live arkd/Bitcoin settlement, durable recovery, refresh/expiry handling, emergency exits, or independent production security review. See [spec/POC-PROFILE.md](spec/POC-PROFILE.md), [tools/vm/README.md](tools/vm/README.md), and [HANDOFF.md](HANDOFF.md) before extending it.

The earlier research design and fail-closed contract scaffold remain in [spec/protocol-design.md](spec/protocol-design.md) and `contracts/`. They are distinct from the runnable bounded profile under `contracts/poc/` and are not used by this showcase. Keep protocol-specific work private unless publication is explicitly approved.
