# Shielded Arkade continuation

Source: [shared conversation](https://chatgpt.com/share/6abd3b85-a030-83eb-bb3b-1369fa813c60), original chat `6abd0c50-f2a8-83ed-829e-e51b3da88dfb` (Shielded Arkade).

## Current work — 2026-10-04

The current work is on `main`; the earlier Shielded PR stack is closed/consolidated and must not be recreated. The managed checkout is `C:\Users\evilk\.codex\worktrees\compact-shielded\shielded`. Preserve unrelated changes in the original `C:\Git\shielded` checkout and the repository's private visibility.

The compact transport keeps proofs and note data offchain and carries a 133-byte binding in native transactions. Fresh Mutinynet bootstrap now continues automatically after the SDK durably registers the existing profile: it writes a fresh-start marker before resource funding, journals each exact request, validates operator signatures and native-asset conservation, and persists a verified response before finalization. Restart resumes only a contiguous receipt-backed prefix. A lost Submit response is reconciled through the exact saved input outpoints and read-only pending-response endpoint; unknown requests are never resubmitted. Unmarked partial legacy funding fails closed. Controlled contract tests cover all four SDK-built spends, restart after two accepted heads, lost Submit response, and accepted-but-uncertain Finalize. These tests do not prove a funded live deployment.

The current local gates recorded by the root are 101 full tests with zero skipped, a successful app build, successful Go and Python checks, the retained 12-case E2E flow, and both Docker lifecycle smoke tests. The generated full E2E report is preserved under ignored `.recovery/final-gates/`; the tracked `validation/e2e.json` was restored to its exact `HEAD` blob. Its sanitized summary records the command, exit status, case/receipt counts, and report hash.

The incident state-only apply succeeded using one encrypted store open/save/close and zero SubmitTx, FinalizeTx, or wallet writes. It preserved the registered profile, keys, four bootstrap heads, and recorded funds; it archived the known rejected transaction identity and idempotency key and cleared only pending journals. The subsequent funded v2 lifecycle completed 20 real transactions across Alice and Bob and BTC and DEMO: four shields, eight seals, four transfers, and four withdrawals. All were accepted and indexed, and the negative scenarios passed. Maximum native transaction weight was 3,436 WU under the 4,000 WU effective cap; the operator advertises 40,000 WU. The native heads then advanced through the 20 settlements as designed. Full evidence is in [validation/compact-mutinynet.json](validation/compact-mutinynet.json), SHA-256 `2104a3f9c5f3051f1076310e7a9f5ea706f6cd607708c0cca08bb1b6cb955185`.

The registered profile, verifier sources, proving artifacts, and keys remained unchanged. Same-image, same-container, same-named-volume restart/replay passed: all 20 previously accepted actions replayed, there were zero new financial actions, Docker inspection matched the saved container/image/mount evidence, and the before/after financial-state digests match. See [validation/compact-mutinynet-restart-replay.json](validation/compact-mutinynet-restart-replay.json), SHA-256 `bbf4c59bad4b0e9e04daafbc16cdcb9510fa40d787488d6833788a91c2aa7aac`.

The authenticated browser UI run passed its checks, replaying 20 cached accepted receipts and inspecting 20 public receipts across Alice/Bob and BTC/DEMO. Authentication, logout, privacy views, and reserves passed; the run recorded zero new financial actions and the financial-state digest remained unchanged. See [validation/compact-ui.json](validation/compact-ui.json), SHA-256 `cb1e6eb4be7487eb76f2e086a1a7dc28ebd63fdde242695ee27c8acaa47042a1`. This validates the cached-receipt UI path, not new funded transactions or a clean first funded bootstrap.

The live 20-action lifecycle started from the already funded resource heads; it is distinct from the fresh-bootstrap continuation contract tests and does not prove a clean first funded bootstrap. The native heads advanced through those settlements as designed. Keep the profile, verifier sources, proving artifacts, and keys unchanged.

This remains a bounded treasury-funded, operator-backed PoC with service-owned demonstration keys and depth-eight trees. It has no customer deposit rail, client-owned key custody, or independent note-holder pool exit. Operator acceptance is not Bitcoin finality. Keep the registered profile, verifier sources, proving artifacts, keys, and encrypted volume unchanged during funded verification; do not bypass network or weight preflight.

The sections below record the September 30 transfer and its evidence. Their
branch layout, test counts and deployment status are historical.

This remains a treasury-backed operator PoC with service-owned demo keys, depth-eight trees and no independent note-holder pool exit. Client-owned CSV/recursive wallets and an external customer deposit rail remain unimplemented.

## Accepted work

Continue the end-to-end PoC here: `.ark` contracts → compiler artifacts → SDK Programs → SDK-built transactions and real Groth16 proofs → actual emulator `Service.SubmitTx`. Showcase BTC and a demonstration token through shield → seal → transfer → seal → withdraw.

Retain separate private-intent and current-state proofs, independent asset conservation, native asset provenance, authenticated lane/vault continuation, stable nullifiers, exact withdrawal recipients, and rejection of unsealed notes and replay. Keep the default VM limits. Root owns architecture and integration; lighter agents handle bounded implementation and verification.

## Recovery completed on 2026-09-30

- Restored the original Git history. `feat/end-to-end-showcase` continues from scaffold commit `ae7a5f5afc01ee0270341691f2d3d67ec0c7a4df`.
- Preserved `main` at `c15e632fba31b10efcdf556e3c5a669c6efe9d1d`, `feat/protocol-design` at `59aed12177aca588e93cb0a9ee9f769e7bc8cffc`, and `feat/covenant-scaffold` at `ae7a5f5afc01ee0270341691f2d3d67ec0c7a4df`.
- With explicit permission, requested the source chat's current files. It supplied `shielded-transfer-20260930.zip` (48,989,064 bytes), SHA-256 `0da8aa7079dbef6a6bc154c21cd9fe37bfb4d22b55e3e72c979fe8192065c3bd`. All 121 manifest file hashes matched before import.
- Imported its circuits, proving keys, SDK adapter, compiled Programs, Go bridge, showcase and tests. Complete originals, Git bundles, provenance and patches remain under `.recovery/current-snapshot/`; the earlier bootstrap is also preserved. A stale nested duplicate was retained in recovery only.
- Existing dirty checkouts elsewhere in `C:\Git` were left intact.

## Local continuation

- Fixed Windows VM executable selection in runtime, engine and tests, compiler selection, and Vite's module-relative path.
- Built compiler PR 124 at `22ee412b91388a9e6c9256d08a6c35e3dbb8c9a3`; all five recompiled PoC artifacts match the transferred fingerprints. `artifacts/compiler-profile.json` records the native build. Transferred Linux provenance remains in recovery.
- Built `bin/shielded-vm.exe` from `tools/vm`. The bridge pins emulator modules at `d928b6ed57ee`, uses actual `Service.SubmitTx`, native asset/BTC validation and default VM budgets, and returns emulator co-signatures.
- Added native stale-state/rebase regression coverage: a competing settlement rejects the stale transaction without mutation; rebase preserves the exact private proof/signals and regenerates the transition proof before native settlement.
- Corrected the unsupported relayer wallet and required second seal before withdrawal; actual synthetic funding is displayed separately from private balances.
- Updated run instructions and ignore rules to include the exact eight runtime proving files. CI retains Python checks and adds the Node/Go PoC gates. The new GitHub CI job has not run remotely.

## Verification

- Research model: 13 passed; Python unittest: 14 passed; bootstrap safety: six passed.
- Compiler: six pairing-product feature checks, one pairing check, ten actual Go VM pairing-product variants passed.
- Upstream emulator: 47 pairing checks/subtests and nine checkpoint checks passed.
- Go bridge: `go test ./...`, `go vet ./...`, build and `--info` passed.
- `npm test`: 11 passed, zero failed/skipped. `npm run build`: passed.
- `npm run test:primitives`: passed with real proofs.
- `npm run test:e2e`: 12 cases passed with ten VM-accepted transactions, BTC/token backing equality, recovery, replay/tamper rejection without mutation, native rebase and API key omission. Report: `validation/e2e.json`.
- Browser: both complete asset flows ran sequentially, with ten native accepted transactions, exact Bob payouts and two rejected attacks. Primitives and verified withdrawal views were inspected. Report: `validation/browser-validation.json`; screenshot: `validation/showcase.jpg`. The server remains available at `http://127.0.0.1:8787`.
- Logs and pre-native-compile artifacts remain under `.recovery/`.

## Upstream and publication

| Dependency | PR | Verified head | Recovery status |
| --- | --- | --- | --- |
| Compiler | [124](https://github.com/arkade-os/compiler/pull/124) | `22ee412b91388a9e6c9256d08a6c35e3dbb8c9a3` | Open draft; checks pass; CodeRabbit skipped draft review |
| Emulator | [164](https://github.com/arkade-os/emulator/pull/164) | `2eb230afba6bc033a24152f9958e8fbdd0866476` | Open draft; checks pass; CodeRabbit skipped draft review |

Both PRs are attached here. No formal/inline feedback was present at recovery; green CI is not review completion. Recheck all review channels and exact heads before publication.

The user explicitly authorized creating the private repository and pushing this work. [`arkade-os/shielded`](https://github.com/arkade-os/shielded) was created empty and verified private. The preserved branch stack is `main` (`c15e632`), `feat/protocol-design` (`59aed12`), `feat/covenant-scaffold` (`ae7a5f5`), then `feat/end-to-end-showcase` from `ae7a5f5`. Git branch refs and PR checks identify the published revision; local delivery evidence is retained under `.recovery/publish/`. Keep the historical refs intact and the repository private.

The compiler and emulator dependency PRs above remain separate upstream work. Their green checks do not mean they received human or bot review; recheck formal reviews, inline comments, and issue comments before any merge.

## Bounds

Synthetic local genesis, deterministic signing keys and single-party demo proving keys; one lane, one input/two output notes, depth-eight trees, low-bit nullifier collisions rejected. Emulator co-signing does not establish live arkd/Bitcoin settlement. Persistence, production setup, refresh/expiry and emergency exits remain outside this PoC. See `spec/POC-PROFILE.md`, `HANDOFF.md` and `README.md`.
