/**
 * The CLI worker loop (docs/plans/2026-11-14-cli-workers.md §3.5, §3.7, §3.11, packet CW5): one attempt of a task by
 * Codex CLI (`codex-cli`), Claude Code (`claude-code`) or agy (`agy`), in place of the API worker's model loop.
 *
 * 1. Refusals before any launch: the CLI on this OS (§3.11), under root (§3.12), a Windows host whose Job containment
 *    is not verified, a `.cmd` the host cannot launch or whose exact argv a `.cmd` launcher refuses. Each is the
 *    Runner's own refusal (§3.11 case 1): the attempt fails with `process_launch_unproven:<code>` and the CLI's health
 *    is untouched; a second one in the same run pauses it with `process_launch_unproven_repeated:<code>`.
 * 2. Launch as the worker's owner, through the managed-process service (its Windows Job or POSIX group), in the task's
 *    worktree, with the prompt on stdin and `AIBOARD_MCP_DEPTH=2` for every process of that owner.
 * 3. Wait for the CLI's result (Claude Code's and agy's `result` event ends the turn, even while a background task
 *    keeps the process up) or its exit (Codex), the attempt's deadline, or the assignment's abort.
 * 4. Prove the stop of everything the owner started before anything is collected. An unproven stop never submits
 *    (§3.11 case 2): it returns `stop_unproven`, and #220's scheduler pause keeps the worktree claim. When the CLI had
 *    delivered its result or exited, the run is recorded `collected: false` first; once the stop is proven, the next
 *    run of the same attempt collects it from the Runner's result file without starting a CLI.
 * 5. Collect: undo the CLI's own commits, restore `docs/project`, compare the project folder, record
 *    `worker.cli_attempt_recorded`, and map the CLI's report onto the shared submit, ask and replan functions.
 *
 * The CLI's report is a claim. Only what the Runner runs itself is evidence (§3.6, CW6's re-runs).
 */

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentActor, ToolExecutionContext } from "./agent-contracts.js";
import type { CriterionEvidenceLink } from "./acceptance-contracts.js";
import { BudgetExceededError, type BudgetLedger } from "./budget-ledger.js";
import type { ChangeSet } from "./change-set.js";
import { LOCAL_MCP_DEPTH_LIMIT, type RunnerProcessEnvironment } from "./child-environment.js";
import {
  CLI_ATTEMPT_RECORD_ACTOR,
  CLI_ATTEMPT_RECORD_VERSION,
  CLI_ATTEMPT_RECORDED_EVENT_TYPE,
  boundedRecordText,
  parseCliAttemptRecord,
  type CliAttemptOutcomeKind,
  type CliAttemptRecord,
  type CliProjectChange,
} from "./cli-worker-attempt-record.js";
import {
  CLI_WORKER_ADAPTERS,
  CLI_WORKER_DISPLAY_NAMES,
  buildCliWorkerArgs,
  buildCliWorkerPrompt,
  buildCliWorkerStdin,
  cliExecutableMissingFailure,
  cliWorkerPlatformRefusal,
  cliWorkerResultSchemaJson,
  cliWorkerRootRefusal,
  windowsBatchShimRefusedArguments,
  type CliExecutableForm,
  type CliExecutableResolution,
  type CliLaunchSpec,
  type CliRunReading,
  type CliStreamReader,
} from "./cli-worker-adapters.js";
import { isCliVersion, type CliWorkerProviderId } from "./cli-worker-config.js";
import { cliProviderFailure } from "./cli-worker-failures.js";
import {
  CLI_CHECKS_RERUN_FAILED,
  CLI_FIX_ROUNDS,
  cliCheckGapFailure,
  cliCheckGaps,
  cliFixRoundPrompt,
  hasCliCheckGaps,
  type CliCheckRerun,
} from "./cli-worker-evidence.js";
import type { CliWorkerResultV1 } from "./cli-worker-result.js";
import type { WorkingTreeIdentity } from "./command-evidence-identity.js";
import type { PermissionProfile } from "./contracts.js";
import type { ExecutionGrantAuthority } from "./execution-grants.js";
import { publishLiveModelOutput } from "./live-model-output.js";
import type { ManagedProcessService } from "./managed-process.js";
import { MANAGED_OUTPUT_READ_MAX_BYTES, MANAGED_OUTPUT_WAIT_MAX_MS } from "./managed-process-contracts.js";
import { OwnedFenceLockUnavailableError } from "./owned-fence-lock.mjs";
import type { ProcessHostSemanticFact } from "./process-host-semantic-probes.js";
import { errorMessage, isProcessStopUnprovenError } from "./process-stop-proof.js";
import type { ProviderFailure } from "./provider-health.js";
import { runnerRunStateSegment } from "./run-state-identity.js";
import type { SchedulerStore } from "./scheduler-store.js";
import { redactSensitiveText } from "./sensitive-redaction.js";
import type { SqliteAgentSessionStore } from "./sqlite-agent-session-store.js";
import type { SettledWorkerOutcome } from "./task-scheduler.js";
import type { ValidationScope } from "./validation-scope.js";
import { requestArchitectGuidance, requestTaskReplan } from "./worker-lifecycle-tools.js";
import { submitWorkerTask, type WorkerSubmissionContext } from "./worker-runtime.js";
import { ForeignHistoryError, type ProjectFolderState, type TaskWorkspace, type WorkspaceManager } from "./workspace-manager.js";

// ---------------------------------------------------------------------------------------------------------------
// Seams

/** The exact owner every process of a worker attempt runs under (managed-process-transport.ts). */
export interface CliWorkerOwner {
  readonly runId: string;
  readonly sessionId: string;
  readonly actor: Readonly<AgentActor>;
}

/** What one read of the CLI's output returned since the previous read. */
export interface CliProcessOutput {
  stdout: string;
  stderr: string;
  /** Output that bounded retention no longer held was skipped: an unfinished line before it is broken. */
  gap: boolean;
  /** The process ended and its output was read to the end. */
  exited: boolean;
  exitCode: number | null;
}

export interface CliProcessHandle {
  readonly processId: string;
  /** Writes `text` to stdin; with `closeInput`, stdin is closed after it. */
  write(text: string, closeInput: boolean): Promise<void>;
  /** Waits up to `waitMs` for new output. */
  read(waitMs: number): Promise<CliProcessOutput>;
}

/**
 * Launches a CLI as the worker's owner, and stops that owner. Production runs it through `ManagedProcessService`
 * (createManagedCliProcessLauncher), so the CLI and its descendants run in the backend's containment (a Windows Job,
 * a POSIX group) and every process call carries its own grant.
 */
export interface CliProcessLauncher {
  start(input: { owner: CliWorkerOwner; executable: string; args: readonly string[]; cwd: string }): Promise<CliProcessHandle>;
  /** Stops every process the owner started and proves it; throws when the stop is not proven. */
  stopOwner(owner: CliWorkerOwner): Promise<void>;
}

/** The home's settings for one CLI, read when an attempt starts (§3.2, §3.3). */
export interface CliWorkerLaunchSettings {
  executable: CliExecutableResolution;
  /** The attempt's deadline: `maxMinutesPerAttempt` (CWD-6, default 90 minutes). */
  attemptLimitMs: number;
  /** Arguments put before the CLI's own (a test runs `node fake-cli.mjs`); production sets none. */
  argsPrefix?: readonly string[];
  /** The CLI's version, as the run's free checks recorded it. */
  version?: string;
}

export type CliWorkerLaunchSettingsSource = (providerId: CliWorkerProviderId) => Promise<CliWorkerLaunchSettings>;

/** The host facts a CLI launch is refused on (§3.11, §3.12, CW3's Job containment rule). */
export interface CliWorkerHostFacts {
  platform: NodeJS.Platform;
  isRoot: boolean;
  /** Windows: the batch-argv fact every `.cmd` launch reads. */
  windowsBatchArgv?: ProcessHostSemanticFact;
  /** Windows: CLI workers run only when this host's Job containment is verified. */
  jobContainment?: ProcessHostSemanticFact;
}

/** CW8: the owner's Playwright CLI session, started before the CLI. CW5 records what it reports. */
export interface CliBrowserSessions {
  start?(owner: CliWorkerOwner, signal?: AbortSignal): Promise<
    | { status: "started"; note: string }
    | { status: "none"; note?: string }
    | { status: "start_failed"; reason: string }
  >;
  /**
   * The browser check after the owner's processes are proven stopped (§3.10), read afresh: the owner folder's browsers
   * plus its known escapes (`PlaywrightCliSessions.checkOwnerBrowsers`, the check `removeRun` runs). `escaped` or
   * `unknown` leaves the stop unproven; a known escape stays so until a later check proves it gone.
   */
  checkAfterStop?(owner: CliWorkerOwner): Promise<"none" | "exited" | "escaped" | "unknown">;
  /** The PIDs of the owner's browsers the last check found still running, for the pause reason the owner reads. */
  escapedPids?(owner: CliWorkerOwner): readonly number[];
}

/**
 * CW6: the Runner's re-runs of the checks the CLI reported, as the assigned worker (§3.6); production is
 * `createCliCheckRerunner` (cli-worker-evidence.ts). A throw fails the attempt with `cli_checks_rerun_failed`.
 */
export type CliCheckRerunner = (input: {
  owner: CliWorkerOwner;
  workspace: TaskWorkspace;
  taskId: string;
  attempt: number;
  result: CliWorkerResultV1;
  /** The CLI ran without a browser (case 3): its browser checks are not run. */
  browserUnavailable: boolean;
  /** The task's criteria and validation budget, as the submission reads them. */
  submission: WorkerSubmissionContext;
  signal?: AbortSignal;
}) => Promise<{
  criterionEvidenceLinks: CriterionEvidenceLink[];
  notRun: { what: string; why: string }[];
  /** Each reported check as the Runner re-ran it; a failed one is a gap (§3.6). */
  reruns?: CliCheckRerun[];
  /** Files a re-run changed, which the Runner restored before the commit. */
  restoredPaths?: string[];
}>;

/**
 * Raises `AIBOARD_MCP_DEPTH` to the local MCP door's limit for every process of a CLI worker's owner (§3.11), from
 * before its launch until its stop is proven, so an `aiboard mcp serve` inside the CLI refuses by depth (and the
 * home commands refuse any depth of 1 or more). Composed into the run binding's per-owner environment
 * (child-environment.ts).
 */
export class CliWorkerOwners {
  private readonly owners = new Set<string>();

  register(owner: Pick<CliWorkerOwner, "runId" | "sessionId">): void { this.owners.add(ownerKey(owner)); }
  release(owner: Pick<CliWorkerOwner, "runId" | "sessionId">): void { this.owners.delete(ownerKey(owner)); }
  has(owner: Pick<CliWorkerOwner, "runId" | "sessionId">): boolean { return this.owners.has(ownerKey(owner)); }

  readonly environmentFor = (owner: { readonly runId: string; readonly sessionId: string }): RunnerProcessEnvironment | undefined =>
    this.owners.has(ownerKey(owner))
      ? Object.freeze({ values: Object.freeze({}), pathPrepend: Object.freeze([]), mcpDepth: LOCAL_MCP_DEPTH_LIMIT })
      : undefined;
}

function ownerKey(owner: Pick<CliWorkerOwner, "runId" | "sessionId">): string {
  return JSON.stringify([owner.runId, owner.sessionId]);
}

export interface CliWorkerRuntimeDeps {
  schedulerStore: SchedulerStore;
  sessions: SqliteAgentSessionStore;
  workspaceManager: WorkspaceManager;
  launcher: CliProcessLauncher;
  settings: CliWorkerLaunchSettingsSource;
  host: CliWorkerHostFacts;
  /** The Runner's state folder: the CLI's schema and result files go to `cli-workers/<run>/<session>/` there. */
  stateDirectory: string;
  /** A tree hash of a worktree's working files, built in a temporary index (command-evidence-identity.ts). */
  captureTree: (cwd: string) => Promise<WorkingTreeIdentity>;
  owners?: CliWorkerOwners;
  budgetLedger?: BudgetLedger;
  browser?: CliBrowserSessions;
  rerunChecks?: CliCheckRerunner;
  clock?: () => string;
  now?: () => number;
  /** How long one read waits for output; the deadline and the abort are checked between reads. */
  readWaitMs?: number;
  /**
   * Test seam only: the per-OS refusals (CW0b, cliWorkerPlatformRefusal). Production never sets it, so Codex CLI stays
   * refused on every OS; a test lifts it to run the Codex branch against the fake CLI.
   */
  platformRefusal?: (providerId: CliWorkerProviderId, platform: NodeJS.Platform) => string | undefined;
}

export interface CliWorkerRuntimeConfig {
  runtimeId: string;
  providerId: CliWorkerProviderId;
  /** null: the CLI's own default (no model flag). */
  model: string | null;
  reasoningEffort?: string;
}

export interface CliWorkerAttemptInput {
  runId: string;
  taskId: string;
  attempt: number;
  workerId: string;
  sessionId: string;
  owner: CliWorkerOwner;
  workspace: TaskWorkspace;
  config: CliWorkerRuntimeConfig;
  /** The same context pack text an API worker gets. */
  contextText: string;
  submission: WorkerSubmissionContext;
  signal?: AbortSignal;
}

export type CliWorkerAttemptResult =
  | { type: "submitted"; changeSet: ChangeSet }
  | { type: "guidance"; requestId: string }
  | { type: "provider_failure"; failure: ProviderFailure }
  | { type: "settled"; outcome: SettledWorkerOutcome }
  | { type: "stop_unproven"; reason: string; outcome: SettledWorkerOutcome };

// ---------------------------------------------------------------------------------------------------------------
// Codes

/** §3.11 case 1: the attempt fails with this prefix and the code; the CLI's health is untouched. */
export const PROCESS_LAUNCH_UNPROVEN_PREFIX = "process_launch_unproven:";
/** A second case 1 in the same run pauses it instead. */
export const PROCESS_LAUNCH_UNPROVEN_REPEATED_PREFIX = "process_launch_unproven_repeated:";
/** §3.11 case 2: the kept outcome of a CLI run whose result waits for a proven stop. */
export const CLI_COLLECT_PENDING_PREFIX = "cli_collect_pending:";
/** The worktree changed between the unproven stop and the collect: nothing is collected. */
export const CLI_COLLECT_WORKTREE_CHANGED = "cli_collect_worktree_changed";
/** The prompt did not reach the CLI's stdin (a write refused or past its limit); the stop was proven. */
export const CLI_STDIN_UNDELIVERED = "cli_stdin_undelivered";

class CliStdinUndeliveredError extends Error {
  readonly code = CLI_STDIN_UNDELIVERED;
  constructor(message: string) {
    super(message);
    this.name = "CliStdinUndeliveredError";
  }
}

/** A launch the Runner refuses itself, before anything starts (§3.11 case 1). */
export class CliLaunchRefusedError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "CliLaunchRefusedError";
  }
}

/** Coded Runner refusals that `ManagedProcessService.start` throws alone, after proving its own cleanup (CW5a). */
const RUNNER_LAUNCH_REFUSAL_CODES = new Set(["windows_batch_argv_unverified"]);

/**
 * The code of a start failure that is case 1 of §3.11: a Runner launch refusal the stop classifier does not mark.
 * `ManagedProcessService.start` throws a failure alone only after its exact cleanup proved the record stopped; an
 * unproven cleanup is an aggregate the classifier marks, and that is case 2 even when its first error is a refusal.
 * Decided by code or class, never by message text; anything else is not case 1.
 */
export function runnerLaunchRefusalCode(error: unknown): string | undefined {
  if (isProcessStopUnprovenError(error)) return undefined;
  if (error instanceof CliLaunchRefusedError) return error.code;
  if (error instanceof AggregateError) return undefined;
  // The OS-lock fence claim at launch ran out of its deadline or was unavailable (§3.11a).
  if (error instanceof OwnedFenceLockUnavailableError) return "owned_fence_unavailable";
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && RUNNER_LAUNCH_REFUSAL_CODES.has(code) ? code : undefined;
}

// ---------------------------------------------------------------------------------------------------------------
// The attempt

const DEFAULT_READ_WAIT_MS = 1_000;
const STDERR_KEEP = 64 * 1024;
/** One stdin write stays under ManagedProcessService's 64 KiB: 16 Ki UTF-16 units are at most 48 KiB of UTF-8. */
const STDIN_CHUNK_UNITS = 16 * 1024;
const OUTPUT_FILE_MAX_BYTES = 4 * 1024 * 1024;
const LIVE_TAIL_CHUNK_CHARS = 4_000;
/** Live turns of a CLI run are numbered apart from an API worker's turns in the same session. */
const LIVE_TURN_BASE = 1_000_000;
const CONCERN_MAX = 2_000;
const CONCERNS_MAX = 100;

/** The Runner's own record of one CLI run, written before its stop: the source a collect-on-resume reads. */
interface CliRunResultFile {
  version: 1;
  providerId: CliWorkerProviderId;
  runNumber: number;
  exitCode: number | null;
  exited: boolean;
  stoppedBy?: "deadline" | "cancelled";
  reading: CliRunReading;
  /** The task branch's tip before the CLI ran: what `undoForeignCommits` moves back to. */
  recordedTip: string;
  projectBefore: ProjectFolderState;
  browser?: CliAttemptRecord["browser"];
  cliVersion?: string;
}

interface Collectable {
  file: CliRunResultFile;
  resultDigest: string;
}

/** A run whose re-runs left a gap the CLI gets its fix round for (§3.6): the next run resumes its session. */
type CliRunResult = CliWorkerAttemptResult | { type: "fix_round" };

/**
 * One CLI attempt: refusals, launch, wait, verified stop, collect (§3.5), and the Runner's re-runs of the reported
 * checks (§3.6). A gap in them sends the CLI into its one fix round (CWD-3), a second run in the same call.
 */
export async function runCliWorkerAttempt(deps: CliWorkerRuntimeDeps, input: CliWorkerAttemptInput): Promise<CliWorkerAttemptResult> {
  // The fix round is counted from the attempt's durable records (submitCliResult), so this loop runs at most
  // 1 + CLI_FIX_ROUNDS times; the bound below only guards that count.
  for (let run = 0; ; run += 1) {
    const result = await runCliWorkerRun(deps, input);
    if (result.type !== "fix_round") return result;
    if (run >= CLI_FIX_ROUNDS) {
      return { type: "settled", outcome: { type: "failed", reason: `${CLI_CHECKS_RERUN_FAILED}: the CLI was sent into more fix rounds than it has.` } };
    }
  }
}

async function runCliWorkerRun(deps: CliWorkerRuntimeDeps, input: CliWorkerAttemptInput): Promise<CliRunResult> {
  const clock = deps.clock ?? (() => new Date().toISOString());
  const now = deps.now ?? Date.now;
  const { providerId } = input.config;
  const adapter = CLI_WORKER_ADAPTERS[providerId];
  const name = CLI_WORKER_DISPLAY_NAMES[providerId];

  // A submission this session already made is the attempt's outcome (a restart between its commit and its record).
  if (deps.sessions.events(input.sessionId).length === 0) {
    await deps.sessions.create({ sessionId: input.sessionId, runId: input.runId, actor: { role: "worker", id: input.workerId }, occurredAt: clock() });
  } else {
    const recovered = await deps.sessions.load(input.sessionId);
    if (recovered.status === "submitted" && recovered.changeSet) return { type: "submitted", changeSet: recovered.changeSet };
  }

  const folder = cliWorkerStateFolder(deps.stateDirectory, input.runId, input.sessionId);
  const records = cliAttemptRecords(deps.schedulerStore, input);

  // §3.11 case 2, once the stop was proven: collect what the CLI left, starting no CLI.
  const last = records.at(-1);
  if (last && !last.collected) return await collectPending(deps, input, last, records.length, folder, clock);

  if (input.signal?.aborted) return { type: "settled", outcome: { type: "paused", reason: "worker_cancelled" } };

  // §3.11 case 1: the Runner's own refusals, before anything starts.
  const settings = await deps.settings(providerId);
  const refusal = launchRefusal(deps.host, providerId, settings.executable, deps.platformRefusal ?? cliWorkerPlatformRefusal);
  if (refusal && "failure" in refusal) return refusal;
  if (refusal) return launchUnproven(deps.schedulerStore, input.runId, refusal.code);
  const executable = settings.executable as Extract<CliExecutableResolution, { status: "found" }>;

  const runNumber = records.length + 1;
  await mkdir(folder, { recursive: true });
  const schemaPath = join(folder, "result.schema.json");
  const outputPath = join(folder, "last-message.json");
  // An earlier run's Codex result is never read as this one's (CW2 also requires turn.completed in the stream).
  await rm(outputPath, { force: true });
  if (adapter.schemaDelivery === "file") await writeFile(schemaPath, `${cliWorkerResultSchemaJson()}\n`, "utf8");

  const resume = [...records].reverse().find((record) => record.providerId === providerId && record.cliSessionId)?.cliSessionId;
  // §3.6: the fix round's prompt, written for this run when the last run's re-runs left a gap. A CLI session that
  // cannot be resumed gets the task again before it.
  const fixRound = await readFixRound(folder, runNumber);
  const taskContext = fixRound === undefined ? input.contextText : resume ? fixRound : `${input.contextText}\n\n${fixRound}`;
  const args = buildCliWorkerArgs(launchSpec(input, { schemaPath, outputPath, worktree: input.workspace.path, resume }));
  const cmdRefusal = cmdLaunchRefusal(deps.host, executable.form, args);
  if (cmdRefusal) return launchUnproven(deps.schedulerStore, input.runId, cmdRefusal);

  // The tip and project state before this run, written before the launch: a Runner that stopped during the run (a crash,
  // a restart) runs it again with the tip recorded before the first launch, so the stopped CLI's commits are undone too.
  // §3.7: a worktree an earlier CLI left off the task branch is refused at every collect, so no CLI is started in it.
  try {
    await deps.workspaceManager.assertOnTaskBranch(input.workspace);
  } catch (error) {
    if (!(error instanceof ForeignHistoryError)) throw error;
    return { type: "settled", outcome: { type: "failed", reason: cliHistoryRefusal(error) } };
  }
  const { recordedTip, projectBefore } = await launchBaseline(deps, input, folder, runNumber);
  const usage = beginUsage(deps.budgetLedger, input, clock, runNumber);
  if (usage.exhausted !== undefined) return { type: "settled", outcome: { type: "paused", reason: `budget_exhausted:${usage.exhausted}` } };

  deps.owners?.register(input.owner);
  // The owner's depth registration ends in the finally unless a path below keeps it: a stop not proven yet (the
  // scheduler's retried stop releases it), or a run that goes on to its stop below. A throw anywhere, even before the
  // launch (the browser, the prompt), releases it.
  let keepOwner = false;
  let file: CliRunResultFile;
  let resultDigest: string;
  try {
    const browser = await startBrowser(deps.browser, input);
    const prompt = buildCliWorkerPrompt({ taskContext, ...(browser.note ? { browserNote: browser.note } : {}) });
    let handle: CliProcessHandle;
    try {
      handle = await deps.launcher.start({ owner: input.owner, executable: executable.path, args: [...(settings.argsPrefix ?? []), ...args], cwd: input.workspace.path });
    } catch (error) {
      const code = runnerLaunchRefusalCode(error);
      // A start failure the stop classifier marks keeps the owner's depth until the scheduler's retried stop proves it.
      if (!code) {
        keepOwner = isProcessStopUnprovenError(error);
        throw error;
      }
      // The managed start proved its own cleanup: nothing of this launch runs.
      return launchUnproven(deps.schedulerStore, input.runId, code);
    }
    try {
      const run = await waitForRun(deps, input, handle, adapter.createStreamReader(), adapter.resultDelivery,
        buildCliWorkerStdin(providerId, prompt), settings.attemptLimitMs, now, runNumber);
      // Codex's -o file is complete only at its exit (§3.5 step 4).
      const outputFile = providerId === "codex-cli" && run.exited ? await readBounded(outputPath) : undefined;
      const reading = run.reader.read({
        stderr: run.stderr,
        exitCode: run.exited ? run.exitCode : null,
        ...(outputFile !== undefined ? { outputFile } : {}),
        now: now(),
      });
      file = {
        version: 1, providerId, runNumber, exitCode: run.exited ? run.exitCode : null, exited: run.exited,
        ...(run.stoppedBy ? { stoppedBy: run.stoppedBy } : {}),
        reading, recordedTip, projectBefore,
        ...(browser.record ? { browser: browser.record } : {}),
        // Recorded only in the form the attempt record accepts; anything else is left out, never fails the record.
        ...(isCliVersion(settings.version) ? { cliVersion: settings.version } : {}),
      };
      usage.finish(reading.usage);
      resultDigest = await writeResultFile(join(folder, `run-${runNumber}.result.json`), file);
      keepOwner = true;
    } catch (error) {
      // The wait failed with the CLI started (its stdin, its output): nothing is collected, and the error stands only
      // once the owner's stop is proven.
      const stopFailure = await proveCliStop(deps, input.owner);
      if (stopFailure) {
        keepOwner = true;
        return {
          type: "stop_unproven",
          reason: `${name}'s run failed after its launch (${boundedRecordText(errorMessage(error), 500)}); the stop of its processes is not proven: ${stopFailure}`,
          outcome: { type: "failed", reason: "process_stop_unproven" },
        };
      }
      // The stop is proven: a prompt that never reached the CLI is the Runner's coded failure. It is not a provider
      // failure, so the CLI's health and cooldown stay as they are.
      if (error instanceof CliStdinUndeliveredError) {
        return { type: "settled", outcome: { type: "failed", reason: `${CLI_STDIN_UNDELIVERED}: ${boundedRecordText(error.message, 500)}` } };
      }
      throw error;
    }
  } finally {
    usage.finish();
    if (!keepOwner) deps.owners?.release(input.owner);
  }

  // The stop: everything the owner started, proven, and the browser it ran (§3.10). Only a verified stop collects.
  const stopFailure = await proveCliStop(deps, input.owner);
  if (stopFailure) {
    if (file.reading.turnEnded || file.exited) {
      const worktree = await worktreeIdentity(deps, input.workspace).catch(() => undefined);
      // A record the store refuses (the run ended, the attempt moved on) keeps nothing to collect: failed below.
      const recorded = worktree !== undefined && (() => {
        try {
          appendRecord(deps.schedulerStore, input, clock, {
            ...recordBase(input, file), collected: false, resultDigest, worktree, stopFailure: boundedRecordText(stopFailure) || "not proven",
          });
          return true;
        } catch {
          return false;
        }
      })();
      if (recorded) {
        const exit = file.exited ? `${name} exited with code ${file.exitCode ?? "unknown"}` : `${name} delivered its result while its process was still running`;
        return {
          type: "stop_unproven",
          reason: `${exit}${file.stoppedBy ? ` after the Runner's ${file.stoppedBy} signal` : ""}; the stop of its processes is not proven: ${stopFailure}`,
          outcome: { type: "paused", reason: `${CLI_COLLECT_PENDING_PREFIX}${input.taskId}` },
        };
      }
    }
    return {
      type: "stop_unproven",
      reason: `${name} ${file.stoppedBy ? `was stopped by the Runner's ${file.stoppedBy}` : "was still running"} without a result; the stop of its processes is not proven: ${stopFailure}`,
      outcome: { type: "failed", reason: "process_stop_unproven" },
    };
  }
  deps.owners?.release(input.owner);
  return await collect(deps, input, { file, resultDigest }, clock);
}

/**
 * The branch tip and project-folder state a run is measured against. A run's launch record is written once, before its
 * CLI starts; finding one means that run started before and has no attempt record, so the Runner stopped during it.
 * Its baseline is kept, and a result file it may have left (never recorded, so never digested) is removed.
 */
async function launchBaseline(deps: CliWorkerRuntimeDeps, input: CliWorkerAttemptInput, folder: string, runNumber: number):
  Promise<{ recordedTip: string; projectBefore: ProjectFolderState }> {
  const path = join(folder, `run-${runNumber}.launch.json`);
  let text: string | undefined;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (text !== undefined) {
    const earlier = JSON.parse(text) as { recordedTip?: unknown; projectBefore?: Partial<ProjectFolderState> };
    const state = earlier.projectBefore;
    if (typeof earlier.recordedTip !== "string" || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(earlier.recordedTip) || !state ||
      typeof state.head !== "string" || typeof state.index !== "string" || typeof state.status !== "string") {
      throw new Error(`The CLI run's launch record ${path} cannot be read.`);
    }
    await rm(join(folder, `run-${runNumber}.result.json`), { force: true });
    return { recordedTip: earlier.recordedTip, projectBefore: { head: state.head, index: state.index, status: state.status } };
  }
  // §3.7: the baseline or the Runner's own last commit, never HEAD, so commits an earlier CLI run left are undone too.
  const recordedTip = await deps.workspaceManager.runnerTip(input.workspace);
  const projectBefore = await deps.workspaceManager.projectFolderState();
  await writeFile(path, `${JSON.stringify({ version: 1, recordedTip, projectBefore })}
`, { encoding: "utf8", flag: "wx" });
  return { recordedTip, projectBefore };
}

/** §3.6: the fix round's text for run `runNumber`, written by the run before it (writeFixRound), if any. */
async function readFixRound(folder: string, runNumber: number): Promise<string | undefined> {
  let text: string;
  try {
    text = await readFile(join(folder, `run-${runNumber}.fix.json`), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  const parsed = JSON.parse(text) as { version?: unknown; prompt?: unknown };
  if (parsed.version !== 1 || typeof parsed.prompt !== "string" || !parsed.prompt.trim()) {
    throw new Error(`The CLI run's fix-round record ${join(folder, `run-${runNumber}.fix.json`)} cannot be read.`);
  }
  return parsed.prompt;
}

/**
 * Written before the fix round's run starts, so a Runner that stops in between (a crash, a restart) still runs the
 * fix round, not the task again.
 */
async function writeFixRound(folder: string, runNumber: number, prompt: string): Promise<void> {
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, `run-${runNumber}.fix.json`), `${JSON.stringify({ version: 1, prompt })}\n`, "utf8");
}

/** The Runner-owned folder of one worker session's CLI files (§3.5 step 2), outside the worktree. */
export function cliWorkerStateFolder(stateDirectory: string, runId: string, sessionId: string): string {
  return join(stateDirectory, "cli-workers", runnerRunStateSegment(runId), runnerRunStateSegment(sessionId));
}

/**
 * Stops the CLI owner's processes and checks the browser record of that stop (§3.10). Returns why the stop is not
 * proven, or undefined when it is. The driver's `retryStop` runs the same check for a CLI attempt.
 */
export async function proveCliStop(deps: Pick<CliWorkerRuntimeDeps, "launcher" | "browser">, owner: CliWorkerOwner): Promise<string | undefined> {
  try {
    await deps.launcher.stopOwner(owner);
  } catch (error) {
    return errorMessage(error);
  }
  let browser: Awaited<ReturnType<NonNullable<CliBrowserSessions["checkAfterStop"]>>> | undefined;
  try {
    browser = await deps.browser?.checkAfterStop?.(owner);
  } catch {
    browser = "unknown";
  }
  if (browser === "escaped") {
    // The owner's way out: stop that browser, then Resume. Its PIDs, so the owner need not read the Runner's log.
    let pids: readonly number[] = [];
    try { pids = deps.browser?.escapedPids?.(owner) ?? []; } catch { /* the reason still stands without them */ }
    return `the browser the CLI's session ran is still running (${pids.length ? `PID${pids.length > 1 ? "s" : ""} ${pids.slice(0, 16).join(", ")}` : "its PIDs are in the Runner's log"}); stop it, then Resume`;
  }
  if (browser === "unknown") {
    return "the browser the CLI's session ran is not known to be stopped: the Runner could not read its processes (the Runner's log names what it found); Resume checks again";
  }
  return undefined;
}

/** The CLI runs of this attempt and session, oldest first. */
export function cliAttemptRecords(store: SchedulerStore, input: Pick<CliWorkerAttemptInput, "runId" | "taskId" | "attempt" | "sessionId">): CliAttemptRecord[] {
  return store.readRun(input.runId)
    .filter((event) => event.type === CLI_ATTEMPT_RECORDED_EVENT_TYPE)
    .map((event) => parseCliAttemptRecord(event.payload))
    .filter((record) => record.taskId === input.taskId && record.attempt === input.attempt && record.sessionId === input.sessionId);
}

function launchRefusal(host: CliWorkerHostFacts, providerId: CliWorkerProviderId, executable: CliExecutableResolution,
  platformRefusal: (providerId: CliWorkerProviderId, platform: NodeJS.Platform) => string | undefined):
  { code: string } | { type: "provider_failure"; failure: ProviderFailure } | undefined {
  if (platformRefusal(providerId, host.platform)) return { code: "cli_worker_platform_refused" };
  if (host.isRoot && cliWorkerRootRefusal(providerId)) return { code: "cli_worker_root_refused" };
  // CW3's rule (§3.11): on Windows a CLI runs only inside a Job this host verified it can hold.
  if (host.platform === "win32" && host.jobContainment !== "verified") return { code: "job_containment_unverified" };
  // The executable is gone, or the home names one AIBoard does not launch: the owner must fix the setup (§3.8).
  if (executable.status === "missing") return { type: "provider_failure", failure: cliExecutableMissingFailure(providerId) };
  if (executable.status === "refused") return { type: "provider_failure", failure: cliProviderFailure("authentication", executable.reason, Date.now()) };
  if (executable.status === "unknown") return { code: "cli_executable_unknown" };
  return undefined;
}

/**
 * A `.cmd` CLI on Windows (§3.2, §3.5's open point): the host must launch `.cmd` files at all, and the exact argv must
 * hold none of the characters both Windows launchers refuse in a `.cmd` argument. A launch they refuse throws an
 * uncoded error, which is not case 1, so it must never be reached: it is refused here with a code.
 */
function cmdLaunchRefusal(host: CliWorkerHostFacts, form: CliExecutableForm, args: readonly string[]): string | undefined {
  if (host.platform !== "win32" || form !== "cmd") return undefined;
  if (host.windowsBatchArgv !== "verified") return "windows_batch_argv_unverified";
  return windowsBatchShimRefusedArguments(args).length > 0 ? "cli_launch_argv_unsafe" : undefined;
}

/** Case 1: `failed` the first time in the run, `paused` after (§3.11). */
function launchUnproven(store: SchedulerStore, runId: string, code: string): CliWorkerAttemptResult {
  const earlier = store.readRun(runId).some((event) => event.type === "task.transitioned" &&
    String((event.payload.patch as { failureReason?: unknown } | undefined)?.failureReason ?? "").startsWith(PROCESS_LAUNCH_UNPROVEN_PREFIX));
  return earlier
    ? { type: "settled", outcome: { type: "paused", reason: `${PROCESS_LAUNCH_UNPROVEN_REPEATED_PREFIX}${code}` } }
    : { type: "settled", outcome: { type: "failed", reason: `${PROCESS_LAUNCH_UNPROVEN_PREFIX}${code}` } };
}

function launchSpec(input: CliWorkerAttemptInput, paths: { schemaPath: string; outputPath: string; worktree: string; resume?: string }): CliLaunchSpec {
  const common = {
    mode: "worker" as const,
    model: input.config.model,
    ...(input.config.reasoningEffort !== undefined ? { reasoningEffort: input.config.reasoningEffort } : {}),
  };
  switch (input.config.providerId) {
    case "codex-cli":
      return { providerId: "codex-cli", ...common, schemaPath: paths.schemaPath, outputPath: paths.outputPath, worktree: paths.worktree,
        ...(paths.resume ? { resumeThreadId: paths.resume } : {}) };
    case "claude-code":
      return { providerId: "claude-code", ...common, schemaJson: cliWorkerResultSchemaJson(), sessionId: paths.resume ?? randomUUID(),
        ...(paths.resume ? { resume: true } : {}) };
    case "agy":
      return { providerId: "agy", ...common, schemaPath: paths.schemaPath, ...(paths.resume ? { resumeConversationId: paths.resume } : {}) };
  }
}

/** One budget-ledger entry per CLI run (§3.5 step 9): tokens when the CLI reported them, cost 0, and its active time. */
function beginUsage(ledger: BudgetLedger | undefined, input: CliWorkerAttemptInput, clock: () => string, runNumber: number):
  { exhausted?: string; finish(usage?: { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; totalInputTokens: number }): void } {
  if (!ledger) return { finish() {} };
  // One reservation per launch: a run the Runner stopped during (a crash, a restart, a wait that failed after its proven
  // stop) is launched again under the same run number and its own usage, so a key of the run number alone would settle
  // the same reservation twice with different amounts, which the ledger refuses as an idempotency conflict.
  const reservationId = `cli:${input.sessionId}:${runNumber}:${randomUUID()}`;
  try {
    ledger.reserve({
      scopeId: input.runId, reservationId, kind: "model",
      attribution: { runtimeId: input.config.runtimeId, providerId: input.config.providerId, modelId: input.config.model ?? "default", role: "worker", sessionId: input.sessionId, taskId: input.taskId },
      costBasis: { kind: "account_not_metered" },
      estimate: { inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 },
      occurredAt: clock(), idempotencyKey: `reserve:${reservationId}`,
    });
  } catch (error) {
    if (error instanceof BudgetExceededError) return { exhausted: error.message, finish() {} };
    throw error;
  }
  const segmentId = `active:${reservationId}`;
  ledger.startActive({ scopeId: input.runId, segmentId, occurredAt: clock(), idempotencyKey: `start:${segmentId}` });
  let settled = false;
  return {
    finish(usage) {
      if (settled) return;
      settled = true;
      const read = usage?.cacheReadTokens ?? 0, written = usage?.cacheWriteTokens ?? 0;
      ledger.settle({
        scopeId: input.runId, reservationId,
        actual: {
          inputTokens: usage ? Math.max(0, usage.totalInputTokens - read - written) : 0,
          cachedInputTokens: read, cacheWriteInputTokens: written,
          outputTokens: usage?.outputTokens ?? 0, estimatedCostMicros: 0,
        },
        tokenSources: { inputTokens: usage ? "reported" : "estimated", outputTokens: usage ? "reported" : "estimated" },
        costBasis: { kind: "account_not_metered" },
        occurredAt: clock(), idempotencyKey: `settle:${reservationId}`,
      });
      ledger.stopActive({ scopeId: input.runId, segmentId, occurredAt: clock(), idempotencyKey: `stop:${segmentId}` });
    },
  };
}

async function startBrowser(sessions: CliBrowserSessions | undefined, input: CliWorkerAttemptInput):
  Promise<{ note?: string; record?: CliAttemptRecord["browser"] }> {
  if (!sessions?.start) return {};
  // §3.11 case 3: a session that does not start is recorded; the CLI runs without a browser and the run never pauses.
  let started: Awaited<ReturnType<NonNullable<CliBrowserSessions["start"]>>>;
  try {
    started = await sessions.start(input.owner, input.signal);
  } catch (error) {
    started = { status: "start_failed", reason: errorMessage(error) };
  }
  if (started.status === "started") return { note: started.note, record: { status: "started" } };
  if (started.status === "none") return { ...(started.note ? { note: started.note } : {}), record: { status: "none" } };
  return {
    note: "No browser is running for this task: the Runner could not start its Playwright CLI session, so browser checks are not run.",
    record: { status: "start_failed", reason: boundedRecordText(started.reason, 300) },
  };
}

interface RunWait {
  reader: CliStreamReader;
  stderr: string;
  exited: boolean;
  exitCode: number | null;
  stoppedBy?: "deadline" | "cancelled";
}

async function waitForRun(
  deps: CliWorkerRuntimeDeps,
  input: CliWorkerAttemptInput,
  handle: CliProcessHandle,
  reader: CliStreamReader,
  delivery: "exit_output_file" | "result_event",
  stdin: string,
  limitMs: number,
  now: () => number,
  runNumber: number,
): Promise<RunWait> {
  const live = liveTail(input, runNumber);
  const deadline = now() + limitMs;
  const chunks = stdinChunks(stdin);
  for (let index = 0; index < chunks.length; index += 1) {
    try {
      await handle.write(chunks[index]!, index === chunks.length - 1);
    } catch (error) {
      // Each write has ManagedProcessService's fixed limit (MANAGED_INPUT_WRITE_TIMEOUT_MS). A CLI that has not started
      // reading its stdin when the pipe buffer is full (a slow start) can reach it: the Runner's failure, not the CLI's.
      throw new CliStdinUndeliveredError(`The prompt's write ${index + 1} of ${chunks.length} to the CLI's stdin was not delivered: ${errorMessage(error)}`);
    }
  }
  let stderr = "";
  let exited = false;
  let exitCode: number | null = null;
  let stoppedBy: RunWait["stoppedBy"];
  try {
    for (;;) {
      if (input.signal?.aborted) {
        if (reader.noteRunnerStop("cancelled")) stoppedBy = "cancelled";
        break;
      }
      const remaining = deadline - now();
      if (remaining <= 0) {
        if (reader.noteRunnerStop("deadline")) stoppedBy = "deadline";
        break;
      }
      const page = await handle.read(Math.max(0, Math.min(deps.readWaitMs ?? DEFAULT_READ_WAIT_MS, remaining)));
      // A skipped stretch breaks the line it cut; the reader drops that line, never misreads it.
      if (page.gap) reader.push("\n");
      if (page.stdout) {
        reader.push(page.stdout);
        live.delta(page.stdout);
      }
      if (page.stderr) stderr = (stderr + page.stderr).slice(-STDERR_KEEP);
      if (page.exited) {
        exited = true;
        exitCode = page.exitCode;
        break;
      }
      // Claude Code's and agy's result event ends the turn, even while a background task keeps the process up.
      if (delivery === "result_event" && reader.turnEnded) break;
    }
  } finally {
    reader.end();
    live.finish();
  }
  return { reader, stderr, exited, exitCode, ...(stoppedBy ? { stoppedBy } : {}) };
}

/** The prompt on stdin in writes ManagedProcessService accepts, never splitting a surrogate pair. */
export function stdinChunks(text: string): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(text.length, start + STDIN_CHUNK_UNITS);
    const code = text.charCodeAt(end - 1);
    if (end < text.length && code >= 0xd800 && code <= 0xdbff) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks.length ? chunks : [""];
}

/** Run details' live tail (live-model-output.ts): the CLI's stdout as it arrives, redacted and bounded. */
function liveTail(input: CliWorkerAttemptInput, runNumber: number) {
  const identity = { runId: input.runId, sessionId: input.sessionId, actor: { role: "worker" as const, id: input.workerId }, turn: LIVE_TURN_BASE + runNumber, attempt: 1 };
  publishLiveModelOutput({ ...identity, phase: "reset", text: "" });
  return {
    delta(text: string) {
      for (let start = 0; start < text.length; start += LIVE_TAIL_CHUNK_CHARS) {
        const piece = redactSensitiveText(text.slice(start, start + LIVE_TAIL_CHUNK_CHARS), LIVE_TAIL_CHUNK_CHARS);
        if (piece) publishLiveModelOutput({ ...identity, phase: "delta", text: piece, channel: "tool" });
      }
    },
    finish() { publishLiveModelOutput({ ...identity, phase: "finish", text: "" }); },
  };
}

async function readBounded(path: string): Promise<Uint8Array | null> {
  try {
    const bytes = await readFile(path);
    return bytes.byteLength <= OUTPUT_FILE_MAX_BYTES ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

async function writeResultFile(path: string, file: CliRunResultFile): Promise<string> {
  const text = `${JSON.stringify(file)}\n`;
  await writeFile(path, text, { encoding: "utf8", flag: "wx" });
  return createHash("sha256").update(text).digest("hex");
}

async function worktreeIdentity(deps: CliWorkerRuntimeDeps, workspace: TaskWorkspace): Promise<{ head: string; tree?: string }> {
  const head = await deps.workspaceManager.workspaceHead(workspace);
  const tree = await deps.captureTree(workspace.path);
  return { head, ...(tree.status === "known" ? { tree: tree.treeId } : {}) };
}

function recordBase(input: CliWorkerAttemptInput, file: CliRunResultFile): Omit<CliAttemptRecord, "collected"> {
  const reading = file.reading;
  const outcome: CliAttemptOutcomeKind = reading.outcome.type === "result" ? reading.outcome.result.outcome
    : reading.outcome.type === "failure" ? "failure" : "stopped";
  const summary = reading.outcome.type === "result" ? reading.outcome.result.summary
    : reading.outcome.type === "failure" ? reading.outcome.failure.message : undefined;
  return {
    version: CLI_ATTEMPT_RECORD_VERSION,
    taskId: input.taskId, attempt: input.attempt, workerId: input.workerId, sessionId: input.sessionId,
    runtimeId: input.config.runtimeId, providerId: input.config.providerId,
    ...(file.cliVersion ? { cliVersion: file.cliVersion } : {}),
    ...(input.config.model ? { model: input.config.model } : {}),
    ...(reading.model ? { reportedModel: reading.model } : {}),
    ...(reading.sessionId ? { cliSessionId: reading.sessionId } : {}),
    exitCode: file.exitCode,
    ...(file.stoppedBy ? { stoppedBy: file.stoppedBy } : {}),
    outcome,
    ...(reading.outcome.type === "failure" ? { failureKind: reading.outcome.failure.kind } : {}),
    ...(summary?.trim() ? { summary: boundedRecordText(redactSensitiveText(summary, 4_000)) } : {}),
    ...(reading.usage ? { usage: { ...reading.usage } } : {}),
    ...(file.browser ? { browser: { ...file.browser } } : {}),
  };
}

function appendRecord(store: SchedulerStore, input: CliWorkerAttemptInput, clock: () => string, record: CliAttemptRecord): void {
  const index = cliAttemptRecords(store, input).length + 1;
  store.append({
    runId: input.runId,
    type: CLI_ATTEMPT_RECORDED_EVENT_TYPE,
    occurredAt: clock(),
    actor: { ...CLI_ATTEMPT_RECORD_ACTOR },
    idempotencyKey: `cli-attempt:${input.taskId}:${input.attempt}:${input.sessionId}:${index}`,
    payload: parseCliAttemptRecord(record) as unknown as Record<string, unknown>,
  });
}

/** §3.11 case 2, second Resume: the stop was proven; collect from the Runner's result file if nothing changed since. */
async function collectPending(
  deps: CliWorkerRuntimeDeps,
  input: CliWorkerAttemptInput,
  pending: CliAttemptRecord,
  runNumber: number,
  folder: string,
  clock: () => string,
): Promise<CliRunResult> {
  // Collected only after a proven stop, proven here too rather than trusted to the caller's retried stop.
  const stopFailure = await proveCliStop(deps, input.owner);
  if (stopFailure) {
    return {
      type: "stop_unproven",
      reason: `the stop of the CLI's processes is still not proven: ${stopFailure}`,
      outcome: { type: "paused", reason: `${CLI_COLLECT_PENDING_PREFIX}${input.taskId}` },
    };
  }
  const changed = (what: string): CliWorkerAttemptResult =>
    ({ type: "settled", outcome: { type: "failed", reason: `${CLI_COLLECT_WORKTREE_CHANGED}: ${what}` } });
  let text: string;
  try {
    text = await readFile(join(folder, `run-${runNumber}.result.json`), "utf8");
  } catch {
    return changed("the Runner's result file for the CLI's run is missing");
  }
  const resultDigest = createHash("sha256").update(text).digest("hex");
  if (resultDigest !== pending.resultDigest) return changed("the Runner's result file for the CLI's run differs from its recorded digest");
  let file: CliRunResultFile;
  try {
    file = JSON.parse(text) as CliRunResultFile;
  } catch {
    return changed("the Runner's result file for the CLI's run cannot be read");
  }
  if (file.version !== 1 || file.providerId !== input.config.providerId || file.runNumber !== runNumber) {
    return changed("the Runner's result file belongs to another CLI run");
  }
  const now = await worktreeIdentity(deps, input.workspace).catch(() => undefined);
  if (!now) return changed("the worktree as it is now could not be read");
  if (now.head !== pending.worktree!.head) return changed(`HEAD is ${now.head}, not ${pending.worktree!.head} as the CLI left it`);
  if (!pending.worktree!.tree || !now.tree) return changed("the working files' tree hash could not be built, so they cannot be compared");
  if (now.tree !== pending.worktree!.tree) return changed(`the working files differ from what the CLI left (tree ${now.tree}, not ${pending.worktree!.tree})`);
  deps.owners?.release(input.owner);
  return await collect(deps, input, { file, resultDigest }, clock);
}

/**
 * §3.7: the coded failure the Architect sees (task_failure_resolution_required) when the CLI left the task branch's
 * history so the Runner cannot take its work. A history the CLI rewrote or merged into fails this run only. A worktree
 * left off the task branch (detached, another branch, an unsettled operation) is kept as the CLI left it, files
 * included, and every later CLI run in it is refused before its launch: the work needs a new task (a new worktree).
 */
export function cliHistoryRefusal(error: ForeignHistoryError): string {
  const offBranch = error.kind === "detached" || error.kind === "other_branch" || error.kind === "unsettled";
  return `${error.code}:${error.kind}: ${error.message}${offBranch
    ? " The task's worktree is kept as the CLI left it, and no CLI run is started in it again; replan the work as a new task."
    : ""}`;
}

/** §3.5 steps 6 and 7: after a proven stop. */
async function collect(deps: CliWorkerRuntimeDeps, input: CliWorkerAttemptInput, collectable: Collectable, clock: () => string): Promise<CliRunResult> {
  const { file, resultDigest } = collectable;
  const name = CLI_WORKER_DISPLAY_NAMES[file.providerId];
  let replacedCliCommits = 0;
  let rewritten: string | undefined;
  try {
    replacedCliCommits = (await deps.workspaceManager.undoForeignCommits(input.workspace, file.recordedTip)).replacedCommits;
  } catch (error) {
    if (!(error instanceof ForeignHistoryError)) throw error;
    rewritten = cliHistoryRefusal(error);
  }
  const restoredProjectDocs = rewritten === undefined ? await deps.workspaceManager.restoreProjectDocs(input.workspace) : [];
  const projectAfter = await deps.workspaceManager.projectFolderState();
  const projectChangedDuringAttempt = (["head", "index", "status"] as const)
    .filter((key) => file.projectBefore[key] !== "unknown" && projectAfter[key] !== "unknown" && file.projectBefore[key] !== projectAfter[key]);
  appendRecord(deps.schedulerStore, input, clock, {
    ...recordBase(input, file), collected: true, resultDigest,
    ...(replacedCliCommits > 0 ? { replacedCliCommits } : {}),
    ...(restoredProjectDocs.length ? { restoredProjectDocs: restoredProjectDocs.slice(0, 64) } : {}),
    ...(projectChangedDuringAttempt.length ? { projectChangedDuringAttempt: [...projectChangedDuringAttempt] } : {}),
  });
  // §3.7: the CLI rewrote or left the task branch's history; nothing is submitted and the worktree stays as it is.
  if (rewritten !== undefined) return { type: "settled", outcome: { type: "failed", reason: rewritten } };

  const outcome = file.reading.outcome;
  if (outcome.type === "failure") return { type: "provider_failure", failure: outcome.failure };
  if (outcome.type === "stopped") {
    return outcome.reason === "cancelled"
      ? { type: "settled", outcome: { type: "paused", reason: "worker_cancelled" } }
      : { type: "settled", outcome: { type: "failed", reason: `cli_attempt_deadline: ${name} did not finish within its time limit for one attempt.` } };
  }
  const result = outcome.result;
  const requester = { runId: input.runId, workerId: input.workerId, taskId: input.taskId, clock };
  if (result.outcome === "needs_decision") {
    const answer = requestArchitectGuidance(deps.schedulerStore, requester, {
      requestId: `cli-${input.taskId}-${input.attempt}-${file.runNumber}`,
      question: `${result.question?.trim() || result.summary.trim() || "The CLI asked for a decision without a question."}\n\n(Asked by the ${name} worker: ${result.summary.trim() || "no summary"})`,
      blocking: true,
    });
    return await guidanceResult(deps, input, answer, clock);
  }
  if (result.outcome === "cannot_do") {
    const answer = requestTaskReplan(deps.schedulerStore, requester, {
      requestId: `cli-${input.taskId}-${input.attempt}-${file.runNumber}`,
      reason: "scope_exceeded",
      summary: `${name} cannot do this task as planned: ${result.replanReason ?? result.summary}`.slice(0, 4_000),
      proposedChange: result.summary.trim().slice(0, 4_000) || "See the reason.",
    });
    return await guidanceResult(deps, input, answer, clock);
  }
  return await submitCliResult(deps, input, file, result, { restoredProjectDocs, projectChangedDuringAttempt: [...projectChangedDuringAttempt], replacedCliCommits }, clock);
}

async function guidanceResult(deps: CliWorkerRuntimeDeps, input: CliWorkerAttemptInput, answer: ReturnType<typeof requestArchitectGuidance>, clock: () => string): Promise<CliWorkerAttemptResult> {
  if (answer.isError) return { type: "settled", outcome: { type: "failed", reason: `cli_guidance_refused: ${answer.error?.message ?? "the request was refused"}` } };
  const lifecycle = answer.lifecycle;
  if (!lifecycle || (lifecycle.type !== "ask_architect" && lifecycle.type !== "request_replan")) {
    return { type: "settled", outcome: { type: "failed", reason: "cli_guidance_refused: no blocking request was recorded" } };
  }
  deps.sessions.suspend(input.sessionId, "waiting_for_architect", lifecycle.requestId, clock());
  return { type: "guidance", requestId: lifecycle.requestId };
}

async function submitCliResult(
  deps: CliWorkerRuntimeDeps,
  input: CliWorkerAttemptInput,
  file: CliRunResultFile,
  result: CliWorkerResultV1,
  facts: { restoredProjectDocs: string[]; projectChangedDuringAttempt: CliProjectChange[]; replacedCliCommits: number },
  clock: () => string,
): Promise<CliRunResult> {
  const name = CLI_WORKER_DISPLAY_NAMES[file.providerId];
  let reruns: Awaited<ReturnType<CliCheckRerunner>> = { criterionEvidenceLinks: [], notRun: [] };
  if (deps.rerunChecks) {
    try {
      reruns = await deps.rerunChecks({
        owner: input.owner, workspace: input.workspace, taskId: input.taskId, attempt: input.attempt, result,
        browserUnavailable: file.browser?.status !== "started", submission: input.submission, ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch (error) {
      // A re-run whose own stop is not proven keeps its classification: the scheduler keeps the claim and pauses.
      if (isProcessStopUnprovenError(error)) throw error;
      return { type: "settled", outcome: { type: "failed", reason: `${CLI_CHECKS_RERUN_FAILED}: ${boundedRecordText(errorMessage(error), 2_000)}` } };
    }
    // §3.6: a criterion with no passing re-run, or a failed re-run, gets the CLI one fix round (CWD-3), counted from
    // this attempt's collected `done` runs (this one included); after it, the attempt fails and the task is requeued.
    if (input.signal?.aborted) return { type: "settled", outcome: { type: "paused", reason: "worker_cancelled" } };
    const gaps = cliCheckGaps(input.submission.acceptanceCriteria, reruns);
    if (hasCliCheckGaps(gaps)) {
      const records = cliAttemptRecords(deps.schedulerStore, input);
      const doneRuns = records.filter((record) => record.collected && record.outcome === "done").length;
      if (doneRuns > CLI_FIX_ROUNDS) return { type: "settled", outcome: { type: "failed", reason: cliCheckGapFailure(name, gaps) } };
      await writeFixRound(cliWorkerStateFolder(deps.stateDirectory, input.runId, input.sessionId), records.length + 1,
        cliFixRoundPrompt({ name, gaps, reruns: reruns.reruns ?? [], restoredPaths: reruns.restoredPaths ?? [] }));
      return { type: "fix_round" };
    }
  }
  // The attempt's earlier collected runs (before a fix round or a question) count too: the Architect sees every commit
  // the Runner undid and every docs/project change it restored in this attempt, not only the last run's.
  const earlier = cliAttemptRecords(deps.schedulerStore, input).filter((record) => record.collected).slice(0, -1);
  facts = {
    replacedCliCommits: facts.replacedCliCommits + earlier.reduce((sum, record) => sum + (record.replacedCliCommits ?? 0), 0),
    restoredProjectDocs: [...new Set([...earlier.flatMap((record) => record.restoredProjectDocs ?? []), ...facts.restoredProjectDocs])].sort(),
    projectChangedDuringAttempt: [...new Set([...earlier.flatMap((record) => record.projectChangedDuringAttempt ?? []), ...facts.projectChangedDuringAttempt])],
  };
  const concerns = [
    ...(result.concerns ?? []).map((concern) => `${name} reported: ${concern}`),
    ...(reruns.restoredPaths?.length
      ? [`A Runner re-run of ${name}'s checks changed ${reruns.restoredPaths.length} file(s); the Runner restored them, so the submitted tree is the one ${name} left: ${reruns.restoredPaths.slice(0, 20).join(", ")}${reruns.restoredPaths.length > 20 ? ", …" : ""}`]
      : []),
    ...(facts.restoredProjectDocs.length
      ? [`${name} changed docs/project, which belongs to the Architect; the Runner restored it from the baseline: ${facts.restoredProjectDocs.join(", ")}`]
      : []),
    ...(facts.projectChangedDuringAttempt.length
      ? [`The project folder's ${facts.projectChangedDuringAttempt.join(", ")} changed while ${name} ran; a CLI at Full access can write outside its worktree.`]
      : []),
    ...(facts.replacedCliCommits > 0
      ? [`${name} made ${facts.replacedCliCommits} commit(s) of its own; the Runner undid them and submits their content through its guarded commit.`]
      : []),
  ].map((concern) => boundedRecordText(concern, CONCERN_MAX)).slice(0, CONCERNS_MAX);
  // The CLI's own entries are its report; the Runner's entries say what its re-runs did not run.
  const notRun = [...(result.notRun ?? []).map((entry) => ({ what: entry.what, why: `${name} reports: ${entry.why}` })), ...reruns.notRun];
  const summary = boundedRecordText(`${name} worker reports: ${result.summary.trim() || "no summary"}`, 4_000);
  let changeSet: ChangeSet;
  try {
    changeSet = await submitWorkerTask(input.submission, {
      summary,
      readiness: "ready_for_architect_review",
      unresolvedConcerns: concerns,
      criterionEvidenceLinks: reruns.criterionEvidenceLinks,
      ...(input.submission.requireValidationScope ? { validationScope: cliValidationScope(name, result, notRun, reruns.reruns ?? []) } : {}),
      validationBudgetJustification: `${name} ran its own checks; the Runner's re-runs of the checks it reported are the evidence.`,
    });
  } catch (error) {
    return { type: "settled", outcome: { type: "failed", reason: `cli_submission_refused: ${boundedRecordText(errorMessage(error), 2_000)}` } };
  }
  await deps.sessions.submit(input.sessionId, changeSet, clock());
  return { type: "submitted", changeSet };
}

/** The validation-scope claim, marked as the CLI's report (§3.6): never evidence. */
function cliValidationScope(name: string, result: CliWorkerResultV1, notRun: readonly { what: string; why: string }[], reruns: readonly CliCheckRerun[]): ValidationScope {
  const bounded = (text: string) => boundedRecordText(text, 500);
  return {
    changed: [bounded(`${name}'s report: ${result.summary.trim() || "no summary"}`)],
    verified: [
      ...result.checks.slice(0, 25).map((check) => bounded(`${name} reports it ran ${check.label}: ${[check.executable, ...check.args].join(" ")}`)),
      // What the Runner observed itself (§3.6), apart from the CLI's claims.
      ...reruns.filter((rerun) => rerun.status !== "not_run").slice(0, 25)
        .map((rerun) => bounded(`The Runner re-ran ${rerun.label}: ${rerun.status === "passed" ? "passed" : `failed, ${rerun.detail}`}${rerun.evidenceId ? ` (evidence ${rerun.evidenceId})` : ""}`)),
    ],
    testsRun: [],
    notRun: [
      ...notRun.slice(0, 49).map((entry) => ({ what: bounded(entry.what) || "a check", why: bounded(entry.why) || "not given" })),
      { what: "test counts", why: bounded(`${name} reports no test counts; only the Runner's re-runs of its checks count as evidence.`) },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------
// The managed-process launcher (production)

/**
 * Runs CLI processes through `ManagedProcessService` for the worker's exact owner: interactive stdin, offset-addressed
 * output reads, and `closeAgent` as the stop. Each call carries its own grant, issued and revoked as a ToolBroker call
 * would (the same pattern as final checks and CW3's Tests).
 */
export function createManagedCliProcessLauncher(options: {
  managedProcesses: ManagedProcessService;
  executionGrants: ExecutionGrantAuthority;
  permissionProfile: PermissionProfile;
}): CliProcessLauncher {
  const invoke = async <T>(owner: CliWorkerOwner, workspacePath: string, toolName: string, perform: (context: ToolExecutionContext) => Promise<T>): Promise<T> => {
    const callId = `cli-worker:${randomUUID()}:${toolName}`;
    const grant = await options.executionGrants.issue({
      runId: owner.runId, sessionId: owner.sessionId, actor: { ...owner.actor }, toolName, callId,
      permissionProfile: options.permissionProfile, workspacePath, access: [{ path: workspacePath, mode: "write" }],
      externalApproved: false, destructiveApproved: false, networkApproved: false,
    });
    try {
      return await perform({ runId: owner.runId, sessionId: owner.sessionId, actor: { ...owner.actor }, callId, toolName, workspacePath, executionGrant: grant });
    } finally {
      await options.executionGrants.revoke(grant, "completed");
    }
  };
  const managed = options.managedProcesses;
  return Object.freeze({
    async start(input: { owner: CliWorkerOwner; executable: string; args: readonly string[]; cwd: string }): Promise<CliProcessHandle> {
      const started = await invoke(input.owner, input.cwd, "process.start", (context) =>
        managed.start({ command: input.executable, args: [...input.args], cwd: ".", interactive: true }, context, input.cwd));
      const processId = started.processId;
      let cursor: string | undefined;
      return Object.freeze({
        processId,
        async write(text: string, closeInput: boolean) {
          const written = await invoke(input.owner, input.cwd, "process.write_stdin", (context) =>
            managed.writeInput(processId, { writeId: randomUUID(), ...(text ? { data: text } : {}), ...(closeInput ? { closeInput: true } : {}) }, context));
          if (written.status !== "acknowledged") throw new Error(`The CLI's stdin was not delivered (${written.status}${written.errorCode ? `: ${written.errorCode}` : ""}).`);
        },
        async read(waitMs: number): Promise<CliProcessOutput> {
          const result = await invoke(input.owner, input.cwd, "process.read_output", (context) =>
            managed.readOutput(processId, { ...(cursor ? { cursor } : {}), waitMs: Math.max(0, Math.min(Math.round(waitMs), MANAGED_OUTPUT_WAIT_MAX_MS)), maxBytes: MANAGED_OUTPUT_READ_MAX_BYTES }, context));
          cursor = result.cursor;
          let stdout = "", stderr = "", gap = false;
          for (const slice of result.slices) {
            if (slice.gap) gap = true;
            if (slice.stream === "stderr") stderr += slice.text;
            else stdout += slice.text;
          }
          // Terminal and read to the end of every stream; a lossy record still ends the wait.
          const exited = result.status !== "running" && result.slices.every((slice) => !slice.hasMore);
          return { stdout, stderr, gap, exited, exitCode: result.exitCode };
        },
      });
    },
    async stopOwner(owner: CliWorkerOwner): Promise<void> {
      await managed.closeAgent(owner);
    },
  });
}
