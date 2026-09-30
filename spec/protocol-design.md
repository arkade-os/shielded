# Arkade Shielded Transactions: multi-asset notes, sharded spend state, separate reserves

**Design revision:** 0.1 — 30 September 2026  
**Status:** Proposed architecture and security requirements, not an audited cryptographic specification.  
**Emulator snapshot inspected:** `d928b6ed57ee7ac3a2e070f2ce078bb4a4a1af02`  
**Scope:** Private transfers inside Arkade and atomic shielding/unshielding of native Arkade value. No BitVM or PIPE mechanism.

## 1. Main decision

Use **one multi-asset shielded note system**, implemented with three distinct resources:

1. **Private notes** held by wallets. A note is a logical UTXO; it does not require its own native VTXO.
2. **Sharded covenant state VTXOs**, called lanes. These enforce unique nullifiers and commit to newly created notes.
3. **Covenant reserve vault VTXOs** holding the actual BTC or Arkade assets. Internal shielded transfers do not spend them.

A periodically sealed commitment forest joins the lanes into a common membership domain. Nullifiers are routed by their pseudorandom value, not by note creation lane or asset ID. A wallet proves membership in the forest without revealing the note's lane, position, owner, amount, or asset.

This deliberately separates three problems often conflated in a single pool UTXO: backing liquidity, spend ordering, and note membership. The construction below is a synthesis, not a construction claimed by either source paper.

## 2. What to take from the sources

**Shielded Bitcoin [S1]:** note ownership, encrypted output recovery, current nullifier checks combined with historical note anchors, canonical body binding, and an explicit metadata-leakage model. Its transfer specification is Bitcoin-denominated and excludes peg-in/out. It does not supply the multi-asset reserve or UTXO-sharding design below.

**Shielded CSV [S2]:** separating a privately proved operation from its publication, proof composition, and independent conservation for each asset type. The final construction uses account-state nullification plus per-account spent accumulators; its asymptotic 64-byte publication figure is not a generic cost for each shielded note. Its wallet state cannot be reconstructed from a seed and the public log alone.

**Earlier drafts [D1–D4]:** retain useful ideas about native asset boundary checks, shared collateral, and note/nullifier state. Do not retain the following assumptions:

- A dedicated `OP_VERIFY_ZKP` must arrive first. The inspected emulator has EC arithmetic and BN254 pairing verification, plus a Groth16 integration test.
- An append-only Merkle tree leaves every witness valid against its newest root. A witness remains valid against its original root; sibling hashes can change in newer roots.
- One asset must have its own privacy pool. Reserve vaults can be asset-specific while the shielded note domain is common.
- A bare dissolution key is noncustodial. Any spend path bypassing the proof/accounting rules is an additional authority over pooled funds.
- Retrying a race after a timeout gives a bounded censorship-resistance guarantee. It does not.
- A depth-32 tree or a constant-sized proof creates unbounded capacity or constant data-availability cost.

## 3. Security boundary

The protocol requires:

- Sound zero-knowledge proofs and a sound setup for the selected proving system.
- Binding, hiding note commitments; collision-resistant position-binding trees; pseudorandom nullifiers; correct key separation; confidential recipient encryption.
- Correct enforcement of the covenant programs by the emulator, including authentication of the scripts and actual native input/output context.
- The native Arkade transaction and asset-validation rules, its ordering/finality model, and its existing checkpoint/forfeit/settlement machinery.
- Availability of the records needed to recover notes and update authenticated state.

A batcher, indexer, or archive is not given a pool spending key. An invalid proof or accounting transition must not become valid because one of these services approves it.

**Emulated execution is not Bitcoin consensus execution.** Bitcoin verifies the actual spending signatures; it does not independently execute the additional Arkade EC/introspection instructions. Colluding signing authorities that can satisfy a vault's native locking condition remain a funds-security concern. Proofs do not remove that signing assumption.

The design guarantees holder-authorized unshielding under this execution model. It does not, by itself, establish an individual Bitcoin-L1 exit for every hidden note after all emulator services disappear.

## 4. Immutable deployment profile

Pin a `Domain` and `ParametersHash` before accepting deposits. They identify:

- Network, system genesis, protocol version and exact covenant templates.
- Proof systems, verifying keys, statement encodings and curve/subgroup rules.
- Note commitment, nullifier PRF, key derivations, encryption and tree hashes.
- Supported action shapes and limits, integer widths, padding semantics and fee rules.
- Lane count and routing rule, tree capacities, archive/anchor format and upgrade rules.

Do not accept a verifying key selected freely by the spender. Do not change a deployed circuit merely by replacing an operator-side verifier file.

For a prototype, use the existing Groth16/BN254 verifier path. Cryptographic hash, encryption, key-derivation and recursive-proof parameters still need a concrete reviewed profile before interoperability or security claims. The architecture does not treat these as implementation-specific choices that different nodes may select independently.

Use a two-stage bootstrap where necessary: establish genesis/identity outpoints first, then initialize scripts and proofs referring to those already-known identifiers. Do not introduce a self-referential transaction ID.

## 5. Asset and note model

### 5.1 Asset identity

Use a tagged identity:

```
AssetKey = BTC
         | ArkadeAsset(issuance_txid: bytes32, issuance_group_index: u16)
```

The group index is the **issuance** group index, not a position in the current transaction's asset packet. BTC has a distinct tag; it is not represented by an arbitrary all-zero asset ID. Hash the canonical representation, or expose checked limbs to the circuit. Never silently reduce a 256-bit transaction ID modulo the proof field and use the result as its identity.

### 5.2 Notes

A logical note contains:

```
Note {
    domain
    asset_key
    value                 // unsigned, bounded integer asset units
    diversified_recipient
    note_seed
    policy_commitment     // fixed empty policy in the initial payment profile
}
```

Use unsigned 64-bit note quantities as a starting format and bounded 128-bit intermediate sums. Check the appropriate native amount bounds as well. Fix maximum arities so that sum bounds have an explicit justification.

A wallet may own many notes of different assets. Balance is the sum of its unspent notes. There is no mutable per-user balance slot and no requirement to own a native VTXO just to receive a note.

### 5.3 Explicit note commitment

Use an explicit, hiding commitment:

```
cm = Commit(Domain, asset_key, value, recipient_binding,
            policy_commitment, note_randomness)
```

Publish an output record containing `cm`, an ephemeral public key, and a fixed-size encrypted recovery payload. The payload must contain everything the recipient cannot derive, including the asset identity, quantity, diversifier, and note seed. Change is an ordinary incoming note to the sender; outgoing-recovery records do not replace change ownership.

Define the public tree leaf from the commitment and authenticated output record, for example:

```
leaf = H_leaf(Domain, cm, H_record(canonical_output_record))
```

The exact record definition must exclude any fields that would make its own computation circular. Optional application memos may use a separately bound channel with a specified retention policy.

This intentionally differs from the ciphertext-only leaf in [S1]. The extra commitment lets input ownership/value proofs open an explicit binding object, rather than requiring the encryption scheme alone to serve as the note commitment. It also allows output records to be flattened across an aggregate batch without publishing an originating intent ID on every leaf.

The output relation must still prove that the ciphertext encodes the same note used for commitment and accounting. A recipient must decrypt, reconstruct the note commitment, check the encryption consistency rules, and verify accepted inclusion before recognizing a spendable payment.

### 5.4 Ownership and nullifiers

Use a reviewed key hierarchy separating spending authority, incoming viewing, outgoing recovery, and nullifier derivation. A straightforward first implementation follows [S1]'s binding principle: the circuit derives the receiving authority and nullifier key from the actual spending secret. These cannot be independent free witness values.

For a note's immutable creation locator:

```
birth = (creation_lane_id, tree_generation, append_index)
nf = PRF_nullifier(nk, Domain || birth || cm)
```

The proof establishes ownership, the correct opening, membership at that exact locator, and this nullifier relation. `birth` is never reset during refresh or sealing. Do not include a spending epoch or current native outpoint in the nullifier derivation: those change while the note remains the same coin.

Position inclusion distinguishes separately funded outputs even if a sender accidentally repeats commitment randomness. A protocol migration must not simply copy an unspent note into a new position while retaining the old spend path.

Initially generate private proofs locally. A service receiving the spending secret is a trusted spending component, not merely a privacy-reducing acceleration service. A later delegated-proving design can use transaction-bound authorization signatures and proof-generation keys, but requires its own precisely specified authorization relation.

## 6. Covenant state lanes

Choose a fixed power-of-two lane count `S`; implement `S=1` first and then exercise a configuration such as `S=16`. Each logical lane has exactly one live native state VTXO, authenticated by an unforgeable genesis identity. A fresh output with the same script text must not be accepted as a fresh empty replacement lane.

```
LaneState {
    domain, parameters_hash
    lane_id
    revision
    sealed_epoch
    anchor_history_root
    note_tree_root, note_count
    nullifier_dictionary_root
}
```

State is bound to the locking program or another output-specific commitment whose preservation is enforced on **every** spend path. A transaction-level packet alone is not sufficient unless its output association and continuity are authenticated.

The note tree is append-only and position-binding. The nullifier dictionary represents the spent set for this lane. A sparse dictionary keyed by full nullifiers is a simple reference choice; a carefully specified indexed Merkle tree can later reduce proving cost. In the latter case, predecessor links, insertion indices, sentinels and sequential updates must all be constrained.

Do not use a lexicographically sorted Merkle-branch primitive as if it authenticated a left/right positional index. The membership circuit needs position binding, including lane identity, tree generation and index bounds.

### 6.1 Routing

Every nullifier has exactly one authoritative lane:

```
nullifier_lane(nf) = low_bits(H_route(Domain, nf), log2(S))
```

The rule is enforced by the transition proof and native resource checks. The spender cannot choose another lane merely because it has no record of the nullifier.

Routing is independent of asset ID and creation lane. Public knowledge of a spend lane therefore does not directly identify the subtree containing the spent note. It is not a guarantee of perfectly balanced adversarial traffic: a user can grind their own activity towards hot lanes, so fees and admission limits remain necessary.

### 6.2 One native transaction

An internal payment consumes:

- The current state VTXO of every lane owning one of its nullifiers.
- A writer lane, normally reused from that set, which will append its output records.

It atomically creates one authorized successor for each consumed lane. Each nullifier is inserted into its one authoritative dictionary; output records are appended exactly once in canonical order. Other lane fields and all unconsumed lanes remain unchanged.

Two disjoint lane sets can advance independently. Two spends of the same note must collide on the same native lane resource. Even after rebasing to its successor, the second spend fails because the current nullifier dictionary already contains the marker.

**Never use a historical nullifier root to authorize a current spend.** Historical anchors are for note existence only.

## 7. A common membership forest without a per-payment global input

A permanent global root VTXO consumed on every payment would negate the lane design. Conversely, merely calling unrelated roots a global forest does not authenticate them.

Use an explicit **SEAL** operation:

1. Consume the current tips of all `S` authenticated lanes in one native transaction.
2. Form `F_e`, a position-binding Merkle root over `(lane_id, tree_generation, note_count, note_tree_root)` for those tips.
3. Append the new `(epoch, F_e)` checkpoint to the authenticated anchor-history accumulator.
4. Recreate all lanes with the same new epoch and history root, preserving their note trees, counts and nullifier dictionaries.

Every later state transition can authenticate an old `F_e` through the history root committed by its consumed lane inputs. A sealer cannot invent a snapshot, omit a lane, or reset its spent set: native identity checks and the SEAL relation prevent it.

All inputs to a normal multi-lane transition must agree on the seal generation/history. Once a SEAL is accepted, its old lane tips cannot also be spent into another accepted branch under the assumed native finality model.

A wallet proves a private path from its note through its creation tree and the forest to `F_e`. The creation lane is private. All assets use the same verification profile and forest; vault selection does not partition ordinary spend membership.

### 7.1 Deliberate trade-off

A note created after `F_e` is recorded but **not spendable until a later SEAL contains it**. The first profile forbids same-epoch chaining, which avoids cross-lane unconfirmed-state and dependency complications.

SEAL is a real synchronization barrier, with `O(S)` native inputs and outputs. It can be run by any service, but coordinating it under heavy load is an operational problem, not free parallelism. The deployment needs an intake/flush mechanism that does not starve SEAL. A short application-level seal interval is a performance target to benchmark, not a Bitcoin block interval or a promised finality time.

Do not call these application checkpoints “Bitcoin finality.” They inherit Arkade's acceptance, settlement and reorganization semantics.

### 7.2 Old roots and offline wallets

The proposed initial design retains **all accepted anchors in an authenticated history**, rather than expiring them after a small number of busy-pool updates. Its current root is compact; its underlying data still grows.

An old note path remains usable against its old anchor. A batcher supplies the public-data proof that this anchor remains in the current history. The note owner need not update the old path to the newest note root just because other people transacted.

This does not imply that paths to an evolving root never change, that unsealed outputs are spendable, or that data availability can be discarded. Wallets without saved witnesses still need recovery data. Prefer common recent anchors operationally to reduce age fingerprinting; aggregate proofs can keep individual anchor choices out of the final published statement.

## 8. Separate private intent proofs from mutable settlement proofs

### 8.1 Private wallet intent

A wallet prepares:

```
PrivateIntent {
    domain, parameters_hash
    accepted_anchor
    nullifiers[]
    output_records[]
    boundary_effects[]
    fee_terms
    authorization_nonce
    validity_conditions
}
```

It commits to a canonical proof-excluded body. Its proof establishes valid input notes and ownership, correct nullifiers, output commitments and encryption, ranges, all required per-asset equations, and authorization of the complete intent.

It does **not** commit to the live lane outpoints, current nullifier roots, writer lane revision, or unrelated users' batch ordering. A wallet need not reprove its private transaction every time the shared native state advances.

Merely adding a hash as an unused public input is not binding. The circuit must constrain the hash to the canonical body and bind spending authorization to that body.

### 8.2 Settlement/batch transition

A batcher receives intent proofs and public bodies, not spending keys or note openings. It:

- Authenticates each anchor through the current history.
- Verifies all included intent proofs and authorization conditions.
- Checks nullifier uniqueness within and across intents and non-membership against the **current** authoritative dictionaries.
- Constructs the exact ordered dictionary updates and note appends.
- Checks actual native vault flows and user-designated withdrawals.
- Proves a complete transition bound to the consumed native outpoints and exact successor output conditions.

The batch proof must establish a bijection between the verified intents' effects and the public batch's effects: no omitted, duplicated, redirected or manufactured output, nullifier, deposit credit or withdrawal.

A competing accepted native transaction may invalidate this **settlement** proof. The batcher rebuilds it using fresh public state. The wallet's private proof usually remains usable. A spent input, changed payment instructions, expired user authorization or invalidated anchor genuinely requires different handling.

### 8.3 Aggregation and public grouping

An aggregate can publish a flattened nullifier list and output-record list while keeping the mapping to individual wallet intents inside the aggregate proof. This can reduce public grouping leakage. The batcher that received the original intents still knows their grouping; aggregation is not a mixnet and does not conceal network metadata from it.

Proof composition is a separate implementation milestone. Recursively verifying many BN254 proofs inside a BN254 circuit is not automatically efficient. Benchmark a recursion-friendly inner proof with a BN254 outer verifier, or another reviewed composition. Do not infer prover throughput from the short final proof.

For the initial single-intent implementation, verify the wallet proof and state-transition proof separately. The current two-pairing-invocation per-input default is relevant. Production aggregation must fit the real per-request limits rather than assuming they reset without bound across inputs.

## 9. Native reserve vaults

Vaults hold the actual collateral. A vault may be dedicated to a single asset for simple auditing and access, and there may be many vault UTXOs for the same asset. This is **not** a separate privacy pool: a note has no reserve-vault identifier.

For every asset `a`, define:

```
R_a = native units locked in authorized vaults for this system
L_a = units represented by accepted, unspent shielded notes
```

Require `L_a <= R_a`. With no unsolicited donations or explicitly accounted surplus, equality holds. Internal payments preserve both. No administrator can skim alleged surplus without a separately specified, safe authorization rule.

Vault spends must require an authenticated state-transition leader and the exact shared effect digest. Each participating vault input must prove it appears once in the input plan; all recognized vault outputs must use the strict continuation template. All actual collateral flows must be included, including additional inputs that could otherwise be used to conceal a backing reduction.

It is safe to split one reserve vault into several correct reserve outputs without moving notes, provided each asset is conserved and no note is created. More reserve UTXOs improve boundary concurrency and liquidity selection; they do not enlarge or fragment the note-membership domain.

### 9.1 Per-asset accounting

For every distinct asset occurring in an operation:

```
sum(input note values for a) + D_a
    = sum(output note values for a) + W_a

R'_a - R_a = D_a - W_a
```

`D_a` and `W_a` are actual, authenticated deposit and withdrawal quantities. Fee notes are already included among note outputs. Transparent fee payouts are included among withdrawals. Do not subtract them twice.

Conservation is an integer equation for **each asset**, not one equation across numerical quantities of unrelated tokens. Implement an exact bounded private grouping/sorting relation or another sound per-asset argument. Prove that every non-dummy input/output appears exactly once and that no asset class is omitted. An attacker-issued token cannot cancel a BTC deficit.

### 9.2 Shield

Atomically consume native funding and any vault/state resources needed; increase authorized native reserve quantities; append corresponding shielded output records. Credit exactly the checked reserve increase. Bind the depositor's output commitments to the authorization, and process each native deposit resource once.

Do not accept only a transaction hash that someone claims was a deposit. Do not count an existing vault's successor as fresh backing without subtracting the consumed vault reserve. Each vault input's own covenant must enforce its participation in the shared plan.

### 9.3 Unshield

Atomically nullify input notes, create shielded change if any, reduce appropriate native vault reserves, and create the **exact** user-authorized native payout outputs. Bind asset, quantity, destination, fee authorization and native output assignment.

No freely redeemable exit claim is created without retiring its shielded source. A future asynchronous ticket design must itself be single-use and count against backing; it is not an ordinary repeatable signed receipt.

The first asset exit target is an ordinary **Arkade asset VTXO**. Do not assume that native Bitcoin consensus enforces the asset's identity or quantity once represented by an arbitrary L1 output.

### 9.4 Rebalance

Vault splitting, merging and same-system movement conserve every native asset and BTC quantity. They create no shielded liabilities and consume no notes. State-transition authentication remains required; rebalancing cannot be an alternate withdrawal path.

### 9.5 Deposits of newly issued assets

Native Arkade asset identity includes its issuance transaction ID. A commitment to a new asset ID inside the same transaction can introduce a circular dependency through the transaction ID. Initially use **issue, then shield in a subsequent transaction**. Same-transaction issuance needs a separate, explicitly non-circular construction.

## 10. Native asset validation and policy compatibility

The inspected `OP_INSPECTINASSET*` functions read **packet-declared input allocations**. They do not, by their names alone, establish that these quantities existed in the real previous output. The adapter must authenticate prior native asset ownership and use the native Arkade asset-validation path. On-chain operation needs the corresponding explicit validation; do not assume an off-chain server check is automatically repeated there.

Check canonical asset identity, local versus intent input mapping, prior output assignment, supply/control rules, asset-group duplication, amount ranges and output ownership. The covenant proof's public quantities must be derived from these authenticated facts.

Initially admit ordinary transferable fungible assets and suitably modeled NFTs. For an NFT, preserve the exact identity and quantity-one semantics. A confidential amount field does not by itself preserve a mint/control token's authority, freeze condition, recipient restriction, or other issuer policy. Such assets require an adapter/circuit that preserves the policy, or must be rejected by the shielding adapter. A transfer into a vault must not silently become a policy-bypass mechanism for subsequent beneficial transfers.

## 11. Mapping to the inspected emulator

The following primitives are already present in the inspected snapshot:

- Input outpoint, value and script inspection; output value and script inspection.
- Current/input packet inspection and native asset lookup/iteration.
- `OP_ECADD`, `OP_ECMUL`, `OP_ECPAIRING` for BN254 verifier arithmetic.
- Streaming SHA256 operations for typed effect commitments.
- `OP_INSPECTINPUTARKADESCRIPTHASH` for authenticated cross-input program checks, when combined with actual input identity/locking-condition validation.
- `OP_TUNNEL` for selected-field preservation during delegation/refresh.
- `OP_CHECKTIME` and `OP_PUSHEXPIRY` in the code, with emulator-context rather than Bitcoin-consensus timing semantics.

`test/groth16_bn254_test.go` contains a four-pair Groth16 equation and valid/invalid fixture cases. Its circuit is the tiny relation `Y*Y=X`, not this protocol's transfer or batch circuit.

### 11.1 Leader/follower validation

A transaction with many state/vault inputs should not verify an expensive identical aggregate proof separately on every input.

The deterministic leader performs the full proof verification. Each follower enforces that the leader is a genuine, authorized lane input, executes the exact required leader validator, commits to the same complete effect digest and consumes this follower once. The follower also checks its own successor or authorized payout treatment.

Checking only a witness-supplied script hash is insufficient. Check the actual input's authenticated role/identity and locking condition, and ensure no alternative leader mode can bypass the required verification. Circular references between followers are not a substitute for an actual designated verifier execution.

The inspected defaults allow two pairing-opcode invocations per input and eight per request, with at most sixteen pairing terms per opcode invocation. Public-input EC multiplication also has limits. Bind large statements through checked digest limbs rather than exposing arbitrary-length ciphertext vectors as EC public inputs.

### 11.2 Native effect commitment

Build a canonical, typed commitment over:

```
Domain, mode, circuit/profile identifiers,
consumed native outpoints and authenticated old states,
ordered successor output scripts, values and asset allocations,
new covenant states,
nullifier and output-record data commitments,
native deposits/withdrawals and authorized fee effects.
```

Exclude proof bytes and other self-referential fields. Do not use a transaction ID that includes the proof as an input to the proof that will create it.

The Arkade VM's signature hash masks emulator witness blobs and uses the `ArkadeTapSighash` domain. Its standard Bitcoin signatures are separate. Therefore explicitly bind the private intent and settlement effects; do not assume an internal generic CHECKSIG covers every runtime proof/record field.

### 11.3 Data carrier and bounds

Allocate a shielded packet type; do not assume the earlier drafts' `0x04` is currently reserved. Define output-index association, versioning, counts, fixed-width fields, canonical CompactSize, rejected duplicates and trailing-byte rules.

The emulator packet places its runtime witness blob **inside an OP_RETURN extension**. Calling it a witness does not make it Bitcoin-discounted witness data. Respect script, packet, compute, native transaction and publication limits separately. A one-megabyte packet-field ceiling does not prove such a transaction is acceptable or economical in every path.

## 12. Fees, padding and example

A relayer funds native transaction overhead and receives a shielded fee note. A user holding only an asset can pay a relayer that accepts that asset without first acquiring a BTC-funded VTXO. The relayer then learns its fee note's asset and amount; this is a disclosure trade-off. A common BTC-denominated shielded fee can reduce that particular asset hint.

Charge for outputs, nullifier insertions, bytes and proving/verification resources. Repeated zero-value outputs and worthless assets otherwise offer a low-capital state-exhaustion attack. Failed intents must not irreversibly debit a wallet's fee independently of the payment.

Support a small fixed set of action shapes; a 4-input/4-output shape can cover a token payment, token change, BTC fee input/change and a relayer output. Padding is a circuit rule, not an unsupported wallet convention. Dummy inputs contribute zero value, use independently derived pseudorandom markers that cannot be chosen as someone else's known nullifier, and still incur state/DA cost. Dummy output records must be indistinguishable in format from ordinary encrypted records. Fix every enable bit and range check in the relation.

Example with two real inputs and four real outputs:

```
Alice inputs:     1,000 units of asset A; 10,000 sats
Outputs:         Bob 250 A; Alice 750 A; Alice 9,990 sats; relayer 10 sats
Native vaults:   unchanged
Native state:    consume nullifier lanes + writer; append four output records
```

The ordinary payment's underlying asset A does not appear in a vault movement. Any additional dummy slots and their costs depend on the selected shape.

Private atomic swaps and private application policies are natural extensions of the multi-asset relation, but not automatic consequences of summing assets. A multiparty swap requires every input owner to authorize the agreed joint effects, and a proof of joint per-asset conservation. Do not permit unbalanced individual intents to be freely recombined without binding their counterparty obligations. The initial payment profile keeps the policy commitment empty.

## 13. Privacy claims and remaining leakage

Target privacy is against observers of accepted protocol data, including the execution service insofar as it receives only public intent data and valid ZK proofs. Network/source identity and voluntary disclosure are separate.

Hidden in ordinary internal payments, under the cryptographic assumptions:

- Input note commitments and birth positions; links from nullifiers to prior notes.
- Note owners, recipient addresses, amounts and asset identities.
- Private policy contents where supported by a future pinned profile.

Still visible or inferable:

- Shielded activity, timing, native state resources touched, output insertion order and chosen public shape.
- Individual intent grouping to a batcher that receives it, and batch grouping to public observers.
- Native asset IDs and amounts at deposits/withdrawals; vault inventories and boundary liquidity movements.
- Fee information disclosed to its recipient and metadata from funding/submission.
- Viewing-key disclosures, recipient knowledge and collusion, wallet-specific sizes or timings.

A common forest avoids a structural per-asset or per-creation-lane partition. It does not make every historical note equally plausible for every spend, erase known entry/exit information, or guarantee anonymity for a uniquely identifiable asset event.

## 14. Data availability, discovery and recovery

Publish enough authenticated data to reconstruct the public state: output commitments and recipient recovery records, accepted nullifiers, canonical append order, lane transitions, seals, and native boundary effects. A hash of a withheld blob is not data availability.

Arkade transaction data is not necessarily permanently published on Bitcoin. A seed-recovery claim therefore requires an explicit archive/DA assumption. Replicated archives, erasure-coded storage and wallet backups can improve availability, but signed availability receipts alone do not prove permanent retrievability.

Wallet recovery is:

1. Obtain authenticated system/genesis parameters and accepted history or a verified replay/checkpoint proof.
2. Scan recipient records using the incoming viewing capability.
3. Reconstruct commitments and birth positions; recover membership witnesses at recognized seals.
4. Derive owned nullifiers locally and verify current spent status.
5. Reconstruct outgoing records separately when requested.

An indexer cannot forge a path to a trusted root, but can lie about freshness, omit records or withhold history. A proof of a root does not establish that it is the latest canonical state. Authenticate the native lane/settlement context as well.

At scale, full self-scanning is the strongest simple baseline but costs bandwidth proportional to all outputs. Incoming-view delegation reduces client workload while revealing that wallet's incoming notes to the scanner. A private-query service can be added, with explicit assumptions. Do not insert a stable public recipient tag and then claim recipient unlinkability.

A current-tree checkpoint does not recreate missing historical ciphertexts for seed recovery. A user with an old saved witness may use its old retained anchor, but a user with neither the ciphertext nor a usable recovery archive cannot obtain the note simply from a root.

## 15. Refresh, expiry and exits

A lane or reserve is still a native Arkade resource with a real lifetime and settlement history. Decoupling wallet notes from native UTXOs does not make backing immortal.

Define distinct covenant modes:

- `TRANSFER`: valid shielded transfer and authorized state successors.
- `BOUNDARY`: valid shield/unshield accounting and native resource flows.
- `SEAL`: all-lane checkpoint operation.
- `REFRESH`: preserves every logical state commitment, identity and reserve quantity while replacing the native backing resource through the proper settlement path.

Use OP_TUNNEL where its selected preservation rules fit, but verify the full logical state separately. Preserve anchor history, note roots/counts, nullifier roots and all reserves; not just the script template name or one token. Distinguish the logical VTXO from checkpoint outputs and account explicitly for native fee/anchor deductions. Runtime type/mode checks must prevent an intent-only refresh authorization from being reused for arbitrary off-chain spending.

Fund keepers to refresh reserves and lane heads before expiry and monitor settlement/expiry status. Contract keys and deprecation windows need a migration policy before old keys stop signing. A failed refresh followed by a backing sweep is a security/liveness failure, not something a private note proof repairs.

Unshielding can be permissionless with respect to a pool batcher: any party may assemble the authorized transition. This is not a bounded inclusion promise against a censoring native operator.

For L1 recovery, distinguish:

1. An already-created ordinary user VTXO, with its actual user exit path.
2. An unrolled covenant resource, whose next claim still needs whatever execution/signing its native script requires.
3. A still-shielded note claiming a fraction of a shared vault.

The repository's ordinary user CSV exit does not automatically implement (3). A bare user/admin CSV leaf on the whole shared reserve is unsafe. Define and validate the actual emergency closures and native execution path before claiming emulator-independent L1 exits. Until that construction exists, describe the guarantee as covenant-enforced Arkade unshielding with the stated execution/availability assumptions.

## 16. Scaling and costs

Three different scale measures matter:

- **Users:** wallet notes do not add one native VTXO per holder. Native persistent payment-state resources are `O(S)` plus reserve vaults.
- **Throughput:** bounded by overlapping lane sets, batch construction, proving, native acceptance and SEAL coordination.
- **History:** public note records and spent nullifiers grow with activity, not merely current users.

For batches touching an average of `k` lanes and containing `B` payments, a rough scheduling upper bound is `S*B/(k*t_commit)`, before proving, DA and underlying service limits. This is not a throughput estimate. Larger batches tend to touch more lanes, eventually all of them; sharding does not provide a free S-fold speedup.

A useful raw-data model is:

```
bytes_per_payment ≈ 32 * published_nullifier_count
                  + output_record_bytes * published_output_count
                  + amortized proofs, headers and native overhead
```

For an **illustrative** 224-byte output record and two nullifiers/two outputs, the base data is 512 bytes/payment. One million such payments per day requires about 512 MB/day before overhead, indexes, replication or backups. At 1,000 payments/second it is about 44.2 GB/day. A four-input/four-output padded shape roughly doubles that base term. These are arithmetic scenarios, not measurements of a completed circuit or wire format.

A depth-32 tree at 2,000 append operations/second fills in approximately 24.9 days. Actual per-lane fill time depends on traffic. Use a wider positional space or a rigorously defined segmented-tree scheme, with explicit capacity limits; do not label a finite tree unbounded.

Nullifiers cannot be deleted merely because they are old while corresponding historical notes remain spendable. Safe retirement requires proving/ensuring that the old note domain can no longer authorize spends and preventing dual redemption during migration. Database compaction is not semantic nullifier pruning.

## 17. Build sequence and acceptance tests

### Stage A — single-lane, end-to-end semantics

Build native asset/BTC adapters, note codec, owned-note relation, actual Groth16 verifier, state transition relation, shielding, payment, unshielding and seed recovery. Keep `S=1` and one intent per transition while validating exact context binding.

### Stage B — concurrent private proof preparation

Retain old note anchors, separate wallet and settlement proofs, and demonstrate that unrelated native state updates do not require regenerating the private witness proof. Exercise invalidation/rebasing when nullifiers really conflict.

### Stage C — sharded execution and SEAL

Deploy a fixed multi-lane instance. Test parallel disjoint state changes, cross-lane atomicity, missing/substituted lane attacks, counterfeit empty lanes, duplicate identity outputs, old anchors and SEAL races. Verify that no note's creation lane becomes a public spend-path requirement.

### Stage D — aggregation, DA and lifecycle

Profile recursive composition versus direct verification; implement strict leader/follower execution; benchmark all real packet and compute limits. Test output recovery under archive failures, refresh through real settlement/checkpoint/forfeit flows, key deprecation, operator outages and the exact supported exit path.

Release gates include:

- Arbitrary asset substitution and cross-asset cancellation rejected.
- Duplicate/nullifier replay, wrong routing and old-nullifier-root attacks rejected.
- Ciphertext/commitment mismatch and independently selected nullifier key rejected.
- External deposit replay and double counting across two credits rejected.
- Payout destination or amount substitution rejected.
- Public input digest limbs canonical; no field-reduction aliases.
- Any invalid batch has no partial effects.
- Refresh/SEAL cannot erase state or dilute reserves.
- All actual taproot/key-path/alternate-leaf spends preserve the stated authorization boundary.

## 18. What is validated here

`reference_model.py` is a **transparent relation/state-machine model**, not a cryptographic or emulator implementation. It checks openings and owner labels directly, abstracts native outpoints with revision checks, and represents vault liquidity with per-asset counters. It exercises thirteen cases, including disjoint-lane advancement, double spends after rebasing, current-nullifier enforcement with old anchors, per-asset conservation, deposit replay, withdrawal atomicity, unsealed notes and rollback on invalid batches.

All thirteen local tests passed when this design was prepared. This does **not** validate the SNARK circuits, ciphertext security, actual native asset adapters, proof aggregation, leader/follower scripts, DA guarantees, or L1 exit construction. The emulator integration tests were inspected but were not run here.

Run locally with standard-library Python:

```
python reference_model.py
```

## 19. Source map

### Uploaded papers

- **[S1]** Clara Shikhelman, Mikhail Komarov, Aleksei Moskvin, *Shielded Bitcoin: Private Transfers on the Bitcoin L1*, uploaded version dated 24 September 2026. In particular: §§1.2, 5–9, 12–16, 17–20, Appendix A and Appendix B.
- **[S2]** Jonas Nick, Liam Eagen, Robin Linus, *Shielded CSV: Private and Efficient Client-Side Validation*, uploaded ePrint 2025/068 PDF dated 20 September 2024. In particular: §2, §4.2, §6.2, §6.4 and Appendix A.1.3/A.2.

### Uploaded exploratory drafts

- **[D1]** `2026-05-01-arkade-asset-pool-v0.md`
- **[D2]** `2026-05-01-arkade-asset-pool-v0-zkp.md`
- **[D3]** `2026-05-01-arkade-asset-pool-v1-zec.md`
- **[D4]** `2026-05-01-shieldedcsv-comparison.md`

### Emulator code inspected

Repository: `https://github.com/arkade-os/emulator`  
Snapshot: `d928b6ed57ee7ac3a2e070f2ce078bb4a4a1af02`

- **[E1]** `README.md`: dual execution model, APIs, packet encoding, signature-hash masking, native introspection, EC and asset opcode interfaces.
- **[E2]** `test/groth16_bn254_test.go`: executable verifier construction and fixture-based valid/invalid integration cases.
- **[E3]** `pkg/arkade/compute_limits.go`: per-input and aggregate request budgets.
- **[E4]** `pkg/arkade/asset_opcodes.go`: packet-declared input lookups and canonical asset identity resolution.
- **[E5]** Search excerpts from `pkg/arkade/opcode.go`, `pkg/arkade/engine.go` and `test/delegate_test.go`: current-time/expiry operations and delegation context.

The proposed reserve/state split, deterministic nullifier routing, all-lane SEAL, native atomic accounting and the exact combination above are design proposals. The sources do not establish their composed security or performance; those are the subjects of the implementation and review gates.
