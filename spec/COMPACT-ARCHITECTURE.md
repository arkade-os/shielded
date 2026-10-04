# Compact shielded architecture

Status: proposed replacement design, not implemented or accepted. The tested
compact transport in [COMPACT-PROFILE.md](COMPACT-PROFILE.md) is an experimental
custodial transport that **fails the core goal**: users must not have to trust
Shielded with their keys, spend validity, or ability to exit. It is not the
replacement architecture and is not a completed Shielded design.

No replacement is ready until it demonstrates all four gates:

1. Spending keys and private coin state stay in client wallets.
2. Authorization and nullifier publication are canonical, publicly recoverable,
   and independently checked so a Shielded service cannot equivocate or suppress
   a spend unnoticed.
3. Funds cannot be spent contrary to the proof rules through a Shielded signer:
   enforcement must be independent of Shielded and bind the proof to the actual
   native effects. A proof checked only by Shielded offchain does not pass.
4. Each holder can recover their own funds while Shielded is offline, including
   a note still represented inside shared backing. A whole-pool timeout key or
   an exit available only after an ordinary withdrawal does not pass.

These gates are cumulative. A public log alone does not constrain a signer; a
sound proof alone does not establish backing; and a multi-party proving-key
ceremony does not provide enforcement or exits. Do not call the design
self-custodial, trust-minimized, or ready until the gates are implemented and
tested end to end.

## Decision

Replace the per-payment shared-pool transition with client-side validation:
wallets own their account/coin state and exchange encrypted proof-carrying coins;
publishers publish compact, authenticated nullifiers. Keep the native BTC/asset
bridge separate from ordinary payments. Use an immutable registered verifier
for the Arkade bridge rather than repeating its program and verification keys.

For an Arkade implementation, evaluate the explicitly sequenced publication-head
variant below first. It keeps fast acceptance under Arkade's stated enforcement
assumptions. Bitcoin publication is the comparison backend for an independently
ordered public log, with different fees and finality. They are separate protocol
profiles, not interchangeable receipts or an automatic outage fallback.

Treat 4,000 WU as an illustrative design gate, not an observed mainnet limit.
Split publication batches to whatever lower cap actually applies. Ordinary
payments must not carry verifier programs, keys, note ciphertexts, private paths,
or validity proofs in their publication transaction.

This is a protocol replacement, not a compressed version of the current wire
format. The current service stores the demonstration wallets' spending keys;
the replacement must put spending keys and proof state in each user's wallet.

## Measured problem

At commit `3b209c0`, `validation/e2e.json` records local-emulator transactions:

| Component | Bytes on an apply path |
| --- | ---: |
| Gate program | 8,447 |
| Lane program | 271 |
| Token-vault program, when needed | 311 |
| Two verification keys, including scalar length prefixes | 4,686 |
| Two Groth16 proofs, excluding prefixes | 512 |
| Public-signal packets | 1,152 |
| Successor state packet | 160 |

The code plus keys alone give `4 * (8,447 + 271 + 311 + 4,686) = 54,860 WU`.
The measured transfer is 62,866 WU; seal is 41,278 WU. These are local PoC
measurements, not funded Mutinynet observations.

`src/sdk/adapter.ts` puts the program and arguments into an OP_RETURN extension.
These are non-witness transaction bytes charged four WU each, despite arguments
being called an Arkade "witness." PSBT bytes and private circuit witness bytes
are separate measurements. Arkade transactions ordinarily travel offchain;
removing data here means removing it from the shared native transaction, not
claiming every current payment is broadcast to Bitcoin.

Compression of random curve points is not the main remedy. Groth16 is already
small. Switching to a larger STARK while retaining the current transport would
make that transport worse; moving proofs out of it changes the equation.

## Payment protocol

Use the published Shielded CSV account-state relation, including its account
initialization rule, authorization, spent-coin accumulator and reorganization
handling. Do not transplant a bare 32-byte note nullifier and assume it provides
the same authenticated 64-byte construction.

1. The sender's wallet builds a payment from its current account state and valid
   incoming coins. A zero-knowledge PCD proof establishes conservation,
   receiving authority, valid input histories, and the unique successor
   account state. Parent proofs are verified inside the recursive relation.
2. The sender creates the authorized account-state nullifier, with a
   sign-to-contract commitment to the complete payment. The first account
   nullifier key is determined by its account identity; it cannot be freely
   chosen to start multiple independent spending histories.
3. Any publisher can collect and half-aggregate nullifiers. The public data
   contains every nullifier record and the aggregate authentication overhead.
   Publishers cannot change an authorized payment or mint valid coins. They can
   delay, censor and reorder submitted records; first inclusion determines the
   winning spend. A user can bypass the preferred publisher with its own fee input.
4. The encrypted coin package reaches the recipient directly or through an
   encrypted delivery store. The recipient independently verifies its PCD proof
   and the relevant first-occurrence publication evidence against the canonical
   chain. It persists the verified package before treating the coin as received.

There is no all-user SEAL/proving barrier. Account updates serialize for that
account; unrelated accounts can prove concurrently. The Arkade variant serializes
publication batches at a small shared head, rather than running the full payment
proof in every native transaction. A recipient can receive multiple coins without
signing a global checkpoint. Unconfirmed dependent payments require explicit
conditional rules; they are not enabled merely by accepting a publisher receipt.

Implement one asset first. Supporting BTC and native assets together is a
separately specified extension: unique issuance identities, noncolliding asset
domains, per-asset conservation and matching bridge reserves must be constrained.
The published core relation alone does not implement that extension.

### Publication and finality

The independently ordered comparison backend is Bitcoin publication. It adds Bitcoin
fees and confirmation latency; this is a real tradeoff against Arkade's fast
preconfirmations. An Arkade fast receipt can be exposed as a provisional state,
but it cannot substitute for canonical publication or prove absence of a
conflicting spend. A separate Arkade ordering construction would need its own
equivocation, settlement and recovery proof before replacing this backend.

### Arkade publication head: proposed fast profile

Use one uniquely identified publication resource. A small continuation covenant
requires exactly one current-head input and one successor retaining the identity
and carrier amount. Bind domain/version, prior head outpoint, sequence, previous
log commitment, ordered batch hash and successor log commitment. Native refresh
must preserve this logical state. Complete bounded batch bytes remain retrievable;
all readers verify nullifier authorization and apply first-valid-occurrence rules.
Appending a record is not proof that a coin has valid ancestry or conserves value.

Any publisher can submit a candidate; progress requires an available accepting
operator and emulator. PCD work is parallel, publication is a serial batched
bottleneck. Publisher admission, fees, payload/work limits and refresh scheduling
must be measured rather than assuming batching removes denial of service.

This profile relies on operator non-equivocation and persistent conflicting-spend
rejection for provisional order. Two signed children of the same head cannot be
resolved by checking their ancestry: freeze on ambiguity and require authenticated
settlement/fork resolution. The current SDK does not implement that publication
log or prove it follows from its existing source-transaction validation.

Accepted head transactions are not automatically Bitcoin-anchored nullifiers.
Prove how canonical settlement binds the log, preserve all required data, and
define bridge/recipient acceptance against the appropriate finalized checkpoint
before using it for funded withdrawals. If an implementation instead trusts an
operator's signed head for withdrawals, state that trust explicitly.

The Bitcoin carrier sizes below exclude this new head covenant, identity packets,
state commitments and additional signers. Compile and measure those costs before
claiming an Arkade batch meets the same low cap. Keep a distinct domain when
switching publication backends; otherwise competing spends could win in each.

Shielded CSV's approximately 64 bytes is amortized protocol data per account
transition: `(nullifier public key, commitment nonce)` plus an aggregate scalar
and other batch overhead. It is neither a full Bitcoin transaction nor its
offchain coin proof. First implement the full authentication construction;
arithmetic using 64-byte records is not an implementation of it.

Keep nullifier data publicly recoverable. Publishing only one batch Merkle root
while keeping the nullifiers on the publisher's disk prevents independent
reconstruction and double-spend checks after withholding. Roots authenticate
data; they do not provide data availability. Proof compression removes history
from coin packages, not all growth from the public nullifier database.

An OP_RETURN carrier charges data four WU per byte. A Bitcoin witness carrier
can charge the data one WU per byte, but needs an actual publication construction,
commit/reveal lifecycle and acceptable relay policy. It is not a current Arkade
extension feature. Budget both transport overheads explicitly.

The local sizing fixture includes one P2TR fee input, a data output, P2TR change,
and a placeholder signature. Its illustrative batch framing adds 70 payload
bytes; its witness alternative additionally includes script and control-block
overhead. Serialization results, excluding policy and protocol verification:

| Account transitions | Payload bytes | OP_RETURN WU | Hypothetical witness WU |
| ---: | ---: | ---: | ---: |
| 1 | 134 | 1,028 | 694 |
| 8 | 582 | 2,832 | 1,146 |
| 16 | 1,094 | 4,880 | 1,662 |
| 64 | 4,166 | 17,168 | 4,758 |

Eight records fit the illustrative 4,000 WU gate in the OP_RETURN fixture;
sixteen do not. At 1,000 WU even one OP_RETURN record misses the gate. This
requires adapting batch size/carrier to the cap, not assuming a fixed low budget
will always suffice. The witness template has no committed valid funding output
or signature and is not a deployable publication transaction.

Weight and relay policy are separate gates. For a node configured with an
83-byte data-carrier script limit, even this fixture's single-record OP_RETURN
script is too large. Smaller batches cannot solve that case. Bitcoin Core 30
changed its default data-carrier policy, but miner/node configurations still
matter; choose and test an actual policy profile rather than assuming relay.

## Bridge: small transactions, explicit enforcement

Deposits identify an actual backing outpoint, asset, amount and pool domain.
They create issuance evidence exactly once. Internal CSV transfers carry this
valid issuance ancestry without consuming the backing on every payment.

A withdrawal is a terminal CSV transition bound to an exact payout destination,
asset, amount and fee. Its published burn must win the canonical spend order.
The bridge verifies the coin proof and publication evidence and atomically
records redemption while spending backing into a user VTXO and reserve change.
The redemption proof also binds reserve conservation, current reserve identity,
old/new redeemed-state commitments and every native output effect. Retrying a
withdrawal cannot pay twice. A signed balance or an indexer's assertion is not
this evidence.

Canonical publication is a verification input, not an arbitrary digest supplied
by a prover. An independently validated Bitcoin node and deterministic scanner
must establish transaction inclusion, first valid occurrence and the accumulator
checkpoint on its selected chain, with explicit confirmation and reorg rules.
Binding a checkpoint hash alone does not establish these facts. A header/SPV
alternative needs its own work, freshness and security assumptions; using only
the bridge's indexer instead introduces trust in that provider. Deposits also
need verified backing inclusion and issuance uniqueness, with reorg rollback.

For an Arkade-enforced bridge, add an immutable registered verification primitive:

```
profile_id = H(protocol version || circuit relation || VK || verifier encoding)
effect_digest = H(domain || backing inputs || payout outputs || fees
                  || canonical publication checkpoint || redemption transition)
bridge_envelope = profile_id[32] || old_state_commitment[32]
                  || new_state_commitment[32] || effect_digest[32]
                  || Groth16_proof[256]
```

The proposed envelope is 384 bytes, or 1,536 WU if carried as non-witness data,
before native framing, asset packets, signatures and a compact program.
This is a design budget, not a measured working Arkade verifier. The boundary
circuit must verify the recursive coin proof and the complete redemption
relation; the existing two PoC proofs cannot simply be renamed into one proof.

Registry entries are content-addressed and immutable. Pin the profile in the
locking program, reject unknown versions, recompute its identifier from loaded
artifacts, enforce point/scalar validation and compute budgets, and retain the
artifacts for old outputs. Cache misses can deny service but cannot select a new
VK. A hash on the transaction does not prove a verification happened.

Current deployed emulator APIs require inline programs and arguments. They do
not provide this registry primitive or an offchain-proof sidecar endpoint.
This route requires emulator/SDK integration; it is not a configuration switch.
The emulator checks extended opcodes and signs; Bitcoin does not execute those
pairing checks. Preserve that existing enforcement assumption explicitly.

The experimental compact profile implements this sidecar pattern: its verifier
checks the proof offchain and signs the native transaction. This saves proof
bytes, but the ordinary Ark operator does not independently enforce the proof;
a malicious Shielded verifier can seek a native-valid co-signature for an
invalid Shielded spend without operator collusion. It therefore fails gate 3
above. It is measured PoC evidence only, not a selected or acceptable
replacement architecture. Do not treat a smaller transaction or successful
ceremony as resolving that failure.

### Exit and backing lifecycle

CSV solves private payment validity and ordering; it does not create a BTC peg.
For a still-shielded share of pooled BTC, current Bitcoin Script cannot directly
enforce the above bridge relation. A federation changes the trust model; a
BitVM-style bridge has separate challenge, liquidity, data and liveness
requirements. Neither is a finished exit solution in this repository.

An ordinary user VTXO already issued by a withdrawal has its own exit package.
A fractional claim on a shared vault does not inherit that package. A timeout
paying the whole reserve to one administrator or an original depositor is unsafe
after private transfers. Require a demonstrable holder-specific recovery path,
including the latest state, before calling the replacement self-custodial BTC.
Backing outpoints, refresh history and expiry remain tracked independently of
coin proofs. No redesign makes expiring VTXOs permanent.

## Proof and data choices

Prototype recursive proof-carrying data for coin histories; recursive STARKs are
a candidate because the proof stays offchain. Measure real proving memory/time,
recipient verification and package size before choosing a library. Folding/IPA
is another candidate, but sequential IVC is not automatically multi-parent PCD,
and folding needs a sound final decider and zero-knowledge construction.
Retain Groth16 as a possible compact boundary wrapper, with a production setup
and a pinned relation; no need to force the wallet and bridge to use one system.

Wallets retain spending secrets, current account state/proof, unspent coin proofs
and address randomness. A seed alone cannot reconstruct unpublished data.
Encrypt and back up this bundle. Offline delivery requires durable replicas and
later verified retrieval; an upload acknowledgment is not a recovery guarantee.
Metadata privacy needs a separate delivery design. Losing all copies can lose
funds even when nullifier publication remains available.

Public nullifier storage still grows with transitions. At 64 bytes per record,
one million transitions require roughly 64 MB before framing, indexes and
replication. Recursive proofs keep an individual coin's history proof bounded;
they do not make scanning, indexing or proving free. Admission fees, payload and
verification-work bounds are needed against denial of service.

## Next implementation gates

1. Run `python tools/compact-budget.py` to size illustrative carriers under a
   chosen low cap. Verify complete transaction framing, not just proof bytes.
2. Implement the account-state relation and recursive verification. Verify
   conservation, unauthorized use, two initial account histories, conflicting
   spends, altered commitments and invalid ancestor proofs all fail.
3. Implement canonical publication and private delivery. Verify publisher outage,
   withheld records, reorgs, offline recipients and encrypted backup restoration.
4. Implement and execute the pinned bridge verifier. Verify replay, stale reserve,
   double redemption, substituted VK, wrong payout and native asset conservation.
5. Demonstrate holder recovery with shield operator and emulator unavailable,
   including reserve expiry, before claiming operator-independent exits or
   production self-custody. A bounded testnet bridge can exercise the earlier
   gates under its explicitly stated trusted-enforcement assumptions.

The sizing fixture uses placeholder signatures/proofs and performs no chain
submission or cryptographic verification. Passing its byte budget is only the
first gate. Existing PoC CI tests and preflight must stay intact.

## Primary sources

- [Shielded CSV paper](https://eprint.iacr.org/2025/068.pdf), account-state
  construction, PCD, publication, wallet state, and bridging requirements.
- [Authors' protocol code](https://github.com/ShieldedCSV/ShieldedCSV), compliance
  predicate and node components; not an assumption of a finished PCD backend.
- [Arkade emulator](https://github.com/arkade-os/emulator), inline packet format
  and execute-before-cosign semantics.
- [Nova](https://github.com/microsoft/Nova), folding-based IVC research and code;
  not a complete CSV protocol by itself.
- [Bitcoin Core 30 release notes](https://bitcoincore.org/en/releases/30.0/),
  data-carrier relay policy changes, independent of transaction weight.
