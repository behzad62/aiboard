import type {
  BuildCommandProblem,
  BuildProblem,
} from "@/lib/db/schema";
import {
  buildMemoryRecord,
  compactOneLine,
  stableHash,
  type BuildMemoryRecord,
} from "./memory-store";

interface ExtractorBaseInput {
  projectKey: string;
  discussionId?: string;
  createdAt?: string;
}

function evidenceExcerpt(text: string | undefined): string | undefined {
  return text ? compactOneLine(text, 220) : undefined;
}

export function extractUserNoteMemories(
  input: ExtractorBaseInput & { notes: string[] }
): BuildMemoryRecord[] {
  return input.notes
    .map((note, index) => ({ note: note.trim(), index }))
    .filter(({ note }) => note.length > 0)
    .map(({ note, index }) =>
      buildMemoryRecord({
        projectKey: input.projectKey,
        discussionId: input.discussionId,
        kind: "user_correction",
        summary: note,
        evidence: [
          {
            kind: "user_note",
            ref: `${input.discussionId ?? "discussion"}#note-${index + 1}`,
            excerpt: evidenceExcerpt(note),
          },
        ],
        createdAt: input.createdAt,
      })
    );
}

export function extractProblemMemories(
  input: ExtractorBaseInput & { problems: BuildProblem[] }
): BuildMemoryRecord[] {
  const memories: BuildMemoryRecord[] = [];
  for (const problem of input.problems) {
    const base = {
      projectKey: input.projectKey,
      discussionId: input.discussionId,
      paths: problem.path ? [problem.path] : undefined,
      taskIds: problem.taskId ? [problem.taskId] : undefined,
      evidence: [
        {
          kind: "problem" as const,
          ref: problem.id,
          excerpt: evidenceExcerpt(problem.details ?? problem.message),
        },
      ],
      createdAt: problem.createdAt ?? input.createdAt,
    };
    if (
      problem.code === "patch_failed" ||
      problem.code === "edit_failed" ||
      problem.code === "suspicious_rewrite" ||
      problem.code === "truncated_output"
    ) {
      memories.push(
        buildMemoryRecord({
          ...base,
          kind: "failed_approach",
          summary: problem.path
            ? `Avoid repeating failed write approach for ${problem.path}: ${problem.message}`
            : `Avoid repeating failed write approach: ${problem.message}`,
        })
      );
    }
    if (problem.code === "write_conflict") {
      memories.push(
        buildMemoryRecord({
          ...base,
          kind: "fragile_file",
          summary: problem.path
            ? `${problem.path} had a same-wave write conflict; coordinate ownership before editing.`
            : `A same-wave write conflict occurred; coordinate file ownership before editing.`,
        })
      );
    }
    if (
      problem.code === "command_failed" ||
      problem.code === "verification_failed" ||
      problem.code === "verification_repeated"
    ) {
      const command = problem.action?.trim();
      memories.push(
        buildMemoryRecord({
          ...base,
          kind: "failed_approach",
          command,
          summary: command ? `Command failed: ${command}` : problem.message,
          detail: problem.details ?? problem.message,
        })
      );
    }
  }
  return memories;
}

export function extractReviewMemories(
  input: ExtractorBaseInput & {
    results: Array<{
      taskId: string;
      verdict: "approve" | "fix";
      fixInstructions?: string;
      paths?: string[];
    }>;
    notes?: string;
  }
): BuildMemoryRecord[] {
  const memories: BuildMemoryRecord[] = [];
  for (const result of input.results) {
    const fix = result.fixInstructions?.trim();
    if (result.verdict !== "fix" || !fix) continue;
    memories.push(
      buildMemoryRecord({
        projectKey: input.projectKey,
        discussionId: input.discussionId,
        kind: "failed_approach",
        summary: `Review sent ${result.taskId} back for fix: ${fix}`,
        paths: result.paths,
        taskIds: [result.taskId],
        evidence: [
          {
            kind: "review",
            ref: `${input.discussionId ?? "discussion"}#${result.taskId}`,
            excerpt: evidenceExcerpt(fix),
          },
        ],
        createdAt: input.createdAt,
      })
    );
  }
  return memories;
}

export interface CommandMemoryResult {
  command: string;
  exitCode: number;
  outputPreview: string;
  createdAt?: string;
  executionId?: string;
}

function commandKey(command: string): string {
  return command.trim().toLowerCase();
}

function commandExecutionRef(result: CommandMemoryResult): string {
  if (result.executionId?.trim()) return result.executionId.trim();
  return `cmd_${stableHash(
    [
      commandKey(result.command),
      result.createdAt ?? "",
      result.exitCode,
      result.outputPreview,
    ].join("|")
  ).slice(0, 12)}`;
}

function distinctCommandResults(results: CommandMemoryResult[]): CommandMemoryResult[] {
  const seen = new Set<string>();
  const out: CommandMemoryResult[] = [];
  for (const result of results) {
    const ref = commandExecutionRef(result);
    if (seen.has(ref)) continue;
    seen.add(ref);
    out.push(result);
  }
  return out;
}

export function extractCommandMemories(
  input: ExtractorBaseInput & { commandResults: CommandMemoryResult[] }
): BuildMemoryRecord[] {
  const memories: BuildMemoryRecord[] = [];
  const successful = new Map<string, CommandMemoryResult[]>();
  for (const result of input.commandResults) {
    const command = result.command.trim();
    if (!command) continue;
    const key = commandKey(command);
    if (result.exitCode === 0) {
      successful.set(key, [...(successful.get(key) ?? []), result]);
    } else {
      memories.push(
        buildMemoryRecord({
          projectKey: input.projectKey,
          discussionId: input.discussionId,
          kind: "failed_approach",
          command,
          summary: `Command failed: ${command}`,
          detail: result.outputPreview,
          evidence: [
            {
              kind: "command",
              ref: commandExecutionRef(result),
              excerpt: evidenceExcerpt(result.outputPreview),
            },
          ],
          createdAt: result.createdAt ?? input.createdAt,
        })
      );
    }
  }
  for (const rawResults of successful.values()) {
    const results = distinctCommandResults(rawResults);
    if (results.length < 2) continue;
    const latest = results.reduce((best, result) =>
      (result.createdAt ?? "") > (best.createdAt ?? "") ? result : best
    );
    memories.push(
      buildMemoryRecord({
        projectKey: input.projectKey,
        discussionId: input.discussionId,
        kind: "reliable_command",
        command: latest.command,
        summary: `${latest.command} passed repeatedly for this project.`,
        evidence: results.slice(-3).map((result) => ({
          kind: "command",
          ref: commandExecutionRef(result),
          excerpt: evidenceExcerpt(result.outputPreview || "exit 0"),
        })),
        createdAt: latest.createdAt ?? input.createdAt,
      })
    );
  }
  return memories;
}

export function extractCommandMemoriesForExecution(
  input: ExtractorBaseInput & {
    current: CommandMemoryResult;
    history: CommandMemoryResult[];
  }
): BuildMemoryRecord[] {
  const command = input.current.command.trim();
  if (!command) return [];
  if (input.current.exitCode !== 0) {
    return extractCommandMemories({
      projectKey: input.projectKey,
      discussionId: input.discussionId,
      createdAt: input.createdAt,
      commandResults: [input.current],
    });
  }

  const key = commandKey(command);
  const sameCommandSuccesses = distinctCommandResults(
    input.history.filter(
      (result) => result.exitCode === 0 && commandKey(result.command) === key
    )
  );
  if (!sameCommandSuccesses.some((result) => commandExecutionRef(result) === commandExecutionRef(input.current))) {
    sameCommandSuccesses.push(input.current);
  }
  if (sameCommandSuccesses.length < 2) return [];
  return extractCommandMemories({
    projectKey: input.projectKey,
    discussionId: input.discussionId,
    createdAt: input.createdAt,
    commandResults: sameCommandSuccesses,
  });
}

export function extractSkillViolationMemories(
  input: ExtractorBaseInput & {
    violations: Array<{ taskId?: string; skillId: string; violation: string; paths?: string[] }>;
  }
): BuildMemoryRecord[] {
  return input.violations
    .filter((item) => item.violation.trim())
    .map((item) =>
      buildMemoryRecord({
        projectKey: input.projectKey,
        discussionId: input.discussionId,
        kind: "skill_violation",
        summary: item.violation,
        paths: item.paths,
        taskIds: item.taskId ? [item.taskId] : undefined,
        evidence: [
          {
            kind: "skill",
            ref: `${item.skillId}${item.taskId ? `#${item.taskId}` : ""}`,
            excerpt: evidenceExcerpt(item.violation),
          },
        ],
        createdAt: input.createdAt,
      })
    );
}

export function commandProblemsToMemoryResults(
  problems: BuildCommandProblem[]
): CommandMemoryResult[] {
  return problems.map((problem) => ({
    command: problem.command,
    exitCode: problem.exitCode,
    outputPreview: problem.outputPreview,
    createdAt: problem.createdAt,
  }));
}
