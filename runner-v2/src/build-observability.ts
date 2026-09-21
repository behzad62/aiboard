import { readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";

import type { AgentActor } from "./agent-contracts.js";
import type { AgentTranscriptPage } from "./agent-session-store.js";
import type {
  HistoricalReadProvenanceBySurface,
} from "./historical-read-provenance.js";
import type { BudgetProjection } from "./budget-ledger.js";
import type { EvidenceRecord } from "./evidence-store.js";
import type { ManagedProcessObservation } from "./managed-process.js";
import type { IntegrationCommit } from "./integration-manager.js";
import type {
  LanguageProviderAuditMetadata,
  LanguageRouteAuditRecord,
} from "./language-provider-router.js";
import type { ProjectMemoryEntry } from "./project-memory.js";
import type { RunnerExtensionManifest } from "./runner-extension.js";
import type { RunnerCapabilityContract } from "./runner-capability-contract.js";
import type { ExecutionEnforcementState } from "./execution-isolation-provider.js";
import type { RecoveryAuditRecord, RecoveryTarget } from "./process-recovery.js";
import type { SkillMetadata } from "./skill-catalog.js";
import type {
  FinalVerificationGenerationProjection,
  SchedulerProjection,
  ProviderHealthProjection,
  SchedulerEvent,
} from "./scheduler-store.js";
import type { FinalVerificationCategory } from "./final-verification-contracts.js";
import { redactSensitiveValue } from "./sensitive-redaction.js";
import type {
  BuildRiskKernelFacts,
  BuildRiskLevel,
  BuildRiskReasonCode,
} from "./risk-policy.js";
import {
  cloneVerifierReview,
  type VerifierReviewProjection,
} from "./verifier-contracts.js";

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
  history: Array<Pick<FinalVerificationObservabilityGeneration, "generationId" | "taskId" | "targetRevision" | "revisionStatus"> & {
    invalidatedByRevision?: string;
    invalidatedByGuidanceId?: string;
  }>;
}

export interface IndependentVerifierRiskObservation {
  targetRevision: string;
  state: "current" | "invalidated" | "superseded";
  risk: BuildRiskLevel;
  architectDeclaration: BuildRiskLevel;
  architectRationale?: string;
  architectRiskSource?: "architect" | "legacy_default";
  stricterQualification: boolean;
  kernelFacts: BuildRiskKernelFacts;
  reasons: Array<{ code: BuildRiskReasonCode; evidence: string[] }>;
  normalizedChangedPaths: string[];
  assessedAt: string;
  invalidatedByRevision?: string;
  invalidatedByGuidanceId?: string;
}

export interface IndependentVerifierObservability {
  policy?: {
    mode: "risk_based";
    candidateRuntimeIds: string[];
    alwaysRequireIndependentVerifier: boolean;
  };
  risk: {
    current?: IndependentVerifierRiskObservation;
    history: IndependentVerifierRiskObservation[];
  };
  selection?: {
    status: "required" | "selected";
    reason: string;
    requiredCapabilities: string[];
    candidateRuntimeIds: string[];
    selectedRuntimeId?: string;
  };
  review: {
    current?: VerifierReviewProjection;
    history: VerifierReviewProjection[];
  };
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
  extensionId?: string;
  status: "started" | "retrying" | "completed";
  occurredAt: string;
  isError?: boolean;
  errorCode?: string;
}

export interface BuildCapabilitiesObservation {
  extensions: RunnerExtensionManifest[];
  languageProviders: LanguageProviderAuditMetadata[];
  languageRoutes: LanguageRouteAuditRecord[];
  /**
   * Immutable identities captured when the Build was created. Terminal
   * historical handles expose this without loading extension or server code.
   */
  historicalContract?: RunnerCapabilityContract;
  /** Durable, redacted Task 6 enforcement outcomes; not a claim that Task 7 routing is active. */
  executionEnforcement?: ExecutionEnforcementState;
}

export interface ExecutionSafetyObservability {
  fullBypass: boolean;
  isolation: {
    status: "unconfined_explicit_full" | "write_confinement_exact_grant" | "blocked" | "unverified";
    securityBoundary: ExecutionEnforcementState["boundary"];
    activeLeaseCount: number;
    blockers: string[];
  };
  grants: { active: number; consumed: number };
  processes: Array<{
    kind: "subprocess" | "streaming";
    invocationId: string;
    logicalProcessId: string;
    lifecycleState: string;
    owned: boolean;
    pendingEffects: boolean;
    backend?: { backendId: string; implementationDigest: string; providerId?: string };
    /** Recorded workload-boundary attestation; omitted for legacy targets. */
    lifecycle?: RecoveryTarget["lifecycle"];
    /** Original required scope when durably available; never synthesized. */
    requiredLifecycleScope?: RecoveryTarget["requiredLifecycleScope"];
    capabilities: RecoveryTarget["capabilities"];
    requiredCapabilities: string[];
    leaseExpiresAt?: string;
    cleanup: RecoveryTarget["cleanup"];
    output: { status: "complete" | "truncated" | "lossy"; totalBytes: number; truncated: boolean; lossyBytes: number } | { status: "unavailable" };
  }>;
  recovery: Array<Pick<RecoveryAuditRecord, "proposalId" | "requestedAction" | "state" | "reason" | "updatedAt" | "observation" | "cleanupState">>;
}

export function projectExecutionSafetyObservability(input: {
  permissionProfile: "guarded" | "project" | "full";
  isolation: ExecutionEnforcementState;
  activeIsolationLeaseCount: number;
  grantStates: readonly ("issued" | "consumed")[];
  processes: readonly RecoveryTarget[];
  recovery: Readonly<Record<string, RecoveryAuditRecord>>;
}): ExecutionSafetyObservability {
  const fullBypass = input.permissionProfile === "full" && input.isolation.records.some(
    (record) => record.status === "unconfined_explicit_full",
  );
  const blockedRecords = input.isolation.records.filter(
    (record) => record.status === "blocked" || record.status === "selection_blocked",
  );
  const summaryBlockers = (input.isolation.recoverySummaries ?? []).flatMap(
    (summary) => summary.blockers,
  );
  const blockers = [...new Set([
    ...blockedRecords.flatMap((record) => record.blocker ? [record.blocker] : []),
    ...summaryBlockers,
  ].map((blocker) => redactSensitiveValue(blocker, { maximumTextLength: 2_048 }))
    .filter((blocker): blocker is string => typeof blocker === "string" && blocker.length > 0))];
  const hasBlockingIsolation = blockedRecords.length > 0 ||
    (input.isolation.recoverySummaries ?? []).some((summary) => summary.blockerCount > 0);
  const confinementRecord = input.activeIsolationLeaseCount > 0
    ? [...input.isolation.records].reverse().find(
        (record) => record.status === "active" && record.enforcement === "write_confinement_exact_grant",
      )
    : undefined;
  const isolationStatus: ExecutionSafetyObservability["isolation"]["status"] = hasBlockingIsolation
    ? "blocked"
    : fullBypass
      ? "unconfined_explicit_full"
      : confinementRecord
        ? "write_confinement_exact_grant"
        : "unverified";
  const grants = { active: 0, consumed: 0 };
  for (const state of input.grantStates) {
    if (state === "issued") grants.active += 1;
    else grants.consumed += 1;
  }
  return {
    fullBypass,
    isolation: {
      status: isolationStatus,
      securityBoundary: input.isolation.boundary,
      activeLeaseCount: Math.max(0, input.activeIsolationLeaseCount),
      blockers,
    },
    grants,
    processes: input.processes.map((process) => ({
      kind: process.scope.kind,
      invocationId: process.scope.invocationId,
      logicalProcessId: process.scope.logicalProcessId,
      lifecycleState: process.scope.state,
      owned: process.owned,
      pendingEffects: process.pendingEffects,
      ...(process.backend ? { backend: { ...process.backend } } : {}),
      ...(process.lifecycle ? { lifecycle: { ...process.lifecycle } } : {}),
      ...(process.requiredLifecycleScope ? { requiredLifecycleScope: process.requiredLifecycleScope } : {}),
      capabilities: { ...process.capabilities },
      requiredCapabilities: [...(process.requiredCapabilities ?? [])],
      ...(process.leaseExpiresAt ? { leaseExpiresAt: process.leaseExpiresAt } : {}),
      cleanup: structuredClone(process.cleanup),
      output: process.output
        ? {
            status: process.output.lossyBytes > 0 ? "lossy" as const : process.output.truncated ? "truncated" as const : "complete" as const,
            totalBytes: process.output.totalBytes,
            truncated: process.output.truncated,
            lossyBytes: process.output.lossyBytes,
          }
        : { status: "unavailable" as const },
    })),
    recovery: Object.values(input.recovery)
      .sort((left, right) => left.proposalId.localeCompare(right.proposalId))
      .map((record) => ({
        proposalId: record.proposalId,
        requestedAction: record.requestedAction,
        state: record.state,
        reason: record.reason,
        updatedAt: record.updatedAt,
        ...(record.observation ? { observation: record.observation } : {}),
        ...(record.cleanupState ? { cleanupState: record.cleanupState } : {}),
      })),
  };
}

export type BuildExecutionSafetyObservability =
  | ({ availability: "live" } & ExecutionSafetyObservability)
  | { availability: "unavailable"; reason: "historical_execution_safety_unavailable" };

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
  capabilities?: BuildCapabilitiesObservation;
  executionSafety?: BuildExecutionSafetyObservability;
  finalVerification?: FinalVerificationObservability;
  independentVerifier?: IndependentVerifierObservability;
  /** Count of recorded context manifests for this run. */
  contextManifestCount: number;
  /** Terminal-reader provenance so absent legacy stores are never shown as live empty state. */
  historical?: {
    terminalState: "completed" | "failed" | "stopped";
    provenance: HistoricalReadProvenanceBySurface;
  };
}

export function projectIndependentVerifierObservability(
  projection: SchedulerProjection,
): IndependentVerifierObservability {
  const currentRisk = projection.buildRisk?.current;
  const currentArchitectRisk =
    currentRisk &&
    projection.finalVerification?.current?.targetRevision ===
      currentRisk.targetRevision
      ? projection.finalVerification.current.review?.decision?.architectRisk
      : undefined;
  return {
    ...(projection.verifierPolicy
      ? {
          policy: {
            mode: projection.verifierPolicy.mode,
            candidateRuntimeIds: [
              ...projection.verifierPolicy.candidateRuntimeIds,
            ],
            alwaysRequireIndependentVerifier:
              projection.verifierPolicy.alwaysRequireIndependentVerifier,
          },
        }
      : {}),
    risk: {
      ...(currentRisk
        ? {
            current: projectVerifierRisk(
              currentRisk,
              currentArchitectRisk,
            ),
          }
        : {}),
      history: (projection.buildRisk?.history ?? [])
        .slice(-8)
        .map((risk) => projectVerifierRisk(risk)),
    },
    ...(projection.verifierSelection
      ? {
          selection: {
            ...projection.verifierSelection,
            requiredCapabilities: [
              ...projection.verifierSelection.requiredCapabilities,
            ],
            candidateRuntimeIds: [
              ...projection.verifierSelection.candidateRuntimeIds,
            ],
          },
        }
      : {}),
    review: {
      ...(projection.verifier?.current
        ? { current: cloneVerifierReview(projection.verifier.current) }
        : {}),
      history: (projection.verifier?.history ?? [])
        .slice(-8)
        .map(cloneVerifierReview),
    },
  };
}

function projectVerifierRisk(
  risk: NonNullable<SchedulerProjection["buildRisk"]>["history"][number],
  architectRisk?: {
    risk: BuildRiskLevel;
    rationale?: string;
    source: "architect" | "legacy_default";
  },
): IndependentVerifierRiskObservation {
  return {
    targetRevision: risk.targetRevision,
    state: risk.state,
    risk: risk.assessment.risk,
    architectDeclaration: risk.input.architectDeclaration,
    ...(architectRisk?.rationale
      ? { architectRationale: architectRisk.rationale }
      : {}),
    ...(architectRisk ? { architectRiskSource: architectRisk.source } : {}),
    stricterQualification: risk.input.stricterQualification,
    kernelFacts: {
      ...risk.input.kernelFacts,
      changedPaths: [...risk.input.kernelFacts.changedPaths],
    },
    reasons: risk.assessment.reasons.map((reason) => ({
      code: reason.code,
      evidence: [...reason.evidence],
    })),
    normalizedChangedPaths: [...risk.assessment.normalizedChangedPaths],
    assessedAt: risk.assessedAt,
    ...(risk.invalidatedByRevision
      ? { invalidatedByRevision: risk.invalidatedByRevision }
      : {}),
    ...(risk.invalidatedByGuidanceId
      ? { invalidatedByGuidanceId: risk.invalidatedByGuidanceId }
      : {}),
  };
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
      ...(generation.invalidatedByGuidanceId ? { invalidatedByGuidanceId: generation.invalidatedByGuidanceId } : {}),
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
    const parsed = redactSensitiveValue(record, {
      maximumItems: MAX_DIAGNOSTICS_ITEMS,
      maximumTextLength: 32 * 1024,
    }) as FinalVerificationDiagnosticsManifest;
    return { ...parsed, changedPaths: [...parsed.changedPaths], checks: [...parsed.checks], evidenceReferences: [...parsed.evidenceReferences], logs: [...parsed.logs] };
  } catch { return undefined; }
}
