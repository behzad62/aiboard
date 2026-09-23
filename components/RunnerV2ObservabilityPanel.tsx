"use client";

import React, { useEffect, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ChevronDown,
  CircleDot,
  Database,
  Download,
  GitBranch,
  Hammer,
  ListChecks,
  MessageSquareText,
  Search,
  Server,
  ShieldCheck,
  Wrench,
} from "lucide-react";

import {
  contextRecordingView,
  type NativeBuildEvidenceFact,
  type NativeBuildObservability,
  type NativeBuildProjection,
  type NativeFinalVerificationObservability,
  type NativeIndependentVerifierObservability,
  type NativePlanCritiqueState,
} from "@/lib/client/runner-v2";
import { projectNativeAcceptanceContract } from "@/lib/client/runner-v2";
import { formatTokenCount } from "@/lib/client/token-usage";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

export function runnerObservabilitySummary(snapshot: NativeBuildObservability) {
  return {
    modelCalls: snapshot.budget.effective.modelCalls,
    toolCalls: snapshot.toolCallCount,
    totalTokens:
      snapshot.budget.effective.inputTokens +
      snapshot.budget.effective.outputTokens,
    cachedInputTokens: snapshot.budget.effective.cachedInputTokens ?? 0,
    cacheWriteInputTokens:
      snapshot.budget.effective.cacheWriteInputTokens ?? 0,
    agents: snapshot.agents.length,
    suspendedAgents: snapshot.agents.filter((agent) => agent.status === "suspended").length,
    toolErrors: snapshot.tools.filter((tool) => tool.isError).length,
    evidence: snapshot.evidence.length,
    memories: snapshot.memories.length,
    skills: snapshot.skills.length,
    runningProcesses: snapshot.processes.filter((process) => process.status === "running").length,
    providers: snapshot.providers.length,
    events: snapshot.events.length,
    contextManifests: snapshot.contextManifestCount ?? 0,
  };
}

export function runnerExecutionSafetyDiagnostics(snapshot: NativeBuildObservability): Array<{
  key: string;
  title: string;
  detail: string;
}> {
  const safety = snapshot.executionSafety;
  if (!safety) {
    return [{
      key: "execution-safety:not-reported",
      title: "Execution safety not reported",
      detail: "This Runner response predates execution-safety disclosure, so confinement cannot be inferred.",
    }];
  }
  if (safety.availability === "unavailable") {
    return [{
      key: "execution-safety:unavailable",
      title: "Execution safety unavailable",
      detail: "This historical view cannot prove the original live grant, isolation lease, process identity, and cleanup state.",
    }];
  }
  const items: Array<{ key: string; title: string; detail: string }> = [];
  const isolationTitle = safety.fullBypass
    ? "Full permission bypass active"
    : safety.isolation.status === "write_confinement_exact_grant"
      ? "Write confinement enforced"
      : safety.isolation.status === "blocked"
        ? "Execution isolation blocked"
        : "Execution confinement unverified";
  const isolationDetail = safety.fullBypass
    ? "Full mode is explicitly unconfined; provider isolation is not being claimed as a security boundary."
    : `${safety.isolation.status} · ${safety.isolation.securityBoundary} · ${safety.isolation.activeLeaseCount} active isolation lease${safety.isolation.activeLeaseCount === 1 ? "" : "s"}${
        safety.isolation.blockers.length ? ` · blockers: ${safety.isolation.blockers.join("; ")}` : ""
      }`;
  items.push({ key: "execution-safety:isolation", title: isolationTitle, detail: isolationDetail });
  items.push({
    key: "execution-safety:grants",
    title: "Execution grants",
    detail: `${safety.grants.active} active · ${safety.grants.consumed} consumed`,
  });
  for (const process of safety.processes) {
    const backend = process.backend
      ? `${process.backend.backendId}${process.backend.providerId ? ` via ${process.backend.providerId}` : ""}`
      : "backend unavailable";
    const lifecycle = process.lifecycle
      ? `lifecycle ${process.lifecycle.scope} (termination=${process.lifecycle.termination}, emptiness=${process.lifecycle.emptiness})`
      : "lifecycle unattested";
    const requiredScope = process.requiredLifecycleScope
      ? `required ${process.requiredLifecycleScope}`
      : "required scope unavailable";
    const capabilities = Object.entries(process.capabilities)
      .map(([name, state]) => `${name}=${state}`)
      .join(", ");
    const output = process.output.status === "unavailable"
      ? "output unavailable"
      : `${process.output.status} output · ${process.output.totalBytes} bytes · ${process.output.lossyBytes} lossy bytes`;
    items.push({
      key: `execution-safety:process:${process.invocationId}`,
      title: `${process.kind} ${process.logicalProcessId}`,
      detail: `${process.lifecycleState} · ${backend} · ${lifecycle} · ${requiredScope} · ${capabilities} · cleanup ${process.cleanup.state} · ${output}`,
    });
  }
  for (const recovery of safety.recovery) {
    const state = recovery.state === "user_decision_required" ? "user decision required" : recovery.state.replaceAll("_", " ");
    items.push({
      key: `execution-safety:recovery:${recovery.proposalId}`,
      title: `Exceptional recovery: ${recovery.requestedAction}`,
      detail: `${state}${recovery.cleanupState ? ` · cleanup ${recovery.cleanupState}` : ""}`,
    });
  }
  return items;
}

type SearchableObservability = Pick<
  NativeBuildObservability,
  | "agents"
  | "tools"
  | "evidence"
  | "memories"
  | "skills"
  | "processes"
  | "providers"
  | "events"
>;

export function filterRunnerObservability<T extends SearchableObservability>(
  snapshot: T,
  query: string
): SearchableObservability {
  const normalized = query.trim().toLowerCase();
  const filter = <TValue,>(values: TValue[]) =>
    normalized
      ? values.filter((value) => JSON.stringify(value).toLowerCase().includes(normalized))
      : values;
  return {
    agents: filter(snapshot.agents),
    tools: filter(snapshot.tools),
    evidence: filter(snapshot.evidence),
    memories: filter(snapshot.memories),
    skills: filter(snapshot.skills),
    processes: filter(snapshot.processes),
    providers: filter(snapshot.providers),
    events: filter(snapshot.events),
  };
}

const PLAN_CRITIQUE_SKIP_LABELS = {
  policy_off: "policy off",
  low_plan_risk: "low plan risk",
  critic_failed: "critic failed",
  plan_only: "plan only",
} as const;

const ARCHITECT_ACTION_REASON_LABELS = {
  plan_critique_resolution_required: "Resolving plan critique",
} as const;

function planCritiqueNeedsResolution(state: NativePlanCritiqueState | undefined): boolean {
  return state?.current?.status === "submitted"
    && (state.current.blockingFindingIds?.length ?? 0) > 0;
}

function planCritiqueSummaryLine(state: NativePlanCritiqueState | undefined): string | undefined {
  if (!state) return undefined;
  if (state.skipped) {
    return `Plan critique: skipped (${PLAN_CRITIQUE_SKIP_LABELS[state.skipped.reason]})`;
  }
  const current = state.current;
  if (!current) return undefined;
  const freshContext = current.independence === "fresh_context"
    ? " · same model, fresh context"
    : "";
  if (current.status === "requested") return `Plan critique: requested${freshContext}`;
  const findings = current.findings ?? [];
  const blocking = findings.filter((finding) => finding.severity === "blocking").length;
  const advisory = findings.filter((finding) => finding.severity === "advisory").length;
  const counts = `${blocking} blocking, ${advisory} advisory`;
  if (current.status === "resolved") return `Plan critique: resolved (${counts})${freshContext}`;
  if (current.status === "submitted") return `Plan critique: submitted (${counts})${freshContext}`;
  return undefined;
}

export function runnerBuildControlSummary(projection: NativeBuildProjection | null) {
  if (!projection) {
    return {
      guidance: [],
      integration: [],
      branch: undefined,
      revision: undefined,
      planCritiqueSummary: undefined,
      planRiskLabel: undefined,
      planRiskRationale: undefined,
      planRiskSource: undefined,
      planCritiqueMode: undefined,
      planCritiqueHistoryLabel: undefined,
      planCritiqueDeclaredLabel: undefined,
    };
  }
  const assessedRisk = projection.planCritique?.risk?.assessment.risk;
  const declaredRisk = projection.planRiskDeclaration?.risk;
  const risk = assessedRisk ?? declaredRisk;
  return {
    guidance: Object.values(projection.guidance),
    integration: Object.values(projection.tasks)
      .filter((task) => task.changeSetId || task.integrationRevision || [
        "submitted",
        "architect_review",
        "approved",
        "integrating",
        "integration_resolution",
        "integrated",
      ].includes(task.status))
      .map((task) => ({
        taskId: task.id,
        objective: task.objective,
        status: task.status,
        changeSetId: task.changeSetId,
        revision: task.integrationRevision,
        conflictPaths: task.conflictPaths ?? [],
      })),
    branch: projection.projectHandoff?.integrationBranch,
    revision: projection.projectHandoff?.integrationRevision,
    planCritiqueSummary: planCritiqueSummaryLine(projection.planCritique),
    planRiskLabel: risk ? `Plan risk: ${risk}` : undefined,
    planRiskRationale: projection.planRiskDeclaration?.rationale,
    planRiskSource: projection.planRiskDeclaration
      ? `Risk source: ${projection.planRiskDeclaration.source}`
      : undefined,
    planCritiqueMode: projection.planCritique?.policy
      ? `Critique mode: ${projection.planCritique.policy.mode}`
      : undefined,
    planCritiqueHistoryLabel: projection.planCritique
      ? `Earlier critiques: ${projection.planCritique.history.length}`
      : undefined,
    planCritiqueDeclaredLabel: projection.planCritique?.risk
      ? `Architect declared: ${projection.planCritique.risk.architectDeclaration}`
      : undefined,
  };
}

type UserFacingVerificationStatus = "pending" | "passed" | "failed" | "not_applicable" | "recorded";

export type RunnerAcceptanceEvidenceStatus = "submitted" | "not_submitted";
export type RunnerAcceptanceVerdictStatus =
  | "satisfied"
  | "unsatisfied"
  | "not_reviewed";

export interface RunnerAcceptanceCriterionSummary {
  id: string;
  text: string;
  evidence: {
    status: RunnerAcceptanceEvidenceStatus;
    evidenceIds: string[];
    artifactHashes: string[];
  };
  verdict: {
    status: RunnerAcceptanceVerdictStatus;
    rationale?: string;
    evidenceIds: string[];
    artifactHashes: string[];
  };
}

const ARCHITECT_DECISION_LABELS = {
  authority_decision: "Authority decision",
  destructive_action: "Destructive action",
  requirement_conflict: "Requirement conflict",
  external_dependency: "External dependency",
  control_weakening: "Control weakening",
  repair_budget_exhausted: "Repair budget exhausted",
} as const;

export type GuidanceReceiptStatus = "complete" | "current" | "pending";

export function architectQuestionAnswerIdempotencyKey(
  questionId: string,
  version: number,
): string {
  return `architect-question:${questionId}:version:${version}:answer`;
}

export interface RunnerSteeringQuestion {
  questionId: string;
  question: string;
  version: number;
  decisionLabel: string;
}

export type RunnerQuestionAnswerCallback = (
  questionId: string,
  version: number,
  answer: string,
  idempotencyKey: string,
) => Promise<void>;

export interface ArchitectQuestionAnswerGate {
  questionKey: string | null;
  generation: number;
}

function architectQuestionKey(question: RunnerSteeringQuestion | undefined): string | null {
  return question ? `${question.questionId}:version:${question.version}` : null;
}

export function createArchitectQuestionAnswerGate(
  question: RunnerSteeringQuestion | undefined,
): ArchitectQuestionAnswerGate {
  return { questionKey: architectQuestionKey(question), generation: 0 };
}

export function alignArchitectQuestionAnswerGate(
  gate: ArchitectQuestionAnswerGate,
  question: RunnerSteeringQuestion | undefined,
): void {
  const nextKey = architectQuestionKey(question);
  if (gate.questionKey === nextKey) return;
  gate.questionKey = nextKey;
  gate.generation += 1;
}

export async function submitRunnerArchitectQuestionAnswer(
  question: RunnerSteeringQuestion,
  answer: string,
  onAnswerQuestion: RunnerQuestionAnswerCallback,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = answer.trim();
  if (!trimmed) return { ok: false, error: "Enter your decision before sending it." };
  try {
    await onAnswerQuestion(
      question.questionId,
      question.version,
      trimmed,
      architectQuestionAnswerIdempotencyKey(question.questionId, question.version),
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error
        ? error.message
        : "Runner did not accept this answer. Refresh the Build state and try again.",
    };
  }
}

export async function submitGuardedRunnerArchitectQuestionAnswer(
  gate: ArchitectQuestionAnswerGate,
  question: RunnerSteeringQuestion,
  answer: string,
  onAnswerQuestion: RunnerQuestionAnswerCallback,
): Promise<{
  current: boolean;
  result: Awaited<ReturnType<typeof submitRunnerArchitectQuestionAnswer>>;
}> {
  alignArchitectQuestionAnswerGate(gate, question);
  const request = { questionKey: gate.questionKey, generation: gate.generation + 1 };
  gate.generation = request.generation;
  const result = await submitRunnerArchitectQuestionAnswer(
    question,
    answer,
    onAnswerQuestion,
  );
  return {
    current: gate.questionKey === request.questionKey && gate.generation === request.generation,
    result,
  };
}

export function RunnerQuestionAnswerError({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-xs font-medium text-red-700 dark:text-red-300">
      {message}
    </p>
  );
}

export function runnerSteeringLedgerView(projection: NativeBuildProjection | null) {
  const guidance = Object.values(projection?.userGuidance ?? {})
    .sort((left, right) => left.version - right.version)
    .map((item) => ({
      guidanceId: item.guidanceId,
      text: item.text,
      version: item.version,
      state: item.status,
      acknowledgementRationale: item.resolution?.rationale,
      receipt: item.status === "acknowledged"
        ? ([
            { label: "Sent to Runner", status: "complete" },
            { label: "Waiting for Architect", status: "complete" },
            { label: "Acknowledged", status: "complete" },
          ] as const)
        : ([
            { label: "Sent to Runner", status: "complete" },
            { label: "Waiting for Architect", status: "current" },
            { label: "Acknowledged", status: "pending" },
          ] as const),
    }));
  const questionId = projection?.blockingArchitectQuestionId;
  const question = questionId
    ? projection?.architectQuestions?.[questionId]
    : undefined;
  return {
    guidance,
    activeQuestion: question?.status === "open" && question.resumeStatus !== "superseded"
      ? {
          questionId: question.questionId,
          question: question.question,
          version: question.version,
          decisionLabel: question.decisionKind
            ? ARCHITECT_DECISION_LABELS[question.decisionKind]
            : "User decision",
        }
      : undefined,
  };
}

export interface RunnerAcceptanceTaskSummary {
  taskId: string;
  title: string;
  version?: number;
  criteria: RunnerAcceptanceCriterionSummary[];
}

export interface RunnerAcceptanceContractSummary {
  status: NonNullable<NativeBuildProjection["acceptanceContractStatus"]>;
  planRevision: number;
  tasks: RunnerAcceptanceTaskSummary[];
}

export function runnerAcceptanceContractSummary(
  projection: NativeBuildProjection | null
): RunnerAcceptanceContractSummary {
  if (!projection) {
    return { status: "current", planRevision: 0, tasks: [] };
  }
  const contract = projectNativeAcceptanceContract(projection);
  return {
    status: contract.status,
    planRevision: contract.planRevision,
    tasks: Object.values(projection.tasks).map((task) => {
      const projectedTask = contract.tasks[task.id];
      const linksByCriterion = new Map<string, typeof task.criterionEvidenceLinks>();
      for (const link of task.criterionEvidenceLinks ?? []) {
        const links = linksByCriterion.get(link.criterionId) ?? [];
        links.push(link);
        linksByCriterion.set(link.criterionId, links);
      }
      const verdictsByCriterion = new Map(
        (projectedTask?.criterionVerdicts ?? []).map((verdict) => [verdict.criterionId, verdict])
      );
      return {
        taskId: task.id,
        title: task.objective,
        ...(task.acceptanceCriteriaVersion !== undefined
          ? { version: task.acceptanceCriteriaVersion }
          : {}),
        criteria: (task.acceptanceCriteria ?? []).map((criterion) => {
          const links = linksByCriterion.get(criterion.id) ?? [];
          const verdict = verdictsByCriterion.get(criterion.id);
          return {
            id: criterion.id,
            text: criterion.text,
            evidence: {
              status: links.length > 0 ? "submitted" : "not_submitted",
              evidenceIds: links.map((link) => link.evidenceId),
              artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
            },
            verdict: verdict
              ? {
                  status: verdict.verdict,
                  rationale: verdict.rationale,
                  evidenceIds: [...verdict.evidenceIds],
                  artifactHashes: [...(verdict.artifactHashes ?? [])],
                }
              : {
                  status: "not_reviewed",
                  evidenceIds: [],
                  artifactHashes: [],
                },
          };
        }),
      };
    }),
  };
}

export function runnerVerificationTone(
  verification: ReadonlyArray<{ status: UserFacingVerificationStatus }>
): "error" | "success" | "progress" {
  if (verification.some((item) => item.status === "failed")) return "error";
  if (verification.some((item) => item.status === "passed")) return "success";
  return "progress";
}

type UserFacingProblem = {
  key: string;
  title: string;
  detail: string;
};

const COMPLETE_TASK_STATUSES = new Set(["integrated", "cancelled"]);
const ACTIVE_WORKER_TASK_STATUSES = new Set(["assigned", "running", "waiting_guidance"]);

const TASK_STATUS_LABELS: Record<string, string> = {
  planned: "Not started",
  assigned: "Preparing to start",
  running: "In progress",
  waiting_guidance: "Waiting for guidance",
  submitted: "Ready for review",
  architect_review: "Under review",
  approved: "Approved",
  rejected: "Changes requested",
  integrating: "Applying changes",
  integration_resolution: "Resolving source control conflicts",
  integrated: "Complete",
  failed: "Failed",
  cancelled: "No longer needed",
};

function taskStatusLabel(status: string): string {
  return TASK_STATUS_LABELS[status] ?? "Status unavailable";
}

function evidenceCategory(fact: NativeBuildEvidenceFact): string {
  if (fact.kind !== "command") return "Browser checks";
  const value = `${fact.label} ${fact.command} ${fact.args.join(" ")}`.toLowerCase();
  if (/\b(browser|playwright|screenshot|visual|console)\b/.test(value)) {
    return "Browser checks";
  }
  if (/\b(git|commit|branch|merge|diff|source control)\b/.test(value)) {
    return "Source control";
  }
  if (/\b(test|tests|lint|typecheck|type-check|tsc|vitest|jest)\b/.test(value)) {
    return "Tests";
  }
  return "Other checks";
}

function evidenceStatus(fact: NativeBuildEvidenceFact): UserFacingVerificationStatus {
  if (fact.kind !== "command") return "recorded";
  if (fact.exitCode === 0) return "passed";
  return fact.exitCode === null ? "recorded" : "failed";
}

function evidenceDetail(category: string, status: UserFacingVerificationStatus): string {
  const result = status === "passed" ? "passed" : status === "failed" ? "failed" : "recorded";
  if (category === "Tests") return `Latest test result ${result}.`;
  if (category === "Browser checks") return "Browser evidence recorded.";
  if (category === "Source control") return `Latest source control check ${result}.`;
  return `Latest check ${result}.`;
}

export function runnerEvidenceDiagnosticDetail(fact: NativeBuildEvidenceFact): string {
  switch (fact.kind) {
    case "command":
      return fact.exitCode === null
        ? `command · signal ${fact.signal ?? "unknown"}`
        : `command · exit ${fact.exitCode}`;
    case "browser_snapshot":
      return `browser snapshot recorded · ${fact.title} · ${fact.url}`;
    case "browser_screenshot":
      return `browser screenshot recorded · ${fact.byteLength.toLocaleString("en-US")} bytes`;
    case "browser_events":
      return `browser events recorded · ${fact.consoleErrorCount} console error${
        fact.consoleErrorCount === 1 ? "" : "s"
      } · ${fact.networkFailureCount} network failure${fact.networkFailureCount === 1 ? "" : "s"}`;
  }
}

export function ContextRecordingLines({
  projection,
}: {
  projection: NativeBuildProjection | null;
}) {
  const recording = contextRecordingView(projection);
  if (!recording) return null;
  return (
    <div className="mt-2 space-y-1 text-xs text-muted-foreground">
      <p>Context manifest: {recording.purpose}</p>
      <p>Attempts: {recording.attempts}</p>
      <p>Reason: {recording.reason}</p>
      {recording.resolution ? <p>Resolution: {recording.resolution}</p> : null}
      {recording.rationale ? <p>Rationale: {recording.rationale}</p> : null}
      {recording.suspended ? <p>Recording suspended</p> : null}
    </div>
  );
}

function lifecycleLabel(projection: NativeBuildProjection | null): string {
  if (!projection) return "Waiting for build activity";
  if (projection.repairCycles?.pause) {
    return "Repair budget exhausted";
  }
  if (projection.verifierSelection?.status === "required") {
    return "Choose an independent verifier";
  }
  if (projection.acceptanceContractStatus === "acceptance_contract_upgrade_required") {
    return "Acceptance criteria upgrade required";
  }
  if (projection.acceptanceContractStatus === "legacy_completed") {
    return "Legacy build complete";
  }
  if (projection.projectHandoff?.status === "requested") {
    return "Ready for your decision";
  }
  if (projection.projectHandoff?.status === "selected") {
    return projection.projectHandoff.appliedToProject
      ? "Changes applied to your project"
      : "Decision received";
  }
  if (projection.pauseReason?.reason === "context_recording_failed") {
    return "Context recording needs a decision";
  }
  if (projection.failureReason === "context_recording_aborted") return "Build failed";
  if (projection.status === "completed") return "Build complete";
  if (projection.status === "paused") return "Build paused";
  if (planCritiqueNeedsResolution(projection.planCritique)) {
    return ARCHITECT_ACTION_REASON_LABELS.plan_critique_resolution_required;
  }

  const statuses = Object.values(projection.tasks).map((task) => task.status);
  if (statuses.some((status) => status === "integration_resolution")) {
    return "Resolving source control conflicts";
  }
  if (statuses.some((status) => ["submitted", "architect_review", "approved"].includes(status))) {
    return "Reviewing completed work";
  }
  if (statuses.some((status) => status === "integrating")) {
    return "Applying completed changes";
  }
  if (statuses.some((status) => status === "waiting_guidance")) {
    return "Waiting for guidance";
  }
  if (statuses.length > 0 && statuses.every((status) => status === "planned")) {
    return "Ready to start";
  }
  return "Build in progress";
}

function providerName(providerId: string): string {
  const knownNames: Record<string, string> = {
    anthropic: "Anthropic",
    chatgpt: "ChatGPT",
    google: "Google",
    openai: "OpenAI",
    openrouter: "OpenRouter",
    xai: "xAI",
  };
  return knownNames[providerId.toLowerCase()] ?? "A model provider";
}

export function runnerNextCooldownExpiry(
  providers: NativeBuildObservability["providers"],
  now = Date.now()
): number | null {
  let nextExpiry: number | null = null;
  for (const provider of providers) {
    if (
      provider.status !== "cooldown" ||
      provider.cooldownUntil === undefined ||
      provider.cooldownUntil <= now
    ) continue;
    if (nextExpiry === null || provider.cooldownUntil < nextExpiry) {
      nextExpiry = provider.cooldownUntil;
    }
  }
  return nextExpiry;
}

export function runnerUserFacingObservability(
  snapshot: NativeBuildObservability,
  projection: NativeBuildProjection | null,
  now = Date.now()
): {
  lifecycle: string;
  progress: {
    completed: number;
    total: number;
    items: Array<{ key: string; title: string; detail: string }>;
  };
  verification: Array<{
    key: string;
    category: string;
    title: string;
    detail: string;
    status: UserFacingVerificationStatus;
  }>;
  verificationSeal?: {
    generationId: string;
    targetRevision: string;
    status: "checks_pending" | "cleanup_pending" | "review_pending" | "repair_required" | "approved" | "failed" | "stale";
  };
  problems: UserFacingProblem[];
} {
  const tasks = projection ? Object.values(projection.tasks) : [];
  const taskTitles = new Map(tasks.map((task) => [task.id, task.objective]));
  const newestEvidence = new Map<
    string,
    { category: string; record: NativeBuildObservability["evidence"][number] }
  >();

  for (const record of snapshot.evidence) {
    const category = evidenceCategory(record.fact);
    const key = `${record.taskId}:${category}`;
    const current = newestEvidence.get(key);
    if (!current || record.createdAt > current.record.createdAt) {
      newestEvidence.set(key, { category, record });
    }
  }

  const evidenceVerification = [...newestEvidence.entries()]
    .sort(([, left], [, right]) => right.record.createdAt.localeCompare(left.record.createdAt))
    .map(([key, { category, record }]) => {
      const status = evidenceStatus(record.fact);
      return {
        key,
        category,
        title: taskTitles.get(record.taskId) ?? "Build verification",
        detail: evidenceDetail(category, status),
        status,
      };
    });
  const canonical = snapshot.finalVerification?.current;
  const categoryLabels: Record<string, string> = {
    build: "Build", tests: "Tests", runtime_smoke: "Runtime", browser: "Browser",
  };
  const verification = canonical
    ? canonical.categories.map((category) => ({
        key: `${canonical.generationId}:${category.category}`,
        category: categoryLabels[category.category],
        title: category.status === "not_applicable"
          ? "Not needed for this revision"
          : `Exact revision ${canonical.targetRevision.slice(0, 12)}`,
        detail: category.status === "pending"
          ? "Runner is waiting to check this category on the exact integrated revision."
          : category.status === "not_applicable"
            ? category.rationale ?? "Repository inspection found no applicable surface."
            : category.status === "failed"
              ? category.issues.join(" ") || "This check did not pass; Runner will preserve diagnostics and schedule repair."
              : "The current integrated revision passed this mechanical check.",
        status: category.status,
      }))
    : evidenceVerification;

  const problems: UserFacingProblem[] = [];
  const executionSafety = snapshot.executionSafety;
  if (executionSafety?.availability === "live") {
    if (executionSafety.fullBypass) {
      problems.push({
        key: "execution-safety:full-bypass",
        title: "Full permission bypass is active",
        detail: "This run explicitly permits unconfined execution in Full mode. Runner does not describe this state as confined.",
      });
    } else if (executionSafety.isolation.status === "blocked" || executionSafety.isolation.status === "unverified") {
      problems.push({
        key: "execution-safety:isolation",
        title: executionSafety.isolation.status === "blocked" ? "Execution isolation is blocked" : "Execution confinement is unverified",
        detail: executionSafety.isolation.status === "blocked"
          ? "The configured provider could not establish the requested execution boundary."
          : "No enforced write-confinement record is available, so Runner cannot claim this execution was confined.",
      });
    }
    const exceptionalStates = new Set(["orphaned", "identity_mismatch", "backend_unavailable", "outcome_unknown"]);
    for (const process of executionSafety.processes) {
      const unavailableRequired = process.requiredCapabilities.filter((capability) =>
        process.capabilities[capability as keyof typeof process.capabilities] !== "enforced"
      );
      if (unavailableRequired.length > 0) {
        problems.push({
          key: `execution-safety:capabilities:${process.invocationId}`,
          title: "Required execution capability is not enforced",
          detail: `${process.logicalProcessId}: ${unavailableRequired.join(", ")} is partial, unavailable, or unverified.`,
        });
      }
      if (process.output.status === "lossy" || process.output.status === "truncated") {
        problems.push({
          key: `execution-safety:output:${process.invocationId}`,
          title: "Process output is incomplete",
          detail: process.output.status === "lossy"
            ? `${process.logicalProcessId} lost ${process.output.lossyBytes} byte${process.output.lossyBytes === 1 ? "" : "s"} of output; captured output must not be treated as complete.`
            : `${process.logicalProcessId} output was truncated; captured output must not be treated as complete.`,
        });
      }
      if (process.cleanup.state === "failed" || (exceptionalStates.has(process.lifecycleState) && process.cleanup.state === "pending")) {
        problems.push({
          key: `execution-safety:cleanup:${process.invocationId}`,
          title: process.cleanup.state === "failed" ? "Process cleanup failed" : "Process cleanup is unresolved",
          detail: process.cleanup.detail ?? "Runner has not proven this process tree empty, so cleanup is not complete.",
        });
      }
    }
    for (const recovery of executionSafety.recovery) {
      const authorizedDestructive = recovery.state === "authorized" && recovery.requestedAction !== "inspect";
      if (!authorizedDestructive && !["user_decision_required", "executing", "outcome_unknown"].includes(recovery.state)) continue;
      problems.push({
        key: `execution-safety:recovery:${recovery.proposalId}`,
        title: recovery.state === "user_decision_required"
          ? "Exceptional recovery needs your decision"
          : authorizedDestructive
            ? "Authorized exceptional recovery is pending"
            : "Exceptional recovery is unresolved",
        detail: recovery.state === "user_decision_required"
          ? "Runner requires an exact user decision before executing this destructive recovery proposal."
          : authorizedDestructive
            ? "The exact destructive proposal is authorized but has not completed; the Build remains blocked until execution reaches a proven outcome."
            : "Runner will not replay or broaden this recovery action until its outcome is known.",
      });
    }
  }
  let verificationSeal: {
    generationId: string;
    targetRevision: string;
    status: "checks_pending" | "cleanup_pending" | "review_pending" | "repair_required" | "approved" | "failed" | "stale";
  } | undefined;
  if (canonical) {
    const status = canonical.revisionStatus === "stale" ? "stale"
      : canonical.cleanup.status === "failed" ? "failed"
      : canonical.mechanicalFailure || canonical.review.status === "repair_required" || canonical.repairs.length > 0 ? "repair_required"
      : canonical.categories.some((category) => category.status === "failed") ? "failed"
      : canonical.categories.some((category) => category.status === "pending") ? "checks_pending"
      : canonical.cleanup.status !== "succeeded" ? "cleanup_pending"
      : canonical.review.status === "approved" ? "approved"
      : "review_pending";
    verificationSeal = { generationId: canonical.generationId, targetRevision: canonical.targetRevision, status };
    if (canonical.revisionStatus === "stale") problems.push({ key: "final-verification:stale", title: "Verification is stale", detail: "The integrated revision changed. Runner must verify the new exact revision before completion." });
    if (canonical.mechanicalFailure || canonical.categories.some((category) => category.status === "failed")) problems.push({ key: "final-verification:failure", title: "Final verification found a problem", detail: canonical.cleanup.diagnosticsAvailable ? "Diagnostics were saved. Runner will repair the failed checks and verify the next integrated revision." : "Runner will preserve diagnostics, repair the failed checks, and verify again." });
    if (canonical.cleanup.status === "failed") problems.push({ key: "final-verification:cleanup", title: "Verification cleanup failed", detail: "Completion is blocked until Runner safely closes verification resources and removes only its owned workspace." });
    if (canonical.repairs.length > 0 || canonical.review.status === "repair_required") problems.push({ key: "final-verification:repair", title: canonical.repairs.some((repair) => !["integrated", "cancelled"].includes(repair.status)) ? "Verification repair is in progress" : "Verification repair required", detail: "Runner is fixing the failed category. A fresh verification generation will check the repaired revision." });
  } else if (snapshot.finalVerification && projection && projection.status !== "completed" && projection.runPolicy !== "plan_only") {
    problems.push({ key: "final-verification:missing", title: "Final verification has not started", detail: "Runner waits for all implementation work, then checks the exact integrated revision before completion." });
  }
  const independentVerifier = snapshot.independentVerifier;
  const currentVerifierReview = independentVerifier?.review.current;
  if (independentVerifier?.selection?.status === "required") {
    problems.push({
      key: "verifier:selection",
      title: "Choose an independent verifier",
      detail: independentVerifier.selection.reason,
    });
  }
  for (const guidance of projection ? Object.values(projection.guidance) : []) {
    if (guidance.kind !== "replan" || guidance.status !== "open" || !guidance.replan) continue;
    problems.push({
      key: `replan:${guidance.requestId}`,
      title: "Worker requested a replan",
      detail: guidance.replan.summary,
    });
  }
  if (
    currentVerifierReview?.state === "current" &&
    currentVerifierReview.verdict &&
    !currentVerifierReview.verdict.satisfied
  ) {
    problems.push({
      key: "verifier:repair",
      title: "Independent verification requires repair",
      detail:
        "Runner will repair the unsatisfied criteria, integrate a new revision, and request a fresh independent verdict.",
    });
  }
  if (projection?.acceptanceContractStatus === "acceptance_contract_upgrade_required") {
    problems.push({
      key: "acceptance-contract:upgrade",
      title: "Acceptance criteria need an Architect upgrade",
      detail: "This legacy run cannot submit or review work until every non-cancelled task has criteria.",
    });
  }
  if (projection?.repairCycles?.pause) {
    problems.push({
      key: "repair-cycles:limit",
      title: "Repair budget exhausted",
      detail: `Runner used ${projection.repairCycles.used} of ${projection.repairCycles.limit} repair plans. Extend the budget or stop the build.`,
    });
  }
  const currentWorkerIds = new Set(
    tasks
      .filter((task) => ACTIVE_WORKER_TASK_STATUSES.has(task.status))
      .map((task) => task.assignedWorkerId)
      .filter((workerId): workerId is string => Boolean(workerId))
  );
  for (const provider of snapshot.providers) {
    if (
      provider.status !== "cooldown" ||
      (provider.cooldownUntil !== undefined && provider.cooldownUntil <= now)
    ) continue;
    problems.push({
      key: `provider:${provider.providerId}`,
      title: `${providerName(provider.providerId)} is temporarily unavailable`,
      detail: "Wait until the provider is available, then resume the build if it is paused.",
    });
  }
  for (const agent of snapshot.agents) {
    if (
      agent.status !== "suspended" ||
      agent.actor.role !== "worker" ||
      !currentWorkerIds.has(agent.actor.id)
    ) continue;
    problems.push({
      key: `agent:${agent.sessionId}`,
      title: "An active agent is paused",
      detail: "Open Advanced diagnostics for the recorded reason and recovery details.",
    });
  }
  for (const guidance of projection ? Object.values(projection.guidance) : []) {
    if (!guidance.blocking || guidance.status !== "open") continue;
    const objective = taskTitles.get(guidance.taskId);
    problems.push({
      key: `guidance:${guidance.requestId}`,
      title: "A decision is needed",
      detail: objective ? `${objective}: ${guidance.question}` : guidance.question,
    });
  }
  for (const task of tasks) {
    if (task.status === "integration_resolution") {
      problems.push({
        key: `conflict:${task.id}`,
        title: "Source control conflicts need resolution",
        detail: task.conflictPaths?.length
          ? `${task.objective}: ${task.conflictPaths.join(", ")}`
          : `${task.objective} cannot be applied until its conflicts are resolved.`,
      });
    } else if (task.status === "failed") {
      problems.push({
        key: `task:${task.id}`,
        title: task.objective,
        detail: "This task failed and needs a new plan before work can continue.",
      });
    } else if (task.status === "rejected") {
      problems.push({
        key: `task:${task.id}`,
        title: task.objective,
        detail: "This task needs changes before it can continue.",
      });
    }
  }
  for (const review of projection ? Object.values(projection.reviews) : []) {
    if (review.status !== "rejected" || problems.some((problem) => problem.key === `task:${review.taskId}`)) {
      continue;
    }
    problems.push({
      key: `task:${review.taskId}`,
      title: taskTitles.get(review.taskId) ?? "A completed task",
      detail: review.summary || "This task needs changes before it can continue.",
    });
  }
  if (planCritiqueNeedsResolution(projection?.planCritique)) {
    const claims = (projection?.planCritique?.current?.findings ?? [])
      .filter((finding) => finding.severity === "blocking")
      .map((finding) => finding.claim);
    problems.push({
      key: "plan-critique:blocking",
      title: "Plan critique found blocking issues",
      detail: claims.join(" "),
    });
  }
  if (
    projection?.status === "paused" &&
    projection.projectHandoff?.status !== "requested" &&
    problems.length === 0
  ) {
    problems.push({
      key: "run:paused",
      title: "Build is paused",
      detail: "Resume the build when you are ready to continue.",
    });
  }

  return {
    lifecycle: lifecycleLabel(projection),
    progress: {
      completed: tasks.filter((task) => COMPLETE_TASK_STATUSES.has(task.status)).length,
      total: tasks.length,
      items: tasks.map((task) => ({
        key: task.id,
        title: task.objective,
        detail: taskStatusLabel(task.status),
      })),
    },
    verification,
    ...(verificationSeal ? { verificationSeal } : {}),
    problems,
  };
}

export function RunnerV2SteeringPanel({
  projection,
  onAnswerQuestion,
}: {
  projection: NativeBuildProjection | null;
  onAnswerQuestion?: (
    questionId: string,
    version: number,
    answer: string,
    idempotencyKey: string,
  ) => Promise<void>;
}) {
  const view = runnerSteeringLedgerView(projection);
  const question = view.activeQuestion;
  const [answer, setAnswer] = useState("");
  const [answerPending, setAnswerPending] = useState(false);
  const [answerError, setAnswerError] = useState<string | null>(null);
  const answerGateRef = useRef(createArchitectQuestionAnswerGate(question));
  alignArchitectQuestionAnswerGate(answerGateRef.current, question);
  useEffect(() => {
    setAnswer("");
    setAnswerPending(false);
    setAnswerError(null);
  }, [question?.questionId, question?.version]);

  if (view.guidance.length === 0 && !question) return null;

  const submitAnswer = async () => {
    const trimmed = answer.trim();
    if (!question || !onAnswerQuestion || !trimmed || answerPending) return;
    setAnswerPending(true);
    setAnswerError(null);
    const completed = await submitGuardedRunnerArchitectQuestionAnswer(
      answerGateRef.current,
      question,
      trimmed,
      onAnswerQuestion,
    );
    if (!completed.current) return;
    const { result } = completed;
    if (result.ok) {
      setAnswer("");
    } else {
      setAnswerError(result.error);
    }
    setAnswerPending(false);
  };

  return (
    <section aria-labelledby="runner-steering-title" className="space-y-3">
      {question && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-amber-950 shadow-sm dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 id="runner-steering-title" className="text-sm font-semibold">
                  Architect needs your decision
                </h2>
                <Badge variant="outline" className="border-amber-400/70 font-mono text-[0.65rem]">
                  {question.decisionLabel} · v{question.version}
                </Badge>
              </div>
              <p className="mt-2 text-sm leading-relaxed">{question.question}</p>
              <form
                className="mt-3 space-y-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  void submitAnswer();
                }}
              >
                <label htmlFor={`architect-answer-${question.questionId}`} className="text-xs font-medium">
                  Your decision
                </label>
                <textarea
                  id={`architect-answer-${question.questionId}`}
                  value={answer}
                  onChange={(event) => setAnswer(event.target.value)}
                  rows={2}
                  className="w-full resize-y rounded-md border border-amber-300 bg-background px-3 py-2 text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500"
                  placeholder="State the decision the Architect should follow."
                  disabled={answerPending}
                />
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs opacity-75">Runner applies this answer to this exact question version.</p>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={!answer.trim() || answerPending || !onAnswerQuestion}
                  >
                    {answerPending ? "Sending decision…" : "Answer decision"}
                  </Button>
                </div>
                <RunnerQuestionAnswerError message={answerError} />
              </form>
            </div>
          </div>
        </div>
      )}

      {view.guidance.length > 0 && (
        <div className="rounded-lg border bg-card px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2">
            <MessageSquareText className="h-4 w-4 text-primary" />
            <div>
              <h2 id={question ? undefined : "runner-steering-title"} className="text-sm font-semibold">
                Steering ledger
              </h2>
              <p className="mt-0.5 text-xs text-muted-foreground">
                Durable text guidance recorded by Runner V2.
              </p>
            </div>
          </div>
          <ol className="mt-3 space-y-3">
            {view.guidance.map((item) => (
              <li key={item.guidanceId} className="rounded-md border bg-muted/10 p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm leading-relaxed">{item.text}</p>
                  <span className={`font-mono text-[0.65rem] ${
                    item.state === "acknowledged" ? "text-emerald-600 dark:text-emerald-400" : "text-blue-600 dark:text-blue-400"
                  }`}>
                    guidance v{item.version}
                  </span>
                </div>
                <div className="mt-3 grid gap-1.5 sm:grid-cols-3" aria-label="Durable guidance receipt">
                  {item.receipt.map((step) => (
                    <div
                      key={step.label}
                      className={`flex items-center gap-2 rounded border px-2.5 py-1.5 text-[0.7rem] ${
                        step.status === "complete"
                          ? "border-emerald-300/70 bg-emerald-50 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/30 dark:text-emerald-300"
                          : step.status === "current"
                            ? "border-blue-300/70 bg-blue-50 text-blue-800 dark:border-blue-900 dark:bg-blue-950/30 dark:text-blue-300"
                            : "border-border bg-muted/30 text-muted-foreground"
                      }`}
                    >
                      {step.status === "complete"
                        ? <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
                        : <CircleDot className="h-3.5 w-3.5 shrink-0" />}
                      <span>{step.label}</span>
                    </div>
                  ))}
                </div>
                {item.acknowledgementRationale && (
                  <p className="mt-2 border-l-2 border-emerald-400 pl-2 text-xs leading-relaxed text-muted-foreground">
                    {item.acknowledgementRationale}
                  </p>
                )}
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

export function RunnerV2ObservabilityPanel({
  snapshot,
  projection,
  onDownloadAudit,
  onExtendRepairCycles,
}: {
  snapshot: NativeBuildObservability | null;
  projection?: NativeBuildProjection | null;
  onDownloadAudit?: () => void;
  onExtendRepairCycles?: (additionalRepairPlans: number, idempotencyKey: string) => Promise<void>;
}) {
  const [query, setQuery] = useState("");
  const [clock, setClock] = useState(() => Date.now());
  const [repairExtension, setRepairExtension] = useState(1);
  const nextCooldownExpiry = runnerNextCooldownExpiry(snapshot?.providers ?? [], clock);
  useEffect(() => {
    if (nextCooldownExpiry === null) return;
    const timeoutId = window.setTimeout(
      () => setClock(Date.now()),
      Math.max(0, nextCooldownExpiry - Date.now())
    );
    return () => window.clearTimeout(timeoutId);
  }, [nextCooldownExpiry, snapshot]);
  if (!snapshot) return null;
  const summary = runnerObservabilitySummary(snapshot);
  const filtered = filterRunnerObservability(snapshot, query);
  const control = runnerBuildControlSummary(projection ?? null);
  const matches = <T,>(value: T) =>
    !query.trim() || JSON.stringify(value).toLowerCase().includes(query.trim().toLowerCase());
  const visibleGuidance = control.guidance.filter(matches);
  const visibleIntegration = control.integration.filter(matches);
  const integrationBranch = snapshot.git.integrationBranch || control.branch;
  const integrationRevision = snapshot.git.integrationRevision || control.revision;
  const visibleCommits = snapshot.git.commits.filter(matches);
  const view = runnerUserFacingObservability(snapshot, projection ?? null, clock);
  const acceptance = runnerAcceptanceContractSummary(projection ?? null);
  return (
    <section aria-labelledby="runner-activity-title" className="overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="border-b px-4 py-4 sm:px-5">
        <div className="flex items-center gap-2.5">
          <Activity className="h-4 w-4 text-primary" />
          <div>
            <h2 id="runner-activity-title" className="text-sm font-semibold">Build activity</h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Follow what is finished, what was checked, and what needs your attention.
            </p>
          </div>
        </div>
      </div>

      <div className="grid gap-3 p-4 sm:p-5 xl:grid-cols-3">
        <UserSection title="Progress" icon={<CircleDot className="h-4 w-4" />} accent="progress">
          <div className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2.5">
            <p className="text-[0.68rem] font-medium uppercase tracking-wide text-primary">Current status</p>
            <p className="mt-1 text-sm font-semibold leading-snug">{view.lifecycle}</p>
            <ContextRecordingLines projection={projection ?? null} />
            <p className="mt-1 text-xs text-muted-foreground">
              {view.progress.completed} of {view.progress.total} task{view.progress.total === 1 ? "" : "s"} complete
            </p>
          </div>
          {view.progress.items.length > 0 ? (
            <ul className="mt-3 space-y-2.5">
              {view.progress.items.map((item) => (
                <li key={item.key} className="flex min-w-0 items-start gap-2.5">
                  {item.detail === "Complete" || item.detail === "No longer needed" ? (
                    <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-500" />
                  ) : (
                    <CircleDot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <div className="min-w-0">
                    <p className="text-xs font-medium leading-snug">{item.title}</p>
                    <p className="mt-0.5 text-[0.7rem] text-muted-foreground">{item.detail}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-3 text-xs text-muted-foreground">Tasks will appear when the build plan is ready.</p>
          )}
        </UserSection>

        {(acceptance.tasks.length > 0 || acceptance.status !== "current") && (
          <UserSection
            title="Acceptance contract"
            icon={<ShieldCheck className="h-4 w-4" />}
            accent={acceptance.status === "acceptance_contract_upgrade_required" ? "warning" : "progress"}
          >
            <p className="mb-3 text-[0.7rem] leading-relaxed text-muted-foreground">
              Evidence is mechanical; Architect verdict is semantic.
            </p>
            {acceptance.status === "acceptance_contract_upgrade_required" && (
              <p className="mb-3 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-xs">
                The Architect must upgrade criteria before this legacy run can submit or review work.
              </p>
            )}
            {acceptance.tasks.length > 0 ? (
              <ul className="space-y-3">
                {acceptance.tasks.map((task) => (
                  <li key={task.taskId} className="rounded-md border bg-muted/10 p-2.5">
                    <div className="flex items-center justify-between gap-2">
                      <p className="min-w-0 truncate text-xs font-medium">
                        <span className="font-mono text-[0.68rem] text-muted-foreground">{task.taskId}</span>{" "}
                        {task.title}
                      </p>
                      {task.version !== undefined && (
                        <Badge variant="secondary" className="shrink-0 text-[0.65rem]">v{task.version}</Badge>
                      )}
                    </div>
                    <ul className="mt-2 space-y-2 border-t pt-2">
                      {task.criteria.map((criterion) => (
                        <li key={criterion.id} className="space-y-1.5 text-xs">
                          <p className="leading-relaxed">
                            <span className="font-mono text-[0.68rem] text-muted-foreground">{criterion.id}</span>{" "}
                            {criterion.text}
                          </p>
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={criterion.evidence.status === "submitted" ? "success" : "secondary"} className="text-[0.65rem]">
                              {criterion.evidence.status === "submitted"
                                ? `Evidence submitted${criterion.evidence.evidenceIds.length > 0 ? ` · ${criterion.evidence.evidenceIds.join(", ")}` : ""}`
                                : "Evidence not submitted"}
                            </Badge>
                            <Badge
                              variant={criterion.verdict.status === "satisfied" ? "success" : criterion.verdict.status === "unsatisfied" ? "destructive" : "secondary"}
                              className="text-[0.65rem]"
                            >
                              Architect verdict: {criterion.verdict.status === "satisfied" ? "Satisfied" : criterion.verdict.status === "unsatisfied" ? "Unsatisfied" : "Not reviewed"}
                            </Badge>
                          </div>
                          {criterion.verdict.rationale && (
                            <p className="leading-relaxed text-muted-foreground">{criterion.verdict.rationale}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">No acceptance criteria are recorded for this run.</p>
            )}
          </UserSection>
        )}

        {snapshot.finalVerification?.current ? (
          <FinalVerificationManifest verification={snapshot.finalVerification} />
        ) : <UserSection
          title="Verification"
          icon={<ShieldCheck className="h-4 w-4" />}
          accent={runnerVerificationTone(view.verification)}
        >
          {view.verification.length > 0 ? (
            <ul className="space-y-3">
              {view.verification.map((item) => (
                <li key={item.key} className="min-w-0">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <Badge variant="secondary" className="font-normal">{item.category}</Badge>
                    <span className={`text-[0.68rem] font-medium ${verificationStatusClass(item.status)}`}>
                      {item.status === "passed" ? "Passed" : item.status === "failed" ? "Failed" : "Recorded"}
                    </span>
                  </div>
                  <p className="mt-1.5 text-xs font-medium leading-snug">{item.title}</p>
                  <p className="mt-0.5 text-[0.7rem] leading-relaxed text-muted-foreground">{item.detail}</p>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs leading-relaxed text-muted-foreground">
              Verification results will appear after the runner records its first check.
            </p>
          )}
        </UserSection>}

        {snapshot.independentVerifier && (
          <IndependentVerifierManifest
            verifier={snapshot.independentVerifier}
            projection={projection ?? null}
          />
        )}

        <UserSection
          title="Problems requiring attention"
          icon={view.problems.length > 0
            ? <AlertTriangle className="h-4 w-4" />
            : <CheckCircle2 className="h-4 w-4" />}
          accent={view.problems.length > 0 ? "warning" : "success"}
        >
          {view.problems.length > 0 ? (
            <ul className="space-y-3">
              {view.problems.map((problem) => (
                <li key={problem.key} data-problem-key={problem.key} className="rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
                  <p className="text-xs font-medium leading-snug">{problem.title}</p>
                  <p className="mt-1 text-[0.7rem] leading-relaxed text-muted-foreground">{problem.detail}</p>
                </li>
              ))}
            </ul>
          ) : (
            <div className="flex items-start gap-2.5 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-3 py-2.5">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
              <p className="text-xs leading-relaxed">No active blockers remain.</p>
            </div>
          )}
          {projection?.repairCycles?.pause && onExtendRepairCycles && (
            <div className="mt-3 flex flex-wrap items-center gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-3 py-2.5">
              <label className="text-[0.7rem] text-muted-foreground" htmlFor="repair-cycle-extension">
                Additional repair plans
              </label>
              <input
                id="repair-cycle-extension"
                type="number"
                min={1}
                max={10}
                value={repairExtension}
                onChange={(event) => {
                  const next = Number(event.target.value);
                  setRepairExtension(Number.isFinite(next) ? Math.min(10, Math.max(1, Math.trunc(next))) : 1);
                }}
                className="h-8 w-16 rounded-md border bg-background px-2 text-xs outline-none focus:ring-2 focus:ring-ring"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void onExtendRepairCycles(
                  repairExtension,
                  `repair-cycles:${projection.runId}:${projection.repairCycles?.used}:${projection.repairCycles?.extensions}`,
                )}
              >
                Extend repair budget
              </Button>
            </div>
          )}
        </UserSection>
      </div>

      <details className="border-t">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-medium outline-none marker:content-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5">
          <span>Advanced diagnostics</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </summary>

        <div className="flex flex-wrap items-start justify-between gap-3 border-t px-4 py-3">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" />
          <div>
            <h3 className="text-sm font-semibold">Diagnostic overview</h3>
            <p className="text-xs text-muted-foreground">
              Durable agents, tools, evidence, memory, skills, and processes
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {onDownloadAudit && (
            <Button type="button" size="sm" variant="outline" onClick={onDownloadAudit}>
              <Download className="mr-1 h-3.5 w-3.5" />
              Download audit
            </Button>
          )}
          <Badge variant={summary.toolErrors > 0 ? "warning" : "secondary"}>
            {summary.toolErrors} tool error{summary.toolErrors === 1 ? "" : "s"}
          </Badge>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-px bg-border sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Model calls" value={String(summary.modelCalls)} />
        <Stat label="Tool calls" value={String(summary.toolCalls)} />
        <Stat label="Tokens" value={formatTokenCount(summary.totalTokens)} />
        <Stat
          label="Cache read / write"
          value={`${formatTokenCount(summary.cachedInputTokens)} / ${formatTokenCount(summary.cacheWriteInputTokens)}`}
        />
        <Stat label="Agents" value={String(summary.agents)} />
        <Stat label="Evidence" value={String(summary.evidence)} />
        <Stat label="Active processes" value={String(summary.runningProcesses)} />
      </div>
      <div className="border-t px-4 py-2 text-xs text-muted-foreground">
        Context manifests: {summary.contextManifests}
      </div>

      <div className="border-t px-4 py-3">
        <label className="relative block max-w-xl">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-3.5 w-3.5 text-muted-foreground" />
          <input
            type="search"
            aria-label="Search durable runner records"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search durable runner records"
            className="h-9 w-full rounded-md border bg-background pl-8 pr-3 text-xs outline-none focus:ring-2 focus:ring-ring"
          />
        </label>
      </div>

      <div className="grid gap-3 border-t p-4 lg:grid-cols-2">
        <PlanCritiqueControlLines control={control} />
        <ObservationList
          icon={<Bot className="h-3.5 w-3.5" />}
          title="Agent sessions"
          empty="No agent sessions recorded."
          items={filtered.agents.slice(-12).reverse().map((agent) => ({
            key: agent.sessionId,
            title: `${agent.actor.role}: ${agent.actor.id}`,
            detail: `${agent.status} · ${agent.turns} turn${agent.turns === 1 ? "" : "s"}${
              agent.suspensionReason ? ` · ${agent.suspensionReason}` : ""
            }`,
          }))}
        />
        <ObservationList
          icon={<Wrench className="h-3.5 w-3.5" />}
          title="Recent tools"
          empty="No native tool calls recorded."
          items={filtered.tools.slice(-12).reverse().map((tool) => ({
            key: `${tool.sessionId}:${tool.callId}`,
            title: tool.toolName,
            detail: `${tool.status}${tool.errorCode ? ` · ${tool.errorCode}` : ""}`,
          }))}
        />
        <ObservationList
          icon={<ListChecks className="h-3.5 w-3.5" />}
          title="Evidence"
          empty="No evidence recorded."
          items={filtered.evidence.slice(-8).reverse().map((evidence) => ({
            key: evidence.id,
            title: evidence.fact.label,
            detail: `${evidence.taskId} · ${runnerEvidenceDiagnosticDetail(evidence.fact)}`,
          }))}
        />
        <ObservationList
          icon={<Database className="h-3.5 w-3.5" />}
          title="Context resources"
          empty="No skills or project memories discovered."
          items={[
            ...filtered.skills.slice(0, 8).map((skill) => ({
              key: `skill:${skill.id}`,
              title: skill.name,
              detail: `${skill.source} skill`,
            })),
            ...filtered.memories.slice(-4).reverse().map((memory) => ({
              key: `memory:${memory.id}`,
              title: memory.content.slice(0, 80),
              detail: `${memory.status} project memory`,
            })),
          ]}
        />
        <ObservationList
          icon={<ShieldCheck className="h-3.5 w-3.5" />}
          title="Execution safety"
          empty="Execution safety disclosure is unavailable."
          items={runnerExecutionSafetyDiagnostics(snapshot).filter(matches)}
        />
        <ObservationList
          icon={<Server className="h-3.5 w-3.5" />}
          title="Provider health"
          empty="No provider health transitions recorded."
          items={filtered.providers.map((provider) => ({
            key: provider.providerId,
            title: provider.providerId,
            detail: `${provider.status} · ${provider.consecutiveFailures} consecutive failure${provider.consecutiveFailures === 1 ? "" : "s"}${provider.failureKind ? ` · ${provider.failureKind}` : ""}`,
          }))}
        />
        <ObservationList
          icon={<Activity className="h-3.5 w-3.5" />}
          title="Recent events"
          empty="No matching scheduler events."
          items={filtered.events.slice(-12).reverse().map((event) => ({
            key: `${event.sequence}:${event.type}`,
            title: event.type,
            detail: `${event.actor.role}: ${event.actor.id} · #${event.sequence}`,
          }))}
        />
        <ObservationList
          icon={<MessageSquareText className="h-3.5 w-3.5" />}
          title="Architect guidance"
          empty="No matching guidance exchanges."
          items={visibleGuidance.slice(-10).reverse().map((guidance) => ({
            key: guidance.requestId,
            title: `${guidance.taskId}: ${guidance.question}`,
            detail: `${guidance.status}${guidance.blocking ? " · blocking" : " · advisory"}${guidance.answer ? ` · ${guidance.answer}` : ""}`,
          }))}
        />
        <ObservationList
          icon={<GitBranch className="h-3.5 w-3.5" />}
          title="Integration queue and Git"
          empty="No change sets have entered integration."
          items={[
            ...(integrationBranch && matches(integrationBranch) ? [{
              key: `branch:${integrationBranch}`,
              title: integrationBranch,
              detail: `integration branch${integrationRevision ? ` · ${integrationRevision.slice(0, 12)}` : ""}`,
            }] : []),
            ...visibleCommits.slice(0, 10).map((commit) => ({
              key: `commit:${commit.revision}`,
              title: commit.subject,
              detail: `${commit.revision.slice(0, 12)} · ${commit.parents.length} parent${commit.parents.length === 1 ? "" : "s"}`,
            })),
            ...visibleIntegration.slice(-10).reverse().map((item) => ({
              key: `integration:${item.taskId}`,
              title: `${item.taskId}: ${item.objective}`,
              detail: `${item.status}${item.revision ? ` · ${item.revision.slice(0, 12)}` : ""}${item.conflictPaths.length ? ` · conflicts: ${item.conflictPaths.join(", ")}` : ""}`,
            })),
          ]}
        />
      </div>

      {filtered.processes.length > 0 && (
        <div className="border-t px-4 py-3">
          <div className="mb-2 flex items-center gap-2 text-xs font-medium">
            <Hammer className="h-3.5 w-3.5" /> Background processes
          </div>
          <div className="space-y-1 font-mono text-xs text-muted-foreground">
            {filtered.processes.slice(-8).reverse().map((process) => (
              <p key={process.processId} className="truncate">
                {process.status} · {process.command} {process.args.join(" ")}
              </p>
            ))}
          </div>
        </div>
      )}
      </details>
      <PlanCritiqueFindings critique={projection?.planCritique} />
    </section>
  );
}

function PlanCritiqueControlLines({
  control,
}: {
  control: ReturnType<typeof runnerBuildControlSummary>;
}) {
  const lines = [
    control.planCritiqueSummary,
    control.planRiskLabel,
    control.planRiskRationale,
    control.planRiskSource,
    control.planCritiqueMode,
    control.planCritiqueHistoryLabel,
    control.planCritiqueDeclaredLabel,
  ].filter((line): line is string => Boolean(line));
  if (lines.length === 0) return null;
  return (
    <div className="space-y-1 lg:col-span-2" data-plan-critique-summary="">
      {lines.map((line) => (
        <p key={line} className="text-xs leading-relaxed text-muted-foreground">{line}</p>
      ))}
    </div>
  );
}

function PlanCritiqueFindings({
  critique,
}: {
  critique: NativePlanCritiqueState | undefined;
}) {
  const current = critique?.current;
  const findings = current?.findings ?? [];
  if (findings.length === 0) return null;
  const resolutions = new Map(
    (current?.resolution?.resolutions ?? []).map((item) => [item.findingId, item]),
  );
  return (
    <details className="border-t">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 text-xs font-medium outline-none marker:content-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring sm:px-5">
        <span>Plan critique findings</span>
        <ChevronDown className="h-4 w-4 text-muted-foreground" />
      </summary>
      <div className="space-y-2 border-t px-4 py-3 sm:px-5">
        <p className="font-mono text-[0.68rem] text-muted-foreground">
          {current?.critiqueId} · {current?.runtime.runtimeId} · {current?.runtime.sessionId}
          {current?.excludedModels.length
            ? ` · ${current.excludedModels.map((model) => model.modelIdentity).join(", ")}`
            : ""}
          {current?.independence === "fresh_context" ? " · same model, fresh context" : ""}
        </p>
        <ul className="space-y-2">
          {findings.map((finding) => {
            const resolution = resolutions.get(finding.findingId);
            return (
              <li key={finding.findingId} className="rounded-md border bg-muted/10 px-3 py-2.5">
                <p className="text-xs font-medium">
                  {finding.severity} · {finding.category} · {finding.taskIds.join(", ")}
                </p>
                <p className="mt-1 text-xs leading-relaxed">{finding.claim}</p>
                <p className="mt-1 text-[0.7rem] leading-relaxed text-muted-foreground">{finding.evidence.join(" ")}</p>
                {finding.criterionIds?.map((criterion) => (
                  <p key={`${criterion.taskId}:${criterion.criterionId}`} className="mt-1 font-mono text-[0.68rem] text-muted-foreground">
                    {criterion.taskId}:{criterion.criterionId}
                  </p>
                ))}
                {finding.severity === "blocking" && resolution ? (
                  <p className="mt-1 text-[0.7rem] leading-relaxed">
                    Architect resolution: {resolution.resolution} - {resolution.rationale}
                  </p>
                ) : null}
              </li>
            );
          })}
        </ul>
      </div>
    </details>
  );
}

export function FinalVerificationManifest({
  verification,
}: {
  verification: NativeFinalVerificationObservability;
}) {
  const current = verification.current;
  if (!current) {
    return (
      <UserSection title="Final verification" icon={<ShieldCheck className="h-4 w-4" />} accent="progress">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Runner waits for the exact integrated revision, then checks Build, Tests, Runtime, and Browser before completion.
        </p>
      </UserSection>
    );
  }
  const labels: Record<string, string> = { build: "Build", tests: "Tests", runtime_smoke: "Runtime", browser: "Browser" };
  const label = (status: string) => status === "not_applicable" ? "N/A" : status[0].toUpperCase() + status.slice(1);
  const seal = current.review.status === "approved" ? "Architect approved"
    : current.review.status === "repair_required" || current.repairs.length > 0 ? "Repair required"
    : current.review.status === "requested" ? "Architect review in progress"
    : "Architect review pending";
  return (
    <section aria-label="Final verification manifest" className="min-w-0 rounded-lg border border-primary/25 bg-muted/10 p-3.5 text-foreground xl:col-span-2">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-primary/15 pb-3">
        <div>
          <div className="flex items-center gap-2 text-primary"><ShieldCheck className="h-4 w-4" /><h3 className="text-xs font-semibold text-foreground">Final verification</h3></div>
          <p className="mt-2 font-mono text-[0.68rem] text-muted-foreground">Revision {current.targetRevision.slice(0, 12)} · Generation {current.generationId}</p>
        </div>
        <Badge variant={current.revisionStatus === "current" ? "secondary" : "warning"}>{current.revisionStatus === "current" ? "Exact revision" : "Stale revision"}</Badge>
      </div>
      <div className="grid gap-2 py-3 sm:grid-cols-2 lg:grid-cols-4">
        {current.categories.map((category) => (
          <div key={category.category} className="rounded-md border bg-card px-3 py-2.5">
            <div className="flex items-center justify-between gap-2"><p className="text-xs font-semibold">{labels[category.category]}</p><span className={`text-[0.68rem] font-semibold ${verificationStatusClass(category.status)}`}>{label(category.status)}</span></div>
            <p className="mt-1.5 text-[0.68rem] leading-relaxed text-muted-foreground">{category.status === "pending" ? "Waiting for the exact revision check." : category.status === "not_applicable" ? category.rationale : category.status === "failed" ? category.issues.join(" ") || "Check failed." : "Current revision passed."}</p>
          </div>
        ))}
      </div>
      <div className="grid gap-2 border-t border-primary/15 pt-3 text-[0.7rem] sm:grid-cols-3">
        <p><span className="font-medium">Cleanup</span><br /><span className="text-muted-foreground">{current.cleanup.status === "succeeded" ? "Complete" : label(current.cleanup.status)}{current.cleanup.diagnosticsAvailable ? " · Diagnostics saved" : ""}</span></p>
        <p><span className="font-medium">Release seal</span><br /><span className="text-muted-foreground">{seal}</span></p>
        <p><span className="font-medium">Repair</span><br /><span className="text-muted-foreground">{current.repairs.length > 0 ? "Repair in progress" : "No repair scheduled"}</span></p>
      </div>
    </section>
  );
}

export function IndependentVerifierManifest({
  verifier,
  projection,
}: {
  verifier: NativeIndependentVerifierObservability;
  projection: NativeBuildProjection | null;
}) {
  const risk = verifier.risk.current;
  const review = verifier.review.current;
  const verdict = review?.state === "current" ? review.verdict : undefined;
  const strictQualification =
    verifier.policy?.alwaysRequireIndependentVerifier ?? false;
  const required = risk
    ? risk.risk === "high" || strictQualification
    : undefined;
  const accent = verdict?.satisfied
    ? "success"
    : verdict && !verdict.satisfied
      ? "error"
      : required === true
        ? "warning"
        : "progress";
  const riskLabel = !risk
    ? "Not assessed"
    : risk.risk === "high"
      ? "High risk"
      : "Low risk";
  const verdictLabel = !risk
    ? "Risk assessment pending"
    : required === false
      ? "Not required"
      : !review
      ? verifier.selection?.status === "required"
        ? "Verifier choice required"
        : "Waiting for verifier"
      : !verdict
        ? "Review in progress"
        : verdict.satisfied
          ? "Satisfied"
          : "Repair required";

  return (
    <UserSection
      title="Independent verification"
      icon={<ShieldCheck className="h-4 w-4" />}
      accent={accent}
    >
      <div className="space-y-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          High-risk builds always require an independent verifier.
          {strictQualification
            ? " This run also independently verifies low-risk revisions."
            : " Low-risk revisions skip this gate unless the run opts into stricter qualification."}
        </p>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-md border bg-card px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold">Build risk</p>
              <Badge
                variant={risk?.risk === "high" ? "warning" : "secondary"}
                className="text-[0.65rem]"
              >
                {riskLabel}
              </Badge>
            </div>
            {risk?.architectRationale && (
              <p className="mt-2 text-[0.7rem] leading-relaxed text-muted-foreground">
                {risk.architectRationale}
              </p>
            )}
            {risk?.reasons.length ? (
              <ul className="mt-2 space-y-1 text-[0.68rem] text-muted-foreground">
                {risk.reasons.map((reason) => (
                  <li key={`${reason.code}:${reason.evidence.join(":")}`}>
                    {riskReasonLabel(reason.code)}
                    {reason.evidence.length > 0
                      ? ` · ${reason.evidence.join(", ")}`
                      : ""}
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
          <div className="rounded-md border bg-card px-3 py-2.5">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold">Verifier verdict</p>
              <Badge
                variant={
                  verdict?.satisfied
                    ? "success"
                    : verdict
                      ? "destructive"
                      : "secondary"
                }
                className="text-[0.65rem]"
              >
                {verdictLabel}
              </Badge>
            </div>
            <p className="mt-2 text-[0.7rem] leading-relaxed text-muted-foreground">
              {review
                ? `${review.runtime.runtimeId} · revision ${review.targetRevision.slice(0, 12)}`
                : verifier.selection?.status === "required"
                  ? verifier.selection.reason
                  : !risk
                    ? "Runner is assessing the exact integrated revision before deciding whether independent verification is required."
                  : required === true
                    ? "Runner will bind a distinct verifier to the exact integrated revision."
                    : "The current low-risk revision does not require an independent verdict."}
            </p>
            {review?.independence === "fresh_context" ? (
              <p className="mt-2 text-[0.7rem] leading-relaxed text-muted-foreground">
                same model, fresh context
              </p>
            ) : null}
            {review?.expectations && review.expectations.length > 0 ? (
              <p className="mt-2 text-[0.7rem] leading-relaxed text-muted-foreground">
                Expectations recorded ({review.expectations.length} criteria)
              </p>
            ) : null}
          </div>
        </div>
        {verdict && (
          <ul className="space-y-2 border-t pt-3">
            {verdict.criterionVerdicts.map((criterion) => (
              <li
                key={`${criterion.taskId}:${criterion.criterionId}`}
                className="rounded-md border bg-card px-3 py-2.5"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-xs font-medium">
                    {projection?.tasks[criterion.taskId]?.objective ??
                      criterion.taskId}{" "}
                    · {criterion.criterionId}
                  </p>
                  <Badge
                    variant={
                      criterion.verdict === "satisfied"
                        ? "success"
                        : "destructive"
                    }
                    className="text-[0.65rem]"
                  >
                    {criterion.verdict === "satisfied"
                      ? "Satisfied"
                      : "Unsatisfied"}
                  </Badge>
                </div>
                <p className="mt-1 text-[0.7rem] leading-relaxed text-muted-foreground">
                  {criterion.rationale}
                </p>
                <p className="mt-1 font-mono text-[0.65rem] text-muted-foreground">
                  Evidence: {criterion.evidenceIds.join(", ")}
                </p>
                {criterion.verdict === "unsatisfied" && criterion.location ? (
                  <p className="mt-1 font-mono text-[0.65rem] text-muted-foreground">
                    {criterion.location.path}
                    {criterion.location.lines ? `:${criterion.location.lines}` : ""}
                  </p>
                ) : null}
                {criterion.verdict === "unsatisfied" &&
                criterion.reproduction &&
                criterion.reproduction.length > 0 ? (
                  <ol className="mt-1 list-decimal space-y-0.5 pl-4 text-[0.7rem] leading-relaxed text-muted-foreground">
                    {criterion.reproduction.map((step) => (
                      <li key={step}>{step}</li>
                    ))}
                  </ol>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </div>
    </UserSection>
  );
}

function riskReasonLabel(code: string): string {
  return code
    .split("_")
    .map((word) => `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
    .join(" ");
}

function verificationStatusClass(status: UserFacingVerificationStatus): string {
  if (status === "passed") return "text-emerald-600 dark:text-emerald-400";
  if (status === "failed") return "text-destructive";
  if (status === "not_applicable") return "text-muted-foreground";
  return "text-amber-600 dark:text-amber-400";
}

function UserSection({
  title,
  icon,
  accent,
  children,
}: {
  title: string;
  icon: React.ReactNode;
  accent: "progress" | "success" | "warning" | "error";
  children: React.ReactNode;
}) {
  const accentClass = accent === "success"
    ? "border-emerald-500/25 text-emerald-600 dark:text-emerald-400"
    : accent === "warning"
      ? "border-amber-500/30 text-amber-600 dark:text-amber-400"
      : accent === "error"
        ? "border-destructive/30 text-destructive"
        : "border-primary/25 text-primary";
  return (
    <section className={`min-w-0 rounded-lg border bg-muted/10 p-3.5 ${accentClass}`}>
      <div className="mb-3 flex items-center gap-2">
        {icon}
        <h3 className="text-xs font-semibold text-foreground">{title}</h3>
        </div>
      <div className="text-foreground">{children}</div>
    </section>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-3 py-2.5">
      <p className="text-[0.65rem] uppercase tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-0.5 font-mono text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function ObservationList({
  icon,
  title,
  empty,
  items,
}: {
  icon: React.ReactNode;
  title: string;
  empty: string;
  items: Array<{ key: string; title: string; detail: string }>;
}) {
  return (
    <div className="rounded-md border bg-muted/10 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs font-medium">
        {icon} {title}
      </div>
      {items.length > 0 ? (
        <ul className="space-y-2">
          {items.map((item) => (
            <li key={item.key} className="min-w-0">
              <p className="truncate text-xs font-medium">{item.title}</p>
              <p className="truncate text-[0.68rem] text-muted-foreground">{item.detail}</p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">{empty}</p>
      )}
    </div>
  );
}
