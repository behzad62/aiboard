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
  buildWorkerTaskPrompt,
  parseArchitectAction,
  STRICT_RETRY_INSTRUCTION,
  type ArchitectAction,
  type BuildTask,
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
  callMcpTool,
  checkRunner,
  formatCommandResult,
  listFilesViaRunner,
  listMcpServers,
  readFileViaRunner,
  runCommand,
  searchViaRunner,
  writeFileViaRunner,
  type RunnerConfig,
} from "./runner";
import {
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

type EventCallback = (event: OrchestratorEvent) => void;

export type CommandApprovalDecision = "allow" | "allow-all" | "deny";

/** UI hooks injected by the discussion page (e.g. the approval prompt). */
export interface BuildHooks {
  requestCommandApproval?: (
    command: string,
    reason?: string
  ) => Promise<CommandApprovalDecision>;
}

const RUNS_PER_PHASE = 4;
const TOTAL_RUNS = 12;
const SEARCHES_PER_PHASE = 4;
const MCP_CALLS_PER_PHASE = 8;
const TOTAL_MCP_CALLS = 24;

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

  // ── Filesystem: virtual always; the real folder when granted ──────────────
  // A folder problem (no permission, moved, or — common on Documents —
  // OneDrive "online-only" placeholder files that throw NotFoundError) must
  // never fail the build. Any error here degrades to in-app/virtual files.
  const dirHandle = await getProjectHandle(discussion.id);
  const virtualFs = new Map<string, string>();
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

  // ── Optional local runner (user-started; opt-in by config) ────────────────
  let runner: RunnerConfig | null = null;
  let allowAllCommands = discussion.runnerAccess === "full";
  let totalRuns = 0;
  let mcpToolsDoc = "";
  let totalMcpCalls = 0;
  if (discussion.runnerUrl && discussion.runnerToken) {
    const config = { url: discussion.runnerUrl, token: discussion.runnerToken };
    const health = await checkRunner(config);
    if (health.ok) {
      runner = config;
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

  const runsLeftThisPhase = (): number =>
    runner ? Math.min(RUNS_PER_PHASE, TOTAL_RUNS - totalRuns) : 0;

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
    totalRuns += 1;
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
          (result.stdout || result.stderr).trim(),
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

  const writeFile = async (
    path: string,
    content: string,
    taskId?: string
  ): Promise<void> => {
    virtualFs.set(path, content);
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
    opts: { systemRole: string; maxTokens: number; label: string }
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
    const content = await collectStream(
      model.modelId,
      providerId,
      rawModel,
      [
        { role: "system", content: opts.systemRole },
        { role: "user", content: prompt },
      ],
      opts.maxTokens,
      0.4,
      reasoningEffort,
      [],
      (token) => emit({ type: "message_token", messageId, token }),
      signal
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

  /**
   * Write any ```lang path=...``` files and apply any ```edit path=...```
   * SEARCH/REPLACE blocks contained in a model's output.
   */
  const writeEmittedFiles = async (
    text: string,
    taskId?: string
  ): Promise<string[]> => {
    const { files, edits } = extractArtifacts(text);
    const written: string[] = [];
    for (const file of files) {
      await writeFile(file.path, file.content, taskId);
      written.push(file.path);
    }
    for (const edit of edits) {
      const current = await readFile(edit.path);
      if (current == null) {
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `Edit to ${edit.path} skipped — the file doesn't exist`,
        });
        continue;
      }
      const { content, applied, failed } = applyEditOps(current, edit.ops);
      if (applied > 0) {
        await writeFile(edit.path, content, taskId);
        written.push(edit.path);
      }
      if (failed > 0) {
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `${failed} edit(s) to ${edit.path} didn't match the current content and were skipped`,
        });
      }
    }
    return written;
  };

  const toTask = (
    raw: PlanAction["tasks"][number],
    index: number
  ): BuildTask => ({
    id: raw.id?.trim() || `T${index + 1}`,
    title: raw.title || `Task ${index + 1}`,
    instructions: raw.instructions || raw.title || "",
    contextFiles: (raw.contextFiles ?? []).slice(0, MAX_CONTEXT_FILES),
    expectedOutputs: raw.expectedOutputs,
    status: "planned",
    dependsOn: Array.isArray(raw.dependsOn)
      ? raw.dependsOn.filter((d): d is string => typeof d === "string")
      : [],
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
      searchesLeft: planSearchesLeft,
      mcpToolsDoc,
      mcpCallsLeft: mcpCallsLeftThisPhase(),
      userNotes: userNotesText(),
      previousSummary: truncate(previousSummary, 6_000),
    });
    const { action, text } = await architectAction(planPrompt, "Architect is planning the project");
    if (action.action === "search" && planSearchesLeft > 0) {
      planSearchesLeft -= 1;
      extraFileContext += `\nSearch results for "${action.query}":\n${await searchProject(action.query)}`;
      continue;
    }
    if (action.action === "tool" && mcpCallsLeftThisPhase() > 0) {
      runFeedback += `\n\nTool result:\n${await executeTool(action)}`;
      continue;
    }
    if (action.action === "read" && readHopsLeft > 0) {
      readHopsLeft -= 1;
      const chunks: string[] = [];
      for (const path of action.paths.slice(0, 8)) {
        const content = await readFile(path);
        chunks.push(
          `\n--- ${path} ---\n${content ?? "[not found or binary]"}`
        );
      }
      extraFileContext += `\nRequested file contents:${chunks.join("\n")}`;
      continue;
    }
    if (action.action === "run" && runsLeftThisPhase() > 0) {
      runFeedback += `\n\nCommand result:\n${await executeRun(action.command, action.reason)}`;
      continue;
    }
    if (action.action === "plan") {
      tasks = action.tasks.slice(0, limits.tasksPerWave).map(toTask);
      architectNotes = action.notes ?? "";
      await writeEmittedFiles(text); // architect may scaffold files in the plan
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
  let rrIndex = 0;
  let done = false;

  for (let cycle = 1; cycle <= limits.cycles && !done; cycle++) {
    const pending = tasks.filter(
      (t) => t.status === "planned" || t.status === "fixing"
    );
    if (pending.length === 0) break;

    const executed: Array<{ task: BuildTask; worker: SelectedModel; files: string[]; notes: string }> = [];

    const runWorkerTask = async (task: BuildTask): Promise<void> => {
      const workerIndex = task.workerIndex ?? rrIndex++ % workers.length;
      task.workerIndex = workerIndex;
      const worker = workers[workerIndex];

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

      try {
        const output = await streamTurn(
          worker,
          buildWorkerTaskPrompt({
            request: discussion.topic,
            treeText: treeText(),
            task,
            contextFileText: contextChunks.length
              ? `\nContext files:${contextChunks.join("\n")}`
              : "",
            architectNotes,
            verbosityInstruction,
          }),
          {
            systemRole:
              "You are an AI engineer completing one assigned task. Output complete files in the required format.",
            maxTokens: workerMaxTokens,
            label: `${worker.displayName} working on ${task.id}: ${task.title}`,
          }
        );
        const files = await writeEmittedFiles(output, task.id);
        const { prose } = extractArtifacts(output);
        task.status = "review";
        executed.push({ task, worker, files, notes: truncate(prose, 1_500) });
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
        task.status = "failed";
        emit({
          type: "task_status",
          taskId: task.id,
          title: task.title,
          status: "failed",
          worker: worker.displayName,
          cycle,
        });
        emit({
          type: "diagnostic",
          phase: "model_failed",
          message: `${worker.displayName} failed ${task.id}: ${err instanceof Error ? err.message : "error"}`,
        });
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
      const batch = ready.slice(0, limits.totalWorkerCalls - workerCalls);
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

    if (executed.length === 0) break;

    // Architect review of this wave.
    let totalChars = 0;
    const executedText = executed
      .map(({ task, worker, files, notes }) => {
        const fileBlocks = files
          .map((path) => {
            const content = virtualFs.get(path) ?? "";
            const block = `--- ${path} ---\n${truncate(content, PER_FILE_REVIEW_CHARS)}`;
            totalChars += block.length;
            return totalChars > TOTAL_REVIEW_CHARS ? `--- ${path} --- [omitted for length]` : block;
          })
          .join("\n");
        return `### ${task.id}: ${task.title} (worker: ${worker.displayName})\nWorker notes: ${notes || "none"}\nFiles written:\n${fileBlocks || "none"}`;
      })
      .join("\n\n");

    emit({
      type: "diagnostic",
      phase: "judging",
      message: `Architect is reviewing wave ${cycle}`,
    });

    // The Architect may read files or run commands (e.g. tests) before
    // deciding the verdict.
    let reviewRunFeedback = "";
    let reviewReadsLeft = 2;
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
          runsLeft: runsLeftThisPhase(),
          searchesLeft: reviewSearchesLeft,
          mcpToolsDoc,
          mcpCallsLeft: mcpCallsLeftThisPhase(),
          userNotes: userNotesText(),
        }),
        `Architect is reviewing wave ${cycle}`
      ));
      if (action.action === "search" && reviewSearchesLeft > 0) {
        reviewSearchesLeft -= 1;
        extraFileContext += `\nSearch results for "${action.query}":\n${await searchProject(action.query)}`;
        continue;
      }
      if (action.action === "tool" && mcpCallsLeftThisPhase() > 0) {
        reviewRunFeedback += `\n\nTool result:\n${await executeTool(action)}`;
        continue;
      }
      if (action.action === "read" && reviewReadsLeft > 0) {
        reviewReadsLeft -= 1;
        const chunks: string[] = [];
        for (const path of action.paths.slice(0, 8)) {
          const content = await readFile(path);
          chunks.push(
            `\n--- ${path} ---\n${content ?? "[not found or binary]"}`
          );
        }
        // Accumulate so later cycles and the next reviews keep what was read.
        extraFileContext += `\nRequested file contents:${chunks.join("\n")}`;
        continue;
      }
      if (action.action === "run" && runsLeftThisPhase() > 0) {
        reviewRunFeedback += `\n\nCommand result:\n${await executeRun(action.command, action.reason)}`;
        continue;
      }
      break;
    }
    if (action.action !== "review") {
      throw new Error("Expected a review action from the Architect.");
    }
    await writeEmittedFiles(text); // the architect's own fixes

    if (action.notes?.trim()) architectNotes = action.notes;

    for (const result of action.results) {
      const task = tasks.find((t) => t.id === result.taskId);
      if (!task || task.status === "done") continue;
      if (result.verdict === "approve") {
        task.status = "done";
        emit({ type: "task_status", taskId: task.id, title: task.title, status: "done", cycle });
      } else {
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
        task.status = "done";
        emit({ type: "task_status", taskId: task.id, title: task.title, status: "done", cycle });
      }
    }

    for (const raw of (action.newTasks ?? []).slice(0, limits.tasksPerWave)) {
      const task = toTask(raw, tasks.length);
      tasks.push(task);
      emit({ type: "task_status", taskId: task.id, title: task.title, status: "planned", cycle });
    }

    done = action.done;
  }

  // ── Final summary ──────────────────────────────────────────────────────────
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
  emit({
    type: "diagnostic",
    phase: "finished",
    message: `Build complete: ${virtualFs.size} file(s) produced${diskGranted ? ` in "${dirHandle?.name}"` : " (download from the artifact panel)"}`,
  });
  emit({ type: "complete" });
}
