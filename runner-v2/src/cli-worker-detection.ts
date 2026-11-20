/**
 * CLI worker detection and the Test button (docs/plans/2026-11-14-cli-workers.md §3.2, §3.4, packet CW3).
 *
 * - The free checks (§3.2): where the CLI is, its version, its login, its models and, for agy, its stated quota.
 *   They cost no quota and send no prompt. `GET /v2/cli-workers` shows them, cached for 60 s.
 * - Refusals come first and launch nothing: the per-OS refusals of §3.11, Claude Code under root (§3.12), and the
 *   `.cmd` rules of §3.2 and §3.5 (Claude Code's npm shim; a host whose batch-argv fact is not `verified`; a Runner
 *   folder with a character a `.cmd` argument cannot carry).
 * - The Test (§3.4): one tiny prompt in the CLI's most restricted mode, never with a bypass flag, in an empty folder
 *   the Runner owns (`<state>/cli-worker-tests/<random>/`). The folder is removed after a verified stop and kept
 *   after an unverified one. The outcome is saved to the home as `cliWorkers.<providerId>.lastTest`.
 *
 * Every process here, the free probes and the Test alike, runs under the same process ownership as a worker
 * (cli-worker-processes.ts: an execution-host run binding, the Windows Job or the POSIX process group, with
 * `AIBOARD_MCP_DEPTH=2`), from a Runner-owned folder, never a worktree or a project folder.
 *
 * CW4's Build-start check (native-build-factory.ts `cliWorkerFreeChecks`) is the service's `freeChecks`, which maps each
 * `check` to cli-worker-crew.ts's `CliWorkerFreeCheck` (`cliWorkerFreeCheckEntry`).
 */

import { randomBytes, randomUUID } from "node:crypto";
import { inspect as describe } from "node:util";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AiboardHomeError, type AiboardHomeLocation } from "./aiboard-home-paths.js";
import { applyHomeBatch, readAiboardHome } from "./aiboard-home-store.js";
import type { CheckToolLookup } from "./check-tool-lookup.js";
import {
  agyQuotaFailure,
  buildCliWorkerArgs,
  buildCliWorkerStdin,
  CLI_PROBE_OUTPUT_MAX_CHARS,
  CLI_WORKER_ADAPTERS,
  CLI_WORKER_DISPLAY_NAMES,
  cliWorkerPlatformRefusal,
  cliWorkerResultSchemaJson,
  cliWorkerRootRefusal,
  parseAgyQuota,
  parseCliVersionOutput,
  resolveCliExecutable,
  windowsBatchShimRefusedArguments,
  type AgyQuotaGroup,
  type CliExecutableForm,
  type CliLaunchSpec,
  type CliLoginState,
  type CliModelChoice,
  type CliModelList,
  type CliProbeOutput,
  type CliRunReading,
} from "./cli-worker-adapters.js";
import {
  CLI_WORKER_PROVIDER_IDS,
  isCliArgumentValue,
  isCliVersion,
  scrubCliMessage,
  type CliTestOutcome,
  type CliWorkerProviderId,
  type HomeCliWorkerTestV1,
} from "./cli-worker-config.js";
import { isCliModelUnavailableText } from "./cli-worker-failures.js";
import type { CliWorkerFreeCheck, CliWorkerFreeChecks } from "./cli-worker-crew.js";
import type { ProcessHostSemanticFact } from "./process-host-semantic-probes.js";
import type { ProviderFailure } from "./provider-health.js";
import type { CliWorkerProcess, CliWorkerProcesses, CliWorkerProcessSession } from "./cli-worker-processes.js";
import { INVENTORY_VERSION_PROBE_TIMEOUT_MS } from "./verification-inventory.js";

/** §3.2: free-check results are cached this long; Settings' Refresh bypasses the cache. */
export const CLI_WORKER_CHECK_CACHE_MS = 60_000;
/** §3.2: one free probe, the tool inventory's version-probe bound. */
export const CLI_WORKER_PROBE_TIMEOUT_MS = INVENTORY_VERSION_PROBE_TIMEOUT_MS;
/** §3.4: the Test's one tiny prompt. */
export const CLI_WORKER_TEST_TIMEOUT_MS = 120_000;
/** One read waits at most this long for new output, so the deadline and the result event are seen promptly. */
const READ_WAIT_MS = 500;

/** The Test's prompt. It goes on stdin; it asks for the result schema's smallest valid answer and no tool use. */
export const CLI_WORKER_TEST_PROMPT = [
  "This is a connection test from AIBoard. Do not run any command, and do not read or change any file.",
  "Reply only with the JSON result the schema describes: outcome \"done\", summary \"AIBoard test\", and empty",
  "checks, notRun and concerns lists; question and replanReason null.",
].join(" ");

// ---------------------------------------------------------------------------------------------------------------
// The free check (CW4 calls this too)

/**
 * - ready: installed, logged in, and nothing refuses it here.
 * - refused: a crew rule refuses it on this host (the OS or root): CW4 refuses a Build whose crew has it.
 * - unavailable: it cannot work now (not installed, logged out, out of usage, a `.cmd` this host cannot launch):
 *   CW4 records `failure` as its provider health before planning.
 * - unknown: a check could not decide (a probe failed, timed out or could not be proven stopped).
 */
export type CliWorkerCheckStatus = "ready" | "refused" | "unavailable" | "unknown";

export type CliWorkerCheckCode =
  | "platform_refused"
  | "root_refused"
  | "not_installed"
  | "executable_refused"
  | "executable_unknown"
  | "job_containment_unavailable"
  | "cmd_shim_schema"
  | "cmd_launch_unavailable"
  | "cmd_argument_unsafe"
  | "not_logged_in"
  | "login_unknown"
  | "usage_limit"
  | "probe_failed";

export interface CliWorkerCheck {
  providerId: CliWorkerProviderId;
  displayName: string;
  status: CliWorkerCheckStatus;
  /** Why it is not ready, in words for Settings; absent when ready. */
  code?: CliWorkerCheckCode;
  reason?: string;
  /** For `unavailable`: the provider failure CW4 records before planning (§3.8). */
  failure?: ProviderFailure;
  executable?: { path: string; source: "home" | "path"; form: CliExecutableForm };
  version?: string;
  login?: CliLoginState;
  models?: CliModelChoice[];
  modelsSource?: CliModelList["source"];
  modelsNote?: string;
  /** agy's stated usage (`/quota`): only group names, model names, windows, fractions and stated resets. */
  quota?: AgyQuotaGroup[];
  checkedAt: string;
}

export interface CliWorkerCheckOptions {
  /** The home's `executablePath`, which overrides the PATH lookup. */
  executablePath?: string;
  /**
   * CW4: the project's worktree folder. For a `.cmd` CLI its path is checked with the Runner's own folders, so a
   * worktree under a folder a `.cmd` argument cannot carry is refused before planning (§3.5's open point).
   */
  worktreeFolder?: string;
}

/** The function CW4's Build-start check takes as its injected dependency. */
export type CliWorkerCheckFunction = (providerId: CliWorkerProviderId, options?: CliWorkerCheckOptions) => Promise<CliWorkerCheck>;

// ---------------------------------------------------------------------------------------------------------------
// The service

/** What a launch of the CLI at `path` runs. Production: the path itself. Tests: node and the fake CLI script. */
export type CliWorkerCommand = (path: string, args: readonly string[]) => { executable: string; arguments: readonly string[] };

export interface CliWorkerDetectionOptions {
  /** The Runner's state folder: the lookup folder and the Test folders live under it. */
  stateDirectory: string;
  /** Where every check and Test process runs: a worker's process ownership (cli-worker-processes.ts). */
  processes: CliWorkerProcesses;
  /** VF2's lookup, so a CLI is found where a launch would find it. */
  lookup: CheckToolLookup;
  /** The home: each CLI's `executablePath`, and where a Test's outcome is saved. */
  home?: AiboardHomeLocation;
  /**
   * The host's Windows batch-argv fact, the one the Job backend gets (§3.2). Undefined on POSIX. A `.cmd` CLI on a
   * host where it is not `verified` is reported "this PC can't launch .cmd CLIs" and never launched.
   */
  windowsBatchArgv?: () => Promise<ProcessHostSemanticFact | undefined>;
  /**
   * The host's Windows Job containment fact (§3.11). On Windows a CLI runs only under a verified Job: the allowance
   * was measured there, and the portable fallback cannot stop what an agent session leaves behind. When it is not
   * `verified` the check reports the CLI unavailable, launching nothing, and a Test is refused.
   */
  windowsJobContainment?: () => Promise<ProcessHostSemanticFact | undefined>;
  /** Test seams. */
  platform?: NodeJS.Platform;
  isRoot?: () => boolean;
  now?: () => number;
  command?: CliWorkerCommand;
  inspect?: (path: string) => Promise<"file" | "absent" | "unknown">;
  probeTimeoutMs?: number;
  testTimeoutMs?: number;
}

export interface CliWorkerTestRequest {
  /** null: the CLI's default model (no flag). */
  model: string | null;
  reasoningEffort?: string;
}

export interface CliWorkerTestResult {
  /** What was saved to the home (`cliWorkers.<providerId>.lastTest`). */
  lastTest: HomeCliWorkerTestV1;
  /** Whether the test's processes were proven stopped; the test folder is kept when they were not. */
  stopVerified: boolean;
  /** Whether a CLI process was started. */
  launched: boolean;
}

/** A Test the free checks refuse before any launch: the OS, root, or a `.cmd` the Runner cannot launch. */
export class CliWorkerTestRefusedError extends Error {
  readonly code: string;
  constructor(readonly check: CliWorkerCheck) {
    super(check.reason ?? `${check.displayName} cannot be tested here.`);
    this.name = "CliWorkerTestRefusedError";
    this.code = check.code ?? "cli_worker_refused";
  }
}

/** A Test the Runner's shutdown interrupted, or one asked for during it: nothing is saved as the CLI's outcome. */
export class CliWorkerShutdownError extends Error {
  readonly code = "runner_shutting_down";
  constructor() {
    super("AIBoard is shutting down, so the test did not finish; nothing was saved. Test again after AIBoard restarts.");
    this.name = "CliWorkerShutdownError";
  }
}

export class CliWorkerTestBusyError extends Error {
  readonly code = "cli_worker_test_running";
  constructor(providerId: CliWorkerProviderId) {
    super(`A test of ${CLI_WORKER_DISPLAY_NAMES[providerId]} is already running.`);
    this.name = "CliWorkerTestBusyError";
  }
}

/** `at`: when the check finished (its 60 s start then). `stale`: a Test ran since, so the next read checks again. */
interface CacheEntry { key: string; at: number; check: Promise<CliWorkerCheck>; settled: boolean; stale: boolean }

/**
 * One check as CW4's `CliWorkerFreeCheck`: `refused` and `unavailable` are `unhealthy`, with the reason as the
 * failure (agy's spent quota keeps its `usage_limit` kind and stated reset); `unknown` keeps its reason as the note.
 */
export function cliWorkerFreeCheckEntry(check: CliWorkerCheck): CliWorkerFreeCheck {
  const executable = check.executable ? { executable: { path: check.executable.path, form: check.executable.form } } : {};
  const version = check.version ? { version: check.version } : {};
  if (check.status === "ready") return { providerId: check.providerId, status: "ready", ...executable, ...version };
  if (check.status === "unknown") {
    return { providerId: check.providerId, status: "unknown", ...executable, ...version, ...(check.reason ? { note: check.reason } : {}) };
  }
  const message = check.reason ?? `${check.displayName} can't run as a worker here.`;
  return { providerId: check.providerId, status: "unhealthy", ...executable, ...version, failure: check.failure ?? { kind: "authentication", message } };
}

export class CliWorkerDetection {
  private readonly cache = new Map<CliWorkerProviderId, CacheEntry>();
  private readonly testing = new Set<CliWorkerProviderId>();
  /** Every process session open now (a check's or a Test's), so a shutdown can stop them. */
  private readonly sessions = new Set<CliWorkerProcessSession>();
  private readonly running = new Set<Promise<unknown>>();
  private closing = false;

  constructor(private readonly options: CliWorkerDetectionOptions) {}

  /** The folder lookups and probes run from: Runner-owned and empty, never a worktree (§3.2, CW2's lookup note). */
  get lookupFolder(): string { return join(this.options.stateDirectory, "cli-workers", "lookup"); }
  /** Where Test folders are made: `<state>/cli-worker-tests/<random>/` (§3.4). */
  get testsFolder(): string { return join(this.options.stateDirectory, "cli-worker-tests"); }

  /** `GET /v2/cli-workers`: every CLI's free check, each cached for 60 s unless `refresh`. */
  async list(options: { refresh?: boolean } = {}): Promise<{ checkedAt: string; platform: NodeJS.Platform; workers: CliWorkerCheck[] }> {
    const paths = await this.homeExecutablePaths();
    const workers = await Promise.all(CLI_WORKER_PROVIDER_IDS.map(async (providerId) => {
      const executablePath = paths[providerId];
      const key = executablePath ?? "";
      const cached = this.cache.get(providerId);
      // A check still running is joined, Refresh included, so a second click starts no second set of probes.
      if (cached && cached.key === key && (!cached.settled || (!options.refresh && !cached.stale && this.now() - cached.at < CLI_WORKER_CHECK_CACHE_MS)))
        return await cached.check;
      const check = this.check(providerId, executablePath === undefined ? {} : { executablePath });
      const entry: CacheEntry = { key, at: this.now(), check, settled: false, stale: false };
      this.cache.set(providerId, entry);
      try {
        return await check;
      } catch (error) {
        if (this.cache.get(providerId) === entry) this.cache.delete(providerId);
        throw error;
      } finally {
        entry.at = this.now();
        entry.settled = true;
      }
    }));
    return { checkedAt: new Date(this.now()).toISOString(), platform: this.platform, workers };
  }

  /** One CLI's free check (§3.2), uncached. CW4's Build-start check calls this. */
  readonly check: CliWorkerCheckFunction = async (providerId, options = {}) => {
    if (this.closing) {
      return { providerId, displayName: CLI_WORKER_DISPLAY_NAMES[providerId], checkedAt: new Date(this.now()).toISOString(),
        status: "unknown", code: "probe_failed", reason: "AIBoard is shutting down, so the CLI was not checked." };
    }
    return await this.during(this.runCheck(providerId, options));
  };

  /**
   * Counts `work` as running until it settles, so the Runner's shutdown waits for it. The routes run a whole Test
   * request through it, answer included, so a shutdown's own answer reaches the client before the server closes.
   */
  async during<T>(work: Promise<T>): Promise<T> {
    this.running.add(work);
    try {
      return await work;
    } finally {
      this.running.delete(work);
    }
  }

  private async runCheck(providerId: CliWorkerProviderId, options: CliWorkerCheckOptions): Promise<CliWorkerCheck> {
    const checkedAt = new Date(this.now()).toISOString();
    const base = { providerId, displayName: CLI_WORKER_DISPLAY_NAMES[providerId], checkedAt };
    const platformRefusal = cliWorkerPlatformRefusal(providerId, this.platform);
    if (platformRefusal) return { ...base, status: "refused", code: "platform_refused", reason: platformRefusal };
    const rootRefusal = this.isRoot() ? cliWorkerRootRefusal(providerId) : undefined;
    if (rootRefusal) return { ...base, status: "refused", code: "root_refused", reason: rootRefusal };

    const unavailable = (code: CliWorkerCheckCode, reason: string, extra: Partial<CliWorkerCheck> = {}, kind: ProviderFailure["kind"] = "authentication"): CliWorkerCheck =>
      ({ ...base, ...extra, status: "unavailable", code, reason, failure: { kind, message: reason } });

    await mkdir(this.lookupFolder, { recursive: true, mode: 0o700 });
    const resolved = await resolveCliExecutable({
      providerId,
      ...(options.executablePath !== undefined ? { executablePath: options.executablePath } : {}),
      lookup: this.options.lookup,
      cwd: this.lookupFolder,
      platform: this.platform,
      ...(this.options.inspect ? { inspect: this.options.inspect } : {}),
    });
    const name = CLI_WORKER_DISPLAY_NAMES[providerId];
    if (resolved.status === "missing") {
      return unavailable("not_installed", resolved.source === "home"
        ? `${name} is not at the path set in Settings.`
        : `${name} is not installed, or not on this Runner's PATH.`);
    }
    if (resolved.status === "refused") return unavailable("executable_refused", resolved.reason);
    if (resolved.status === "unknown") return { ...base, status: "unknown", code: "executable_unknown", reason: resolved.reason };
    const executable = { path: resolved.path, source: resolved.source, form: resolved.form };

    if (this.platform === "win32" && (await this.options.windowsJobContainment?.()) !== "verified") {
      // A fact of this host, not the CLI's login: `provider_unavailable` marks it unhealthy with a 5-minute cooldown
      // (CW4 checks again at each Build start and resume), never the 24 h cooldown of `authentication`.
      return unavailable("job_containment_unavailable", `This PC can't run ${name} as a worker: Windows did not pass AIBoard's check that a Job object holds a CLI and everything it starts.`, { executable }, "provider_unavailable");
    }

    if (executable.form === "cmd") {
      const refusal = await this.cmdRefusal(providerId, executable.path, options.worktreeFolder);
      if (refusal) return unavailable(refusal.code, refusal.reason, { executable });
    }

    return await this.probe(providerId, executable, base);
  }

  /** `POST /v2/cli-workers/<providerId>/test` (§3.4). The caller ends the provider's cooldowns on `passed`. */
  async test(providerId: CliWorkerProviderId, request: CliWorkerTestRequest): Promise<CliWorkerTestResult> {
    if (request.model !== null && (!isCliArgumentValue(request.model) || request.model === "default"))
      throw new TypeError("model must be null (the CLI default) or a model id of A-Z a-z 0-9 . _ : / -.");
    if (request.reasoningEffort !== undefined && !isCliArgumentValue(request.reasoningEffort))
      throw new TypeError("reasoningEffort must be A-Z a-z 0-9 . _ : / -.");
    if (this.closing) throw new CliWorkerShutdownError();
    if (this.testing.has(providerId)) throw new CliWorkerTestBusyError(providerId);
    this.testing.add(providerId);
    try {
      return await this.during(this.runTest(providerId, request));
    } finally {
      this.testing.delete(providerId);
      // The Test may have changed what the checks find (a login it reported, say). A check still running is kept, so
      // a Refresh joins it, and is read again once it settles.
      const cached = this.cache.get(providerId);
      if (cached) cached.stale = true;
    }
  }

  /**
   * The Runner's shutdown, before the execution host closes: no new Test starts, every open check and Test session is
   * stopped (each stop is still proven or not, as always), and what was running settles. A Test it interrupts answers
   * `runner_shutting_down` and saves nothing, unless its stop could not be proven: that is saved as `timed_out` with
   * its folder kept, as always.
   */
  async close(): Promise<void> {
    this.closing = true;
    for (const session of [...this.sessions]) void session.close().catch(() => undefined);
    // What `during` adds while this waits (a Test's answer after its run) is waited for too.
    while (this.running.size > 0) await Promise.allSettled([...this.running]);
  }

  /**
   * CW4's seam (native-build-factory.ts `cliWorkerFreeChecks`): each requested CLI's free check, uncached, at a
   * Build's start and each resume. It never rejects: a check that throws is `unknown` with its reason. CW4 applies
   * its own `.cmd` rules to the launch folders on what this returns.
   */
  readonly freeChecks: CliWorkerFreeChecks = async ({ providerIds, signal }) => {
    const homePaths = await this.homeExecutablePaths().catch(() => ({} as Partial<Record<CliWorkerProviderId, string>>));
    return await Promise.all(providerIds.map(async (providerId): Promise<CliWorkerFreeCheck> => {
      if (signal?.aborted) return { providerId, status: "unknown", note: "The check was cancelled." };
      try {
        const executablePath = homePaths[providerId];
        return cliWorkerFreeCheckEntry(await this.check(providerId, executablePath === undefined ? {} : { executablePath }));
      } catch (error) {
        return { providerId, status: "unknown", note: scrubCliMessage(`${CLI_WORKER_DISPLAY_NAMES[providerId]}'s check failed: ${errorText(error)}`) };
      }
    }));
  };

  // -------------------------------------------------------------------------------------------------------------

  private get platform(): NodeJS.Platform { return this.options.platform ?? process.platform; }
  private now(): number { return (this.options.now ?? Date.now)(); }
  private isRoot(): boolean {
    if (this.options.isRoot) return this.options.isRoot();
    return typeof process.getuid === "function" && process.getuid() === 0;
  }

  private async homeExecutablePaths(): Promise<Partial<Record<CliWorkerProviderId, string>>> {
    if (!this.options.home) return {};
    const snapshot = await readAiboardHome(this.options.home, { credentials: false });
    const workers = snapshot.config.cliWorkers ?? {};
    const paths: Partial<Record<CliWorkerProviderId, string>> = {};
    for (const providerId of CLI_WORKER_PROVIDER_IDS) {
      const entry = workers[providerId];
      if (entry && typeof entry.executablePath === "string") paths[providerId] = entry.executablePath;
    }
    return paths;
  }

  /** §3.2 and §3.5's open point: a `.cmd` CLI is refused here, before any launch, with its reason. */
  private async cmdRefusal(providerId: CliWorkerProviderId, path: string, worktreeFolder?: string): Promise<{ code: CliWorkerCheckCode; reason: string } | undefined> {
    const file = path.split(/[\\/]/).at(-1) ?? path;
    if (providerId === "claude-code") {
      return { code: "cmd_shim_schema", reason: `Claude Code's npm shim (${file}) can't carry its result schema; install the native claude.exe.` };
    }
    const fact = await this.options.windowsBatchArgv?.();
    if (fact !== "verified") {
      return { code: "cmd_launch_unavailable", reason: `This PC can't launch .cmd CLIs: Windows did not pass AIBoard's check that a .cmd gets its arguments intact. Install ${CLI_WORKER_DISPLAY_NAMES[providerId]}'s .exe instead of ${file}.` };
    }
    const refusal = cliWorkerCmdArgumentRefusal({ providerId, file, stateDirectory: this.options.stateDirectory, ...(worktreeFolder !== undefined ? { worktreeFolder } : {}) });
    return refusal ? { code: "cmd_argument_unsafe", reason: refusal } : undefined;
  }

  /**
   * The free probes of one CLI, in one session from the lookup folder. Their output counts only after the session's
   * stop is proven. Readiness is decided by the login: a version or an agy `/quota` that does not parse is left out
   * of the result, never a reason to call the CLI unready.
   */
  private async probe(
    providerId: CliWorkerProviderId,
    executable: NonNullable<CliWorkerCheck["executable"]>,
    base: Pick<CliWorkerCheck, "providerId" | "displayName" | "checkedAt">,
  ): Promise<CliWorkerCheck> {
    const adapter = CLI_WORKER_ADAPTERS[providerId];
    const name = adapter.displayName;
    const failed = (reason: string, extra: Partial<CliWorkerCheck> = {}): CliWorkerCheck =>
      ({ ...base, executable, ...extra, status: "unknown", code: "probe_failed", reason });
    let session: CliWorkerProcessSession;
    try {
      session = await this.options.processes.open({ purpose: "check", workingDirectory: this.lookupFolder });
    } catch (error) {
      return failed(`${name}'s checks could not start: ${errorText(error)}`);
    }
    this.sessions.add(session);
    // A shutdown that began while this session was opening has already gone through the open sessions.
    if (this.closing) void session.close().catch(() => undefined);
    const runs = new Map<string, Promise<CliProbeOutput>>();
    const probe = (args: readonly string[]): Promise<CliProbeOutput> => {
      const key = JSON.stringify(args);
      let run = runs.get(key);
      if (!run) {
        run = this.runProbe(session, executable.path, args);
        runs.set(key, run);
      }
      return run;
    };
    let collected: { version?: string; login: CliLoginState; models: CliModelList; quota?: AgyQuotaGroup[] } | undefined;
    let error: unknown;
    try {
      // Both settle before anything fails: a probe still starting when the other failed would otherwise start after
      // the session's close began.
      const settled = await Promise.allSettled([probe(adapter.freeChecks.version), probe(adapter.freeChecks.login)]);
      for (const result of settled) if (result.status === "rejected") throw result.reason;
      const [versionOutput, loginOutput] = settled.map((result) => (result as PromiseFulfilledResult<CliProbeOutput>).value) as [CliProbeOutput, CliProbeOutput];
      const version = versionOutput.exitCode === 0 ? parseCliVersionOutput(versionOutput.stdout) : undefined;
      const login = adapter.parseLogin(loginOutput);
      const models = await adapter.listModels(probe);
      let quota: AgyQuotaGroup[] | undefined;
      if (adapter.freeChecks.quota && login.status === "logged_in") {
        try {
          const output = await probe(adapter.freeChecks.quota);
          quota = output.exitCode === 0 ? parseAgyQuota(output.stdout, this.now()) : undefined;
        } catch {
          quota = undefined;
        }
      }
      collected = { ...(version ? { version } : {}), login, models, ...(quota ? { quota } : {}) };
    } catch (caught) {
      error = caught;
    }
    // Every probe's stop is proven before anything they printed is used (a timed-out probe is stopped here too).
    try {
      await session.close();
      this.sessions.delete(session);
    } catch {
      return failed(`${name}'s check processes could not be proven stopped, so AIBoard does not trust their output.`);
    }
    if (!collected) return failed(`${name}'s checks could not run: ${errorText(error)}`);
    const { version, login, models, quota } = collected;
    const found = {
      executable,
      ...(version ? { version } : {}),
      login,
      models: models.models,
      modelsSource: models.source,
      ...(models.note ? { modelsNote: models.note } : {}),
    };
    if (login.status === "logged_out") {
      const reason = `${name} is not logged in. Log in with the CLI in a terminal, then check again.`;
      return { ...base, ...found, status: "unavailable", code: "not_logged_in", reason, failure: { kind: "authentication", message: reason } };
    }
    if (login.status === "unknown") {
      return { ...base, ...found, status: "unknown", code: "login_unknown", reason: `AIBoard could not tell whether ${name} is logged in.` };
    }
    if (quota) {
      const failure = agyQuotaFailure(quota, this.now());
      if (failure) return { ...base, ...found, quota, status: "unavailable", code: "usage_limit", reason: failure.message, failure };
      return { ...base, ...found, quota, status: "ready" };
    }
    return { ...base, ...found, status: "ready" };
  }

  /** One free probe (§3.2): 8 s, output cut, stdin closed at once. The session's close stops and proves it. */
  private async runProbe(session: CliWorkerProcessSession, path: string, args: readonly string[]): Promise<CliProbeOutput> {
    const command = this.command(path, args);
    const started = await session.start({ executable: command.executable, args: command.arguments });
    try { await started.closeInput(); } catch { /* it exited before reading stdin */ }
    // The bound starts once the probe runs, as it always did; a re-read below gets only what is left of it.
    const deadline = Date.now() + (this.options.probeTimeoutMs ?? CLI_WORKER_PROBE_TIMEOUT_MS);
    let output = await readUntil(started, deadline - Date.now(), () => false);
    // A probe that printed more than the live tail before its first read (`codex debug models`, about 0.8 MB at once)
    // lost its start to the live reads, so its JSON could not parse. Once it exited, its whole output is read again
    // from the first byte, within the same bound; a probe still running is read as it is (it did not finish).
    if (output.gap && output.exited) {
      started.rewind();
      output = await readUntil(started, deadline - Date.now(), () => false);
      // Still a gap: the output passed even the finalized record's bound, so its start stays unknown.
      if (output.gap) return { exitCode: null, stdout: "", stderr: output.stderr };
    }
    return { exitCode: output.exited ? output.exitCode : null, stdout: output.stdout, stderr: output.stderr };
  }

  private command(path: string, args: readonly string[]): { executable: string; arguments: readonly string[] } {
    return this.options.command ? this.options.command(path, args) : { executable: path, arguments: [...args] };
  }

  private async runTest(providerId: CliWorkerProviderId, request: CliWorkerTestRequest): Promise<CliWorkerTestResult> {
    const adapter = CLI_WORKER_ADAPTERS[providerId];
    const name = adapter.displayName;
    const executablePath = (await this.homeExecutablePaths())[providerId];
    const check = await this.check(providerId, executablePath === undefined ? {} : { executablePath });
    const at = new Date(this.now()).toISOString();
    const cliVersion = check.version && isCliVersion(check.version) ? check.version : "unknown";
    const saved = async (outcome: CliTestOutcome, message: string | undefined, extra: { resetsAt?: string; stopVerified?: boolean; launched?: boolean } = {}): Promise<CliWorkerTestResult> => {
      const lastTest: HomeCliWorkerTestV1 = {
        at, cliVersion, modelId: request.model, outcome,
        ...(extra.resetsAt ? { resetsAt: extra.resetsAt } : {}),
        ...(message ? { message: scrubCliMessage(message) } : {}),
      };
      await this.saveLastTest(providerId, lastTest);
      return { lastTest, stopVerified: extra.stopVerified ?? true, launched: extra.launched ?? false };
    };

    // Outcomes the free checks already decide, without a launch.
    if (this.closing) throw new CliWorkerShutdownError();
    if (check.status === "refused" || (check.code && check.code.startsWith("cmd_")) || check.code === "executable_refused" || check.code === "job_containment_unavailable")
      throw new CliWorkerTestRefusedError(check);
    if (check.code === "not_installed") return await saved("not_installed", check.reason);
    if (check.code === "not_logged_in") return await saved("not_logged_in", check.reason);
    // A login the check could not read is what the Test finds out; any other undecided check is not tested.
    if ((check.status === "unknown" && check.code !== "login_unknown") || !check.executable) throw new CliWorkerTestRefusedError(check);
    if (providerId === "agy" && check.quota) {
      // agy's stated quota for the model under test (§3.4): its id maps to the name `agy models` lists.
      const modelName = request.model === null ? undefined : check.models?.find((model) => model.id === request.model)?.name;
      const failure = request.model === null || modelName ? agyQuotaFailure(check.quota, this.now(), modelName) : undefined;
      if (failure) return await saved("usage_limit", failure.message, resetFrom(failure, this.now()));
    }

    // §3.4: an empty Runner-owned folder; the schema and Codex's -o file sit beside it, never in it.
    const folder = join(this.testsFolder, randomBytes(8).toString("hex"));
    const work = join(folder, "work");
    const schemaPath = join(folder, "result.schema.json");
    const outputPath = join(folder, "result.json");
    await mkdir(work, { recursive: true, mode: 0o700 });
    // Kept unless no process ran in it, or every process that did was proven stopped.
    let keepFolder = false;
    try {
      const model = request.model;
      const effort = request.reasoningEffort === undefined ? {} : { reasoningEffort: request.reasoningEffort };
      const spec: CliLaunchSpec = providerId === "codex-cli"
        ? { providerId, mode: "test", model, ...effort, schemaPath, outputPath, worktree: work }
        : providerId === "claude-code"
          ? { providerId, mode: "test", model, ...effort, schemaJson: cliWorkerResultSchemaJson(), sessionId: randomUUID() }
          : { providerId, mode: "test", model, ...effort, schemaPath };
      const args = buildCliWorkerArgs(spec);
      if (check.executable.form === "cmd" && windowsBatchShimRefusedArguments(args).length) {
        throw new CliWorkerTestRefusedError({ ...check, status: "unavailable", code: "cmd_argument_unsafe",
          reason: `${name} is a .cmd, and this test's arguments have a character a .cmd argument can't carry.` });
      }
      if (adapter.schemaDelivery === "file") await writeFile(schemaPath, cliWorkerResultSchemaJson(), { mode: 0o600 });

      if (this.closing) throw new CliWorkerShutdownError();
      const session = await this.options.processes.open({ purpose: "test", workingDirectory: work });
      keepFolder = true;
      this.sessions.add(session);
      // A shutdown that began while this session was opening has already gone through the open sessions.
      if (this.closing) void session.close().catch(() => undefined);
      const run = await this.runTestProcess(session, providerId, check.executable.path, args, outputPath);
      keepFolder = !run.stopVerified;
      if (run.stopVerified) this.sessions.delete(session);
      // A shutdown stopped the CLI under the Test: whatever it printed or how it ended is not its outcome.
      if (this.closing && run.stopVerified) throw new CliWorkerShutdownError();
      // A start or read that failed, after the stop was proven: the folder goes, and the Test is saved as a CLI that
      // could not be used (the outcomes have no "could not start"; the message says what happened). The process
      // host's own error may speak of cleanup it has since proven, so it is only logged.
      if (run.failure) {
        console.warn(`[runner] a ${name} test could not run: ${describe(run.failure.error)}`);
        return await saved("not_installed", `${name} could not be started for the test; anything it started was stopped. Check its installation, then test again.`, { launched: true });
      }
      if (!run.stopVerified) {
        return await saved("timed_out", `${name}'s test processes could not be proven stopped; the test folder is kept for cleanup.`,
          { stopVerified: false, launched: true });
      }
      const { outcome, message, resetsAt } = testOutcome(name, run.reading, run.stderr, this.now());
      return await saved(outcome, message, { ...(resetsAt ? { resetsAt } : {}), launched: true });
    } finally {
      if (!keepFolder) {
        try {
          await rm(folder, { recursive: true, force: true });
        } catch (error) {
          // The result stands; a folder Windows held open stays behind (its processes were proven stopped).
          console.warn(`[runner] a ${name} test folder could not be removed (${folder}): ${describe(error)}`);
        }
      }
    }
  }

  /**
   * The Test's one process: the prompt on stdin, then output until the CLI delivers its result (Claude Code, agy), it
   * exits (Codex, whose -o file is complete only then), or the time runs out. Then the session's stop, which must be
   * proven before anything is read as the CLI's outcome. It never throws: a start or read that failed is returned as
   * `failure`, after the stop was tried, so the caller decides about the folder from `stopVerified` alone.
   */
  private async runTestProcess(session: CliWorkerProcessSession, providerId: CliWorkerProviderId, path: string, args: readonly string[], outputPath: string): Promise<{ reading: CliRunReading; stderr: string; stopVerified: boolean; failure?: { error: unknown } }> {
    const adapter = CLI_WORKER_ADAPTERS[providerId];
    let reader: ReturnType<typeof adapter.createStreamReader> | undefined;
    let stderr = "";
    let exitCode: number | null = null;
    let error: unknown;
    let failed = false;
    try {
      reader = adapter.createStreamReader();
      const live = reader;
      const command = this.command(path, args);
      const started = await session.start({ executable: command.executable, args: command.arguments });
      try {
        await started.closeInput(buildCliWorkerStdin(providerId, CLI_WORKER_TEST_PROMPT));
      } catch {
        // The CLI closed its input before reading the prompt (it refused its arguments, or exited): what it printed
        // and its exit say why, so the run is read as usual.
      }
      const turnEnds = adapter.resultDelivery === "result_event" ? () => live.turnEnded : () => false;
      const output = await readUntil(started, this.options.testTimeoutMs ?? CLI_WORKER_TEST_TIMEOUT_MS, turnEnds, (chunk) => live.push(chunk));
      stderr = output.stderr;
      if (output.exited) exitCode = output.exitCode;
      else if (!live.turnEnded) live.noteRunnerStop("deadline");
    } catch (caught) {
      failed = true;
      error = caught;
    }
    let stopVerified = true;
    try {
      await session.close();
    } catch {
      stopVerified = false;
    }
    const stopped: CliRunReading = { outcome: { type: "stopped", reason: "cancelled" }, turnEnded: false };
    if (!stopVerified) return { reading: stopped, stderr, stopVerified };
    if (failed || !reader) return { reading: stopped, stderr, stopVerified, failure: { error } };
    reader.end();
    let outputFile: string | null = null;
    if (adapter.resultDelivery === "exit_output_file") {
      try { outputFile = (await readFile(outputPath, "utf8")).slice(0, CLI_PROBE_OUTPUT_MAX_CHARS); } catch { outputFile = null; }
    }
    return { reading: reader.read({ exitCode, stderr, outputFile, now: this.now() }), stderr, stopVerified };
  }

  private async saveLastTest(providerId: CliWorkerProviderId, lastTest: HomeCliWorkerTestV1): Promise<void> {
    const home = this.options.home;
    if (!home) return;
    for (let attempt = 0; ; attempt += 1) {
      const snapshot = await readAiboardHome(home, { credentials: false });
      try {
        await applyHomeBatch(home, { baseRevision: snapshot.revision, ops: [{ path: `cliWorkers.${providerId}`, op: "merge", value: { lastTest } }] });
        return;
      } catch (error) {
        if (error instanceof AiboardHomeError && error.code === "home_conflict" && attempt === 0) continue;
        throw error;
      }
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers

/**
 * §3.5's open point, for a Codex or agy `.cmd`: both Windows launchers refuse a `.cmd` argument with
 * `" % ! ^ & | < > ( )` or a line break, so the Runner-built arguments are built with this Runner's real folders
 * (the worker form and the Test form) and checked with `windowsBatchShimRefusedArguments` before any launch. Codex
 * takes its worktree as `-C <worktree>`; agy's worktree is only its working folder, never an argument. Returns the
 * refusal's reason, or undefined when every argument can pass.
 */
export function cliWorkerCmdArgumentRefusal(input: {
  providerId: Exclude<CliWorkerProviderId, "claude-code">;
  /** The `.cmd` file's name, for the reason. */
  file: string;
  stateDirectory: string;
  /** CW4: the project's worktree folder. */
  worktreeFolder?: string;
}): string | undefined {
  const { providerId, file } = input;
  const folder = join(input.stateDirectory, "cli-workers", "run", "session");
  const testFolder = join(input.stateDirectory, "cli-worker-tests", "0123456789abcdef");
  const forms: CliLaunchSpec[] = providerId === "codex-cli"
    ? [
        { providerId, mode: "worker", schemaPath: join(folder, "result.schema.json"), outputPath: join(folder, "result.json"), worktree: input.worktreeFolder ?? join(testFolder, "work") },
        { providerId, mode: "test", schemaPath: join(testFolder, "result.schema.json"), outputPath: join(testFolder, "result.json"), worktree: join(testFolder, "work") },
      ]
    : [
        { providerId, mode: "worker", schemaPath: join(folder, "result.schema.json") },
        { providerId, mode: "test", schemaPath: join(testFolder, "result.schema.json") },
      ];
  for (const spec of forms) {
    let args: string[];
    try {
      args = buildCliWorkerArgs(spec);
    } catch (error) {
      return `${file} can't be launched with this Runner's folders: ${error instanceof Error ? error.message : String(error)}`;
    }
    const refused = windowsBatchShimRefusedArguments(args);
    if (refused.length) {
      const value = args[refused[0]!]!;
      return `${file} can't be launched here: the folder ${value} has a character a .cmd argument can't carry (" % ! ^ & | < > ( )). ` +
        `Install ${CLI_WORKER_DISPLAY_NAMES[providerId]}'s .exe, or use folders without those characters.`;
    }
  }
  return undefined;
}

/** The Test's outcome class (§3.3 `lastTest.outcome`) for a CLI's reading. */
export function testOutcome(name: string, reading: CliRunReading, stderr: string, now: number): { outcome: CliTestOutcome; message?: string; resetsAt?: string } {
  const outcome = reading.outcome;
  if (outcome.type === "result") return { outcome: "passed" };
  if (outcome.type === "stopped") return { outcome: "timed_out", message: `${name} did not answer within the test's time limit.` };
  const failure = outcome.failure;
  switch (failure.kind) {
    case "usage_limit":
    case "rate_limit":
      return { outcome: "usage_limit", message: failure.message, ...resetFrom(failure, now) };
    case "authentication":
      return isCliModelUnavailableText(failure.message)
        ? { outcome: "model_unavailable", message: failure.message }
        : { outcome: "not_logged_in", message: failure.message };
    default:
      return { outcome: "unreadable_result", message: outcome.reason === "cli_error" ? failure.message : (failure.message || stderr) };
  }
}

/** A reset time only when the CLI stated one (cli-worker-failures sets `retryAfterMs` only then). */
function resetFrom(failure: ProviderFailure, now: number): { resetsAt?: string } {
  return failure.retryAfterMs === undefined ? {} : { resetsAt: new Date(now + failure.retryAfterMs).toISOString() };
}

/**
 * Reads a process until it exits (and its output was read to the end), `done()` holds, or `timeoutMs` passes. Each
 * stream is kept up to CLI_PROBE_OUTPUT_MAX_CHARS; `onStdout` sees every stdout chunk (the live stream reader).
 */
async function readUntil(started: CliWorkerProcess, timeoutMs: number, done: () => boolean, onStdout?: (chunk: string) => void): Promise<{ stdout: string; stderr: string; gap: boolean; exited: boolean; exitCode: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let stdout = "", stderr = "", gap = false;
  for (;;) {
    const remaining = deadline - Date.now();
    const output = await started.read(Math.max(0, Math.min(remaining, READ_WAIT_MS)));
    if (output.gap) gap = true;
    if (output.stdout) {
      onStdout?.(output.stdout);
      if (stdout.length < CLI_PROBE_OUTPUT_MAX_CHARS) stdout = (stdout + output.stdout).slice(0, CLI_PROBE_OUTPUT_MAX_CHARS);
    }
    if (output.stderr && stderr.length < CLI_PROBE_OUTPUT_MAX_CHARS) stderr = (stderr + output.stderr).slice(0, CLI_PROBE_OUTPUT_MAX_CHARS);
    if (output.exited) return { stdout, stderr, gap, exited: true, exitCode: output.exitCode };
    if (done() || Date.now() >= deadline) return { stdout, stderr, gap, exited: false, exitCode: null };
  }
}

function errorText(error: unknown): string {
  return scrubCliMessage(error instanceof Error ? error.message : String(error));
}
