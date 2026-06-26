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

function architectMemoryText(
  records: BuildMemoryRecord[] | undefined,
  provided: string | undefined,
  budget: BuildPromptBudget
): string {
  if (provided?.trim()) return provided.trim();
  if (!records || records.length === 0) return "";
  return buildArchitectMemoryBrief(records, {
    tokenBudget: memoryTokenBudget(budget.role, budget),
  }).text;
}

function workerMemoryText(
  records: BuildMemoryRecord[] | undefined,
  provided: string | undefined,
  task: BuildContextTask,
  budget: BuildPromptBudget
): string {
  if (provided?.trim()) return provided.trim();
  if (!records || records.length === 0) return "";
  return buildWorkerMemoryBrief(records, {
    taskId: task.id,
    paths: taskPaths(task),
    tokenBudget: memoryTokenBudget("worker", budget),
  }).text;
}

export class BuildContextManager {
  buildPlanContext(input: BuildPlanContextInput): AssembledBuildContext {
    const budget = this.budget("architect", input);
    const packs: ContextPack[] = [
      ...optionalPack({
        id: "plan-user-notes",
        title: "User notes",
        kind: "note",
        content: userNotesRequirementText(input.userNotes),
        required: true,
        exact: true,
        priority: 135,
      }),
      ...optionalPack({
        id: "plan-file-context",
        title: "Already inspected project files",
        kind: "source",
        content: input.fileContext,
        exact: false,
        required: true,
        priority: 100,
      }),
      ...optionalPack({
        id: "plan-memory",
        title: "Build memory",
        kind: "note",
        content: architectMemoryText(
          input.memoryRecords,
          input.memoryBrief,
          budget
        ),
        priority: 80,
      }),
      ...optionalPack({
        id: "plan-previous-summary",
        title: "Previous hand-off summary",
        kind: "summary",
        content: followUpSummaryText(input.previousSummary),
        required: true,
        exact: true,
        priority: 130,
      }),
      ...optionalPack({
        id: "plan-scoreboard",
        title: "Worker scoreboard",
        kind: "diagnostic",
        content: input.scoreboard,
        priority: 40,
      }),
      ...(input.contextPacks ?? []),
    ];

    return this.assemble("architect", budget, packs, "Planning context", true);
  }

  buildWorkerContext(input: BuildWorkerContextInput): AssembledBuildContext {
    const budget = this.budget("worker", input);
    const scope = compactLines([
      "Worker task scope: complete only the assigned task and avoid unrelated restructuring.",
      `Task: ${input.task.id}${input.task.title ? ` - ${input.task.title}` : ""}`,
      input.task.contextFiles?.length
        ? `Context files: ${input.task.contextFiles.join(", ")}`
        : undefined,
      input.task.outputPaths?.length
        ? `Allowed output paths: ${input.task.outputPaths.join(", ")}`
        : undefined,
      input.task.expectedOutputs
        ? `Expected outputs: ${input.task.expectedOutputs}`
        : undefined,
    ]);
    const packs: ContextPack[] = [
      ...optionalPack({
        id: `worker-${input.task.id}-scope`,
        title: "Worker task scope",
        kind: "note",
        content: scope,
        required: true,
        priority: 120,
      }),
      ...optionalPack({
        id: `worker-${input.task.id}-context-files`,
        title: "Task context files",
        kind: "source",
        content: input.contextFileText,
        exact: true,
        required: true,
        priority: 100,
        metadata: { taskId: input.task.id },
      }),
      ...optionalPack({
        id: `worker-${input.task.id}-architect-notes`,
        title: "Architect conventions for this task",
        kind: "note",
        content: input.architectNotes,
        required: true,
        priority: 90,
        metadata: { taskId: input.task.id },
      }),
      ...optionalPack({
        id: `worker-${input.task.id}-memory`,
        title: "Task-relevant build memory",
        kind: "note",
        content: workerMemoryText(
          input.memoryRecords,
          input.memoryBrief,
          input.task,
          budget
        ),
        priority: 80,
        metadata: { taskId: input.task.id },
      }),
      ...workerScopedPacks(input.contextPacks ?? [], input.task),
    ];

    return this.assemble("worker", budget, packs, "Worker task-scoped context", false);
  }

  buildReviewContext(input: BuildReviewContextInput): AssembledBuildContext {
    const budget = this.budget("reviewer", input);
    const packs: ContextPack[] = [
      ...optionalPack({
        id: "review-file-context",
        title: "Already inspected project files",
        kind: "source",
        content: reviewFileContextText(input.fileContext),
        exact: true,
        required: true,
        priority: 140,
      }),
      ...optionalPack({
        id: "review-executed-work",
        title: "Work completed since the last review",
        kind: "diagnostic",
        content: input.executedText,
        required: true,
        priority: 130,
      }),
      ...optionalPack({
        id: "review-verification",
        title: "Verification and command output",
        kind: "diagnostic",
        content: input.verificationText,
        required: true,
        priority: 125,
      }),
      ...optionalPack({
        id: "review-outstanding-tasks",
        title: "Required tasks still not done",
        kind: "note",
        content: input.outstandingTasks?.trim()
          ? `${input.outstandingTasks}\nDo NOT set "done": true while any required task is listed here. Approve completed outstanding tasks, send unfinished ones back with precise fix instructions, or create replacement tasks that explicitly cover the missing work.`
          : "",
        required: true,
        priority: 120,
      }),
      ...optionalPack({
        id: "review-user-notes-directive",
        title: "User notes requirement rule",
        kind: "note",
        content: reviewUserNotesDirective(input.userNotes),
        required: true,
        exact: true,
        priority: 160,
      }),
      ...optionalPack({
        id: "review-user-notes",
        title: "User notes",
        kind: "note",
        content: reviewUserNotesRequirementText(input.userNotes),
        required: true,
        priority: 115,
      }),
      ...optionalPack({
        id: "review-skill-evidence",
        title: "Skill evidence and gaps",
        kind: "diagnostic",
        content: input.skillEvidenceText,
        priority: 95,
      }),
      ...optionalPack({
        id: "review-memory",
        title: "Build memory",
        kind: "note",
        content: architectMemoryText(
          input.memoryRecords,
          input.memoryBrief,
          budget
        ),
        priority: 80,
      }),
      ...optionalPack({
        id: "review-scoreboard",
        title: "Worker scoreboard",
        kind: "diagnostic",
        content: input.scoreboard,
        priority: 35,
      }),
      ...(input.contextPacks ?? []),
    ];

    return this.assemble("reviewer", budget, packs, "Review context", true);
  }

  buildSummaryContext(input: BuildSummaryContextInput): AssembledBuildContext {
    const budget = this.budget("summary", input);
    const packs: ContextPack[] = [
      ...optionalPack({
        id: "summary-files-changed",
        title: "Files actually changed",
        kind: "artifact",
        content: input.filesChanged,
        required: true,
        priority: 130,
      }),
      ...optionalPack({
        id: "summary-verification",
        title: "Verification actually performed",
        kind: "diagnostic",
        content: input.verificationText,
        required: true,
        priority: 125,
      }),
      ...optionalPack({
        id: "summary-known-gaps",
        title: "Known gaps and unperformed work",
        kind: "diagnostic",
        content: input.knownGaps,
        required: true,
        priority: 120,
      }),
      ...optionalPack({
        id: "summary-user-notes",
        title: "User notes",
        kind: "note",
        content: userNotesRequirementText(input.userNotes),
        required: true,
        priority: 110,
      }),
      ...optionalPack({
        id: "summary-memory",
        title: "Build memory",
        kind: "note",
        content: architectMemoryText(
          input.memoryRecords,
          input.memoryBrief,
          budget
        ),
        priority: 95,
      }),
      ...optionalPack({
        id: "summary-skill-evidence",
        title: "Skill evidence and gaps",
        kind: "diagnostic",
        content: input.skillEvidenceText,
        priority: 90,
      }),
      ...optionalPack({
        id: "summary-history",
        title: "Build history",
        kind: "history",
        content: input.historyText,
        priority: 80,
      }),
      ...(input.contextPacks ?? []),
    ];

    return this.assemble("summary", budget, packs, "Summary context", true);
  }

  private budget(
    role: BuildPromptRole,
    input: BuildContextBaseInput
  ): BuildPromptBudget {
    return createBuildPromptBudget({
      role,
      profile: input.modelContextProfile ?? input.profile,
    });
  }

  private assemble(
    role: BuildPromptRole,
    budget: BuildPromptBudget,
    packs: ContextPack[],
    heading: string,
    includeOmissionNotes: boolean
  ): AssembledBuildContext {
    const rendered = assembleContextPackPrompt(packs, {
      tokenBudget: budget.contextPackTokens,
      heading,
      includeOmissionNotes,
    });

    return {
      role,
      budget,
      rendered,
      packs,
      notes: [...rendered.assembly.notes],
    };
  }
}
