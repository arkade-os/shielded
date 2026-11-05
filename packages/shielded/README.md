# @arkade-os/shielded

A shielded balance for an [`@arkade-os/sdk`](https://github.com/arkade-os/ts-sdk) app. The wallet you get is a real SDK `Wallet` with a private pool balance beside the normal one. Inside the pool, the amounts and both parties stay private.

It runs on the Mutinynet test pool at `https://shielded.mutinynet.arkade.sh`, with test funds only.

## Install

The package is not on npm yet. Until it is, build and pack it from a checkout of this repository, then install the tarball:

```sh
npm run sdk:build && (cd packages/shielded && npm pack)
npm i ./path/to/arkade-os-shielded-0.1.0.tgz @arkade-os/sdk@0.5.3
```

Once it is published, the install is `npm i @arkade-os/shielded @arkade-os/sdk@0.5.3`.

`@arkade-os/sdk` is a peer dependency, pinned to `0.5.3`, the version this wallet and its swap client are built on. The wallet subclasses your copy of the SDK, so there must be only one; `npm ls @arkade-os/sdk` should show one version.

## Use

```ts
import {createShieldedWallet,recoveryPhraseOf} from '@arkade-os/shielded';

const secret=crypto.getRandomValues(new Uint8Array(32)).reduce((hex,b)=>hex+b.toString(16).padStart(2,'0'),'');
const wallet=await createShieldedWallet({pool:'https://shielded.mutinynet.arkade.sh',secret});

wallet.shieldedAddress();   // shrol1… — share it to receive privately
await wallet.getAddress();  // tark1… — Arkade funds sent here move into the pool while the wallet runs, once any deposit fee is accepted (see Deposit fee)
wallet.shieldedBalance();   // bigint, in sats

const payment=await wallet.pay('shrol1…',1_000n);
await payment.settled();

await wallet.dispose();
```

`createShieldedWallet` resolves once the shielded account is loaded and current, so the balance is ready to show; the incoming-funds watch and the first auto-shield go on in the background. `await wallet.started` waits for those, and rejects if the watch setup failed.

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
| `maxDepositFee` | none. A `DepositFeeSchedule`, `{fixedSats,bps}`: the most deposit fee to accept. See Deposit fee below. |

`shieldedWalletConfig(options)` returns the full `ShieldedWalletConfig` without starting a wallet. Pass it to `ShieldedWallet.create` to change anything first.

### Deposit fee

A pool may charge a fee on each deposit and advertise it as `depositFee`: `fixedSats` sats or `bps` basis points of the deposit, whichever is more. `wallet.depositFee` is the fee it charges now, or `undefined`.

`maxDepositFee` is the most you accept, as a schedule `{fixedSats,bps}`. The fields are compared one by one: the pool's `fixedSats` and its `bps` must each be at most yours. If the pool raises either one past it, deposits pause again.

A wallet without `maxDepositFee` still opens on a pool that charges a fee, shows balances, pays and withdraws. It refuses to deposit until the fee is accepted: `shield()` rejects, and funds sent to its Arkade address stay there instead of moving into the pool. The rejection carries `code: 'fee-paused'`, on the error itself. There is one exception: the pool refuses a deposit for its fee (`fee-missing`), and the wallet's one rebuild then finds a fee above what was accepted. In that case the code is on the `cause` of the error that `handle.settled()` rejects with.

`wallet.depositFeePaused` is the advertised `depositFee` while deposits are paused, and `undefined` otherwise. Show it to your user, or copy its `fixedSats` and `bps` into `maxDepositFee`. An app that asks its user can instead call `await wallet.acceptDepositFee({fixedSats,bps})` with the schedule it showed. Pass what the user saw, not a fresh read of `depositFeePaused`: a fee raised since then stays paused. The wallet saves what it accepted in `repository`, and on a later open accepts the larger of that and `maxDepositFee`, field by field.

To show the fee before a deposit, set `plan` to `wallet.planFor(await wallet.coins())`. `planFor` returns `undefined` when no coin is eligible, which includes coins the fee would leave under the minimum. If `plan` is defined, `wallet.depositFeeOnPlan(plan)` returns the fee in sats as a `bigint`. `depositFeeOf(schedule,sats)` gives it for any amount.

## Browser bundles

`circomlibjs`'s main entry touches Node's `Buffer` when it loads. Alias it to the browser-safe Poseidon module, as the reference wallet does:

```js
// vite.config.js
import {fileURLToPath} from 'node:url';
export default {resolve:{alias:{circomlibjs:fileURLToPath(new URL('./node_modules/circomlibjs/src/poseidon_wasm.js',import.meta.url))}}};
```

webpack 5 takes the same `resolve.alias` entry in its config. Without the alias, `createShieldedWallet` fails with a message that names it. You can also pass your own `hash`.

The pool answers cross-origin requests only from origins its operator allows. Until yours is allowed, serve your app from the pool's origin, or proxy `/api/rollup` to it. Reveal links always point at `pool`.

## Node

Run Node 24 with `--experimental-eventsource`. Without it, the SDK falls back to polling every 20 seconds.

A proof starts snarkjs worker threads, which stay alive for the whole process. After the last wallet is disposed, `await releaseProver()` so the process can exit. It waits for any proof still running.

## TypeScript

The SDK's types use `AsyncDisposable`, and so do these. Add `"ESNext.Disposable"` to `lib`, or keep `skipLibCheck`.

## License

MIT. Two runtime dependencies, `snarkjs` and `circomlibjs`, are GPL-3.0, and an app that ships them takes on their terms.
