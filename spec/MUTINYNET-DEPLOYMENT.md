# Mutinynet deployment preparation

The current public wallet is an unfunded local lab with client-owned keys and independently verified Groth16 proofs. This kit prepares a separate registered-verifier service. It does not enable a customer-funded live pool or change the preserved funded deployment.

Read-only inspection on 2026-10-04 found `mutinynet.arkade.sh` reporting Mutinynet and a 40000 WU operator limit. `emulator.mutinynet.arkade.sh` reported `v0.0.9-rc.0` and no registered-program protocol, hash, program list or sidecar cap. The experimental transaction cap remains `min(operator limit, 4000 WU)`; an advertised larger limit never raises it. Check capabilities again before any deployment or funding.

## Build and install the verifier

```sh
npm ci
npm run registry:build
npm run test:registry
docker build -f Dockerfile.registry-server -t shielded-registry:local .
```

The build verifies pinned upstream file hashes and applies the extension only inside ignored `.deps/native-registry`. Its original VM, transaction context, signature checks and compute limits remain in force. The runtime image includes no signing keys or public demo fixture.

The Arkade operator must authorize the emulator signer for the new deployment. Mount that signer secret, an API bearer-token file and an exact immutable public registry JSON. Public program IDs are SHA256 of their original bound bytecode; the registry hash is SHA256 of compact JSON with ASCII-sorted program IDs. Programs bind the new pool's exact domain, verification keys and native asset identities. A local synthetic registry is not a funded network deployment manifest.

Use `registry.env.example` for public configuration and secret file paths. Keep secret contents outside Git and readable only to the service UID. Start a new service with:

```sh
docker compose --env-file /path/to/operator-registry.env -f compose.registry.yaml up --build
```

Compose publishes only loopback port 8790. Put a remotely reachable endpoint behind a TLS reverse proxy with request rate and body limits. The process requires a bearer token off loopback, caps request/sidecar sizes and obtains previous transaction bodies only from the configured trusted HTTPS Ark indexer. It replaces submitted previous-transaction metadata before executing the VM. Do not expose indexer credentials or signer secrets through the public wallet.

`GET /v1/info` returns protocol, exact compressed signer key, registry hash, sorted registered program IDs and sidecar limit. `POST /v1/tx` accepts canonical base64 Ark/checkpoint PSBTs and a registry sidecar. Its signed response is **emulator approval**. The Ark operator must separately admit/finalize the transaction and establish canonical ordering and unspent status.

`src/sdk/registry-provider.ts` pins the signer, original bytecode and registry hash; validates the exact sidecar-to-input binding and response signatures; and performs no automatic POST retries. An unknown signing or Ark submission outcome must be journaled and reconciled using the original transaction ID, never resubmitted with a new request. The registered transport is not yet wired into the live wallet runtime. Its remote bearer-token transmission is disabled pending destination-specific authorization; the server requires a token for non-loopback requests. The current unauthenticated client integration tests use only explicit loopback fixtures.

## Read-only readiness

Prepare a public pin JSON containing `arkUrl`, `emulatorUrl`, compressed `arkSignerPubkey`, compressed `emulatorSignerPubkey`, x-only `operatorSignerPubkey`, `registryHash`, `registryPrograms`, `requiredMaxTxWeight` and `requiredMaxSidecarBytes`. Use exact verified deployment values and original program bytecode; do not include secrets. Then:

```sh
npm run mutinynet:readiness -- /path/to/public-pins.json
```

This command reads capabilities only. It does not open a wallet, create a pool, issue assets, board funds or submit a transaction. It fails closed for unsupported capabilities or mismatched pins. It reports intrinsic implementation blockers even if the transport is compatible. Passing a capability check is not funded lifecycle evidence.

## Required live gates

- Operator installation of the registered extension and acceptance of the pinned signer.
- A new network-bound pool manifest, immutable registry and reviewed Groth16 setup. Current keys use a single-party development ceremony.
- Registered transport connected to real Ark submission/finalization with durable reconciliation of every unknown outcome.
- An actual customer-funded deposit rail and client-authorized withdrawal path; a synthetic treasury credit is not a deposit.
- Independently authenticated latest Ark checkpoint for fresh wallet recovery, with retained master secret and operator archive availability.
- Larger note/nullifier structures before general public use. The current depth-8 profile has finite capacity and nullifier-slot collisions.
- A deliberate availability/exit model: individual holders currently have no unilateral pooled-BTC L1 exit if the operator disappears.
- Authentic independent wallet distribution, then funded BTC/DEMO lifecycle and same-volume restart/replay verification on the exact deployed software, keys and proving artifacts.

Keep the old funded container, encrypted volume and verifier profile frozen. None of these commands migrate it or authorize funding the public fixture keys.
