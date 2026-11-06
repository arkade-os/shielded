# Native Shielded wallet

The Tauri application bundles the existing wallet frontend. Rust owns its embedded Arti client, private network requests, streams and sockets. The bundled renderer has no permission to connect to remote hosts directly. Remote navigation and additional windows are denied.

The native renderer also disables WebRTC peer connections, which could otherwise introduce ICE/STUN traffic outside the HTTP and WebSocket transport. Workers and remote assets remain subject to the bundled CSP.

The native build targets Windows, Linux, macOS, Android and iOS. Source support and the CI definitions do not establish that each target has been built or tested on a physical device. Record matching build and runtime evidence before distributing a release.

## Build

Use Node 24, the repository's locked npm dependencies and a Rust toolchain meeting `src-tauri/Cargo.toml`. Build desktop packages on the matching operating system. Windows requires Microsoft C++ build tools and WebView2; Linux requires WebKitGTK 4.1 and its development packages; macOS and iOS require Xcode.

```sh
npm ci
node tools/native-build.mjs desktop dev
node tools/native-build.mjs desktop build
```

The wrapper generates the platform icons from `src-tauri/icon.svg` when needed. The Tauri build invokes `npm run native:frontend`; generated assets, icons, platform projects and binaries are ignored.

Windows packages bundle the offline WebView2 installer. Setup does not download the browser runtime directly before Tor is available. This increases the package size; build-time dependency downloads and Tor's own relay/bootstrap connections are outside the wallet request tunnel.

For Android, install the Android SDK/NDK, set `ANDROID_HOME`, `NDK_HOME` and `JAVA_HOME`, and install the Rust Android target. The initializer retains an existing generated project and disables app backup and device transfer before each build.

```sh
npm run native:android -- init --ci
npm run native:android -- build --debug --apk --target aarch64
```

For iOS, run on macOS with Xcode and the appropriate Rust target:

```sh
npm run native:ios -- init --ci
npm run native:ios -- build --debug --target aarch64-sim --no-sign --ci
```

The simulator example targets an Apple Silicon Mac. Intel Macs use `x86_64`. Device distribution requires the usual Apple signing setup; no signing credentials or release publication are configured here.

Use the npm scripts for mobile initialization. Tauri uses that package-manager context and the canonical `tauri` script to generate the Rust callbacks invoked from Xcode and Gradle.

Arti currently pins a `sysinfo` release that calls macOS-only process APIs on iOS. `src-tauri/vendor/sysinfo` backports the upstream iOS fix while retaining the pinned release and real memory metrics. Its `README.shielded.md` records the source and patch; remove this override when Arti accepts a fixed release.

## Native boundary and storage

Only the bundled top-level `main` window can call the private transport and seed commands. Both the Tauri capability list and command-side origin checks enforce that boundary. The native marker is immutable and carries the fixed pool origin. The native host does not load a remote wallet website with native permissions.

The seed uses a fixed, bounded native vault record, through `plugin:shielded-platform|secret_get` and `secret_set`. Windows uses Credential Manager, macOS uses Keychain and Linux uses Secret Service. Android encrypts the seed using an Android Keystore AES-GCM key. iOS uses a nonsynchronizing Keychain item with `WhenUnlockedThisDeviceOnly` accessibility. A locked or broken vault is an error; it is not treated as an empty wallet. Linux requires a working Secret Service provider at runtime.

The vault protects the seed at rest. The frontend still receives it while the wallet is open. Notes, checkpoints and pending-operation state retain the wallet's repository storage and recovery semantics. Keep the recovery phrase and retain app data while outstanding swaps are unresolved; a seed-only backup is not a complete pending-swap backup.

## Isolation and lifecycle

Tor is required for native wallet networking. Bootstrap failure does not fall back to a direct connection. Privacy scopes bind connection ownership to the wallet operation or watched item; unrelated scopes must not share HTTP pools or private subscriptions. DNS names are resolved through Tor. Renewing a Tor circuit cannot remove identifiers already shared in request content or guarantee different exit addresses.

HTTP responses are bounded to 64 MiB. The pinned [genesis-4 proving keys](https://github.com/arkade-os/shielded/releases/tag/rollup-genesis-4-keys) fit this limit (join: 14,042,110 bytes; spend: 8,225,922 bytes). A future key release above that limit requires a bounded download path and mobile memory validation before adoption; increasing the limit alone would multiply buffering through IPC and the prover.

On Android pause and iOS resignation of active status, Tauri emits a native suspension event. The Rust host immediately pauses the transport, invalidates active scopes and cancels network work without depending on JavaScript running. The renderer must bootstrap and recreate its scopes after resumption. Window destruction also pauses the transport.

These controls hide the user's network address from wallet endpoints and separate transport contexts. Amounts, invoices, reused scripts, shared request identifiers and timing may still correlate activity. Tor does not provide protection against every observer or eliminate application-level links.

Native pool admissions are journaled before dispatch. Unknown submissions retain both their note nullifiers and deposit outpoints across restart, and cannot be replayed automatically. A generic `dropped` status also remains unresolved: an abandoned batch can later be adopted and included. Matching inclusion or a proven pre-admission refusal retires the hold. The wallet displays a pending-outcome notice while those inputs remain reserved. Keep app data; manually deleting the journal discards this protection.

Private providers, proof downloads, pool calls, LNURL and swap transports are bound to the unlocked session that created them. Retired calls cannot acquire a later session's generation. Historical script watches beyond the bounded live-stream budget use separate per-script polling; scripts are never grouped to avoid the limit.

## Validation recorded on November 6, 2026

- Windows debug NSIS packaging succeeded. The bundled app reached the create/restore screen with no seed created; a second launch exited successfully with one native process remaining.
- A live Rust smoke test bootstrapped Tor, read the pool through two isolated handles, received `IsTor=true` from the Tor Project and exercised cancellation, pause and stale-generation rejection.
- The full Node suite passed 1,187/1,187 tests, native Rust passed 21/21, and TypeScript, browser/SDK builds and four host/build-policy checks passed. The bounded TLA model passed and six guard mutations produced their intended counterexamples.
- Android/iOS source and CI targets are present. Android SDK/device, macOS/Xcode, physical mobile runtime, funded wallet flows and a complete packaged-process packet-capture audit remain unverified here. The setup-screen check does not establish those gates.

## Checks and release gates

```sh
node --test tools/native-host.test.mjs
node tools/native-build.mjs icons
npm run native:frontend
cargo test --manifest-path src-tauri/Cargo.toml --workspace --locked
```

The native workflow builds matching desktop packages, an Android APK and an unsigned iOS simulator application. Before release, exercise cold start, unavailable Tor, interrupted bootstrap, multiple concurrent scopes, streaming cancellation, suspend/resume, seed persistence, restore and pending swaps in an installed application. Capture network traffic to confirm the renderer cannot bypass Tor, including DNS and WebSocket paths. A passing compile or configuration test alone does not prove those properties at runtime.
