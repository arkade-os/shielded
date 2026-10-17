# Compiler covenant variant

This draft preserves the `.ark` port as a reproducible comparison with the Go covenant builders. The service still uses `shielded-vm -rollup-leaves` and the existing Go programs. The compiler variant is selected only inside the Go tests.

## Sources

| File | Purpose |
| --- | --- |
| `contracts/compiler/rollup.ark` | Readable eleven-slot batch covenant, with verification keys as constructor inputs |
| `contracts/compiler/generate.py` | Optimized batch source generator: unrolled locals and inline verification-key coordinates, for spend and join batches |
| `contracts/compiler/reserve.ark` | Asset reserve covenant |
| `contracts/compiler/renew.ark` | Experimental renewal source; compilation only |

The generator accepts the exact public verification-key coordinates used by each test world. It emits `.ark` source, which `arkadec` compiles before the harness assembles its artifact with the emulator's opcode table. The assembler supports BN254 integers beyond signed 64-bit and preserves the literal byte `0x00`. The harness reorders the existing witnesses into the compiler's proof-and-slot ABI.

The reference batch source is compiled as a syntax check. Execution comparisons use the optimized generated source. Reserve execution uses the compiled reserve leaf; renewal and exit execution continue using the existing implementation.

## Run

Requires Node 24, Go 1.26.6, Python 3 and Rust/Cargo. The compiler is pinned to `89a1ff73b24441699095c9135d6429f7dc6cb6ab`; its version string alone does not identify the code generator.

```sh
git clone https://github.com/arkade-os/compiler.git .deps/compiler
git -C .deps/compiler checkout 89a1ff73b24441699095c9135d6429f7dc6cb6ab
SHIELDED_COMPILER_SOURCE=.deps/compiler npm run test:compiler
```

On PowerShell, set `$env:SHIELDED_COMPILER_SOURCE='.deps/compiler'` before running `npm run test:compiler`. `SHIELDED_PYTHON`, `GO`, `CARGO` and `CARGO_TARGET_DIR` can select the installed tools and build directory. The runner rejects a different compiler commit or checkout changes, builds with `--locked`, and prints the compiler binary's SHA256.

The compiler workflow runs this command independently of the existing checks. The ordinary Go suite retains its live weight assertions. In compiler mode the proof, state, BTC, asset and reserve attack cases execute against compiled leaves, including the real snarkjs proof fixture. A separate comparison measures the compiler weight blocker without relaxing the production admission limit.

## Compare a compiler change

The default run requires the pinned clean compiler checkout. Use a separate checkout and explicit candidate mode to test another revision or local code-generator changes:

```sh
SHIELDED_COMPILER_SOURCE=/path/to/compiler \
SHIELDED_COMPILER_OUTPUT=.recovery/compiler-candidate \
npm run test:compiler -- --candidate
```

Candidate mode keeps the proof and attack checks, reports the measured weight, and permits improvements over the pinned size baseline. The output records the compiler commit, working-tree status, tracked diff hash, hashes of untracked files, and the built executable hash. The executable hash identifies the tested build; a dirty checkout's metadata is not a substitute for sharing its complete source changes.

The artifact analyzer compares emitted instruction mixes without conflating token counts with script bytes or transaction weight:

```sh
python3 -I tools/compiler/analyze.py baseline-artifact.json candidate-artifact.json
```

It reports push counts, integers beyond signed 64-bit, and per-opcode deltas including `OP_PICK`, `OP_ROLL`, `OP_PUT`, `OP_NIP`, `OP_ECMUL` and `OP_ECPAIRING`. Use the Go comparison for the actual byte and weight effect of a change. CI uploads the generated vectors under `compiler-vectors-<commit>`.

## Vectors

`contracts/compiler/vectors/` contains the checked-in baseline. `weights.json` covers all six transaction shapes. `kind-0/` and `kind-1/` each contain generated `.ark` source, public VK bindings, Go and compiler script hex, reserve script hex, operation metadata, and a transfer transaction/witness vector. The transfer vectors use seed-11 synthetic test proofs; the existing snarkjs fixture is exercised separately by the VM suite. No signing key or trapdoor scalar is exported.

`manifest.json` hashes the eighteen stable files with CRLF normalized to LF. The pinned runner compares regenerated files with those hashes. Candidate runs report changed vectors without requiring byte identity. The raw compiler artifacts (`batch.raw.json`) remain in the generated output and CI artifact: their timestamps and temporary source paths are intentionally excluded from the stable snapshot.

Regenerated files default to `.recovery/compiler-variant/vectors/`. To compare instruction mixes from two runs:

```sh
python3 -I tools/compiler/analyze.py \
  .recovery/compiler-variant/vectors/kind-0/batch.raw.json \
  .recovery/compiler-candidate/kind-0/batch.raw.json
```

`transfer-vector.json` records an unsigned transaction containing the emulator extension, the logical witness in bottom-to-top order, and its previous outputs/parent transaction. Its weight field uses the test's signed transaction construction with two 64-byte signature placeholders, the leaf, and its control block for each input. This is an execution fixture and size vector, not a funded transaction or a submitted spend.

## Optimization target

The comparison executes the same eleven-slot BN254 statement, with 41 `OP_ECMUL` operations and one 16-pair `OP_ECPAIRING`. Its statement prefix is `SH`, version 2, batch kind 0 or 1, and slot count 11; the old state and new state/data commitment remain unchanged. The generated source moves the scalar modulus into one local and uses unrolled accumulators to reduce repeated constants and field reassignment.

At the pinned compiler, the generated leaf is 6,077 bytes against 4,795 bytes from Go for the comparison keys. Compiling the readable array/loop reference produces more stack copying. The useful targets are last-use consumption of proof/slot array elements, pairing operand staging, and the resulting `OP_PICK`/`OP_NIP` cleanup. Changing curve operations or reducing the slot count would change the comparison's premise.

| Transaction shape | Go WU | Compiler WU | Limit |
| --- | ---: | ---: | ---: |
| Transfers only | 34,788 | 39,916 | 40,000 |
| Deposits, payouts and an asset | 38,066 | 43,202 | 40,000 |
| Eleven BTC deposits | 39,694 | 44,822 | 40,000 |
| Eleven BTC payouts | 38,260 | 43,388 | 40,000 |
| Reserve and eight deposit inputs | 39,594 | 44,730 | 40,000 |
| Join batch, no legs | 34,788 | 39,916 | 40,000 |

These measurements include the compiled reserve's additional two bytes where present. The Go suite uses the signed Ark transaction layout and the emulator packet inside its extension output; leaf size alone is not the admission weight. See the exported weight matrix for regenerated measurements.

## Adoption blockers

- The optimized batch script is larger than the Go program. Pure-transfer batches barely fit the 40,000 WU limit; representative deposit, payout and asset batches exceed it. The comparison test records those transactions and requires the current blocker to remain visible.
- The compiler uses byte equality where the Go program uses numeric equality, so some rejected attacks have a different opcode diagnostic. One missing-token attack is rejected earlier by the batch leaf's asset lookup. These are narrow diagnostic allowances; the attacks must still fail.
- The renewal prototype encodes the head's output index in four bytes. The current signing digest concatenates its minimal script-number representation. The prototype cannot replace the existing renewal leaf with the current signatures.
- The harness assembles artifacts in Go. It does not demonstrate the SDK's direct artifact loading or a funded Arkade admission and settlement lifecycle.
- Changing leaf bytes changes the pool's programs hash and Taproot address. Adoption needs a new genesis; existing pools retain their pinned programs.

Compiler stack consumption and pairing operand staging must improve before this batch variant can cover the current eleven-slot boundary batches. No slot reduction, circuit change, ceremony, pool migration or deployment is included.
