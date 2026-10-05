/**
 * IV-1 (CD-23): the worker's durable validation-scope report.
 *
 * A `validationScope` is the submitting worker's own report of what changed,
 * what was verified, which test commands actually ran (with counts), and what
 * was deliberately not run and why. It is a CLAIM, not evidence: these
 * strings and counts never satisfy criterion evidence or turn into green
 * evidence on their own. The existing criterionEvidenceLinks/EvidenceStore
 * remain the only evidence authority; the deliverable reviewer compares this
 * report against the diff, the task's validation rationales, and the durable
 * evidence, and raises ordinary blocking findings when the scope is thin.
 *
 * One canonical type, parser, cloner, and JSON schema live here. The worker
 * tool (`worker-lifecycle-tools.ts`), the change set (`change-set.ts`), and
 * the scheduler kernel (`scheduler-store.ts`) all reuse this module instead
 * of duplicating validation logic.
 */

/** Per-surface bounds: concise labels, never unbounded prose. */
export const VALIDATION_SCOPE_SURFACE_MAX_LENGTH = 500;
export const VALIDATION_SCOPE_SURFACE_MAX_ENTRIES = 50;
/** Exact commands as run can be long; still bounded. */
export const VALIDATION_SCOPE_COMMAND_MAX_LENGTH = 2000;
export const VALIDATION_SCOPE_TEST_RUNS_MAX_ENTRIES = 20;
export const VALIDATION_SCOPE_NOT_RUN_MAX_ENTRIES = 50;

export interface ValidationScopeCounts {
  selected: number;
  passed: number;
  failed: number;
  skipped: number;
}

export interface ValidationScopeTestRun {
  /** Exact command as run, non-empty. */
  command: string;
  counts: ValidationScopeCounts;
}

export interface ValidationScopeNotRun {
  what: string;
  why: string;
}

export interface ValidationScope {
  /** Concise changed/impact surfaces being claimed. */
  changed: string[];
  /** Behavior/surfaces actually verified. */
  verified: string[];
  testsRun: ValidationScopeTestRun[];
  notRun: ValidationScopeNotRun[];
}

/**
 * Conservative validation: arrays required (individually empty is legitimate,
 * but an all-empty scope is meaningless); strings non-empty after trimming
 * and bounded; counts non-negative safe integers with the canonical report
 * invariant `selected === passed + failed + skipped` (the same invariant the
 * JUnit/TRX report readers in `test-report-readers.ts` enforce); a run
 * claiming `selected === 0` is refused because it cannot verify anything; no
 * unknown keys at any level (no freeform hidden authority, no model-only
 * "trust me" flags). Returns a canonical fresh clone with trimmed strings.
 * Throws with a stable message on any violation.
 */
export function parseValidationScope(value: unknown): ValidationScope {
  if (!isRecord(value)) {
    throw new Error("validationScope must be an object.");
  }
  assertKnownKeys(value, ["changed", "verified", "testsRun", "notRun"], "validationScope");
  const changed = parseSurfaceList(value.changed, "validationScope.changed");
  const verified = parseSurfaceList(value.verified, "validationScope.verified");
  const testsRun = parseTestsRun(value.testsRun);
  const notRun = parseNotRun(value.notRun);
  if (
    changed.length === 0 &&
    verified.length === 0 &&
    testsRun.length === 0 &&
    notRun.length === 0
  ) {
    throw new Error(
      "validationScope must describe at least one changed surface, verification, test run, or omission; an all-empty scope is meaningless."
    );
  }
  return { changed, verified, testsRun, notRun };
}

/** Deep clone of trusted validation-scope state. */
export function cloneValidationScope(scope: ValidationScope): ValidationScope {
  return {
    changed: [...scope.changed],
    verified: [...scope.verified],
    testsRun: scope.testsRun.map((run) => ({
      command: run.command,
      counts: { ...run.counts },
    })),
    notRun: scope.notRun.map((entry) => ({ ...entry })),
  };
}

/** Model-facing JSON schema for the `submit_task` validationScope property. */
export function validationScopeJsonSchema(): Record<string, unknown> {
  return {
    type: "object",
    properties: {
      changed: {
        type: "array",
        maxItems: VALIDATION_SCOPE_SURFACE_MAX_ENTRIES,
        items: { type: "string", minLength: 1, maxLength: VALIDATION_SCOPE_SURFACE_MAX_LENGTH },
      },
      verified: {
        type: "array",
        maxItems: VALIDATION_SCOPE_SURFACE_MAX_ENTRIES,
        items: { type: "string", minLength: 1, maxLength: VALIDATION_SCOPE_SURFACE_MAX_LENGTH },
      },
      testsRun: {
        type: "array",
        maxItems: VALIDATION_SCOPE_TEST_RUNS_MAX_ENTRIES,
        items: {
          type: "object",
          properties: {
            command: { type: "string", minLength: 1, maxLength: VALIDATION_SCOPE_COMMAND_MAX_LENGTH },
            counts: {
              type: "object",
              properties: {
                selected: { type: "integer", minimum: 0 },
                passed: { type: "integer", minimum: 0 },
                failed: { type: "integer", minimum: 0 },
                skipped: { type: "integer", minimum: 0 },
              },
              required: ["selected", "passed", "failed", "skipped"],
              additionalProperties: false,
            },
          },
          required: ["command", "counts"],
          additionalProperties: false,
        },
      },
      notRun: {
        type: "array",
        maxItems: VALIDATION_SCOPE_NOT_RUN_MAX_ENTRIES,
        items: {
          type: "object",
          properties: {
            what: { type: "string", minLength: 1, maxLength: VALIDATION_SCOPE_SURFACE_MAX_LENGTH },
            why: { type: "string", minLength: 1, maxLength: VALIDATION_SCOPE_SURFACE_MAX_LENGTH },
          },
          required: ["what", "why"],
          additionalProperties: false,
        },
      },
    },
    required: ["changed", "verified", "testsRun", "notRun"],
    additionalProperties: false,
  };
}

function parseSurfaceList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > VALIDATION_SCOPE_SURFACE_MAX_ENTRIES) {
    throw new Error(
      `${label} must be an array of at most ${VALIDATION_SCOPE_SURFACE_MAX_ENTRIES} entries.`
    );
  }
  return value.map((entry) => {
    if (typeof entry !== "string") {
      throw new Error(`${label} entries must be strings.`);
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0 || trimmed.length > VALIDATION_SCOPE_SURFACE_MAX_LENGTH) {
      throw new Error(
        `${label} entries must be non-empty after trimming and at most ${VALIDATION_SCOPE_SURFACE_MAX_LENGTH} characters.`
      );
    }
    return trimmed;
  });
}

function parseTestsRun(value: unknown): ValidationScopeTestRun[] {
  if (!Array.isArray(value) || value.length > VALIDATION_SCOPE_TEST_RUNS_MAX_ENTRIES) {
    throw new Error(
      `validationScope.testsRun must be an array of at most ${VALIDATION_SCOPE_TEST_RUNS_MAX_ENTRIES} entries.`
    );
  }
  return value.map((entry, index) => {
    const label = `validationScope.testsRun[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${label} must be an object.`);
    }
    assertKnownKeys(entry, ["command", "counts"], label);
    if (typeof entry.command !== "string") {
      throw new Error(`${label}.command must be a string.`);
    }
    const command = entry.command.trim();
    if (command.length === 0 || command.length > VALIDATION_SCOPE_COMMAND_MAX_LENGTH) {
      throw new Error(
        `${label}.command must be non-empty after trimming and at most ${VALIDATION_SCOPE_COMMAND_MAX_LENGTH} characters.`
      );
    }
    return { command, counts: parseCounts(entry.counts, `${label}.counts`) };
  });
}

function parseCounts(value: unknown, label: string): ValidationScopeCounts {
  if (!isRecord(value)) {
    throw new Error(`${label} must be an object.`);
  }
  assertKnownKeys(value, ["selected", "passed", "failed", "skipped"], label);
  const counts: Record<string, number> = {};
  for (const key of ["selected", "passed", "failed", "skipped"] as const) {
    const count = value[key];
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`${label}.${key} must be a non-negative safe integer.`);
    }
    counts[key] = count;
  }
  const { selected, passed, failed, skipped } = counts as unknown as ValidationScopeCounts;
  if (selected !== passed + failed + skipped) {
    throw new Error(
      `${label} is inconsistent: selected (${selected}) must equal passed + failed + skipped (${passed + failed + skipped}).`
    );
  }
  if (selected === 0) {
    throw new Error(
      `${label} claims selected=0, which cannot verify anything; omit the run and explain it in notRun instead.`
    );
  }
  return { selected, passed, failed, skipped };
}

function parseNotRun(value: unknown): ValidationScopeNotRun[] {
  if (!Array.isArray(value) || value.length > VALIDATION_SCOPE_NOT_RUN_MAX_ENTRIES) {
    throw new Error(
      `validationScope.notRun must be an array of at most ${VALIDATION_SCOPE_NOT_RUN_MAX_ENTRIES} entries.`
    );
  }
  return value.map((entry, index) => {
    const label = `validationScope.notRun[${index}]`;
    if (!isRecord(entry)) {
      throw new Error(`${label} must be an object.`);
    }
    assertKnownKeys(entry, ["what", "why"], label);
    const parsed: Record<string, string> = {};
    for (const key of ["what", "why"] as const) {
      const text = entry[key];
      if (typeof text !== "string") {
        throw new Error(`${label}.${key} must be a string.`);
      }
      const trimmed = text.trim();
      if (trimmed.length === 0 || trimmed.length > VALIDATION_SCOPE_SURFACE_MAX_LENGTH) {
        throw new Error(
          `${label}.${key} must be non-empty after trimming and at most ${VALIDATION_SCOPE_SURFACE_MAX_LENGTH} characters.`
        );
      }
      parsed[key] = trimmed;
    }
    return { what: parsed.what!, why: parsed.why! };
  });
}

function assertKnownKeys(
  value: Record<string, unknown>,
  known: readonly string[],
  label: string
): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) {
      throw new Error(`${label} carries an unknown field ${JSON.stringify(key)}; no freeform authority is accepted.`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * IV-1 repair (F1/F2/F3): structural canonical form for durable scope
 * agreement and ReviewKey binding. Sorted arrays only; no model labels or
 * timestamps participate (the scope carries none). Two scopes with the same
 * claimed surfaces, commands, counts, and omissions canonicalize
 * identically even when array order differs; any content change
 * canonicalizes differently.
 */
export function canonicalValidationScope(scope: ValidationScope): ValidationScope {
  const byString = (left: string, right: string): number =>
    left < right ? -1 : left > right ? 1 : 0;
  return {
    changed: [...scope.changed].sort(byString),
    verified: [...scope.verified].sort(byString),
    testsRun: scope.testsRun
      .map((run) => ({
        command: run.command,
        counts: {
          selected: run.counts.selected,
          passed: run.counts.passed,
          failed: run.counts.failed,
          skipped: run.counts.skipped,
        },
      }))
      .sort((left, right) =>
        byString(left.command, right.command) ||
        left.counts.selected - right.counts.selected ||
        left.counts.passed - right.counts.passed ||
        left.counts.failed - right.counts.failed ||
        left.counts.skipped - right.counts.skipped
      ),
    notRun: scope.notRun
      .map((entry) => ({ what: entry.what, why: entry.why }))
      .sort((left, right) => byString(left.what, right.what) || byString(left.why, right.why)),
  };
}

/** Exact canonical equality over the structural canonical form. */
export function validationScopesEqual(left: ValidationScope, right: ValidationScope): boolean {
  return JSON.stringify(canonicalValidationScope(left)) === JSON.stringify(canonicalValidationScope(right));
}

/**
 * IV-1 repair (F2/F3): bidirectional durable agreement. Both-absent stays
 * legacy (undefined); either copy present requires both copies and exact
 * canonical equality, otherwise fail closed. Returns a fresh clone of the
 * scheduler-bound task copy after agreement.
 */
export function agreedValidationScope(
  taskScope: ValidationScope | undefined,
  changeScope: ValidationScope | undefined,
): ValidationScope | undefined {
  if (taskScope === undefined && changeScope === undefined) return undefined;
  if (taskScope === undefined || changeScope === undefined) {
    throw new Error("Submitted validation scope differs from its durable kernel binding.");
  }
  if (!validationScopesEqual(taskScope, changeScope)) {
    throw new Error("Submitted validation scope differs from its durable kernel binding.");
  }
  return cloneValidationScope(taskScope);
}
