# Compiler-specific adaptation and implementation status

The architecture keeps immutable configuration and genuine resource identities in
constructors. Mutable roots/counters live in creator-output-indexed authenticated
packets. This replaces the architectural document's suggestion of dynamically
reconstructing next-state locking programs: the pinned compiler rejects spend-time
values in `new Contract(...)`.

A transaction-local verifier at input 0 checks the private intent and public state
transition. Each lane/vault authenticates both its actual locking program and the
selected `apply` or `seal` closure, and retains its identity asset in its unique
successor. It is not a global singleton verifier.

The prior source sketch had unparenthesized computed builtin operands. These have
been replaced with local bindings. All four entrypoints compile in the pinned
compiler, including the deliberately disabled batch verifier. Both optimized and
unoptimized compilation are covered by `scripts/check_contracts.py`.

No real circuits or native VM/transaction integration are provided. There is no
refresh mode. The privacy proof, conservation rules, and full native-effect mapping
are requirements in CIRCUIT-RELATIONS.md, not claimed completed implementations.

The provided profiles are bounded (8 inputs, 12 outputs), not a sixteen-lane seal.
Compiled artifact size and instantiated script/packet/stack budgets must be checked
before increasing any bound. Output state must survive every authorized lineage
transition, including future refresh implementations.
