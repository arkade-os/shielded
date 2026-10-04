# Security status

This is unaudited research software. The retained legacy compact transport is an experimental,
custodial demonstration and **does not meet Shielded's core trust goal**: users
must not have to trust the Shielded service not to steal, inflate, or force a
custodial exit. The server stores Alice and Bob's spending secrets and note data.
Users do not control their own keys, and the service can access their notes.

Legacy compact verification is offchain. The ordinary Ark operator checks native
transaction rules and signatures; it does not independently verify Shielded's
Groth16 proofs. A malicious Shielded verifier can seek an otherwise native-valid
operator co-signature for a spend that violates the Shielded state rules; operator
collusion is not required by this design. Bitcoin does not execute the proof
checks either. The current verifier-controlled CSV recovery key can take an
entire pooled resource after its timeout. Note holders have no fractional,
holder-specific pool exit if Shielded disappears.

The multi-party Groth16 ceremony, even if correctly performed, would address
proof-system setup soundness only. It would not make the service's verification
or signing decision enforceable by the Ark operator or Bitcoin, give users their
own keys, or create an independent exit. This experiment is not an accepted
replacement architecture or a completed Shielded design.

The older scaffold under `contracts/` stays disabled: `PairingProduct.check4`
rejects unconditionally. Do not fund those scaffold outputs or remove their guard
solely because the compiler supports pairing products. The runnable profile also
lacks pooled-funds emergency exits, refresh/expiry handling, and a production audit.

Never send user spending keys or note openings to a batcher. The current demo's
service-owned keys and whole-resource CSV recovery are explicit custodial test
arrangements, not acceptable properties of a future user-facing design. A
replacement must put keys in user wallets, make spending validity enforceable
without trusting Shielded, and provide holder-specific recovery when Shielded
is unavailable. A verifier-controlled whole-pool exit does not satisfy that
requirement. Native asset provenance is not established by packet-declared
quantities alone. Emulator signatures do not make the extra opcodes Bitcoin
consensus.

The isolated client-owned lab is a separate synthetic profile. It keeps user
spend/view/native withdrawal secrets in the browser and requires the independent
registered emulator VM to execute the full original Groth16 covenants. The
coordinator receives public descriptors, ciphertext, proofs and receipts. Its
registry and known client recipient directory freeze after registration.

That local enforcement does not establish live Ark inclusion, Bitcoin proof
verification, independent pooled-BTC exits or production readiness. The emulator
extension is undeployed, the proof setup is single-party development material,
and the bounded lab has no external customer deposit rail. Recovery also needs
canonical Ark checkpoints and authentic independently distributed wallet code.
Initial peer identity must be verified independently; the two named lab slots
are not a production recipient discovery or identity system. See
[the exact lab scope](spec/NONCUSTODIAL-LAB.md).

Report issues privately to maintainers in this private repository. Do not reproduce
private application details in public dependency issues or PRs without approval.
No license or publication grant is selected by this scaffold.
