# Shielded Arkade transfer snapshot — 2026-09-30

This is the CURRENT working tree, not a release. No changes were committed, merged, published, or deleted to make this snapshot. Continue in C:\Git\shielded. The receiving chat should orchestrate/design and use lighter subagents as requested by the user.

## Restore and run

The `shielded/` directory is the authoritative complete working tree, including untracked/unvalidated implementation. Copy its CONTENTS into C:\Git\shielded. Do not overwrite it with a clone of the bundle: the main bundle contains only prior committed history. To retain history, clone `handoff/shielded.bundle` elsewhere, check out `feat/end-to-end-showcase`, then overlay the snapshot contents. See `handoff/git-state.json` for exact branch/commit/status.

Fastest exact execution environment is Linux/WSL with Node 24 (used: 24.19.0). Included compiler and VM binaries are Linux amd64. In WSL, use a Linux checkout (or /mnt/c/Git/shielded), restore executable permissions with `chmod +x bin/arkadec bin/shielded-vm`, then run each command separately:

```
npm ci
npm test
npm run build
npm run test:primitives
npm run test:e2e
npm run dev
```

Open http://127.0.0.1:5173 (API 127.0.0.1:8787). `npm run demo` runs the scripted flow. Proving takes seconds to tens of seconds per action. Use `node --import tsx`, as the tsx CLI encountered forbidden IPC sockets in the original environment. Reset is an in-memory local fixture reset.

Native Windows has NOT been validated. `npm run vm:build` builds shielded-vm.exe with Go >=1.26.6, but `src/engine.ts` currently hardcodes bin/shielded-vm; update that path for native Windows. Precompiled contract JSON is portable; compiling contracts on Windows requires an appropriate compiler binary and ARKADEC_PATH. WSL avoids these immediate portability edits.

## Architecture and acceptance

Canonical executable contracts are contracts/poc/*.ark, compiled by tools/compile.ts into artifacts/poc_*.json, loaded through SDK programFromArtifact, instantiated as SDK Programs, and used by the SDK adapter to build multi-input offchain/checkpoint PSBTs and packets. Runtime submits these to the real Go emulator Service.SubmitTx, with native asset validation against actual attached source transactions before execution/co-signing. The app and showcase consume this same engine. This is not a mocked VM success path.

Proof primitives are packages/protocol/src and circuits/*.circom. Private intent has 25 public inputs, transition has 30. Two real Groth16 equations use compiler ecPairingProduct; immutable verification-key hashes are contract constructors, full keys are witnesses. Default VM compute/script limits remain intact. SDK OP_PUT omission is patched reproducibly by postinstall tools/patch-sdk.mjs and patches/sdk-op-put.patch.

## Evidence and current failures

validation/e2e.json records `passed: true` and receipts for real compiler→Program→SDK→emulator BTC/token shield, unsealed rejection, seal, private transfers, exact native withdrawals, encrypted recovery, replay rejection, public-effect tamper rejection by VM, unchanged state after rejection, and API key sanitization. It is the current positive report. circuits/build/primitive-smoke.json records real proof-only full flow including stale-state rejection and rebase with unchanged private proof. Transfer-time npm test passed all 10 tests including actual compiled covenant substitution rejection. Previously npm build passed; Go bridge native validation cases and vet passed. No full end-to-end rerun was awaited for this transfer request.

validation/demo-run.stderr is an EARLIER failed run, retained deliberately. First gate OP_VERIFY failure was native asset identity txid byte order: SDK packet display order differs from Go chainhash internal order. Current addAssetArgs reverses constructor txid only; packet order stays SDK canonical. Later e2e report is positive. Other addressed integration issues: missing SDK PUT opcode; script >10k from inline VKs; >50 EC multiplications; projective fold coordinates; genesis provenance/value accounting. Diagnostics remain in tools/vm/debug.go.

Full live arkd/Bitcoin/regtest settlement has not been run. Emulator co-signing is not Bitcoin settlement. Synthetic trusted genesis/demo funding is explicit. Browser visual QA was blocked by failed Chromium download; UI builds, but final visual and interactive browser QA remains pending. Native Windows, persistence/restart recovery, emergency exits, expiry/refresh, concurrency stress, and production cryptographic/security review remain unvalidated. Retain all current work before redesigning.

## Essential artifacts and regeneration

Essential to run without repeating setup: package-lock.json; contracts/poc; artifacts/poc_*.json; circuits/build/{intent,transition}.zkey; matching .vkey.json and *_js/*.wasm; all source; bin/shielded-vm (or rebuild). Verification keys and proving keys MUST match the WASM and circuit source. Local setup is fresh random single-party demo setup, not production MPC. Public deterministic demo keys are fixtures, not credentials.

Build caches, node_modules, app/dist, R1CS/SYM, initial zkeys and ptau were excluded. Regenerate UI via npm run build. Regenerate proof artifacts via npm run setup (expensive; changes keys), then instantiate a fresh runtime with the new keys. Regenerate contracts via npm run compile using bundled Linux arkadec or ARKADEC_PATH. Rebuild emulator bridge via npm run vm:build with Go1.26.6. No system Go toolchain is bundled. Read circuits/README.md, spec/POC-PROFILE.md and tools/vm/README.md before extending.

Bounded profile: one lane, one input/two outputs, 48-bit amounts, depth-8 note/history trees, low-8-bit spent dictionary rejecting collisions, one boundary asset/direction per settlement. Pending notes cannot spend until seal; seal never clears nullifiers. Local demo wallet/display filter is not process isolation; encrypted logs are currently in memory. Pooled reserve owner bypass is absent.

## Precise pins and upstream work

SDK npm 0.4.77, source 33ac4e5b91af9ea2484e4ef204a3aad2c4fbe908. Source PUT addition and untracked regression test are in handoff/ts-sdk-working.patch and sdk-arkade-put.test.ts; postinstall patch is in main tree.

Emulator packages v0.0.0-20260925153657-d928b6ed57ee; full checkout d928b6ed57ee7ac3a2e070f2ce078bb4a4a1af02. No dirty upstream emulator changes; native asset validation/trace integration lives in main tree tools/vm, with go.mod/go.sum. Ark-lib v0.8.1-0.20260901090427-f863e4847193.

Compiler source bundle includes pairing-product branch (PR124) at 22ee412; upstream master checkout df116dd98baec0530f3a872755d6d3ffa2fa6c7e is NOT the executable feature build. Included binary provenance is artifacts/compiler-profile.json: recorded executable source commit 6f919c57ae84039a8c80423cecc9e536aef153d6; binary SHA256 2188d4ca2a07ba17571695081535120eb17ce15ae56ef0230cf41ae68241521b. handoff/compiler-provenance includes original source archive, binaries, commit.txt and worktree.patch. Use those bytes for exact current reproduction; use pairing-product branch for further compiler work. Empty upstream patches mean no dirty edits, not missing feature branches.

Main committed baseline ae7a5f5afc01ee0270341691f2d3d67ec0c7a4df; current branch feat/end-to-end-showcase. Most end-to-end implementation is UNTRACKED and present only in overlaid snapshot. Original contracts/*.ark are a separate fail-closed architecture scaffold; do not confuse with executable contracts/poc. The nested shielded/shielded/circuits duplicate is stale agent path fallout, retained for transfer; canonical circuits are shielded/circuits. Original README may describe the old scaffold; this handoff and POC-PROFILE describe current implementation.

All npm pins resolved exactly in package-lock; ffjavascript package range was recently upgraded to ^0.3.1, lock pins 0.3.1 to harmonize snarkjs/circomlibjs curve caches. snarkjs0.7.6, circomlib2.0.5, circomlibjs0.1.7, circom2 npm0.2.23, React19.1.1, Vite7.1.4; see package.json and locks for all components.

## Next steps

1. Restore history plus overlay, npm ci, inspect current report, rerun checks in receiving environment.
2. Confirm native full acceptance flow remains passing after last unvalidated edits; add actual native rebase/concurrency test (proof-only rebase already passed).
3. Run showcase in browser; exercise recovery/rebase/replay/tamper and inspect source/Program explorer.
4. Fix Windows paths if using native Windows; clean stale duplicates only after keeping snapshot.
5. Update README, pin ffjavascript range if desired, review invariants and bounded limitations; expand live regtest settlement/persistence separately.

SHA256SUMS.txt inventories every payload file. Git bundles preserve available history without credentials/remotes from local .git config. Nothing was published or merged.
