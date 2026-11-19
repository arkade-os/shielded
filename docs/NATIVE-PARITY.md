# Native capability parity

Source audit: 2026-11-15, based on main `176651a` plus the native passkey follow-up. Source support is distinct from packaged-device qualification.

| Capability | Android | iOS | macOS | Windows / Linux | Implementation |
| --- | --- | --- | --- | --- | --- |
| Phrase create/restore, lock and reset | Yes | Yes | Yes | Yes | `NativeWallet.tsx`, `WalletOnboarding.tsx`, native vault |
| Shielded send/receive, Unified QR, assets and transaction details | Shared | Shared | Shared | Shared | `RollupWallet.tsx`, `wallet-receive.tsx`, `tx-details.tsx` |
| Lightning send, LNURL receive and pending-payment recovery | Shared | Shared | Shared | Shared | `RollupWallet.tsx`, `src/shielded/lightning-wallet.ts` |
| Embedded Tor, isolated providers and explicit direct-mode confirmation | Shared | Shared | Shared | Shared | `src/native`, `src-tauri/src/transport` |
| Recovery secret storage | Keystore | Device-only Keychain | Keychain | Credential Manager / Secret Service | `plugins/shielded-platform` |
| Camera QR scanner | Shared | Shared | Shared; camera usage string and entitlement added | Shared | `wallet-qr.tsx`, platform permission metadata |
| Copy and paste | Native text | Native text | Native text | Native text | `wallet-clipboard.ts`; Android retains its bounded plain-text reader |
| bitcoin/lightning/arkade payment links | Yes | Yes | Yes | Yes | Tauri deep-link plugin and `native-deeplink.ts` |
| Same-process background/return | Same owner retained | Same owner retained; native activation repair | Same owner retained | Same owner retained | Native session, shared page lifecycle and foreground-gated health monitor |
| Update availability | Yes | Yes | Yes | Yes | `AppUpdates.tsx` |
| Download, verify and launch installer inside the app | Yes, compatible signed sideload APK | No; Apple provisioning/store distribution needed | Yes, release-key signed `.app.zip` swapped in place atomically, then relaunch; opens downloads when it detects before downloading that the bundle cannot be replaced (translocated, read-only or in an unwritable folder); a failed swap leaves the app unchanged and offers Try again | Yes, release-key signed NSIS installer or AppImage, then relaunch; a `.deb` opens downloads | `android-updates.ts`, `desktop-updates.ts`; iOS remains a platform difference |
| Passkey create/restore and recovery reveal | Credential Manager; provider PRF required | Platform PRF on iOS 18+, disabled until Apple build/signing/domain setup | Platform PRF on macOS 15+, disabled until Apple build/signing/domain setup | Windows WebAuthn API 6+; Linux requires the optional experimental Credential portal; provider PRF required | Shared SDK derivation and native bridges; [Apple setup](NATIVE.md#apple-passkeys) |

The wallet features above share the same React and protocol implementation. Platform-specific failures can still arise from WebView versions, camera permissions, keychain providers, deep-link registration and operating-system suspension. The shared scanner uses WebView camera APIs; a camera permission description is not evidence of a successful physical-device scan.

## Background and resume contract

Ordinary app switching preserves an already-ready, never-revoked wallet owner, its provider graph, sheets and forms, and authorized Android update work while the process can run. Health diagnostics stop when either the page is hidden/frozen or native activation is false. Native status polling remains possible when the page is visible so a missed native activation event cannot strand the diagnostic monitor. A return immediately reconciles status and only rechecks health when due. Camera and recovery-secret views close on backgrounding.

Document `visibilitychange`, `freeze` and `resume` are observed on document; `pagehide` and `pageshow` on window. Frozen and departed-page state are independent until their corresponding return events. Ordinary desktop focus changes do not revoke or lock the wallet. On iOS, `UIApplication.didBecomeActiveNotification` repairs inactive native metadata after system prompts which did not enter background, including Tauri's default non-scene lifecycle. The native callback changes metadata only and grants no new renderer command or unlock authority.

Explicit Lock, reset, mode changes and window destruction retain their existing revocation rules. A retired provider cannot acquire a later generation. Process termination is a fresh launch using persisted wallet/pending-operation state, not an in-memory resume. These changes do not request unlimited background execution or replay payments after wake.

## Remaining platform qualification

1. On each packaged platform, test a ready wallet through repeated brief switches, long suspension and desktop sleep/wake; retain an open Send form and Receive sheet, then verify their contents and current balance on return.
2. On iOS, test Control Center, camera permission, interruption and device-lock returns; verify native activation becomes true and no fresh vault-open loop occurs.
3. Test first-grant/deny/retry camera and clipboard access, plus cold/warm payment links. Test macOS on both Intel and Apple Silicon, and Linux on X11 and Wayland with a working Secret Service.
4. Verify explicit Lock and reset during an in-flight read/proof cannot publish an old result or restart work. Use only a separate test wallet for money-path checks.
5. Verify Android update progress survives switches; installation still requires a foreground action. iOS/macOS signing and store/updater distribution remain separate work.
6. Use a separate test wallet to verify native passkey create, confirming authentication, restore and recovery reveal on each supported provider. Compare browser/native 12-word and 24-word recovery for the same credential; cover cancellation, system prompts, background/return and explicit lock during a prompt. On Android, attempt setup with the storage full: setup must fail, and after a restart the app must offer setup again rather than report a missing seed. Apple requires a real signing team and associated-domain setup before this test. Linux portal availability is experimental and is not broad Linux provider support.

Local Node/Rust/model results do not replace these device checks. No real credential ceremonies, physical Apple qualification, publisher credentials or published Apple domain association are included. The opt-in Apple entitlement preparation changes build configuration, without enrolling a team or supplying a signing identity.
