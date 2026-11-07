# Native Shielded wallet

The Tauri application bundles the existing wallet frontend. Rust owns its embedded Arti client, private network requests, streams and sockets. The bundled renderer has no permission to connect to remote hosts directly. Remote navigation and additional windows are denied.

Web and native use the same `RollupWallet` screen and `WalletOnboarding` create/restore flow. The native wrapper supplies the vault, Tor transport and session lifecycle; the browser keeps its existing storage and networking. Browser onboarding does not start or claim an embedded Tor connection.

The native renderer also disables WebRTC peer connections, which could otherwise introduce ICE/STUN traffic outside the HTTP and WebSocket transport. Workers and remote assets remain subject to the bundled CSP.

The native build targets Windows, Linux, macOS, Android and iOS. Source support and the CI definitions do not establish that each target has been built or tested on a physical device. Record matching build and runtime evidence before distributing a release.

## Download and install

Open [Download Shielded](https://shielded.mutinynet.arkade.sh/#download) and choose your platform. Each row contains an install guide, the exact build's public download links, source commit and SHA-256 checksums. The native channel is **Mutinynet test coins only**. If release information cannot be checked, the page offers **Retry downloads**. The install guides and this source build guide remain available while checking or retrying.

Public packages are versioned GitHub release assets. Their links point to immutable build tags, `native-mutinynet-<commit12>-run<runId>-attempt<attempt>`. The repository's `native-mutinynet` Git branch stores the [public channel index](https://raw.githubusercontent.com/arkade-os/shielded/native-mutinynet/latest.json) in `latest.json`, selecting the complete build offered by the website. Publication atomically updates that branch, so readers receive the previous or new complete index without an unavailable gap. The repository's generic latest release can contain proving keys and is not the native download source. Compare the downloaded file's SHA-256 with the value displayed in its install guide. A matching checksum checks release consistency, not a publisher signature.

### Windows x64

1. Download the `.exe` installer and compare its checksum. In PowerShell, use `Get-FileHash -Algorithm SHA256` followed by the downloaded file's path.
2. Open the installer and complete setup. The offline WebView2 runtime is included; there is no separate runtime download.
3. Launch Shielded from Start, wait for Tor to connect, then create or restore a wallet.

These packages have no publisher signature. If Windows blocks a download, review [Microsoft's explanation of SmartScreen](https://learn.microsoft.com/windows/apps/package-and-deploy/smartscreen-reputation) before deciding whether to proceed.

### Linux x64

1. For Debian or Ubuntu, download the `.deb` and open it in the system's software installer, or run `sudo apt install ./<downloaded-filename>.deb` from its folder. The package manager resolves the package's declared dependencies.
2. Alternatively, download the `.AppImage`, allow it to execute in the file manager's Permissions tab, and open it. Preserve executable permissions when copying it. See the [AppImage opening guide](https://docs.appimage.org/introduction/quickstart.html) and [FUSE troubleshooting](https://docs.appimage.org/user-guide/troubleshooting/fuse.html) if required.
3. Use a desktop with WebKitGTK 4.1, GTK 3 and D-Bus available. Start and unlock a Secret Service provider, such as GNOME Keyring or a compatible KWallet setup. See [GNOME's keyring instructions](https://help.gnome.org/seahorse/keyring-unlock.html). Without a working provider, the native vault reports an error instead of creating a different wallet.
4. Launch Shielded, wait for Tor, then create or restore a wallet.

See the [Linux package requirements](https://v2.tauri.app/distribute/debian/). The public AppImage is a direct executable download; the Actions artifact archive also preserves its executable bit.

### macOS, Intel and Apple Silicon

1. Download the universal `.dmg`, open it, and drag Shielded into Applications. Or extract the universal `.app.zip` and move Shielded.app into Applications.
2. Compare the file's SHA-256 before opening the app; Terminal's `shasum -a 256 <downloaded-file>` prints it.
3. Open Shielded. These builds are unsigned and not notarized. If macOS blocks this specific app and you trust the checked download, follow [Apple's per-app Privacy & Security instructions](https://support.apple.com/en-us/102445). Keep the system's security protections enabled.
4. Wait for Tor, then create or restore a wallet. The recovery secret is held in this Mac's Keychain.

macOS 11 or later is required. Both architecture slices are included in the same app.

### Android ARM64

1. Download the **debug APK** on an ARM64 device. It is installable and signed with a build runner's development key. The separate unsigned release APK requires your own signing before installation.
2. Open the APK from Downloads. If prompted, allow the browser or file manager opening that file to install unknown apps, then return to the installer. Follow [Google's instructions for apps from other sources](https://support.google.com/pixelphone/answer/7391672?hl=en-GB); labels can differ by device.
3. Turn off that source's installation permission afterward. Leave Play Protect enabled. Open Shielded and wait for Tor before creating or restoring the wallet.
4. Before updating, preserve verified recovery data and the existing app data for unresolved swaps. Android requires the same signing key for an in-place update. The runner's development key can change, so a new APK may be refused as an update. Keep the existing installation and its data while resolving a signing mismatch.

### iPhone and iOS Simulator

The device `.ipa` is **unsigned**. It needs your Apple development signing certificate and a provisioning profile for the target iPhone before installation. It cannot be installed by tapping the public download. The simulator `.app.zip` is a separate Apple Silicon Mac build, not an iPhone installer. There is no TestFlight or App Store distribution in this channel.

1. For the supported Xcode route, get the source at the download's Source commit and follow the iOS commands in [Build](#build) on a Mac with Xcode installed. Open the generated iOS project in Xcode.
2. Add your Apple Account in Xcode Settings. In the app target's Signing & Capabilities, select your team and automatic signing.
3. Connect and trust the iPhone, select it as the run destination, and enable Developer Mode when prompted. Build and run. See [Apple's device setup guide](https://developer.apple.com/documentation/xcode/running-your-app-on-simulated-or-physical-devices).
4. If you use an existing workflow to sign the public IPA, sign it for your registered device first, then install that signed copy using Xcode or Apple Configurator. See [Apple's registered-device distribution guide](https://developer.apple.com/documentation/xcode/distributing-your-app-to-registered-devices) for provisioning and installation requirements.

To use the simulator ZIP, extract it on an Apple Silicon Mac with Xcode, start a matching iOS Simulator, and drag Shielded.app onto the simulator.

Before replacing an installation on any platform, save the recovery phrase securely and retain app data while swaps are unresolved. A phrase alone does not preserve all pending-swap state.

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

The simulator example targets an Apple Silicon Mac. Intel Macs use `x86_64`. For an iPhone, select `aarch64` and configure your development team in Xcode before building and running the generated project. Device distribution requires Apple signing; no distribution signing credentials are configured here.

Use the npm scripts for mobile initialization. Tauri uses that package-manager context and the canonical `tauri` script to generate the Rust callbacks invoked from Xcode and Gradle.

Arti currently pins a `sysinfo` release that calls macOS-only process APIs on iOS. `src-tauri/vendor/sysinfo` backports the upstream iOS fix while retaining the pinned release and real memory metrics. Its `README.shielded.md` records the source and patch; remove this override when Arti accepts a fixed release.

## CI binaries and public releases

The **Native wallet** GitHub Actions workflow builds release packages on pushes to `master` or `main`, and on manual dispatch. Pull requests build debug packages. Every package uses the fixed Mutinynet pool, `https://shielded.mutinynet.arkade.sh`; collection fails if the native marker and Rust route policy disagree with it. These builds use test funds only.

For CI diagnostics, open the matching workflow run in the repository's **Actions** tab and download its **Artifacts**. Artifact names include `mutinynet`, platform, profile, source commit and run attempt. These Actions downloads remain available for 14 days and contain `manifest.json`, `SHA256SUMS` and signing notes. They are separate from the website's public release assets.

Successful release runs on the default `main` or `master` branch publish all five platforms together after the native matrix and ordinary Checks pass for that exact source commit. Manual publication is also restricted to the default branch. When rerunning only failed jobs, publication selects the latest successful attempt for each platform from that workflow run, retaining successful packages from earlier attempts for the same source commit. Pull requests retain Actions artifacts and do not publish the public channel. A failed or incomplete run leaves the channel pointing at its previous complete build.

| Platform | Downloads |
| --- | --- |
| Windows x86_64 | NSIS `.exe` installer with offline WebView2 |
| Linux x86_64 | `.deb` and `.AppImage` inside a `.tar.gz` that preserves executable permissions |
| macOS Intel and Apple Silicon | Universal `.app.zip` and `.dmg`; CI verifies both architecture slices |
| Android ARM64 | Debug APK for PRs; unsigned release APK plus an installable debug APK for release runs |
| iOS | Unsigned ARM64 iPhone `.ipa` and a simulator `.app.zip` for the CI host's simulator architecture |

The device IPA needs your own Apple signing and provisioning before installation; the simulator archive is not an iPhone installer. Android release APKs also require signing. The additional Android debug APK uses the runner's development key, which is not a stable distribution identity. Updates require the same signing key: preserve verified recovery data and unresolved-swap app state before replacing an existing installation. Distribution signing credentials and macOS notarization are not configured by this workflow.

## Native boundary and storage

Only the bundled top-level `main` window can call the private transport and seed commands. Both the Tauri capability list and command-side origin checks enforce that boundary. The native marker is immutable and carries the fixed pool origin. The native host does not load a remote wallet website with native permissions.

The seed uses a fixed, bounded native vault record, through `plugin:shielded-platform|secret_get` and `secret_set`. Windows uses Credential Manager, macOS uses Keychain and Linux uses Secret Service. Android encrypts the seed using an Android Keystore AES-GCM key. iOS uses a nonsynchronizing Keychain item with `WhenUnlockedThisDeviceOnly` accessibility. A locked or broken vault is an error; it is not treated as an empty wallet. Linux requires a working Secret Service provider at runtime.

The vault protects the seed at rest. The frontend still receives it while the wallet is open. Notes, checkpoints and pending-operation state retain the wallet's repository storage and recovery semantics. Keep the recovery phrase and retain app data while outstanding swaps are unresolved; a seed-only backup is not a complete pending-swap backup.

## Isolation and lifecycle

Tor is required for native wallet networking. Bootstrap failure does not fall back to a direct connection. Privacy scopes bind connection ownership to the wallet operation or watched item; unrelated scopes must not share HTTP pools or private subscriptions. DNS names are resolved through Tor. Renewing a Tor circuit cannot remove identifiers already shared in request content or guarantee different exit addresses.

Tor starts on every foreground load, before the vault is read, including before a wallet exists. The connection indicator appears on onboarding and above the wallet. Its details show bootstrap progress or the last connection check. Foreground checks use a fresh isolated Tor scope every 30–45 seconds and stop on pause, lock or suspension. “Tor connected” means a recent HTTPS response arrived through Tor; it does not establish that every wallet service is healthy.

A failed Tor stream connection gets one further attempt using a fresh isolated client for the same scope. This happens before TLS or HTTP bytes are sent; TLS failures, HTTP requests and responses are not replayed. Native balance and history reads recover transient failures with backoff while retaining their last successful values. Lock and close cancel that recovery.

HTTP responses are bounded to 64 MiB. The pinned [genesis-4 proving keys](https://github.com/arkade-os/shielded/releases/tag/rollup-genesis-4-keys) fit this limit (join: 14,042,110 bytes; spend: 8,225,922 bytes). A future key release above that limit requires a bounded download path and mobile memory validation before adoption; increasing the limit alone would multiply buffering through IPC and the prover.

On Android pause and iOS resignation of active status, Tauri emits a native suspension event. The Rust host immediately pauses the transport, invalidates active scopes and cancels network work without depending on JavaScript running. The renderer must bootstrap and recreate its scopes after resumption. Window destruction also pauses the transport.

These controls hide the user's network address from wallet endpoints and separate transport contexts. Amounts, invoices, reused scripts, shared request identifiers and timing may still correlate activity. Tor does not provide protection against every observer or eliminate application-level links.

Native pool admissions are journaled before dispatch. Unknown submissions retain both their note nullifiers and deposit outpoints across restart, and cannot be replayed automatically. A generic `dropped` status also remains unresolved: an abandoned batch can later be adopted and included. Matching inclusion or a proven pre-admission refusal retires the hold. The wallet displays a pending-outcome notice while those inputs remain reserved. Keep app data; manually deleting the journal discards this protection.

Private providers, proof downloads, pool calls, LNURL and swap transports are bound to the unlocked session that created them. Retired calls cannot acquire a later session's generation. Historical script watches beyond the bounded live-stream budget use separate per-script polling; scripts are never grouped to avoid the limit.

## Validation recorded on November 6, 2026

- Windows debug NSIS packaging succeeded. The bundled app reached the create/restore screen with no seed created; a second launch exited successfully with one native process remaining.
- A live Rust smoke test bootstrapped Tor, read the pool through two isolated handles, received `IsTor=true` from the Tor Project and exercised cancellation, pause and stale-generation rejection.
- The full Node suite passed 1,245/1,245 tests, native Rust passed 29/29, and TypeScript and nine host/build-policy checks passed. Thirteen TLA configurations cover session safety, status ordering and connection recovery, including ten deliberately weakened guards with their expected invariant violations.
- PR #128 CI built Windows, Linux, macOS, Android APK and unsigned iOS simulator artifacts. Physical mobile runtime, funded wallet flows and a complete packaged-process packet-capture audit remain unverified. Build success does not establish those runtime gates.

## Checks and release gates

```sh
node --test tools/native-host.test.mjs
node tools/native-build.mjs icons
npm run native:frontend
cargo test --manifest-path src-tauri/Cargo.toml --workspace --locked
```

The native workflow builds matching desktop packages, an Android APK and an unsigned iOS simulator application. Before release, exercise cold start, unavailable Tor, interrupted bootstrap, multiple concurrent scopes, streaming cancellation, suspend/resume, seed persistence, restore and pending swaps in an installed application. Capture network traffic to confirm the renderer cannot bypass Tor, including DNS and WebSocket paths. A passing compile or configuration test alone does not prove those properties at runtime.
