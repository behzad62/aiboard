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
 * Every process here runs under the Runner-internal process kernel as a Runner-internal owner (as the browser
 * install button and the Git preflight do), from a Runner-owned folder, never a worktree or a project folder.
 *
 * CW4's Build-start check takes `CliWorkerFreeCheck` (the service's `check`) as an injected dependency.
 */

import { randomBytes, randomUUID } from "node:crypto";
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
import type { ProcessHostSemanticFact } from "./process-host-semantic-probes.js";
import type { ProviderFailure } from "./provider-health.js";
import type { RunnerInternalOwnedProcess, RunnerInternalProcessKernel } from "./runner-internal-process-kernel.js";
import { INVENTORY_VERSION_PROBE_TIMEOUT_MS } from "./verification-inventory.js";

/** §3.2: free-check results are cached this long; Settings' Refresh bypasses the cache. */
export const CLI_WORKER_CHECK_CACHE_MS = 60_000;
/** §3.2: one free probe, the tool inventory's version-probe bound. */
export const CLI_WORKER_PROBE_TIMEOUT_MS = INVENTORY_VERSION_PROBE_TIMEOUT_MS;
/** §3.4: the Test's one tiny prompt. */
export const CLI_WORKER_TEST_TIMEOUT_MS = 120_000;
/** Proving a stop: a graceful shutdown, then termination, each bounded as the browser install's. */
const SHUTDOWN_TIMEOUT_MS = 5_000;
const TERMINATION_TIMEOUT_MS = 15_000;
const POLL_INTERVAL_MS = 50;

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
  | "cmd_shim_schema"
  | "cmd_launch_unavailable"
  | "cmd_argument_unsafe"
  | "cmd_checks_unavailable"
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
export type CliWorkerFreeCheck = (providerId: CliWorkerProviderId, options?: CliWorkerCheckOptions) => Promise<CliWorkerCheck>;

// ---------------------------------------------------------------------------------------------------------------
// The service

/** What a launch of the CLI at `path` runs. Production: the path itself. Tests: node and the fake CLI script. */
export type CliWorkerCommand = (path: string, args: readonly string[]) => { executable: string; arguments: readonly string[] };

export interface CliWorkerDetectionOptions {
  /** The Runner's state folder: the lookup folder and the Test folders live under it. */
  stateDirectory: string;
  /** The Runner-internal process kernel (Runner-owned processes with a verified stop). */
  processes: Pick<RunnerInternalProcessKernel, "launch">;
  /** The environment the Runner gives its own processes (sensitive names already dropped). */
  environment: () => Readonly<Record<string, string>>;
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
   * Whether `processes` itself can launch a `.cmd`. The Runner-internal kernel cannot (its batch fact is always
   * `unavailable`), so in production a `.cmd` CLI's checks are reported as not run from Settings, never launched.
   */
  launcherRunsCmd?: boolean;
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

export class CliWorkerTestBusyError extends Error {
  readonly code = "cli_worker_test_running";
  constructor(providerId: CliWorkerProviderId) {
    super(`A test of ${CLI_WORKER_DISPLAY_NAMES[providerId]} is already running.`);
    this.name = "CliWorkerTestBusyError";
  }
}

interface CacheEntry { key: string; at: number; check: Promise<CliWorkerCheck> }

export class CliWorkerDetection {
  private readonly cache = new Map<CliWorkerProviderId, CacheEntry>();
  private readonly testing = new Set<CliWorkerProviderId>();

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
      if (!options.refresh && cached && cached.key === key && this.now() - cached.at < CLI_WORKER_CHECK_CACHE_MS) return await cached.check;
      const check = this.check(providerId, executablePath === undefined ? {} : { executablePath });
      const entry = { key, at: this.now(), check };
      this.cache.set(providerId, entry);
      try {
        return await check;
      } catch (error) {
        if (this.cache.get(providerId) === entry) this.cache.delete(providerId);
        throw error;
      }
    }));
    return { checkedAt: new Date(this.now()).toISOString(), platform: this.platform, workers };
  }

  /** One CLI's free check (§3.2), uncached. CW4's Build-start check calls this. */
  readonly check: CliWorkerFreeCheck = async (providerId, options = {}) => {
    const checkedAt = new Date(this.now()).toISOString();
    const base = { providerId, displayName: CLI_WORKER_DISPLAY_NAMES[providerId], checkedAt };
    const platformRefusal = cliWorkerPlatformRefusal(providerId, this.platform);
    if (platformRefusal) return { ...base, status: "refused", code: "platform_refused", reason: platformRefusal };
    const rootRefusal = this.isRoot() ? cliWorkerRootRefusal(providerId) : undefined;
    if (rootRefusal) return { ...base, status: "refused", code: "root_refused", reason: rootRefusal };

    const unavailable = (code: CliWorkerCheckCode, reason: string, extra: Partial<CliWorkerCheck> = {}): CliWorkerCheck =>
      ({ ...base, ...extra, status: "unavailable", code, reason, failure: { kind: "authentication", message: reason } });

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

    if (executable.form === "cmd") {
      const refusal = await this.cmdRefusal(providerId, executable.path, options.worktreeFolder);
      if (refusal) return unavailable(refusal.code, refusal.reason, { executable });
      if (!this.options.launcherRunsCmd) {
        return {
          ...base, executable, status: "unknown", code: "cmd_checks_unavailable",
          reason: `${name} is a .cmd here. Settings can't run its checks yet: AIBoard's own checks can't launch .cmd files. Install its .exe to check it here.`,
        };
      }
    }

    return await this.probe(providerId, executable, base);
  };

  /** `POST /v2/cli-workers/<providerId>/test` (§3.4). The caller ends the provider's cooldowns on `passed`. */
  async test(providerId: CliWorkerProviderId, request: CliWorkerTestRequest): Promise<CliWorkerTestResult> {
    if (request.model !== null && (!isCliArgumentValue(request.model) || request.model === "default"))
      throw new TypeError("model must be null (the CLI default) or a model id of A-Z a-z 0-9 . _ : / -.");
    if (request.reasoningEffort !== undefined && !isCliArgumentValue(request.reasoningEffort))
      throw new TypeError("reasoningEffort must be A-Z a-z 0-9 . _ : / -.");
    if (this.testing.has(providerId)) throw new CliWorkerTestBusyError(providerId);
    this.testing.add(providerId);
    try {
      return await this.runTest(providerId, request);
    } finally {
      this.testing.delete(providerId);
      this.cache.delete(providerId);
    }
  }

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

  private async probe(
    providerId: CliWorkerProviderId,
    executable: NonNullable<CliWorkerCheck["executable"]>,
    base: Pick<CliWorkerCheck, "providerId" | "displayName" | "checkedAt">,
  ): Promise<CliWorkerCheck> {
    const adapter = CLI_WORKER_ADAPTERS[providerId];
    const name = adapter.displayName;
    const runs = new Map<string, Promise<CliProbeOutput>>();
    let unverified = false;
    const probe = (args: readonly string[]): Promise<CliProbeOutput> => {
      const key = JSON.stringify(args);
      let run = runs.get(key);
      if (!run) {
        run = this.runProbe(executable.path, args).then((result) => {
          if (!result.stopVerified) unverified = true;
          return result.output;
        });
        runs.set(key, run);
      }
      return run;
    };
    const failed = (reason: string, extra: Partial<CliWorkerCheck> = {}): CliWorkerCheck =>
      ({ ...base, executable, ...extra, status: "unknown", code: "probe_failed", reason });

    let version: string | undefined;
    let login: CliLoginState;
    let models: CliModelList;
    try {
      const [versionOutput, loginOutput] = await Promise.all([probe(adapter.freeChecks.version), probe(adapter.freeChecks.login)]);
      version = versionOutput.exitCode === 0 ? parseCliVersionOutput(versionOutput.stdout) : undefined;
      login = adapter.parseLogin(loginOutput);
      models = await adapter.listModels(probe);
    } catch (error) {
      return failed(`${name}'s checks could not run: ${errorText(error)}`);
    }
    if (unverified) return failed(`${name}'s check processes could not be proven stopped, so AIBoard does not trust their output.`, version ? { version } : {});
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
    if (adapter.freeChecks.quota) {
      let groups: AgyQuotaGroup[] | undefined;
      try {
        const output = await probe(adapter.freeChecks.quota);
        groups = output.exitCode === 0 ? parseAgyQuota(output.stdout, this.now()) : undefined;
      } catch {
        groups = undefined;
      }
      if (unverified) return failed(`${name}'s check processes could not be proven stopped, so AIBoard does not trust their output.`, found);
      if (groups) {
        const failure = agyQuotaFailure(groups, this.now());
        if (failure) return { ...base, ...found, quota: groups, status: "unavailable", code: "usage_limit", reason: failure.message, failure };
        return { ...base, ...found, quota: groups, status: "ready" };
      }
    }
    return { ...base, ...found, status: "ready" };
  }

  /** One free probe (§3.2): 8 s, output cut, no stdin, from the lookup folder, its stop proven. */
  private async runProbe(path: string, args: readonly string[]): Promise<{ output: CliProbeOutput; stopVerified: boolean }> {
    const command = this.command(path, args);
    const id = randomUUID();
    const owned = await this.options.processes.launch({
      principalId: `cli-worker-check-${id}`,
      callId: `cli-worker-check-${id}`,
      runId: "runner-cli-worker-checks",
      kind: "command",
      executable: command.executable,
      arguments: command.arguments,
      workingDirectory: this.lookupFolder,
      environment: this.options.environment(),
      access: [],
    });
    const output = collectOutput(owned, CLI_PROBE_OUTPUT_MAX_CHARS);
    try { await owned.closeInput(); } catch { /* a command without stdin */ }
    const exited = await waitUntil(owned, this.options.probeTimeoutMs ?? CLI_WORKER_PROBE_TIMEOUT_MS, () => false);
    const stop = await proveStop(owned, !exited);
    output.stop();
    return {
      output: { exitCode: exited ? stop.exitCode ?? null : null, stdout: output.stdout(), stderr: output.stderr() },
      stopVerified: stop.verified,
    };
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
    if (check.status === "refused" || (check.code && check.code.startsWith("cmd_")) || check.code === "executable_refused")
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

      const run = await this.launchTest(providerId, check.executable.path, args, work, outputPath);
      keepFolder = !run.stopVerified;
      if (!run.stopVerified) {
        return await saved("timed_out", `${name}'s test processes could not be proven stopped; the test folder is kept for cleanup.`,
          { stopVerified: false, launched: true });
      }
      const { outcome, message, resetsAt } = testOutcome(name, run.reading, run.stderr, this.now());
      return await saved(outcome, message, { ...(resetsAt ? { resetsAt } : {}), launched: true });
    } finally {
      if (!keepFolder) await rm(folder, { recursive: true, force: true });
    }
  }

  private async launchTest(providerId: CliWorkerProviderId, path: string, args: readonly string[], work: string, outputPath: string): Promise<{ reading: CliRunReading; stderr: string; stopVerified: boolean }> {
    const adapter = CLI_WORKER_ADAPTERS[providerId];
    const command = this.command(path, args);
    const id = randomUUID();
    const owned = await this.options.processes.launch({
      principalId: `cli-worker-test-${id}`,
      callId: `cli-worker-test-${id}`,
      runId: "runner-cli-worker-tests",
      kind: "command",
      executable: command.executable,
      arguments: command.arguments,
      workingDirectory: work,
      environment: this.options.environment(),
      access: [],
    });
    const reader = adapter.createStreamReader();
    const decoder = new TextDecoder();
    const output = collectOutput(owned, CLI_PROBE_OUTPUT_MAX_CHARS, (chunk) => reader.push(decoder.decode(chunk, { stream: true })));
    let stopVerified = false;
    let exitCode: number | null = null;
    try {
      try {
        await owned.write(new TextEncoder().encode(buildCliWorkerStdin(providerId, CLI_WORKER_TEST_PROMPT)), 10_000);
        await owned.closeInput();
      } catch {
        // The CLI closed its input before reading the prompt (it refused its arguments, or exited): what it printed
        // and its exit say why, so the run is read as usual.
      }
      // Claude Code and agy deliver their result in a `result` event, which ends the turn even while a process
      // stays up; Codex's -o file is complete only at exit (§3.5 step 4).
      const turnEnds = adapter.resultDelivery === "result_event" ? () => reader.turnEnded : () => false;
      const exited = await waitUntil(owned, this.options.testTimeoutMs ?? CLI_WORKER_TEST_TIMEOUT_MS, turnEnds);
      if (!exited && !reader.turnEnded) reader.noteRunnerStop("deadline");
      const stop = await proveStop(owned, !exited && !reader.turnEnded);
      stopVerified = stop.verified;
      exitCode = exited ? stop.exitCode ?? null : null;
    } catch (error) {
      const stop = await proveStop(owned, true);
      stopVerified = stop.verified;
      output.stop();
      if (!stopVerified) return { reading: { outcome: { type: "stopped", reason: "cancelled" }, turnEnded: false }, stderr: "", stopVerified };
      throw error;
    }
    output.stop();
    reader.push(decoder.decode());
    reader.end();
    let outputFile: string | null = null;
    if (adapter.resultDelivery === "exit_output_file") {
      try { outputFile = (await readFile(outputPath, "utf8")).slice(0, CLI_PROBE_OUTPUT_MAX_CHARS); } catch { outputFile = null; }
    }
    const stderr = output.stderr();
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

interface CollectedOutput { stdout(): string; stderr(): string; stop(): void }

/** Keeps at most `max` characters of each stream; `onStdout` sees every stdout chunk (the live stream reader). */
function collectOutput(owned: RunnerInternalOwnedProcess, max: number, onStdout?: (chunk: Uint8Array) => void): CollectedOutput {
  const decoders = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  const text = { stdout: "", stderr: "" };
  const unsubscribe = owned.setOutputSink((metadata, bytes) => {
    const stream = metadata.stream === "stderr" ? "stderr" : "stdout";
    if (stream === "stdout") onStdout?.(bytes);
    if (text[stream].length >= max) return;
    text[stream] = (text[stream] + decoders[stream].decode(bytes, { stream: true })).slice(0, max);
  });
  let stopped = false;
  return {
    stdout: () => text.stdout,
    stderr: () => text.stderr,
    stop: () => {
      if (stopped) return;
      stopped = true;
      unsubscribe();
    },
  };
}

/** Polls until the process exits (true), `done()` holds, or the time runs out (false for both). */
async function waitUntil(owned: RunnerInternalOwnedProcess, timeoutMs: number, done: () => boolean): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await owned.reconcile()).state === "exited") return true;
    if (done() || Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

/** Stops the process and everything it started, and proves it. An unproven stop is reported, never thrown. */
async function proveStop(owned: RunnerInternalOwnedProcess, force: boolean): Promise<{ verified: boolean; exitCode?: number }> {
  try {
    const disposition = await owned.closeVerified({
      shutdownTimeoutMs: force ? 1 : SHUTDOWN_TIMEOUT_MS,
      terminationTimeoutMs: TERMINATION_TIMEOUT_MS,
      ...(force ? { forceImmediately: true } : {}),
    });
    return { verified: true, ...(disposition.exitCode !== undefined ? { exitCode: disposition.exitCode } : {}) };
  } catch {
    return { verified: false };
  }
}

function errorText(error: unknown): string {
  return scrubCliMessage(error instanceof Error ? error.message : String(error));
}
