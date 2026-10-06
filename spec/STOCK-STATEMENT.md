# Stock Shielded statement v1

This specification describes the new BTC-only profile under development. It is not the historical registered-verifier profile and must never replace a funded profile in place. The immutable verification key fixes domain 20260930001 and the complete Shielded relation. Native preparation publishes that key and commit proves a transition. The retained research policy includes an abort program. The fresh live policy proposal excludes its spend leaf: key publication is public and any valid client can complete the prepared phase. This policy change requires approval and a separately pinned fresh genesis.

## Canonical native binding

The public scalar is the little-endian integer represented by the first 31 bytes of SHA256 of the following 201 bytes. This 248-bit integer is below BN254 Fr and gives a generic collision bound of 124 bits. The descriptor explicitly pins `sha256-le-248`; changing this encoding requires a new profile and genesis. The VM constructs these bytes from actual transaction fields and authenticated parent packets. The scalar is not supplied in the transaction witness. All fixed-width integers are unsigned little-endian; transaction hashes use their wire byte order.

| Offset | Bytes | Source |
| --- | ---: | --- |
| 0 | 4 | Profile tag `53480100` |
| 4 | 1 | Operation: transfer 0, deposit 1, withdrawal 2, seal 3 |
| 5 | 36 | Current pool input checkpoint outpoint: 32-byte hash and 4-byte index |
| 41 | 32 | Authenticated parent state commitment, packet 0x87 |
| 73 | 32 | Successor state commitment, packet 0x87 |
| 105 | 8 | Actual pool input BTC value |
| 113 | 8 | Actual pool continuation BTC value |
| 121 | 8 | External funding input value, or zero if absent |
| 129 | 8 | External payout/change output value, or zero if absent |
| 137 | 32 | External P2TR witness program, or zero if absent |
| 169 | 32 | SHA256 of the raw native asset packet payload, or empty payload when absent |

A mode may be fixed by an authenticated immutable commit leaf or read from a checked transaction packet. It cannot be an unchecked coordinator assertion. Shape checks determine which inputs and outputs supply each field. All continuation outputs retain the identical pool Taproot policy. Extension and anchor outputs have zero BTC; additional outputs are rejected. For proved commits, zero auxiliary values follow from circuit-bound exact pool/funding/continuation/payout conservation together with ArkD conservation across every native output and nonnegative Bitcoin output amounts. The standalone signing Service is only one part of that enforcement; it does not establish ArkD admission.

The first profile forbids native asset packets and DEMO reserve changes. Token support needs its own proved asset identity and native allocation binding before activation. BTC genesis must start with zero note reserves and a 330-sat carrier, and wallets pin the accepted genesis outpoint and profile. A same-policy transaction supplied by an untrusted coordinator is not sufficient evidence of ancestry.

## Combined private relation

The state commitment is Poseidon9 of domain, note root, spent root, history root, note count, history count, revision, BTC reserve and DEMO reserve. The circuit constrains canonical field encodings, all state openings, revision advancement and actual pool values equal to 330 plus the BTC reserve. It retains Intent ownership, conservation and authenticated ciphertext constraints, with a stock-specific transition for note appends, historical anchors and collision-free nullifiers. One public scalar binds their native effects. Revision is an independent authenticated counter, advanced once per accepted operation.

Transfer and seal have one pool input and one continuation output. Withdrawal adds an exact P2TR payout and binds its program to the original intent destination. Deposit adds a customer-owned funding input. An exact-coin deposit has no native change: the full funding value becomes shielded notes. The implemented deposit consumes the whole selected coin and has no change-output variant. A sub-dust withdrawal combines the private claim with one customer-authorized native funding coin and pays their sum to the proved destination. Customer authorization must sign the complete native transaction and checkpoint; the coordinator receives no customer spending secret.

Seals use a valid private zero-value dummy Intent witness while the Transition retains its original zero intent fields. They require no pending user's liveness. Ordinary transitions are proved by the client after the exact prepared checkpoint identity is known. A stale state requires a new client proof. Unknown submitted outcomes are journaled and reconciled by exact identity before further writes.

## Nullifiers and bounded-pool recovery

The nullifier accumulator uses a depth-9 indexed Merkle tree with a sentinel at index zero. Each leaf commits to tag 20260930302, its full field-valued nullifier, and the next index/value in a sorted linked list. An insertion proves strict predecessor ordering, predecessor membership, its update, and an empty append slot. The spent-state commitment binds the inner tree root and count. Colliding low bits do not share a slot. The circuit uses canonical field decompositions and a bitwise comparison for full-width nullifiers.

Notes retain depth-8 demonstration capacity and two padded encrypted outputs per append operation. A full withdrawal with both outputs zero consumes its nullifier without appending records, so exhaustion of note capacity does not prevent cashing out a sealed note. Its padded zero-output ciphertext metadata is not committed by the unchanged note root and must not be treated as authenticated note records. Recovery uses only records appended to the verified note tree. Partial withdrawals still append their change. Seals require a nonempty note tree and a root different from the last sealed root, authenticated against the history tree; repeated seals cannot burn history capacity. This is a bounded pool, with one serial settlement lane and one input note per private intent.

## Acceptance gates

Every signed Ark transaction and every checkpoint must fit min(current operator limit, 4000 WU). A test with a substituted scalar or arithmetic-only relation cannot establish this profile's validity. Acceptance needs the full combined circuit, stock Service execution, rejection of mutated native fields and proofs, customer deposit/transfer/seal/withdrawal, archive restoration, restart/replay, and actual public Mutinynet admission. Existing local and funded historical results do not prove these gates. Public phase-1 ceremony reuse still requires circuit-specific Groth16 phase 2; isolated development keys are not a production ceremony.
