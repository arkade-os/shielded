# Arkade shielded protocol — private research workspace

**Experimental. Do not deploy or fund these contracts.**

This workspace separates private multi-asset notes, sharded spend-state VTXOs,
and native BTC/asset reserve vaults. It contains a design, a transparent reference
model, and a fail-closed `.ark` scaffold — not a working private payment system.

## Review branches

- `feat/protocol-design`: architecture, security boundaries, circuit requirements,
  and transparent state-machine model. Review against `main`.
- `feat/covenant-scaffold`: packet-backed lane/vault contracts, statement encoding,
  and wire tests. Review against `feat/protocol-design`.

## Dependencies

Generic upstream work is separate from the private application:

- https://github.com/arkade-os/compiler/pull/124 — pairing-product source interface.
- https://github.com/arkade-os/emulator/pull/164 — pairing-product budget regressions.

The scaffold compiles with upstream compiler snapshot
`df116dd98baec0530f3a872755d6d3ffa2fa6c7e` because its pairing adapter deliberately
rejects all calls. Merging the compiler PR does not make this application deployable.

## Local checks

```sh
python model/reference_model.py
python -m unittest discover -s tests -v
python scripts/check_contracts.py --compiler /path/to/arkadec
```

Compilation checks cover both optimization settings. They are not VM execution,
proof verification, or an audit. The transparent model proves no cryptographic
security property. Generated artifacts go to `build/` and are not committed.

## Still required

Actual private-intent and native-transition circuits; setup/verification keys;
complete authentic native-asset provenance and checkpoint adapter; executable VM
integration; packet allocation; data-availability/recovery services; refresh and
expiry handling; emergency-exit analysis; and independent review.

The note/UTXO architecture is in `spec/protocol-design.md`. The compiler-specific
packet-state adaptation is described in `spec/IMPLEMENTATION.md`. Earlier
brainstorms are not normative. Keep protocol-specific source and discussion in
this private workspace until explicitly approved for publication.
