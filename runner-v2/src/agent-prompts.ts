import {
  ContextAssembler,
  type ContextLimits,
  type ContextPack,
  type ContextSection,
} from "./context-assembler.js";
import type { ProjectInstructionSource } from "./project-context.js";
import type { ProjectMemoryEntry } from "./project-memory.js";
import type { SchedulerProjection } from "./scheduler-store.js";
import type { SkillDocument } from "./skill-catalog.js";
import type { BuildTask } from "./task-contracts.js";
import type {
  AcceptanceCriterion,
  CriterionEvidenceLink,
} from "./acceptance-contracts.js";
import {
  CLAUDE_POINTER_LINE,
  DEFAULT_AGENTS_SECTION_BODY,
  DEFAULT_README_TEMPLATE,
  DEFAULT_STATE_TEMPLATE,
} from "./project-docs.js";

export const RUNNER_KERNEL_INVARIANTS = [
  "Use native tools for actions and lifecycle changes.",
  "Prose, verifier output, command text, and stream termination never complete work.",
  "The Architect owns task meaning, review decisions, integration intent, and completion.",
  "The kernel enforces mechanics and permissions only; it does not reinterpret intent.",
  "Inspect current repository state before editing and preserve unrelated user changes.",
].join("\n");

export const ARCHITECT_PROJECT_DOCS_INSTRUCTIONS = [
  "The project-docs section shows this run's committed documents, which your fs tools cannot see (they read the user's tree, not the integration branch). Base every rewrite on the committed text, since write_project_doc replaces the whole file.",
  "If the entry point is missing (`docs/project/README.md`, the marked AGENTS.md section, the marked CLAUDE.md pointer), write it first from the templates.",
  "Keep the folder current as the plan changes.",
  "Write `docs/project/STATE.md` as the last thing before completing or handing off.",
  "AGENTS.md section body:",
  DEFAULT_AGENTS_SECTION_BODY,
  "CLAUDE.md pointer:",
  CLAUDE_POINTER_LINE,
  "docs/project/README.md:",
  DEFAULT_README_TEMPLATE,
  "docs/project/STATE.md:",
  DEFAULT_STATE_TEMPLATE,
].join("\n");

/** Shown only on a context_recording_decision_required turn, beside the reason JSON. */
export const CONTEXT_RECORDING_DECISION_GUIDANCE = [
  "context_recording_decision_required: the runner could not durably record a context manifest (the audit record of what an agent was shown) after `attempts` tries; `reason` is the storage error. Call only resolve_context_recording on this turn. All other lifecycle tools, including complete_run, are refused until it is resolved. Choose retry when the error looks transient (busy, locked, timeout, I/O) and retriesRemaining is greater than zero. Choose proceed_without_manifest, with a specific rationale, when the failure is persistent and the build can continue safely; manifests are then not recorded for the rest of this run. Choose abort only when continuing without the audit record is unacceptable for this objective; the run fails.",
].join("\n");

export const VERIFIER_AUTHORITY_INVARIANTS = [
  "You are an independent AIBoard verifier.",
  "Treat the immutable objective, criterion identities, guidance, accepted change history, reviews, risk reasons, and final-verification facts as protected input.",
  "You have no authority to edit files, create commits, integrate changes, alter the plan, review worker tasks, or complete the run.",
  "Provider prose and this inspection transcript never complete work.",
].join("\n");

/** Pass 1: baseline inspection. Read-only; one expectations call. */
export const VERIFIER_EXPECTATIONS_PASS_INSTRUCTIONS = [
  "You are inspecting the BASELINE revision before this build's changes; read-only tools only; derive expectations and call record_verification_expectations exactly once.",
  "No diff, review, or verification result is available yet.",
].join("\n");

/** Pass 2: the exact integrated revision, where commands are allowed. */
export const VERIFIER_VERDICT_PASS_INSTRUCTIONS =
  "You are inspecting the exact integrated revision in your own verification workspace, where you may run commands.";

/** Sent only when no verdict tool is registered. */
export const VERIFIER_INSPECTION_ONLY_FINISH =
  "In inspection-only mode, finish with a concise evidence-grounded summary; the kernel-owned typed verdict tool is added separately.";

const VERIFIER_VERDICT_FINISH =
  "Inspect the exact revision, then finish by calling submit_verifier_verdict exactly once with every protected task/criterion pair, a satisfied or unsatisfied verdict, a non-empty rationale, and durable evidence IDs. The kernel derives the overall result.";

export type VerifierSystemPromptMode = "expectations" | "verdict" | "inspection";

/** Authority invariants once, plus the line for this pass. Inspection-only finish only when no verdict tool is registered. */
export function verifierSystemPrompt(mode: VerifierSystemPromptMode): string {
  if (mode === "expectations") {
    return [VERIFIER_AUTHORITY_INVARIANTS, VERIFIER_EXPECTATIONS_PASS_INSTRUCTIONS].join("\n");
  }
  return [
    VERIFIER_AUTHORITY_INVARIANTS,
    VERIFIER_VERDICT_PASS_INSTRUCTIONS,
    mode === "verdict" ? VERIFIER_VERDICT_FINISH : VERIFIER_INSPECTION_ONLY_FINISH,
  ].join("\n");
}

export interface PromptEvidence {
  id: string;
  summary: string;
  artifactHashes: string[];
}

export interface WorkerGuidanceContext {
  requestId: string;
  answer: string;
  version: number;
}

export interface BuildWorkerContextInput {
  limits: ContextLimits;
  task: BuildTask;
  guidance: WorkerGuidanceContext[];
  instructions: ProjectInstructionSource[];
  skills: SkillDocument[];
  memories: ProjectMemoryEntry[];
  repositorySnapshot: string;
  evidence: PromptEvidence[];
  recentHistory: string[];
  pendingToolResults?: string[];
}

export function buildWorkerContext(input: BuildWorkerContextInput): ContextPack {
  return new ContextAssembler(input.limits).assemble(workerContextSections(input));
}

export function workerContextSections(input: BuildWorkerContextInput): ContextSection[] {
  const sections: ContextSection[] = [
    required("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
    required("current-task", "task", JSON.stringify(input.task, null, 2)),
  ];
  if (input.guidance.length > 0) {
    sections.push(
      required("architect-guidance", "guidance", JSON.stringify(input.guidance, null, 2))
    );
  }
  for (const [index, result] of (input.pendingToolResults ?? []).entries()) {
    sections.push(required(`pending-tool-${index + 1}`, "tool-result", result));
  }
  for (const instruction of input.instructions) {
    sections.push({
      id: `instruction:${instruction.relativePath}`,
      kind: "instructions",
      required: false,
      priority: 900,
      sourceDigest: instruction.digest,
      content: `Source: ${instruction.relativePath}\nScope: ${instruction.scopeDirectory || "."}\n${instruction.content}`,
    });
  }
  for (const skill of input.skills) {
    sections.push({
      id: `skill:${skill.id}`,
      kind: "skill",
      required: false,
      priority: 800,
      sourceDigest: skill.digest,
      content: `Source: ${skill.relativePath}\n${skill.content}`,
    });
  }
  for (const memory of input.memories) {
    sections.push({
      id: `memory:${memory.id}`,
      kind: "memory",
      required: false,
      priority: 700,
      content: `Memory ID: ${memory.id}\nConcepts: ${memory.concepts.join(", ")}\n${memory.content}`,
    });
  }
  if (input.repositorySnapshot) {
    sections.push(optional("repository-snapshot", "repository", 600, input.repositorySnapshot));
  }
  for (const evidence of input.evidence) {
    sections.push({
      id: `evidence:${evidence.id}`,
      kind: "evidence",
      required: false,
      priority: 500,
      artifactHash: evidence.artifactHashes[0],
      content: `Evidence ID: ${evidence.id}\nArtifacts: ${evidence.artifactHashes.join(", ")}\n${evidence.summary}`,
    });
  }
  for (const [index, history] of input.recentHistory.entries()) {
    sections.push(optional(`history:${index + 1}`, "history", 100, history));
  }
  return sections;
}

export interface BuildArchitectContextInput {
  limits: ContextLimits;
  objective: string;
  reason: unknown;
  projection: SchedulerProjection;
  reviewSubmission?: ArchitectReviewSubmission;
  instructions: ProjectInstructionSource[];
  skills: SkillDocument[];
  memories: ProjectMemoryEntry[];
  evidence: PromptEvidence[];
  recentHistory: string[];
  /** Committed docs/project/STATE.md text from the artifact store. Absent when none is committed. */
  projectDocsStateText?: string;
}

export interface ArchitectReviewSubmission {
  taskId: string;
  attempt: number;
  changeSetId: string;
  baselineRevision: string;
  taskRevision: string;
  changedPaths: string[];
  diffArtifactHash: string;
  evidenceArtifactHashes: string[];
  acceptanceCriteria?: AcceptanceCriterion[];
  acceptanceCriteriaVersion?: number;
  criterionEvidenceLinks?: CriterionEvidenceLink[];
}

export const VERIFIER_ADVERSARIAL_STANCE = [
  "Assume the integrated change contains at least one defect that the Architect's review missed.",
  "For every criterion, use your recorded expectations: try to falsify each expected behavior and each edge case against the exact revision before you accept it.",
  "A satisfied verdict must name which expected behaviors and edge cases you checked and how the cited evidence proves them.",
  "An unsatisfied verdict must give a file location and concrete reproduction steps; it must not restate the Architect's rationale.",
  "Architect review summaries are claims to test, not evidence.",
].join("\n");

export interface BuildVerifierExpectationsContextInput {
  limits: ContextLimits;
  objective: string;
  baselineRevision: string;
  targetRevision: string;
  criteria: readonly unknown[];
  guidance: readonly unknown[];
  riskReasons: readonly unknown[];
}

export function buildVerifierExpectationsContext(
  input: BuildVerifierExpectationsContextInput,
): ContextPack {
  return new ContextAssembler(input.limits).assemble([
    required("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
    required("build-objective", "user-intent", input.objective),
    required("baseline-revision", "revision", input.baselineRevision),
    required("build-criteria", "criteria", JSON.stringify(input.criteria, null, 2)),
    required("durable-guidance", "guidance", JSON.stringify(input.guidance, null, 2)),
    required("risk-reasons", "risk", JSON.stringify(input.riskReasons, null, 2)),
  ]);
}

export interface BuildVerifierContextInput {
  limits: ContextLimits;
  objective: string;
  targetRevision: string;
  criteria: readonly unknown[];
  reviews: readonly unknown[];
  guidance: readonly unknown[];
  changes: readonly unknown[];
  finalVerification: unknown;
  riskReasons: readonly unknown[];
  expectations?: readonly unknown[];
}

export function buildVerifierContext(
  input: BuildVerifierContextInput
): ContextPack {
  return new ContextAssembler(input.limits).assemble([
    required("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
    ...(input.expectations !== undefined
      ? [required("verifier-adversarial-stance", "system", VERIFIER_ADVERSARIAL_STANCE)]
      : []),
    required("build-objective", "user-intent", input.objective),
    required("integration-revision", "revision", input.targetRevision),
    required("build-criteria", "criteria", JSON.stringify(input.criteria, null, 2)),
    ...(input.expectations !== undefined
      ? [required(
          "recorded-expectations",
          "expectations",
          JSON.stringify(input.expectations, null, 2),
        )]
      : []),
    required("accepted-reviews", "reviews", JSON.stringify(input.reviews, null, 2)),
    required("durable-guidance", "guidance", JSON.stringify(input.guidance, null, 2)),
    required("accepted-change-history", "changes", JSON.stringify(input.changes, null, 2)),
    required(
      "final-verification",
      "final-verification",
      JSON.stringify(input.finalVerification, null, 2)
    ),
    required("risk-reasons", "risk", JSON.stringify(input.riskReasons, null, 2)),
  ]);
}

export const PLAN_CRITIC_INVARIANTS = [
  "You are an independent AIBoard plan critic inspecting one task graph before any worker starts.",
  "The repository you can read is the exact baseline revision; nothing has been implemented yet.",
  "Assume the plan contains at least one defect. For every task ask: is each criterion objectively testable; do tasks overlap in file ownership; are dependencies complete and acyclic in meaning, not just in graph shape; which failure modes are omitted; which assumptions about the repository are unproven (check them with the read-only tools); is any task too large for one worker; can each task be verified independently; is the wiring that connects separately built parts (registration, entry points, configuration) owned by some task? (Merging branches is the runner's job, not a task.)",
  "A blocking finding must cite concrete evidence: a criterion text, a file path, a symbol, or a dependency pair. Advisory findings record concerns that do not stop implementation.",
  "You have no authority to edit files, change the plan, assign work, or complete the run. Finish by calling submit_plan_critique exactly once.",
].join("\n");

export interface BuildPlanCritiqueContextInput {
  limits: ContextLimits;
  objective: string;
  planRevision: number;
  baselineRevision: string;
  tasks: readonly unknown[];
  riskReasons: readonly unknown[];
  guidance: readonly unknown[];
}

export function buildPlanCritiqueContext(input: BuildPlanCritiqueContextInput): ContextPack {
  return new ContextAssembler(input.limits).assemble([
    required("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
    required("build-objective", "user-intent", input.objective),
    required("baseline-revision", "revision", `${input.baselineRevision} (plan revision ${input.planRevision})`),
    required("task-graph", "task-graph", JSON.stringify(input.tasks, null, 2)),
    required("risk-reasons", "risk", JSON.stringify(input.riskReasons, null, 2)),
    required("durable-guidance", "guidance", JSON.stringify(input.guidance, null, 2)),
  ]);
}

export function buildArchitectContext(
  input: BuildArchitectContextInput
): ContextPack {
  return new ContextAssembler(input.limits).assemble(architectContextSections(input));
}

export function architectContextSections(
  input: BuildArchitectContextInput,
): ContextSection[] {
  const sections: ContextSection[] = [
    required("kernel-invariants", "system", RUNNER_KERNEL_INVARIANTS),
    required("project-documentation", "system", ARCHITECT_PROJECT_DOCS_INSTRUCTIONS),
    required("project-docs", "project-docs", renderArchitectProjectDocs(input)),
    required("build-objective", "user-intent", input.objective),
    required("architect-action", "architect", architectActionContent(input.reason)),
    required(
      "task-graph",
      "task-graph",
      JSON.stringify(
        {
          status: input.projection.status,
          initialObjective: input.projection.initialObjective ?? input.objective,
          planRevision: input.projection.planRevision,
          tasks: input.projection.tasks,
          guidance: input.projection.guidance,
          userGuidance: input.projection.userGuidance,
          userGuidanceVersion: input.projection.userGuidanceVersion,
          architectQuestions: input.projection.architectQuestions,
          architectQuestionVersion: input.projection.architectQuestionVersion,
          blockingArchitectQuestionId: input.projection.blockingArchitectQuestionId ?? null,
          reviews: input.projection.reviews,
          integrationRevision: input.projection.integrationRevision,
          finalVerification: input.projection.finalVerification ?? null,
        },
        null,
        2
      )
    ),
  ];
  if (input.reviewSubmission) {
    sections.push(
      required(
        "current-submission",
        "current-submission",
        [
          "Review this immutable submitted attempt, not a prior attempt or the project working tree.",
          "Use artifact.read with diffArtifactHash for the authoritative submitted diff.",
          JSON.stringify(input.reviewSubmission, null, 2),
        ].join("\n")
      )
    );
  }
  for (const instruction of input.instructions) {
    sections.push({
      id: `instruction:${instruction.relativePath}`,
      kind: "instructions",
      required: false,
      priority: 900,
      sourceDigest: instruction.digest,
      content: `Source: ${instruction.relativePath}\n${instruction.content}`,
    });
  }
  for (const skill of input.skills) {
    sections.push({
      id: `skill:${skill.id}`,
      kind: "skill",
      required: false,
      priority: 800,
      sourceDigest: skill.digest,
      content: `Source: ${skill.relativePath}\n${skill.content}`,
    });
  }
  for (const memory of input.memories) {
    sections.push(optional(`memory:${memory.id}`, "memory", 700, memory.content));
  }
  for (const evidence of input.evidence) {
    sections.push({
      id: `evidence:${evidence.id}`,
      kind: "evidence",
      required: false,
      priority: 750,
      artifactHash: evidence.artifactHashes[0],
      content: `${evidence.summary}\nArtifacts: ${evidence.artifactHashes.join(", ")}`,
    });
  }
  for (const [index, history] of input.recentHistory.entries()) {
    sections.push(optional(`history:${index + 1}`, "history", 100, history));
  }
  return sections;
}

function required(id: string, kind: string, content: string): ContextSection {
  return { id, kind, required: true, priority: 1000, content };
}

const PROJECT_DOCS_STATE_TEXT_CAP_BYTES = 4096;

function architectActionContent(reason: unknown): string {
  const body = JSON.stringify(reason, null, 2);
  if (!isReasonType(reason, "context_recording_decision_required")) return body;
  return `${CONTEXT_RECORDING_DECISION_GUIDANCE}\n${body}`;
}

function renderArchitectProjectDocs(input: BuildArchitectContextInput): string {
  const committed = [...(input.projection.projectDocs?.committed ?? [])]
    .sort((left, right) => left.sequence - right.sequence);
  const abandoned = [...(input.projection.projectDocs?.abandoned ?? [])]
    .sort((left, right) => left.sequence - right.sequence);
  const latest = committed.at(-1);
  const stateCommit = [...committed].reverse().find((commit) => commit.path === "docs/project/STATE.md");
  const lines = [
    `stateCurrent: ${projectDocsStateCurrent(input.projection)}`,
    `entryPoint: readme=${latest?.readme ?? false} agentsMarkedSection=${latest?.agentsMarkedSection ?? false} claudePointer=${latest?.claudePointer ?? false}`,
    "committed:",
    ...(committed.length === 0
      ? ["(none)"]
      : committed.map((commit) => `${commit.path} sequence=${commit.sequence}`)),
  ];
  if (abandoned.length > 0) {
    lines.push("abandoned:");
    for (const item of abandoned) {
      lines.push(`${item.path} sequence=${item.sequence} ${item.reason}`);
    }
  }
  lines.push("STATE.md:");
  if (!stateCommit) lines.push("(not committed)");
  else if (input.projectDocsStateText === undefined) lines.push("(committed text unavailable)");
  else lines.push(capProjectDocsStateText(input.projectDocsStateText));
  return lines.join("\n");
}

function projectDocsStateCurrent(projection: SchedulerProjection): boolean {
  const state = [...(projection.projectDocs?.committed ?? [])]
    .filter((commit) => commit.path === "docs/project/STATE.md")
    .sort((left, right) => left.sequence - right.sequence)
    .at(-1);
  if (!state) return false;
  if (projection.latestIntegratedTaskSequence === undefined) return true;
  return state.sequence > projection.latestIntegratedTaskSequence;
}

function capProjectDocsStateText(text: string): string {
  if (Buffer.byteLength(text, "utf8") <= PROJECT_DOCS_STATE_TEXT_CAP_BYTES) return text;
  let end = text.length;
  while (end > 0 && Buffer.byteLength(text.slice(0, end), "utf8") > PROJECT_DOCS_STATE_TEXT_CAP_BYTES) {
    end -= 1;
  }
  return `${text.slice(0, end)}\n[truncated]`;
}

function isReasonType(reason: unknown, type: string): boolean {
  return typeof reason === "object" && reason !== null && !Array.isArray(reason) &&
    (reason as { type?: unknown }).type === type;
}

function optional(
  id: string,
  kind: string,
  priority: number,
  content: string
): ContextSection {
  return { id, kind, required: false, priority, content };
}
