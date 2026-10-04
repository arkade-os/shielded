import { createCompactLiveRuntime } from "./live.ts";
import { createCompactReadyLiveRuntime } from "./ready-live.ts";
import type { NativeCheckpoint, SdkRuntime, SdkRuntimeOptions } from "../sdk/runtime.ts";

type FreshRecovery = { version?: number; profileId?: string; freshStart?: boolean };
type BootstrapLive = NonNullable<NativeCheckpoint["live"]> & { bootstrapRecovery?: FreshRecovery };
type FreshContinuation = (checkpoint: NativeCheckpoint,
  onProgress: (checkpoint: NativeCheckpoint) => void) => Promise<NativeCheckpoint>;
export type CompactBootstrapFactories = {
  createLegacy(options: SdkRuntimeOptions): Promise<SdkRuntime>;
  createReady(options: SdkRuntimeOptions): Promise<SdkRuntime>;
};

class RegisteredProfileBoundary extends Error {}

function hasFreshMarker(checkpoint: NativeCheckpoint): boolean {
  const marker = (checkpoint.live as BootstrapLive | undefined)?.bootstrapRecovery;
  return marker?.version === 1 && marker.freshStart === true && marker.profileId === checkpoint.compact?.profileId;
}

function hasCompletedFreshBootstrap(checkpoint: NativeCheckpoint): boolean {
  if (checkpoint.live?.phase !== "ready" || !checkpoint.compact?.profileId || !checkpoint.genesisRaw || !checkpoint.issuanceRaw ||
      ["gate", "lane", "btcVault", "tokenVault"].some((name) => !checkpoint.heads[name])) return false;
  const recovery = (checkpoint.live as BootstrapLive).bootstrapRecovery as
    { version?: number; profileId?: string; freshStart?: boolean; heads?: Record<string, { request?: { arkTx?: string; checkpoints?: string[] };
      response?: { arkTxid?: string }; finalizedCheckpointTxs?: string[] }> } | undefined;
  return recovery?.freshStart === true && recovery.version === 1 && recovery.profileId === checkpoint.compact.profileId &&
    ["gate", "lane", "btcVault", "tokenVault"].every((name) => {
      const receipt = recovery.heads?.[name];
      return Boolean(receipt?.request?.arkTx && receipt.response?.arkTxid && receipt.finalizedCheckpointTxs &&
        receipt.finalizedCheckpointTxs.length === receipt.request.checkpoints?.length);
    });
}

function canStartFresh(checkpoint: NativeCheckpoint): boolean {
  return checkpoint.network === "mutinynet" && checkpoint.live?.phase === "funding-programs" &&
    !Object.keys(checkpoint.heads ?? {}).length && !checkpoint.live.pendingBootstrap;
}

function hasUnmarkedPartialFunding(checkpoint: NativeCheckpoint): boolean {
  return checkpoint.live?.phase === "funding-programs" && !hasFreshMarker(checkpoint) &&
    (Object.keys(checkpoint.heads ?? {}).length > 0 || Boolean(checkpoint.live.pendingBootstrap));
}

/**
 * Keep the existing SDK issuance and profile registration path, then hand
 * resource funding to the journaled continuation before its first wallet send.
 */
export async function createCompactBootstrapLiveRuntime(options: SdkRuntimeOptions,
  continueFresh: FreshContinuation,
  factories: CompactBootstrapFactories = { createLegacy: createCompactLiveRuntime, createReady: createCompactReadyLiveRuntime }): Promise<SdkRuntime> {
  if (!options.onCheckpoint) throw new Error("Compact bootstrap needs encrypted checkpoint persistence");
  if (typeof continueFresh !== "function") throw new Error("Compact bootstrap requires the engine-owned recovery continuation");

  let latest = options.checkpoint ? structuredClone(options.checkpoint) : undefined;
  const restoringFreshBoundary = Boolean(options.checkpoint &&
    (hasFreshMarker(options.checkpoint) || canStartFresh(options.checkpoint)));
  let legacy!: SdkRuntime;
  let ready: SdkRuntime | undefined;
  let closed = false;
  let legacyClosed = false;
  let freshAttempted = false;
  let handingOff: Promise<void> | undefined;
  const onCheckpoint = async (checkpoint: NativeCheckpoint): Promise<void> => {
    // The legacy constructor recomputes the same local profile and temporarily
    // labels it profile-registration. Keep the registered checkpoint as the
    // source of truth until bootstrap() reaches the durable funding boundary.
    if (restoringFreshBoundary && checkpoint.live?.phase === "profile-registration") return;
    await options.onCheckpoint!(checkpoint);
    latest = structuredClone(checkpoint);
    if (canStartFresh(checkpoint) && !hasFreshMarker(checkpoint)) throw new RegisteredProfileBoundary();
  };

  legacy = await factories.createLegacy({ ...options, onCheckpoint });

  const handoff = async (): Promise<void> => {
    if (ready) return;
    if (handingOff) return handingOff;
    handingOff = (async () => {
      const checkpoint = latest ?? legacy.exportState();
      if (hasUnmarkedPartialFunding(checkpoint)) {
        throw new Error("Compact bootstrap found legacy partial funding without its continuation journal; use the explicit recovery tool.");
      }
      const alreadyReady = hasCompletedFreshBootstrap(checkpoint);
      if (!alreadyReady && !hasFreshMarker(checkpoint) && !canStartFresh(checkpoint)) {
        throw new Error("Compact bootstrap cannot safely identify a fresh registered profile or its continuation.");
      }
      if (!legacyClosed) { legacyClosed = true; await legacy.close(); }
      freshAttempted = true;
      const completed = alreadyReady ? checkpoint :
        await continueFresh(structuredClone(checkpoint), (progress) => { latest = structuredClone(progress); });
      if (completed.live?.phase !== "ready" || completed.compact?.profileId !== checkpoint.compact?.profileId) {
        throw new Error("Fresh compact bootstrap did not preserve the registered profile through ready handoff.");
      }
      ready = await factories.createReady({ ...options, checkpoint: completed,
        onCheckpoint: async (next) => {
          await options.onCheckpoint!(next);
          latest = structuredClone(next);
        } });
      latest = structuredClone(completed);
    })();
    try { await handingOff; }
    finally { handingOff = undefined; }
  };

  return {
    async bootstrap() {
      if (closed || ready) return;
      const checkpoint = latest ?? legacy.exportState();
      if (hasCompletedFreshBootstrap(checkpoint)) return handoff();
      if (hasFreshMarker(checkpoint) || canStartFresh(checkpoint)) return handoff();
      if (hasUnmarkedPartialFunding(checkpoint)) {
        throw new Error("Compact bootstrap found legacy partial funding without its continuation journal; use the explicit recovery tool.");
      }
      try { await legacy.bootstrap?.(); }
      catch (error) {
        if (!(error instanceof RegisteredProfileBoundary)) throw error;
        await handoff();
      }
    },
    async refreshFunding() {
      if (closed) throw new Error("Compact bootstrap runtime is closed");
      if (ready) return ready.refreshFunding?.();
      return legacy.refreshFunding?.();
    },
    async onboardFunding(requestId: string) {
      if (closed) throw new Error("Compact bootstrap runtime is closed");
      if (ready) throw new Error("Fresh bootstrap no longer accepts wallet boarding");
      if (!legacy.onboardFunding) throw new Error("Wallet boarding is unavailable");
      return legacy.onboardFunding(requestId);
    },
    async settle(prepared) {
      if (!ready) throw new Error("Compact resource heads are not ready");
      return ready.settle(prepared);
    },
    async reconcile(prepared, submission) {
      if (ready) return ready.reconcile(prepared, submission);
      return legacy.reconcile(prepared, submission);
    },
    destination(owner) { return (ready ?? legacy).destination(owner); },
    snapshot() {
      const current = (ready ?? legacy).snapshot();
      if (ready || !freshAttempted || !latest?.live) return current;
      const phase = latest.live.phase;
      const nativeSnapshot = (current.native && typeof current.native === "object" ? current.native : {}) as Record<string, unknown>;
      return { ...current, phase, bootstrapPhase: phase, ready: false,
        native: { ...nativeSnapshot, phase, bootstrapPhase: phase, ready: false, profileId: latest.compact?.profileId,
          heads: structuredClone(latest.heads), funding: structuredClone(latest.funding) } };
    },
    compiledArtifacts() { return (ready ?? legacy).compiledArtifacts(); },
    exportState() { return structuredClone(ready ? ready.exportState() : latest ?? legacy.exportState()); },
    async close() {
      if (closed) return;
      closed = true;
      if (handingOff) await handingOff.catch(() => {});
      if (ready) await ready.close();
      else if (!legacyClosed) { legacyClosed = true; await legacy.close(); }
    },
  };
}
