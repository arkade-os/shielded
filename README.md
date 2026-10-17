# Shielded

A private pool for Bitcoin and Arkade assets on Arkade. Inside the pool, value moves as notes: each spend is proved valid, but nobody learns who paid whom or how much. It runs on Mutinynet only.

## How it works

- The pool is one Arkade VTXO, the head, which holds a supply-1 pool token and a commitment to the pool state. Each listed asset has one reserve VTXO beside it (at most eight).
- A wallet owns notes in a depth-32 Poseidon tree. To spend, the browser proves a spend (one input note) or a join (two input notes), each with two outputs, with Groth16, and reveals only the spent notes' nullifiers.
- The operator collects up to eleven spends, or eleven joins, into a batch and proves the state update. A batch closes as soon as a spend is pending and no batch is in flight; spends that arrive meanwhile share the next. The head's covenant checks every client proof and the batch proof with the Arkade emulator's BN254 opcodes before the pool moves.
- Deposits come from the depositor's Arkade coins, which they sign during a short round. Withdrawals pay an Arkade address and must be at least the 330-sat dust.
- Each output note is sealed to its recipient's view key (X25519 and AES-GCM) and published with its batch. A wallet restores from its recovery secret by scanning the published batches.
- A payment spends one note, two notes in one join, or up to three notes as one atomic group. A wallet holding more than eight notes of an asset merges its two smallest in the background.
- One 24-word recovery phrase derives a spend key, a nullifier key and a view key. An address (`shrol2…`) carries the owner hash and the public view key. Two read-only keys can be shared: a view key (`shview2…`) shows the notes a wallet received, and a full viewing key (`shfvk2…`) also shows which of them were spent. Neither can spend or freeze a note.
- Anyone can list an Arkade asset by sending one unit and 330 sats to the pool address; the operator turns it into that asset's reserve.
- The operator moves the head and reserves into a fresh Arkade round 48 hours before they expire.

## Lightning privacy and recovery

The wallet requests Lightning quotes only after **Get quote**. That action shares the invoice or Lightning address and amount with its payment service. Sending funds the verified HTLC directly from one pool note, including the swap fee; ordinary Arkade coins are never added. Each send refund and receive invoice uses its own HD child key and payout address. Receive and refund payouts return to the pool one coin at a time, signed with that child's key.

A Lightning address remains a permanent alias. Its service receives only a dedicated public HD branch (`2/7`) and reserves a fresh child for every valid callback, including unpaid requests. The service can link those callbacks to the alias. Payers see the individual payout address. Direct swaps use a separate branch (`2/8`), with a durable counter shared across pools. Creating an alias requires the server's explicit HD acknowledgement; older servers fail closed. This depends on [lnurl-server #92](https://github.com/ArkLabsHQ/lnurl-server/pull/92).

Keep browser data while swaps or payouts are pending. The journal saves the exact pool submission before sending it, and keeps uncertain funds reserved across reloads; a timeout or missing status never frees them. Existing swaps retain their original recovery path, with new funding disabled. Rolling back the application must preserve the Lightning journal and swap repositories.

The recovery phrase derives all child keys, but does not reconstruct every direct swap or arbitrarily large unpaid index gap after browser storage is lost. **Recover a Lightning address** restores alias allocations from authenticated server history, including historical script settings. Outstanding direct swaps also require their stored recovery records. Alias history recovery contacts the service only after explicit enablement or recovery. Keep the page open to shield received payouts.

## Layout

| Path | Contents |
| --- | --- |
| `src/server.ts` | The service: pool, `/api/rollup` and web app on one port |
| `src/rollup/` | Operator, batcher, covenant, prover, renewal, listings and HTTP API |
| `src/stock/` | Arkade network, indexer, journal and signature helpers |
| `packages/protocol/src/rollup/` | Notes, state tree, nullifiers, addresses and the wallet account |
| `app/` | Home page and wallet (`/wallet`) |
| `circuits/rollup/` | Spend, join and batch circuits |
| `rollup-keys/` | The pinned manifest of each published proving-key set |
| `tools/vm/` | Go bridge to the Arkade emulator, and the covenant builder (`-rollup-leaves`) |

## Run locally

Requires Node 24 and Go 1.26.9.

```sh
npm ci
npm run vm:build
npm run build
node tools/fetch-rollup-keys.mjs rollup-keys/genesis-2.json https://github.com/arkade-os/shielded/releases/download/rollup-genesis-2-keys .deps/keys
SHIELDED_DATA_DIR=.deps/data SHIELDED_ROLLUP_KEYS=.deps/keys HOST=127.0.0.1 npm run server
```

`fetch-rollup-keys.mjs` keeps each downloaded file only if it matches the manifest pinned in the repo. Without `SHIELDED_ROLLUP_KEYS` the server generates its own development keys instead: that needs the compiled circuits (`npm run circom && npm run rollup:compile`, then `SHIELDED_ROLLUP_CIRCUITS=circuits/rollup/build`), 6 GiB of memory and a 1.2 GB powers-of-tau download. Then fund the `fundingAddress` from `/api/rollup/status` with at least 2,000 sats to create the pool. The server listens on port 8792; `npm run app` serves the web app with hot reload and proxies `/api` to it.

## Proving keys

The proving keys come from a two-phase Groth16 setup.

- **Phase 1** is the Hermez [Perpetual Powers of Tau](https://github.com/privacy-scaling-explorations/perpetualpowersoftau) transcript for 2^20 constraints, `powersOfTau28_hez_final_20.ptau`, pinned by its BLAKE2b-512 in `tools/rollup-setup.mjs`. It is shared with many other projects; nothing here re-runs it.
- **Phase 2** is specific to these circuits, so it had to be run for them. Its contributions, and the public Bitcoin block hash that seals them, are listed in `rollup-keys/genesis-2.json`. The keys are sound if at least one contributor discarded their randomness. The beacon only stops the last contributor from choosing the final key; it adds no secrecy. This is a small testnet ceremony, not a production one.

To check the published keys, compile the circuits (the build is deterministic) and verify each key against its circuit and the phase-1 transcript:

```sh
npm run circom && npm run rollup:compile
node tools/fetch-rollup-keys.mjs rollup-keys/genesis-2.json https://github.com/arkade-os/shielded/releases/download/rollup-genesis-2-keys .deps/keys
for c in spend join batch-spend batch-join; do npx snarkjs zkey verify circuits/rollup/build/$c.r1cs .deps/rollup-ceremony/powersOfTau28_hez_final_20.ptau .deps/keys/$c.zkey; done
```

Fetch the transcript first from `https://circom.info/powersOfTau28_hez_final_20.ptau` into `.deps/rollup-ceremony/`, and check that `b2sum` matches the `PTAU_BLAKE2B512` in `tools/rollup-setup.mjs`. `snarkjs zkey verify` prints every contribution hash and the beacon it finds in the key; they should match the manifest.

## If the operator stops

The batch leaf accepts any valid batch, whoever proves it. Mirror the pool while it is up, then prove and submit your own withdrawal without it:

```sh
npm run fallback -- mirror https://shielded.mutinynet.arkade.sh ./pool-mirror
SHIELDED_PHRASE="your 24 words" npm run fallback -- withdraw ./pool-mirror 5000 tark1…
npm run fallback -- publish ./pool-mirror https://shielded.mutinynet.arkade.sh <batch>
```

`withdraw` replays the mirrored batches, checks they reach the head the indexer shows, and proves your spend plus ten zero-value spends and the batch. It then submits the batch to the Arkade emulator. `publish` hands its record to the operator, which checks it against the chain before following. Without the operator nobody can renew the pool head, so the payout expires when the head does; `withdraw` prints that deadline, and the wallet shows it once the operator stops answering.

This path covers the pool operator stopping, not Arkade itself: the batch still needs the Arkade emulator and operator to accept it. If they are offline, the pool cannot move at all (see [SECURITY.md](SECURITY.md)).

## Test

```sh
npm test
(cd tools/vm && go test ./...)
npm run test:rollup:witness
```

`npm test` needs the VM binary from `npm run vm:build`; the witness test needs the compiled circuits.

## Deploy

See [docs/DOKPLOY.md](docs/DOKPLOY.md). Read [SECURITY.md](SECURITY.md) first: this is unaudited test software.
