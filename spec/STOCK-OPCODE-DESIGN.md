> Historical feasibility candidate and measurements. The current combined BTC implementation is specified in [STOCK-STATEMENT.md](STOCK-STATEMENT.md); its proposed fresh live policy and acceptance gates are in [STOCK-DEPLOYMENT.md](STOCK-DEPLOYMENT.md). The old arithmetic fixtures and abort coverage remain intact.

# Stock-opcode Shielded design

## Accepted enforcement boundary

The Shielded coordinator is untrusted. It may store encrypted note data, provide Merkle paths, coordinate requests and submit transactions. It must not own an approval key that substitutes for proof verification. The existing independent Arkade emulator must execute proof and native-effect checks using its existing opcodes. No Shielded-hosted emulator, attestation service, registered-program resolver or operator-specific patch is an accepted deployment prerequisite.

The existing inline path demonstrates this enforcement model, but its recorded transfer is 62866 WU and its seal is 41278 WU. Those transactions cannot satisfy the experimental min(operator limit, 4000 WU) cap. The previously built registry lab and verifier HTTP container are historical experiments, not the deployment target. Their tests remain for regression coverage.

## Existing primitive and weight constraint

Stock BN254 Groth16 verification uses EC multiplication, EC addition and one four-term pairing-product call. It does not need a new proof-verification opcode. A proof has eight uncompressed field coordinates (256 raw bytes). A one-public-input verification key has eighteen coordinates (576 raw bytes).

The emulator's proof stack comes from the EmulatorPacket inside the native transaction extension. Those bytes are non-witness data and cost four WU per byte. Supplying a proof in arbitrary PSBT metadata does not make it available to the stock VM. Reducing public inputs and verifier code is necessary; changing the proof system alone does not remove this serialization cost.

## Candidate: prepare, verify, abort

The candidate separates immutable verification-key publication from proof execution using the existing previous-input packet inspection opcode. The stock VM can read the original creating Arkade transaction through checkpoint mapping. Returned packet elements are limited to 520 bytes, so the candidate uses separate 128-byte IC and 448-byte fixed-pairing key packets. Each is size checked and SHA256 pinned by the verifier program.

Prepare, commit and abort must be leaves of one immutable Taproot policy. Every continuation must retain the same policy script. Phase is read from authenticated parent state; separately hardcoding active and prepared policies into each other introduces circular script commitments.

A preparation transaction must preserve all pool funds, assets and the current state commitment. It publishes key material and enters a verification phase. It must not issue notes, withdraw funds or change the accepted private state. The temporary output must expose an emulator-enforced abort path.

A commit transaction reads and authenticates those key packets from its exact parent, supplies the current proof, and executes the stock pairing equation. Its public statement must bind the pool domain and asset identities, previous and successor state commitments, actual native reserve changes, payout program, operation and spent outpoint. The immutable covenant must construct that statement from authenticated lineage and actual transaction fields, rather than trusting a coordinator-supplied digest.

An abort transaction must restore the identical active pool policy, state commitment, value and asset allocations. It must require neither a Shielded private key nor an unavailable note holder. It must not redirect value, alter roots or create claims. Abort is a safety path; competing preparations and aborts still introduce denial-of-service and scheduling concerns. It requires Arkade acceptance and checkpointing, so it is not an independent Bitcoin exit during Arkade operator failure. Conflicting preparations must be rejected by the native ledger single-spend rules; VM verification alone is not protection against a malicious Arkade operator accepting conflicting VTXO spends.

Every stage and checkpoint must pass its own weight and compute preflight. No stage may change a funded verifier profile in place, infer acceptance from a signature, or resubmit an unknown outcome with a new transaction identity.

## Measured stock-opcode experiment

The ordinary Go tests use the unmodified emulator module pinned at `v0.0.0-20260925153657-d928b6ed57ee`, without the historical registry build tag. Packet reuse reduced the actual Groth16 verifier bytecode from 403 to 305 bytes while retaining both verification-key pins and all pairing rejection tests.

`TestStagedStockServiceSubmitTxTransportAndWeight` submits a three-leaf immutable policy through the real stock `Service.SubmitTx`. It adds the deterministic public test Arkade signature, finalizes each transaction, verifies its two-signature Taproot witness using Bitcoin `StandardVerifyFlags`, and measures `3 * stripped bytes + total bytes`. The raw verifier unit test uses a mocked parent fetcher; the service test supplies the actual original parent through checkpoint mapping.

| Local arithmetic fixture | Ark transaction WU | Checkpoint WU |
| --- | ---: | ---: |
| Prepare | 3608 | 696 |
| Commit | 3708 | 728 |
| Prepare after original output index 1 | 3608 | 696 |
| Abort | 1276 | 728 |

The limit applies to each transaction separately. A logical prepare-and-commit action also pays for both checkpoints; splitting does not make aggregate bandwidth or fees disappear. The fixture retains an unchanged opaque state record, preserves the pool remainder and policy, checks phase and shape, and exercises both original output index 0 and index 1 through checkpoint output index 0. Incorrect proof, key, payout, state, phase, remainder, extra output and substituted bytecode are rejected. It is an assetless synthetic fixture with public test signing keys, not a funded wallet.

Its public scalar is the one-byte value 9. Replacing that with a 32-byte statement scalar adds an estimated 128 WU including framing, leaving only 164 WU before additional Shielded state and asset checks. This is a lower-bound byte estimate, not a budget pass for the complete relation. Current public Mutinynet opcode support and final admission have not been established by these local tests.

## Experiment scope and remaining work

The initial staged VM experiment uses the upstream arithmetic Groth16 relation Y*Y=X. It checks that a key obtained from a parent transaction can support actual stock VM verification and that tampered keys, proof points and native payouts fail. This is a transport and enforcement experiment, not the Shielded note relation or a funded Mutinynet lifecycle.

Before replacing the wallet path, implement and test the compact Shielded relation, canonical digest encoding, nonzero native asset and identity preservation, authenticated recovery and actual Arkade admission/finalization. The new proof must be produced by the client without disclosing its spending secret; rebasing must regenerate the proof against the actual successor state, rather than letting the coordinator reuse a stale proof or acquire the secret. A single proof should preserve the existing ownership, conservation, nullifier and encrypted-record constraints while reducing public-signal and key size. The setup remains a separate security requirement.

Encrypted ciphertexts, note trees and restoration data can remain in the operator archive, authenticated by the proved state commitments and checked with the user's retained secret. Groth16 proofs, required native bindings and executable verifier bytecode remain visible to the stock emulator.

Two native stages add ordering, latency, transaction fees and recovery work. No throughput or production-readiness claim follows from a small arithmetic proof fixture. The existing finite trees and lack of independent pooled-BTC holder exit remain unresolved.
