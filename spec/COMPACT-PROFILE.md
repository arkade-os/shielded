# Compact verifier profile

This implementation moves the existing bounded PoC's Groth16 proofs, public
signals, encrypted note records, verification keys and verifier code off the
native transaction. It does not implement the recursive wallet protocol proposed
in [COMPACT-ARCHITECTURE.md](COMPACT-ARCHITECTURE.md).

## Transaction and verifier

The native transaction retains the actual BTC outputs, native asset packet,
checkpoint ancestry and signatures. Its application packet is exactly 133 bytes:

| Field | Bytes |
| --- | ---: |
| `SCMP`, version | 5 |
| Immutable verifier profile ID | 32 |
| Previous public state commitment | 32 |
| Successor public state commitment | 32 |
| Full sidecar and native transaction binding | 32 |

The binding hashes a domain tag and length-framed canonical encodings of both
the proof sidecar and transaction effects. Input outpoints, checkpoint IDs,
previous-output scripts and values, ordered outputs and native asset allocations
are covered. Proofs and ciphertexts remain in encrypted durable storage.

A server-owned registry pins the circuit verification keys, deployment domain,
signer keys, issued resource identities, checkpoint and exit policy, destinations
and validator source fingerprint. Source fingerprints normalize CRLF to LF so
Windows and Linux use the same profile. Resource scripts commit the profile ID;
they require the Arkade operator and dedicated verifier signatures.

Before signing, the verifier checks real Groth16 proofs, the authenticated current
state, the complete source-to-checkpoint-to-transaction chain, exact reserve and
payout effects, asset conservation and the packet binding. Successful signing is
not sufficient to advance state: the returned bodies and required signatures
must also verify. A verified signed response is journaled with the previous
heads before acceptance advances native state. The engine then atomically saves
the accepted receipt and successor heads before committing note state. Unknown
network outcomes freeze spending until authoritative reconciliation.

## Bootstrap response recovery

Bootstrap journals the exact `SubmitTx` request before contacting the operator.
It validates the operator-only response against the submitted body,
previous-output metadata, checkpoint leaves, and pinned operator signatures
before the SDK wallet signs the checkpoints. The validated signed response is
journaled before `FinalizeTx`. On restart, recovery first checks for indexed
acceptance; if absent, it queries the read-only pending-response endpoint using
the exact saved input outpoints and transaction ID. It never retries
`SubmitTx`; if no unique matching response is recoverable, bootstrap fails
closed and keeps the operation blocked.

The live indexer returns base64-encoded PSBTs, not raw transaction hex. These
provide transaction-body and output evidence, but Arkd strips operator signature
fields; an indexed PSBT is not a complete signed receipt. The fallback recovery
path can restore signature fields from a finalized witness only if the exact
matching signatures remain present and the expected leaf script and control
block match. Otherwise it fails closed. Full finalized-transaction recovery
without the saved journal has not been verified. Persist the full signed
operator response before `FinalizeTx`; the read-only pending-response endpoint
is the recovery path for an unfinalized response. Do not use raw-transaction
parsing for indexer PSBTs or infer acceptance from a transaction ID alone.

## Authority and limits

The dedicated verifier runs in this service. Bitcoin does not evaluate its
Groth16 proofs, and the public Mutinynet emulator does not accept this sidecar
protocol. A malicious verifier and Arkade operator can co-sign an invalid spend;
the profile hash is an identity commitment, not remote attestation.

The pooled resources also have a CSV recovery path controlled by the verifier
key. This key can recover an entire resource after its timelock. A shielded note
holder cannot use that path to independently recover their fraction of the pool.
Withdrawal creates an ordinary user VTXO with a user CSV exit. This distinction
is material: this is an experimental operator-backed pool, not a trustless
Bitcoin shielded rollup.

The showcase service also holds Alice and Bob's demo spending keys. Encrypted
persistence protects data at rest; it does not hide those keys or note contents
from the running service. A client-owned wallet and privacy from that service
require a separate protocol and implementation.

Bootstrap pre-funds a treasury gate. The showcase's shield action transfers
that backing into reserve vaults while creating a private note; it does not
consume an external customer's VTXO. Funding the deployment wallet and boarding
coins are treasury setup operations. A customer deposit rail is unimplemented.

The circuit remains bounded to one lane, depth-eight note/history trees and a
depth-eight nullifier dictionary that rejects index collisions. Internal payments
leave reserve vaults untouched. Seals do not require every user's participation;
accepted encrypted records and spent-state roots survive restart. This transport
change does not remove the existing capacity, liveness, refresh or exit limits.

Every submitted Ark transaction is checked against the smaller of the reported
operator limit and 4,000 WU. The latter is a conservative experiment target,
not a claim about mainnet policy. Actual signed main and checkpoint weights are
reported separately. Local emulator genesis and funding remain synthetic test
fixtures. Mutinynet received 300,000 test sats and the approved recovery funded
all four registered resource outputs. Read-only indexer validation confirmed
signed request/response, checkpoint and head evidence: gate 3,228 WU, lane
1,300 WU, BTC and token vaults 1,116 WU each; funding checkpoints are 696 WU.
The pool allocation is 200,000 sats and 10,000,000 DEMO.

Recovery stopped at ready restore because the original live adapter rehashes
a derived profile object including its old ID. The original profile still
recomputes exactly from its base configuration. A separate ready-only
orchestration adapter passed independent review, all 78 tests and a read-only restore of the funded volume; fingerprinted verifier
files, proving artifacts, signing keys and accepted resource outputs remain
unchanged. Readiness was durably restored with zero network submissions. Full funded payment lifecycle, UI and
same-volume restart/replay evidence are pending. The shared Bitcoin commitment
round used for boarding is an operator aggregate with a separate size.

The standalone recovery tool passed read-only preflight and post-apply validation on this checkpoint. It
is restricted to a clean treasury state with no boarding requests or receipts,
notes, reserves, activities, or protocol receipts. It validates signed request
and response data, checkpoint ancestry, source-asset provenance and conservation,
head allocation and wallet-owned change; it enforces the effective 4,000-WU
limit and journals before any new SubmitTx or FinalizeTx. Ambiguous outcomes fail
closed without retry. The human-approved apply funded the remaining outputs,
then stopped at final ready restore. The readiness-only apply subsequently changed only native.live.phase; original keys and the encrypted volume are preserved. Readiness may be persisted only
after a read-only restore passes using a separately reviewed orchestration
image with unchanged fingerprinted verifier files; that final step must make
zero network submissions.

The separately proposed normal-bootstrap source fix was not applied to this
registered profile. Do not install changed verifier/profile artifacts on the
funded service; future source changes require a fresh, unfunded profile unless
an independently reviewed migration is designed. The saved
`validation/compact-mutinynet-preflight.json` predates funding and is historical,
not current wallet evidence.

## Run

Use a fresh data directory for this profile. An existing inline checkpoint
cannot be reopened as compact:

```powershell
$env:SHIELDED_PROOF_TRANSPORT = 'compact'
$env:SHIELDED_NETWORK = 'local-emulator'
npm run server
```

For Compose, set `SHIELDED_PROOF_TRANSPORT=compact` and use a separate project
and volume. Mutinynet generates and stores its wallet and verifier keys before
exposing a funding address. Bootstrap issues real identities, registers their
profile, then funds its four resource scripts in separate, resumable
transactions. Each accepted head is authenticated and saved before the next
step. Fragmented funding still must pass the per-transaction weight preflight.
Use Mutinynet test coins only.

Fund either the displayed Ark address directly or the on-chain boarding address.
For the latter, wait for confirmation, sync, then use **Board confirmed funds**
before bootstrap. The authenticated boarding action journals its selected inputs
before joining an Ark round. An ambiguous result blocks a new boarding attempt
until the saved operation can be reconciled; sync alone does not spend coins.
Boarding receipts retain their request identities so retries return or reconcile
the original operation even when another deposit arrives after acceptance.
Legacy boarding journals without a request identity refuse new boarding or
reconciliation; no automatic migration assigns an old operation to a new key.

```powershell
$env:SHIELDED_SMOKE_TRANSPORT = 'compact'
npm run test:deployment
```

That smoke exercises the actual image, authenticated API, real proofs and
signatures, payments, withdrawals, adversarial rejection and encrypted restart.
It is local evidence; funded network evidence must be recorded separately.

To exercise an already running authenticated compact Mutinynet instance:

```powershell
$env:SHIELDED_API_TOKEN = '<your deployment token>'
$env:SHIELDED_SMOKE_URL = 'http://127.0.0.1:8787'
node --import tsx tools/compact-mutinynet-smoke.ts
```

The command submits real BTC and DEMO shield, seal, transfer and withdrawal
transactions, checks indexed ancestry and idempotency, and records sanitized
evidence in `validation/compact-mutinynet.json`. Add `--fund-from-faucet` to
explicitly request Mutinynet test coins for a fresh wallet. Add `--board-confirmed`
to board coins already confirmed at that wallet's on-chain boarding address.
Reuse the same
`SHIELDED_SMOKE_KEY_PREFIX` after interruption or restart to replay receipts
instead of creating duplicate actions.
