# Deploy Shielded on Dokploy

Create a Dokploy **Application** from this repository and its `main` branch. Choose the Dockerfile build type with the path `Dockerfile.dokploy`. The image downloads the genesis-4 proving keys from the GitHub release named in `Dockerfile.dokploy` (the `SHIELDED_ROLLUP_KEYS_URL` build argument) and keeps each file only if it matches `rollup-keys/genesis-4.json`. It also downloads the pinned rapidsnark prover release, checks its SHA-256, and builds the Arkade VM bridge and the web app, then starts `src/server.ts`. The host never runs a key setup.

Add the variables from [`dokploy.env.example`](../dokploy.env.example) to the runtime environment. Only Mutinynet is supported. Read [FEE-WALLET.md](FEE-WALLET.md) before setting the deposit fee variables.

Use a single-node host. In **Advanced → Volumes/Mounts**, mount one persistent volume at `/data` and set the container port to `8792`. Keep one replica: the pool journal allows a single writer. The default Swarm update order works: a replacement reports healthy while it waits for the previous container to release the pool, then takes over. Keep the volume across updates. It holds the operator keys, the proving keys and the pool journal; losing it loses the pool.

On first start the service copies those keys onto the volume and verifies them. It then shows an operator funding address in `/api/rollup/status`. Send at least 2,000 sats there and the service creates the pool.

For the domain, point an A record at the Dokploy server. In the application's **Domains** settings, route the hostname to port `8792` over HTTP and enable HTTPS. The wallet is at `https://HOSTNAME/wallet` and the health check at `/health`. Do not expose port `8792` directly; Dokploy's proxy handles public traffic.

Pushes to `main` deploy automatically and do not wait for GitHub Actions. Confirm a deploy by the bundle hash the site serves, not by Dokploy's status.

## App cache

The web app runs from a service worker cache. A browser checks `/sw.js` about once a day, installs a new version in the background and switches to it when the user taps **Update** or when every tab using the old version has closed. Two build arguments change that. Set them in **Environment → Build Time Arguments**, not in the runtime environment, and redeploy. While either is on, the build log prints a `[plugin app-cache]` line naming it.

**Forcing.** `SHIELDED_APP_CACHE_FORCE=1` is only for a release that crashes before the Update bar can show: a browser installs the forced build and reloads its tabs without asking. Set it as a build argument, deploy, then purge `/sw.js` in Cloudflare. Unset it before the next push to `main` deploys, or every later deploy skips consent too.

**Rollback.** A forced build of the last good commit. If that commit predates the app cache, its build has no worker and answers `/sw.js` with a 404, which leaves the old worker in control. Deploy a cache-enabled build with `SHIELDED_APP_CACHE_OFF=1` first, keep it deployed until affected browsers have fetched it (at least a day, plus however long their users take to visit), and only then roll back to the older commit.

**Removal.** `SHIELDED_APP_CACHE_OFF=1` ships a worker that deletes the app's caches, unregisters itself and reloads the tabs it controlled, and the page stops registering one. A browser removes its copy the next time it checks `/sw.js`, so keep the argument set for as long as the cache should stay off.

**Reloading no longer fetches new code.** An open or returning tab keeps the version it has until the user taps Update or every tab using it has closed. A server change that breaks old clients needs about a day of compatibility, plus however long users wait to tap Update, or a forced build.

## Oblivious HTTP gateway

The pool server can open Oblivious HTTP (RFC 9458) requests, so a wallet reaches the pool, arkd, the Arkade indexer and Esplora through a relay that sees its address but not what it asks for. The gateway is off until `SHIELDED_OHTTP_KEY` is set. While it is off, `GET /api/rollup/ohttp-keys` and `POST /api/rollup/ohttp` answer 404 once the pool has opened. Before that they get the pool's 503 instead: "The rollup pool is starting.", or "The rollup pool is not open yet" while the pool is not open, for example while a rollout waits for the volume lock.

**Turn it on.** For testing only for now. Production use waits for four things: the gateway accepting only configured relays (planned), a measurement of memory with 32 concurrent 4 MiB answers, a replay window, and a way to rotate the key without stranding wallets. Today a repeated sealed request is refused only while an in-memory register remembers it, and a restart clears that register. A time bound needs the wallet to send an inner `Date` (RFC 9458 section 6.5.1), which is wallet-side work. Rotation is a hard cut (see **Rotate**), so before any wallet pins a config, the gateway needs to hold the old and new keys together, or wallets need a stale-key signal they act on. Run `npm run ohttp:keygen -- <file>` on a trusted machine. It writes the line `SHIELDED_OHTTP_KEY=<key id>:<private key>` to `<file>` (mode 0600, which holds on Linux and macOS but not on Windows, and it refuses to overwrite an existing file) and prints only the key id, the config and the gateway's Nostr key (`nostr: <hex>`), which are public. Paste the line into the application's runtime **Environment**, delete the file and redeploy. Never put the key in a command line, a log, a chat or the repository. Publish the printed config and Nostr key: the wallet build that uses the gateway pins both.

**Verify.** The start log shows `Oblivious HTTP gateway on (key id N, Nostr 3c857963…, 6 relays, HTTP route off).`, with the key id and the first 8 characters of the Nostr key the tool printed. `GET /api/rollup/ohttp-keys` then returns content type `application/ohttp-keys`, and its bytes equal the printed config. This prints the content type and the bytes in the tool's base64url encoding:

```
node -e "fetch(process.argv[1]).then(async r=>console.log(r.headers.get('content-type'),Buffer.from(await r.arrayBuffer()).toString('base64url')))" https://HOSTNAME/api/rollup/ohttp-keys
```

This proves the key and the config. It does not prove the gateway's hop to the pool or to the upstreams; only a sealed request does. The response is cacheable for an hour, so a cache in front can show the old config for that long after a rotation.

**Settings.** Runtime environment variables:

- `SHIELDED_OHTTP_KEY`: the private key as `<key id>:<base64url key>`. A secret. Unset or empty leaves the gateway off.
- `SHIELDED_OHTTP_RATE`: requests per second across all callers, from the Nostr carrier and the HTTP route alike. Default 20.
- `SHIELDED_NOSTR_RELAYS`: the `wss://` relays the Nostr carrier listens on, separated by commas. Unset or blank uses the six relays under **Nostr carrier**.
- `SHIELDED_OHTTP_HTTP`: `1` mounts `POST /api/rollup/ohttp`, the route an HTTP relay uses. Anything else leaves it off, and sealed requests arrive only over Nostr.
- `SHIELDED_PUBLIC_ORIGIN`: the origin a wallet names for the pool inside a sealed request. Default `https://shielded.mutinynet.arkade.sh`. Set it on any other domain.
- `SHIELDED_ESPLORA_URL`: the Esplora base URL. Default `https://mempool.mutinynet.arkade.sh/api`.
- `SHIELDED_ARK_URL` and `SHIELDED_INDEXER_URL`: already used by the pool, and the gateway forwards to the same servers. The indexer defaults to the arkd URL. Both are bare origins, with no path, as the pool already requires.

A malformed key, a rate that is not a whole number of at least 1, an upstream URL that is not `https` (or an arkd or indexer URL that is not a bare origin), a relay list with an entry that is not a `wss://` URL, a `PORT` that is not a fixed number, or a `HOST` other than `0.0.0.0` or `127.0.0.1` stops the server at start, like any other bad setting. The error never prints the key. While there is no key, the other checks do not run, and the rate, the public origin, the Esplora URL, the relay list and the HTTP route setting are ignored.

**What it forwards.** Only `GET` and `POST`, and only to these:

- the pool, for paths under `/api/rollup/` other than the gateway's own two, reached at `http://127.0.0.1:$PORT`. The image sets `HOST=0.0.0.0` and `PORT=8792`: do not set `HOST` in Dokploy, where `127.0.0.1` would cut off the proxy, and keep `PORT` a fixed number;
- arkd under `/v1/` and the indexer under `/v1/indexer/`, each on a bare origin, and Esplora under the path of its base URL.

If the pool's public origin is also an upstream's, only `/api/rollup/` paths on it go to the pool; every other path on it is checked against the upstream list. Event streams are refused. The gateway's pool requests carry a token it makes at start. The pool lets only loopback requests with that token skip its per-address limit on submissions, because every sealed request would otherwise count against 127.0.0.1. The gateway's own budget applies instead.

**What the shared budget costs.** One holder of the public key config can submit at the whole `SHIELDED_OHTTP_RATE`: 20 a second by default, about 1,200 a minute, against 60 a minute per address when calling the pool directly. Each submission costs a Groth16 check. The budget is shared and first come, first served, so that caller crowds out every other sealed caller, reads included. It can also push direct `/spends` requests to a 503 "busy", because the cap on spends being checked at once (8) is shared by everyone. To cut it, lower `SHIELDED_OHTTP_RATE` or unset the key.

**Limits and logs.** A request over 1 MiB gets an outer 413, and one still uploading after 30 seconds is cut off. A response over 4 MiB, or an upstream that takes over 30 seconds, comes back as an inner 502 or 504. Whatever the upstream or the reading client does, the connection is cut after 90 seconds, three times that deadline, so no request holds a slot longer. Of the upstream's headers only the content type, the cache control and `Retry-After` cross, so a sealed client can wait as told. All callers share one budget, `SHIELDED_OHTTP_RATE` a second and 32 requests in flight; past it the gateway answers an outer 429 or 503 with `Retry-After: 1`. It logs counts by kind, such as `[ohttp] forwarded 120, busy 3`, at most once a minute, and never a target or a body.

**Rotate.** The gateway holds one key at a time. Run `ohttp:keygen` again. It picks the key id at random, so if it prints the id already in use, run it again. Replace the `SHIELDED_OHTTP_KEY` line, redeploy and publish the new config. The wallet build that uses the gateway pins the config, so a rotation also needs a new app build. Until a client has the new config, its requests are sealed to the old key id, and the gateway answers them with an outer 400.

**Roll back.** Unset `SHIELDED_OHTTP_KEY` and redeploy. The start log then says `Oblivious HTTP gateway off.`, the Nostr listener does not start and, once the pool has opened, both HTTP paths answer 404.

**The HTTP relay.** With `SHIELDED_OHTTP_HTTP=1` the gateway only opens requests, and a separate relay carries them. It must be run by someone other than us or Arkade: the relay sees who is asking and the gateway sees what, so one operator for both would see both. It must not sit on Cloudflare, which already fronts this domain. It must apply a per-client rate limit, because it is the only hop that sees callers. It forwards each sealed request as `POST /api/rollup/ohttp` with content type `message/ohttp-req`, and it adds the CORS headers for the wallet's origin. The gateway sends none, because the browser talks only to the relay.

### Nostr carrier

A wallet can also send its sealed request inside a Nostr event, so no relay of ours or Arkade's has to carry it. The listener subscribes to each relay for kind 21470 events addressed to the gateway's Nostr key and opens each through the same gateway as the HTTP route, with the same rate, in-flight cap and repeat check. It publishes the sealed answer as kind 21471 events signed by that key, to the relays that delivered the request. A request is one event of at most 32 KiB. An answer is at most 32 events of 32 KiB, and the listener asks the gateway for no more than 960 KiB of upstream body, so a larger upstream answer comes back as an inner 502. When the gateway is busy the listener publishes a status event instead (503 over 32 requests in flight, 429 over the rate, each with a retry delay of 1 second) and runs nothing, so the wallet may send again. A request the gateway cannot open (not sealed to this key, or a repeat) gets no answer, and neither does any event that is not a valid request.

**Relays.** `SHIELDED_NOSTR_RELAYS` is a comma-separated list of `wss://` URLs. Unset or blank, it is `wss://nos.lol`, `wss://relay.snort.social`, `wss://offchain.pub`, `wss://nostr.mom`, `wss://nostr.oxtr.dev` and `wss://nostr-pub.wellorder.net`, none of which sat behind Cloudflare when probed on 2026-11-06. Choose relays by the same rule as the HTTP relay: a relay sees who is publishing and the gateway sees what, so no relay may be run by us or Arkade (never `wss://nostr.arkade.sh`), and none may sit behind Cloudflare, which already fronts this domain. A wallet publishes to relays from its own list, and a relay the gateway does not listen on only costs it an attempt, so keep this list equal to the wallet build's or larger.

**The key.** The gateway's Nostr key is derived from the OHTTP key (HKDF-SHA256 over the 32-byte secret, with the info `shielded-nostr-carrier-v1`), so there is no second secret to keep and a rotation changes both. `ohttp:keygen` prints its public half as `nostr: <hex>`, and the start log shows the first 8 characters.

**Start and stop.** The listener starts once, the first time the pool has opened, and logs `Nostr carrier listening on N relays.` It closes before the pool does. While a rollout waits for the previous instance to release the volume, the new instance does not listen.

**What a relay and its readers see.** The relay sees the address of the wallet that publishes, and the event: a one-time key as author, the gateway's key in the `p` tag, a time rounded down to 30 seconds and the sealed bytes. Anyone who reads the relay sees the same events without the address, and the answers: the gateway's key as author, the request id and the one-time key in the tags, the number of chunks and when. Neither learns the target or the body, which only the gateway can open. The gateway learns them but not the address, because a relay is the only path a request takes to it. Sizes show: a request's length and an answer's chunk count say roughly how much was asked and returned.

**Logs.** The listener logs counts by kind, such as `[nostr] answered 12, busy 1, dropped 3`, at most once a minute, and never an event, a relay or a target. `answered` and `busy` are published; `refused` is a request the gateway would not open; `dropped` is an event that is not a valid request; `duplicate` is another copy of a request already seen; `failed` is an error after the request was accepted, where nothing is published because the request may have run; `unpublished` is an answer event a relay refused or timed out; `lost` is a relay that closed its subscription, which the listener reopens after 30 seconds.

**Limits.** The listener sends no pings, so a connection that dies without closing stays quiet until the network or the relay closes it, and restarting the service reopens it. The Nostr library also keeps every event id a relay sends for as long as the process runs, measured at about 440 bytes each.
