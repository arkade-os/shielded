import assert from "node:assert/strict";
import test from "node:test";
import { createCompactBootstrapLiveRuntime, type CompactBootstrapFactories } from "../src/compact/bootstrap-live.ts";
import type { NativeCheckpoint, SdkRuntime, SdkRuntimeOptions } from "../src/sdk/runtime.ts";

function checkpoint(phase: string): NativeCheckpoint {
  return { version: 1, network: "mutinynet", domain: "1", state: {} as NativeCheckpoint["state"], serverKey: "a".repeat(64),
    emulatorKey: "b".repeat(64), aliceSecret: "01".repeat(32), bobSecret: "02".repeat(32), checkpointScript: "policy",
    identities: {}, issuanceRaw: "", genesisRaw: "", heads: {}, funding: { BTC: "0", DEMO: "0" }, receipts: [],
    compact: { version: 1, profileId: "c".repeat(64), sidecars: {} },
    live: { seedHex: "03".repeat(32), compactEmulatorSecret: "04".repeat(32), arkUrl: "https://mutinynet.arkade.sh",
      emulatorUrl: "inprocess://compact-verifier", phase: phase as "profile-registration", issued: {} } };
}

function fakeRuntime(state: NativeCheckpoint, events: string[], label: string): SdkRuntime {
  let current = structuredClone(state);
  return {
    async bootstrap() {}, async settle() {
      if (current.live) (current.live as any).readySettlement = undefined;
      return {} as never;
    }, async reconcile() { return undefined; }, destination() { return ""; },
    snapshot() { return { ready: current.live?.phase === "ready", phase: current.live?.phase, native: { heads: current.heads } }; },
    compiledArtifacts() { return {}; }, async close() { events.push(`${label}:close`); },
    exportState() { return structuredClone(current); }, async refreshFunding() {},
    async onboardFunding() { return { status: "accepted", selectedOutpoints: [] }; },
  } as unknown as SdkRuntime;
}

function factories(events: string[], legacyFactory: (options: SdkRuntimeOptions) => Promise<SdkRuntime>, readyState: NativeCheckpoint,
  readyRef: { runtime?: SdkRuntime }): CompactBootstrapFactories {
  return {
    createLegacy: legacyFactory,
    async createReady(options) {
      events.push("ready:create");
      const runtime = fakeRuntime(options.checkpoint ?? readyState, events, "ready");
      readyRef.runtime = runtime;
      return runtime;
    },
  };
}

test("registered profile boundary persists before old live stops and hands off to ready runtime", async () => {
  const events: string[] = [];
  const original = checkpoint("profile-registration");
  const boundary = checkpoint("funding-programs");
  const ready = checkpoint("ready");
  (ready.live as any).readySettlement = { stage: "finalize-attempted", txid: "e".repeat(64) };
  const readyRef: { runtime?: SdkRuntime } = {};
  let resourceSends = 0;
  const deps = factories(events, async (options) => {
    return { ...fakeRuntime(original, events, "legacy"), bootstrap: async () => {
      await options.onCheckpoint!(boundary);
      resourceSends++;
    } } as SdkRuntime;
  }, ready, readyRef);
  const wrapper = await createCompactBootstrapLiveRuntime({ checkpoint: original, network: "mutinynet",
    initialState: {} as SdkRuntimeOptions["initialState"], verificationKeys: {}, onCheckpoint: async (saved) => {
      events.push(`persist:${saved.live?.phase}`);
    } }, async (saved, progress) => {
      events.push("continuation:start");
      assert.equal(saved.live?.phase, "funding-programs");
      const marked = structuredClone(saved) as NativeCheckpoint & { live: any };
      marked.live.bootstrapRecovery = { version: 1, profileId: marked.compact?.profileId, freshStart: true, heads: {} };
      events.push("store:save-marker");
      progress(marked);
      return ready;
    }, deps);
  await wrapper.bootstrap?.();
  assert.equal(resourceSends, 0);
  assert.ok(events.indexOf("persist:funding-programs") < events.indexOf("legacy:close"));
  assert.ok(events.indexOf("legacy:close") < events.indexOf("continuation:start"));
  assert.ok(events.indexOf("store:save-marker") < events.indexOf("ready:create"));
  assert.equal(wrapper.exportState().live?.phase, "ready");
  await wrapper.settle({} as never);
  assert.equal((wrapper.exportState().live as any).readySettlement, undefined);
  await wrapper.close();
});

test("failed continuation exposes its last durably published checkpoint", async () => {
  const events: string[] = [];
  const original = checkpoint("funding-programs");
  const boundary = checkpoint("funding-programs");
  const failed = structuredClone(boundary) as NativeCheckpoint & { live: any };
  failed.live.bootstrapRecovery = { version: 1, profileId: failed.compact?.profileId, freshStart: true, heads: {} };
  failed.heads.gate = { txid: "d".repeat(64), vout: 0, value: 200_000, sourceTx: "raw" };
  const readyRef: { runtime?: SdkRuntime } = {};
  const deps = factories(events, async (options) => {
    return { ...fakeRuntime(original, events, "legacy"), bootstrap: async () => { await options.onCheckpoint!(boundary); } } as SdkRuntime;
  }, checkpoint("ready"), readyRef);
  const wrapper = await createCompactBootstrapLiveRuntime({ checkpoint: original, network: "mutinynet",
    initialState: {} as SdkRuntimeOptions["initialState"], verificationKeys: {}, onCheckpoint: async () => {} },
  async (_saved, progress) => { progress(failed); throw new Error("unknown finalize outcome"); }, deps);
  await assert.rejects(wrapper.bootstrap!(), /unknown finalize outcome/);
  assert.equal(wrapper.exportState().heads.gate?.txid, "d".repeat(64));
  assert.equal((wrapper.snapshot().native as any).heads.gate.txid, "d".repeat(64));
  await wrapper.close();
});
