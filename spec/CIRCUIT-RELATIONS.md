# What the external circuits must prove

These relations are REQUIREMENTS, not implemented circuits. The `.ark` compiler
compiles validators to Arkade Script; it does not turn `.ark` into a private
SNARK computation.

Both circuits expose eight unsigned 32-bit public integers. These are successive
little-endian four-byte chunks of a SHA256 digest. They must reconstruct the
exact canonical byte preimage and constrain SHA256(preimage) to those limbs.

## Intent relation

Digest:

```
SHA256("ArkShieldIntent:v1" || domain32 || parametersHash32 || SHA256(intentBytes))
```

`intentBytes` is the canonical public intent, including supported arity/padding,
accepted forest anchor, nullifiers, encrypted output records, exact boundary
instructions, fee terms, nonce and any validity conditions. The canonical intent
wire format, crypto gadgets and curve choices remain to be frozen.

Private witness: note openings, spend authority, original birth positions,
position-binding membership paths, and output encryption randomness.

The relation must enforce ownership tied to the nullifier key, membership in the
chosen forest, immutable birth-based nullifier derivation, exact ciphertext/note
commitment consistency, unique real input notes, correct dummy handling, range
checks, and independent integer conservation for every canonical asset:

```
sum(input notes[a]) + D[a] = sum(output notes[a]) + W[a]
```

It must bind output recipients and public withdrawal destination/amount/asset.
It must NOT bind live native lane outpoints or current nullifier roots. This is
what permits a state-transition retry without re-proving private note ownership.

## Transition relation

Digest is the exact `Statements.transition` preimage. All required native
information, plan bytes, state bytes, asset packet and intent bytes are available
to the batcher. It needs no spending keys or note openings.

1. Recompute the full native IO hash from actual input/output fields. Hash order,
   integer encoding, script introspection representation, and maximum dimensions
   must match `statements.ark` and the native adapter exactly.
2. Parse the complete native asset packet. Reject fresh issuance, inflation,
   unauthorized controls, aliases and unsupported asset policies. Native Arkade
   asset validation must independently authenticate declared input quantities:
   a SNARK over invented declared amounts does not establish provenance.
3. Authenticate resource identities against the fixed genesis registry committed
   by the deployment profile. An ordinary user-minted NFT is not a lane identity.
4. Every claimed resource row must correspond to the actual consumed input with
   that identity, and every consumed registered identity must be accounted for.
   Counterfeit/non-resource rows cannot supply roots or reserves. Duplicate
   identities, rows, continuations and funding credits are rejected.
5. The actual resource covenants authenticate each old record from its previous
   OUTPUT index, compare its hash to the plan, and enforce the planned successor.
   Treat this as a joint covenant/circuit invariant, not optional batcher checks.
6. For TRANSFER/BOUNDARY, authenticate the intent's forest anchor through current
   lane history, route every nullifier to its unique authoritative lane, prove
   absence in the CURRENT dictionary and insert exactly once, and append exactly
   the authorized output records to the selected writer lane(s). Preserve note
   birth identity and all unchanged data; enforce capacity and counter bounds.
7. TRANSFER has no reserve changes or public value movements credited to notes.
8. For BOUNDARY, the per-vault D/W fields equal actual reserve changes and sum to
   precisely the intent's D/W per asset. Match every withdrawal to exact native
   recipient outputs, asset identities and amounts. Subtract existing reserves
   before counting deposits, and count each actual funding resource only once.
9. SEAL consumes every registered lane once, from the same compatible epoch,
   computes the forest from authentic note roots/counts/generations, appends the
   forest to authenticated history, and gives every successor the identical new
   history commitment. Preserve nullifier dictionaries and note contents. No
   intent, new note, liability, vault delta, or unaccounted state reset is allowed.
10. Enforce native input/output record canonicality: role 0 rows and non-resource
    output records are all-zero, lane/vault kinds are correct, reserved bytes are
    zero, indices/counts are bounded, and the final extension carries no assets
    or BTC. Parent state packets use the same canonical rules from genesis.

The Gate separately verifies the intent proof for TRANSFER/BOUNDARY. Therefore
this initial transition circuit does not recursively verify that proof. Both
checks share the exact intent digest. Multi-user recursive aggregation requires
another explicit circuit/interface; it is not supplied here.

## Native IO digest exclusions

Do not include current txid, transaction weight, the emulator packet (type 1),
proof bytes, or the full proof-bearing OP_RETURN output in the proof statement.
Doing so creates a self-reference or makes proof rerandomization affect the
statement. The digest explicitly includes every relevant non-proof packet,
version, locktime, all native input outpoints/values/programs/sequences, and all
spendable output values/programs. The excluded last output must carry zero BTC
and zero assets. Unknown optional packet types have no shielded semantics in
this profile. Native extension parsing must be unambiguous.

`scriptPubKey` in this source means the compiler/emulator introspection value,
not a raw serialized Bitcoin script. The implementation must constrain the exact
normalization and permitted output types before proving; that adapter is not
implemented in this source package.

## Genesis, non-circular pins and lifetime

First establish singleton identity issuance IDs and the immutable registry.
Then instantiate the proof gate with real verification keys and a non-circular
profile hash. Then instantiate resource contracts pinned to the gate's actual
program and closure hashes. Fund the unique resource IDs into those contracts
with an authenticated empty initial state, and irreversibly disable reissuance.
No other spend leaf may move a resource identity outside its covenant.

A BTC vault's `carrierFloor` is externally funded operational overhead, not note
backing. Native state-carrier sats are likewise not shielded liabilities.

This sketch has no resource retirement, native batch refresh, emergency closure,
key migration or emulator-independent fractional L1 exit. Do not fund it. A
real refresh must preserve/authenticate the application state through the actual
Arkade intent/checkpoint/forfeit/commitment flow; `this.tunnel()` alone is not
packet preservation. The current gate deliberately rejects intent-proof context.
