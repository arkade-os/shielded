# Required compiler extension: a pairing product, not another VM opcode

Compiler snapshot: `df116dd98baec0530f3a872755d6d3ffa2fa6c7e`.

The current `ecPairing(g1x, g1y, g2xc1, g2xc0, g2yc1, g2yc0, curve)`
syntax emits six coordinates, the literal `1`, the curve, and `OP_ECPAIRING`.
That is a one-pair identity test. Its boolean result is NOT a GT value.
Four calls joined with `&&` do not implement Groth16's product equation.

## Proposed source API — tracked by compiler PR #124

```
ecPairingProduct(int[6*N] coordinates, int curve) -> bool
```

This is descriptive type notation for the compiler builtin, not generic-array
syntax to put in an `.ark` declaration. The builtin accepts a fixed scalar int
array whose length is a nonzero multiple of six. Derive `N` at compile time,
require `1 <= N <= 16`. The compiler PR accepts an integer curve operand; the
current emulator supports pairing only for 2 (BN254) and rejects other curves.
The API need not expose arrays of structs, which the compiler does not support.

Each six-value block is:

```
g1_x, g1_y, g2_x_c1, g2_x_c0, g2_y_c1, g2_y_c0
```

For the 24-value Groth16 call, lowering must leave:

```
<coords[0]> ... <coords[23]> 4 2 OP_ECPAIRING
```

on the actual VM stack, using the existing stack-variable machinery. Do not
emit an opaque placeholder that the runtime might resolve without validation.

The eventual adapter body would be the following. Do not activate it in this
workspace until actual circuits, pinned keys, native integration, and independent
review are complete. Compiler support alone is not enough:

```ark
pragma arkade ^0.1.0;
library PairingProduct {
    function check4(int[24] coordinates) bool {
        return ecPairingProduct(coordinates, 2);
    }
}
```

## Implementation touch points

- `src/parser/grammar.pest`, `src/parser/expr.rs`, `src/parser/crypto.rs`: builtin
  syntax, parser, and diagnostics.
- `src/models/mod.rs`: expression representation and expression-child traversal.
- Type checking and reference validation: exact scalar-array shape, curve type,
  bounded compile-time term count, valid arguments even in short-circuited code.
- Existing helper-inlining, constant resolution, struct/array lowering and loop
  visitors must retain every coordinate expression. Adding parsing/emission alone
  is not enough.
- `src/compiler/expr.rs`: evaluate/flatten each argument once, emit coordinates
  in the documented order, then constant count and curve, then the opcode.
- Tests must execute the compiled artifact through the emulator, not only check
  that the expected opcode appears in an assembly string.

## Required regression cases

Use a real generated Groth16 fixture for the EIGHT-public-input digest relation,
not the emulator's one-input square-root fixture as a shielded circuit.
Verify a valid proof, wrong digest limb, swapped G2 components, tampered A/B/C,
negative/non-canonical/out-of-field coordinates, invalid G2 subgroup, invalid
scalar, zero/excess term count, and array expressions inside inlined helpers.
The VM's point/subgroup validation must remain in force.

The `Groth16Key` constructor must contain the real key's IC0..IC8 and negated
beta/gamma/delta G2 points. Never accept a spend-time-selected verification key.
The circuit must constrain its reconstructed statement bytes to all eight digest
limbs. Merely declaring unused public inputs is not binding.

This source package does not implement the compiler extension, prove a circuit,
or assert that a full shielded circuit fits current VM resource limits.
