/**
 * IV-3 (CD-23): the ONE explicit revision-bound project validation config.
 *
 * Filename (repository root, relative to the inspected checkout):
 *   `aiboard-validation.json`
 *
 * Cross-language JSON schema (all keys strict, no unknown keys):
 *   {
 *     "version": 1,
 *     "validationBudgetMs": 600000,        // optional advisory per-task budget
 *     "tiers": {                            // optional tier -> commands map
 *       "fast":        [{ "label": "...", "executable": "...", "args": [...] }],
 *       "component":   [...],
 *       "integration": [...],
 *       "slow":        [...],
 *       "release":     [...]
 *     }
 *   }
 *
 * - `version` must be 1. Unknown top-level keys, unknown tier keys, empty
 *   tier arrays, shell command strings, and out-of-bound values fail closed.
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

/** Repository-root relative path of the project validation config. */
export const PROJECT_VALIDATION_CONFIG_PATH = "aiboard-validation.json";

/** IV-3 default advisory per-task validation budget (about 10 minutes). */
export const DEFAULT_VALIDATION_BUDGET_MS = 600_000;

/** Bounded override ceiling: 24h, nonnegative safe integer. */
export const MAX_VALIDATION_BUDGET_MS = 86_400_000;

/** Bounded tier-map shapes. */
export const MAX_TIER_COMMANDS_PER_TIER = 8;
export const MAX_TIER_ARG_COUNT = 100;
export const MAX_TIER_ARG_LENGTH = 2000;
export const MAX_TIER_LABEL_LENGTH = 200;
export const MAX_TIER_EXECUTABLE_LENGTH = 500;
export const MAX_TIER_TIMEOUT_MS = 1_800_000;
export const MAX_TIER_ENV_VARS = 100;
export const MAX_TIER_ENV_VALUE_LENGTH = 4000;

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
  version: 1;
  validationBudgetMs?: number;
  tiers?: ProjectValidationTiers;
}

const KNOWN_TOP_KEYS = new Set(["version", "validationBudgetMs", "tiers"]);
const KNOWN_COMMAND_KEYS = new Set([
  "label",
  "executable",
  "args",
  "timeoutMs",
  "environment",
]);
const TIER_SET = new Set<string>(VALIDATION_TIERS);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

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
  if (value.version !== 1) {
    throw new Error("Project validation config version must be 1.");
  }
  const config: ProjectValidationConfig = { version: 1 };
  if (value.validationBudgetMs !== undefined) {
    config.validationBudgetMs = parseValidationBudgetMs(
      value.validationBudgetMs,
    );
  }
  if (value.tiers !== undefined) {
    const tiers = parseTierMap(value.tiers);
    if (Object.keys(tiers).length > 0) config.tiers = tiers;
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
  const clone: ProjectValidationConfig = { version: 1 };
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(shown.stdout) as unknown;
  } catch (error) {
    throw new Error(`Project validation config ${PROJECT_VALIDATION_CONFIG_PATH} is not valid JSON.`, { cause: error });
  }
  try {
    return validationBudgetMsForConfig(parseProjectValidationConfig(parsed));
  } catch (error) {
    throw new Error(`Project validation config ${PROJECT_VALIDATION_CONFIG_PATH} is malformed: ${error instanceof Error ? error.message : String(error)}.`, { cause: error });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
