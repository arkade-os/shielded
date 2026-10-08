# Deploy Shielded on Dokploy

Create a Dokploy **Application** from this repository and its `main` branch. Choose the Dockerfile build type with the path `Dockerfile.dokploy`. The image compiles the rollup circuits, the pinned rapidsnark prover, the Arkade VM bridge and the web app, then starts `src/server.ts`.

Add the variables from [`dokploy.env.example`](../dokploy.env.example) to the runtime environment. Only Mutinynet is supported.

Use a single-node host. In **Advanced → Volumes/Mounts**, mount one persistent volume at `/data` and set the container port to `8792`. Keep one replica: the pool journal allows a single writer. The default Swarm update order works: a replacement reports healthy while it waits for the previous container to release the pool, then takes over. Keep the volume across updates. It holds the operator keys, the proving keys and the pool journal; losing it loses the pool.

On first start the service generates development proving keys, which needs at least 4 GiB of memory. It then shows an operator funding address in `/api/rollup/status`. Send at least 2,000 sats there and the service creates the pool.

For the domain, point an A record at the Dokploy server. In the application's **Domains** settings, route the hostname to port `8792` over HTTP and enable HTTPS. The wallet is at `https://HOSTNAME/wallet` and the health check at `/health`. Do not expose port `8792` directly; Dokploy's proxy handles public traffic.

Pushes to `main` deploy automatically and do not wait for GitHub Actions. Confirm a deploy by the bundle hash the site serves, not by Dokploy's status.
