import {
  createBuildPromptBudget,
  type BuildPromptBudget,
  type BuildPromptRole,
  type CreateBuildPromptBudgetOptions,
} from "./budgets";
import {
  assembleContextPackPrompt,
  renderAssembledContext,
  type AssembledBuildContext,
} from "./prompt-assembly";
import type { ContextPack } from "./context-packs";
import {
  buildArchitectMemoryBrief,
  buildWorkerMemoryBrief,
} from "./memory-brief";
import type { BuildMemoryRecord } from "./memory-store";

export * from "./budgets";
export * from "./context-packs";
export * from "./code-intel-plus";
export * from "./memory-brief";
export * from "./memory-extractors";
export * from "./memory-store";
export * from "./prompt-assembly";
export * from "./token-estimator";
export { renderAssembledContext };

type BuildContextProfile = CreateBuildPromptBudgetOptions["profile"];

interface BuildContextBaseInput {
  modelContextProfile?: BuildContextProfile;
  profile?: BuildContextProfile;
  contextPacks?: ContextPack[];
}

export interface BuildPlanContextInput extends BuildContextBaseInput {
  request: string;
  treeText?: string;
  fileContext?: string;
  previousSummary?: string;
  userNotes?: string;
  scoreboard?: string;
  memoryBrief?: string;
  memoryRecords?: BuildMemoryRecord[];
}

export interface BuildContextTask {
  id: string;
  title?: string;
  instructions?: string;
  contextFiles?: string[];
  outputPaths?: string[];
  expectedOutputs?: string;
}

export interface BuildWorkerContextInput extends BuildContextBaseInput {
  request: string;
  treeText?: string;
  task: BuildContextTask;
  contextFileText?: string;
  architectNotes?: string;
  memoryBrief?: string;
  memoryRecords?: BuildMemoryRecord[];
}

export interface BuildReviewContextInput extends BuildContextBaseInput {
  request: string;
  treeText?: string;
  fileContext?: string;
  executedText?: string;
  outstandingTasks?: string;
  verificationText?: string;
  userNotes?: string;
  scoreboard?: string;
  memoryBrief?: string;
  memoryRecords?: BuildMemoryRecord[];
  skillEvidenceText?: string;
}

export interface BuildSummaryContextInput extends BuildContextBaseInput {
  request: string;
  treeText?: string;
  filesChanged?: string;
  historyText?: string;
  verificationText?: string;
  knownGaps?: string;
  userNotes?: string;
  memoryBrief?: string;
  memoryRecords?: BuildMemoryRecord[];
  skillEvidenceText?: string;
}

function normalizedPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "")
    .trim()
    .toLowerCase();
}

function pathsOverlap(a: string, b: string): boolean {
  const left = normalizedPath(a);
  const right = normalizedPath(b);
  if (!left || !right) return false;
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function compactLines(lines: Array<string | undefined>): string {
  return lines
    .map((line) => line?.trim() ?? "")
    .filter(Boolean)
    .join("\n");
}

function optionalPack(
  pack: Omit<ContextPack, "content"> & { content?: string }
): ContextPack[] {
  const content = pack.content?.trim();
  return content ? [{ ...pack, content }] : [];
}

function userNotesRequirementText(notes: string | undefined): string {
  const trimmed = notes?.trim();
  return trimmed
    ? `NOTES FROM THE USER (added while the team was building - treat them as requirements and address every one):\n${trimmed}`
    : "";
}

function reviewUserNotesRequirementText(notes: string | undefined): string {
  const base = userNotesRequirementText(notes);
  return base
    ? `${base}\nThe user's notes above are requirements: turn any that aren't covered yet into fix instructions or new tasks, and do NOT set "done": true while one remains unaddressed.`
    : "";
}

function reviewUserNotesDirective(notes: string | undefined): string {
  return notes?.trim()
    ? `The user's notes above are requirements: turn any that aren't covered yet into fix instructions or new tasks, and do NOT set "done": true while one remains unaddressed.`
    : "";
}

function followUpSummaryText(summary: string | undefined): string {
  const trimmed = summary?.trim();
  return trimmed
    ? `This is a FOLLOW-UP pass: a previous build already delivered the project summarized below. Everything delivered is still a requirement - preserve it. Plan ONLY the delta (changes the notes/request ask for), editing existing files where possible instead of rebuilding.\nPrevious hand-off summary:\n${trimmed}`
    : "";
}

function reviewFileContextText(fileContext: string | undefined): string {
  const trimmed = fileContext?.trim();
  return trimmed
    ? `File contents you have already read - ground every decision in these; NEVER invent replacement content for an existing file:\n${trimmed}`
    : "";
}

function taskPaths(task: BuildContextTask): string[] {
  return [
    ...(task.contextFiles ?? []),
    ...(task.outputPaths ?? []),
  ].filter(Boolean);
}

function metadataTaskIds(pack: ContextPack): string[] {
  const taskId = pack.metadata?.taskId;
  const taskIds = pack.metadata?.taskIds;
  return [
    typeof taskId === "string" ? taskId : "",
    typeof taskIds === "string" ? taskIds : "",
  ]
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
}

function workerScopedPacks(
  packs: ContextPack[],
  task: BuildContextTask
): ContextPack[] {
  const paths = taskPaths(task);
  return packs.filter((pack) => {
    if (metadataTaskIds(pack).includes(task.id)) return true;
    if (pack.sourcePath && paths.some((path) => pathsOverlap(pack.sourcePath!, path))) {
      return true;
    }
    return false;
  });
}

function memoryTokenBudget(role: BuildPromptRole, budget: BuildPromptBudget): number {
  const share = role === "worker" ? 0.35 : role === "summary" ? 0.2 : 0.18;
  const cap = role === "worker" ? 900 : role === "summary" ? 1_800 : 1_500;
  return Math.max(0, Math.min(cap, Math.floor(budget.historyTokens * share)));
}