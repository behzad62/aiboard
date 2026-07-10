/** Build capability routing checks (run: npx tsx scripts/test-build-capability-routing.mts) */
import {
  selectParticipantModelIdsByInputSupport,
  selectBuildModelIdsByCapabilities,
  selectedModelIdsForMode,
} from "../lib/client/build-capabilities";
import type { CapabilityInputType } from "../lib/attachments/types";
import type { DiscussionMode } from "../lib/db/schema";
import type { ModelCapabilities } from "../lib/providers/base";
import type { ModelCapabilityProbeProfile } from "../lib/providers/capability-probes";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

function profile(
  fullModelId: string,
  status: "pass" | "fail",
  expiresAt = "2999-01-01T00:00:00.000Z"
): ModelCapabilityProbeProfile {
  const [providerId, modelId] = fullModelId.split(":");
  return {
    fullModelId,
    providerId,
    modelId,
    modelName: fullModelId,
    testedAt: "2026-01-01T00:00:00.000Z",
    expiresAt,
    source: "probed",
    results: [{ id: "toolCalls", status, detail: status }],
    capabilities: {
      text: true,
      streaming: true,
      structuredOutput: true,
      imageInput: false,
      documentInput: false,
      toolCalls: status === "pass",
      temperature: false,
      reasoningEffort: [],
      maxTokens: true,
      parallelRequests: 1,
    },
  };
}

const selected = ["openai:worker-pass", "openai:worker-fail", "openai:worker-untested"];
const imageRequired: CapabilityInputType[] = ["image"];
const textOnlyCaps: ModelCapabilities = {
  image: false,
  document: false,
  audio: false,
  video: false,
};
const visionCaps: ModelCapabilities = {
  image: true,
  document: false,
  audio: false,
  video: false,
};
const capabilityMap = new Map<string, ModelCapabilities>([
  ["openai:text-only-worker", textOnlyCaps],
  ["openai:vision-worker", visionCaps],
]);

check(
  "build participant selection keeps text-only workers when image attachments exist",
  selectParticipantModelIdsByInputSupport({
    mode: "build",
    selectedModelIds: ["openai:text-only-worker", "openai:vision-worker"],
    capabilitiesById: capabilityMap,
    requiredInputTypes: imageRequired,
  }).join(",") === "openai:text-only-worker,openai:vision-worker"
);

check(
  "build participant selection drops models that are no longer available",
  selectParticipantModelIdsByInputSupport({
    mode: "build",
    selectedModelIds: ["openai:removed-worker", "openai:vision-worker"],
    capabilitiesById: capabilityMap,
    requiredInputTypes: [],
  }).join(",") === "openai:vision-worker"
);

check(
  "non-build participant selection still filters models missing image support",
  selectParticipantModelIdsByInputSupport({
    mode: "panel",
    selectedModelIds: ["openai:text-only-worker", "openai:vision-worker"],
    capabilitiesById: capabilityMap,
    requiredInputTypes: imageRequired,
  }).join(",") === "openai:vision-worker"
);

const decision = selectBuildModelIdsByCapabilities(selected, {
  "openai:worker-pass": profile("openai:worker-pass", "pass"),
  "openai:worker-fail": profile("openai:worker-fail", "fail"),
});

check("routing keeps only passing models when any pass", decision.modelIds.join(",") === "openai:worker-pass", {
  modelIds: decision.modelIds,
});

check(
  "build selector displays the routed model set",
  selectedModelIdsForMode("build", selected, decision).join(",") === "openai:worker-pass",
  selectedModelIdsForMode("build", selected, decision)
);

for (const mode of ["panel", "debate", "specialist"] satisfies DiscussionMode[]) {
  check(
    `${mode} selector displays the user's raw selection`,
    selectedModelIdsForMode(mode, selected, decision).join(",") === selected.join(","),
    selectedModelIdsForMode(mode, selected, decision)
  );
}

const expiredDecision = selectBuildModelIdsByCapabilities(["openai:expired-pass", "openai:failed"], {
  "openai:expired-pass": profile("openai:expired-pass", "pass", "2000-01-01T00:00:00.000Z"),
  "openai:failed": profile("openai:failed", "fail"),
});

check("expired passing probes are treated as untested", expiredDecision.modelIds.join(",") === "openai:expired-pass", {
  modelIds: expiredDecision.modelIds,
});

process.exit(failed === 0 ? 0 : 1);
