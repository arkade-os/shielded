# Fee wallet runbook

A pool can charge a fee on each deposit ([README](../README.md#deposit-fee)). The fee goes to a separate wallet. This runbook covers creating it, configuring the pool, running its keeper, and turning the fee on and off.

## Why a separate wallet

The pool server holds only the fee wallet's address (`shrol2…`) and view key (`shview2…`). The spend key never reaches the server, so a compromised pool cannot spend the fees. The server uses the view key to open each deposit's fee note and check what it pays.

## Create it

Generate a 24-word phrase on a machine that is not the pool host, and keep it in a secret store. Whoever holds it can spend every fee. From a checkout after `npm ci`:

```sh
node --import tsx -e "import('./packages/protocol/src/wallet-keys.ts').then(m=>console.log(m.recoveryPhraseOf(crypto.getRandomValues(new Uint8Array(32)))))"
```

Then print the address and view key the pool is configured with. The phrase goes only in the environment, never as an argument: an argument lands in shell history and the process list, and npm's own banner echoes the command line. In bash or zsh (plain `sh` has no `-s`), `read -rs` takes the phrase with no echo and no history entry:

```sh
read -rs SHIELDED_FEE_WALLET_PHRASE && export SHIELDED_FEE_WALLET_PHRASE
npm run --silent fee:keeper -- --derive
unset SHIELDED_FEE_WALLET_PHRASE
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

- The wallet and page that pay the fee are deployed (PRs #107 and #108). A page or `@arkade-os/shielded` from before #107 cannot pay it: the pool refuses its deposits with `fee-missing` and a message to reload. A cached page recovers by reloading, an SDK app by upgrading and passing `maxDepositFee`. A page with #107 but not #108 can neither show nor accept the fee, so its deposits stay paused.
- The pool runs PR #106 (`6c927d7`) or later. Its fee refusal drops a whole asset group at once, which the wallet's rebuild of a refused deposit relies on.

Set these in the pool's runtime environment ([DOKPLOY.md](DOKPLOY.md)) and redeploy, with a keeper ready to start. The [First turn-on checklist](#first-turn-on-checklist) gives the order:

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

A malformed fee never runs the pool fee-free: the pool stays closed. `/api/rollup/status` shows `"phase": "blocked"` with the reason in `message`, and the log repeats it. Blocked: a missing, malformed or mismatched address or view key; SATS or BPS that is not plain decimal digits; BPS above 10000; SATS or BPS above 0 without an address and view key; any other variable starting `SHIELDED_DEPOSIT_FEE_` (a misspelling). Fix it and redeploy. `/health` answers 503 while blocked, so a rollout that starts the new instance first should keep the old one serving; this is not verified on Dokploy.

**Turning the fee on restarts the pool.** Pending spends are re-admitted on the restart. A deposit made only of this pool's own payouts is exempt and is re-admitted; any other fee-less deposit is dropped with its reason, and its wallet rebuilds it with the fee once it has accepted the fee (last paragraph of this section). With a fee on, the operator also keeps `batch-txids.json` beside its batch records (`rollup4/operator/` under the data directory). It only caches those records, so it needs no backup: if it is missing or damaged, as on the first start with the fee on, the operator rebuilds it from them.

The fee is live when `/api/rollup/status` shows it. Until it does, no wallet pays it:

```sh
curl -s https://shielded.mutinynet.arkade.sh/api/rollup/status | jq .pool.depositFee
```

A wallet pauses automatic shielding while the advertised fee is above what it has accepted, in either number: a wallet that accepted nothing when the fee is first turned on, any wallet when you raise SATS or BPS past its ceiling (a fee at or below it needs no new acceptance). The page then shows an **Accept the new fee** banner; an SDK wallet needs a higher `maxDepositFee`. A wallet the page creates after the fee is on accepts the fee its funding card showed, which is why checklist step 4 has no accept click. A wallet restored from a phrase accepts nothing and shows the banner, which withdrawing does not need.

## Run the keeper

Every fee-paying deposit mints one fee note. The keeper merges them down to one note, which keeps them inside the window in which they can be spent (see [If the keeper stops](#if-the-keeper-stops)) and lets a withdrawal, which spends a single note, pay out the whole balance.

Run it on a separate host. On the pool's own host, even outside the container, one compromise would reach the phrase as well as the view key, which undoes the point of a separate wallet. It never runs inside the pool's container. It needs a checkout after `npm ci` and Node 24.2 or later, because its direct-run check, `import.meta.main`, arrived in 24.2.

| Variable | Meaning |
| --- | --- |
| `SHIELDED_POOL_ORIGIN` | The pool, for example `https://shielded.mutinynet.arkade.sh` |
| `SHIELDED_FEE_WALLET_PHRASE` | The 24 words, from the secret store |
| `SHIELDED_FEE_KEEPER_INTERVAL_MS` | Optional: the pause between passes, a whole number of milliseconds from 1000 to 2147483647, digits only; default 60000. Anything else is refused, `60` included, which would be 60 ms, not a minute |

```sh
npm run fee:keeper
```

It keeps nothing on disk, so each start reads the whole pool again. It logs `syncing with <pool>` first, and the start line comes only after that read, because creating the wallet waits for the first sync; the first pass follows at once. It exits with status 1 if the pool is not open when it starts (blocked, restarting, unreachable) and does not retry. Run it under a supervisor that restarts it.

It logs a line when it starts syncing, one when it starts merging, one for each merge that lands, and one at the end of each pass:

```
<time> syncing with https://shielded.mutinynet.arkade.sh
<time> fee wallet shrol2… holds 1200 sats; merging every 60000 ms
<time> merge 1 landed, batch 411
<time> merge 2 landed, batch 412
<time> merged 2, notes remaining 1, batch 412
```

`merge n landed` counts the merges of the current pass. In the pass line, `merged` counts the merges in that pass and `notes remaining` is every note the wallet holds, including notes awaiting recovery. `batch` is how far the wallet has read the pool. A pass ends, and prints its line, when nothing is left to merge or after a failed merge. A merge that was sent and then fails, or has not landed 10 minutes after it was sent, is logged to stderr as `merging asset … failed, trying again next pass: …`, and the wallet waits 60 s before it builds another merge. A merge that cannot be planned is logged the same way and sets no wait. Node's one-time `EventSource is experimental` warning on stderr at start is expected.

**Wrong phrase.** If the pool advertises a fee address that is not this wallet's, the keeper writes `The pool sends its deposit fee to <the pool's address>, not to this wallet <this wallet's>; check SHIELDED_FEE_WALLET_PHRASE.` to stderr and exits 1. It checks once the wallet has synced, so the refusal follows the start-up wait. If the pool's fee address changes under a running keeper, the same message is logged at the start of each pass and the keeper carries on. With the fee off the pool advertises no address and there is nothing to check, so compare the start line's `shrol2…` with the address `--derive` printed.

**One keeper per phrase.** A second keeper on the same phrase only races the first for the same notes: the pool takes one merge and refuses the other as a double spend, which that keeper logs as a failed merge.

## First turn-on checklist

Use a small fixed fee for the first run (`SHIELDED_DEPOSIT_FEE_SATS=100`, `SHIELDED_DEPOSIT_FEE_BPS=0`), once both conditions under [Configure the pool](#configure-the-pool) hold.

**Dry run first, with the fee off.** Before step 1, run the keeper on the fee wallet against the pool while it still charges nothing, and watch it merge:

- Start it (`npm run fee:keeper`) with the fee wallet's phrase. Its start line prints the wallet's `shrol2…`, which should be the `SHIELDED_DEPOSIT_FEE_ADDRESS` that `--derive` printed.
- From any test wallet that holds a shielded balance (a deposit of at least 330 sats made while the fee is off), pay that `shrol2…` address twice: on the **Send** tab paste it into **To**, enter the sats, press **Get quote**, then **Private payment**. The page, the wallet and the pool enforce no minimum on a payment to a shielded address; only a withdrawal has one, 330 sats. So pay at least 330 sats in all, for example 200 and 200, or the merged note could not be withdrawn.
- Watch for `merge 1 landed`, then a pass line with `notes remaining 1`.
- Then withdraw the test funds from the fee wallet ([Spend the fees](#spend-the-fees)).

1. Have the keeper's host ready, with the phrase in its secret store. Set the four variables and redeploy. When `/api/rollup/status` shows `"phase": "ready"`, start the keeper, before the first deposit.
2. `curl -s https://shielded.mutinynet.arkade.sh/api/rollup/status | jq .pool.depositFee` shows `{fixedSats, bps, address}`, with the address the keeper's start line prints. The same URL piped to `grep -c shview` prints `0`: the view key is not served.
3. In a fresh browser profile, open `/wallet`. The funding card names the fee.
4. Fund the wallet from the Mutinynet faucet (linked on the funding card) with at least 330 sats plus the fee; a smaller coin stays outside the pool, and the card says so. No accept click is needed. One deposit lands, and its History row has a **Deposit fee** line equal to the configured fee.
5. The keeper logs `notes remaining 1` within a pass or two of the deposit (the wallet syncs on pool events and every 60 s). Restart it: the start line reads `holds N sats`, N being the fee. Fund again, and the first pass after that deposit lands logs `merge 1 landed`, then `merged 1, notes remaining 1`.
6. Withdraw at least 330 sats to this wallet's own Arkade address, the one on the funding card. When the payout lands, the **BACK ON ARKADE FROM THE POOL** card shows **Shield again**. Press it: the whole payout shields with no fee and no `fee-missing` refusal, because a deposit made only of this pool's own payouts pays nothing. So 330 sats is enough here; the faucet deposit needed 330 plus the fee. If the card does not appear, the payout went elsewhere or has not landed; that is not a failed exemption.
7. On the **Receive** tab, open **How Lightning receive works** on the Lightning card. Its minimum is the 330-sat minimum plus the fee: at the 100-sat fee it reads `Payouts of at least 430 sats, the 330-sat minimum plus the deposit fee, move into the pool while this page is open`.
8. Check a tab that was already open before the turn-on. If it still runs the page from before the fee shipped, the pool refuses its next deposit with `A deposit of … sats owes a 100-sat deposit fee to this pool; this one carries 0. Reload the page to shield at the current fee.` After a reload the wallet already in that browser shows **Shielding is paused** with **Accept the new fee** (only a wallet the page has just created accepts the fee by itself), and its deposit shields once the fee is accepted. A tab that already runs the page with the fee needs no reload: the wallet reads the pool's status every 60 s, so the same banner appears within a minute.
9. If anything above fails, unset the variables and redeploy ([Turn the fee off](#turn-the-fee-off)).

## If the keeper stops

A note spends directly only in the epoch it was made in and the next one (an epoch is 128 batches). A fee note not merged or renewed by then falls out of that window and can only be recovered. A recovery is a one-slot batch, so each missed note costs the pool a whole batch of capacity. The fees are not lost: the notes stay recoverable and the phrase still spends them.

Restart the keeper. Its wallet's watchdog recovers held notes on its own, and the keeper then merges what was recovered.

The keeper has a ceiling. It merges one pair at a time and waits for each merge to land, so it removes about one note per batch, while every fee-paying deposit adds one. If fee-paying deposits come faster than about one per batch, the backlog grows until notes age out and fall to recovery. No setting raises this: `SHIELDED_FEE_KEEPER_INTERVAL_MS` only spaces passes, and within a pass the keeper already merges back to back. The levers are the fee level (a higher fee should bring fewer, larger deposits) and accepting some recoveries, which cost the pool a batch each and lose no fees.

A keeper that is keeping up logs `merge n landed` as each merge settles and ends each pass with a pass line, about one interval after the last. In the pass lines `merged` is small, `notes remaining` is 1 (0 before the first fee), and the newest line's `batch` is within a few of `pool.batches` in `/api/rollup/status`. A backlog shows as a pass that keeps finding more to merge: `merge n landed` lines with n climbing, then a large `merged` in the pass line. A `notes remaining` that stays above 1 after a pass means a merge failed (stderr says so, and the wallet waits 60 s before the next try) or notes are waiting for recovery.

Each merge waits for its batch, and the wallet gives up on a sent merge after `MERGE_WAIT_MS`, 10 minutes (`src/shielded/wallet.ts`), logging it as failed. So the longest a healthy keeper stays silent, stdout and stderr together, is the pass interval plus 10 minutes plus the time to prove one merge. If it is silent for longer, treat it as stuck: check that `/api/rollup/status` shows `"phase": "ready"`, then restart the keeper. Nothing is kept on disk and the notes are in the pool, so a restart loses nothing; the start reads the pool again.

## Spend the fees

Any wallet on the phrase can spend the fee notes. A withdrawal spends one note, so it pays out at most your largest note (which the keeper's merging makes the whole balance), and at least 330 sats.

- **The web wallet.** Open `/wallet` in a fresh browser profile, because a restore replaces any wallet already in that browser. Expand **Recovery phrase and restore**, paste the phrase into **Restore from a recovery phrase**, and press **Restore wallet**. A **Created on** date skips older pool history; use the day you turned the fee on, or any earlier day. The restore saves the wallet secret in that browser's local storage, so clear the site data afterwards.
- **Code.** Call `createShieldedWallet` from `@arkade-os/shielded` with the phrase as `secret`, then `wallet.withdraw(arkAddress, sats)` and await the handle's `settled()`. See [packages/shielded/README.md](../packages/shielded/README.md).

## Turn the fee off

Unset the four variables and redeploy. Setting SATS and BPS to 0 and keeping the address and view key also turns it off, and the pool logs a warning. Do not unset only some of them. With SATS or BPS above 0, unsetting just the address or just the view key does not turn the fee off: it blocks the pool (`"phase": "blocked"`, and no deposits until you fix the variables and redeploy). So does an address or a view key on its own with SATS and BPS at 0.

The redeploy restarts the pool, as turning the fee on does. When it is back, check that the fee is gone:

```sh
curl -s https://shielded.mutinynet.arkade.sh/api/rollup/status | jq .pool.depositFee
```

It prints `null`. Trust that only once the same command with `jq .phase` prints `"ready"`: a pool that is still restarting, or is blocked, has no `pool` object and prints `null` too.

Wallets return to fee-less deposits on their next `/api/rollup/status` read. Fee notes already minted stay spendable from the phrase.

Keep the keeper running until you have withdrawn the remaining balance. Notes that nobody renews fall to recovery, as described above.
