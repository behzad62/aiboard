import type { SelectedModel } from "@/lib/providers/base";
import type { ModelCapabilityProbeProfile } from "@/lib/providers/capability-probes";

export interface BuildCapabilityDecision {
  workers: SelectedModel[];
  diagnostics: string[];
}

export type CapabilityProfileMap = Record<string, ModelCapabilityProbeProfile> | undefined;

function fresh(profile: ModelCapabilityProbeProfile | undefined): ModelCapabilityProbeProfile | undefined {
  if (!profile) return undefined;
  if (Date.parse(profile.expiresAt) <= Date.now()) return undefined;
  return profile;
}

function actionProtocolStatus(
  model: SelectedModel,
  profiles: CapabilityProfileMap
): "passed" | "failed" | "untested" {
  const profile = fresh(profiles?.[model.modelId]);
  if (!profile) return "untested";
  const result = profile.results.find((item) => item.id === "toolCalls");
  if (!result) return "untested";
  return result.status === "pass" ? "passed" : "failed";
}

export function selectBuildWorkersByCapabilities(
  workers: SelectedModel[],
  profiles: CapabilityProfileMap
): BuildCapabilityDecision {
  if (workers.length <= 1) return { workers, diagnostics: [] };

  const passed = workers.filter((worker) => actionProtocolStatus(worker, profiles) === "passed");
  const failed = workers.filter((worker) => actionProtocolStatus(worker, profiles) === "failed");
  const untested = workers.filter((worker) => actionProtocolStatus(worker, profiles) === "untested");
  const diagnostics: string[] = [];

  if (passed.length > 0) {
    if (failed.length > 0 || untested.length > 0) {
      diagnostics.push(
        `Build capability routing: using ${passed.length} model(s) that passed the Build action-protocol probe; ` +
          `${failed.length} failed and ${untested.length} untested model(s) are benched for this Build run.`
      );
    }
    return { workers: passed, diagnostics };
  }

  if (failed.length > 0 && untested.length > 0) {
    diagnostics.push(
      `Build capability routing: ${failed.length} model(s) failed the Build action-protocol probe and are benched; ` +
        `${untested.length} untested model(s) remain active.`
    );
    return { workers: untested, diagnostics };
  }

  if (failed.length === workers.length) {
    diagnostics.push(
      "Build capability routing: all selected workers failed the Build action-protocol probe, so Build mode keeps them active rather than leaving no worker. Retest or choose different models."
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
