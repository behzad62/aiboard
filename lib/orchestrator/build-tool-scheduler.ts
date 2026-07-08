/**
 * Pure scheduling helpers for Build-mode tool batches. The model may request
 * several tool actions in one turn; the engine classifies them, runs safe reads
 * together, queues mutations in order (never overlapping the same path), keeps
 * risky shell commands single-step, and packs one combined, capped tool result
 * back to the model with an explicit served/skipped report.
 */

import type { ArchitectAction } from "@/lib/orchestrator/build";
import { exactToolKey } from "@/lib/orchestrator/build";

export type BuildToolScheduleClass =
  | "batch_read"
  | "queued_mutation"
  | "safe_run"
  | "exclusive";

export interface ScheduledToolAction {
  action: ArchitectAction;
  label: string;
  scheduleClass: BuildToolScheduleClass;
}

export interface SkippedToolAction {
  action: ArchitectAction;
  label: string;
  reason: string;
}

interface ReplayRangeEntry {
  path: string;
  startLine: number;
  endLine: number;
  result: string;
  totalLines?: number;
  lines?: string[];
}

export function classifyBuildToolActionForScheduling(
  action: ArchitectAction
): BuildToolScheduleClass {
  switch (action.action) {
    case "read":
    case "read_range":
    case "context_retrieve":
    case "code_intel":
    case "search":
    // fetch is a non-mutating network read (no repo side effects), so it batches
    // with reads — the same servable safety class the Architect fetch path implies.
    // (Unlike other batch_reads it may block on a per-fetch user approval prompt,
    // but it never mutates, so batch ordering stays safe.)
    case "fetch":
    case "repo_status":
    case "repo_diff":
    case "repo_issue_list":
    case "repo_issue_read":
      return "batch_read";
    case "patch":
    case "append":
    case "repo_branch_create":
    case "repo_commit":
    case "repo_push":
    case "repo_pr_create":
    case "repo_milestone_create":
    case "repo_issue_create":
      return "queued_mutation";
    case "run":
      return isSafeQueuedRunCommand(action.command) ? "safe_run" : "exclusive";
    default:
      return "exclusive";
  }
}

/**
 * A shell command safe to run inside a batch in full-access mode: read-only git
 * inspection, ripgrep, the project's test/build/lint/typecheck scripts, or a tsx
 * test script. Anything with shell chaining/redirection (`;`, `&`, `|`, `>`) is
 * excluded so a "safe" prefix can't smuggle a side effect.
 */
export function isSafeQueuedRunCommand(command: string): boolean {
  const trimmed = command.trim();
  return (
    (/^git\s+(?:status|diff|show|log|branch)(?:\s|$)/i.test(trimmed) ||
      /^rg(?:\s|$)/i.test(trimmed) ||
      /^npm\s+(?:test|run\s+(?:build|lint|test|typecheck))(?:\s|$)/i.test(trimmed) ||
      /^npx\s+tsx\s+scripts\/[\w.-]+\.mts(?:\s|$)/i.test(trimmed.replace(/\\/g, "/"))) &&
    !/[;&|]|\d?>|>>/.test(trimmed)
  );
}

function labelFor(action: ArchitectAction): string {
  switch (action.action) {
    case "read":
      return `read ${action.paths.join(", ")}`;
    case "read_range":
      return `read_range ${action.path}:${action.startLine}`;
    case "context_retrieve":
      return `context_retrieve ${action.ref}@${action.offsetChars ?? 0}`;
    case "code_intel":
      return `code_intel ${action.op}`;
    case "search":
      return `search ${action.query}`;
    case "run":
      return `run ${action.command}`;
    case "fetch":
      return `fetch ${action.url}`;
    case "tool":
      return `mcp:${action.server}.${action.tool}`;
    case "patch":
      return `patch ${action.path}`;
    case "append":
      return `append ${action.path}`;
    default:
      return action.action;
  }
}

export function scheduleBuildToolActions(
  actions: ArchitectAction[],
  options: { allowSafeRunQueue: boolean; maxSafeRuns: number }
): { served: ScheduledToolAction[]; skipped: SkippedToolAction[] } {
  const served: ScheduledToolAction[] = [];
  const skipped: SkippedToolAction[] = [];
  let safeRuns = 0;
  let contextRetrieves = 0;
  const mutationPaths = new Set<string>();

  for (const action of actions) {
    const scheduleClass = classifyBuildToolActionForScheduling(action);
    const label = labelFor(action);
    if (action.action === "context_retrieve") {
      if (contextRetrieves > 0) {
        skipped.push({
          action,
          label,
          reason: "only one context_retrieve can run per batch",
        });
        continue;
      }
      contextRetrieves += 1;
    }
    if (scheduleClass === "safe_run") {
      if (options.allowSafeRunQueue && safeRuns < options.maxSafeRuns) {
        safeRuns += 1;
        served.push({ action, label, scheduleClass });
        continue;
      }
      // Can't batch it (queue disabled, e.g. ask mode, or queue full). Fall back
      // to single-step: serve it alone so it still runs through the normal
      // (approval-gated) command path; skip it only if other actions already ran.
      if (served.length > 0) {
        skipped.push({ action, label, reason: "command must run alone — not batched here" });
        continue;
      }
      served.push({ action, label, scheduleClass: "exclusive" });
      continue;
    }
    if (scheduleClass === "queued_mutation") {
      const path =
        action.action === "patch" || action.action === "append"
          ? action.path.toLowerCase()
          : "";
      if (path && mutationPaths.has(path)) {
        skipped.push({ action, label, reason: "another mutation in this batch targets the same path" });
        continue;
      }
      if (path) mutationPaths.add(path);
      served.push({ action, label, scheduleClass });
      continue;
    }
    if (scheduleClass === "exclusive" && served.length > 0) {
      skipped.push({ action, label, reason: "exclusive action must run alone" });
      continue;
    }
    served.push({ action, label, scheduleClass });
  }

  return { served, skipped };
}

export function skippedOnlyToolBatchRecoveryInstruction(input: {
  servedCount: number;
  skippedCount: number;
  terminalSkippedCount?: number;
}): string {
  if ((input.terminalSkippedCount ?? 0) > 0) {
    return "\n\nA requested tool could not run because the required tool budget or runner resource is unavailable. Stop using tools now and provide the final task output from the context already available.";
  }
  if (input.servedCount !== 0 || input.skippedCount <= 0) return "";
  return "\n\nNo requested tools were run. If the skipped actions were duplicate, unsupported, or out of budget, stop using tools now and provide the final task output from the context already available.";
}

function requestedRange(action: Extract<ArchitectAction, { action: "read_range" }>): {
  path: string;
  startLine: number;
  endLine: number;
} {
  const startLine = Math.max(1, Math.round(action.startLine));
  return {
    path: action.path.trim().toLowerCase(),
    startLine,
    endLine: startLine + Math.max(1, Math.round(action.lineCount)) - 1,
  };
}

function rangeCoverage(
  delivered: Pick<ReplayRangeEntry, "startLine" | "endLine">,
  requested: Pick<ReplayRangeEntry, "startLine" | "endLine">
): number {
  const requestedLines = requested.endLine - requested.startLine + 1;
  if (requestedLines <= 0) return 1;
  const coveredStart = Math.max(delivered.startLine, requested.startLine);
  const coveredEnd = Math.min(delivered.endLine, requested.endLine);
  if (coveredEnd < coveredStart) return 0;
  return (coveredEnd - coveredStart + 1) / requestedLines;
}

function combinedRangeCoverage(
  delivered: Array<Pick<ReplayRangeEntry, "startLine" | "endLine">>,
  requested: Pick<ReplayRangeEntry, "startLine" | "endLine">
): number {
  const requestedLines = requested.endLine - requested.startLine + 1;
  if (requestedLines <= 0) return 1;
  const covered = new Set<number>();
  for (const range of delivered) {
    const coveredStart = Math.max(range.startLine, requested.startLine);
    const coveredEnd = Math.min(range.endLine, requested.endLine);
    for (let line = coveredStart; line <= coveredEnd; line++) {
      covered.add(line);
    }
  }
  return covered.size / requestedLines;
}

function parseRangeResultLines(
  result: string,
  startLine: number,
  endLine: number
): { totalLines?: number; lines?: string[] } {
  const [header = "", ...bodyLines] = result.split("\n");
  const headerMatch = /lines (\d+)-(\d+) of (\d+)/.exec(header);
  if (!headerMatch) return {};

  const headerStart = Number(headerMatch[1]);
  const headerEnd = Number(headerMatch[2]);
  const totalLines = Number(headerMatch[3]);
  const expectedLines = endLine - startLine + 1;
  if (
    headerStart !== startLine ||
    headerEnd !== endLine ||
    expectedLines < 0 ||
    bodyLines.length !== expectedLines
  ) {
    return { totalLines };
  }
  return { totalLines, lines: bodyLines };
}

interface ReadRangeLoopGuardState {
  totalLines?: number;
  intervals: Array<{ startLine: number; endLine: number }>;
}

export interface ReadRangeLoopGuardOptions {
  minTotalLines?: number;
  coverageThreshold?: number;
  restartFraction?: number;
}

export function createReadRangeLoopGuard(
  options: ReadRangeLoopGuardOptions = {}
): {
  record: (
    action: Extract<ArchitectAction, { action: "read_range" }>,
    result: string
  ) => void;
  shouldInterrupt: (
    action: Extract<ArchitectAction, { action: "read_range" }>
  ) => string | null;
} {
  const minTotalLines = Math.max(1, Math.floor(options.minTotalLines ?? 800));
  const coverageThreshold = Math.max(
    0.1,
    Math.min(1, options.coverageThreshold ?? 0.85)
  );
  const restartFraction = Math.max(
    0.05,
    Math.min(0.75, options.restartFraction ?? 0.3)
  );
  const states = new Map<string, ReadRangeLoopGuardState>();

  const coveredLineCount = (intervals: ReadRangeLoopGuardState["intervals"]): number =>
    intervals.reduce((sum, range) => sum + Math.max(0, range.endLine - range.startLine + 1), 0);

  const mergeInterval = (
    intervals: ReadRangeLoopGuardState["intervals"],
    next: { startLine: number; endLine: number }
  ): ReadRangeLoopGuardState["intervals"] => {
    const sorted = [...intervals, next].sort((a, b) => a.startLine - b.startLine);
    const merged: ReadRangeLoopGuardState["intervals"] = [];
    for (const range of sorted) {
      const prior = merged[merged.length - 1];
      if (!prior || range.startLine > prior.endLine + 1) {
        merged.push({ ...range });
      } else {
        prior.endLine = Math.max(prior.endLine, range.endLine);
      }
    }
    return merged;
  };

  const parseDelivered = (
    result: string
  ): { startLine: number; endLine: number; totalLines?: number } | null => {
    const header = result.split("\n", 1)[0] ?? "";
    const match = /lines (\d+)-(\d+) of (\d+)/.exec(header);
    if (!match) return null;
    return {
      startLine: Number(match[1]),
      endLine: Number(match[2]),
      totalLines: Number(match[3]),
    };
  };

  return {
    record(action, result) {
      const requested = requestedRange(action);
      const delivered = parseDelivered(result) ?? {
        startLine: requested.startLine,
        endLine: requested.endLine,
        totalLines: undefined,
      };
      const startLine = Math.max(1, delivered.startLine);
      const endLine = Math.max(startLine, delivered.endLine);
      const existing = states.get(requested.path) ?? { intervals: [] };
      states.set(requested.path, {
        totalLines:
          typeof delivered.totalLines === "number" && Number.isFinite(delivered.totalLines)
            ? delivered.totalLines
            : existing.totalLines,
        intervals: mergeInterval(existing.intervals, { startLine, endLine }),
      });
    },
    shouldInterrupt(action) {
      const requested = requestedRange(action);
      const state = states.get(requested.path);
      const totalLines = state?.totalLines;
      if (!state || !totalLines || totalLines < minTotalLines) return null;
      const coverage = coveredLineCount(state.intervals) / totalLines;
      if (coverage < coverageThreshold) return null;
      const restartZoneEnd = Math.max(1, Math.floor(totalLines * restartFraction));
      if (requested.startLine > restartZoneEnd) return null;
      const percent = Math.round(coverage * 100);
      return `read_range loop detected for ${requested.path}: already delivered ${percent}% of this ${totalLines}-line file, then the worker started paging from the beginning again. Stop rereading chunks; use code_intel/search to target symbols, emit a scoped patch, ask guidance, or finalize from existing context.`;
    },
  };
}

function buildSyntheticRangeReplay(input: {
  path: string;
  requested: { startLine: number; endLine: number };
  ranges: ReplayRangeEntry[];
}): string | null {
  const usable = input.ranges
    .filter(
      (range): range is ReplayRangeEntry & { lines: string[] } =>
        range.path === input.path && Array.isArray(range.lines) && range.lines.length > 0
    )
    .sort((a, b) => a.startLine - b.startLine);
  if (usable.length === 0) return null;
  if (combinedRangeCoverage(usable, input.requested) < 0.9) return null;

  const totalLines =
    usable.find((range) => Number.isFinite(range.totalLines))?.totalLines ??
    input.requested.endLine;
  const out: string[] = [];
  let gapStart: number | null = null;

  const flushGap = (endLine: number): void => {
    if (gapStart == null) return;
    out.push(
      `[cached replay gap: lines ${gapStart}-${endLine} were not available]`
    );
    gapStart = null;
  };

  for (let line = input.requested.startLine; line <= input.requested.endLine; line++) {
    const entry = usable.find(
      (range) => line >= range.startLine && line <= range.endLine
    );
    if (!entry) {
      if (gapStart == null) gapStart = line;
      continue;
    }
    flushGap(line - 1);
    out.push(entry.lines[line - entry.startLine]);
  }
  flushGap(input.requested.endLine);
  if (out.length === 0) return null;

  return [
    "REPLAYED COVERED READ_RANGE - this requested range was already covered by earlier read_range results and is repeated here without spending tool budget.",
    `--- ${input.path} lines ${input.requested.startLine}-${input.requested.endLine} of ${totalLines} (replayed from cached reads) ---`,
    out.join("\n"),
  ].join("\n");
}

function replayableExactKey(action: ArchitectAction): string | null {
  if (
    action.action !== "read" &&
    action.action !== "search" &&
    action.action !== "context_retrieve" &&
    action.action !== "code_intel" &&
    action.action !== "fetch"
  ) {
    return null;
  }
  return exactToolKey(action);
}

export interface ToolReplayCache {
  remember: (
    action: ArchitectAction,
    result: string,
    deliveredRange?: { startLine: number; endLine: number }
  ) => void;
  replay: (action: ArchitectAction) => string | null;
  summary: (maxEntries?: number) => string[];
}

export interface ReplayedDuplicateToolAction {
  served: {
    label: string;
    result: string;
    preserveFullResult?: boolean;
  } | null;
  skipped: {
    label: string;
    reason: string;
  } | null;
}

export function createToolReplayCache(): ToolReplayCache {
  const exact = new Map<string, string>();
  const ranges: ReplayRangeEntry[] = [];
  const memory: string[] = [];
  const memoryKeys = new Set<string>();
  const replayPrefix =
    "REPLAYED DUPLICATE TOOL RESULT - this result was already delivered earlier in the task and is repeated here without spending tool budget.\n";
  const rememberMemory = (key: string, label: string): void => {
    if (memoryKeys.has(key)) return;
    memoryKeys.add(key);
    memory.push(label);
  };

  return {
    remember(action, result, deliveredRange) {
      if (action.action === "read_range") {
        const requested = requestedRange(action);
        const startLine = deliveredRange?.startLine ?? requested.startLine;
        const endLine = deliveredRange?.endLine ?? requested.endLine;
        if (endLine >= startLine) {
          const parsed = parseRangeResultLines(result, startLine, endLine);
          ranges.push({
            path: requested.path,
            startLine,
            endLine,
            result,
            totalLines: parsed.totalLines,
            lines: parsed.lines,
          });
          rememberMemory(
            `read_range:${requested.path}:${startLine}-${endLine}`,
            `read_range ${requested.path}:${startLine}-${endLine}`
          );
        }
        return;
      }
      const key = replayableExactKey(action);
      if (key) {
        exact.set(key, result);
        rememberMemory(key, toolMemoryLabel(action));
      }
    },
    replay(action) {
      if (action.action === "read_range") {
        const requested = requestedRange(action);
        const entry = ranges.find(
          (candidate) =>
            candidate.path === requested.path &&
            rangeCoverage(candidate, requested) >= 0.9
        );
        if (entry) return `${replayPrefix}${entry.result}`;
        return buildSyntheticRangeReplay({
          path: requested.path,
          requested,
          ranges,
        });
      }
      const key = replayableExactKey(action);
      if (!key) return null;
      const result = exact.get(key);
      return result ? `${replayPrefix}${result}` : null;
    },
    summary(maxEntries = 20) {
      return memory.slice(-Math.max(1, Math.floor(maxEntries)));
    },
  };
}

export function replayDuplicateToolAction(input: {
  action: ArchitectAction;
  label: string;
  replayCache: ToolReplayCache;
}): ReplayedDuplicateToolAction {
  const replayed = input.replayCache.replay(input.action);
  if (replayed) {
    return {
      served: {
        label: `${input.label} (replayed)`,
        result: replayed,
        preserveFullResult: input.action.action === "context_retrieve",
      },
      skipped: null,
    };
  }
  return {
    served: null,
    skipped: {
      label: input.label,
      reason: "duplicate tool request (already delivered)",
    },
  };
}

function toolMemoryLabel(action: ArchitectAction): string {
  switch (action.action) {
    case "read":
      return `read ${action.paths.join(", ")}`;
    case "search":
      return `search ${action.query}`;
    case "context_retrieve":
      return `context_retrieve ${action.ref}@${action.offsetChars ?? 0}`;
    case "code_intel":
      return `code_intel ${action.op}${
        action.query ? ` ${action.query}` : action.symbol ? ` ${action.symbol}` : ""
      }`;
    case "fetch":
      return `fetch ${action.url}`;
    default:
      return exactToolKey(action) ?? action.action;
  }
}

export function packToolBatchResult(input: {
  served: Array<{ label: string; result: string; preserveFullResult?: boolean }>;
  skipped: Array<{ label: string; reason: string }>;
  memory?: string[];
  maxChars: number;
}): string {
  const lines: string[] = ["TOOL BATCH RESULT", ""];
  lines.push("Served:");
  lines.push(...(input.served.length ? input.served.map((item) => `- ${item.label}`) : ["- none"]));
  lines.push("", "Skipped:");
  lines.push(...(input.skipped.length ? input.skipped.map((item) => `- ${item.label}: ${item.reason}`) : ["- none"]));
  const memory = (input.memory ?? []).map((item) => item.trim()).filter(Boolean);
  if (memory.length > 0) {
    lines.push(
      "",
      "Already available in this task (do not re-request these; use the cached context above/below or ask for a different target):"
    );
    lines.push(...memory.map((item) => `- ${item}`));
  }
  lines.push("", "Results:");
  let remaining = input.maxChars - lines.join("\n").length;
  for (const item of input.served) {
    const header = `\n--- ${item.label} ---\n`;
    if (item.preserveFullResult) {
      lines.push(`${header}${item.result}`);
      remaining -= header.length + item.result.length;
      continue;
    }
    if (remaining <= 0) {
      lines.push(`\n--- ${item.label} ---\n[omitted: output cap reached]`);
      continue;
    }
    const slice = item.result.slice(0, Math.max(0, remaining - header.length));
    const suffix = slice.length < item.result.length ? "\n[truncated: output cap reached]" : "";
    lines.push(`${header}${slice}${suffix}`);
    remaining -= header.length + slice.length + suffix.length;
  }
  return lines.join("\n");
}
