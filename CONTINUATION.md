# Shielded Arkade continuation

Source: [shared conversation](https://chatgpt.com/share/6abd3b85-a030-83eb-bb3b-1369fa813c60), original chat `6abd0c50-f2a8-83ed-829e-e51b3da88dfb` (Shielded Arkade).

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
