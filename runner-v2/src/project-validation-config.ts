/**
 * IV-3 (CD-23): the ONE explicit revision-bound project validation config.
 *
 * Filename (repository root, relative to the inspected checkout):
 *   `aiboard-validation.json`
 *
 * Cross-language JSON schema (all keys strict, no unknown keys):
 *   {
 *     "version": 1 | 2,
 *     "validationBudgetMs": 600000,        // optional advisory per-task budget
 *     "tiers": {                            // optional tier -> commands map
 *       "fast":        [{ "label": "...", "executable": "...", "args": [...] }],
 *       "component":   [...],
 *       "integration": [...],
 *       "slow":        [...],
 *       "release":     [...]
 *     },
 *     "checks": [                           // version 2 only (VF4)
 *       { "id": "typecheck", "label": "...", "kind": "build" | "tests" | "start" | "other",
 *         "mandatory": true,
 *         "run": { "executable": "...", "args": [...], "cwd"?: "...", "timeoutMs"?: 1 },
 *         // or "start": { "executable", "args", "timeoutMs"?,
 *         //   "ready": { "http": { "path", "status" } } | { "outputLine" } | { "exitCode" },
 *         //   "steps"?: [{ "label", "executable", "args", "timeoutMs"?, "outputs"? }] },
 *         "outputs"?: [...], "environment"?: { "NAME": "value" } }   // environment: run checks only
 *     ]
 *   }
 *
 * - `version` is 1 or 2. A version-1 file reads exactly as before VF4; `checks`
 *   needs version 2. A newer version fails closed and asks for a newer Runner.
 *   Unknown top-level keys, unknown tier keys, empty tier arrays, shell command
 *   strings, and out-of-bound values fail closed.
 * - `checks` (VF4) are the project's own final checks, in the verification plan's
 *   check shape (verification-plan-v2.ts) with `mandatory`, which only this file
 *   sets. They become the Runner's suggested checks with origin `project`. When a
 *   project declares checks they are the whole suggestion list: what the Runner
 *   detects is a fallback for a project that declares none. The tiers keep
 *   driving the per-task boundary as before. A `start` server is ready on HTTP on
 *   the Runner-leased port, which its args take as {port}.
 * - `validationBudgetMs` is an advisory per-task wall-clock budget for
 *   worker `run_evidence_command` time plus integrated delivery-boundary
 *   time. Default {@link DEFAULT_VALIDATION_BUDGET_MS}. It never hard-fails
 *   correct work and never routes through BudgetExceededError/maxActiveMs.
 * - `tiers` maps a subset of the canonical tiers (see
 *   final-verification-contracts.ts VALIDATION_TIERS) to one or more exact
 *   executable+args commands. Missing config/map means no profile field and
 *   exact IV-2 behavior. A present-but-malformed config fails closed.
 * - No shell strings: commands are executable + string args arrays only,
 *   with optional bounded timeoutMs and string-only environment overrides.
 */
import { createHash } from "node:crypto";
import type { GitRunner } from "./git-repository.js";
import {
  VALIDATION_TIERS,
  type ValidationTier,
} from "./final-verification-contracts.js";
import {
  ENVIRONMENT_NAME_PATTERN,
  MAX_TIER_ARG_COUNT,
  MAX_TIER_ENV_VALUE_LENGTH,
  MAX_TIER_ENV_VARS,
  MAX_TIER_TIMEOUT_MS,
} from "./validation-command-limits.js";
import {
  cloneProjectCheck,
  parseProjectVerificationChecks,
  projectCheckLines,
  type ProjectVerificationCheck,
} from "./verification-plan-v2.js";

export { MAX_TIER_ARG_COUNT, MAX_TIER_ENV_VALUE_LENGTH, MAX_TIER_ENV_VARS, MAX_TIER_TIMEOUT_MS };

/** Repository-root relative path of the project validation config. */
export const PROJECT_VALIDATION_CONFIG_PATH = "aiboard-validation.json";

/** IV-3 default advisory per-task validation budget (about 10 minutes). */
export const DEFAULT_VALIDATION_BUDGET_MS = 600_000;

/** Bounded override ceiling: 24h, nonnegative safe integer. */
export const MAX_VALIDATION_BUDGET_MS = 86_400_000;

/** Bounded tier-map shapes. */
export const MAX_TIER_COMMANDS_PER_TIER = 8;
export const MAX_TIER_ARG_LENGTH = 2000;
export const MAX_TIER_LABEL_LENGTH = 200;
export const MAX_TIER_EXECUTABLE_LENGTH = 500;

/** The newest aiboard-validation.json version this Runner reads. */
export const PROJECT_VALIDATION_CONFIG_VERSION = 2;

export interface ProjectValidationTierCommand {
  label: string;
  executable: string;
  args: string[];
  timeoutMs?: number;
  environment?: Record<string, string>;
}

export type ProjectValidationTiers = Partial<
  Record<ValidationTier, ProjectValidationTierCommand[]>
>;

export interface ProjectValidationConfig {
  version: 1 | 2;
  validationBudgetMs?: number;
  tiers?: ProjectValidationTiers;
  /** Version 2 only: the project's own final checks. */
  checks?: ProjectVerificationCheck[];
}

export type { ProjectVerificationCheck };

const KNOWN_TOP_KEYS = new Set(["version", "validationBudgetMs", "tiers", "checks"]);
const KNOWN_COMMAND_KEYS = new Set([
  "label",
  "executable",
  "args",
  "timeoutMs",
  "environment",
]);
const TIER_SET = new Set<string>(VALIDATION_TIERS);
const ENV_NAME = ENVIRONMENT_NAME_PATTERN;

/** Strict parse of the `aiboard-validation.json` bytes (already JSON-parsed). */
export function parseProjectValidationConfig(
  value: unknown,
): ProjectValidationConfig {
  if (!isRecord(value)) {
    throw new Error("Project validation config must be an object.");
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_TOP_KEYS.has(key)) {
      throw new Error(
        `Project validation config carries an unknown field ${JSON.stringify(key)}.`,
      );
    }
  }
  if (value.version !== 1 && value.version !== 2) {
    if (Number.isSafeInteger(value.version) && (value.version as number) > PROJECT_VALIDATION_CONFIG_VERSION) {
      throw new Error(`Project validation config version ${String(value.version)} is newer than this Runner reads (1 or 2); update the Runner.`);
    }
    throw new Error("Project validation config version must be 1 or 2.");
  }
  const config: ProjectValidationConfig = { version: value.version };
  if (value.validationBudgetMs !== undefined) {
    config.validationBudgetMs = parseValidationBudgetMs(
      value.validationBudgetMs,
    );
  }
  if (value.tiers !== undefined) {
    const tiers = parseTierMap(value.tiers);
    if (Object.keys(tiers).length > 0) config.tiers = tiers;
  }
  if (value.checks !== undefined) {
    if (config.version !== 2) {
      throw new Error("Project validation config checks need version 2.");
    }
    config.checks = parseProjectVerificationChecks(value.checks);
  }
  return config;
}

/** VF4: the project's aiboard-validation.json is present but not valid; a v2 run pauses on it before planning. */
export class ProjectValidationConfigError extends Error {
  override readonly name = "ProjectValidationConfigError";
  /**
   * VF4b review fix: the read failed for a reason a fresh checkout of the same revision may not
   * repeat (no permission, a held file, an I/O error), not because of what the revision holds. A
   * resume takes a fresh checkout, so it can get past it; a malformed file, a folder or a dangling
   * link in its place stays at that revision.
   */
  readonly retryable: boolean;

  constructor(message: string, options?: { cause?: unknown; retryable?: boolean }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.retryable = options?.retryable === true;
  }
}

/**
 * Parse the file text: JSON, then the strict schema. A leading UTF-8 byte-order mark (Windows
 * PowerShell 5's `Out-File -Encoding utf8` writes one) is ignored. A declared check also records
 * the line of its id, so a pause can name it. Errors name the file and what is wrong with it.
 */
export function parseProjectValidationConfigText(text: string): ProjectValidationConfig {
  const source = text.startsWith("\uFEFF") ? text.slice(1) : text;
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch (error) {
    throw new ProjectValidationConfigError(`Project validation config ${PROJECT_VALIDATION_CONFIG_PATH} is not valid JSON.`, { cause: error });
  }
  let config: ProjectValidationConfig;
  try {
    config = parseProjectValidationConfig(parsed);
  } catch (error) {
    throw new ProjectValidationConfigError(`Project validation config ${PROJECT_VALIDATION_CONFIG_PATH} is malformed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (config.checks) {
    const lines = projectCheckLines(source, config.checks.length);
    config.checks = config.checks.map((check, index) => ({
      ...check,
      ...(lines[index] !== undefined ? { line: lines[index] } : {}),
    }));
  }
  return config;
}

/** Bounded nonnegative safe-integer budget override. */
export function parseValidationBudgetMs(value: unknown): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_VALIDATION_BUDGET_MS
  ) {
    throw new Error(
      `validationBudgetMs must be a nonnegative safe integer up to ${MAX_VALIDATION_BUDGET_MS}.`,
    );
  }
  return value;
}

/** Override when configured, else the IV-3 default. */
export function validationBudgetMsForConfig(
  config: ProjectValidationConfig | undefined,
): number {
  if (config?.validationBudgetMs === undefined) return DEFAULT_VALIDATION_BUDGET_MS;
  return parseValidationBudgetMs(config.validationBudgetMs);
}

function parseTierMap(value: unknown): ProjectValidationTiers {
  if (!isRecord(value)) {
    throw new Error("Project validation tiers must be an object.");
  }
  const tiers: ProjectValidationTiers = {};
  for (const [tier, commands] of Object.entries(value)) {
    if (!TIER_SET.has(tier)) {
      throw new Error(`Unknown validation tier ${JSON.stringify(tier)}.`);
    }
    if (!Array.isArray(commands)) {
      throw new Error(`Validation tier ${tier} must be a command array.`);
    }
    if (
      commands.length < 1 ||
      commands.length > MAX_TIER_COMMANDS_PER_TIER
    ) {
      throw new Error(
        `Validation tier ${tier} must carry 1 to ${MAX_TIER_COMMANDS_PER_TIER} commands.`,
      );
    }
    tiers[tier as ValidationTier] = commands.map((command, index) =>
      parseTierCommand(command, `${tier}[${index}]`),
    );
  }
  return tiers;
}

function parseTierCommand(value: unknown, label: string): ProjectValidationTierCommand {
  if (!isRecord(value)) {
    throw new Error(`Validation tier command ${label} must be an object.`);
  }
  for (const key of Object.keys(value)) {
    if (!KNOWN_COMMAND_KEYS.has(key)) {
      throw new Error(
        `Validation tier command ${label} carries an unknown field ${JSON.stringify(key)}.`,
      );
    }
  }
  const rawLabel = value.label;
  const rawExecutable = value.executable;
  if (
    typeof rawLabel !== "string" ||
    rawLabel.trim().length === 0 ||
    rawLabel.trim().length > MAX_TIER_LABEL_LENGTH
  ) {
    throw new Error(
      `Validation tier command ${label} requires a label of 1 to ${MAX_TIER_LABEL_LENGTH} characters.`,
    );
  }
  if (
    typeof rawExecutable !== "string" ||
    rawExecutable.trim().length === 0 ||
    rawExecutable.trim().length > MAX_TIER_EXECUTABLE_LENGTH
  ) {
    throw new Error(
      `Validation tier command ${label} requires an executable of 1 to ${MAX_TIER_EXECUTABLE_LENGTH} characters.`,
    );
  }
  if (
    !Array.isArray(value.args) ||
    value.args.length > MAX_TIER_ARG_COUNT ||
    value.args.some(
      (arg) =>
        typeof arg !== "string" ||
        arg.length > MAX_TIER_ARG_LENGTH ||
        arg.includes("\0"),
    )
  ) {
    throw new Error(
      `Validation tier command ${label} requires a string args array of at most ${MAX_TIER_ARG_COUNT} entries.`,
    );
  }
  const command: ProjectValidationTierCommand = {
    label: rawLabel.trim(),
    executable: rawExecutable.trim(),
    args: [...(value.args as string[])],
  };
  if (value.timeoutMs !== undefined) {
    if (
      !Number.isSafeInteger(value.timeoutMs) ||
      (value.timeoutMs as number) < 1 ||
      (value.timeoutMs as number) > MAX_TIER_TIMEOUT_MS
    ) {
      throw new Error(
        `Validation tier command ${label} timeoutMs must be from 1 to ${MAX_TIER_TIMEOUT_MS}.`,
      );
    }
    command.timeoutMs = value.timeoutMs as number;
  }
  if (value.environment !== undefined) {
    command.environment = parseTierEnvironment(value.environment, label);
  }
  return command;
}

function parseTierEnvironment(
  value: unknown,
  label: string,
): Record<string, string> {
  if (!isRecord(value)) {
    throw new Error(`Validation tier command ${label} environment must be an object.`);
  }
  const entries = Object.entries(value);
  if (entries.length > MAX_TIER_ENV_VARS) {
    throw new Error(
      `Validation tier command ${label} environment carries too many variables.`,
    );
  }
  const environment: Record<string, string> = {};
  for (const [name, entry] of entries) {
    if (
      !ENV_NAME.test(name) ||
      typeof entry !== "string" ||
      entry.length > MAX_TIER_ENV_VALUE_LENGTH ||
      entry.includes("\0")
    ) {
      throw new Error(
        `Validation tier command ${label} environment variable ${JSON.stringify(name)} is invalid.`,
      );
    }
    environment[name] = entry;
  }
  return environment;
}

/** Deterministic deep clone in canonical tier order. */
export function cloneProjectValidationConfig(
  config: ProjectValidationConfig,
): ProjectValidationConfig {
  const clone: ProjectValidationConfig = { version: config.version };
  if (config.validationBudgetMs !== undefined) {
    clone.validationBudgetMs = parseValidationBudgetMs(config.validationBudgetMs);
  }
  if (config.tiers !== undefined) {
    const tiers: ProjectValidationTiers = {};
    for (const tier of VALIDATION_TIERS) {
      const commands = config.tiers[tier];
      if (!commands) continue;
      tiers[tier] = commands.map((command) => ({
        label: command.label,
        executable: command.executable,
        args: [...command.args],
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
        ...(command.environment ? { environment: { ...command.environment } } : {}),
      }));
    }
    if (Object.keys(tiers).length > 0) clone.tiers = tiers;
  }
  if (config.checks !== undefined) clone.checks = config.checks.map(cloneProjectCheck);
  return clone;
}

/** Deterministic digest over the canonical clone. */
export function projectValidationConfigDigest(
  config: ProjectValidationConfig,
): string {
  return stableDigest(cloneProjectValidationConfig(config));
}

function stableDigest(value: unknown): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

/**
 * IV-3 one pure tier selector used by every path. Final candidate wins over
 * milestone, milestone wins over ordinary-task risk. Deterministic, trusted
 * inputs only; never asks the model.
 */
export function selectValidationTier(input: {
  changeRisk: "low" | "medium" | "high";
  isMilestoneGate: boolean;
  isFinalCandidate: boolean;
}): ValidationTier {
  if (input.isFinalCandidate) return "release";
  if (input.isMilestoneGate) return "slow";
  if (input.changeRisk === "high") return "integration";
  if (input.changeRisk === "medium") return "component";
  return "fast";
}

/**
 * Cloned commands for the chosen tier, or undefined when no map or the tier
 * is absent (the caller fails safe to the current detected-command behavior).
 */
export function tierCommandsForTier(
  tiers: ProjectValidationTiers | undefined,
  tier: ValidationTier,
): ProjectValidationTierCommand[] | undefined {
  const commands = tiers?.[tier];
  if (!commands || commands.length === 0) return undefined;
  return commands.map((command) => ({
    label: command.label,
    executable: command.executable,
    args: [...command.args],
    ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
    ...(command.environment ? { environment: { ...command.environment } } : {}),
  }));
}

export async function readValidationBudgetMsAtRevision(input: {
  git: GitRunner;
  cwd: string;
  revision: string;
}): Promise<number> {
  // R2-F3: prove the revision exists first through Git plumbing only.
  // Invalid/unresolvable revisions and Git authority failures reject;
  // only a valid revision with an absent file returns the default.
  let verified;
  try {
    verified = await input.git({ cwd: input.cwd, args: ["rev-parse", "--verify", `${input.revision}^{commit}`], allowFailure: true });
  } catch (error) {
    throw new Error(`Project validation config ${PROJECT_VALIDATION_CONFIG_PATH} revision ${JSON.stringify(input.revision)} is unresolvable: ${error instanceof Error ? error.message : String(error)}.`, { cause: error });
  }
  if (verified.exitCode !== 0) {
    throw new Error(`Project validation config ${PROJECT_VALIDATION_CONFIG_PATH} revision ${JSON.stringify(input.revision)} is invalid or unresolvable.`);
  }
  // Valid revision: ls-tree distinguishes absent file (exit 0, empty) from
  // Git failure (nonzero/throw, which rejects). No filesystem shortcut.
  let listing;
  try {
    listing = await input.git({ cwd: input.cwd, args: ["ls-tree", input.revision, "--", PROJECT_VALIDATION_CONFIG_PATH], allowFailure: true });
  } catch (error) {
    throw new Error(`Project validation config ${PROJECT_VALIDATION_CONFIG_PATH} Git read failed: ${error instanceof Error ? error.message : String(error)}.`, { cause: error });
  }
  if (listing.exitCode !== 0) {
    throw new Error(`Project validation config ${PROJECT_VALIDATION_CONFIG_PATH} Git read failed: ${listing.stderr.trim() || `exit ${listing.exitCode}`}.`);
  }
  if (!listing.stdout.trim()) {
    return DEFAULT_VALIDATION_BUDGET_MS;
  }
  // Present file: the blob read must succeed; any failure rejects.
  let shown;
  try {
    shown = await input.git({ cwd: input.cwd, args: ["show", `${input.revision}:${PROJECT_VALIDATION_CONFIG_PATH}`], allowFailure: true });
  } catch (error) {
    throw new Error(`Project validation config ${PROJECT_VALIDATION_CONFIG_PATH} is present but unreadable: ${error instanceof Error ? error.message : String(error)}.`, { cause: error });
  }
  if (shown.exitCode !== 0) {
    throw new Error(`Project validation config ${PROJECT_VALIDATION_CONFIG_PATH} is present but unreadable: ${shown.stderr.trim() || `exit ${shown.exitCode}`}.`);
  }
  return validationBudgetMsForConfig(parseProjectValidationConfigText(shown.stdout));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
