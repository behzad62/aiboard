import type {
  NativeTool,
  ToolAccessRequest,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";
import {
  evidenceFactArtifactHashes,
  type EvidenceRecord,
  type EvidenceStore,
} from "./evidence-store.js";
import {
  FINAL_VERIFICATION_CATEGORIES,
  planFinalVerification,
  type FinalVerificationCategory,
  type FinalVerificationCheck,
  type FinalVerificationPlan,
  type FinalVerificationRepositoryInspection,
  type FinalVerificationStatus,
} from "./final-verification-contracts.js";
import type {
  FinalVerificationBrowserEventsFact,
  FinalVerificationBrowserScreenshotFact,
  FinalVerificationBrowserSnapshotFact,
  FinalVerificationCommandFact,
  FinalVerificationFact,
  FinalVerificationRevisionSource,
  FinalVerificationRun,
} from "./final-verification-runtime.js";

export interface FinalVerificationSubmissionInput {
  plan: unknown;
  run: unknown;
}

export interface FinalVerificationSubmissionOptions {
  evidenceStore: EvidenceStore;
  currentIntegrationRevision?: FinalVerificationRevisionSource;
  /** Compatibility alias for callers that use the runtime option name. */
  integrationRevision?: FinalVerificationRevisionSource;
  /** Optional artifact verification strengthens, but does not replace, evidence-ID checks. */
  artifacts?: ArtifactStore;
  clock?: () => string;
}

export interface FinalVerificationSubmissionCheck {
  category: FinalVerificationCategory;
  status: FinalVerificationStatus;
  green: true;
  rationale?: string;
  repositoryInspection?: FinalVerificationRepositoryInspection;
  evidenceIds: readonly string[];
  facts: readonly FinalVerificationFact[];
}

interface ValidatedSubmissionCheck {
  category: FinalVerificationCategory;
  status: FinalVerificationStatus;
  green: boolean;
  rationale?: string;
  repositoryInspection?: FinalVerificationRepositoryInspection;
  evidenceIds: string[];
  facts: FinalVerificationFact[];
  issues: string[];
}

type ValidatedFinalVerificationRun = FinalVerificationRun & { attempt: number };

/** Mechanical, immutable output. It contains no ChangeSet or completion decision. */
export interface FinalVerificationSubmission {
  kind: "final_verification_submission";
  generationId: string;
  runId: string;
  taskId: string;
  attempt: number;
  targetRevision: string;
  plan: FinalVerificationPlan;
  checks: readonly FinalVerificationSubmissionCheck[];
  evidenceIds: readonly string[];
  submittedAt: string;
  /** Mechanical fact that every required check was green; not semantic completion. */
  green: true;
}

export type FinalVerificationSubmissionToolOptions = FinalVerificationSubmissionOptions;

/**
 * Submit one already-executed verification generation after re-reading the
 * current integration revision and resolving every cited evidence ID.
 */
export async function submitFinalVerification(
  input: FinalVerificationSubmissionInput,
  options: FinalVerificationSubmissionOptions,
): Promise<FinalVerificationSubmission> {
  if (!options || !options.evidenceStore) {
    throw new Error("Final verification submission requires an EvidenceStore.");
  }
  const plan = planFinalVerification(input?.plan);
  const run = validateRun(input?.run);
  const normalizedRunPlan = planFinalVerification(run.plan);
  if (stableJson(normalizedRunPlan) !== stableJson(plan)) {
    throw new Error("Final verification submission plan does not match the generation's exact plan.");
  }
  validateGeneration(run);

  const checks = validateChecks(run, plan);
  const evidenceIds = checks.flatMap((check) => [...check.evidenceIds]);
  assertUnique(evidenceIds, "final verification evidence IDs");

  const records = options.evidenceStore.getByIds({
    runId: run.runId,
    taskId: run.taskId,
    ids: evidenceIds,
  });
  if (records.length !== evidenceIds.length) {
    throw new Error("Final verification submission cites missing or foreign evidence records.");
  }
  const recordsById = new Map(records.map((record) => [record.id, record]));
  for (const check of checks) {
    await validateCheckEvidence(check, run, recordsById, options.artifacts);
  }

  const currentRevision = await readRevision(
    options.currentIntegrationRevision ?? options.integrationRevision,
  );
  if (currentRevision !== run.targetRevision) {
    throw new Error(
      `Final verification submission is stale: target revision ${run.targetRevision} ` +
        `does not match current integration revision ${currentRevision}.`,
    );
  }

  const submittedAt = options.clock?.() ?? new Date().toISOString();
  if (typeof submittedAt !== "string" || !submittedAt.trim()) {
    throw new Error("Final verification submission clock must return a timestamp.");
  }
  return freezeSubmission({
    kind: "final_verification_submission",
    generationId: run.generationId,
    runId: run.runId,
    taskId: run.taskId,
    attempt: run.attempt,
    targetRevision: run.targetRevision,
    plan,
    checks: checks.map((check) => ({
      category: check.category,
      status: check.status,
      green: true,
      ...(check.rationale !== undefined ? { rationale: check.rationale } : {}),
      ...(check.repositoryInspection
        ? { repositoryInspection: cloneInspection(check.repositoryInspection) }
        : {}),
      evidenceIds: [...check.evidenceIds],
      facts: check.facts.map(cloneFact),
    })),
    evidenceIds: [...evidenceIds],
    submittedAt,
    green: true,
  });
}

/** Snake-case lifecycle name required by the Architect contract. */
export async function submit_final_verification(
  input: FinalVerificationSubmissionInput,
  options: FinalVerificationSubmissionOptions,
): Promise<FinalVerificationSubmission> {
  return await submitFinalVerification(input, options);
}

/** JSON-schema surface for the dedicated lifecycle tool. */
export function finalVerificationSubmissionSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      plan: {
        type: "object",
        properties: {
          checks: { type: "array", minItems: FINAL_VERIFICATION_CATEGORIES.length },
        },
        required: ["checks"],
        additionalProperties: false,
      },
      run: {
        type: "object",
        properties: {
          generationId: { type: "string", minLength: 1 },
          runId: { type: "string", minLength: 1 },
          taskId: { type: "string", minLength: 1 },
          attempt: { type: "integer", minimum: 1 },
          plan: { type: "object", required: ["checks"] },
          targetRevision: { type: "string", pattern: "^[a-f0-9]{40,64}$" },
          checks: { type: "array", minItems: FINAL_VERIFICATION_CATEGORIES.length },
          green: { type: "boolean" },
        },
        required: ["generationId", "runId", "taskId", "attempt", "plan", "targetRevision", "checks", "green"],
        additionalProperties: true,
      },
    },
    required: ["plan", "run"],
    additionalProperties: false,
  };
}

/** Expose the contract as a small, read-only lifecycle tool; persistence belongs to later packets. */
export function createSubmitFinalVerificationTool(
  options: FinalVerificationSubmissionToolOptions,
): NativeTool<FinalVerificationSubmissionInput> {
  return {
    definition: {
      name: "submit_final_verification",
      description: "Submit current-generation final verification facts without deciding semantic completion",
      inputSchema: finalVerificationSubmissionSchema(),
      readOnly: true,
      effect: "none",
      lifecycle: true,
    },
    validate: validateSubmissionInput,
    assessAccess: (_input, _context): ToolAccessRequest => ({
      capability: "verification.submit",
      external: false,
    }),
    execute: async (input, context): Promise<ToolExecutionOutput> => {
      const run = asRecord(input.run);
      if (run && run.runId !== context.runId) {
        return failure("verification_run_mismatch", "Final verification run does not belong to this lifecycle run.");
      }
      try {
        const submission = await submitFinalVerification(input, options);
        return { content: [{ type: "json", value: submission }], isError: false };
      } catch (error) {
        return failure(
          "final_verification_rejected",
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  };
}

function validateSubmissionInput(input: unknown): ValidationResult<FinalVerificationSubmissionInput> {
  const value = asRecord(input);
  if (!value || !("plan" in value) || !("run" in value)) {
    return { ok: false, issues: ["Final verification submission requires plan and run."] };
  }
  return { ok: true, value: { plan: value.plan, run: value.run } };
}

function validateRun(value: unknown): ValidatedFinalVerificationRun {
  const run = asRecord(value);
  if (!run) throw new Error("Final verification submission requires a run object.");
  requireString(run.generationId, "generationId");
  requireString(run.runId, "runId");
  requireString(run.taskId, "taskId");
  requireString(run.targetRevision, "targetRevision");
  requireString(run.workspacePath, "workspacePath");
  requireString(run.startedAt, "startedAt");
  requireString(run.finishedAt, "finishedAt");
  if (!run.plan || typeof run.plan !== "object") {
    throw new Error("Final verification submission requires the exact generation plan.");
  }
  if (!isRevision(run.targetRevision)) throw new Error("Final verification targetRevision is invalid.");
  const attempt = run.attempt;
  if (typeof attempt !== "number" || !Number.isSafeInteger(attempt) || attempt < 1) {
    throw new Error("Final verification submission requires a positive attempt identity.");
  }
  if (!Array.isArray(run.checks)) throw new Error("Final verification run requires checks.");
  if (typeof run.green !== "boolean") throw new Error("Final verification run green must be boolean.");
  return run as unknown as ValidatedFinalVerificationRun;
}

function validateGeneration(run: ValidatedFinalVerificationRun): void {
  if (run.generationId.length > 512) throw new Error("Final verification generationId is too long.");
  if (run.runId.length > 256 || run.taskId.length > 256) {
    throw new Error("Final verification run/task identity is too long.");
  }
  if (run.green !== true) throw new Error("Final verification run is not mechanically green.");
}

function validateChecks(
  run: ValidatedFinalVerificationRun,
  plan: FinalVerificationPlan,
): ValidatedSubmissionCheck[] {
  const seen = new Set<string>();
  const checksByCategory = new Map<FinalVerificationCategory, ValidatedSubmissionCheck>();
  for (const candidate of run.checks) {
    const check = asRecord(candidate);
    if (!check || !isCategory(check.category)) {
      throw new Error(`Final verification run contains an unknown check category ${String(check?.category)}.`);
    }
    if (seen.has(check.category)) {
      throw new Error(`Final verification run contains duplicate check category ${check.category}.`);
    }
    seen.add(check.category);
    if (check.status !== "required" && check.status !== "not_applicable") {
      throw new Error(`Final verification check ${check.category} has an unsupported status.`);
    }
    if (typeof check.green !== "boolean") throw new Error(`Final verification check ${check.category} green must be boolean.`);
    if (!Array.isArray(check.evidenceIds) || check.evidenceIds.some((id) => typeof id !== "string" || !id.trim())) {
      throw new Error(`Final verification check ${check.category} requires string evidence IDs.`);
    }
    if (!Array.isArray(check.facts)) throw new Error(`Final verification check ${check.category} requires facts.`);
    if (!Array.isArray(check.issues) || check.issues.some((issue) => typeof issue !== "string")) {
      throw new Error(`Final verification check ${check.category} requires issue facts.`);
    }
    if (check.rationale !== undefined && (typeof check.rationale !== "string" || !check.rationale.trim())) {
      throw new Error(`Final verification check ${check.category} has an invalid rationale.`);
    }
    if (check.repositoryInspection !== undefined && !asRecord(check.repositoryInspection)) {
      throw new Error(`Final verification check ${check.category} has invalid repository inspection.`);
    }
    const normalized: ValidatedSubmissionCheck = {
      category: check.category,
      status: check.status,
      green: check.green,
      ...(typeof check.rationale === "string" ? { rationale: check.rationale } : {}),
      ...(check.repositoryInspection !== undefined
        ? { repositoryInspection: check.repositoryInspection as FinalVerificationRepositoryInspection }
        : {}),
      evidenceIds: [...check.evidenceIds] as string[],
      facts: [...check.facts] as FinalVerificationFact[],
      issues: [...check.issues],
    };
    checksByCategory.set(check.category, normalized);
  }
  if (run.checks.length !== FINAL_VERIFICATION_CATEGORIES.length) {
    throw new Error("Final verification run must represent each of the four categories exactly once.");
  }
  const result: ValidatedSubmissionCheck[] = [];
  for (const planned of plan.checks) {
    const check = checksByCategory.get(planned.category);
    if (!check) throw new Error(`Final verification run is missing category ${planned.category}.`);
    const projection = projectCheck(check);
    if (stableJson(projection) !== stableJson(planned)) {
      throw new Error(`Final verification check ${planned.category} does not match the exact plan.`);
    }
    const issues = check.issues;
    if (check.status === "not_applicable") {
      if (check.green !== true || issues.length > 0 || check.evidenceIds.length > 0 || check.facts.length > 0) {
        throw new Error(`Not-applicable final verification category ${check.category} carries executable result evidence.`);
      }
    } else {
      if (check.green !== true || issues.length > 0) {
        throw new Error(`Required final verification category ${check.category} is not mechanically green.`);
      }
      if (check.evidenceIds.length === 0 || check.facts.length === 0) {
        throw new Error(`Required final verification category ${check.category} is missing evidence.`);
      }
    }
    result.push(check);
  }
  return result;
}

async function validateCheckEvidence(
  check: ValidatedSubmissionCheck,
  run: ValidatedFinalVerificationRun,
  recordsById: ReadonlyMap<string, EvidenceRecord>,
  artifacts: ArtifactStore | undefined,
): Promise<void> {
  const facts = check.facts;
  if (check.status === "not_applicable") return;
  if (facts.length !== check.evidenceIds.length) {
    throw new Error(`Final verification category ${check.category} has mismatched facts and evidence citations.`);
  }
  const browserKinds = new Set<string>();
  for (const [index, fact] of facts.entries()) {
    const evidenceId = check.evidenceIds[index];
    const record = recordsById.get(evidenceId);
    if (!record) throw new Error(`Final verification evidence ${evidenceId} is missing.`);
    if (record.runId !== run.runId || record.taskId !== run.taskId || record.attempt !== run.attempt) {
      throw new Error(`Final verification evidence ${evidenceId} is foreign to this generation/task/attempt.`);
    }
    if (record.status !== "observed" || !record.idempotencyKey.startsWith(`${run.generationId}:`)) {
      throw new Error(`Final verification evidence ${evidenceId} is not authoritative current-generation evidence.`);
    }
    if (stableJson(record.fact) !== stableJson(fact)) {
      throw new Error(`Final verification evidence ${evidenceId} does not match the cited authoritative fact.`);
    }
    validateFact(fact, check.category, run.targetRevision);
    if (fact.kind.startsWith("browser_")) browserKinds.add(fact.kind);
    if (artifacts) {
      for (const hash of evidenceFactArtifactHashes(fact)) await artifacts.verify(hash);
    }
  }
  if (check.category === "browser") {
    const requiredKinds = new Set(["browser_snapshot", "browser_screenshot", "browser_events"]);
    if (browserKinds.size !== requiredKinds.size || [...requiredKinds].some((kind) => !browserKinds.has(kind))) {
      throw new Error("Required browser verification is missing snapshot, screenshot, or event evidence.");
    }
  }
}

function validateFact(
  fact: FinalVerificationFact,
  category: FinalVerificationCategory,
  targetRevision: string,
): void {
  const value = asRecord(fact);
  if (!value) throw new Error(`Final verification ${category} evidence fact is invalid.`);
  const factCategory = value.category;
  if (factCategory !== category) throw new Error(`Final verification evidence fact category does not match ${category}.`);
  if (category === "build" || category === "tests" || category === "runtime_smoke") {
    if (fact.kind !== "command") throw new Error(`Final verification ${category} requires command evidence.`);
    const command = fact as FinalVerificationCommandFact;
    if (command.repositoryRevision !== targetRevision || command.targetRevision !== targetRevision) {
      throw new Error(`Final verification ${category} evidence targets a stale revision.`);
    }
    if (command.startState.revision !== targetRevision || command.endState.revision !== targetRevision) {
      throw new Error(`Final verification ${category} evidence crossed a revision boundary.`);
    }
    if (command.timedOut || command.cancelled || command.outputTruncated) {
      throw new Error(`Final verification ${category} evidence contains timeout, cancellation, or truncation.`);
    }
    if (category === "runtime_smoke") {
      if (command.exitCode !== null && command.exitCode !== 0) {
        throw new Error("Final verification runtime_smoke evidence exited non-zero.");
      }
      if (command.readinessSatisfied !== true) {
        throw new Error("Final verification runtime_smoke evidence lacks readiness proof.");
      }
    } else if (command.exitCode !== 0 || command.signal !== null) {
      throw new Error(`Final verification ${category} evidence did not exit cleanly.`);
    }
    if (!command.stdoutArtifactHash || !command.stderrArtifactHash) {
      throw new Error(`Final verification ${category} is missing command output artifacts.`);
    }
    return;
  }
  if (fact.kind === "browser_snapshot") {
    const snapshot = fact as FinalVerificationBrowserSnapshotFact;
    validateBrowserState(snapshot, targetRevision);
    if (!snapshot.url || !snapshot.htmlArtifactHash || snapshot.truncated || snapshot.htmlBytes < 1) {
      throw new Error("Final verification browser snapshot evidence is missing or truncated.");
    }
    return;
  }
  if (fact.kind === "browser_screenshot") {
    const screenshot = fact as FinalVerificationBrowserScreenshotFact;
    validateBrowserState(screenshot, targetRevision);
    if (!screenshot.url || !screenshot.screenshotArtifactHash || screenshot.mediaType !== "image/png" || screenshot.byteLength < 1) {
      throw new Error("Final verification browser screenshot evidence is missing.");
    }
    return;
  }
  if (fact.kind !== "browser_events") throw new Error("Final verification browser evidence has an unsupported kind.");
  const events = fact as FinalVerificationBrowserEventsFact;
  validateBrowserState(events, targetRevision);
  if (!events.url || !events.eventsArtifactHash || events.timedOut || events.cancelled || events.policyViolations.length > 0) {
    throw new Error("Final verification browser events contain missing evidence or policy violations.");
  }
  if (events.consoleErrors.length !== events.consoleErrorCount || events.failedNetworkEvents.length !== events.networkFailureCount) {
    throw new Error("Final verification browser event counts do not match captured failures.");
  }
}

function validateBrowserState(
  fact: FinalVerificationBrowserSnapshotFact | FinalVerificationBrowserScreenshotFact | FinalVerificationBrowserEventsFact,
  targetRevision: string,
): void {
  if (fact.category !== "browser" || fact.targetRevision !== targetRevision || fact.startState.revision !== targetRevision || fact.endState.revision !== targetRevision) {
    throw new Error("Final verification browser evidence targets a stale or changed revision.");
  }
}

function projectCheck(check: ValidatedSubmissionCheck): FinalVerificationCheck {
  return {
    category: check.category,
    status: check.status,
    ...(check.rationale !== undefined ? { rationale: check.rationale } : {}),
    ...(check.repositoryInspection !== undefined
      ? { repositoryInspection: check.repositoryInspection }
      : {}),
  };
}

async function readRevision(source: FinalVerificationRevisionSource | undefined): Promise<string> {
  if (source === undefined) throw new Error("Final verification submission requires current integration revision.");
  const value = typeof source === "function" ? await source() : source;
  if (!isRevision(value)) throw new Error("Current integration revision is invalid.");
  return value;
}

function freezeSubmission(value: FinalVerificationSubmission): FinalVerificationSubmission {
  return deepFreeze(cloneValue(value)) as FinalVerificationSubmission;
}

function cloneInspection(inspection: FinalVerificationRepositoryInspection): FinalVerificationRepositoryInspection {
  return {
    paths: [...inspection.paths],
    summary: inspection.summary,
    ...(inspection.detectedSignals
      ? { detectedSignals: inspection.detectedSignals.map((signal) => ({ ...signal })) }
      : {}),
  };
}

function cloneFact(fact: FinalVerificationFact): FinalVerificationFact {
  return cloneValue(fact);
}

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map((item) => cloneValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, cloneValue(item)]),
    ) as T;
  }
  return value;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortValue(item)]),
    );
  }
  return value;
}

function assertUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`${label} must not contain duplicates.`);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Final verification ${label} is required.`);
}

function isCategory(value: unknown): value is FinalVerificationCategory {
  return typeof value === "string" && (FINAL_VERIFICATION_CATEGORIES as readonly string[]).includes(value);
}

function isRevision(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{40,64}$/.test(value.trim());
}

function failure(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message, issues: [message] },
  };
}
