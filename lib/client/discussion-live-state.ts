import type {
  BuildStopReason,
  Discussion,
  DiscussionStatus,
} from "@/lib/db/schema";
import type {
  NativeBuildProjection,
  NativeProjectHandoffChoice,
} from "@/lib/client/runner-v2";

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
