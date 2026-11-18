import type { Discussion, ReasoningEffort } from "@/lib/db/schema";
import { isCliRuntimeId, nativeBuildCliCrewRefusal, type CliCrewPolicyRefusal } from "@/runner-v2/src/cli-crew-policy";

/** One model in one Build role, with the reasoning effort it runs that role at. */
export interface BuildCrewMember {
  modelId: string;
  /** "default" leaves the provider's own default. */
  reasoningEffort: ReasoningEffort;
}

/**
 * The owner's Build roles. The reviewer is the preferred model for plan review, task verification
 * and deliverable review; when it is unavailable (or authored the change) the runner falls back to
 * another configured model. No workers means the Architect's model also implements the tasks.
 */
export interface BuildCrew {
  architect: BuildCrewMember;
  reviewer: BuildCrewMember | null;
  workers: BuildCrewMember[];
}

export interface BuildCrewRuntime extends BuildCrewMember {
  runtimeId: string;
}

export interface BuildCrewRuntimes {
  /** Priority order: Architect, reviewer, then workers. */
  runtimes: BuildCrewRuntime[];
  architectRuntimeId: string;
  reviewerRuntimeId: string | null;
  workerRuntimeIds: string[];
  /** Every configured runtime: the reviewer is preferred, the rest are its fallback. */
  verifierRuntimeIds: string[];
}

const RUNTIME_EFFORT_SEPARATOR = "#";

/** The model a runtime runs; a role at a second reasoning effort gets `model#effort`. */
export function runtimeModelId(runtimeId: string): string {
  const index = runtimeId.lastIndexOf(RUNTIME_EFFORT_SEPARATOR);
  return index > 0 ? runtimeId.slice(0, index) : runtimeId;
}

export function parseBuildWorkers(value: string | null | undefined): BuildCrewMember[] | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((item) =>
      item && typeof item === "object" && typeof (item as BuildCrewMember).modelId === "string" &&
      typeof (item as BuildCrewMember).reasoningEffort === "string"
        ? [{ modelId: (item as BuildCrewMember).modelId, reasoningEffort: (item as BuildCrewMember).reasoningEffort }]
        : []
    );
  } catch {
    return null;
  }
}

export function serializeBuildWorkers(workers: readonly BuildCrewMember[]): string {
  return JSON.stringify(workers.map(({ modelId, reasoningEffort }) => ({ modelId, reasoningEffort })));
}

/**
 * The crew a Build session runs. Sessions saved before per-role efforts keep their meaning: every
 * participant except the Architect and reviewer is a worker at the session reasoning effort.
 */
export function buildCrewFromDiscussion(
  discussion: Pick<
    Discussion,
    | "modelIds"
    | "judgeModelId"
    | "reviewerModelId"
    | "reasoningEffort"
    | "buildArchitectReasoningEffort"
    | "buildReviewerReasoningEffort"
    | "buildWorkers"
  >
): BuildCrew | null {
  let participants: string[] = [];
  try {
    participants = JSON.parse(discussion.modelIds) as string[];
  } catch {
    participants = [];
  }
  const sessionEffort = discussion.reasoningEffort ?? "default";
  const architectId = discussion.judgeModelId ?? participants[0];
  if (!architectId) return null;
  const reviewer = discussion.reviewerModelId
    ? {
        modelId: discussion.reviewerModelId,
        reasoningEffort: discussion.buildReviewerReasoningEffort ?? sessionEffort,
      }
    : null;
  const workers =
    parseBuildWorkers(discussion.buildWorkers) ??
    [...new Set(participants)]
      .filter((id) => id !== architectId && id !== reviewer?.modelId)
      .map((modelId) => ({ modelId, reasoningEffort: sessionEffort }));
  return {
    architect: {
      modelId: architectId,
      reasoningEffort: discussion.buildArchitectReasoningEffort ?? sessionEffort,
    },
    reviewer,
    workers,
  };
}

/** Every model the crew calls, in role order; stored as the session's participants. */
export function buildCrewModelIds(crew: BuildCrew): string[] {
  return [
    ...new Set([
      crew.architect.modelId,
      ...(crew.reviewer ? [crew.reviewer.modelId] : []),
      ...crew.workers.map((worker) => worker.modelId),
    ]),
  ];
}

/**
 * One runner runtime per (model, reasoning effort). A model's first effort keeps the plain model id
 * (so existing runs and provider configs stay addressable); another effort of the same model gets
 * `model#effort`. The runner compares models, not runtime ids, for reviewer independence. A CLI worker is never
 * a verifier candidate (CLI workers plan §3.13): the Runner refuses a crew that lists one.
 */
export function selectBuildCrewRuntimes(crew: BuildCrew): BuildCrewRuntimes {
  const runtimes: BuildCrewRuntime[] = [];
  const runtimeFor = (member: BuildCrewMember): string => {
    const existing = runtimes.find(
      (runtime) => runtime.modelId === member.modelId && runtime.reasoningEffort === member.reasoningEffort
    );
    if (existing) return existing.runtimeId;
    const runtimeId = runtimes.some((runtime) => runtime.modelId === member.modelId)
      ? `${member.modelId}${RUNTIME_EFFORT_SEPARATOR}${member.reasoningEffort}`
      : member.modelId;
    runtimes.push({ ...member, runtimeId });
    return runtimeId;
  };
  const architectRuntimeId = runtimeFor(crew.architect);
  const reviewerRuntimeId = crew.reviewer ? runtimeFor(crew.reviewer) : null;
  const workerRuntimeIds = [...new Set(crew.workers.map(runtimeFor))];
  return {
    runtimes,
    architectRuntimeId,
    reviewerRuntimeId,
    workerRuntimeIds: workerRuntimeIds.length > 0 ? workerRuntimeIds : [architectRuntimeId],
    verifierRuntimeIds: runtimes.map((runtime) => runtime.runtimeId).filter((runtimeId) => !isCliRuntimeId(runtimeId)),
  };
}

/**
 * The CLI crew rule a crew breaks at this access, or null (§3.12, §3.13): the Runner refuses the same crew at the
 * Build's start, so the composer says so before it is sent.
 */
export function buildCrewCliRefusal(
  crew: BuildCrew,
  access: "ask" | "project" | "full" | null | undefined,
): CliCrewPolicyRefusal | null {
  const selected = selectBuildCrewRuntimes(crew);
  return nativeBuildCliCrewRefusal({
    architectRuntimeId: selected.architectRuntimeId,
    reviewerRuntimeId: selected.reviewerRuntimeId,
    workerRuntimeIds: selected.workerRuntimeIds,
    verifierRuntimeIds: selected.verifierRuntimeIds,
    permissionProfile: access === "full" ? "full" : access === "project" ? "project" : "guarded",
  });
}

/** The reviewer shown by default: the first available model that isn't the Architect's. */
export function defaultReviewerModelId(
  architectModelId: string,
  candidates: readonly string[]
): string | null {
  return candidates.find((id) => id !== architectModelId) ?? candidates[0] ?? null;
}
