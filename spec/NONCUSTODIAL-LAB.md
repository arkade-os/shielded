# Client-owned Shielded lab

This is an isolated local vertical slice, not a funded Mutinynet deployment or production claim. The existing funded compact deployment is frozen and separate.

## Run

With Node 24 and Go 1.26.6 installed:

```sh
npm ci
npm run vm:registry:build
npm run build
npm run server
```

Open http://127.0.0.1:8789/wallet. Create Alice and Bob using separate browser profiles, or lock one wallet before creating the other. Download each encrypted backup. The coordinator freezes their public recipient descriptors and native public keys after both register. The default server now starts this lab; `npm run server:legacy` retains the historical demo.

Deposit synthetic BTC/DEMO, seal the receipts, pay the other participant, seal again, and withdraw. Lock and unlock or import the encrypted backup to recover from the public archive. Keep the backup and its passphrase: this is not seed-only recovery. A client persists the exact pending proof package before submission and resolves the same ID after a lost response.

A separate Docker image and volume are available:

```sh
# Set SHIELDED_API_TOKEN to a fresh lab token of at least 32 characters.
docker compose -f compose.noncustodial.yaml up --build
```

Use that token in the wallet. This never reuses the funded container or its volume. Do not fund the public test signing keys.

## Enforcement

The client owns spend/view secrets and its native withdrawal secret. The coordinator has public descriptors, trees, encrypted notes, nullifiers, receipts, and a write-ahead journal. Its public kernel cannot create a private spend from action metadata. Proving happens in the browser/client; only the proof package is submitted.

The operator emulator receives a versioned binary sidecar. Its transaction commitment is SHA256 of that exact sidecar. Each spending program is the fail-closed envelope `PUSH32 SHA256(original bound program) OP_RETURN`. The startup registry maps that full content hash to the original compiler-generated program. Unmodified emulators reject the envelope. Profiles and verification keys cannot be supplied through a transaction request.

The extension resolves the envelope after ordinary tapleaf/prevout checks. It runs the original program inside the same VM, with the same real transaction, input, prevout fetcher, signature context, per-input and aggregate compute budgets. There is no recursive program call or compute-budget reset. Registered programs cannot contain OP_RETURN or hidden expiry requests.

The sidecar carries public packets 0x80–0x82, the intent/transition witnesses (verification keys and Groth16 proofs), and old/new public state. Native packet 0x83 carries SHA256 of the new state, while the previous lane transaction carries the old state hash. The VM authenticates both before exposing the original 160-byte state packets to the existing covenant. Native asset allocations and outputs remain actual transaction data. The original proof, conservation, reserve, continuation and payout checks all execute before the emulator signs.

`tools/native-registry/apply.mjs` verifies exact upstream file hashes, copies pinned Go modules into ignored `.deps/native-registry`, and applies the small extension there. It does not alter the module cache, another repository, or the funded runtime. The separate binary is `shielded-registry-vm`.

## Validation and limits

The local lifecycle uses real Groth16 proofs and SDK transactions with synthetic genesis. It covers both assets, unsealed notes, client recovery, independent VM rejection of forged proofs and diverted effects, accepted-ID replay, final persistence interruption and restart completion without signing again. Complete signed transaction weight is checked against a hard maximum of min(configured limit, 4000 WU). The current lifecycle spans 2358–3532 WU; smaller operator limits fail closed.

The isolated Docker lifecycle can be reproduced with `npm run test:noncustodial:deployment`. It creates and removes its own synthetic container/volume, preserves user deployments, and writes sanitized evidence to `validation/noncustodial-deployment.json`. Deterministic note entropy is restricted to that standalone disposable fixture; the server and browser use operating-system randomness.

Important remaining boundaries:

- The registry/sidecar extension has not been deployed on Mutinynet. Live registry mode is deliberately rejected.
- The existing Groth16 artifacts use a single-party development setup. Real value requires a verified circuit-specific ceremony or a separately verified existing wrapper integration; this change does not solve that gate.
- Canonical spend ordering and double-spend rejection still require the Ark operator. A stateless emulator signature alone does not establish inclusion or an unspent output. Independent Ark/emulator liveness and the existing emulator trust model remain.
- The treasury fixture is synthetic; there is no external customer deposit rail in this slice.
- There is one serial native lane. Client proofs for unrelated notes can be generated concurrently, but stale public transitions must be rebased. Depth-8 note/history/nullifier structures are bounded and stop at capacity or a nullifier-slot collision; this is not a scalable production index.
- Individual holders still lack a unilateral pooled-BTC L1 exit. A withdrawal after proof verification is not an offline escape hatch.
- The two named lab slots are not a production identity or recipient discovery service. Verify initial peer descriptors independently. Clients freeze a known recipient directory and reject later substitutions, including after backup restoration.
- The browser must run an authentic wallet bundle. A malicious party serving modified wallet JavaScript could steal keys; independent client distribution is required for that adversary.
- Shielded-assisted restoration assumes user backups and archive availability. Wallets validate tree/log consistency, their fixed profile, and known history; production restoration also needs an independently obtained canonical Ark checkpoint.

The historical compact signature service remains available only as a legacy demo and is not evidence of these client-custody or independent-verification properties.
