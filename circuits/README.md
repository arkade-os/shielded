# Bounded cryptographic demonstration profile

These are genuine Circom relations compiled to Groth16/BN254, rather than a proof over an arbitrary supplied digest. The app verifies both the private intent and public state transition. Native covenants separately authenticate the real consumed resources, successors, reserve changes and withdrawal destination against these public fields.

`intent.circom` consumes one real note or a zero-value deposit placeholder, and creates exactly two encrypted note records. It enforces:

- Poseidon ownership commitment from the spending secret, private depth-8 membership, and the stable nullifier `Poseidon(domain, spendingSecret, noteRho)`.
- Separate BTC/demo-token conservation over bounded 48-bit integers. The asset selector is a constrained Boolean.
- Each output commitment binds domain, amount, asset, spending-owner hash and note randomness.
- Output randomness is derived from private randomness plus the authorized public destination and nonce. Changing a destination or nonce invalidates the existing proof; neither enters the stable nullifier.
- BabyJub ephemeral ECDH and Poseidon field encryption, including an authentication tag, are constrained inside the circuit. The recipient view key remains private. The public ephemeral point and four ciphertext fields are part of the proved record. The circuit proves recipient prime-order subgroup membership using a private curve point Q with recipient = 8Q, and requires a canonical nonzero ephemeral scalar smaller than the subgroup order. Wallets also check recipient keys before proving and encrypted ephemeral keys during recovery.

This field encryption construction is an experimental PoC profile, not an audited deployment encryption suite. The circuit checks curve membership for the cofactor preimage and all three doubling steps, and rejects identity recipient keys. A recipient public key remains private to the intent relation; its matching spending-owner identity is supplied by the recipient address profile.

`transition.circom` enforces zero-to-record sequential appends, current zero-to-nullifier dictionary insertion, accepted-anchor membership and seal history insertion. Tree leaves authenticate **both the note commitment and its full ciphertext**: `Poseidon(commitment, seven ciphertext fields)`. SEAL preserves note/nullifier roots and counters and appends a domain-separated note root to history. New notes cannot be spent before a seal. Old anchors remain usable while current nullifiers prevent replay.

All three trees have depth 8 and capacity 256. The nullifier slot uses the low 8 bits of a canonical field element. Occupied slot collisions are rejected, so useful capacity can be substantially less than 256; this is an explicit bounded demonstration limitation. Do not silently overwrite or delete nullifiers. A deployment needs a scalable dictionary and a larger or segmented note tree.

## Public fields

Intent has 25 canonical field inputs:

| Index | Meaning |
|---|---|
| 0 | Deployment domain |
| 1 | Accepted anchor; zero for deposits |
| 2 | Stable nullifier; zero for deposits |
| 3–4 | Two note commitments |
| 5–11 | First ciphertext: ephemeral x/y, encrypted amount/asset/owner/rho, tag |
| 12–18 | Second ciphertext, same shape |
| 19–20 | Native deposits, BTC then demo token |
| 21–22 | Native withdrawals, BTC then demo token |
| 23 | Withdrawal destination: SHA-256 of exact 32-byte Taproot witness program, decoded little endian and reduced modulo Fr |
| 24 | Authorization nonce |

Transition has 30 canonical field inputs. Indices 0–18 equal the corresponding intent fields. The remaining fields are:

| Index | Meaning |
|---|---|
| 19 | Operation: 0 APPLY, 1 SEAL |
| 20–21 | Old/new note root |
| 22–23 | Old/new spent root |
| 24–25 | Old/new accepted-anchor history root |
| 26–27 | Old/new note count |
| 28–29 | Old/new history count |

SEAL supplies zero intent fields except the deployment domain and requires no private intent proof. Public values are represented as canonical 32-byte little-endian field elements in packets and decimal strings in the host API.

## Build

From the repository root:

```sh
node circuits/setup-proofs.mjs
node --import tsx circuits/smoke.ts
```

The optimized relations have 15,121 intent constraints and 19,432 transition constraints. Setup generates fresh random phase-one and per-circuit phase-two contributions without printing their entropy. This is a **local single-party experimental setup**, not a reviewed multi-party ceremony. Demo wallets deliberately derive their keys from public fixed labels; they cannot secure real funds.

The PoC binds settlement freshness to actual authenticated consumed state roots and counters through native covenants. It does not hash a complete transaction/outpoint manifest inside the circuit. That is a deliberate narrower profile than the full design's native effect transcript.
