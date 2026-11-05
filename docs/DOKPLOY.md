# Deploy Shielded on Dokploy

Create a Dokploy **Application** from this repository and its `main` branch. Choose the Dockerfile build type with the path `Dockerfile.dokploy`. The image downloads the genesis-4 proving keys from the GitHub release named in `Dockerfile.dokploy` (the `SHIELDED_ROLLUP_KEYS_URL` build argument) and keeps each file only if it matches `rollup-keys/genesis-4.json`. It also downloads the pinned rapidsnark prover release, checks its SHA-256, and builds the Arkade VM bridge and the web app, then starts `src/server.ts`. The host never runs a key setup.

Add the variables from [`dokploy.env.example`](../dokploy.env.example) to the runtime environment. Only Mutinynet is supported. Read [FEE-WALLET.md](FEE-WALLET.md) before setting the deposit fee variables.

Use a single-node host. In **Advanced → Volumes/Mounts**, mount one persistent volume at `/data` and set the container port to `8792`. Keep one replica: the pool journal allows a single writer. The default Swarm update order works: a replacement reports healthy while it waits for the previous container to release the pool, then takes over. Keep the volume across updates. It holds the operator keys, the proving keys and the pool journal; losing it loses the pool.

On first start the service copies those keys onto the volume and verifies them. It then shows an operator funding address in `/api/rollup/status`. Send at least 2,000 sats there and the service creates the pool.

For the domain, point an A record at the Dokploy server. In the application's **Domains** settings, route the hostname to port `8792` over HTTP and enable HTTPS. The wallet is at `https://HOSTNAME/wallet` and the health check at `/health`. Do not expose port `8792` directly; Dokploy's proxy handles public traffic.

Pushes to `main` deploy automatically and do not wait for GitHub Actions. Confirm a deploy by the bundle hash the site serves, not by Dokploy's status.

## App cache

The web app runs from a service worker cache. A browser checks `/sw.js` about once a day, installs a new version in the background and switches to it only when the user taps **Update**. Two build arguments change that. Set them in **Environment → Build Time Arguments**, not in the runtime environment, and redeploy. While either is on, the build log prints a `[plugin app-cache]` line naming it.

**Forcing.** `SHIELDED_APP_CACHE_FORCE=1` is only for a release that crashes before the Update bar can show: a browser installs the forced build and reloads its tabs without asking. Set it as a build argument, deploy, then purge `/sw.js` in Cloudflare. Unset it before the next push to `main` deploys, or every later deploy skips consent too.

**Rollback.** A forced build of the last good commit.

**Removal.** `SHIELDED_APP_CACHE_OFF=1` ships a worker that deletes the app's caches, unregisters itself and reloads the tabs it controlled, and the page stops registering one. A browser removes its copy the next time it checks `/sw.js`, so keep the argument set for as long as the cache should stay off.

**Reloading no longer fetches new code.** An open or returning tab keeps the version it has until the user taps Update. A server change that breaks old clients needs about a day of compatibility, plus however long users wait to tap Update, or a forced build.
