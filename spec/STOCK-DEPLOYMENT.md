# Stock-opcode deployment

The new BTC profile uses the existing public Arkade operator and emulator. The Shield coordinator stores encrypted public state and coordinates transactions; it holds no customer spending, viewing or native key and cannot approve a private transition. Users prove the combined Shielded relation. The existing emulator executes the immutable Groth16 verifier using stock BN254 opcodes before signing. Native transaction fields, pool ancestry and recipient program are part of that proof statement.

This is a bounded test-network profile. It has 256 encrypted note records, 511 usable indexed nullifiers, a revision limit of 1023, one input note per private intent and one serial pool settlement lane. It supports BTC. The historical DEMO/registered-verifier deployment is a different profile and stays separate. The proposed fresh pool has six platform multisig leaves (prepare, deposit, transfer, withdraw, funded withdraw and seal) and three proof-program-bound CSV leaves (prepare and both withdrawal shapes). The proposal excludes the abort leaf: published verifier keys are public and do not reserve a prepared phase for one client. Any valid client can complete the phase. An abort leaf would allow arbitrary callers to cancel it repeatedly. The final native policy requires all-path proof execution and weight qualification before genesis funding. The abort program and earlier ten-leaf research tests remain available.

## Build and verify

Use Node 24 and the Go version pinned by the existing workflow. The native Circom compiler and reused public phase-1 transcript are checksum pinned.

```
npm ci
npm run stock:tools
npm run stock:compile
npm run test:stock:witness
npm run stock:setup -- --development-only
npm run vm:build
npm run test:stock:lifecycle
npm run test:stock:baseline-ten
npm run stock:qualify -- --local-only
npm test
npm run build
```

Development setup is circuit-specific, single-party Groth16 phase 2. Reusing the public phase-1 ceremony does not make it a production ceremony. Production requires a reviewed circuit and verified multi-party phase-2 contributions. New circuit, key, native policy or backend means a new profile and genesis. Never replace them in a funded pool.

The retained ten-leaf baseline can be reproduced with `npm run test:stock:baseline-ten`. It validates main settlement operations, recovery and replay using the full combined circuit and stock signing Service, with synthetic native parents. CSV exit leaves are present in its policy tree but are not executed by that lifecycle, and its evidence is not public deployment weight acceptance. The fresh-policy lifecycle executes the nine-leaf policy; all three delayed leaf shapes require a separate all-path qualification gate.

The lifecycle gate uses actual combined proofs and the real stock emulator Service with synthetic native parents. It must verify every signed Ark transaction and checkpoint against the 4000-WU ceiling. Passing it establishes a local lifecycle, not public Arkade admission, Bitcoin settlement or funded Mutinynet success. Those are separate gates.

Before live genesis, run `npm run stock:qualify` to bind all nine local native executions and signed weight projections to the current public signer keys, checkpoint, verifier, artifacts and pool tree. Supply its `validation/stock-profile-qualification.json` to bootstrap with `--weight-evidence`. The three CSV paths execute through the pinned stock emulator Bitcoin API with synthetic prevouts; this does not prove a confirmed, matured Bitcoin exit. The bootstrap gate labels public funded admission unverified and never accepts it as an inferred result of local execution.

## Immutable release

A release directory contains `deployment.json`, `stock-combined.manifest.json`, `stock-combined.vkey.json`, `stock-combined.zkey` and `stock-combined_js/stock-combined.wasm`. The deployment binds the accepted genesis transaction, native programs, signer keys, checkpoint policy and all proving artifact hashes. Publish its canonical release fingerprint through an independently verified software release. Wallets require that fingerprint before trusting the operator API; matching a server-supplied key to a server-supplied manifest alone is insufficient.

```
SHIELDED_STOCK_RELEASE_DIR=<absolute immutable release directory>
SHIELDED_STOCK_RELEASE_FINGERPRINT=<verified release fingerprint>
SHIELDED_STOCK_ALLOW_DEV_SETUP=true
docker compose -f compose.stock.yaml up --build -d
```

The development opt-in applies only to this test-network profile. The container runs without root privileges, mounts the release read-only and stores encrypted coordinator state in a dedicated volume. It exposes the wallet on loopback port 8792 at `/stock-wallet`. A separately configured public HTTPS origin is needed for public use. Build and startup do not create or fund genesis.

Startup checks the public network, signer keys, current checkpoint policy, fee assumptions and accepted genesis against the indexer. Before submission it checks the exact original inputs. Changed, spent, expired, swept or unrolled inputs fail closed. The first profile requires zero operator fees and uses the lower of the advertised operator limit and 4000 WU.

## Wallet and recovery

Customer wallets derive their spending, viewing and native keys from a locally stored recovery secret. The coordinator receives signed public registrations and encrypted note records. Deposits consume one exact whole customer Ark VTXO. Transfers and withdrawals are proved in the client. A withdrawal below native dust requires its exact customer funding coin and authorization for that coin.

Sealing is a public proved operation and does not require every pending user to stay online. A user who disconnects keeps their encrypted backup and can recover encrypted notes using their recovery secret and the authenticated archive.

Wallet recovery replays the complete proof and signed native transaction history from the pinned genesis, checks recipient signatures and consults the public indexer. It rejects changed artifact pins, forged states and rollback past the wallet's last verified head. An exact pending request is cleared only when its prepared statement and proof appear in that verified history.

The coordinator persists the exact native request before transmission and its verified receipt before applying local state. A lost response freezes writes. Restart performs read-only reconciliation of that same identity; it does not select a later coin or resubmit an unknown outcome. Preserve the exact release, keys and encrypted volume for restart verification.

## Remaining platform boundary

The Shield coordinator is outside the spending trust boundary. The public Arkade platform remains inside the native covenant execution boundary: Bitcoin does not execute BN254 pairing verification itself. Users need platform availability for proof-checked pool settlement. A CSV closure must remain tied to the proof program; a Shield-owned recovery key would violate the design.

Independent pooled exits during platform outage, durable pool renewal across Ark expiry, unbounded operation and mainnet readiness are separate unresolved requirements. Do not describe a local test, a green CI run or a built image as evidence that those requirements have been met.

Data availability remains a protocol assumption. Clients retain their sidecars and submit them through the coordinator, which persists them before broadcasting. A valid Groth16 proof and native transaction alone do not publish the encrypted records and spent nullifiers needed to replay the pool. With those deltas and an authenticated starting checkpoint, Merkle paths and state openings can be recomputed. A direct valid transition that withholds its sidecar can freeze other users. The current coordinator also stops on a foreign native prepare and does not adopt that head automatically. Recovery from such transitions and enforcement of sidecar availability remain unresolved for adversarial public use.

A separate data-publication transaction is a candidate for a future fresh profile, not a completed mitigation. It must bind the published records and nullifier to the proved transition, remain within the weight cap, and support authenticated discovery of foreign native heads. It must also prevent an arbitrary publisher from locking the shared pool to data for which no valid transition exists. Generating a proof in an honest wallet before publication does not enforce that requirement against a malicious publisher. A proofless pending-state lock without an independently safe recovery path is insufficient.

## Dokploy test deployment

Use Docker Compose with the private repository branch `main` and Compose path `./compose.stock.yaml`. Copy `stock.env.example` into Dokploy Environment and replace both release placeholders with the separately accepted immutable release. Dokploy can keep the release under its managed `../files` directory, outside the Git checkout. The Compose build passes the release fingerprint to the wallet as `VITE_STOCK_RELEASE_FINGERPRINT`; it is public and must also be distributed through an independently trusted release channel.

In Domains select service `shielded-stock`, container port `8792`, path `/`, and HTTPS. The wallet is served at `/stock-wallet`; `/health` checks the HTTP service. Preserve the named `/data` volume and its `.key`, and keep one writer. Deployments stop the previous writer before starting its replacement. Keep the software image fixed during the funded restart acceptance run, and never regenerate or overwrite a funded release from a CD build.

Dokploy push auto-deploy does not wait for GitHub Actions. For CI-gated CD, disable that trigger and have a successful workflow call `POST /api/compose.deploy` with the Compose ID and a Dokploy API key stored in GitHub Secrets. Dokploy configuration and the live release mount must be verified on the deployment host; a successful image build alone does not establish public acceptance.
