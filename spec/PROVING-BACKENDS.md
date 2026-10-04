# Proving backends

`packages/protocol/src/proofs.ts` separates witness proving and verification from the wallet kernel. Node and browser factories accept an optional `ProofBackend<Groth16Proof>`; the default adapter uses local snarkjs and the existing intent and transition artifacts. A proof statement binds backend/version, curve, circuit relation, verification-key digest, profile, domain, exact public-signal count and ordered canonical field elements. The kernel checks the descriptor and statement before admitting a result. The browser default also verifies pinned size and SHA256 of each downloaded proving artifact before using private witness data. An authentic independently distributed wallet bundle is still required. The registered native VM independently verifies actual proofs and effects. A service assertion does not replace native enforcement.

The existing prepared-settlement wire and native covenants remain Groth16-only. The generic backend interface permits a different proof representation at the API boundary, but another backend cannot be substituted into a funded profile. Verification keys and verifier behavior are immutable. This release includes no RISC Zero or Cairo implementation.

## RISC Zero migration

A future implementation should:

1. Implement the intent and transition relations in a pinned guest, preserving note ownership, nullifiers, root transitions, conservation and native payout binding. Test equivalence with the current circuits, including every rejection case.
2. Pin guest image ID, receipt/control version and the exact wrapper verification key. A receipt must authenticate execution of that guest, not merely any guest that emitted an acceptable journal.
3. Define a canonical public journal encoding for the same domain, roots, nullifiers and native effects. Bind its digest and guest identity into native verification. Prove byte ordering and field conversions with shared test vectors.
4. Add a receipt adapter for the published RISC Zero Groth16 wrapper and measure actual native VM support, compute, transaction weight and proof-sidecar size. The existing Groth16 opcode is not evidence that the wrapper's input layout and curve are compatible.
5. Create a new immutable pool/profile with its own verifier programs. Migrate only by an explicit supported withdrawal/deposit path; never modify a funded verifier in place.

RISC Zero's published ceremony covers its exact generic STARK-verification wrapper. Changing the guest can reuse that setup if the same reviewed wrapper remains in use. It does not reuse our current custom-circuit Groth16 phase 2. Private proving must remain local or on a prover the user accepts seeing witness secrets. Remote proving is not private merely because its result is a zero-knowledge proof.

## Cairo

Cairo can express a similar program and prove execution using STARK tooling. Current Stwo Cairo is transparent and does not need an MPC setup, but its default proof mode is not zero knowledge. Privacy therefore needs an explicitly suitable proof configuration. Its proof also requires an appropriate native verifier or a reviewed wrapper plus a new pinned profile; it cannot pass our existing Groth16 verifier unchanged.

Primary references: [RISC Zero ceremony](https://dev.risczero.com/api/trusted-setup-ceremony), [RISC Zero security model](https://dev.risczero.com/api/security-model), [Stwo Cairo](https://github.com/starkware-libs/stwo-cairo).
