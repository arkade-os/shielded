import type {SwapClientConfig} from '@arkade-os/swap';
import {attesting} from '@arkade-os/swap/advanced';
import {nostrCardFetcher,nostrRfqTransport} from '@arkade-os/swap/nostr';
import type {PrivateTransport} from './private-transport.ts';

/** Swaps for the sealed transport: the solver registry from the pool's mirror and every relay read and write through the pool's rendezvous, so no socket opens and no foreign host is asked. Kept out of the private boot's module graph, since the swap's Nostr module captures WebSocket as it loads. */
export function privateSwapConfig(transport:Pick<PrivateTransport,'fetch'|'poolOrigin'|'rfqPool'>):Pick<SwapClientConfig,'fetchImpl'|'discovery'|'transportFor'> {
 return {fetchImpl:transport.fetch,
  discovery:{fetchImpl:transport.fetch,registryUrl:transport.poolOrigin+'/api/rollup/solver-registry',transportCards:nostrCardFetcher({pool:transport.rfqPool() as never,timeoutMs:15_000})},
  // attesting is what verifyResponder reads: without it every quote fails as unattested.
  transportFor:rendezvous=>attesting(nostrRfqTransport({relays:[...rendezvous.relays],solverPubkey:rendezvous.solverPubkey,pool:transport.rfqPool() as never}),rendezvous.solverPubkey)};
}
