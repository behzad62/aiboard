import type {
  BuildStopReason,
  BuildRunPolicy,
  BuildUsageWindow,
  Discussion,
  DiscussionStatus,
} from "@/lib/db/schema";
import type {
  NativeBuildProjection,
  NativeBuildUsageProjection,
  NativeProjectHandoffChoice,
} from "@/lib/client/runner-v2";
import { mapNativeBuildUsageModels } from "@/lib/client/native-model-usage";

export function applyDiscussionLiveStatus(
  discussion: Discussion,
  status: DiscussionStatus
): Discussion {
  if (discussion.mode !== "build" || status !== "running") {
    return discussion.status === status ? discussion : { ...discussion, status };
  }
  return {
    ...discussion,
    status,
    buildStopReason: null,
    buildStoppedAt: null,
  };
}

export function buildStopFallbackMessage(reason: BuildStopReason): string {
  if (reason === "blocked") {
    return "Build paused at its durable checkpoint after a recoverable blocker.";
  }
  if (reason === "user") {
    return "Build was interrupted or stopped before it could finish.";
  }
  if (reason === "completed") {
    return "Build completed and is awaiting its final handoff.";
  }
  return `Build stopped because the ${reason} guardrail was reached.`;
}

export function buildRunWorkflowStatus(input: {
  status: string;
  stopReason?: BuildStopReason | null;
  projectHandoffRequested?: boolean;
}): string {
  if (input.projectHandoffRequested) return "Awaiting project handoff";
  if (
    input.status === "completed" ||
    !input.stopReason ||
    input.stopReason === "completed"
  ) {
    return input.status;
  }
  return `${input.status} (${input.stopReason})`;
}

export function shouldShowBuildStopFallback(input: {
  stopReason: BuildStopReason | null | undefined;
  status: string;
  hasStopReport: boolean;
  hasArchitectHandoff: boolean;
  hasProjectHandoff: boolean;
}): boolean {
  return Boolean(
    input.stopReason &&
      input.status === "stopped" &&
      !input.hasStopReport &&
      !input.hasArchitectHandoff &&
      !input.hasProjectHandoff
  );
}

export function shouldRestoreDurableBuildProjection(
  status: string
): boolean {
  return status === "stopped" || status === "failed";
}

export function durableBuildHandoffPanels(
  projection: NativeBuildProjection
): {
  architect: { reason: string; candidateRuntimeIds: string[] } | null;
  project: {
    summary: string;
    options: NativeProjectHandoffChoice[];
  } | null;
} {
  const projectHandoff = projection.projectHandoff;
  if (projectHandoff?.status === "requested") {
    return {
      architect: null,
      project: {
        summary: projectHandoff.summary,
        options: [...projectHandoff.options],
      },
    };
  }
  const architectHandoff = projection.runtime.architect.handoff;
  return {
    architect: architectHandoff
      ? {
          reason: architectHandoff.reason,
          candidateRuntimeIds: [...architectHandoff.candidateRuntimeIds],
        }
      : null,
    project: null,
  };
}

export function nativeBuildTaskStatus(
  status: string
): "planned" | "in_progress" | "review" | "fixing" | "done" | "failed" {
  if (status === "planned") return "planned";
  if (["assigned", "running", "waiting_guidance"].includes(status)) {
    return "in_progress";
  }
  if (["submitted", "architect_review", "approved", "integrating"].includes(status)) {
    return "review";
  }
  if (["rejected", "integration_resolution"].includes(status)) return "fixing";
  if (["integrated", "cancelled"].includes(status)) return "done";
  return "failed";
}

export function nativeBuildDiscussionStatus(
  projection: Pick<NativeBuildProjection, "status">
): DiscussionStatus {
  return projection.status === "paused" ? "stopped" : projection.status;
}

export function nativeBuildUsageWindow(
  projection: NativeBuildUsageProjection,
  startedAt: string
): BuildUsageWindow {
  const usage = projection.effective;
  const estimatedUsd = usage.estimatedCostMicros / 1_000_000;
  const models = mapNativeBuildUsageModels(projection);
  return {
    startedAt,
    elapsedMs: usage.activeMs,
    estimatedUsd,
    unknownPricedModelIds: [...new Set(
      models.filter(hasUnpricedContributingNativeUsage).map((model) => model.modelId)
    )].sort(),
    models,
  };
}

export function nativeBuildRunPolicy(
  projection: Pick<NativeBuildProjection, "runPolicy">,
  fallback: BuildRunPolicy
): BuildRunPolicy {
  return projection.runPolicy ?? fallback;
}

export interface NativeBuildPolicyEvent {
  type: "native_build_policy";
  policy: BuildRunPolicy;
}

export function nativeBuildPolicyChange(
  current: BuildRunPolicy,
  projection: Pick<NativeBuildProjection, "runPolicy">
): NativeBuildPolicyEvent | null {
  const policy = nativeBuildRunPolicy(projection, current);
  return policy === current ? null : { type: "native_build_policy", policy };
}

export function createNativeBuildPolicySynchronizer(
  initial: BuildRunPolicy,
  onChange: (event: NativeBuildPolicyEvent) => void
): (projection: Pick<NativeBuildProjection, "runPolicy">) => void {
  let current = initial;
  return (projection) => {
    const change = nativeBuildPolicyChange(current, projection);
    if (!change) return;
    current = change.policy;
    onChange(change);
  };
}

export function applyNativeBuildPolicyEvent(
  discussion: Discussion,
  event: NativeBuildPolicyEvent
): Discussion {
  return discussion.buildRunPolicy === event.policy
    ? discussion
    : { ...discussion, buildRunPolicy: event.policy };
}

export function nativeBuildRestorationPolicyPatch(
  discussion: Pick<Discussion, "buildRunPolicy">,
  projection: Pick<NativeBuildProjection, "runPolicy">
): Pick<Discussion, "buildRunPolicy"> | Record<string, never> {
  const policy = nativeBuildRunPolicy(
    projection,
    discussion.buildRunPolicy ?? "finish"
  );
  return discussion.buildRunPolicy === policy ? {} : { buildRunPolicy: policy };
}

function hasUnpricedContributingNativeUsage(
  model: BuildUsageWindow["models"][number]
): boolean {
  if (
    model.usageOrigin !== "native" ||
    model.priced ||
    model.costBasis === "account_not_metered"
  ) return false;
  return (
    model.calls > 0 ||
    model.inputTokens > 0 ||
    (model.cachedInputTokens ?? 0) > 0 ||
    (model.cacheWriteInputTokens ?? 0) > 0 ||
    model.outputTokens > 0 ||
    model.totalTokens > 0
  );
}
