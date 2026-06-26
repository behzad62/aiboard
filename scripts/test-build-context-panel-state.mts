import assert from "node:assert/strict";
import {
  EMPTY_BUILD_CONTEXT_PANEL_STATE,
  getVisibleBuildContextAssemblies,
  getVisibleBuildContextDroppedPacks,
  getVisibleBuildContextRetrieveRefs,
  hasBuildMemoryEntryRefs,
  reduceBuildContextPanelState,
} from "../components/BuildContextPanel";
import type { OrchestratorEvent } from "../lib/orchestrator/engine";

function contextEvent(index: number): Extract<OrchestratorEvent, { type: "context_assembled" }> {
  return {
    type: "context_assembled",
    role: "worker",
    phase: "worker",
    label: `Task ${index}`,
    modelId: "openai:gpt-5-mini",
    modelName: "GPT-5 mini",
    providerId: "openai",
    contextTier: "standard",
    totalInputBudgetTokens: 48_000,
    modelContextWindowTokens: 128_000,
    estimatedInputTokens: 10_000 + index,
    contextPackBudgetTokens: 29_000,
    contextPackUsedTokens: 1_000 + index,
    selectedPackCount: 2,
    omittedPackCount: index % 3,
    droppedPacks: [
      {
        id: `pack-${index}`,
        title: `Dropped ${index}`,
        kind: "source",
        reason: "budget-exceeded",
        estimatedTokens: 2_000,
      },
    ],
    retrieveRefs: [
      {
        id: `ctx_${index}`,
        label: `Blob ${index}`,
        kind: "command_output",
        tokenEstimate: 3_000,
      },
    ],
  };
}

let state = EMPTY_BUILD_CONTEXT_PANEL_STATE;
for (let i = 0; i < 45; i++) {
  state = reduceBuildContextPanelState(state, contextEvent(i));
}

assert.equal(state.assemblies.length, 40);
assert.equal(state.assemblies[0].label, "Task 44");
assert.equal(state.assemblies.at(-1)?.label, "Task 5");
assert.equal(state.assemblies[0].droppedPacks[0]?.title, "Dropped 44");
assert.equal(state.assemblies[0].retrieveRefs[0]?.id, "ctx_44");

const visibleAssemblies = getVisibleBuildContextAssemblies(state);
assert.equal(visibleAssemblies.length, 8);
assert.deepEqual(
  visibleAssemblies.slice(0, 3).map((item) => item.label),
  ["Task 44", "Task 43", "Task 42"]
);

const visibleDroppedPacks = getVisibleBuildContextDroppedPacks(state);
assert.equal(visibleDroppedPacks.length, 12);
assert.equal(visibleDroppedPacks[0]?.assemblyLabel, "Task 44");
assert.equal(visibleDroppedPacks[1]?.assemblyLabel, "Task 43");

const visibleRetrieveRefs = getVisibleBuildContextRetrieveRefs(state);
assert.equal(visibleRetrieveRefs.length, 12);
assert.equal(visibleRetrieveRefs[0]?.assemblyLabel, "Task 44");
assert.equal(visibleRetrieveRefs[1]?.assemblyLabel, "Task 43");

state = reduceBuildContextPanelState(state, {
  type: "memory_event",
  activeDecisions: [{ id: "m1", summary: "Use IndexedDB storage", paths: ["lib/client/store.ts"] }],
  failedApproaches: [{ id: "m2", summary: "Do not extend server engine" }],
  fragileFiles: [{ id: "m3", summary: "Event union is shared", paths: ["lib/orchestrator/engine.ts"] }],
  warnings: ["1 fragile file warning active"],
});

assert.equal(state.memory.activeDecisions.length, 1);
assert.equal(state.memory.failedApproaches[0]?.summary, "Do not extend server engine");
assert.equal(state.memory.warnings[0], "1 fragile file warning active");
assert.equal(hasBuildMemoryEntryRefs({ id: "empty", summary: "No refs", paths: [], taskIds: [] }), false);
assert.equal(hasBuildMemoryEntryRefs({ id: "path", summary: "Has path", paths: ["app/page.tsx"], taskIds: [] }), true);
assert.equal(hasBuildMemoryEntryRefs({ id: "task", summary: "Has task", paths: [], taskIds: ["T1"] }), true);

for (let i = 0; i < 45; i++) {
  state = reduceBuildContextPanelState(state, {
    type: "context_blob",
    action: "created",
    ref: `ctx_blob_${i}`,
    label: `Stored blob ${i}`,
    kind: "tool_exchange",
    charCount: 20_000,
    tokenEstimate: 5_000,
  });
}

assert.equal(state.blobs.length, 40);
assert.equal(state.blobs[0].ref, "ctx_blob_44");
assert.equal(state.blobs.at(-1)?.ref, "ctx_blob_5");

state = reduceBuildContextPanelState(state, {
  type: "code_intel_status",
  provider: "native",
  status: "auto_included",
  available: true,
  detail: "Native code intelligence available.",
  architectureDigestIncluded: true,
  changeImpactDigestIncluded: false,
  callsLeft: 2,
});

assert.equal(state.codeIntel?.provider, "native");
assert.equal(state.codeIntel?.architectureDigestIncluded, true);

state = reduceBuildContextPanelState(state, {
  type: "code_intel_status",
  provider: "native",
  status: "available",
  available: true,
  detail: "Native code intelligence still available.",
  architectureDigestIncluded: false,
  changeImpactDigestIncluded: true,
  callsLeft: 1,
});

assert.equal(state.codeIntel?.architectureDigestIncluded, true);
assert.equal(state.codeIntel?.changeImpactDigestIncluded, true);

console.log("PASS build context panel state");
