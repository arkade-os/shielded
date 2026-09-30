# Executable one-lane covenant profile

These contracts are the executable proof-of-concept profile. The earlier contracts in the parent directory remain separate and fail closed.

`npm run compile` runs the pinned `arkadec`, emits five JSON artifacts, and loads every artifact through `arkade.programFromArtifact`. The application then instantiates each `Program` through the SDK. No application code assembles these covenant scripts by hand.

| Artifact | Responsibility |
| --- | --- |
| `poc_gate.json` | Verify the private intent and current state transition; authenticate the lane; enforce the exact native boundary effects |
| `poc_lane.json` | Authenticate the actual verifier lock and execution closure; preserve the singleton lane identity and native carrier |
| `poc_btc_vault.json` | Authenticate the verifier and preserve the reserve identity |
| `poc_token_vault.json` | Authenticate the verifier and preserve the reserve identity, program, and native carrier |
| `poc_recipient.json` | Ordinary holder-controlled native payout, including a CSV leaf |

## Canonical transaction shape

Input 0 is a verifier/funding VTXO. Input 1 is the unique lane. A boundary consumes its selected reserve as input 2. Each resource continues at the output with the same index. A withdrawal creates output 3. The SDK then appends the extension and zero-value P2A anchor.

The gate checks every permitted value and allocation. A deposit reduces preloaded verifier funding and increases the selected reserve by the authorized amount. An unshield decreases that reserve and creates the exact payout; token payouts receive a fixed 330-satoshi native carrier funded by the verifier. Transfers and seals preserve the verifier and lane native holdings. This profile has no fee extraction and handles one boundary asset and direction per operation.

Resource singleton assets originate in a separate issuance transaction. The SDK adapter reverses the canonical asset ID transaction bytes when binding covenant constructor operands because the VM lookup consumes internal `chainhash` byte order; serialized native asset packet IDs retain their canonical SDK encoding. Input allocation quantities must be authenticated against the actual creating transaction by the SDK adapter and local emulator bridge before covenant execution. Arithmetic over witness-declared allocations is insufficient.

## Packets and proof statements

All public fields use canonical unsigned little-endian 32-byte encodings below the BN254 scalar modulus. Packet sizes are below the VM's 520-byte item limit.

| Packet | Content | Bytes |
| --- | --- | ---: |
| `0x80` | Intent fields 0–12 | 416 |
| `0x81` | Intent fields 13–24 | 384 |
| `0x82` | Operation plus six old/new roots and four old/new counters | 352 |
| `0x83` | Current lane note root, spent root, history root, note count, history count | 160 |

The private intent proof has 25 public fields. The transition proof has 30: intent fields 0–18 followed by the 11 fields from `0x82`. The gate uses an internal 36-field view to enforce both relations and the boundary fields. It reads the previous state directly from the authentic lane's creating transaction packet and compares every field to the old-state statement; the new packet is compared to the successor statement.

A checkpoint outpoint has a different `vout` from the original VTXO. This one-lane profile uses one state record, so it does not incorrectly index the original packet with a checkpoint output index.

`apply` verifies both proofs. `seal` verifies only the transition proof and requires a zero user-intent body. Followers authenticate both the actual leader witness program and its selected Arkade closure. All leader paths verify their required proof; followers cannot point to an alternative unverified branch.

## Verification keys and limits

The immutable gate constructor pins SHA-256 commitments to the two verification keys. Spend-time key coordinates are authenticated against those commitments before use. Moving the coordinates into the covenant witness keeps the script within the VM's 10,000-byte ceiling.

For each key, start with `SHA256(UTF8("ArkShieldPocVk:Intent:v1"))` or the corresponding `Transition` tag. Roll `SHA256(previousDigest || uintLE32(coordinate))` over this order:

1. `alpha.x`, `alpha.y`.
2. `betaNeg`, `gammaNeg`, `deltaNeg`, each in `xc1`, `xc0`, `yc1`, `yc0` order.
3. Every `icX`, then every `icY`, including index zero.

Deployment folds the fixed domain contribution into the accumulator: `IC0' = IC0 + domain * IC1`. The gate independently requires the proof's public domain to equal its immutable deployment domain, so the verifier can skip that one fixed public scalar. Zero scalars are also skipped. The ordinary off-chain verifier still uses the original verification keys. This fixed-domain projection keeps the worst supported apply within the default 50 ECMUL operations; apply uses two pairing-product calls and seal uses one.

Each pairing product uses the compiler's `ecPairingProduct` intrinsic with four terms. Key and proof G2 coordinates use `c1` before `c0`, and the equation is `e(A,B) e(C,-delta) e(vk_x,-gamma) e(alpha,-beta) = 1`.

The deployment requires trusted keys, fresh locally contributed Groth16 setup artifacts, the authenticated genesis resources, and the exact frozen circuit profile. The depth-8 trees have finite 256-position capacities; a nullifier slot collision stops the demo rather than deleting earlier spends. This profile does not implement reserve refresh, pooled unilateral L1 redemption, recursive aggregation, or multi-lane operation.
