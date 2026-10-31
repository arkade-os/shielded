# @arkade-os/shielded

A shielded balance for an [`@arkade-os/sdk`](https://github.com/arkade-os/ts-sdk) app. The wallet you get is a real SDK `Wallet` with a private pool balance beside the normal one. Inside the pool, the amounts and both parties stay private.

It runs on the Mutinynet test pool at `https://shielded.mutinynet.arkade.sh`, with test funds only.

## Install

```sh
npm i @arkade-os/shielded @arkade-os/sdk@0.5.0
```

`@arkade-os/sdk` is a peer dependency, pinned to `0.5.0`, the version this wallet and its swap client are built on. The wallet subclasses your copy of the SDK, so there must be only one; `npm ls @arkade-os/sdk` should show one version.

## Use

```ts
import {createShieldedWallet,recoveryPhraseOf} from '@arkade-os/shielded';

const secret=crypto.getRandomValues(new Uint8Array(32)).reduce((hex,b)=>hex+b.toString(16).padStart(2,'0'),'');
const wallet=await createShieldedWallet({pool:'https://shielded.mutinynet.arkade.sh',secret});

wallet.shieldedAddress();   // shrol1… — share it to receive privately
await wallet.getAddress();  // tark1… — Arkade funds sent here move into the pool while the wallet runs
wallet.shieldedBalance();   // bigint, in sats

const payment=await wallet.pay('shrol1…',1_000n);
await payment.settled();

await wallet.dispose();
```

`secret` is 32 bytes as 64 hex characters, or the same bytes as a 24-word phrase. `recoveryPhraseOf(secret)` gives that phrase. The same secret always opens the same wallet, with the same Arkade address and shielded address as the reference wallet at `https://shielded.mutinynet.arkade.sh/wallet`.

The wallet also has:
- `withdraw(to,amount)` back to an Arkade address;
- `shield()`;
- `sync()`;
- `onShieldedChange()` and `onAction()`, the second of which reports every background action, such as auto-shield or a merge;
- claim links: `mintLink()` and `claimLink()`;
- `revealLink()`;
- `viewKey()`.

Every action returns an SDK `PaymentHandle` with named steps.

## Options

| option | default |
|---|---|
| `pool` | required: the pool's origin |
| `secret` | required |
| `identity` | derived from `secret`, as the reference wallet does |
| `bornAt` | `0`, the first batch to scan. A full scan is always correct. |
| `repository` | `IndexedDBShieldedNoteRepository` in browsers, otherwise in memory |
| `prover` | `snarkjsProver`, which downloads proving files from the pool |
| `hash` | circomlib Poseidon from `circomlibjs` |
| `fetch` | global `fetch`, for the pool's API. Proving files and the Arkade server always use the global `fetch`. |

`shieldedWalletConfig(options)` returns the full `ShieldedWalletConfig` without starting a wallet. Pass it to `ShieldedWallet.create` to change anything first.

## Browser bundles

`circomlibjs`'s main entry touches Node's `Buffer` when it loads. Alias it to the browser-safe Poseidon module, as the reference wallet does:

```js
// vite.config.js
import {fileURLToPath} from 'node:url';
export default {resolve:{alias:{circomlibjs:fileURLToPath(new URL('./node_modules/circomlibjs/src/poseidon_wasm.js',import.meta.url))}}};
```

Without the alias, `createShieldedWallet` fails with a message that names it. You can also pass your own `hash`.

The pool answers cross-origin requests only from origins its operator allows. Until yours is allowed, serve your app from the pool's origin, or proxy `/api/rollup` to it. Reveal links always point at `pool`.

## Node

Run Node 24 with `--experimental-eventsource`. Without it, the SDK falls back to polling every 20 seconds.

A proof starts snarkjs worker threads, which stay alive for the whole process. After the last wallet is disposed, `await releaseProver()` so the process can exit. It waits for any proof still running.

## TypeScript

The SDK's types use `AsyncDisposable`, and so do these. Add `"ESNext.Disposable"` to `lib`, or keep `skipLibCheck`.
