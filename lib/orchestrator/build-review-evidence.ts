import type { BuildTask, ReviewResult } from "./build";
import { isRedBuildTask } from "./build-task-phase";

export interface BuildTaskVerificationFact {
  taskId: string;
  wave: number;
  at: string;
  action: string;
  status: "passed" | "failed" | "skipped";
  summary: string;
  coveredPaths: string[];
  /** Optional for legacy checkpoint readability; absent facts are not approval evidence. */
  source?: "worker" | "project_verifier";
  /** Landed-content generation observed when the check actually executed. */
  writeGeneration?: number;
  /** Exact command or typed tool identifier that actually executed. */
  verifierIdentity?: string;
}

export interface BuildReviewContractIssue {
  code:
    | "missing_task_verification"
    | "stale_task_verification"
    | "failed_task_verification"
    | "read_only_task_mutation";
  taskId: string;
  message: string;
}

function reviewResultApproved(result: ReviewResult): boolean {
  return (
    result.specVerdict === "approve" && result.qualityVerdict === "approve"
  );
}

function requestsReadOnlyTaskMutation(instructions: string): boolean {
  const text = instructions.trim();
  if (!text) return false;
  const explicitWriteAction =
    /\b(?:typed\s+)?file\s+edits?\b|\b(?:patch|append|rewrite)\b/i.test(text);
  const mutationNearPath =
    /\b(?:edit|modify|move|remove|merge|change|implement|add|fix)\b[\s\S]{0,140}\b(?:[a-z0-9_.-]+\/)+(?:[a-z0-9_.-]+\.[a-z0-9]+)\b/i.test(
      text
    );
  const projectCommand =
    /\b(?:run|execute)\b[\s\S]{0,120}\b(?:node|npm|pnpm|yarn|bun|pytest|cargo|go|dotnet|gradle|mvn)\b/i.test(
      text
    );
  return explicitWriteAction || mutationNearPath || projectCommand;
}

export function validateReadOnlyReviewFixes(input: {
  tasks: ReadonlyArray<BuildTask>;
  results: ReadonlyArray<ReviewResult>;
}): { valid: boolean; errors: BuildReviewContractIssue[] } {
  const errors: BuildReviewContractIssue[] = [];
  for (const result of input.results) {
    if (reviewResultApproved(result)) continue;
    const task = input.tasks.find((item) => item.id === result.taskId);
    if (
      !task ||
      task.completionMode !== "evidence" ||
      (task.outputPaths?.length ?? 0) > 0 ||
      (task.testOutputPaths?.length ?? 0) > 0
    ) {
      continue;
    }
    if (!requestsReadOnlyTaskMutation(result.fixInstructions ?? "")) continue;
    errors.push({
      code: "read_only_task_mutation",
      taskId: task.id,
      message: `Task ${task.id} is read-only evidence work and cannot be returned with file edits or project commands. Review it only against its declared evidence. If implementation is required, approve or evidence-correct this task and add a separate modify task with explicit outputPaths and tool verification.`,
    });
  }
  return { valid: errors.length === 0, errors };
}

export function appendBuildTaskVerificationFact(
  facts: ReadonlyArray<BuildTaskVerificationFact>,
  fact: BuildTaskVerificationFact,
  maxFacts = 96
): BuildTaskVerificationFact[] {
  return [...facts, {
    ...fact,
    taskId: fact.taskId.trim().slice(0, 80),
    action: fact.action.trim().slice(0, 160),
    verifierIdentity: fact.verifierIdentity?.trim().slice(0, 500),
    summary: fact.summary.replace(/\s+/g, " ").trim().slice(0, 1_200),
    coveredPaths: [...new Set(fact.coveredPaths.map((path) => path.trim()).filter(Boolean))]
      .slice(0, 64),
  }].slice(-Math.max(1, maxFacts));
}

export function discardSupersededTaskVerificationFacts(
  facts: ReadonlyArray<BuildTaskVerificationFact>,
  taskId: string,
  writeWave: number
): BuildTaskVerificationFact[] {
  return facts.filter(
    (fact) => fact.taskId !== taskId || fact.wave >= writeWave
  );
}

export interface BuildTaskVerificationRequirement {
  action: string;
  source?: BuildTaskVerificationFact["source"];
  /** Null means the Architect declared an action class without a concrete identity. */
  verifierIdentity: string | null;
  coveredPaths: string[];
  expectedStatus?: "passed" | "failed";
}

function normalizePath(path: string): string {
  return path.trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

function normalizeIdentity(identity: string): string {
  return identity.trim();
}

function extractQuotedVerifierIdentities(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return [...trimmed.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => !!value);
}

function requirementAction(verifierIdentity: string): string {
  return verifierIdentity.includes(".") && !/\s/.test(verifierIdentity)
    ? verifierIdentity
    : "run";
}

function isTypedToolIdentity(value: string): boolean {
  return /^(?:run|[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*)$/.test(value);
}

export function compileBuildTaskVerificationRequirements(input: {
  task: BuildTask;
  projectVerifier?: string;
  phaseVerification?: ReadonlyArray<string>;
}): BuildTaskVerificationRequirement[] {
  const { task } = input;
  if (task.verificationPolicy !== "tool") return [];
  const redPhase = isRedBuildTask(task);
  const coveredPaths = [...new Set([
    ...(task.outputPaths ?? []),
    ...(task.testOutputPaths ?? []),
  ].map(normalizePath).filter(Boolean))];
  const declared = [...new Set((task.requiredToolActions ?? [])
    .map((action) => action.trim())
    .filter(Boolean))];
  const phaseChecks = (redPhase
    ? []
    : input.phaseVerification ?? task.phaseSpec?.verification ?? [])
    .map((item) => item.trim())
    .filter(Boolean);
  const evidenceChecks = (task.requiredEvidence ?? []).flatMap((item) => {
    const quoted = extractQuotedVerifierIdentities(item);
    if (quoted.length > 0) return quoted;
    const trimmed = item.trim();
    return isTypedToolIdentity(trimmed) ? [trimmed] : [];
  });
  const requirements: BuildTaskVerificationRequirement[] = [];
  for (const verifierIdentity of phaseChecks) {
    const action = requirementAction(verifierIdentity);
    requirements.push({
      action,
      verifierIdentity: verifierIdentity === "run" ? null : verifierIdentity,
      coveredPaths: action === "run" && verifierIdentity !== "run" ? coveredPaths : [],
    });
  }
  for (const verifierIdentity of evidenceChecks) {
    requirements.push({
      action: requirementAction(verifierIdentity),
      verifierIdentity: verifierIdentity === "run" ? null : verifierIdentity,
      coveredPaths: [],
      expectedStatus: redPhase ? "failed" : "passed",
    });
  }
  const acceptedProjectVerifier = input.projectVerifier?.trim();
  if (acceptedProjectVerifier && !redPhase) {
    requirements.push({
      action: "run",
      source: "project_verifier",
      verifierIdentity: acceptedProjectVerifier,
      coveredPaths,
    });
  }
  const objectiveActions = new Set(requirements.map((requirement) => requirement.action));
  for (const action of declared) {
    if (objectiveActions.has(action)) continue;
    requirements.push({
      action,
      verifierIdentity: action === "run" ? null : action,
      coveredPaths: [],
    });
  }
  if (
    !redPhase &&
    coveredPaths.length > 0 &&
    !requirements.some(
      (requirement) =>
        requirement.verifierIdentity !== null &&
        coveredPaths.every((path) => requirement.coveredPaths.includes(path))
    )
  ) {
    requirements.push({
      action: "run",
      source: "project_verifier",
      verifierIdentity: null,
      coveredPaths,
    });
  }
  const seen = new Set<string>();
  return requirements.filter((requirement) => {
    if (
      requirement.source === undefined &&
      requirements.some(
        (candidate) =>
          candidate.source === "project_verifier" &&
          candidate.action === requirement.action &&
          candidate.verifierIdentity === requirement.verifierIdentity &&
          requirement.coveredPaths.every((path) =>
            candidate.coveredPaths.includes(path)
          )
      )
    ) {
      return false;
    }
    const key = `${requirement.action}\u0000${requirement.source ?? ""}\u0000${requirement.verifierIdentity ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function validateBuildReviewApprovals(input: {
  tasks: ReadonlyArray<BuildTask>;
  results: ReadonlyArray<ReviewResult>;
  facts: ReadonlyArray<BuildTaskVerificationFact>;
  wave: number;
  projectVerifier?: string;
}): { valid: boolean; errors: BuildReviewContractIssue[] } {
  const tasksById = new Map(input.tasks.map((task) => [task.id, task]));
  const errors: BuildReviewContractIssue[] = [];
  const seenErrorKeys = new Set<string>();
  const pushError = (
    requirement: BuildTaskVerificationRequirement,
    mismatchKind: string,
    error: BuildReviewContractIssue
  ): void => {
    const key = [
      error.taskId,
      requirement.action,
      requirement.source ?? "",
      requirement.verifierIdentity ?? "<unresolved>",
      mismatchKind,
      error.code,
    ].join("\u0000");
    if (seenErrorKeys.has(key)) return;
    seenErrorKeys.add(key);
    errors.push(error);
  };

  for (const result of input.results) {
    if (result.specVerdict !== "approve" || result.qualityVerdict !== "approve") {
      continue;
    }
    const task = tasksById.get(result.taskId);
    if (!task) continue;

    for (const requirement of compileBuildTaskVerificationRequirements({
      task,
      projectVerifier: input.projectVerifier,
    })) {
      const { action } = requirement;
      const trustedActionFacts = input.facts.filter(
        (fact) =>
          fact.taskId === task.id &&
          fact.action === action &&
          (fact.source === "worker" || fact.source === "project_verifier")
      );
      const sourceFacts = trustedActionFacts.filter(
        (fact) => !requirement.source || fact.source === requirement.source
      );
      const identityFacts = sourceFacts.filter(
        (fact) =>
          requirement.verifierIdentity !== null &&
          normalizeIdentity(fact.verifierIdentity ?? "") ===
            normalizeIdentity(requirement.verifierIdentity)
      );
      const generationFacts = identityFacts.filter(
        (fact) =>
          fact.writeGeneration !== undefined &&
          fact.writeGeneration === (task.writeGeneration ?? 0)
      );
      const coveredFacts = generationFacts.filter((fact) =>
        requirement.coveredPaths.every((path) =>
          fact.coveredPaths.map(normalizePath).includes(path)
        )
      );
      const current = coveredFacts
        .filter((fact) => fact.wave === input.wave)
        .sort((left, right) => left.at.localeCompare(right.at));
      const verifierLabel = `${action} verifier ${JSON.stringify(
        requirement.verifierIdentity ?? "<unresolved>"
      )} (source: ${requirement.source ?? "trusted worker or project verifier"})`;
      if (current.length === 0) {
        const mismatchKind =
          requirement.verifierIdentity === null
            ? "unresolved verifier identity"
            : sourceFacts.length === 0
              ? "missing source fact"
              : identityFacts.length === 0
                ? "verifier identity mismatch"
                : generationFacts.length === 0
                  ? "stale generation"
                  : coveredFacts.length === 0
                    ? "path coverage mismatch"
                    : "stale wave";
        const stale =
          mismatchKind === "stale generation" || mismatchKind === "stale wave";
        pushError(requirement, mismatchKind, {
          code: stale ? "stale_task_verification" : "missing_task_verification",
          taskId: task.id,
          message: `Task ${task.id} approval requires ${verifierLabel}; mismatch: ${mismatchKind}.`,
        });
        continue;
      }
      const expectedStatus = requirement.expectedStatus ?? "passed";
      const latestExpectedIndex = current.findLastIndex(
        (fact) => fact.status === expectedStatus
      );
      const contradictoryStatus =
        expectedStatus === "passed" ? "failed" : "passed";
      const laterContradiction = current.find(
        (fact, index) =>
          fact.status === contradictoryStatus && index > latestExpectedIndex
      );
      if (laterContradiction) {
        pushError(requirement, `unexpected ${contradictoryStatus}`, {
          code: "failed_task_verification",
          taskId: task.id,
          message: `Task ${task.id} approval contradicts current-wave ${verifierLabel}; expected ${expectedStatus}, got ${contradictoryStatus} - ${laterContradiction.summary}`,
        });
      } else if (latestExpectedIndex < 0) {
        pushError(requirement, "skipped", {
          code: "missing_task_verification",
          taskId: task.id,
          message: `Task ${task.id} approval requires a current-wave ${verifierLabel} with status ${expectedStatus}; mismatch: missing or skipped.`,
        });
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export async function resolveBuildReviewContract<T>(input: {
  initialAction: T;
  validate: (action: T) => { valid: boolean; errors: BuildReviewContractIssue[] };
  revise: (
    action: T,
    errors: BuildReviewContractIssue[],
    revision: number
  ) => Promise<T | null>;
  maxRevisions?: number;
}): Promise<
  | { status: "valid"; action: T; revisions: number }
  | {
      status: "blocked";
      action: T;
      revisions: number;
      errors: BuildReviewContractIssue[];
    }
> {
  const maxRevisions = Math.max(0, input.maxRevisions ?? 2);
  let action = input.initialAction;
  let validation = input.validate(action);
  let revisions = 0;

  while (!validation.valid && revisions < maxRevisions) {
    revisions += 1;
    const revised = await input.revise(action, validation.errors, revisions);
    if (revised === null) break;
    action = revised;
    validation = input.validate(action);
  }

  return validation.valid
    ? { status: "valid", action, revisions }
    : { status: "blocked", action, revisions, errors: validation.errors };
}
