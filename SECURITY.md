# Security status

This is an unaudited, fail-closed research scaffold, not production software.
Do not place funds under any generated output. `PairingProduct.check4` rejects
unconditionally; removing that guard requires a separately reviewed implementation
and cannot be justified solely by upstream pairing support.

Never send spending keys or note openings to a batcher. Do not add a pooled-funds
owner CSV leaf, administrative dissolution key, or a refresh path that silently
forgets packet state. Native asset provenance is not established by packet-declared
quantities alone. Emulator signatures do not make the extra opcodes Bitcoin consensus.

Report issues privately to maintainers in this private repository. Do not reproduce
private application details in public dependency issues or PRs without approval.
No license or publication grant is selected by this scaffold.
