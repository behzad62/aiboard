/**
 * Build mode runner: the Architect (judge model) plans tasks, worker models
 * implement them with focused context, the Architect reviews/fixes and adds
 * tasks until done. Files are written immediately — always to a virtual FS
 * (drives the artifact panel / zip), and also to the user's project folder
 * when one was granted.
 */

import { v4 as uuidv4 } from "uuid";
import type {
  Discussion,
  EffortLevel,
  ReasoningEffort,
  Verbosity,
} from "@/lib/db/schema";
import type { SelectedModel } from "@/lib/providers/base";
import { parseModelId } from "@/lib/providers/base";
import { resolveModelName } from "./providers";
import {
  BUILD_INTEGRATOR_MIN_TOKENS,
  BUILD_LIMITS,
  BUILD_ROUND_MIN_TOKENS,
  EFFORT_CONFIG,
} from "@/lib/orchestrator/config";
import { buildVerbosityInstruction } from "@/lib/orchestrator/prompts";
import { extractJudgeResult } from "@/lib/orchestrator/parse";
import { applyEditOps, extractArtifacts } from "@/lib/artifacts/extract";
import {
  buildArchitectPlanPrompt,
  buildArchitectReviewPrompt,
  buildArchitectSummaryPrompt,
  buildIncompleteTaskFailure,
  buildWaveReviewDigest,
  formatBuildFileToolDiagnostic,
  buildWorkerTaskPrompt,
  classifyRunCommand,
  decideBuildTaskFailure,
  detectVerifyCommand,
  findIncompleteBuildTasks,
  githubWorkflowRequested,
  hasCompleteBuildToolAction,
  inspectStrictToolActionOutput,
  isGitHubWorkflowCommand,
  outputPathsForTask,
  parseArchitectAction,
  runBudgetStatus,
  summarizeFileChange,
  STRICT_RETRY_INSTRUCTION,
  type ArchitectAction,
  type BuildTask,
  type FetchAction,
  type FileChangeOperation,
  type PlanAction,
  type ToolAction,
} from "@/lib/orchestrator/build";
import {
  getProjectHandle,
  listProjectTree,
  queryProjectPermission,
  readProjectFile,
  writeProjectFile,
} from "./project-fs";
import {
  appendFileViaRunner,
  callMcpTool,
  checkRunner,
  fetchViaRunner,
  formatCommandResult,
  listFilesViaRunner,
  listMcpServers,
  patchFileViaRunner,
  readFileRangeViaRunner,
  readFileViaRunner,
  runCommand,
  searchViaRunner,
  stripAnsi,
  writeFileViaRunner,
  type RunnerConfig,
} from "./runner";
import {
  accumulateModelStats,
  getBuildFiles,
  getFinalResult,
  getMessagesForDiscussion,
  insertFinalResult,
  insertMessage,
  updateDiscussion,
  upsertBuildFile,
} from "./store";
import { drainBuildNotes } from "./build-notes";
import {
  abortError,
  collectStream,
  isAbortError,
  type OrchestratorEvent,
} from "./engine";
import { estimateModelCallUsage } from "./token-usage";

type EventCallback = (event: OrchestratorEvent) => void;

export type CommandApprovalDecision = "allow" | "allow-all" | "deny";

/** UI hooks injected by the discussion page (e.g. the approval prompt). */
export interface BuildHooks {
  requestCommandApproval?: (
    command: string,
    reason?: string
  ) => Promise<CommandApprovalDecision>;
}

const SEARCHES_PER_PHASE = 4;
const MCP_CALLS_PER_PHASE = 8;
const TOTAL_MCP_CALLS = 24;
const FETCHES_PER_PHASE = 4;
const TOTAL_FETCHES = 12;
const WORKER_READS_PER_TASK = 4;
const WORKER_RANGE_READS_PER_TASK = 8;
const WORKER_SEARCHES_PER_TASK = 4;
const WORKER_PATCHES_PER_TASK = 8;
const WORKER_APPENDS_PER_TASK = 12;
const WORKER_TOOL_TURNS_PER_TASK = 24;
const WORKER_BAD_TOOL_CALLS_PER_TASK = 3;

const MANIFEST_CANDIDATES = [
  "README.md",
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Cargo.toml",
  "go.mod",
];

const MAX_CONTEXT_FILES = 8;
const PER_FILE_REVIEW_CHARS = 6_000;
const TOTAL_REVIEW_CHARS = 48_000;

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…[truncated]`;
}

/**
 * One-line shell/OS hint for the Architect's run-command prompt, derived from
 * the runner's reported platform. Returns "" for unknown/absent platforms (old
 * runners that don't report one) so no misleading hint is shown.
 */
function shellHintForPlatform(platform?: string): string {
  if (platform === "win32") {
    return 'SHELL: commands run on Windows via cmd.exe — Unix tools (sed/awk/grep/ls/cat) are NOT available; use `node -e "..."` for file inspection and Windows equivalents (type, dir, findstr) otherwise.';
  }
  if (platform === "darwin" || platform === "linux") {
    return "SHELL: commands run in a POSIX shell (sh) — standard Unix tools (sed/awk/grep/ls/cat) are available.";
  }
  return "";
}

/**
 * Run a browser-side Build-mode discussion from planning through worker waves,
 * Architect review, file persistence, and final hand-off.
 */
export async function runBuildDiscussion(
  discussion: Discussion,
  models: SelectedModel[],
  emit: EventCallback,
  hooks?: BuildHooks,
  signal?: AbortSignal
): Promise<void> {
  const throwIfAborted = (): void => {
    if (signal?.aborted) throw abortError();
  };
  const waitForRetry = (ms: number): Promise<void> =>
    new Promise((resolve, reject) => {
      if (ms <= 0) {
        resolve();
        return;
      }
      if (signal?.aborted) {
        reject(abortError());
        return;
      }
      const timeout = window.setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = () => {
        window.clearTimeout(timeout);
        reject(abortError());
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  const effort = discussion.effort as EffortLevel;
  const limits = BUILD_LIMITS[effort];
  const config = EFFORT_CONFIG[effort];
  const reasoningEffort = (discussion.reasoningEffort ?? "default") as ReasoningEffort;
  const verbosityInstruction = buildVerbosityInstruction(
    (discussion.verbosity ?? "balanced") as Verbosity,
    discussion.styleNote
  );
  const workerMaxTokens = Math.max(config.maxTokens, BUILD_ROUND_MIN_TOKENS);
  const architectMaxTokens = Math.max(config.judgeMaxTokens, BUILD_INTEGRATOR_MIN_TOKENS);

  const modelIds: string[] = JSON.parse(discussion.modelIds);
  const architectId = discussion.judgeModelId ?? modelIds[0];
  // The Architect is the JUDGE model — even when it isn't one of the
  // participating (worker) models. Resolve it on its own so a non-participant
  // judge (e.g. an expensive GPT-5.5 orchestrating cheap workers) is honored
  // instead of silently falling back to the first participant.
  const architect: SelectedModel =
    models.find((m) => m.modelId === architectId) ??
    {
      modelId: architectId,
      providerId: parseModelId(architectId).providerId,
      displayName: resolveModelName(architectId),
    };
  const workers = models.filter((m) => m.modelId !== architect.modelId);
  if (workers.length === 0) workers.push(architect); // solo build

  // ── Worker scoreboard ─────────────────────────────────────────────────────
  // Tracks each worker's performance so the Architect can assign harder tasks
  // to the reliable ones, and so a model that stops responding gets benched
  // while others can carry on. Scores are derived objectively from the
  // Architect's approve/fix verdicts, failures, and response times — no model
  // is asked to self-report.
  interface WorkerStat {
    index: number;
    name: string;
    attempts: number;
    approvals: number;
    fixes: number;
    // Failures are split: a model's QUALITY is only judged by badOutput.
    badOutput: number; // responded with no usable files, or a non-infra error
    unavailable: number; // provider denied/timed out (429/503/quota/network) — NOT quality
    // Difficulty-weighted tallies (weight = task difficulty / 3, medium = 1)
    // for the global benchmark; hard-task outcomes count more than trivial ones.
    wApprovals: number;
    wFixes: number;
    wBadOutput: number;
    responseMs: number; // time of SUCCESSFUL responses only (clean throughput)
    responseChars: number; // output chars of successful responses only
    responses: number; // successful, non-empty responses
    active: boolean;
  }
  const scoreboard: WorkerStat[] = workers.map((w, index) => ({
    index,
    name: w.displayName,
    attempts: 0,
    approvals: 0,
    fixes: 0,
    badOutput: 0,
    unavailable: 0,
    wApprovals: 0,
    wFixes: 0,
    wBadOutput: 0,
    responseMs: 0,
    responseChars: 0,
    responses: 0,
    active: true,
  }));

  /** Normalized difficulty weight: medium (3) = 1.0, trivial = 0.33, hard = 1.67. */
  const difficultyWeight = (task: BuildTask): number =>
    Math.max(1, Math.min(5, task.difficulty ?? 3)) / 3;

  // Speed is judged by THROUGHPUT (ms per output char) of SUCCESSFUL responses,
  // relative to the other workers — never raw elapsed time (bigger tasks take
  // longer) and never polluted by failed attempts.
  const msPerChar = (s: WorkerStat): number | null =>
    s.responseChars > 0 ? s.responseMs / s.responseChars : null;

  const medianMsPerChar = (): number | null => {
    const rates = scoreboard
      .map(msPerChar)
      .filter((r): r is number => r != null)
      .sort((a, b) => a - b);
    if (rates.length < 2) return null; // a relative measure needs a peer
    const mid = Math.floor(rates.length / 2);
    return rates.length % 2 ? rates[mid] : (rates[mid - 1] + rates[mid]) / 2;
  };

  // In-build operational score (drives assignment): raw counts, integer, and
  // excludes unavailable so a model isn't punished for the provider's outages.
  // (The global leaderboard uses the difficulty-weighted tallies instead.)
  const workerScore = (s: WorkerStat): number => {
    let score = s.approvals * 3 - s.fixes * 1 - s.badOutput * 4;
    const median = medianMsPerChar();
    const rate = msPerChar(s);
    if (median != null && rate != null) {
      if (rate < median * 0.5) score += 1;
      else if (rate > median * 2) score -= 1;
    }
    return score;
  };

  /** Active workers, best first (score desc, then better throughput, then order). */
  const rankedActiveWorkers = (): WorkerStat[] =>
    scoreboard
      .filter((s) => s.active)
      .sort((a, b) => {
        const ds = workerScore(b) - workerScore(a);
        if (ds !== 0) return ds;
        const rateA = msPerChar(a) ?? Infinity;
        const rateB = msPerChar(b) ?? Infinity;
        if (rateA !== rateB) return rateA - rateB;
        return a.index - b.index;
      });

  const scoreboardText = (): string =>
    scoreboard
      .slice()
      .sort((a, b) => workerScore(b) - workerScore(a))
      .map((s) => {
        const avg =
          s.responses > 0
            ? ` avg ${Math.round(s.responseMs / s.responses / 1000)}s`
            : "";
        const down = s.unavailable > 0 ? `, ${s.unavailable} unavailable` : "";
        const bench = s.active ? "" : " [BENCHED — not producing output]";
        return `- ${s.name}: score ${workerScore(s)} (${s.approvals} approved, ${s.fixes} fix${s.fixes === 1 ? "" : "es"}, ${s.badOutput} bad output${down}${avg})${bench}`;
      })
      .join("\n");

  // Bench workers that still haven't produced any usable output after more
  // than one try — never benches on a single attempt, and never the last
  // active worker. Benching is operational (a model that isn't producing,
  // for any reason, can't carry the build); it does NOT affect quality score.
  const benchUnresponsiveWorkers = (): void => {
    for (const stat of scoreboard) {
      if (!stat.active) continue;
      const neverProduced = stat.attempts >= 2 && stat.responses === 0;
      const othersActive = scoreboard.some((s) => s.active && s.index !== stat.index);
      if (neverProduced && othersActive) {
        stat.active = false;
        const why = stat.unavailable >= stat.badOutput ? "the provider keeps denying it" : "it hasn't produced usable output";
        emit({
          type: "diagnostic",
          phase: "round_preparing",
          message: `Benching ${stat.name} — ${why}; remaining workers will continue`,
        });
      }
    }
  };

  /** Match an Architect-provided assignTo name to a worker index. */
  const workerIndexByName = (name?: string): number | null => {
    if (!name) return null;
    const lower = name.trim().toLowerCase();
    const found = scoreboard.find((s) => s.name.toLowerCase() === lower);
    return found ? found.index : null;
  };

  // ── Filesystem: virtual always; the real folder when granted ──────────────
  // A folder problem (no permission, moved, or — common on Documents —
  // OneDrive "online-only" placeholder files that throw NotFoundError) must
  // never fail the build. Any error here degrades to in-app/virtual files.
  const dirHandle = await getProjectHandle(discussion.id);
  const virtualFs = new Map<string, string>();
  // Paths actually written THIS run — grounds the hand-off summary so it can
  // only describe changes that really happened.
  const writtenThisRun = new Set<string>();
  // Normalized path → writer label ("T3"/"Architect") for the CURRENT wave only
  // (cleared each cycle). Detects two workers writing the same path concurrently
  // — last-write-wins silently destroys the earlier output otherwise.
  const waveWrites = new Map<string, string>();
  // Task id -> bounded landed-change summaries for the CURRENT wave. The
  // Architect reviews this digest instead of full rewritten file bodies.
  let waveChangeSummaries = new Map<string, string[]>();
  // Seed with everything previous passes built — follow-up passes and resumes
  // must see the existing files instead of re-planning from an "empty" tree.
  for (const file of getBuildFiles(discussion.id)) {
    virtualFs.set(file.path, file.content);
  }
  if (virtualFs.size > 0) {
    emit({
      type: "diagnostic",
      phase: "initializing",
      message: `Restored ${virtualFs.size} file(s) from the previous build pass`,
    });
  }
  let diskTree: string[] = [];
  let diskGranted = false;
  let diskWarning: string | null = null;
  if (dirHandle) {
    try {
      if (await queryProjectPermission(dirHandle)) {
        const tree = await listProjectTree(dirHandle);
        diskTree = tree.files;
        diskGranted = true;
      } else {
        diskWarning = "folder access was not granted";
      }
    } catch (err) {
      // Surface the real error in DevTools so the exact failing operation is
      // visible if a specific folder/handle misbehaves.
      console.error("[build] reading the project folder failed:", err);
      diskWarning =
        err instanceof Error
          ? `${err.name}: ${err.message}`
          : "the folder couldn't be read";
    }
  }
  if (diskWarning) {
    emit({
      type: "diagnostic",
      phase: "initializing",
      message: `Project folder unavailable — ${diskWarning}. Building in the app instead; download the files as a zip when done.`,
    });
  }

  emit({
    type: "diagnostic",
    phase: "initializing",
    message: diskGranted
      ? `Build mode: Architect ${architect.displayName}, ${workers.length} worker(s), writing to folder "${dirHandle?.name}"`
      : `Build mode: Architect ${architect.displayName}, ${workers.length} worker(s), files kept in the app (download as zip)`,
  });

  const githubWorkflow = githubWorkflowRequested(discussion.topic);

  // ── Optional local runner (user-started; opt-in by config) ────────────────
  let runner: RunnerConfig | null = null;
  let runnerDirName: string | null = null;
  // One-line note about the runner's shell/OS, fed to the Architect so it stops
  // emitting Unix-only commands (sed/awk/grep) on a Windows runner. Empty when
  // the platform is unknown (old runner) — no hint then.
  let shellHint = "";
  let allowAllCommands = discussion.runnerAccess === "full";
  let totalRuns = 0;
  let totalFetches = 0;
  let mcpToolsDoc = "";
  let totalMcpCalls = 0;
  if (discussion.runnerUrl && discussion.runnerToken) {
    const config = { url: discussion.runnerUrl, token: discussion.runnerToken };
    const health = await checkRunner(config);
    if (health.ok) {
      runner = config;
      runnerDirName = health.dir ?? null;
      shellHint = shellHintForPlatform(health.platform);
      emit({
        type: "diagnostic",
        phase: "initializing",
        message: `Local runner connected (folder "${health.dir}") — the Architect can run commands${allowAllCommands ? "" : " with your approval"}`,
      });
      // The runner sees the REAL folder — use it for the tree so the
      // Architect is never blind to files it (or the user) put on disk,
      // even when no File System Access grant is active. Old runners
      // without /ls return null; the FSA tree then stands.
      const runnerTree = await listFilesViaRunner(config);
      if (runnerTree) {
        diskTree = [...new Set([...diskTree, ...runnerTree])];
        diskGranted = true;
      }
      // Sync files restored from previous passes (currently only in virtualFs)
      // into the runner's folder so a runner attached AFTER an earlier in-app
      // build pass starts from those files. Never overwrite what's already on
      // disk — the runner copy may be newer or user-edited; only write paths
      // the tree doesn't already contain. Same normalization the tree uses
      // (forward slash, lowercased, no leading "./" or "/").
      const normTreePath = (p: string): string =>
        p.replace(/\\/g, "/").replace(/^\.?\//, "").toLowerCase();
      const onDisk = new Set((runnerTree ?? []).map(normTreePath));
      let synced = 0;
      const syncFailures: string[] = [];
      for (const [path, content] of virtualFs) {
        if (onDisk.has(normTreePath(path))) continue;
        try {
          await writeFileViaRunner(config, path, content);
          synced += 1;
          if (!diskTree.includes(path)) diskTree.push(path);
        } catch (err) {
          console.error(`[build] syncing restored file ${path} to the runner failed:`, err);
          syncFailures.push(path);
        }
      }
      if (synced > 0 || syncFailures.length > 0) {
        const failNote =
          syncFailures.length > 0
            ? ` (${syncFailures.length} failed: ${syncFailures.slice(0, 5).join(", ")}${syncFailures.length > 5 ? "…" : ""})`
            : "";
        emit({
          type: "diagnostic",
          phase: "initializing",
          message: `Synced ${synced} restored file(s) into the runner folder${failNote}`,
        });
      }
      // MCP bridge: tools from stdio MCP servers the runner spawned
      // (e.g. Playwright to verify the build in a real browser). Each tool is
      // documented as a call signature from its input schema — without the
      // exact parameter names models guess them and get validation errors.
      const toolSignature = (t: {
        name: string;
        inputSchema?: { properties?: Record<string, { type?: string }>; required?: string[] } | null;
      }): string => {
        const props = t.inputSchema?.properties;
        if (!props || Object.keys(props).length === 0) return `${t.name}()`;
        const required = new Set(t.inputSchema?.required ?? []);
        const params = Object.entries(props)
          .slice(0, 10)
          .map(([key, def]) => `${key}${required.has(key) ? "" : "?"}: ${def?.type ?? "any"}`);
        return `${t.name}({${params.join(", ")}})`;
      };
      const servers = (await listMcpServers(config)) ?? [];
      const ready = servers.filter((s) => s.status === "ready" && s.tools.length > 0);
      if (ready.length > 0) {
        mcpToolsDoc = ready
          .map(
            (s) =>
              `Server "${s.name}":\n${s.tools
                .slice(0, 30)
                .map((t) => `- ${toolSignature(t)} — ${truncate(t.description ?? "", 160)}`)
                .join("\n")}`
          )
          .join("\n");
        emit({
          type: "diagnostic",
          phase: "initializing",
          message: `MCP bridge connected: ${ready.map((s) => `${s.name} (${s.tools.length} tools)`).join(", ")}`,
        });
      }
      for (const s of servers.filter((x) => x.status === "error")) {
        emit({
          type: "diagnostic",
          phase: "initializing",
          message: `MCP server "${s.name}" failed to start: ${s.error ?? "unknown error"}`,
        });
      }
    } else {
      emit({
        type: "diagnostic",
        phase: "initializing",
        message: `Local runner not reachable (${health.error}) — continuing without command execution`,
      });
    }
  }

  const currentRunBudget = () =>
    runBudgetStatus({
      runnerAvailable: !!runner,
      totalRuns,
      githubWorkflow: githubWorkflow && !!runner,
    });

  const runsLeftThisPhase = (): number => currentRunBudget().normalRunsLeft;

  const canExecuteRunAction = (command: string): boolean => {
    const budget = currentRunBudget();
    return (
      budget.normalRunsLeft > 0 ||
      (budget.githubCommandsUnlimited && isGitHubWorkflowCommand(command))
    );
  };

  const fetchesLeftThisPhase = (): number =>
    runner ? Math.min(FETCHES_PER_PHASE, TOTAL_FETCHES - totalFetches) : 0;

  const mcpCallsLeftThisPhase = (): number =>
    runner && mcpToolsDoc
      ? Math.min(MCP_CALLS_PER_PHASE, TOTAL_MCP_CALLS - totalMcpCalls)
      : 0;

  /** Execute one MCP tool call (same approval flow as commands). */
  const executeTool = async (action: ToolAction): Promise<string> => {
    if (!runner) return "No runner is available.";
    const label = `mcp:${action.server}.${action.tool} ${truncate(JSON.stringify(action.args ?? {}), 200)}`;
    if (!allowAllCommands) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, action.reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `${label}\nThe user DENIED this tool call. Continue without it.`;
      }
    }
    totalMcpCalls += 1;
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      message: `MCP tool: ${action.server}.${action.tool}`,
    });
    const startedAt = Date.now();
    try {
      const result = await callMcpTool(
        runner,
        action.server,
        action.tool,
        action.args ?? {}
      );
      emit({
        type: "command_run",
        command: label,
        exitCode: result.isError ? 1 : 0,
        durationMs: Date.now() - startedAt,
        outputPreview: truncate(result.text.trim(), 400),
      });
      return `MCP ${action.server}.${action.tool} → ${result.isError ? "ERROR" : "ok"}\n${truncate(result.text, 8_000)}`;
    } catch (err) {
      const message = err instanceof Error ? err.message : "MCP call failed";
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        outputPreview: message,
      });
      return `MCP ${action.server}.${action.tool} failed: ${message}`;
    }
  };

  /** Execute one Architect-requested command (with approval when required). */
  const executeRun = async (
    command: string,
    reason?: string
  ): Promise<string> => {
    if (!runner) return "No runner is available.";
    const safety = classifyRunCommand(command);
    if (!safety.allowed) {
      const message = `Command rejected: ${safety.reason} Use patch/append/edit output for file changes, then run tests/build commands only for verification.`;
      emit({
        type: "command_run",
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
        denied: true,
      });
      return `$ ${command}\nCOMMAND REJECTED: ${message}`;
    }
    if (!allowAllCommands) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(command, reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `$ ${command}\nThe user DENIED this command. Continue without it.`;
      }
    }
    const githubBudgetExempt =
      githubWorkflow && isGitHubWorkflowCommand(command);
    if (!githubBudgetExempt) totalRuns += 1;
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      message: `Running command: ${command}`,
    });
    try {
      const result = await runCommand(runner, command);
      emit({
        type: "command_run",
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputPreview: truncate(
          stripAnsi(result.stdout || result.stderr).trim(),
          400
        ),
      });
      // Commands can create files (scaffolders, installs) — refresh the tree.
      const refreshed = await listFilesViaRunner(runner);
      if (refreshed) diskTree = [...new Set([...diskTree, ...refreshed])];
      return formatCommandResult(command, result);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Runner request failed";
      emit({
        type: "command_run",
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
      });
      return `$ ${command}\nRunner error: ${message}`;
    }
  };

  /** Fetch a public URL via the runner (same approval flow as commands). */
  const executeFetch = async (action: FetchAction): Promise<string> => {
    if (!runner) return "No runner is available.";
    const label = `fetch ${action.url}`;
    if (!allowAllCommands) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(label, action.reason)
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command: label,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return `${label}\nThe user DENIED this fetch. Continue without it.`;
      }
    }
    totalFetches += 1;
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      message: `Fetching ${truncate(action.url, 120)}`,
    });
    const startedAt = Date.now();
    try {
      const result = await fetchViaRunner(runner, action.url);
      emit({
        type: "command_run",
        command: label,
        exitCode: result.status >= 200 && result.status < 400 ? 0 : 1,
        durationMs: result.durationMs,
        outputPreview: `HTTP ${result.status} ${result.statusText}; ${result.contentType || "unknown type"}; ${result.text.length} chars${result.truncated ? " (truncated)" : ""}`,
      });
      return [
        `Fetched ${result.finalUrl} — HTTP ${result.status} ${result.statusText}; content-type: ${result.contentType || "unknown"}; ${(result.durationMs / 1000).toFixed(1)}s${result.truncated ? "; TRUNCATED to the size cap" : ""}`,
        truncate(result.text, 16_000),
      ].join("\n\n");
    } catch (err) {
      const message = err instanceof Error ? err.message : "Fetch failed";
      emit({
        type: "command_run",
        command: label,
        exitCode: -1,
        durationMs: Date.now() - startedAt,
        outputPreview: message,
      });
      return `${label}\nFetch failed: ${message}`;
    }
  };

  /**
   * Run the wave build-check command (resolved verifyCommand) and format its
   * result for the review prompt. Honors command approval like any run, but
   * uses its OWN budget so it never starves the Architect's discretionary
   * runs. Returns "" when there's nothing to run.
   */
  const runVerify = async (command: string): Promise<string> => {
    if (!runner || !command) return "";
    const safety = classifyRunCommand(command);
    if (!safety.allowed) {
      const message = `Automated build check rejected: ${safety.reason} Verification commands must not edit files; use patch/append/edit output for file changes.`;
      emit({
        type: "command_run",
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: message,
        denied: true,
      });
      return `AUTOMATED BUILD CHECK - \`${command}\` was rejected before execution. ${message}`;
    }
    if (!allowAllCommands) {
      const decision = hooks?.requestCommandApproval
        ? await hooks.requestCommandApproval(command, "Automated build check")
        : "deny";
      if (decision === "allow-all") allowAllCommands = true;
      if (decision === "deny") {
        emit({
          type: "command_run",
          command,
          exitCode: -1,
          durationMs: 0,
          outputPreview: "Denied by the user",
          denied: true,
        });
        return "";
      }
    }
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      message: `Build check: ${command}`,
    });
    try {
      const result = await runCommand(runner, command);
      emit({
        type: "command_run",
        command,
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        outputPreview: truncate(stripAnsi(result.stdout || result.stderr).trim(), 400),
      });
      let finalCommand = command;
      let finalResult = result;
      const combinedOutput = stripAnsi(`${result.stdout}\n${result.stderr}`);
      const tscShimFailure =
        result.exitCode !== 0 &&
        detectedVerifyCommand &&
        detectedVerifyCommand !== command &&
        /^npx\s+tsc\b/i.test(command.trim()) &&
        /not the tsc command|Use npm install typescript|To get access to the TypeScript compiler/i.test(
          combinedOutput
        );
      if (tscShimFailure) {
        if (!allowAllCommands) {
          const decision = hooks?.requestCommandApproval
            ? await hooks.requestCommandApproval(
                detectedVerifyCommand,
                "Retry automated build check with the detected TypeScript command"
              )
            : "deny";
          if (decision === "allow-all") allowAllCommands = true;
          if (decision === "deny") {
            return [
              `AUTOMATED BUILD CHECK — \`${command}\` exited ${result.exitCode} (FAILED).`,
              "The declared TypeScript command hit the npx tsc shim, and the user denied the detected retry.",
              truncate(combinedOutput.trim() || "(no output)", 6_000),
            ].join("\n");
          }
        }
        emit({
          type: "diagnostic",
          phase: "model_streaming",
          message: `Retrying build check with detected command: ${detectedVerifyCommand}`,
        });
        finalResult = await runCommand(runner, detectedVerifyCommand);
        finalCommand = detectedVerifyCommand;
        emit({
          type: "command_run",
          command: detectedVerifyCommand,
          exitCode: finalResult.exitCode,
          durationMs: finalResult.durationMs,
          outputPreview: truncate(stripAnsi(finalResult.stdout || finalResult.stderr).trim(), 400),
        });
      }
      const ok = finalResult.exitCode === 0;
      return [
        `AUTOMATED BUILD CHECK — \`${finalCommand}\` exited ${finalResult.exitCode} (${ok ? "OK" : "FAILED"})${finalResult.truncated ? " [output truncated]" : ""}.`,
        ok
          ? "The project compiles. Approve only what the build and your review both support."
          : "The project does NOT compile. Treat the errors below as required fixes — do NOT mark done while they remain; send the owning tasks back with precise fix instructions.",
        truncate(stripAnsi(finalResult.stderr || finalResult.stdout).trim() || "(no output)", 6_000),
      ].join("\n");
    } catch (err) {
      emit({
        type: "command_run",
        command,
        exitCode: -1,
        durationMs: 0,
        outputPreview: err instanceof Error ? err.message : "build check failed",
      });
      return `AUTOMATED BUILD CHECK — \`${command}\` could not run: ${err instanceof Error ? err.message : "error"}.`;
    }
  };

  const treeText = (): string => {
    const all = new Set([...diskTree, ...virtualFs.keys()]);
    return [...all].sort().slice(0, 400).join("\n");
  };

  /** Case-insensitive substring search over virtual files + the runner. */
  const searchProject = async (query: string): Promise<string> => {
    const MAX_MATCHES = 80;
    const matches: string[] = [];
    const q = query.toLowerCase();
    for (const [path, content] of virtualFs) {
      if (matches.length >= MAX_MATCHES) break;
      const lines = content.split("\n");
      for (let i = 0; i < lines.length && matches.length < MAX_MATCHES; i++) {
        if (lines[i].toLowerCase().includes(q)) {
          matches.push(`${path}:${i + 1}: ${truncate(lines[i].trim(), 200)}`);
        }
      }
    }
    if (runner && matches.length < MAX_MATCHES) {
      const remote = await searchViaRunner(runner, query);
      for (const m of remote ?? []) {
        if (matches.length >= MAX_MATCHES) break;
        const entry = `${m.path}:${m.line}: ${truncate(m.text.trim(), 200)}`;
        if (!matches.includes(entry)) matches.push(entry);
      }
    }
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      message: `Searched the project for "${truncate(query, 60)}" — ${matches.length} match(es)`,
    });
    return matches.length > 0 ? matches.join("\n") : "(no matches)";
  };

  const readFile = async (path: string): Promise<string | null> => {
    if (virtualFs.has(path)) return virtualFs.get(path)!;
    if (dirHandle) {
      try {
        const content = await readProjectFile(dirHandle, path);
        if (content != null) return content;
      } catch {
        // fall through to the runner
      }
    }
    if (runner) return readFileViaRunner(runner, path);
    return null;
  };

  const emitFileToolDiagnostic = (
    message: string,
    model?: SelectedModel
  ): void => {
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      modelId: model?.modelId,
      modelName: model?.displayName,
      providerId: model ? parseModelId(model.modelId).providerId : undefined,
      message,
    });
  };

  const recordFileChange = (
    taskId: string | undefined,
    path: string,
    operation: FileChangeOperation,
    before: string | null,
    after: string
  ): void => {
    if (!taskId) return;
    const current = waveChangeSummaries.get(taskId) ?? [];
    current.push(
      summarizeFileChange({
        path,
        operation,
        before,
        after,
      })
    );
    waveChangeSummaries.set(taskId, current);
  };

  const readFileRange = async (
    path: string,
    startLine: number,
    lineCount: number
  ): Promise<string> => {
    const start = Math.max(1, Math.round(startLine || 1));
    const count = Math.max(1, Math.min(400, Math.round(lineCount || 80)));
    if (runner) {
      const remote = await readFileRangeViaRunner(runner, path, start, count);
      if (remote) {
        if (remote.content == null) return `--- ${path} ---\n[not found or binary]`;
        const rangeNote = remote.truncated
          ? " (request capped to max range size)"
          : remote.hasMoreBefore || remote.hasMoreAfter
            ? " (partial range)"
            : "";
        return [
          `--- ${path} lines ${remote.startLine}-${remote.endLine} of ${remote.totalLines}${rangeNote} ---`,
          remote.content,
        ].join("\n");
      }
    }
    const content = await readFile(path);
    if (content == null) return `--- ${path} ---\n[not found or binary]`;
    const lines = content.split("\n");
    const startIdx = Math.min(start - 1, lines.length);
    const selected = lines.slice(startIdx, startIdx + count);
    const endLine = selected.length > 0 ? startIdx + selected.length : startIdx;
    const rangeNote = endLine < lines.length || startIdx > 0 ? " (partial range)" : "";
    return [
      `--- ${path} lines ${startIdx + 1}-${endLine} of ${lines.length}${rangeNote} ---`,
      selected.join("\n"),
    ].join("\n");
  };

  const writeFile = async (
    path: string,
    content: string,
    taskId?: string,
    operation: FileChangeOperation = "rewrite",
    beforeOverride?: string | null
  ): Promise<void> => {
    const before = beforeOverride !== undefined ? beforeOverride : await readFile(path);
    virtualFs.set(path, content);
    writtenThisRun.add(path);
    // Persist so follow-up passes and resumes still see this file.
    upsertBuildFile({
      discussionId: discussion.id,
      path,
      content,
      updatedAt: new Date().toISOString(),
    });
    let bytes = new TextEncoder().encode(content).length;
    let location: "disk" | "virtual" = "virtual";

    // Prefer the runner: it writes to the REAL project folder over HTTP with no
    // File System Access permission flakiness. Fall back to the picked folder
    // (FSA), then to in-app only.
    if (runner) {
      try {
        bytes = await writeFileViaRunner(runner, path, content);
        location = "disk";
      } catch (err) {
        console.error(`[build] writing ${path} via the runner failed:`, err);
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `Couldn't write ${path} via the runner (${err instanceof Error ? err.message : "error"}); kept in the app.`,
        });
      }
    } else if (diskGranted && dirHandle) {
      try {
        bytes = await writeProjectFile(dirHandle, path, content);
        location = "disk";
      } catch (err) {
        // Stop trying the folder after the first failure (avoids a warning per
        // file) and keep everything in-app for the rest of the build.
        console.error(`[build] writing ${path} to the project folder failed:`, err);
        diskGranted = false;
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `Couldn't write to the project folder (${err instanceof Error ? `${err.name}: ${err.message}` : "error"}). Switching to in-app files — download them as a zip when done.`,
        });
      }
    }
    emit({ type: "file_written", path, bytes, location, taskId });
    recordFileChange(
      taskId,
      path,
      before == null && operation === "rewrite" ? "create" : operation,
      before,
      content
    );
  };

  // ── Streaming helpers (persist as messages so the timeline works) ─────────
  // Continue the round numbering from any previous pass (follow-up builds keep
  // the earlier transcript) so the timeline stays in chronological order.
  let round = getMessagesForDiscussion(discussion.id).reduce(
    (max, m) => Math.max(max, m.round),
    0
  );
  const history: Array<{ label: string; text: string }> = [];

  // ── User notes: drained at every Architect decision point ─────────────────
  // Seeded with the notes from previous passes (they persist as user messages)
  // so a requirement satisfied in pass 2 can't silently fall out of pass 3.
  const userNotes: string[] = getMessagesForDiscussion(discussion.id)
    .filter((m) => m.role === "user")
    .map((m) => m.content);
  const userNotesText = (): string => {
    const fresh = drainBuildNotes(discussion.id).filter(
      (n) => !userNotes.includes(n)
    );
    if (fresh.length > 0) {
      userNotes.push(...fresh);
      emit({
        type: "diagnostic",
        phase: "round_preparing",
        message: `Handing ${fresh.length} user note${fresh.length === 1 ? "" : "s"} to the Architect`,
      });
    }
    return userNotes.map((n, i) => `${i + 1}. ${n}`).join("\n");
  };

  // The previous pass's hand-off summary (if any) tells the Architect what
  // already exists and must be preserved when planning a follow-up.
  const previousSummary = getFinalResult(discussion.id)?.answer ?? "";

  const streamTurn = async (
    model: SelectedModel,
    prompt: string,
    opts: {
      systemRole: string;
      maxTokens: number;
      label: string;
      stopWhen?: (content: string) => boolean;
    }
  ): Promise<string> => {
    round += 1;
    const messageId = uuidv4();
    const { providerId, model: rawModel } = parseModelId(model.modelId);
    emit({
      type: "message_start",
      messageId,
      modelId: model.modelId,
      modelName: model.displayName,
      round,
      role: "assistant",
    });
    emit({
      type: "diagnostic",
      phase: "model_streaming",
      round,
      modelId: model.modelId,
      modelName: model.displayName,
      providerId,
      message: opts.label,
    });
    const messages = [
      { role: "system" as const, content: opts.systemRole },
      { role: "user" as const, content: prompt },
    ];
    const content = await collectStream(
      model.modelId,
      providerId,
      rawModel,
      messages,
      opts.maxTokens,
      0.4,
      reasoningEffort,
      [],
      (token) => emit({ type: "message_token", messageId, token }),
      signal,
      opts.stopWhen
    );
    insertMessage({
      id: messageId,
      discussionId: discussion.id,
      round,
      modelId: model.modelId,
      role: "assistant",
      content,
      createdAt: new Date().toISOString(),
    });
    emit({ type: "message_complete", messageId, content });
    const usage = estimateModelCallUsage({
      messages,
      output: content,
      maxTokens: opts.maxTokens,
    });
    emit({
      type: "token_usage",
      messageId,
      modelId: model.modelId,
      modelName: model.displayName,
      providerId,
      round,
      label: opts.label,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      totalTokens: usage.totalTokens,
      maxTokens: usage.maxTokens,
      estimated: usage.estimated,
    });
    history.push({ label: opts.label, text: content });
    return content;
  };

  /** Architect turn that must yield a parseable action (one strict retry). */
  const architectAction = async (
    prompt: string,
    label: string
  ): Promise<{ action: ArchitectAction; text: string }> => {
    let text = await streamTurn(architect, prompt, {
      systemRole:
        "You are the Architect orchestrating an AI engineering team. Follow the response format exactly.",
      maxTokens: architectMaxTokens,
      label,
      stopWhen: hasCompleteBuildToolAction,
    });
    let action = parseArchitectAction(text);
    if (!action) {
      // Don't lose files the Architect emitted in the unparseable attempt —
      // the strict retry returns ONLY the json block, without them.
      await writeEmittedFiles(text);
      text = await streamTurn(
        architect,
        `${prompt}\n\n${STRICT_RETRY_INSTRUCTION}`,
        {
          systemRole: "Respond with ONLY the fenced json action block.",
          maxTokens: architectMaxTokens,
          label: `${label} (strict retry)`,
          stopWhen: hasCompleteBuildToolAction,
        }
      );
      action = parseArchitectAction(text);
    }
    if (!action) {
      throw new Error(
        "The Architect did not produce a parseable plan/review action."
      );
    }
    return { action, text };
  };

  const claimWaveWrite = (path: string, taskId?: string): string | null => {
    if (taskId == null) return null;
    const writer = taskId;
    const key = path.toLowerCase();
    const prior = waveWrites.get(key);
    if (prior && prior !== writer) {
      const issue = `CONFLICT: ${writer} attempted to write ${path}, which ${prior} already wrote in this wave — the write was rejected before it could overwrite the earlier version`;
      emit({ type: "diagnostic", phase: "model_failed", message: issue });
      return issue;
    }
    waveWrites.set(key, writer);
    return null;
  };

  const applyPatchAction = async (
    path: string,
    ops: Array<{ search: string; replace: string }>,
    taskId?: string
  ): Promise<{ written: string[]; issues: string[]; summary: string }> => {
    const conflict = claimWaveWrite(path, taskId);
    if (conflict) {
      return { written: [], issues: [conflict], summary: conflict };
    }

    const before = await readFile(path);
    if (runner) {
      try {
        const result = await patchFileViaRunner(runner, path, ops);
        if (result.content != null && result.applied > 0) {
          virtualFs.set(path, result.content);
          writtenThisRun.add(path);
          upsertBuildFile({
            discussionId: discussion.id,
            path,
            content: result.content,
            updatedAt: new Date().toISOString(),
          });
          if (!diskTree.includes(path)) diskTree.push(path);
          emit({ type: "file_written", path, bytes: result.bytes, location: "disk", taskId });
          recordFileChange(taskId, path, "patch", before, result.content);
        }
        const issues =
          result.failed > 0
            ? [
                `${result.failed} patch op(s) to ${path} did NOT match the current file content and were skipped (${result.applied} applied).`,
              ]
            : [];
        return {
          written: result.applied > 0 ? [path] : [],
          issues,
          summary: `Patch ${path}: ${result.applied} applied, ${result.failed} failed`,
        };
      } catch (err) {
        const issue = `Patch to ${path} via the runner failed (${err instanceof Error ? err.message : "error"}).`;
        emit({ type: "diagnostic", phase: "model_failed", message: issue });
        return { written: [], issues: [issue], summary: issue };
      }
    }

    const current = before;
    if (current == null) {
      const issue = `Patch to ${path} skipped — the file doesn't exist.`;
      emit({ type: "diagnostic", phase: "model_failed", message: issue });
      return { written: [], issues: [issue], summary: issue };
    }
    const { content, applied, failed } = applyEditOps(current, ops);
    const issues =
      failed > 0
        ? [
            `${failed} patch op(s) to ${path} did NOT match the current file content and were skipped (${applied} applied).`,
          ]
        : [];
    if (applied > 0) {
      await writeFile(path, content, taskId, "patch", current);
    }
    return {
      written: applied > 0 ? [path] : [],
      issues,
      summary: `Patch ${path}: ${applied} applied, ${failed} failed`,
    };
  };

  const applyAppendAction = async (
    path: string,
    content: string,
    reset: boolean,
    taskId?: string
  ): Promise<{ written: string[]; issues: string[]; summary: string }> => {
    const conflict = claimWaveWrite(path, taskId);
    if (conflict) {
      return { written: [], issues: [conflict], summary: conflict };
    }

    const before = await readFile(path);
    if (runner) {
      try {
        const result = await appendFileViaRunner(runner, path, content, reset);
        if (result.content != null) {
          virtualFs.set(path, result.content);
          writtenThisRun.add(path);
          upsertBuildFile({
            discussionId: discussion.id,
            path,
            content: result.content,
            updatedAt: new Date().toISOString(),
          });
          if (!diskTree.includes(path)) diskTree.push(path);
          emit({ type: "file_written", path, bytes: result.totalBytes, location: "disk", taskId });
          recordFileChange(
            taskId,
            path,
            before == null ? "create" : reset ? "rewrite" : "append",
            before,
            result.content
          );
        }
        return {
          written: [path],
          issues: [],
          summary: `Append ${path}: +${result.bytes} bytes${reset ? " (reset first)" : ""}`,
        };
      } catch (err) {
        const issue = `Append to ${path} via the runner failed (${err instanceof Error ? err.message : "error"}).`;
        emit({ type: "diagnostic", phase: "model_failed", message: issue });
        return { written: [], issues: [issue], summary: issue };
      }
    }

    const current = reset ? "" : before ?? "";
    await writeFile(
      path,
      `${current}${content}`,
      taskId,
      before == null ? "create" : reset ? "rewrite" : "append",
      before
    );
    return {
      written: [path],
      issues: [],
      summary: `Append ${path}: +${new TextEncoder().encode(content).length} bytes${reset ? " (reset first)" : ""}`,
    };
  };

  /**
   * Write any ```lang path=...``` files and apply any ```edit path=...```
   * SEARCH/REPLACE blocks contained in a model's output.
   *
   * Returns the paths actually written plus `issues`: writes/edits that were
   * REJECTED or SKIPPED (truncated output, suspicious shrink rewrites, edits
   * that didn't match). Callers must surface issues to the Architect's review
   * — a skipped write the Architect never hears about gets approved blind.
   */
  const writeEmittedFiles = async (
    text: string,
    taskId?: string
  ): Promise<{ written: string[]; issues: string[] }> => {
    const { files, edits, truncatedPaths } = extractArtifacts(text);
    const written: string[] = [];
    const issues: string[] = [];
    const writer = taskId ?? "Architect";

    // Record a landed write and flag it LOUDLY when a different writer already
    // touched the same path this wave (a same-writer re-emit or fix is fine).
    // Architect writes are exempt: its review fixes run AFTER the wave's
    // workers settle and overwrite their files deliberately — not a race.
    // Paths arrive already normalized by extractArtifacts (forward slash); key
    // on the lowercased form so case-only differences still collide.
    const noteWrite = (path: string): void => {
      if (taskId == null) return;
      const key = path.toLowerCase();
      const prior = waveWrites.get(key);
      if (prior && prior !== writer) {
        const issue = `CONFLICT: ${writer} overwrote ${path}, which ${prior} also wrote in this wave — the earlier version is lost`;
        issues.push(issue);
        emit({ type: "diagnostic", phase: "model_failed", message: issue });
      }
      waveWrites.set(key, writer);
    };

    for (const path of truncatedPaths) {
      const issue = `Output was cut off mid-block for ${path} — nothing from the truncated block was written. This file is too large for a single response; use read_range/search plus patch for existing files, or append chunks for large/missing files.`;
      issues.push(issue);
      emit({ type: "diagnostic", phase: "model_failed", message: `Truncated output block for ${path} rejected${taskId ? ` (${taskId})` : ""}` });
    }

    for (const file of files) {
      // A full-file rewrite that shrinks an existing file drastically is far
      // more often a truncated/lazy rewrite ("// rest unchanged") than a real
      // refactor — refuse it and tell the model to use edit blocks instead.
      const existing = await readFile(file.path);
      if (
        existing != null &&
        existing.length > 2_000 &&
        file.content.length < existing.length * 0.5
      ) {
        const issue = `Rewrite of ${file.path} skipped as suspicious: the existing file is ${existing.length} chars but the replacement is only ${file.content.length}. Use SEARCH/REPLACE edit blocks for changes, or re-emit the COMPLETE file if a smaller rewrite is genuinely intended.`;
        issues.push(issue);
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `Skipped suspicious rewrite of ${file.path} (${existing.length} → ${file.content.length} chars)${taskId ? ` (${taskId})` : ""}`,
        });
        continue;
      }
      const conflict = claimWaveWrite(file.path, taskId);
      if (conflict) {
        issues.push(conflict);
        continue;
      }
      await writeFile(
        file.path,
        file.content,
        taskId,
        existing == null ? "create" : "rewrite",
        existing
      );
      noteWrite(file.path);
      written.push(file.path);
    }

    for (const edit of edits) {
      const current = await readFile(edit.path);
      if (current == null) {
        issues.push(`Edit to ${edit.path} skipped — the file doesn't exist.`);
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `Edit to ${edit.path} skipped — the file doesn't exist`,
        });
        continue;
      }
      const { content, applied, failed } = applyEditOps(current, edit.ops);
      if (applied > 0) {
        const conflict = claimWaveWrite(edit.path, taskId);
        if (conflict) {
          issues.push(conflict);
        } else {
          await writeFile(edit.path, content, taskId, "patch", current);
          noteWrite(edit.path);
          written.push(edit.path);
        }
      }
      if (failed > 0) {
        issues.push(
          `${failed} edit(s) to ${edit.path} did NOT match the current file content and were skipped (${applied} applied). The intended change is missing — re-issue it with SEARCH text copied verbatim from the current file.`
        );
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `${failed} edit(s) to ${edit.path} didn't match the current content and were skipped`,
        });
      }
    }
    return { written, issues };
  };

  const toTask = (
    raw: PlanAction["tasks"][number],
    index: number
  ): BuildTask => ({
    id: raw.id?.trim() || `T${index + 1}`,
    title: raw.title || `Task ${index + 1}`,
    instructions: raw.instructions || raw.title || "",
    contextFiles: (raw.contextFiles ?? []).slice(0, MAX_CONTEXT_FILES),
    outputPaths: outputPathsForTask(raw),
    expectedOutputs: raw.expectedOutputs,
    status: "planned",
    dependsOn: Array.isArray(raw.dependsOn)
      ? raw.dependsOn.filter((d): d is string => typeof d === "string")
      : [],
    assignTo: typeof raw.assignTo === "string" ? raw.assignTo : undefined,
    difficulty:
      typeof raw.difficulty === "number"
        ? Math.max(1, Math.min(5, Math.round(raw.difficulty)))
        : undefined,
  });

  // ── Status bookkeeping ─────────────────────────────────────────────────────
  const totalPhases = limits.cycles * 2 + 2; // plan + waves/reviews + summary
  updateDiscussion(discussion.id, {
    status: "running",
    maxRounds: totalPhases,
    updatedAt: new Date().toISOString(),
  });
  emit({ type: "status", status: "running", round: 0, maxRounds: totalPhases });

  // ── 1) Plan (with up to 2 read hops) ───────────────────────────────────────
  let architectNotes = "";
  let extraFileContext = "";
  let readHopsLeft = 2;
  let tasks: BuildTask[] = [];
  let planVerifyCommand = ""; // build/check command the Architect declared

  // Give the Architect the obvious entry points of an existing project up front
  // so it usually doesn't need to spend a read hop on them.
  for (const manifest of MANIFEST_CANDIDATES) {
    if (!diskTree.includes(manifest)) continue;
    const content = await readFile(manifest);
    if (content != null) {
      extraFileContext += `\n--- ${manifest} ---\n${truncate(content, PER_FILE_REVIEW_CHARS)}`;
    }
  }
  if (extraFileContext) {
    extraFileContext = `\nKey project files:${extraFileContext}`;
  }

  let runFeedback = "";
  let planSearchesLeft = SEARCHES_PER_PHASE;
  for (;;) {
    throwIfAborted();
    const planPrompt = buildArchitectPlanPrompt({
      request: discussion.topic,
      treeText: treeText(),
      fileContext: extraFileContext + runFeedback,
      maxTasks: limits.tasksPerWave,
      workerNames: workers.map((w) => w.displayName),
      readHopsLeft,
      runsLeft: runsLeftThisPhase(),
      githubWorkflow: githubWorkflow && !!runner,
      searchesLeft: planSearchesLeft,
      mcpToolsDoc,
      mcpCallsLeft: mcpCallsLeftThisPhase(),
      userNotes: userNotesText(),
      scoreboard: scoreboard.some((s) => s.attempts > 0) ? scoreboardText() : "",
      previousSummary: truncate(previousSummary, 6_000),
      fetchesLeft: fetchesLeftThisPhase(),
      shellHint,
    });
    const { action, text } = await architectAction(planPrompt, "Architect is planning the project");
    const strictTool = inspectStrictToolActionOutput(text);
    if (strictTool.action && strictTool.feedback && strictTool.valid) {
      runFeedback += `\n\n${strictTool.feedback}`;
      emit({
        type: "diagnostic",
        phase: "model_failed",
        modelId: architect.modelId,
        modelName: architect.displayName,
        providerId: parseModelId(architect.modelId).providerId,
        message: `Architect tool-call warning while planning: ${strictTool.feedback}`,
      });
    } else if (strictTool.feedback && !strictTool.valid) {
      const feedback =
        strictTool.feedback ?? "TOOL CALL REJECTED: invalid tool call.";
      runFeedback += `\n\n${feedback}\nRe-issue exactly one valid JSON tool action, or produce the plan JSON.`;
      emit({
        type: "diagnostic",
        phase: "model_failed",
        modelId: architect.modelId,
        modelName: architect.displayName,
        providerId: parseModelId(architect.modelId).providerId,
        message: `Architect made an invalid tool call while planning: ${feedback}`,
      });
      continue;
    }
    if (action.action === "search" && planSearchesLeft > 0) {
      planSearchesLeft -= 1;
      emitFileToolDiagnostic(
        formatBuildFileToolDiagnostic({
          actor: "Architect",
          action: "search",
          query: action.query,
        }),
        architect
      );
      extraFileContext += `\nSearch results for "${action.query}":\n${await searchProject(action.query)}`;
      continue;
    }
    if (action.action === "tool" && mcpCallsLeftThisPhase() > 0) {
      runFeedback += `\n\nTool result:\n${await executeTool(action)}`;
      continue;
    }
    if (action.action === "fetch" && fetchesLeftThisPhase() > 0) {
      runFeedback += `\n\nWeb fetch result:\n${await executeFetch(action)}`;
      continue;
    }
    if (action.action === "read" && readHopsLeft > 0) {
      readHopsLeft -= 1;
      const paths = action.paths.slice(0, 8);
      emitFileToolDiagnostic(
        formatBuildFileToolDiagnostic({
          actor: "Architect",
          action: "read",
          paths,
        }),
        architect
      );
      const chunks: string[] = [];
      for (const path of paths) {
        const content = await readFile(path);
        chunks.push(
          `\n--- ${path} ---\n${content ?? "[not found or binary]"}`
        );
      }
      extraFileContext += `\nRequested file contents:${chunks.join("\n")}`;
      continue;
    }
    if (action.action === "run" && canExecuteRunAction(action.command)) {
      runFeedback += `\n\nCommand result:\n${await executeRun(action.command, action.reason)}`;
      continue;
    }
    if (action.action === "plan") {
      tasks = action.tasks.slice(0, limits.tasksPerWave).map(toTask);
      architectNotes = action.notes ?? "";
      planVerifyCommand =
        typeof action.verifyCommand === "string" ? action.verifyCommand.trim() : "";
      const { issues } = await writeEmittedFiles(text); // architect may scaffold files in the plan
      if (issues.length > 0) {
        extraFileContext += `\nYOUR SCAFFOLD WRITES THAT DID NOT LAND:\n${issues.map((s) => `- ${s}`).join("\n")}`;
      }
      break;
    }
    throw new Error("The Architect's first action must be a plan.");
  }

  if (tasks.length === 0) {
    throw new Error("The Architect produced an empty plan.");
  }

  emit({
    type: "build_plan",
    cycle: 0,
    tasks: tasks.map((t) => ({ id: t.id, title: t.title, status: t.status })),
  });
  for (const task of tasks) {
    emit({ type: "task_status", taskId: task.id, title: task.title, status: "planned" });
  }

  // ── 2..n) Implement waves + Architect reviews ──────────────────────────────
  let workerCalls = 0;
  // Persists across batches and waves so small (even size-1) batches still
  // spread work over all active workers instead of piling onto the top rank.
  let assignCursor = 0;
  // Mechanical build/check backstop: a project-appropriate command run after
  // each wave (when a runner is connected) so broken code is caught by the
  // compiler in ANY language, not only by model review. The
  // Architect's declared command wins; otherwise we detect from the manifests.
  const detectedVerifyCommand = runner
    ? detectVerifyCommand([...diskTree, ...virtualFs.keys()])
    : "";
  const verifyCommand = runner ? (planVerifyCommand || detectedVerifyCommand) : "";
  if (verifyCommand) {
    emit({
      type: "diagnostic",
      phase: "round_preparing",
      message: `Build check each wave: \`${verifyCommand}\``,
    });
  }
  let done = false;

  for (let cycle = 1; cycle <= limits.cycles && !done; cycle++) {
    // Drive the hero progress bar one notch per review wave. Builds count
    // "waves" (review cycles), not panel-style discussion rounds — this
    // corrects the store's initial maxRounds to the real wave budget.
    emit({
      type: "status",
      status: "running",
      round: cycle,
      maxRounds: limits.cycles,
    });
    const pending = tasks.filter(
      (t) => t.status === "planned" || t.status === "fixing"
    );
    if (pending.length === 0) break;
    // Write-conflict tracking and the deferral-announced set are per wave.
    waveWrites.clear();
    waveChangeSummaries = new Map<string, string[]>();
    const deferAnnounced = new Set<string>();

    const executed: Array<{
      task: BuildTask;
      worker: SelectedModel;
      files: string[];
      notes: string;
      changes: string[];
    }> = [];

    // A failed attempt (threw, or returned no files) goes back to the pool
    // once so another — or a better — worker can retry it, instead of the
    // deliverable silently dying with the wave. The second failure is final.
    const failTask = (
      task: BuildTask,
      stat: WorkerStat,
      worker: SelectedModel,
      detail: string,
      kind: "bad" | "unavailable"
    ): void => {
      // "unavailable" = the provider denied/timed out; it's not the model's
      // fault, so it never dents the quality score (only badOutput does).
      if (kind === "unavailable") {
        stat.unavailable += 1;
      } else {
        stat.badOutput += 1;
        stat.wBadOutput += difficultyWeight(task);
      }
      const decision = decideBuildTaskFailure(task, kind, detail);
      task.failCount = decision.failCount;
      task.status = decision.status;
      if (task.status === "fixing") {
        task.workerIndex = undefined;
        task.assignTo = undefined;
        task.retryAfterMs = decision.retryDelayMs
          ? Date.now() + decision.retryDelayMs
          : undefined;
        task.instructions = `${task.instructions}\n\n${decision.instructionNote}`;
      } else {
        task.retryAfterMs = undefined;
      }
      emit({
        type: "task_status",
        taskId: task.id,
        title: task.title,
        status: task.status,
        worker: worker.displayName,
        cycle,
      });
      emit({
        type: "diagnostic",
        phase: "model_failed",
        message: `${worker.displayName} ${detail} for ${task.id}${task.status === "fixing" ? " — requeued for another attempt" : " — giving up on this task"}`,
      });
    };

    // Provider-side denials/transience are not a quality signal. Detected from
    // the error text the providers surface (status codes, "overloaded", quota,
    // timeouts, network) so a free-tier 429/503 doesn't tank a model's score.
    const UNAVAILABLE = /\b(429|500|502|503|504|529)\b|rate.?limit|over.?loaded|high demand|capacity|quota|exhausted|timed? ?out|temporarily|unavailable|econnreset|etimedout|enotfound|socket hang up|network|fetch failed/i;
    const classifyError = (message: string): "bad" | "unavailable" =>
      UNAVAILABLE.test(message) ? "unavailable" : "bad";

    const workerToolInstructions = (budget: {
      reads: number;
      rangeReads: number;
      searches: number;
      patches: number;
      appends: number;
    }): string =>
      [
        "FILE TOOLS — before your final answer, you may inspect or patch files by responding with ONLY one JSON action:",
        budget.reads > 0
          ? `- Read whole small files: {"action":"read","paths":["src/file.ts"]} (${budget.reads} left).`
          : "",
        budget.rangeReads > 0
          ? `- Read part of a file: {"action":"read_range","path":"src/file.ts","startLine":40,"lineCount":80} (${budget.rangeReads} left). Prefer this for large files. If a returned range is partial, continue from endLine + 1 instead of rereading overlapping lines unless you truly need overlap.`
          : "",
        budget.searches > 0
          ? `- Search project text: {"action":"search","query":"functionName"} (${budget.searches} left). After search results, read_range around the returned path:line matches, not from the start of the file.`
          : "",
        budget.patches > 0
          ? `- Patch an existing file exactly: {"action":"patch","path":"src/file.ts","ops":[{"search":"copy exact current text","replace":"replacement text"}],"reason":"why"} (${budget.patches} left).`
          : "",
        budget.appends > 0
          ? `- Create or extend a large/missing file in chunks: {"action":"append","path":"tests/run-tests.ts","content":"chunk text","reset":true,"reason":"start file"} then more append actions with reset false/omitted (${budget.appends} left).`
          : "",
        "Patch SEARCH text must come from the current file content. If a patch fails, read/search and try again. Do not emit full-file blocks for existing files. For large or missing files, use append chunks instead of one giant fenced block.",
      ]
        .filter(Boolean)
        .join("\n");

    const isWorkerFileAction = (action: ArchitectAction): boolean =>
      action.action === "read" ||
      action.action === "read_range" ||
      action.action === "search" ||
      action.action === "patch" ||
      action.action === "append";

    const workerInspectionKey = (action: ArchitectAction): string | null => {
      if (action.action === "read") {
        return `read:${action.paths.map((p) => p.trim().toLowerCase()).sort().join("|")}`;
      }
      if (action.action === "read_range") {
        return `read_range:${action.path.trim().toLowerCase()}:${action.startLine}:${action.lineCount}`;
      }
      if (action.action === "search") {
        return `search:${action.query.trim().toLowerCase()}`;
      }
      return null;
    };

    const runWorkerTask = async (task: BuildTask): Promise<void> => {
      const worker = workers[task.workerIndex!];
      const stat = scoreboard[task.workerIndex!];
      stat.attempts += 1;

      emit({
        type: "task_status",
        taskId: task.id,
        title: task.title,
        status: "in_progress",
        worker: worker.displayName,
        cycle,
      });

      const contextChunks: string[] = [];
      for (const path of task.contextFiles) {
        const content = await readFile(path);
        if (content != null) {
          contextChunks.push(`\n--- ${path} ---\n${truncate(content, PER_FILE_REVIEW_CHARS)}`);
        }
      }

      const startedAt = Date.now();
      let output = "";
      const patchedFiles: string[] = [];
      const toolIssues: string[] = [];
      try {
        let toolContext = "";
        let readsLeft = WORKER_READS_PER_TASK;
        let rangeReadsLeft = WORKER_RANGE_READS_PER_TASK;
        let searchesLeft = WORKER_SEARCHES_PER_TASK;
        let patchesLeft = WORKER_PATCHES_PER_TASK;
        let appendsLeft = WORKER_APPENDS_PER_TASK;
        let badToolCalls = 0;
        const seenInspectionCalls = new Set<string>();
        for (let turn = 0; turn < WORKER_TOOL_TURNS_PER_TASK; turn++) {
          output = await streamTurn(
            worker,
            buildWorkerTaskPrompt({
              request: discussion.topic,
              treeText: treeText(),
              task,
              contextFileText:
                (contextChunks.length
                  ? `\nContext files:${contextChunks.join("\n")}`
                  : "") + truncate(toolContext, 24_000),
              architectNotes,
              toolInstructions: workerToolInstructions({
                reads: readsLeft,
                rangeReads: rangeReadsLeft,
                searches: searchesLeft,
                patches: patchesLeft,
                appends: appendsLeft,
              }),
              verbosityInstruction,
            }),
            {
              systemRole:
                "You are an AI engineer completing one assigned task. Use file tools when needed, then output the final files or notes.",
              maxTokens: workerMaxTokens,
              label:
                turn === 0
                  ? `${worker.displayName} working on ${task.id}: ${task.title}`
                  : `${worker.displayName} continuing ${task.id}: ${task.title}`,
              stopWhen: hasCompleteBuildToolAction,
            }
          );
          const inspected = inspectStrictToolActionOutput(output);
          if (inspected.action && inspected.feedback && inspected.valid) {
            toolContext += `\n\n${inspected.feedback}`;
            emit({
              type: "diagnostic",
              phase: "model_failed",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              message: `${worker.displayName} tool-call warning for ${task.id}: ${inspected.feedback}`,
            });
          } else if (inspected.feedback && !inspected.valid) {
            badToolCalls += 1;
            const feedback =
              inspected.feedback ?? "TOOL CALL REJECTED: invalid tool call.";
            toolIssues.push(feedback);
            emit({
              type: "diagnostic",
              phase: "model_failed",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              message: `${worker.displayName} made an invalid tool call for ${task.id}: ${feedback}`,
            });
            toolContext += `\n\n${feedback}\nDo not repeat the same malformed response. Reply with exactly one valid JSON tool action, or stop using tools and provide final file output.`;
            if (badToolCalls >= WORKER_BAD_TOOL_CALLS_PER_TASK) {
              toolIssues.push(
                `Too many malformed tool calls (${badToolCalls}); task stopped to avoid wasting more turns.`
              );
              break;
            }
            continue;
          }
          const action = inspected.action ?? parseArchitectAction(output);
          if (!action || !isWorkerFileAction(action)) break;

          const duplicateKey = workerInspectionKey(action);
          if (duplicateKey && seenInspectionCalls.has(duplicateKey)) {
            badToolCalls += 1;
            const feedback =
              "DUPLICATE TOOL CALL REJECTED: you already received this exact read/search result. Use the previous tool result in your context, request a different range/search if needed, or apply a patch now.";
            toolIssues.push(feedback);
            emit({
              type: "diagnostic",
              phase: "model_failed",
              modelId: worker.modelId,
              modelName: worker.displayName,
              providerId: parseModelId(worker.modelId).providerId,
              message: `${worker.displayName} repeated a file inspection call for ${task.id}: ${feedback}`,
            });
            toolContext += `\n\n${feedback}`;
            if (badToolCalls >= WORKER_BAD_TOOL_CALLS_PER_TASK) {
              toolIssues.push(
                `Too many repeated or malformed tool calls (${badToolCalls}); task stopped to avoid wasting more turns.`
              );
              break;
            }
            continue;
          }
          if (duplicateKey) seenInspectionCalls.add(duplicateKey);

          if (action.action === "read" && readsLeft > 0) {
            readsLeft -= 1;
            const paths = action.paths.slice(0, 6);
            emitFileToolDiagnostic(
              formatBuildFileToolDiagnostic({
                actor: `${worker.displayName} ${task.id}`,
                action: "read",
                paths,
              }),
              worker
            );
            const chunks: string[] = [];
            for (const path of paths) {
              const content = await readFile(path);
              chunks.push(`\n--- ${path} ---\n${content ?? "[not found or binary]"}`);
            }
            toolContext += `\n\nTool result:\n${truncate(chunks.join("\n"), 18_000)}`;
            continue;
          }
          if (action.action === "read_range" && rangeReadsLeft > 0) {
            rangeReadsLeft -= 1;
            emitFileToolDiagnostic(
              formatBuildFileToolDiagnostic({
                actor: `${worker.displayName} ${task.id}`,
                action: "read_range",
                path: action.path,
                startLine: action.startLine,
                lineCount: action.lineCount,
              }),
              worker
            );
            toolContext += `\n\nTool result:\n${await readFileRange(
              action.path,
              action.startLine,
              action.lineCount
            )}`;
            continue;
          }
          if (action.action === "search" && searchesLeft > 0) {
            searchesLeft -= 1;
            emitFileToolDiagnostic(
              formatBuildFileToolDiagnostic({
                actor: `${worker.displayName} ${task.id}`,
                action: "search",
                query: action.query,
              }),
              worker
            );
            toolContext += `\n\nTool result:\nSearch results for "${action.query}":\n${await searchProject(
              action.query
            )}`;
            continue;
          }
          if (action.action === "patch" && patchesLeft > 0) {
            patchesLeft -= 1;
            const result = await applyPatchAction(action.path, action.ops, task.id);
            emitFileToolDiagnostic(
              formatBuildFileToolDiagnostic({
                actor: `${worker.displayName} ${task.id}`,
                action: "patch",
                path: action.path,
                summary: result.summary,
              }),
              worker
            );
            patchedFiles.push(...result.written);
            toolIssues.push(...result.issues);
            toolContext += `\n\nTool result:\n${result.summary}`;
            continue;
          }
          if (action.action === "append" && appendsLeft > 0) {
            appendsLeft -= 1;
            const result = await applyAppendAction(
              action.path,
              action.content,
              !!action.reset,
              task.id
            );
            emitFileToolDiagnostic(
              formatBuildFileToolDiagnostic({
                actor: `${worker.displayName} ${task.id}`,
                action: "append",
                path: action.path,
                summary: result.summary,
              }),
              worker
            );
            patchedFiles.push(...result.written);
            toolIssues.push(...result.issues);
            toolContext += `\n\nTool result:\n${result.summary}`;
            continue;
          }

          toolIssues.push(
            `Worker requested unavailable file tool action "${action.action}" after its budget was exhausted.`
          );
          break;
        }

        const artifactResult = await writeEmittedFiles(output, task.id);
        const files = [...new Set([...patchedFiles, ...artifactResult.written])];
        const issues = [...toolIssues, ...artifactResult.issues];
        const { prose } = extractArtifacts(output);
        // The model DID respond — a no-files result is a quality failure
        // (bad output), distinct from a provider denial.
        if (files.length === 0) {
          failTask(
            task,
            stat,
            worker,
            issues.length > 0
              ? `produced no usable files (${truncate(issues.join("; "), 300)})`
              : "returned no files",
            "bad"
          );
          return;
        }
        stat.responses += 1;
        stat.responseMs += Date.now() - startedAt;
        stat.responseChars += output.length;
        task.retryAfterMs = undefined;
        task.status = "review";
        // Issues are appended AFTER the truncation so the Architect always
        // sees them in the review prompt — a silently skipped write must
        // never be approved blind.
        const issueNotes =
          issues.length > 0
            ? `\nWRITE ISSUES — these changes did NOT land; act on them in your review:\n${issues.map((s) => `- ${s}`).join("\n")}`
            : "";
        executed.push({
          task,
          worker,
          files,
          notes: truncate(prose, 1_500) + issueNotes,
          changes: waveChangeSummaries.get(task.id) ?? [],
        });
        emit({
          type: "task_status",
          taskId: task.id,
          title: task.title,
          status: "review",
          worker: worker.displayName,
          cycle,
        });
      } catch (err) {
        if (isAbortError(err)) throw err;
        const message = err instanceof Error ? err.message : "error";
        const kind = classifyError(message);
        if (kind === "unavailable" && patchedFiles.length > 0) {
          stat.unavailable += 1;
          stat.responses += 1;
          stat.responseMs += Date.now() - startedAt;
          stat.responseChars += output.length;
          task.retryAfterMs = undefined;
          task.status = "review";
          executed.push({
            task,
            worker,
            files: [...new Set(patchedFiles)],
            notes:
              `Provider became unavailable after writing files (${message}). Review the landed files before approving.` +
              (toolIssues.length > 0
                ? `\nWRITE ISSUES - these changes did NOT land; act on them in your review:\n${toolIssues.map((s) => `- ${s}`).join("\n")}`
                : ""),
            changes: waveChangeSummaries.get(task.id) ?? [],
          });
          emit({
            type: "task_status",
            taskId: task.id,
            title: task.title,
            status: "review",
            worker: worker.displayName,
            cycle,
          });
          emit({
            type: "diagnostic",
            phase: "model_failed",
            message: `${worker.displayName} was unavailable after writing files for ${task.id} - sending landed files to Architect review instead of failing the task`,
          });
          return;
        }
        failTask(
          task,
          stat,
          worker,
          kind === "unavailable" ? `was unavailable (${message})` : `failed (${message})`,
          kind
        );
      }
    };

    // A dependency is satisfied once the task has produced output (or can't):
    // unknown ids and failed tasks count as settled so a typo or a failure
    // can never deadlock the wave.
    const dependencySettled = (depId: string): boolean => {
      const dep = tasks.find((t) => t.id === depId);
      return (
        !dep ||
        dep.status === "review" ||
        dep.status === "done" ||
        dep.status === "failed"
      );
    };

    // Dispatch every ready task CONCURRENTLY; repeat so dependency chains run
    // batch by batch (independent tasks never wait on each other).
    for (;;) {
      throwIfAborted();
      if (workerCalls >= limits.totalWorkerCalls) {
        emit({
          type: "diagnostic",
          phase: "round_preparing",
          message: `Worker call budget reached (${limits.totalWorkerCalls}); moving to review`,
        });
        break;
      }
      const ready = tasks.filter(
        (t) =>
          (t.status === "planned" || t.status === "fixing") &&
          (t.dependsOn ?? []).every(dependencySettled)
      );
      if (ready.length === 0) break;
      const now = Date.now();
      const due = ready.filter((t) => !t.retryAfterMs || t.retryAfterMs <= now);
      if (due.length === 0) {
        const waitMs = Math.max(
          0,
          Math.min(...ready.map((t) => t.retryAfterMs ?? now)) - now
        );
        emit({
          type: "diagnostic",
          phase: "round_preparing",
          message: `Waiting ${Math.ceil(waitMs / 1000)}s before retrying transiently failed task${ready.length === 1 ? "" : "s"}`,
        });
        await waitForRetry(waitMs);
        continue;
      }
      // Greedily fill the batch, but never run two tasks whose DECLARED outputs
      // overlap concurrently — that's exactly the silent last-write-wins clobber
      // we want to prevent. A task with no parseable outputs always joins (we
      // can't know its writes — don't over-block). Deferred tasks just stay
      // planned/fixing and get picked up by the next loop iteration.
      const cap = limits.totalWorkerCalls - workerCalls;
      const batch: BuildTask[] = [];
      const claimed = new Set<string>();
      for (const task of due) {
        if (batch.length >= cap) break;
        const paths = (task.outputPaths?.length ? task.outputPaths : outputPathsForTask(task)).map((p) =>
          p.toLowerCase()
        );
        const clash = paths.find((p) => claimed.has(p));
        if (clash) {
          if (!deferAnnounced.has(task.id)) {
            deferAnnounced.add(task.id);
            const owner = batch.find((b) =>
              (b.outputPaths?.length ? b.outputPaths : outputPathsForTask(b))
                .map((p) => p.toLowerCase())
                .includes(clash)
            );
            emit({
              type: "diagnostic",
              phase: "round_preparing",
              message: `Deferred ${task.id} to the next batch — its declared outputs overlap ${owner?.id ?? "another task"}'s (${clash})`,
            });
          }
          continue;
        }
        for (const p of paths) claimed.add(p);
        batch.push(task);
      }
      // Nothing could be admitted (everything left clashes with itself across
      // iterations — shouldn't happen since claimed resets, but guard anyway).
      if (batch.length === 0) break;

      // Assign a worker to each task: a still-active pin (fix tasks) wins, then
      // the Architect's assignTo, then auto-assignment spreading work across
      // active workers best-first so reliable models get the earlier tasks.
      const ranked = rankedActiveWorkers();
      for (const task of batch) {
        const pinned =
          task.workerIndex != null && scoreboard[task.workerIndex]?.active
            ? task.workerIndex
            : null;
        const requested = workerIndexByName(task.assignTo);
        const requestedActive =
          requested != null && scoreboard[requested].active ? requested : null;
        if (task.assignTo && pinned == null && requestedActive == null) {
          emit({
            type: "diagnostic",
            phase: "round_preparing",
            message: `Requested worker "${task.assignTo}" for ${task.id} is unknown or benched — auto-assigning instead`,
          });
        }
        task.workerIndex =
          pinned ?? requestedActive ?? ranked[assignCursor++ % ranked.length].index;
      }

      workerCalls += batch.length;
      if (batch.length > 1) {
        emit({
          type: "diagnostic",
          phase: "round_preparing",
          message: `Running ${batch.length} independent tasks concurrently: ${batch.map((t) => t.id).join(", ")}`,
        });
      }
      // allSettled so an abort in one task doesn't leave the siblings as
      // unhandled rejections; runWorkerTask only rethrows abort errors.
      const settled = await Promise.allSettled(batch.map(runWorkerTask));
      const rejected = settled.find(
        (r): r is PromiseRejectedResult => r.status === "rejected"
      );
      if (rejected) throw rejected.reason;
    }

    if (executed.length === 0) {
      // Nothing usable this wave. If budget remains and tasks were requeued,
      // try the next cycle instead of silently ending the build half-done.
      benchUnresponsiveWorkers();
      if (workerCalls >= limits.totalWorkerCalls) break;
      emit({
        type: "diagnostic",
        phase: "round_preparing",
        message: `No task produced output in wave ${cycle} — retrying the remaining tasks`,
      });
      continue;
    }

    // Architect review of this wave.
    const executedText = buildWaveReviewDigest(
      executed.map(({ task, worker, files, notes, changes }) => ({
        task,
        workerName: worker.displayName,
        files,
        notes,
        changes,
      }))
    );

    // Mechanical backstop: compile/type-check the project now so the verdict
    // is informed by the actual compiler, not only the models' reading.
    const verifyFeedback = await runVerify(verifyCommand);

    emit({
      type: "diagnostic",
      phase: "judging",
      message: `Architect is reviewing wave ${cycle}`,
    });

    // The Architect may read files or run commands (e.g. tests) before
    // deciding the verdict. Seed with the build-check result.
    let reviewRunFeedback = verifyFeedback ? `\n\n${verifyFeedback}` : "";
    let reviewReadsLeft = 2;
    let reviewRangeReadsLeft = 6;
    let reviewSearchesLeft = SEARCHES_PER_PHASE;
    let action: ArchitectAction;
    let text: string;
    for (;;) {
      throwIfAborted();
      ({ action, text } = await architectAction(
        buildArchitectReviewPrompt({
          request: discussion.topic,
          treeText: treeText(),
          // Everything read so far (plan-phase manifests + read hops) — without
          // this the Architect forgets file contents between phases and starts
          // inventing replacements for files it has already seen.
          fileContext: truncate(extraFileContext, TOTAL_REVIEW_CHARS),
          executedText: executedText + reviewRunFeedback,
          maxNewTasks: limits.tasksPerWave,
          cyclesLeft: limits.cycles - cycle,
          readHopsLeft: reviewReadsLeft,
          rangeReadsLeft: reviewRangeReadsLeft,
          runsLeft: runsLeftThisPhase(),
          githubWorkflow: githubWorkflow && !!runner,
          searchesLeft: reviewSearchesLeft,
          mcpToolsDoc,
          mcpCallsLeft: mcpCallsLeftThisPhase(),
          userNotes: userNotesText(),
          scoreboard: scoreboard.some((s) => s.attempts > 0) ? scoreboardText() : "",
          fetchesLeft: fetchesLeftThisPhase(),
          shellHint,
        }),
        `Architect is reviewing wave ${cycle}`
      ));
      const strictTool = inspectStrictToolActionOutput(text);
      if (strictTool.action && strictTool.feedback && strictTool.valid) {
        reviewRunFeedback += `\n\n${strictTool.feedback}`;
        emit({
          type: "diagnostic",
          phase: "model_failed",
          modelId: architect.modelId,
          modelName: architect.displayName,
          providerId: parseModelId(architect.modelId).providerId,
          message: `Architect tool-call warning while reviewing: ${strictTool.feedback}`,
        });
      } else if (strictTool.feedback && !strictTool.valid) {
        const feedback =
          strictTool.feedback ?? "TOOL CALL REJECTED: invalid tool call.";
        reviewRunFeedback += `\n\n${feedback}\nRe-issue exactly one valid JSON tool action, or produce the review JSON.`;
        emit({
          type: "diagnostic",
          phase: "model_failed",
          modelId: architect.modelId,
          modelName: architect.displayName,
          providerId: parseModelId(architect.modelId).providerId,
          message: `Architect made an invalid tool call while reviewing: ${feedback}`,
        });
        continue;
      }
      if (action.action === "search" && reviewSearchesLeft > 0) {
        reviewSearchesLeft -= 1;
        emitFileToolDiagnostic(
          formatBuildFileToolDiagnostic({
            actor: "Architect",
            action: "search",
            query: action.query,
          }),
          architect
        );
        extraFileContext += `\nSearch results for "${action.query}":\n${await searchProject(action.query)}`;
        continue;
      }
      if (action.action === "tool" && mcpCallsLeftThisPhase() > 0) {
        reviewRunFeedback += `\n\nTool result:\n${await executeTool(action)}`;
        continue;
      }
      if (action.action === "fetch" && fetchesLeftThisPhase() > 0) {
        reviewRunFeedback += `\n\nWeb fetch result:\n${await executeFetch(action)}`;
        continue;
      }
      if (action.action === "read" && reviewReadsLeft > 0) {
        reviewReadsLeft -= 1;
        const paths = action.paths.slice(0, 8);
        emitFileToolDiagnostic(
          formatBuildFileToolDiagnostic({
            actor: "Architect",
            action: "read",
            paths,
          }),
          architect
        );
        const chunks: string[] = [];
        for (const path of paths) {
          const content = await readFile(path);
          chunks.push(
            `\n--- ${path} ---\n${content ?? "[not found or binary]"}`
          );
        }
        // Accumulate so later cycles and the next reviews keep what was read.
        extraFileContext += `\nRequested file contents:${chunks.join("\n")}`;
        continue;
      }
      if (action.action === "read_range" && reviewRangeReadsLeft > 0) {
        reviewRangeReadsLeft -= 1;
        emitFileToolDiagnostic(
          formatBuildFileToolDiagnostic({
            actor: "Architect",
            action: "read_range",
            path: action.path,
            startLine: action.startLine,
            lineCount: action.lineCount,
          }),
          architect
        );
        extraFileContext += `\nRequested file range:\n${await readFileRange(
          action.path,
          action.startLine,
          action.lineCount
        )}`;
        continue;
      }
      if (action.action === "run" && canExecuteRunAction(action.command)) {
        reviewRunFeedback += `\n\nCommand result:\n${await executeRun(action.command, action.reason)}`;
        continue;
      }
      break;
    }
    if (action.action !== "review") {
      throw new Error("Expected a review action from the Architect.");
    }
    // The architect's own fixes. If any were rejected/skipped, carry that into
    // the accumulated context so the next phase knows they did not land.
    const { issues: fixIssues } = await writeEmittedFiles(text);
    if (fixIssues.length > 0) {
      extraFileContext += `\nYOUR PREVIOUS FIXES THAT DID NOT LAND:\n${fixIssues.map((s) => `- ${s}`).join("\n")}`;
    }

    if (action.notes?.trim()) architectNotes = action.notes;

    for (const result of action.results) {
      const task = tasks.find((t) => t.id === result.taskId);
      if (!task || task.status === "done") continue;
      // Credit/debit the worker that produced this task's output.
      const verdictStat =
        task.workerIndex != null ? scoreboard[task.workerIndex] : null;
      if (result.verdict === "approve") {
        if (verdictStat) {
          verdictStat.approvals += 1;
          verdictStat.wApprovals += difficultyWeight(task);
        }
        task.status = "done";
        emit({ type: "task_status", taskId: task.id, title: task.title, status: "done", cycle });
      } else {
        if (verdictStat) {
          verdictStat.fixes += 1;
          verdictStat.wFixes += difficultyWeight(task);
        }
        task.status = "fixing";
        // The fixing worker must see the files it wrote last time.
        const prior = executed.find((e) => e.task.id === task.id);
        if (prior && prior.files.length > 0) {
          task.contextFiles = [
            ...new Set([...task.contextFiles, ...prior.files]),
          ].slice(0, MAX_CONTEXT_FILES);
        }
        task.instructions = `${task.instructions}\n\nFIX (from the Architect's review): ${result.fixInstructions ?? "address the review feedback"}`;
        emit({ type: "task_status", taskId: task.id, title: task.title, status: "fixing", cycle });
      }
    }
    // Tasks the review didn't mention count as approved.
    for (const { task } of executed) {
      if (task.status === "review") {
        if (task.workerIndex != null) {
          const st = scoreboard[task.workerIndex];
          st.approvals += 1;
          st.wApprovals += difficultyWeight(task);
        }
        task.status = "done";
        emit({ type: "task_status", taskId: task.id, title: task.title, status: "done", cycle });
      }
    }

    benchUnresponsiveWorkers();

    emit({
      type: "diagnostic",
      phase: "judging",
      message: `Worker scoreboard after wave ${cycle}:\n${scoreboardText()}`,
    });

    for (const raw of (action.newTasks ?? []).slice(0, limits.tasksPerWave)) {
      const task = toTask(raw, tasks.length);
      tasks.push(task);
      emit({ type: "task_status", taskId: task.id, title: task.title, status: "planned", cycle });
    }

    done = action.done;
  }

  // Fold this build's scoreboard into the global per-model stats (the
  // "which models actually perform" view on the dashboard). The Architect is
  // the judge of record; a verdict is "independent" when the judge is a
  // different model from the one being scored (not grading its own work).
  accumulateModelStats({
    judgeModelId: architect.modelId,
    workers: scoreboard
      .filter((s) => s.attempts > 0)
      .map((s) => ({
        modelId: workers[s.index].modelId,
        displayName: s.name,
        attempts: s.attempts,
        approvals: s.approvals,
        fixes: s.fixes,
        badOutput: s.badOutput,
        unavailable: s.unavailable,
        wApprovals: s.wApprovals,
        wFixes: s.wFixes,
        wBadOutput: s.wBadOutput,
        responseMs: s.responseMs,
        responseChars: s.responseChars,
      })),
  });

  // ── Final summary ──────────────────────────────────────────────────────────
  const incompleteTasks = findIncompleteBuildTasks(tasks);
  if (incompleteTasks.length > 0) {
    const message = buildIncompleteTaskFailure(incompleteTasks);
    emit({
      type: "diagnostic",
      phase: "model_failed",
      message,
    });
    throw new Error(message);
  }

  throwIfAborted();
  emit({ type: "status", status: "judging" });
  emit({
    type: "diagnostic",
    phase: "judging",
    message: "Architect is writing the final build summary",
  });

  const historyText = history
    .map((h) => `## ${h.label}\n${truncate(h.text, 2_500)}`)
    .join("\n\n");

  const summaryRaw = await streamTurn(
    architect,
    buildArchitectSummaryPrompt({
      request: discussion.topic,
      treeText: treeText(),
      filesChanged: [...writtenThisRun].sort().join("\n"),
      historyText: truncate(historyText, 60_000),
      verbosityInstruction,
      userNotes: userNotesText(),
    }),
    {
      systemRole:
        "You are the Architect writing the final hand-off summary in Markdown.",
      maxTokens: architectMaxTokens,
      label: "Architect is writing the build summary",
    }
  );

  const { answer, confidence, dissent } = extractJudgeResult(summaryRaw);
  insertFinalResult({
    discussionId: discussion.id,
    answer,
    confidence,
    dissent: JSON.stringify(dissent),
    createdAt: new Date().toISOString(),
  });
  updateDiscussion(discussion.id, {
    status: "completed",
    updatedAt: new Date().toISOString(),
  });
  emit({ type: "final_answer", answer, confidence, dissent });
  // Files land via the runner (its folder), the picked browser folder, or
  // in-app only — name whichever actually applied.
  const diskLabel = runner ? runnerDirName : diskGranted ? dirHandle?.name : null;
  emit({
    type: "diagnostic",
    phase: "finished",
    message: `Build complete: ${virtualFs.size} file(s) produced${diskLabel ? ` in "${diskLabel}"` : " (download from the artifact panel)"}`,
  });
  emit({ type: "complete" });
}
