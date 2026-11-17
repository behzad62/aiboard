/**
 * CLI workers' crew rules and their checks before planning (docs/plans/2026-11-14-cli-workers.md §3.2, §3.11,
 * §3.12, §3.13, packet CW4).
 *
 * - A Build start, a crew change and a recovered spec are refused when the crew breaks a rule
 *   (`assertCliCrewRules`): a CLI as Architect, reviewer or verifier, a CLI worker below Full access, or a CLI
 *   refused on this OS or under root. Nothing is launched to find out.
 * - Before planning, every CLI in the crew gets its free checks (CW3's detection, injected as
 *   `CliWorkerFreeChecks`), and the `.cmd` rules of §3.2 and §3.5 are applied to what they found
 *   (`checkCliWorkers`). The result is one `cli_workers.checked` event; a CLI that fails is recorded as unhealthy
 *   with its failure kind (§3.8), so no task is assigned to it and the Build goes on with its other workers.
 *
 * This module reads nothing and launches nothing itself.
 */

import { join } from "node:path";

import {
  CLI_RUNTIME_ROLE_REFUSED,
  CLI_WORKERS_REQUIRE_FULL_ACCESS,
  nativeBuildCliCrewRefusal,
  type CliCrewPolicyInput,
} from "./cli-crew-policy.js";
import {
  buildCliWorkerArgs,
  CLI_WORKER_DISPLAY_NAMES,
  cliWorkerPlatformRefusal,
  cliWorkerResultSchemaJson,
  cliWorkerRootRefusal,
  windowsBatchShimRefusedArguments,
  type CliExecutableForm,
  type CliLaunchSpec,
} from "./cli-worker-adapters.js";
import { CLI_DEFAULT_MODEL_ID, isCliWorkerProviderId, type CliWorkerProviderId } from "./cli-worker-config.js";
import type { ProcessHostSemanticFact } from "./process-host-semantic-probes.js";
import type { RunnerProviderConfig } from "./provider-config-store.js";
import type { ProviderFailure, ProviderFailureKind } from "./provider-health.js";

export { CLI_RUNTIME_ROLE_REFUSED, CLI_WORKERS_REQUIRE_FULL_ACCESS };

/** A CLI worker refused on this OS (§3.11, CWD-10, CWD-11). */
export const CLI_WORKER_PLATFORM_REFUSED = "cli_worker_platform_refused";
/** Claude Code refused while the Runner runs as root (§3.12). */
export const CLI_WORKER_ROOT_REFUSED = "cli_worker_root_refused";
/** A `cli` config whose provider is not a CLI worker AIBoard knows (CW1's validator refuses one too). */
export const CLI_WORKER_UNKNOWN = "cli_worker_unknown";

export type CliCrewRuleCode =
  | typeof CLI_RUNTIME_ROLE_REFUSED
  | typeof CLI_WORKERS_REQUIRE_FULL_ACCESS
  | typeof CLI_WORKER_PLATFORM_REFUSED
  | typeof CLI_WORKER_ROOT_REFUSED
  | typeof CLI_WORKER_UNKNOWN;

/** A Build or crew refused by a CLI crew rule. The control server answers it with 409 and its code. */
export class CliCrewRuleError extends Error {
  readonly status = 409;

  constructor(readonly code: CliCrewRuleCode, message: string, readonly runtimeId: string) {
    super(message);
    this.name = "CliCrewRuleError";
  }
}

/** The host facts the crew rules read. */
export interface CliCrewHost {
  platform: NodeJS.Platform;
  /** The Runner runs as root (uid 0). Always false on Windows, where there is no uid. */
  isRoot: boolean;
}

export function currentCliCrewHost(): CliCrewHost {
  return { platform: process.platform, isRoot: typeof process.getuid === "function" && process.getuid() === 0 };
}

/** The CLI runtimes among these configs, by the authoritative `transport: "cli"`. */
export function cliRuntimeIds(configs: readonly RunnerProviderConfig[]): Set<string> {
  return new Set(configs.filter((config) => config.transport === "cli").map((config) => config.runtimeId));
}

/**
 * Refuses a crew that breaks a CLI rule, with a coded `CliCrewRuleError`. A crew with no CLI runtime passes
 * untouched, so API-only Builds behave exactly as before.
 */
export function assertCliCrewRules(
  configs: readonly RunnerProviderConfig[],
  crew: CliCrewPolicyInput,
  host: CliCrewHost = currentCliCrewHost(),
): void {
  const cli = cliRuntimeIds(configs);
  if (cli.size === 0) return;
  const refusal = nativeBuildCliCrewRefusal(crew, (runtimeId) => cli.has(runtimeId));
  if (refusal) throw new CliCrewRuleError(refusal.code, refusal.message, refusal.runtimeId);
  for (const runtimeId of crew.workerRuntimeIds) {
    if (!cli.has(runtimeId)) continue;
    const providerId = configs.find((config) => config.runtimeId === runtimeId)?.providerId;
    // CW1's validator refuses a `cli` config whose provider is not a CLI worker; a stray one is refused here too.
    if (!isCliWorkerProviderId(providerId)) {
      throw new CliCrewRuleError(CLI_WORKER_UNKNOWN, `${runtimeId} is not a known CLI worker.`, runtimeId);
    }
    const platform = cliWorkerPlatformRefusal(providerId, host.platform);
    if (platform) throw new CliCrewRuleError(CLI_WORKER_PLATFORM_REFUSED, platform, runtimeId);
    const root = host.isRoot ? cliWorkerRootRefusal(providerId) : undefined;
    if (root) throw new CliCrewRuleError(CLI_WORKER_ROOT_REFUSED, root, runtimeId);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The free checks before planning

/**
 * What CW3's free checks report for one CLI: the seam the Build start takes as a dependency. CW3's detection
 * module supplies the function; until it is wired, the Build records its CLIs as `unchecked`.
 */
export interface CliWorkerFreeCheck {
  providerId: CliWorkerProviderId;
  /**
   * - `ready`: installed and logged in (and, for agy, usage left).
   * - `unhealthy`: a free check failed; `failure` says how, as a §3.8 kind (not installed and logged out are
   *   `authentication`; agy's spent `/quota` is `usage_limit` with its stated reset in `retryAfterMs`).
   * - `unknown`: nothing could be decided (a probe timed out, the lookup could not tell); the CLI stays a
   *   candidate, as VF2 launches a tool its lookup could not decide about.
   */
  status: "ready" | "unhealthy" | "unknown";
  /** The executable the lookup resolved; its `form` decides the `.cmd` rules, applied here. */
  executable?: { path: string; form: CliExecutableForm };
  version?: string;
  /** Required when `unhealthy`. Its message is shown to the owner, so it holds no account field. */
  failure?: ProviderFailure;
  /** Why the result is `unknown`. */
  note?: string;
}

/**
 * CW3's free checks for the CLIs a Build uses: version, login and, for agy, `/quota`, with no prompt (§3.2). It
 * runs each probe with its own 8 s bound, never launches a CLI with a prompt, and never rejects: a probe that
 * fails is a result. It returns one entry per requested provider id; a missing entry is recorded as `unknown`.
 */
export type CliWorkerFreeChecks = (request: {
  readonly providerIds: readonly CliWorkerProviderId[];
  readonly signal?: AbortSignal;
}) => Promise<readonly CliWorkerFreeCheck[]>;

export const CLI_WORKERS_CHECKED_EVENT_TYPE = "cli_workers.checked";
export const CLI_WORKERS_CHECKED_VERSION = 1;
const CLI_CHECK_TEXT_MAX = 300;

export interface CliWorkerCheckedRecord {
  providerId: CliWorkerProviderId;
  /** The crew's runtimes of this CLI; health is per provider, so they share one result. */
  runtimeIds: string[];
  /** `unchecked`: no free checks are wired into this Runner yet. */
  status: "ready" | "unhealthy" | "unknown" | "unchecked";
  executableForm?: CliExecutableForm;
  version?: string;
  failureKind?: ProviderFailureKind;
  /** Why it is unhealthy, unknown or unchecked; at most 300 characters. */
  reason?: string;
  retryAfterMs?: number;
}

export interface CliWorkersChecked {
  version: typeof CLI_WORKERS_CHECKED_VERSION;
  trigger: "planning" | "resume";
  clis: CliWorkerCheckedRecord[];
}

export interface CheckCliWorkersInput {
  trigger: "planning" | "resume";
  /** The crew's CLI worker configs. */
  workers: readonly Pick<RunnerProviderConfig, "runtimeId" | "providerId" | "modelId" | "cli">[];
  freeChecks?: CliWorkerFreeChecks;
  signal?: AbortSignal;
  platform: NodeJS.Platform;
  /** Windows only: the batch-argv fact every launch reads; a `.cmd` launch runs only when it is `verified`. */
  windowsBatchArgv?: ProcessHostSemanticFact;
  /**
   * The Runner-built folders a launch would name (§3.5): a task worktree and a CLI state folder of this run.
   * Their segments below the Runner's state folder are Runner-made and safe, so only that folder can hold a
   * character a `.cmd` shim refuses.
   */
  launchFolders: { worktree: string; cliState: string };
}

export const CLI_CMD_HOST_REFUSED_REASON = "this PC can't launch .cmd CLIs";

/**
 * Runs the free checks for the crew's CLIs and applies the `.cmd` rules (§3.2, §3.5's open point) to what they
 * found. `failures` holds one provider failure per unhealthy CLI, for the provider health registry.
 */
export async function checkCliWorkers(input: CheckCliWorkersInput): Promise<{
  checked: CliWorkersChecked;
  failures: { providerId: CliWorkerProviderId; failure: ProviderFailure }[];
}> {
  const byProvider = new Map<CliWorkerProviderId, string[]>();
  for (const worker of input.workers) {
    if (!isCliWorkerProviderId(worker.providerId)) continue;
    byProvider.set(worker.providerId, [...(byProvider.get(worker.providerId) ?? []), worker.runtimeId]);
  }
  const providerIds = [...byProvider.keys()];
  let results: readonly CliWorkerFreeCheck[] | undefined;
  let checksError: string | undefined;
  if (input.freeChecks && providerIds.length > 0) {
    try {
      results = await input.freeChecks({ providerIds, ...(input.signal ? { signal: input.signal } : {}) });
    } catch (error) {
      checksError = `The free checks could not run: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
  const clis: CliWorkerCheckedRecord[] = [];
  const failures: { providerId: CliWorkerProviderId; failure: ProviderFailure }[] = [];
  for (const providerId of providerIds) {
    const runtimeIds = byProvider.get(providerId)!;
    const base = { providerId, runtimeIds: [...runtimeIds] };
    if (!input.freeChecks) {
      clis.push({ ...base, status: "unchecked", reason: "This Runner does not run CLI free checks yet." });
      continue;
    }
    const result = results?.find((entry) => entry.providerId === providerId);
    if (!result) {
      clis.push({ ...base, status: "unknown", reason: bound(checksError ?? "The free checks returned no result for this CLI.") });
      continue;
    }
    const facts = {
      ...(result.executable ? { executableForm: result.executable.form } : {}),
      ...(result.version ? { version: bound(result.version) } : {}),
    };
    const failure = result.status === "unhealthy"
      ? result.failure ?? { kind: "authentication" as const, message: `${CLI_WORKER_DISPLAY_NAMES[providerId]} failed a free check.` }
      : cmdLaunchFailure(providerId, result, input, runtimeIds);
    if (failure) {
      // A message and a retry time the health registry accepts, so one odd result never drops the epoch's record.
      const retryAfterMs = typeof failure.retryAfterMs === "number" && Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs >= 0
        ? Math.min(Math.round(failure.retryAfterMs), Number.MAX_SAFE_INTEGER)
        : undefined;
      const recorded: ProviderFailure = {
        // An unknown kind is transient, as an unknown CLI message is (§3.8).
        kind: FAILURE_KINDS.has(failure.kind) ? failure.kind : "transient",
        message: bound(failure.message || "") || `${CLI_WORKER_DISPLAY_NAMES[providerId]} failed a free check.`,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
      };
      failures.push({ providerId, failure: recorded });
      clis.push({
        ...base, ...facts, status: "unhealthy", failureKind: recorded.kind, reason: recorded.message,
        ...(recorded.retryAfterMs !== undefined ? { retryAfterMs: recorded.retryAfterMs } : {}),
      });
      continue;
    }
    clis.push({ ...base, ...facts, status: result.status, ...(result.status === "unknown" && result.note ? { reason: bound(result.note) } : {}) });
  }
  return { checked: { version: CLI_WORKERS_CHECKED_VERSION, trigger: input.trigger, clis }, failures };
}

/**
 * The `.cmd` rules for a CLI the free checks found as a `.cmd` shim on Windows, as an `authentication` failure:
 * the owner must change the setup, and a passing Settings test ends it (§3.8).
 * - The host refuses every `.cmd` launch unless its batch-argv fact is `verified` (windows-process-backend.ts).
 * - Claude Code's inline result schema always has quotes, which both Windows launchers refuse in a `.cmd`
 *   argument, so its shim is always refused (§3.5's open point, settled by CW2).
 * - A Codex or agy shim is refused when an argument it would be launched with, built from this run's real
 *   folders, holds one of those characters.
 */
function cmdLaunchFailure(
  providerId: CliWorkerProviderId,
  result: CliWorkerFreeCheck,
  input: CheckCliWorkersInput,
  runtimeIds: readonly string[],
): ProviderFailure | undefined {
  if (input.platform !== "win32" || result.executable?.form !== "cmd") return undefined;
  const name = CLI_WORKER_DISPLAY_NAMES[providerId];
  if (input.windowsBatchArgv !== "verified") {
    return { kind: "authentication", message: `${name} is installed as a .cmd shim, and ${CLI_CMD_HOST_REFUSED_REASON}: Windows' batch-argument check did not pass here. Install its native .exe.` };
  }
  if (providerId === "claude-code") {
    return { kind: "authentication", message: "Claude Code's npm shim can't carry its result schema; install the native claude.exe." };
  }
  for (const runtimeId of runtimeIds) {
    let refused: string[];
    try {
      refused = representativeArgv(providerId, runtimeId, input);
    } catch (error) {
      return { kind: "authentication", message: `${name} can't be launched from this Runner's folders: ${error instanceof Error ? error.message : String(error)}` };
    }
    const unsafe = windowsBatchShimRefusedArguments(refused);
    if (unsafe.length > 0) {
      return {
        kind: "authentication",
        message: `${name} is installed as a .cmd shim, which can't be launched with ${refused[unsafe[0]!]}: Windows refuses " % ! ^ & | < > ( ) in a .cmd argument. Install its native .exe, or move AIBoard's home to a folder without those characters.`,
      };
    }
  }
  return undefined;
}

/** The argv a worker launch of this runtime would get, with this run's real folders (§3.5). */
function representativeArgv(providerId: CliWorkerProviderId, runtimeId: string, input: CheckCliWorkersInput): string[] {
  const worker = input.workers.find((entry) => entry.runtimeId === runtimeId);
  const model = worker && worker.modelId !== CLI_DEFAULT_MODEL_ID ? worker.modelId : null;
  const effort = worker?.cli?.reasoningEffort;
  const common = { mode: "worker" as const, model, ...(effort !== undefined ? { reasoningEffort: effort } : {}) };
  const schemaPath = join(input.launchFolders.cliState, "result.schema.json");
  const spec: CliLaunchSpec = providerId === "codex-cli"
    ? { providerId, ...common, schemaPath, outputPath: join(input.launchFolders.cliState, "result.json"), worktree: input.launchFolders.worktree }
    : providerId === "agy"
      ? { providerId, ...common, schemaPath }
      : { providerId, ...common, schemaJson: cliWorkerResultSchemaJson(), sessionId: "00000000-0000-4000-8000-000000000000" };
  return buildCliWorkerArgs(spec);
}

function bound(text: string): string {
  const line = text.replace(/[\r\n]+/g, " ").trim();
  return line.length <= CLI_CHECK_TEXT_MAX ? line : `${line.slice(0, CLI_CHECK_TEXT_MAX - 1)}…`;
}

const CHECKED_STATUSES = new Set(["ready", "unhealthy", "unknown", "unchecked"]);
const FAILURE_KINDS = new Set<ProviderFailureKind>(["usage_limit", "rate_limit", "authentication", "provider_unavailable", "transient", "invalid_request", "cancelled"]);
const EXECUTABLE_FORMS = new Set<CliExecutableForm>(["exe", "cmd", "native"]);

/** Strict replay parse of a `cli_workers.checked` payload: closed fields, bounded text. */
export function parseCliWorkersChecked(payload: unknown): CliWorkersChecked {
  const fail = (what: string): never => { throw new Error(`CLI worker checks payload is invalid: ${what}.`); };
  if (!isPlainRecord(payload)) return fail("not an object");
  if (Object.keys(payload).sort().join(",") !== "clis,trigger,version") fail("unexpected fields");
  if (payload.version !== CLI_WORKERS_CHECKED_VERSION) fail("version");
  if (payload.trigger !== "planning" && payload.trigger !== "resume") fail("trigger");
  if (!Array.isArray(payload.clis) || payload.clis.length > 3) fail("clis");
  const allowed = new Set(["providerId", "runtimeIds", "status", "executableForm", "version", "failureKind", "reason", "retryAfterMs"]);
  const clis = (payload.clis as unknown[]).map((entry): CliWorkerCheckedRecord => {
    if (!isPlainRecord(entry) || Object.keys(entry).some((key) => !allowed.has(key))) return fail("a CLI entry");
    if (!isCliWorkerProviderId(entry.providerId)) return fail("providerId");
    if (!Array.isArray(entry.runtimeIds) || entry.runtimeIds.length === 0 || entry.runtimeIds.length > 64 ||
        entry.runtimeIds.some((id) => typeof id !== "string" || !id)) return fail("runtimeIds");
    if (typeof entry.status !== "string" || !CHECKED_STATUSES.has(entry.status)) return fail("status");
    if (entry.executableForm !== undefined && !EXECUTABLE_FORMS.has(entry.executableForm as CliExecutableForm)) fail("executableForm");
    for (const key of ["version", "reason"] as const) {
      const value = entry[key];
      if (value !== undefined && (typeof value !== "string" || value.length > CLI_CHECK_TEXT_MAX)) fail(key);
    }
    if (entry.failureKind !== undefined && !FAILURE_KINDS.has(entry.failureKind as ProviderFailureKind)) fail("failureKind");
    if ((entry.status === "unhealthy") !== (entry.failureKind !== undefined)) fail("failureKind and status");
    if (entry.retryAfterMs !== undefined && (!Number.isSafeInteger(entry.retryAfterMs) || (entry.retryAfterMs as number) < 0)) fail("retryAfterMs");
    return {
      providerId: entry.providerId,
      runtimeIds: [...(entry.runtimeIds as string[])],
      status: entry.status as CliWorkerCheckedRecord["status"],
      ...(entry.executableForm !== undefined ? { executableForm: entry.executableForm as CliExecutableForm } : {}),
      ...(entry.version !== undefined ? { version: entry.version as string } : {}),
      ...(entry.failureKind !== undefined ? { failureKind: entry.failureKind as ProviderFailureKind } : {}),
      ...(entry.reason !== undefined ? { reason: entry.reason as string } : {}),
      ...(entry.retryAfterMs !== undefined ? { retryAfterMs: entry.retryAfterMs as number } : {}),
    };
  });
  if (new Set(clis.map((entry) => entry.providerId)).size !== clis.length) fail("a CLI listed twice");
  return { version: CLI_WORKERS_CHECKED_VERSION, trigger: payload.trigger as "planning" | "resume", clis };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
