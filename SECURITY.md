# Security status

This is unaudited research software. The runnable bounded profile is under
`contracts/poc/`; its live adapter accepts Mutinynet test coins only. Its server
stores both demonstration users' wallet secrets in an encrypted checkpoint, so
the operator can access their notes. It is not a private, noncustodial wallet service.

The older scaffold under `contracts/` stays disabled: `PairingProduct.check4`
rejects unconditionally. Do not fund those scaffold outputs or remove their guard
solely because the compiler supports pairing products. The runnable profile also
lacks pooled-funds emergency exits, refresh/expiry handling, and a production audit.

Never send spending keys or note openings to a batcher. Do not add a pooled-funds
owner CSV leaf, administrative dissolution key, or a refresh path that silently
forgets packet state. Native asset provenance is not established by packet-declared
quantities alone. Emulator signatures do not make the extra opcodes Bitcoin consensus.

Report issues privately to maintainers in this private repository. Do not reproduce
private application details in public dependency issues or PRs without approval.
No license or publication grant is selected by this scaffold.
