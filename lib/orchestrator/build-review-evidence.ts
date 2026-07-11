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
    | "read_only_task_mutation"
    | "out_of_scope_task_fix";
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
  // Running a non-mutating check is normal evidence collection for a read-only
  // task. Do not classify project commands themselves as file mutations; the
  // runner's command policy remains responsible for unsafe command approval.
  return explicitWriteAction || mutationNearPath;
}

const normalizeReviewPath = (value: string): string =>
  value
    .trim()
    .replace(/^[`'"([{]+|[`'".,;:)\]}]+$/g, "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .toLowerCase();

function outOfScopeMutationPaths(
  task: BuildTask,
  instructions: string
): string[] {
  const owned = new Set(
    [...(task.outputPaths ?? []), ...(task.testOutputPaths ?? [])]
      .map(normalizeReviewPath)
      .filter(Boolean)
  );
  if (owned.size === 0) return [];
  const pathPattern = /(?:[a-z0-9_.-]+[\\/])+(?:[a-z0-9_.-]+\.[a-z0-9]+)\b/gi;
  const violations = new Set<string>();
  for (const match of instructions.matchAll(pathPattern)) {
    const path = normalizeReviewPath(match[0]);
    if (!path || owned.has(path)) continue;
    const start = Math.max(0, (match.index ?? 0) - 160);
    const nearby = instructions.slice(start, (match.index ?? 0) + match[0].length);
    if (/\bdo\s+not\s+(?:modify|edit|patch|rewrite|add|create|repair)\b/i.test(nearby)) {
      continue;
    }
    if (
      /\b(?:may|must|should|need\s+to|please)?\s*(?:modify|edit|patch|rewrite|add|create|repair|move|remove|merge|change)\b/i.test(
        nearby
      )
    ) {
      violations.add(path);
    }
  }
  return [...violations];
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
      if (!task) continue;
      const outOfScopePaths = outOfScopeMutationPaths(
        task,
        result.fixInstructions ?? ""
      );
      if (outOfScopePaths.length > 0) {
        errors.push({
          code: "out_of_scope_task_fix",
          taskId: task.id,
          message: `Task ${task.id} review instructions attempt to modify paths outside its immutable output contract: ${outOfScopePaths.join(", ")}. Keep fixes within declared outputPaths/testOutputPaths; create a separate modify task for other files.`,
        });
      }
      continue;
    }
    if (!requestsReadOnlyTaskMutation(result.fixInstructions ?? "")) continue;
    errors.push({
      code: "read_only_task_mutation",
      taskId: task.id,
      message: `Task ${task.id} is read-only evidence work and cannot be returned with file edits. Review it against its declared evidence and allow non-mutating verification commands when evidence is missing. If implementation is required, approve or evidence-correct this task and add a separate modify task with explicit outputPaths and tool verification.`,
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

function splitAndChainedCommands(identity: string): string[] {
  const commands: string[] = [];
  let start = 0;
  let quote = "";
  let escaped = false;
  for (let index = 0; index < identity.length; index++) {
    const char = identity[index] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quote) {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = "";
      continue;
    }
    if (char === '"' || char === "'" || char === "`") {
      quote = char;
      continue;
    }
    if (char === "&" && identity[index + 1] === "&") {
      commands.push(identity.slice(start, index).trim());
      index += 1;
      start = index + 1;
    }
  }
  commands.push(identity.slice(start).trim());
  return commands.filter(Boolean);
}

export function successfulRunIdentityIncludes(
  actualIdentity: string,
  requiredIdentity: string
): boolean {
  const required = normalizeIdentity(requiredIdentity);
  const actual = normalizeIdentity(actualIdentity);
  return (
    actual === required ||
    splitAndChainedCommands(actual).some(
      (component) => normalizeIdentity(component) === required
    )
  );
}

function verifierIdentityMatches(
  fact: BuildTaskVerificationFact,
  requirement: BuildTaskVerificationRequirement
): boolean {
  if (requirement.verifierIdentity === null) return false;
  const required = normalizeIdentity(requirement.verifierIdentity);
  const actual = normalizeIdentity(fact.verifierIdentity ?? "");
  if (actual === required) return true;
  // An exit-0 AND chain proves every component ran successfully. Failed chains
  // are deliberately not decomposed because the failing component is unknown.
  return (
    requirement.action === "run" &&
    fact.status === "passed" &&
    successfulRunIdentityIncludes(actual, required)
  );
}

function extractQuotedVerifierIdentities(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  return [...trimmed.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1]?.trim())
    .filter((value): value is string => !!value && isConcreteVerifierIdentity(value));
}

function requirementAction(verifierIdentity: string): string {
  return verifierIdentity.includes(".") && !/\s/.test(verifierIdentity)
    ? verifierIdentity
    : "run";
}

function isTypedToolIdentity(value: string): boolean {
  return /^(?:run|[a-z][a-z0-9_-]*\.[a-z][a-z0-9_-]*)$/.test(value);
}

function isConcreteVerifierIdentity(value: string): boolean {
  if (isTypedToolIdentity(value)) return true;
  const executable = value.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? "";
  return /^(?:node|npm|npx|pnpm|yarn|bun|deno|python(?:3)?|py|pytest|cargo|go|dotnet|gradle|gradlew|\.\/gradlew|mvn|mvnw|\.\/mvnw|cmake|ctest|make|php|ruby|java|javac|powershell|pwsh|cmd|git)(?:\.exe)?$/.test(
    executable
  );
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
  const declaredPhaseChecks = (redPhase
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
  // Exact verifier identities in requiredEvidence are the task-scoped contract.
  // A phase can intentionally span several serialized tasks, so inheriting every
  // phase verifier here would make an early task depend on checks assigned to
  // future tasks. Fall back to phase verification only when the task does not
  // declare any concrete verifier of its own.
  const phaseChecks = evidenceChecks.length > 0 ? [] : declaredPhaseChecks;
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
    const action = requirementAction(verifierIdentity);
    requirements.push({
      action,
      verifierIdentity: verifierIdentity === "run" ? null : verifierIdentity,
      // A concrete command declared in this task's requiredEvidence is the
      // Architect's task-scoped verifier. Attribute its result to the task's
      // owned files so the compiler does not add a second anonymous project
      // verifier merely to prove the same landed generation again.
      coveredPaths: action === "run" && !redPhase ? coveredPaths : [],
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

export function pendingExpectedFailureVerifierCommands(input: {
  task: BuildTask;
  facts: ReadonlyArray<BuildTaskVerificationFact>;
  wave: number;
  projectVerifier?: string;
}): string[] {
  const writeGeneration = input.task.writeGeneration ?? 0;
  return compileBuildTaskVerificationRequirements({
    task: input.task,
    projectVerifier: input.projectVerifier,
  })
    .filter(
      (requirement) =>
        requirement.action === "run" &&
        requirement.expectedStatus === "failed" &&
        requirement.verifierIdentity !== null
    )
    .map((requirement) => requirement.verifierIdentity!)
    .filter(
      (command) =>
        !input.facts.some(
          (fact) =>
            fact.taskId === input.task.id &&
            fact.wave === input.wave &&
            fact.action === "run" &&
            fact.writeGeneration === writeGeneration &&
            normalizeIdentity(fact.verifierIdentity ?? "") ===
              normalizeIdentity(command)
        )
    );
}

export function buildExpectedFailureEvidenceResponse(input: {
  task: BuildTask;
  facts: ReadonlyArray<BuildTaskVerificationFact>;
  wave: number;
  durableFiles: ReadonlyArray<string>;
  projectVerifier?: string;
}): string {
  if (input.durableFiles.length === 0) return "";
  const writeGeneration = input.task.writeGeneration ?? 0;
  const commands = compileBuildTaskVerificationRequirements({
    task: input.task,
    projectVerifier: input.projectVerifier,
  })
    .filter(
      (requirement) =>
        requirement.action === "run" &&
        requirement.expectedStatus === "failed" &&
        requirement.verifierIdentity !== null
    )
    .map((requirement) => requirement.verifierIdentity!);
  const facts = commands.flatMap((command) => {
    const matching = input.facts
      .filter(
        (fact) =>
          fact.taskId === input.task.id &&
          fact.wave === input.wave &&
          fact.action === "run" &&
          fact.writeGeneration === writeGeneration &&
          normalizeIdentity(fact.verifierIdentity ?? "") ===
            normalizeIdentity(command)
      )
      .sort((left, right) => left.at.localeCompare(right.at));
    const latest = matching.at(-1);
    return latest ? [{ command, fact: latest }] : [];
  });
  if (facts.length !== commands.length || commands.length === 0) return "";
  const verificationLines = facts.map(
    ({ command, fact }) =>
      `- \`${command}\` ${fact.status}: ${fact.summary.slice(0, 1_200)}`
  );
  const failedCommands = facts
    .filter(({ fact }) => fact.status === "failed")
    .map(({ command }) => command);
  return [
    "Task result:",
    `Restored landed output(s) retained without rewrite: ${input.durableFiles.join(", ")}.`,
    "",
    "Verification evidence:",
    ...verificationLines,
    "",
    "Skill evidence:",
    ...(failedCommands.length > 0
      ? [
          `- superpowers:strict-test-driven-development: RED: \`${failedCommands.join("`, `")}\` failed with engine-recorded current-wave output before implementation.`,
        ]
      : [
          "- superpowers:strict-test-driven-development: RED was not observed; the exact verifier did not fail as expected.",
        ]),
    `- superpowers:systematic-debugging: Root cause or reproduction identified before the fix: the exact task verifier produced the current-wave status shown above. Fix verification is not applicable in this RED-only task.`,
    "- agent:security-and-hardening: Trust boundary reviewed and unsafe case considered: the engine used only restored declared local outputs and a non-mutating task verifier; no file rewrite or trust-boundary expansion occurred.",
  ].join("\n");
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
        (fact) => verifierIdentityMatches(fact, requirement)
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
      // Task-scoped shell checks remain valid while the landed write generation
      // is unchanged. Requiring every check in the same recovery wave causes
      // multi-command tasks to alternate forever when a worker gathers only one
      // missing result per turn. Project verifiers and non-shell actions still
      // describe current external state and therefore remain wave-scoped.
      const requiresCurrentWave =
        requirement.source === "project_verifier" || action !== "run";
      const current = coveredFacts
        .filter((fact) => !requiresCurrentWave || fact.wave === input.wave)
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
          message: `Task ${task.id} approval contradicts current landed-generation ${verifierLabel}; expected ${expectedStatus}, got ${contradictoryStatus} - ${laterContradiction.summary}`,
        });
      } else if (latestExpectedIndex < 0) {
        pushError(requirement, "skipped", {
          code: "missing_task_verification",
          taskId: task.id,
          message: `Task ${task.id} approval requires ${requiresCurrentWave ? "a current-wave" : "current landed-generation"} ${verifierLabel} with status ${expectedStatus}; mismatch: missing or skipped.`,
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
