import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { AgentActor } from "./agent-contracts.js";
import type { AgentTranscriptPage } from "./agent-session-store.js";
import type { BudgetProjection } from "./budget-ledger.js";
import type { EvidenceRecord } from "./evidence-store.js";
import type { ManagedProcessObservation } from "./managed-process.js";
import type { IntegrationCommit } from "./integration-manager.js";
import type { ProjectMemoryEntry } from "./project-memory.js";
import type { SkillMetadata } from "./skill-catalog.js";
import type {
  FinalVerificationGenerationProjection,
  SchedulerProjection,
  ProviderHealthProjection,
  SchedulerEvent,
} from "./scheduler-store.js";
import type { FinalVerificationCategory } from "./final-verification-contracts.js";

export type FinalVerificationCategoryStatus = "pending" | "passed" | "failed" | "not_applicable";
export type FinalVerificationDiagnosticValue =
  | null | boolean | number | string
  | FinalVerificationDiagnosticValue[]
  | { [key: string]: FinalVerificationDiagnosticValue };

export interface FinalVerificationDiagnosticsManifest {
  version: 1;
  kind: "final-verification-diagnostics";
  runId: string;
  generationId: string;
  taskId: string;
  targetRevision: string;
  changedPaths: string[];
  checks: FinalVerificationDiagnosticValue[];
  evidenceReferences: string[];
  logs: string[];
}

export interface FinalVerificationObservabilityGeneration {
  generationId: string;
  taskId: string;
  targetRevision: string;
  revisionStatus: "current" | "stale";
  categories: Array<{
    category: FinalVerificationCategory;
    applicability: "required" | "not_applicable";
    rationale?: string;
    repositoryInspection?: { inspectedPaths: string[]; summary: string };
    status: FinalVerificationCategoryStatus;
    evidenceIds: string[];
    issues: string[];
  }>;
  submission: { status: "pending" | "submitted"; submissionId?: string; green?: boolean };
  mechanicalFailure?: { failureId: string; failedCategories: FinalVerificationCategory[]; evidenceIds: string[] };
  cleanup: { status: "pending" | "started" | "succeeded" | "failed"; attempt?: number; error?: string; diagnosticsAvailable: boolean; diagnosticsPath?: never; diagnostics?: FinalVerificationDiagnosticsManifest };
  review: { status: "pending" | "requested" | "approved" | "repair_required" | "rejected"; summary?: string };
  repairs: Array<{ taskId: string; status: string }>;
}

export interface FinalVerificationObservability {
  canonicalRevision?: string;
  current?: FinalVerificationObservabilityGeneration;
  history: Array<Pick<FinalVerificationObservabilityGeneration, "generationId" | "taskId" | "targetRevision" | "revisionStatus"> & { invalidatedByRevision?: string }>;
}

export interface BuildAgentObservation {
  sessionId: string;
  actor: AgentActor;
  status: "active" | "suspended" | "submitted" | "completed";
  turns: number;
  suspensionReason?: string;
  error?: string;
  changeSetId?: string;
  lastSequence: number;
}

export interface BuildToolObservation {
  sequence: number;
  sessionId: string;
  callId: string;
  toolName: string;
  status: "started" | "retrying" | "completed";
  occurredAt: string;
  isError?: boolean;
  errorCode?: string;
}

export type BuildTranscriptPage = AgentTranscriptPage;

export interface BuildObservabilitySnapshot {
  runId: string;
  budget: BudgetProjection;
  toolCallCount: number;
  agents: BuildAgentObservation[];
  tools: BuildToolObservation[];
  evidence: EvidenceRecord[];
  memories: ProjectMemoryEntry[];
  skills: SkillMetadata[];
  processes: ManagedProcessObservation[];
  providers: ProviderHealthProjection[];
  events: SchedulerEvent[];
  git: {
    integrationBranch: string;
    integrationRevision: string;
    commits: IntegrationCommit[];
  };
  finalVerification?: FinalVerificationObservability;
}

export function projectFinalVerificationObservability(
  projection: SchedulerProjection,
  diagnostics?: FinalVerificationDiagnosticsManifest,
): FinalVerificationObservability {
  const canonicalRevision = projection.integrationRevision;
  const current = projection.finalVerification?.current;
  return {
    ...(canonicalRevision ? { canonicalRevision } : {}),
    ...(current ? { current: projectGeneration(current, projection, canonicalRevision, diagnostics) } : {}),
    history: (projection.finalVerification?.history ?? []).slice(-8).map((generation) => ({
      generationId: generation.generationId,
      taskId: generation.taskId,
      targetRevision: generation.targetRevision,
      revisionStatus: "stale",
      ...(generation.invalidatedByRevision ? { invalidatedByRevision: generation.invalidatedByRevision } : {}),
    })),
  };
}

function projectGeneration(
  generation: FinalVerificationGenerationProjection,
  projection: SchedulerProjection,
  canonicalRevision: string | undefined,
  diagnostics?: FinalVerificationDiagnosticsManifest,
): FinalVerificationObservabilityGeneration {
  const checks = new Map((generation.completedChecks ?? []).map((check) => [check.category, check]));
  const cleanup = generation.cleanup;
  return {
    generationId: generation.generationId,
    taskId: generation.taskId,
    targetRevision: generation.targetRevision,
    revisionStatus: generation.state === "current" && generation.targetRevision === canonicalRevision ? "current" : "stale",
    categories: generation.plan.checks.map((planned) => {
      const check = checks.get(planned.category);
      return {
        category: planned.category,
        applicability: planned.status,
        ...(planned.status === "not_applicable" && planned.repositoryInspection ? { rationale: planned.rationale, repositoryInspection: { inspectedPaths: [...planned.repositoryInspection.paths], summary: planned.repositoryInspection.summary } } : {}),
        status: !check ? "pending" : planned.status === "not_applicable" ? "not_applicable" : check.green ? "passed" : "failed",
        evidenceIds: [...(check?.evidenceIds ?? [])],
        issues: [...(check?.issues ?? [])],
      };
    }),
    submission: generation.submission
      ? { status: "submitted", submissionId: generation.submission.submissionId, green: generation.submissionResult?.green }
      : { status: "pending" },
    ...(generation.failure ? { mechanicalFailure: { failureId: generation.failure.failureId, failedCategories: [...generation.failure.failedCategories], evidenceIds: [...generation.failure.evidenceIds] } } : {}),
    cleanup: {
      status: cleanup?.status ?? "pending",
      ...(cleanup ? { attempt: cleanup.attempt } : {}),
      ...(cleanup?.error ? { error: cleanup.error } : {}),
      diagnosticsAvailable: Boolean(cleanup?.diagnosticsPath),
      ...(diagnostics ? { diagnostics } : {}),
    },
    review: {
      status: generation.review?.status ?? "pending",
      ...(generation.review?.decision?.summary ? { summary: generation.review.decision.summary } : {}),
    },
    repairs: (generation.repairTaskIds ?? []).map((taskId) => ({ taskId, status: projection.tasks[taskId]?.status ?? "missing" })),
  };
}

const MAX_DIAGNOSTICS_BYTES = 256 * 1024;
const MAX_DIAGNOSTICS_ITEMS = 200;

export async function loadFinalVerificationDiagnostics(input: {
  stateDirectory: string;
  runId: string;
  expectedRunSegment: string;
  diagnosticsPath?: string;
  generationId: string;
  taskId: string;
  targetRevision: string;
}): Promise<FinalVerificationDiagnosticsManifest | undefined> {
  if (!input.diagnosticsPath) return undefined;
  const root = resolve(input.stateDirectory, "builds", input.expectedRunSegment, "audit", "final-verification-diagnostics");
  const candidate = resolve(input.diagnosticsPath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return undefined;
  try {
    const actualRoot = await realpath(root);
    const actualCandidate = await realpath(candidate);
    if (actualCandidate !== actualRoot && !actualCandidate.startsWith(`${actualRoot}${sep}`)) return undefined;
    const source = await readFile(actualCandidate, "utf8");
    if (Buffer.byteLength(source) > MAX_DIAGNOSTICS_BYTES) return undefined;
    const record = JSON.parse(source) as Record<string, unknown>;
    if (record.version !== 1 || record.kind !== "final-verification-diagnostics" ||
      record.runId !== input.runId || record.generationId !== input.generationId ||
      record.taskId !== input.taskId || record.targetRevision !== input.targetRevision) return undefined;
    const strings = (value: unknown) => Array.isArray(value) && value.length <= MAX_DIAGNOSTICS_ITEMS && value.every((item) => typeof item === "string");
    if (!strings(record.changedPaths) || !Array.isArray(record.checks) || record.checks.length > MAX_DIAGNOSTICS_ITEMS || !strings(record.evidenceReferences) || !strings(record.logs)) return undefined;
    const safe = JSON.stringify(record).replace(/\b(token|password|secret|api[_-]?key|authorization)\s*[:=]\s*[^\s"}]+/gi, "$1=[REDACTED]");
    const parsed = JSON.parse(safe) as FinalVerificationDiagnosticsManifest;
    return { ...parsed, changedPaths: [...parsed.changedPaths], checks: [...parsed.checks], evidenceReferences: [...parsed.evidenceReferences], logs: [...parsed.logs] };
  } catch { return undefined; }
}
