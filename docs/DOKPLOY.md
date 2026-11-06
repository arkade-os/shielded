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

**Turn it on.** For testing only for now. Production use waits until the gateway accepts only configured relays (planned) and until memory has been measured with 32 concurrent 4 MiB answers. Run `npm run ohttp:keygen -- <file>` on a trusted machine. It writes the line `SHIELDED_OHTTP_KEY=<key id>:<private key>` to `<file>` (mode 0600, which holds on Linux and macOS but not on Windows, and it refuses to overwrite an existing file) and prints only the key id and the config, which are public. Paste the line into the application's runtime **Environment**, delete the file and redeploy. Never put the key in a command line, a log, a chat or the repository. Publish the printed config: the wallet build that uses the gateway pins it.

**Verify.** The start log shows `Oblivious HTTP gateway on (key id N).`, with the key id the tool printed. `GET /api/rollup/ohttp-keys` then returns content type `application/ohttp-keys`, and its bytes equal the printed config. This prints the content type and the bytes in the tool's base64url encoding:

```
node -e "fetch(process.argv[1]).then(async r=>console.log(r.headers.get('content-type'),Buffer.from(await r.arrayBuffer()).toString('base64url')))" https://HOSTNAME/api/rollup/ohttp-keys
```

This proves the key and the config. It does not prove the gateway's hop to the pool or to the upstreams; only a sealed request through a relay does. The response is cacheable for an hour, so a cache in front can show the old config for that long after a rotation.

**Settings.** Runtime environment variables:

- `SHIELDED_OHTTP_KEY`: the private key as `<key id>:<base64url key>`. A secret. Unset or empty leaves the gateway off.
- `SHIELDED_OHTTP_RATE`: requests per second across all callers. Default 20.
- `SHIELDED_PUBLIC_ORIGIN`: the origin a wallet names for the pool inside a sealed request. Default `https://shielded.mutinynet.arkade.sh`. Set it on any other domain.
- `SHIELDED_ESPLORA_URL`: the Esplora base URL. Default `https://mempool.mutinynet.arkade.sh/api`.
- `SHIELDED_ARK_URL` and `SHIELDED_INDEXER_URL`: already used by the pool, and the gateway forwards to the same servers. The indexer defaults to the arkd URL.

A malformed key, a rate that is not a whole number of at least 1, an upstream URL that is not `https`, or a `PORT` that is not a fixed number stops the server at start, like any other bad setting. The error never prints the key. While there is no key, the other checks do not run, and the rate, the public origin and the Esplora URL are ignored.

**What it forwards.** Only `GET` and `POST`, and only to these:

- the pool, for paths under `/api/rollup/` other than the gateway's own two, reached at `http://127.0.0.1:$PORT`. The image sets `HOST=0.0.0.0` and `PORT=8792`: do not set `HOST` in Dokploy, and keep `PORT` a fixed number;
- arkd under `/v1/`, the indexer under `/v1/indexer/`, and Esplora under its base path, each after the path of the configured base URL.

Event streams are refused. The gateway's pool requests carry a token it makes at start. The pool lets only loopback requests with that token skip its per-address limit on submissions, because every sealed request would otherwise count against 127.0.0.1. The gateway's own budget applies instead.

**What the shared budget costs.** One holder of the public key config can submit at the whole `SHIELDED_OHTTP_RATE`: 20 a second by default, about 1,200 a minute, against 60 a minute per address when calling the pool directly. Each submission costs a Groth16 check. The budget is shared and first come, first served, so that caller crowds out every other sealed caller, reads included. It can also push direct `/spends` requests to a 503 "busy", because the cap on spends being checked at once (8) is shared by everyone. To cut it, lower `SHIELDED_OHTTP_RATE` or unset the key.

**Limits and logs.** A request over 1 MiB gets an outer 413, and one still uploading after 30 seconds is cut off. A response over 4 MiB, or an upstream that takes over 30 seconds, comes back as an inner 502 or 504. All callers share one budget, `SHIELDED_OHTTP_RATE` a second and 32 requests in flight; past it the gateway answers an outer 429 or 503 with `Retry-After: 1`. It logs counts by kind, such as `[ohttp] forwarded 120, busy 3`, at most once a minute, and never a target or a body.

**Rotate.** The gateway holds one key at a time. Run `ohttp:keygen` again. It picks the key id at random, so if it prints the id already in use, run it again. Replace the `SHIELDED_OHTTP_KEY` line, redeploy and publish the new config. The wallet build that uses the gateway pins the config, so a rotation also needs a new app build. Until a client has the new config, its requests are sealed to the old key id, and the gateway answers them with an outer 400.

**Roll back.** Unset `SHIELDED_OHTTP_KEY` and redeploy. The start log then says `Oblivious HTTP gateway off.` and, once the pool has opened, both paths answer 404.

**The relay.** The gateway only opens requests; a separate relay carries them. It must be run by someone other than us or Arkade: the relay sees who is asking and the gateway sees what, so one operator for both would see both. It must not sit on Cloudflare, which already fronts this domain. It must apply a per-client rate limit, because it is the only hop that sees callers. It forwards each sealed request as `POST /api/rollup/ohttp` with content type `message/ohttp-req`, and it adds the CORS headers for the wallet's origin. The gateway sends none, because the browser talks only to the relay.
