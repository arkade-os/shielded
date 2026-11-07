# sysinfo iOS backport

This is the MIT-licensed `sysinfo` 0.38.4 crate from crates.io, upstream source
revision `97c194d6f0b0e09eee7db22e2128cd303e58a11d`. The original license and
Cargo manifests are retained, together with source, documentation and declared
test/example/benchmark targets. Upstream repository tooling and its standalone
lockfile are omitted.

The only source changes backport upstream commit
[`680e14bcfc2b6244d430805dee47638602244e00`](https://github.com/GuillaumeGomez/sysinfo/commit/680e14bcfc2b6244d430805dee47638602244e00),
“Remove usage of proc_pidinfo on iOS”, to these files:

- `src/unix/apple/process.rs`
- `src/unix/apple/macos/process.rs`
- `src/unix/apple/app_store/process.rs`

The change moves the macOS process-file query into its platform implementation;
iOS reports that unsupported query as unavailable. System memory measurement
and Tor's memory quota remain enabled. Arti 0.48 requires the 0.38 series, which
has no release containing this fix. Remove the patch when Arti accepts a
sysinfo release containing it.
