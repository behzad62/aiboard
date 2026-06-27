import type {
  BuildCommandProblem,
  BuildProblem,
  BuildProblemCode,
  BuildProblemSeverity,
  BuildToolReviewGroup,
  BuildToolReviewReport,
} from "../db/schema";

export interface BuildToolReviewReportInput {
  discussionId: string;
  topic: string;
  status: string;
  wave: number;
  problems: BuildProblem[];
  commandProblems: BuildCommandProblem[];
  createdAt?: string;
}

const REVIEW_CODES = new Set<BuildProblemCode>([
  "malformed_tool_call",
  "tool_warning",
  "empty_tool_batch",
  "duplicate_tool_call",
  "budget_exhausted",
  "patch_failed",
  "edit_failed",
  "write_conflict",
  "suspicious_rewrite",
  "truncated_output",
  "command_failed",
  "tool_denied",
  "no_output",
  "skill_evidence_missing",
  "browser_acceptance_missing",
]);

function isReviewProblem(problem: BuildProblem): boolean {
  return REVIEW_CODES.has(problem.code) || problem.source === "mcp";
}

function sortNewestProblems(problems: BuildProblem[]): BuildProblem[] {
  return [...problems].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

function sortNewestCommands(
  commandProblems: BuildCommandProblem[]
): BuildCommandProblem[] {
  return [...commandProblems].sort((a, b) =>
    b.createdAt.localeCompare(a.createdAt)
  );
}

function isReviewCommandProblem(command: BuildCommandProblem): boolean {
  return command.command.startsWith("mcp:") || command.denied === true;
}

function actorFor(problem: BuildProblem): string {
  if (problem.modelName) {
    return problem.providerId
      ? `${problem.modelName} / ${problem.providerId}`
      : problem.modelName;
  }
  if (problem.source === "mcp" && problem.action) {
    const match = /^mcp:([^\s]+)/.exec(problem.action);
    if (match) return match[1];
  }
  return problem.source;
}

function commandProblemFromReviewProblem(
  problem: BuildProblem
): BuildCommandProblem | null {
  if (!problem.action) return null;
  if (problem.source !== "mcp" && !problem.action.startsWith("mcp:")) {
    return null;
  }
  if (problem.code !== "command_failed" && problem.code !== "tool_denied") {
    return null;
  }
  return {
    command: problem.action,
    exitCode: problem.code === "tool_denied" ? -1 : 1,
    durationMs: 0,
    outputPreview: problem.details ?? problem.message,
    denied: problem.code === "tool_denied" ? true : undefined,
    createdAt: problem.createdAt,
  };
}

function collectCommandEvidence(
  commandProblems: BuildCommandProblem[],
  problems: BuildProblem[]
): BuildCommandProblem[] {
  const commands = sortNewestCommands(
    commandProblems.filter(isReviewCommandProblem)
  );
  const seen = new Set(commands.map((command) => command.command));
  for (const problem of sortNewestProblems(problems)) {
    const command = commandProblemFromReviewProblem(problem);
    if (!command || seen.has(command.command)) continue;
    commands.push(command);
    seen.add(command.command);
  }
  return sortNewestCommands(commands);
}

function severityRank(severity: BuildProblemSeverity): number {
  return severity === "blocked"
    ? 4
    : severity === "error"
      ? 3
      : severity === "warning"
        ? 2
        : 1;
}

function highestSeverity(
  a: BuildProblemSeverity,
  b: BuildProblemSeverity
): BuildProblemSeverity {
  return severityRank(b) > severityRank(a) ? b : a;
}

function groupProblems(problems: BuildProblem[]): BuildToolReviewGroup[] {
  const groups = new Map<string, BuildToolReviewGroup>();
  for (const problem of problems) {
    const actor = actorFor(problem);
    const key = [
      problem.source,
      problem.code,
      actor,
      problem.taskId ?? "",
      problem.action ?? "",
    ].join("|");
    const existing = groups.get(key);
    if (!existing) {
      groups.set(key, {
        key,
        code: problem.code,
        source: problem.source,
        severity: problem.severity,
        actor,
        count: 1,
        latestAt: problem.createdAt,
        latestMessage: problem.message,
        taskId: problem.taskId,
        action: problem.action,
      });
      continue;
    }
    existing.count += 1;
    existing.severity = highestSeverity(existing.severity, problem.severity);
    if (problem.createdAt > existing.latestAt) {
      existing.latestAt = problem.createdAt;
      existing.latestMessage = problem.message;
    }
  }
  return [...groups.values()].sort(
    (a, b) =>
      severityRank(b.severity) - severityRank(a.severity) ||
      b.count - a.count ||
      b.latestAt.localeCompare(a.latestAt)
  );
}

function failedCommandReviewProblem(
  command: BuildCommandProblem
): BuildProblem | null {
  if (command.exitCode === 0 && !command.denied) return null;
  if (!command.denied && !command.command.startsWith("mcp:")) return null;
  return {
    id: `command:${command.createdAt}:${command.command}`,
    createdAt: command.createdAt,
    code: command.denied ? "tool_denied" : "command_failed",
    severity: command.denied ? "warning" : "error",
    source: command.command.startsWith("mcp:") ? "mcp" : "runner",
    action: command.command,
    message: command.denied
      ? `Tool call was denied: ${command.command}`
      : `Tool call failed with exit ${command.exitCode}: ${command.command}`,
    details: command.outputPreview,
  };
}

function enrichProblemsFromCommands(
  problems: BuildProblem[],
  commandProblems: BuildCommandProblem[]
): BuildProblem[] {
  const existingActions = new Set(
    problems.map((problem) => problem.action).filter(Boolean)
  );
  const enriched = [...problems];
  for (const command of commandProblems) {
    if (existingActions.has(command.command)) continue;
    const problem = failedCommandReviewProblem(command);
    if (!problem) continue;
    enriched.push(problem);
    existingActions.add(command.command);
  }
  return enriched;
}

function buildSummary(input: {
  status: string;
  wave: number;
  totalProblems: number;
  groups: BuildToolReviewGroup[];
}): string {
  const actorCount = new Set(input.groups.map((group) => group.actor)).size;
  const top = input.groups[0];
  const base = `${input.totalProblems} tool-call problem${
    input.totalProblems === 1 ? "" : "s"
  } recorded across ${actorCount} actor${actorCount === 1 ? "" : "s"} by wave ${
    input.wave
  } (${input.status}).`;
  return top
    ? `${base} Most frequent/latest group: ${top.code} from ${top.actor} (${top.count}).`
    : base;
}

export function createBuildToolReviewReport(
  input: BuildToolReviewReportInput
): BuildToolReviewReport | null {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const directCommandProblems = sortNewestCommands(input.commandProblems).filter(
    (command) =>
      (command.exitCode !== 0 || command.denied) &&
      isReviewCommandProblem(command)
  );
  const reviewProblems = sortNewestProblems(
    enrichProblemsFromCommands(
      input.problems.filter(isReviewProblem),
      directCommandProblems
    )
  ).slice(0, 20);

  if (reviewProblems.length === 0) return null;

  const commandProblems = collectCommandEvidence(
    directCommandProblems,
    reviewProblems
  ).slice(0, 8);
  const groups = groupProblems(reviewProblems).slice(0, 12);
  const warningCount = reviewProblems.filter(
    (problem) => problem.severity === "warning"
  ).length;
  const errorCount = reviewProblems.filter(
    (problem) => problem.severity === "error"
  ).length;
  const blockedCount = reviewProblems.filter(
    (problem) => problem.severity === "blocked"
  ).length;

  return {
    id: `tool-review:${input.discussionId}:${createdAt}`,
    discussionId: input.discussionId,
    createdAt,
    topic: input.topic,
    status: input.status,
    wave: input.wave,
    summary: buildSummary({
      status: input.status,
      wave: input.wave,
      totalProblems: reviewProblems.length,
      groups,
    }),
    totalProblems: reviewProblems.length,
    warningCount,
    errorCount,
    blockedCount,
    groups,
    problems: reviewProblems,
    commandProblems: commandProblems.slice(0, 8),
  };
}

function section(title: string, body: string): string {
  return body.trim() ? `## ${title}\n${body.trim()}` : "";
}

function bullet(lines: string[]): string {
  return lines.filter(Boolean).map((line) => `- ${line}`).join("\n");
}

function fence(text: string): string {
  return `\`\`\`\n${text.trim() || "(no output preview)"}\n\`\`\``;
}

export function formatBuildToolReviewMarkdown(
  report: BuildToolReviewReport
): string {
  const groups = bullet(
    report.groups.map(
      (group) =>
        `\`${group.code}\` x${group.count} from ${group.source} (${group.actor})${
          group.taskId ? ` task ${group.taskId}` : ""
        }${group.action ? ` action \`${group.action}\`` : ""}: ${
          group.latestMessage
        }`
    )
  );
  const commands = report.commandProblems
    .map(
      (command) =>
        `- \`${command.command}\` -> exit ${command.exitCode} (${(
          command.durationMs / 1000
        ).toFixed(1)}s)\n${fence(command.outputPreview)}`
    )
    .join("\n");
  const examples = report.problems
    .slice(0, 12)
    .map((problem) => {
      const actor = [problem.modelName, problem.providerId]
        .filter(Boolean)
        .join(" / ");
      return [
        `- ${problem.createdAt} \`${problem.code}\` ${problem.severity} from ${
          problem.source
        }${actor ? ` (${actor})` : ""}${problem.taskId ? ` task ${problem.taskId}` : ""}${
          problem.action ? ` action \`${problem.action}\`` : ""
        }: ${problem.message}`,
        problem.details ? fence(problem.details) : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");

  return [
    "# Build Tool Call Review",
    `Generated: ${report.createdAt}`,
    "",
    section(
      "What I need help with",
      "This Build run recorded tool-call problems. Use the report below to identify model/tool-calling issues even when the build eventually completed."
    ),
    section(
      "Run",
      bullet([
        `Topic: ${report.topic}`,
        `Status: ${report.status}`,
        `Wave: ${report.wave}`,
        `Problems: ${report.totalProblems}`,
        `Warnings: ${report.warningCount}`,
        `Errors: ${report.errorCount}`,
        report.blockedCount ? `Blocked: ${report.blockedCount}` : "",
      ])
    ),
    section("Summary", report.summary),
    section("Problem Groups", groups),
    section("Failed Commands And MCP Calls", commands || "No failed commands recorded."),
    section("Recent Examples", examples),
  ]
    .filter(Boolean)
    .join("\n\n");
}
