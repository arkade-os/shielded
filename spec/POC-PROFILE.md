# Executable proof-of-concept profile

The executable app is a separate bounded profile of the broader protocol design.
Its `.ark` contracts live in `contracts/poc/`; the earlier multi-lane scaffold
remains fail-closed and is not used by the demo.

The acceptance flow is **shield → seal → private transfer → seal → withdraw**,
for BTC and one ordinary transferable demonstration token. Transfers update a
single note/spent-state lane and do not consume a reserve vault. Boundary
operations consume a reserve vault and enforce exact native value and token
deltas. There is no recursive batching or fee market in this profile.

## Proof and execution boundary

The wallet relation consumes one private note and creates two encrypted output
records. It constrains ownership, membership, a stable nullifier, bounded
per-asset conservation, and the actual ciphertext construction. The public
transition relation appends the authorized encrypted records, checks current
spent-state absence, and authenticates an accepted sealed anchor.

The covenant jointly binds those proof signals to authenticated previous state,
resource identities, successor programs, reserve movements, and the exact payout
program. Unlike the research scaffold's blanket native-IO transcript, this
bounded profile binds these effects directly through transaction introspection.
The wallet proof does not name current native outpoints.

Compiler artifacts are imported with `programFromArtifact`; SDK Programs supply
locking scripts and the witness ABI. The SDK builds Ark transactions, checkpoint
transactions, Emulator Packets, native asset packets, and previous-transaction
attachments. The actual emulator `Service.SubmitTx` executes and co-signs these
transactions with its default compute limits. Native asset validation is a
separate prerequisite to script execution.

## Bounded state

- One lane; one input note and two output records per intent.
- Depth-eight note and anchor trees: at most 256 records / seals.
- A depth-eight nullifier dictionary indexed by low nullifier bits. A collision
  is rejected; this is a capacity limitation, not a collision-resolution design.
- Amounts are unsigned 48-bit integers. Each asset is conserved independently.
- New notes become spendable after a seal. Seals preserve all nullifiers.
- Historical anchors and encrypted records are retained by the local harness.

## What the showcase demonstrates

This is local execution with a synthetic genesis and demonstration funding. It
does not run an arkd/Bitcoin settlement stack. Emulator signatures are not
Bitcoin confirmations. Demo wallets and proof generation share the local Node
process; the emulator receives public fields and proofs, not wallet secrets.
The observer toggle is a presentation filter, not an API permission boundary.

Setup keys and deterministic signing fixtures are for testing. Do not fund
their programs. The profile does not establish production cryptographic review,
durable data availability, refresh before expiry, emergency fractional reserve
exits, or an emulator-independent L1 redemption path.

The browser displays actual execution results, proof timings, compiled source,
Program instances, encrypted records, and native transactions. Missing artifacts
or rejected verification leave the app visibly unavailable or rejected; they are
not replaced with a successful mock response.
