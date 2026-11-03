# Fee wallet runbook

A pool can charge a fee on each deposit (see [Deposit fee](../README.md#deposit-fee)). The fee goes to a separate wallet. This runbook covers creating that wallet, configuring the pool with it, running its keeper, and turning the fee on and off.

## Why a separate wallet

The pool server holds only the fee wallet's address (`shrol2…`) and view key (`shview2…`). The spend key never reaches the server, so a compromised pool cannot spend the fees. The server uses the view key to open each deposit's fee note and check that it pays this wallet what is owed.

## Create it

Generate a 24-word phrase on a machine that is not the pool host, and keep it in a secret store. Whoever holds it can spend every fee. From a checkout after `npm ci`:

```sh
node --import tsx -e "import('./packages/protocol/src/wallet-keys.ts').then(m=>console.log(m.recoveryPhraseOf(crypto.getRandomValues(new Uint8Array(32)))))"
```

Then print the address and view key the pool is configured with. The phrase goes only in the environment, never as an argument: an argument lands in shell history and the process list, and npm's own banner echoes the command line. `read -rs` takes the phrase from the terminal with no echo and no history entry:

```sh
read -rs SHIELDED_FEE_WALLET_PHRASE && export SHIELDED_FEE_WALLET_PHRASE
npm run --silent fee:keeper -- --derive
```

```
SHIELDED_DEPOSIT_FEE_ADDRESS=shrol2…
SHIELDED_DEPOSIT_FEE_VIEW_KEY=shview2…
```

`--silent` keeps npm's banner out of the output, so those two lines can go straight into the pool's env file. Running node directly does the same:

```sh
node --experimental-eventsource --import tsx tools/shielded-fee-keeper.ts --derive
```

`--derive` makes no network call. The keeper refuses every other argument.

The address is public: the pool advertises it. The view key is not. It shows every note the fee wallet receives and the amount of each, which is the fee income. Put it only in the pool's configuration.

## Configure the pool

Turn the fee on only when both of these hold:

- The wallet and page that pay the fee are deployed (PRs #107 and #108). A page or an `@arkade-os/shielded` version from before #107 cannot pay it: the pool refuses its deposits with `fee-missing` and a message to reload. A cached page recovers by reloading; an SDK app has to upgrade and pass `maxDepositFee`. A page with #107 but not #108 can neither show nor accept the fee, so its deposits stay paused.
- The pool runs PR #106 (`6c927d7`) or later. Its fee refusal drops a whole asset group at once, which the wallet's rebuild of a refused deposit relies on.

Set these in the pool's runtime environment ([DOKPLOY.md](DOKPLOY.md)) and redeploy:

```
SHIELDED_DEPOSIT_FEE_ADDRESS=shrol2…
SHIELDED_DEPOSIT_FEE_VIEW_KEY=shview2…
SHIELDED_DEPOSIT_FEE_SATS=100
SHIELDED_DEPOSIT_FEE_BPS=0
```

The fee on a deposit is `max(SATS, ceil(deposit × BPS / 10000))`.

| Set | Result |
| --- | --- |
| Nothing, or SATS and BPS at 0 alone | Fee off |
| Address and view key, with SATS and BPS both 0 | Fee off, and the log warns |
| Address, view key, and SATS or BPS above 0 | Fee on |
| Anything else | Pool blocked |

A malformed fee never runs the pool fee-free: the pool stays closed instead. `/health` answers 503, `/api/rollup/status` shows `"phase": "blocked"` with the reason in `message`, and the log repeats it. These block the pool: a missing, malformed or mismatched address or view key; a SATS or BPS that is not plain decimal digits; BPS above 10000; SATS or BPS above 0 without an address and view key; and any other variable starting with `SHIELDED_DEPOSIT_FEE_`, which is a misspelling. Fix the variable and redeploy.

**Turning the fee on restarts the pool.** Spends that were pending are re-admitted on the restart; any fee-less deposit among them is dropped with its reason, and its wallet rebuilds it with the fee. With a fee on, the operator also keeps `batch-txids.json` beside its batch records (`rollup4/operator/` under the data directory). It only caches those records, so it needs no backup: if it is missing or damaged, the operator rebuilds it by reading the records. It is missing on the first start with the fee on.

The fee is live when `/api/rollup/status` shows it. Until it does, no wallet pays it:

```sh
curl -s https://shielded.mutinynet.arkade.sh/api/rollup/status | jq .pool.depositFee
```

A wallet pauses automatic shielding while the advertised fee is above what it has accepted, in either number. A wallet that has accepted nothing pauses when the fee is first turned on, and any wallet pauses again when you raise SATS or BPS past its ceiling. The page shows an **Accept the new fee** banner; an SDK wallet needs a higher `maxDepositFee`. A fee at or below what a wallet accepted, in both numbers, needs no new acceptance.

## Run the keeper

Every fee-paying deposit mints one fee note for the fee wallet. The keeper merges them down to one note per asset. That keeps the notes inside the window in which they can be spent (see [If the keeper stops](#if-the-keeper-stops)), and lets a withdrawal, which spends a single note, pay out the whole balance.

Run it on a different host from the pool or, at the least, as a separate process outside the pool's container. It holds the phrase, so it never runs inside that container. It needs a checkout after `npm ci` and Node 24.2 or later, because its direct-run check, `import.meta.main`, arrived in 24.2.

| Variable | Meaning |
| --- | --- |
| `SHIELDED_POOL_ORIGIN` | The pool, for example `https://shielded.mutinynet.arkade.sh` |
| `SHIELDED_FEE_WALLET_PHRASE` | The 24 words, from the secret store |
| `SHIELDED_FEE_KEEPER_INTERVAL_MS` | Optional: the pause between passes in milliseconds, default 60000; a whole number from 1 to 2147483647 |

```sh
npm run fee:keeper
```

It keeps nothing on disk, so each start reads the whole pool again and the first pass waits for that. It exits with status 1 if the pool is not open when it starts (blocked, restarting, unreachable) and does not retry. Run it under a supervisor that restarts it.

It logs one line when it starts and one at the end of each pass:

```
<time> fee wallet shrol2… holds 1200 sats; merging every 60000 ms
<time> merged 2, notes remaining 1, batch 412
```

`merged` counts the merges in that pass. `notes remaining` is every note the wallet holds across the pool's assets, including notes awaiting recovery. `batch` is how far it has read the pool. A pass ends when nothing is left to merge, so a backlog means a long gap between lines. A merge that fails, or has not landed after 10 minutes, is logged to stderr as `merging asset … failed, trying again next pass: …` and retried on the next pass.

## First turn-on checklist

Use a small fixed fee for the first run (`SHIELDED_DEPOSIT_FEE_SATS=100`, `SHIELDED_DEPOSIT_FEE_BPS=0`), once both conditions under [Configure the pool](#configure-the-pool) hold.

1. Set the four variables and redeploy. When `/api/rollup/status` shows `"phase": "ready"`, start the keeper.
2. `curl -s https://shielded.mutinynet.arkade.sh/api/rollup/status | jq .pool.depositFee` shows `{fixedSats, bps, address}`. The same URL piped to `grep -c shview` prints `0`: the view key is not served.
3. In a fresh browser profile, open `/wallet`. The funding card names the fee.
4. Fund the wallet with a small amount from the Mutinynet faucet, which the funding card links. One deposit lands, and its History row has a **Deposit fee** line equal to the configured fee.
5. The keeper's next pass logs `notes remaining 1`. Fund again, and the first pass after that deposit lands logs `merged 1, notes remaining 1`.
6. Withdraw a small amount to an Arkade address, then press **Shield again** on that single payout. It shields with no fee and no `fee-missing` refusal, because a deposit made only of this pool's own payouts pays nothing.
7. If anything above fails, unset the variables and redeploy ([Turn the fee off](#turn-the-fee-off)).

## If the keeper stops

A note spends directly only in the epoch it was made in and the next one, and an epoch is 128 batches. A fee note that has not been merged or renewed by then falls out of that window and can only be recovered. A recovery is a one-slot batch: one note takes a whole batch, so each missed note costs the pool a batch of capacity. The fees are not lost. The notes stay recoverable and the phrase still spends them.

Restart the keeper. Its wallet's watchdog recovers held notes on its own, and the keeper then merges what was recovered.

The keeper has a ceiling. It merges one pair at a time and waits for each merge to land, so it removes about one note per batch, while every fee-paying deposit adds one. If fee-paying deposits arrive faster than about one per batch, the backlog grows until notes age out of the window and fall to recovery. `SHIELDED_FEE_KEEPER_INTERVAL_MS` does not raise the ceiling: it spaces passes, and within a pass the keeper merges back to back.

It is keeping up while `notes remaining` stays near one per asset the wallet holds and `batch` follows `pool.batches` in `/api/rollup/status`. If `notes remaining` climbs from pass to pass, it is falling behind.

## Spend the fees

Any wallet on the phrase can spend the fee notes. A withdrawal spends one note, so it pays out at most your largest note, and at least 330 sats. The keeper's merging is what makes that one note the whole balance.

- **The web wallet.** Open `/wallet` in a fresh browser profile, because a restore replaces any wallet already in that browser. Expand **Recovery phrase and restore**, paste the phrase into **Restore from a recovery phrase**, and press **Restore wallet**. A **Created on** date makes the restore skip older pool history; use the day you turned the fee on, or any earlier day. The restore saves the wallet secret in that browser's local storage, so clear the site data when you are done.
- **Code.** Call `createShieldedWallet` from `@arkade-os/shielded` with the phrase as `secret`, then `wallet.withdraw(arkAddress, sats)` and await the handle's `settled()`. See [packages/shielded/README.md](../packages/shielded/README.md).

## Turn the fee off

Unset the four variables and redeploy. Setting SATS and BPS to 0 and keeping the address and view key also turns it off, and the pool logs a warning. Wallets return to fee-less deposits on their next `/api/rollup/status` read. Fee notes already minted stay spendable from the phrase.

Keep the keeper running until you have withdrawn the remaining balance. Notes that nobody renews fall to recovery, as described above.
