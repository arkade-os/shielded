# Native Shielded wallet

The Tauri application bundles the existing wallet frontend. Rust owns its embedded Arti client, private network requests, streams and sockets. The bundled renderer has no permission to connect to remote hosts directly. Remote navigation and additional windows are denied.

Web and native use the same `RollupWallet` screen and `WalletOnboarding` create/restore flow. The native wrapper supplies the vault, Tor transport and session lifecycle; the browser keeps its existing storage and networking. Browser onboarding does not start or claim an embedded Tor connection.

The native renderer also disables WebRTC peer connections, which could otherwise introduce ICE/STUN traffic outside the HTTP and WebSocket transport. Workers and remote assets remain subject to the bundled CSP.

The native build targets Windows, Linux, macOS, Android and iOS. Source support and the CI definitions do not establish that each target has been built or tested on a physical device. Record matching build and runtime evidence before distributing a release.

## Download and install

Open [Download Shielded](https://shielded.mutinynet.arkade.sh/download#download). Your platform appears first; **Other systems** expands the remaining platforms. Each row contains an install guide, the exact build's public download links, source commit and SHA-256 checksums. The native channel is **Mutinynet test coins only**. If release information cannot be checked, the page offers **Retry downloads**. The install guides and this source build guide remain available while checking or retrying.

When this build detects a newer native release, **Update available** opens the update dialog on Android and on desktop installations that can replace themselves, or otherwise the download page in the system browser. Other external links keep the in-app copy fallback. Future store-distributed builds can use their platform update flow; Google Play installs cannot use the sideload updater.

The desktop and mobile apps register the standard `bitcoin:`, `lightning:` and `arkade:` URI schemes. Opening a payment link fills the Send form with its destination and amount, preserving required-parameter checks, but it never sends without the normal quote and confirmation steps. Links opened before the private wallet is ready remain queued until it opens.

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

1. Download the **signed APK** on an ARM64 device. Current release builds use a permanent publisher certificate. Older releases offer an installable debug APK signed with a runner's development key. The separate unsigned release APK requires your own signing before installation.
2. Open the APK from Downloads. If prompted, allow the browser or file manager opening that file to install unknown apps, then return to the installer. Follow [Google's instructions for apps from other sources](https://support.google.com/pixelphone/answer/7391672?hl=en-GB); labels can differ by device.
3. Turn off that source's installation permission afterward. Leave Play Protect enabled. Open Shielded and wait for Tor before creating or restoring the wallet.
4. In a signed release, tap **Update available**, then **Update**. Shielded downloads the APK through embedded Tor, or directly when Tor is off, and verifies its size and SHA-256. It checks the package identity, newer Android version and signing certificate, saves and locks the wallet, then hands the APK to Android's own installer. If Android asks to allow installs from Shielded, allow it and continue in the installer. A failed step shows its error and **Try again**; a verified download is reused rather than fetched again. An in-place update keeps the wallet vault, WebView data and pending-swap records.

Android requires a compatible signing certificate for an in-place update. An older APK signed with a runner's changing development key cannot be upgraded using the new publisher key. Shielded refuses that mismatch rather than clearing data or replacing the wallet. Keep the existing installation and its data while resolving this; a recovery phrase alone does not preserve every pending swap. The updater does not provide an automatic migration between incompatible signing identities.

Downloads use their own Tor isolation scope when Tor is on and remain in app-private update staging. A paused connection or interrupted download becomes retryable; partial packages are never installable. Retrying an interrupted download starts it fresh. The update flow does not use the browser or Android DownloadManager to fetch the APK. Android performs its final package verification and installation; store-managed installation and future store update APIs are separate from this sideload channel.

APK and release-metadata requests use embedded Tor, or a direct connection when Tor is off. Android's installer and system verification services, including Play Protect, can perform their own network checks outside Shielded's transport.

The signed APK also requires the private publisher key to reproduce. Use the retained unsigned APK when comparing independently rebuilt Android output; signing secrets are never published with reproducible build inputs.

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

### Wallet setup

Passkey and phrase setup retain a public recovery intent across an unknown vault-write outcome. A fresh random wallet records its optional birth metadata after the vault acknowledges creation, so a rejected first write cannot require a phrase that was never shown. If that acknowledgement or metadata is lost, reopening reads the native vault and scans from genesis when no birth cursor exists. A competing wallet is never replaced by setup.

Public passkey metadata retains credential IDs up to 4,096 base64url characters for compatibility with existing browser wallets. Native passkey requests and responses accept decoded IDs up to 1,024 bytes. If an existing browser credential exceeds that native bound, native passkey recovery fails closed; use its original supported browser or restore the same wallet with its recovery phrase.

### Passkey availability and PRF results

`passkey_support` checks native API/build availability; it does not certify that the
selected provider or credential will return PRF output. Android's API 28 threshold
matches [Credential Manager's passkey minimum](https://developer.android.com/identity/passkeys#android-version-compatibility).
Provider and service versions still matter. The existing Android bridge forwards
WebAuthn extension requests and responses to Credential Manager. The SDK rejects
missing or invalid PRF output before seed creation or any vault write; it never
substitutes a random wallet. CI does not establish a physical-device PRF matrix.

The protocol wipes the PRF bytes it owns after derivation and on failure. Native WebAuthn
responses also contain encoded PRF material in JSON/IPC strings; those copies cannot
be reliably wiped across the bridge and JavaScript runtime. They remain secret data
and must not enter logs, public metadata or storage.

### Apple passkeys

The Apple bridge implements platform-passkey PRF on iOS 18 and macOS 15 or later. The app deployment minima remain iOS 14 and macOS 11; older systems can use phrase wallets. Hardware-security-key PRF is outside this Apple adapter. See [Apple's PRF API availability](https://developer.apple.com/documentation/authenticationservices/asauthorizationpublickeycredentialprfassertioninput-swift.struct).

Apple passkeys are disabled in default builds. There is no Apple Developer team or associated-domain signing configured for Shielded yet. Unsigned compilation checks the bridge, but does not establish a usable Apple credential ceremony. Enabling the build flag alone does not configure or prove the domain association.

Before enabling a signed build:

1. Register `io.arkade.shielded` with the actual Apple Developer team, enable Associated Domains for that app identity, and use a signing identity/provisioning profile that permits it.
2. Serve `https://shielded.mutinynet.arkade.sh/.well-known/apple-app-site-association` over HTTPS with a `webcredentials.apps` entry for the signed app's actual application-identifier prefix plus `.io.arkade.shielded`. Use the actual prefix from that app identity; do not assume it always equals the Team ID. No association file or signing identity is published by this change.
3. Build with `SHIELDED_APPLE_PASSKEYS=1` and verify the resulting signed app contains `com.apple.developer.associated-domains = ["webcredentials:shielded.mutinynet.arkade.sh"]`. Follow [Apple's associated-domain setup](https://developer.apple.com/documentation/xcode/supporting-associated-domains) and [passkey requirements](https://developer.apple.com/documentation/authenticationservices/supporting-passkeys).

On a configured Mac, keep the flag in the environment for the entire command:

```sh
SHIELDED_APPLE_PASSKEYS=1 npm run native:build
SHIELDED_APPLE_PASSKEYS=1 npm run native:ios -- init --ci
SHIELDED_APPLE_PASSKEYS=1 npm run native:ios -- prepare
SHIELDED_APPLE_PASSKEYS=1 npm run native:ios -- build --target aarch64 --ci
```

Configure the real development team/signing through Xcode or the documented Tauri signing environment before the signed iPhone build. Do not put certificates or private keys in source. These commands do not enroll a team, create certificates, publish the domain association or submit an app.

The desktop wrapper selects `macos/PasskeyEntitlements.plist`, which retains camera access. The iOS wrapper merges the domain into the entitlement file referenced by the generated app target's signing settings, using macOS `plutil`. This runs after initialization and before build/dev/prepare, retains other entitlements and associated domains, and rejects ambiguous projects, changed app identifiers or redirected paths before editing. Existing generated native edits are preserved; regeneration is not required merely to enable the domain. If those signing settings are customized, every app configuration must use the same entitlement file inside the generated project. After an opted-in build, unsetting the flag disables the bridge; it does not remove an association from a manually maintained iOS entitlement file.

Before distributing an enabled build, verify create, confirming authentication, restore and recovery reveal on signed iOS and both Mac architectures. Compare 12-word and 24-word recovery phrases across browser/native use of the same passkey, and exercise cancellation, system-prompt inactivity, lock and background/return. The provider must return a valid PRF result; operating-system/API availability alone does not guarantee it. These credential/device checks remain unverified here.

Apple provider waits have a 120-second runtime deadline. Expiration releases only that ceremony and cancels its captured controller; late callbacks or timer cleanup cannot cancel a newer request. This is independent of the renderer's immediate logical cancellation on lock or connection revocation. Device suspension and main-thread scheduling remain subject to the operating system.

### Passkey relying-party changes

The current native relying party is `shielded.mutinynet.arkade.sh`. Changing only the pool origin or one native constant fails closed; changing every constant does not migrate existing passkeys to another relying party. Before enabling a signed build with a different origin:

1. Review the bundled `__SHIELDED_NATIVE__.poolOrigin` used by `NativeWallet.tsx` and `RollupWallet.tsx`; `passkeyRpId` derives their RP host from it. Browser recovery also depends on the website's actual hostname. Keep the native network policy and build metadata consistent with that origin.
2. Update and rebuild the matching enforcement layers together: Rust `passkeys/mod.rs` (`RP`), Swift `Passkeys.swift` (`PasskeyInput.rpID`), Linux `passkeys/linux.rs` (`ORIGIN`, including its HTTPS scheme), macOS `macos/PasskeyEntitlements.plist`, and the iOS domain added by `tools/native-build.mjs`. Do not enable a mixed-origin build.
3. Configure the new host's HTTPS `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` for the actual Apple app identity and existing Android package/signing certificate. Verify the signed Apple associated-domain entitlement and Android association against that host before enabling passkey controls. Keep signing identities stable.
4. Preserve access to the old RP's recovery path until a separately reviewed credential migration is available. Verify existing-wallet recovery and any new-RP credential with separate test wallets, across browser and native providers; compare the derived 12/24 words and test pending-setup recovery. This PR does not implement an RP migration or publish new domain associations.

## CI binaries and public releases

Release inputs are pinned for reproduction. The workflow uses Node `24.22.2`, Rust `1.96.0`, immutable action commit SHAs, the committed npm and Cargo lockfiles, `SOURCE_DATE_EPOCH=1794240000`, and a Rust path remap. Each platform artifact records those inputs and SHA-256 hashes of both lockfiles. Publication rejects a mixed toolchain or mismatched reproduction metadata. `tools/reproducible-build.test.mjs` fails if a runtime or action becomes floating.

Rebuild the published source commit on the same operating system and target, using the recorded inputs, then compare the rebuilt package SHA-256 with the release manifest. Reproducibility means the build can be independently checked. It does not replace publisher signing. The unsigned Android release APK remains available for independent build comparison; the separately signed APK adds a publisher signature that requires the private distribution key to reproduce. macOS packages are not notarized, and iPhone IPAs are unsigned.

The **Native wallet** GitHub Actions workflow builds release packages on pushes to `master` or `main`, and on manual dispatch. Pull requests build debug packages. Every package uses the fixed Mutinynet pool, `https://shielded.mutinynet.arkade.sh`; collection fails if the native marker and Rust route policy disagree with it. These builds use test funds only.

For CI diagnostics, open the matching workflow run in the repository's **Actions** tab and download its **Artifacts**. Artifact names include `mutinynet`, platform, profile, source commit and run attempt. These Actions downloads remain available for 14 days and contain `manifest.json`, `SHA256SUMS` and signing notes. They are separate from the website's public release assets.

Successful release runs on the default `main` or `master` branch publish all five platforms together after the native matrix and ordinary Checks pass for that exact source commit. Manual publication is also restricted to the default branch. When rerunning only failed jobs, publication selects the latest successful attempt for each platform from that workflow run, retaining successful packages from earlier attempts for the same source commit. Pull requests retain Actions artifacts and do not publish the public channel. A failed or incomplete run leaves the channel pointing at its previous complete build.

| Platform | Downloads |
| --- | --- |
| Windows x86_64 | NSIS `.exe` installer with offline WebView2 |
| Linux x86_64 | `.deb` and `.AppImage` inside a `.tar.gz` that preserves executable permissions |
| macOS Intel and Apple Silicon | Universal `.app.zip` and `.dmg`; CI verifies both architecture slices |
| Android ARM64 | Debug APK for PRs; permanently signed release APK, unsigned release APK and a legacy debug APK for release runs |
| iOS | Unsigned ARM64 iPhone `.ipa` and a simulator `.app.zip` for the CI host's simulator architecture |

The device IPA needs your own Apple signing and provisioning before installation; the simulator archive is not an iPhone installer. The legacy Android debug APK uses the runner's development key, which is not a stable distribution identity. Keep that installation and its data if Android refuses a differently signed update. macOS notarization is not configured by this workflow.

### Stable Android signing

`src-tauri/android-signing.json` records the public package identity, key alias and certificate SHA-256. The distribution certificate is `374219922ff53597fc064bd511f8af6475118ddc681d47f6b86bbc884a252855`. The private keystore and password are stored in the encrypted repository secrets `ANDROID_RELEASE_KEYSTORE_BASE64` and `ANDROID_RELEASE_KEYSTORE_PASSWORD`; they are never source files or build artifacts. Maintain a separate protected backup of that signing identity. Do not generate a replacement key to recover a failed CI run: a changed certificate breaks compatibility with installed wallets and their passkey association (`/.well-known/assetlinks.json`).

The signing job runs only for this repository's primary-branch push or dispatch after the unprivileged Android build. It verifies the unsigned artifact's identity and hash, signs with the permanent key, verifies the resulting certificate and package, and uploads the signed APK with its own manifest. Pull requests do not receive the distribution key. Missing credentials or an unexpected certificate fail publication; there is no development-key fallback for the signed channel.

Keep two independently recoverable, encrypted backups of the keystore and its unlocking credentials, separate from source and CI artifacts. A machine-bound encrypted password also needs that machine account's recovery material. If CI secrets are deleted, restore the existing identity from a verified backup; do not create a new key. If every recoverable copy is lost, installed apps cannot accept ordinary updates signed with a replacement key. Uninstalling removes local wallet and pending-payment data; a recovery phrase alone does not restore every pending operation.

Android `versionCode` is `100000 + GITHUB_RUN_NUMBER`, above the previous default `1000`. Reruns retain the same version code; a later workflow run advances it. Package identity remains `io.arkade.shielded`, and the storage origin and native vault identity stay unchanged. The installer accepts only a strictly newer version.

The public release manifest remains schema 1 and retains its nine legacy packages. New clients read the optional `androidUpdate` entry for the separately signed APK; older clients continue reading the original package list. Publication uploads both sets completely before advancing the channel.

The `release` transport purpose is an internal bridge policy bundled with its matching frontend. Older native binaries retain their own `public` policy; the remote metadata endpoint and legacy package schema remain compatible. Native builds use bundled assets with the service worker disabled, so a new host does not load an older cached wallet frontend.

The sideload plugin declares `REQUEST_INSTALL_PACKAGES` in both debug and release builds so the installer path can be tested consistently. Installation still requires the pinned certificate, an explicit action and Android permission. Store distribution needs its own update integration and permission policy.

### Desktop update signing

Publication signs each desktop package that can replace an installation in place (the Windows `-setup.exe`, the Linux `.AppImage` and the macOS `.app.zip`) with an ed25519 release key. The signature covers the channel, network, platform, file name, size, SHA-256, commit and build number. The 32-byte seed is the repository secret `SHIELDED_UPDATE_SIGNING_KEY`, passed only to the publish step, and publication fails unless it derives the public key pinned in `src-tauri/update-signing.json`. Each desktop build installs only a newer package that verifies against the key it was built with.

Rotating the key takes two releases: publish a build that pins the new key while the old key still signs it, then switch the secret once installations have taken that build. Publication refuses a secret that does not derive the pinned key, so the transition release also needs the publisher to check the old key instead; that publisher change does not exist yet. An installation that skips the transition build needs one manual install from the downloads page, as does every installation if the seed is lost. A leaked key cannot be revoked: an installation that still pins it accepts packages signed with it until it installs a build pinning a new key.

## Native boundary and storage

Only the bundled top-level `main` window can call the private transport and seed commands. Both the Tauri capability list and command-side origin checks enforce that boundary. The native marker is immutable and carries the fixed pool origin. The native host does not load a remote wallet website with native permissions.

The seed uses a fixed, bounded native vault record, through `plugin:shielded-platform|secret_get` and `secret_set`. Windows uses Credential Manager, macOS uses Keychain and Linux uses Secret Service. Android encrypts the seed using an Android Keystore AES-GCM key. iOS uses a nonsynchronizing Keychain item with `WhenUnlockedThisDeviceOnly` accessibility. A locked or broken vault is an error; it is not treated as an empty wallet. Linux requires a working Secret Service provider at runtime.

The vault protects the seed at rest. The frontend still receives it while the wallet is open. Notes, checkpoints and pending-operation state retain the wallet's repository storage and recovery semantics. Keep the recovery phrase and retain app data while outstanding swaps are unresolved; a seed-only backup is not a complete pending-swap backup.

## Isolation and lifecycle

Tor is the default for native wallet networking. Bootstrap failure never falls back to a direct connection. The connection menu can turn Tor off only after confirming the IP/DNS exposure and loss of Tor circuit isolation. The native host remembers the choice in its app data, across launches and a wallet reset, until Tor is turned back on: it records direct once a direct connection is ready and Tor as soon as Tor is requested, and an unreadable record means Tor. In Tor mode, privacy scopes bind connection ownership to the wallet operation or watched item; unrelated scopes must not share HTTP pools or private subscriptions, and DNS names are resolved through Tor. Renewing a Tor circuit cannot remove identifiers already shared in request content or guarantee different exit addresses.

The remembered connection starts on load, before the vault is read, including before a wallet exists; with Tor off, no Tor bootstrap starts. Wallet creation and restore wait for the selected connection to be ready. A ready same-owner return retains its scopes and providers; rebuilding an interrupted opening can reuse the Arti client and directory cache while retiring the previous generation's scopes. The connection indicator appears on onboarding and above the wallet. Its details show bootstrap progress or the last connection check. Tor-mode foreground checks use a fresh isolated scope every 30–45 seconds and stop on pause, lock or suspension. “Tor connected” means a recent HTTPS response arrived through Tor; it does not establish that every wallet service is healthy. Direct mode is labelled separately.

A failed Tor stream connection gets one further attempt using a fresh isolated client for the same scope. This happens before TLS or HTTP bytes are sent; TLS failures, HTTP requests and responses are not replayed. Native balance and history reads recover transient failures with backoff while retaining their last successful values. Lock and close cancel that recovery.

HTTP/1 connections can be reused within the same host, native scope and transport generation after the complete bounded response has been read and validated. The cache holds at most one idle connection per scope and 16 globally; idle connections expire after 30 seconds. Context rotation, scope release, pause and mode changes close cached connections, and transport retirement waits for their physical I/O to stop. TLS ticket resumption remains disabled, and SSE/WebSocket streams keep dedicated connections. A closed cached connection can be replaced before dispatch; a dispatched HTTP request is never automatically replayed.

HTTP responses are bounded to 64 MiB. The pinned [genesis-4 proving keys](https://github.com/arkade-os/shielded/releases/tag/rollup-genesis-4-keys) fit this limit (join: 14,042,110 bytes; spend: 8,225,922 bytes). A future key release above that limit requires a bounded download path and mobile memory validation before adoption; increasing the limit alone would multiply buffering through IPC and the prover.

On Android pause and iOS resignation of active status, Tauri emits a native suspension event. An already-ready session retains its owner, scopes and wallet graph during ordinary backgrounding; native activation metadata gates new startup and foreground-only actions. A return to that same owner preserves open sheets and form contents. An interrupted startup or genuinely retired generation still rebuilds through the existing readiness and cleanup gates. Explicit Lock clears the in-memory seed after teardown; reset, mode changes and window destruction retain their revocation rules.

All native platforms observe page visibility, document freeze/resume and window pagehide/pageshow. Health diagnostics stop while either the page or native app is inactive, and reconcile immediately on return. An iOS native `didBecomeActive` notification repairs an inactive status after system prompts that never entered background. Camera capture and recovery-secret views withdraw during backgrounding. The OS may suspend or terminate the process; this does not request unlimited background execution. See [Native capability parity](NATIVE-PARITY.md) for the platform differences and remaining device checks.

In Tor mode, these controls hide the user's network address from wallet endpoints and separate transport contexts. Confirmed direct mode exposes the network address and DNS lookups. Amounts, invoices, reused scripts, shared request identifiers and timing may still correlate activity. Tor does not provide protection against every observer or eliminate application-level links.

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
