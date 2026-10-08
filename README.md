# Shielded

A private pool for Bitcoin and Arkade assets on Arkade. Inside the pool, value moves as notes: each spend is proved valid, but nobody learns who paid whom or how much. It runs on Mutinynet only.

## How it works

- The pool is one Arkade VTXO, the head, which holds a supply-1 pool token and a commitment to the pool state. Each listed asset has one reserve VTXO beside it (at most eight).
- A wallet owns notes in a depth-32 Poseidon tree. To spend, the browser proves a 1-input, 2-output spend with Groth16 and reveals only the note's nullifier.
- The operator collects up to eleven spends into a batch and proves the state update. The head's covenant checks every client proof and the batch proof with the Arkade emulator's BN254 opcodes before the pool moves.
- Deposits come from the depositor's Arkade coins, which they sign during a short round. Withdrawals pay an Arkade address and must be at least the 330-sat dust.
- Each output note is sealed to its recipient's view key (X25519 and AES-GCM) and published with its batch. A wallet restores from its recovery secret by scanning the published batches.
- A payment may spend up to three notes as one atomic group.
- Anyone can list an Arkade asset by sending one unit and 330 sats to the pool address; the operator turns it into that asset's reserve.
- The operator moves the head and reserves into a fresh Arkade round 48 hours before they expire.

## Layout

| Path | Contents |
| --- | --- |
| `src/server.ts` | The service: pool, `/api/rollup` and web app on one port |
| `src/rollup/` | Operator, batcher, covenant, prover, renewal, listings and HTTP API |
| `src/stock/` | Arkade network, indexer, journal and signature helpers |
| `packages/protocol/src/rollup/` | Notes, state tree, nullifiers, addresses and the wallet account |
| `app/` | Home page and wallet (`/wallet`) |
| `circuits/rollup/` | Spend and batch circuits |
| `tools/vm/` | Go bridge to the Arkade emulator, and the covenant builder (`-rollup-leaves`) |

## Run locally

Requires Node 24 and Go 1.26.6.

```sh
npm ci
npm run vm:build
npm run circom && npm run rollup:compile
npm run build
SHIELDED_DATA_DIR=.deps/data SHIELDED_ROLLUP_CIRCUITS=circuits/rollup/build HOST=127.0.0.1 npm run server
```

The first start generates development proving keys once. It needs at least 4 GiB of memory and downloads a 2^20 powers-of-tau file. Set `SHIELDED_ROLLUP_KEYS` to a directory of existing keys to skip it. Then fund the `fundingAddress` from `/api/rollup/status` with at least 2,000 sats to create the pool. The server listens on port 8792; `npm run app` serves the web app with hot reload and proxies `/api` to it.

## If the operator stops

The batch leaf accepts any valid batch, whoever proves it. Mirror the pool while it is up, then prove and submit your own withdrawal without it:

```sh
npm run fallback -- mirror https://shielded.mutinynet.arkade.sh ./pool-mirror
SHIELDED_PHRASE="your 24 words" npm run fallback -- withdraw ./pool-mirror 5000 tark1…
npm run fallback -- publish ./pool-mirror https://shielded.mutinynet.arkade.sh <batch>
```

`withdraw` replays the mirrored batches, checks they reach the head the indexer shows, and proves your spend plus ten zero-value spends and the batch. It then submits the batch to the Arkade emulator. `publish` hands its record to the operator, which checks it against the chain before following. Without the operator nobody can renew the pool head, so the payout expires when the head does; `withdraw` prints that deadline.

## Test

```sh
npm test
(cd tools/vm && go test ./...)
npm run test:rollup:witness
```

`npm test` needs the VM binary from `npm run vm:build`; the witness test needs the compiled circuits.

## Deploy

See [docs/DOKPLOY.md](docs/DOKPLOY.md). Read [SECURITY.md](SECURITY.md) first: this is unaudited test software.
