import type { SelectedModel } from "@/lib/providers/base";
import type { DiscussionMode } from "@/lib/db/schema";
import type { ModelCapabilityProbeProfile } from "@/lib/providers/capability-probes";
import type { CapabilityInputType } from "@/lib/attachments/types";
import type { ModelCapabilities } from "@/lib/providers/base";
import { supportsInputTypes } from "@/lib/providers/capabilities";

export interface BuildCapabilityDecision {
  workers: SelectedModel[];
  diagnostics: string[];
}

export interface BuildModelIdCapabilityDecision {
  modelIds: string[];
  diagnostics: string[];
}

export type CapabilityProfileMap = Record<string, ModelCapabilityProbeProfile> | undefined;

export interface ParticipantInputSupportInput {
  mode: DiscussionMode;
  selectedModelIds: string[];
  capabilitiesById: ReadonlyMap<string, ModelCapabilities | undefined>;
  requiredInputTypes: CapabilityInputType[];
}

type BuildActionProtocolStatus = "passed" | "not_passed" | "untested";

function fresh(profile: ModelCapabilityProbeProfile | undefined): ModelCapabilityProbeProfile | undefined {
  if (!profile) return undefined;
  if (Date.parse(profile.expiresAt) <= Date.now()) return undefined;
  return profile;
}

function actionProtocolStatusForId(
  modelId: string,
  profiles: CapabilityProfileMap
): BuildActionProtocolStatus {
  const profile = fresh(profiles?.[modelId]);
  if (!profile) return "untested";
  const result = profile.results.find((item) => item.id === "toolCalls");
  if (!result) return "untested";
  return result.status === "pass" ? "passed" : "not_passed";
}

function actionProtocolStatus(
  model: SelectedModel,
  profiles: CapabilityProfileMap
): BuildActionProtocolStatus {
  return actionProtocolStatusForId(model.modelId, profiles);
}

export function selectBuildModelIdsByCapabilities(
  modelIds: string[],
  profiles: CapabilityProfileMap
): BuildModelIdCapabilityDecision {
  if (modelIds.length <= 1) return { modelIds, diagnostics: [] };

  const passed = modelIds.filter((modelId) => actionProtocolStatusForId(modelId, profiles) === "passed");
  const notPassed = modelIds.filter((modelId) => actionProtocolStatusForId(modelId, profiles) === "not_passed");
  const untested = modelIds.filter((modelId) => actionProtocolStatusForId(modelId, profiles) === "untested");
  const diagnostics: string[] = [];

  if (passed.length > 0) {
    if (notPassed.length > 0 || untested.length > 0) {
      diagnostics.push(
        `Build capability routing selected ${passed.length} model(s) that passed the Build action-protocol probe; ` +
          `${notPassed.length} not-passed and ${untested.length} untested model(s) were not selected.`
      );
    }
    return { modelIds: passed, diagnostics };
  }

  if (notPassed.length > 0 && untested.length > 0) {
    diagnostics.push(
      `Build capability routing used ${untested.length} untested model(s) and skipped ${notPassed.length} not-passed model(s).`
    );
    return { modelIds: untested, diagnostics };
  }

  return { modelIds, diagnostics };
}

export function participantRequiredInputTypesForMode(
  mode: DiscussionMode,
  requiredInputTypes: CapabilityInputType[]
): CapabilityInputType[] {
  return mode === "build" ? [] : requiredInputTypes;
}

export function selectParticipantModelIdsByInputSupport(
  input: ParticipantInputSupportInput
): string[] {
  const availableModelIds = input.selectedModelIds.filter((id) =>
    input.capabilitiesById.has(id)
  );
  const required = participantRequiredInputTypesForMode(
    input.mode,
    input.requiredInputTypes
  );
  if (required.length === 0) return availableModelIds;
  return availableModelIds.filter((id) =>
    supportsInputTypes(input.capabilitiesById.get(id), required)
  );
}

export function selectedModelIdsForMode(
  mode: DiscussionMode,
  selectedModelIds: string[],
  buildDecision: BuildModelIdCapabilityDecision
): string[] {
  return mode === "build" ? buildDecision.modelIds : selectedModelIds;
}

export function selectBuildWorkersByCapabilities(
  workers: SelectedModel[],
  profiles: CapabilityProfileMap
): BuildCapabilityDecision {
  if (workers.length <= 1) return { workers, diagnostics: [] };

  const passed = workers.filter((worker) => actionProtocolStatus(worker, profiles) === "passed");
  const notPassed = workers.filter((worker) => actionProtocolStatus(worker, profiles) === "not_passed");
  const untested = workers.filter((worker) => actionProtocolStatus(worker, profiles) === "untested");
  const diagnostics: string[] = [];

  if (passed.length > 0) {
    if (notPassed.length > 0 || untested.length > 0) {
      diagnostics.push(
        `Build capability routing: using ${passed.length} model(s) that passed the Build action-protocol probe; ` +
          `${notPassed.length} not-passed and ${untested.length} untested model(s) are benched for this Build run.`
      );
    }
    return { workers: passed, diagnostics };
  }

  if (notPassed.length > 0 && untested.length > 0) {
    diagnostics.push(
      `Build capability routing: ${notPassed.length} model(s) did not pass the Build action-protocol probe; ` +
        `${untested.length} untested model(s) remain active.`
    );
    return { workers: untested, diagnostics };
  }

  if (notPassed.length === workers.length) {
    diagnostics.push(
      "Build capability routing: all selected workers are marked not-passed for the Build action-protocol probe, so Build mode keeps them active rather than leaving no worker. Retest or choose different models."
    );
    return { workers, diagnostics };
  }

  if (untested.length === workers.length) {
    diagnostics.push(
      "Build capability routing: no selected worker has a fresh Build action-protocol probe. Run Provider Capability Lab for safer Build worker selection."
    );
  }

  return { workers, diagnostics };
}
