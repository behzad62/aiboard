import type {
  BuildCommandProblem,
  BuildProblem,
  BuildStopReason,
  BuildStopReport,
  BuildCheckpointTask,
} from "../db/schema";

export interface BuildStopReportInput {
  discussionId: string;
  topic: string;
  status: string;
  stopReason: BuildStopReason | "failed" | "incomplete";
  stopMessage: string;
  wave: number;
  branch?: string | null;
  prUrl?: string | null;
  verifyCommand?: string;
  currentRunStartedAt?: string;
  tasks: Array<
    Pick<BuildCheckpointTask, "id" | "title" | "status" | "failCount">
  >;
  problems: BuildProblem[];
  commandProblems: BuildCommandProblem[];
  failureFingerprints: Record<string, number>;
  recoveryLog: string[];
  createdAt?: string;
}

function maxRepeatedFailureCount(fingerprints: Record<string, number>): number {
  return Object.values(fingerprints).reduce(
    (max, count) => Math.max(max, count),
    0
  );
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

function filterCurrentRunItems<T extends { createdAt: string }>(
  items: T[],
  currentRunStartedAt: string | undefined
): T[] {
  if (!currentRunStartedAt) return items;
  const started = Date.parse(currentRunStartedAt);
  if (!Number.isFinite(started)) return items;
  return items.filter((item) => {
    const created = Date.parse(item.createdAt);
    return Number.isFinite(created) && created >= started;
  });
}

function commandProblemToBuildProblem(
  command: BuildCommandProblem
): BuildProblem {
  const denied = command.denied || command.exitCode === -1;
  const details = [command.cwd ? `cwd: ${command.cwd}` : "", command.outputPreview]
    .filter(Boolean)
    .join("\n");
  return {
    id: `command:${command.createdAt}:${command.command}`,
    createdAt: command.createdAt,
    code: denied ? "tool_denied" : "verification_failed",
    severity: denied ? "warning" : "error",
    source: "runner",
    action: command.command,
    message: denied
      ? `Command was denied: ${command.command}`
      : `Command failed with exit ${command.exitCode}: ${command.command}`,
    details,
  };
}

function verificationProblemToCommandProblem(
  problem: BuildProblem
): BuildCommandProblem | null {
  if (
    problem.source !== "runner" ||
    (problem.code !== "verification_failed" &&
      problem.code !== "verification_repeated") ||
    !problem.action
  ) {
    return null;
  }
  return {
    command: problem.action,
    exitCode: 1,
    durationMs: 0,
    outputPreview: problem.details ?? problem.message,
    createdAt: problem.createdAt,
  };
}

function enrichCommandProblems(
  commandProblems: BuildCommandProblem[],
  problems: BuildProblem[]
): BuildCommandProblem[] {
  const commands = sortNewestCommands(commandProblems);
  const seen = new Set(commands.map((command) => command.command));
  for (const problem of sortNewestProblems(problems)) {
    const command = verificationProblemToCommandProblem(problem);
    if (!command || seen.has(command.command)) continue;
    commands.push(command);
    seen.add(command.command);
  }
  return commands;
}

function normalizeCommand(command: string | undefined): string {
  return (command ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isStaleProjectVerifierProblem(
  problem: BuildProblem,
  verifyCommand: string | undefined
): boolean {
  const activeCommand = normalizeCommand(verifyCommand);
  const action = normalizeCommand(problem.action);
  if (!activeCommand || !action || action === activeCommand) return false;
  if (
    problem.code !== "verification_failed" &&
    problem.code !== "verification_repeated" &&
    problem.code !== "tool_denied"
  ) {
    return false;
  }
  const details = `${problem.message}\n${problem.details ?? ""}`;
  if (/^dotnet build\b/.test(action)) {
    return /MSB1003|does not contain a project or solution|does not match this project tree|verifyCommand ignored/i.test(
      details
    );
  }
  return false;
}

function pickPrimaryCause(
  commandProblems: BuildCommandProblem[],
  problems: BuildProblem[],
  verifyCommand?: string
): BuildProblem | null {
  const failedCommandProblems = sortNewestCommands(commandProblems)
    .filter((command) => command.exitCode !== 0 || command.denied)
    .map(commandProblemToBuildProblem);
  const candidates = [...sortNewestProblems(problems), ...failedCommandProblems];
  const nonStaleCandidates = candidates.filter(
    (problem) => !isStaleProjectVerifierProblem(problem, verifyCommand)
  );
  const rankedCandidates =
    nonStaleCandidates.length > 0 ? nonStaleCandidates : candidates;
  const ranked = rankedCandidates.sort((a, b) => {
    const causeRank = (problem: BuildProblem) => {
      if (
        problem.code === "verification_repeated" ||
        problem.code === "verification_failed" ||
        problem.code === "quality_gate_failed" ||
        problem.code === "skill_evidence_missing" ||
        problem.code === "browser_acceptance_missing"
      ) {
        return 5;
      }
      if (problem.code === "command_failed") return 4;
      if (problem.code === "repeated_no_progress") return 1;
      return 2;
    };
    const activeVerifyRank = (problem: BuildProblem) =>
      normalizeCommand(problem.action) === normalizeCommand(verifyCommand) ? 2 : 0;
    const severityRank = (severity: BuildProblem["severity"]) =>
      severity === "blocked"
        ? 4
        : severity === "error"
          ? 3
          : severity === "warning"
            ? 2
            : 1;
    return (
      causeRank(b) - causeRank(a) ||
      activeVerifyRank(b) - activeVerifyRank(a) ||
      severityRank(b.severity) - severityRank(a.severity) ||
      b.createdAt.localeCompare(a.createdAt)
    );
  });
  return ranked[0] ?? null;
}

function buildSummary(input: BuildStopReportInput, primary: BuildProblem | null): string {
  const done = input.tasks.filter((task) => task.status === "done").length;
  const total = input.tasks.length;
  const base = `Build ${input.status} at wave ${input.wave}: ${done}/${total} tasks done.`;
  if (!primary) return `${base} ${input.stopMessage}`;
  return `${base} Primary issue: ${primary.message}`;
}

function buildNextAction(primary: BuildProblem | null, fallback: string): string {
  if (!primary) return fallback;
  const details = primary.details ?? "";
  const outputWasCapped =
    /\boutput truncated\b|\brunner output truncated\b|TRUNCATED to the runner size cap|…\[truncated\]|\[truncated\]/i.test(
      details
    );
  if (primary.code === "verification_failed" && primary.action) {
    if (outputWasCapped) {
      return `Fix the failing command \`${primary.action}\` first. The output was capped, so rerun a narrower command or the specific failing test/file to get the complete reproduction before editing.`;
    }
    return `Fix the failing command \`${primary.action}\` first; use the latest output in this report as the reproduction.`;
  }
  if (primary.code === "verification_repeated" && primary.action) {
    if (outputWasCapped) {
      return `Fix the repeatedly failing command \`${primary.action}\` first. The output was capped, so rerun a narrower command or the specific failing test/file to get the complete reproduction before editing.`;
    }
    return `Fix the repeatedly failing command \`${primary.action}\` first; use the latest output in this report as the reproduction.`;
  }
  if (primary.code === "malformed_tool_call") {
    return "Resume with guidance telling the Architect to stop using tools and return the required review JSON, or switch Architect models if it repeats.";
  }
  if (primary.code === "repeated_no_progress") {
    return "Resume with a specific instruction that names the stuck task and failing command, or restart with a different Architect if it repeats.";
  }
  if (
    primary.code === "skill_evidence_missing" ||
    (primary.code === "quality_gate_failed" &&
      /skill evidence/i.test(`${primary.message}\n${primary.details ?? ""}`))
  ) {
    return "Resume with a specific instruction to satisfy the missing skill evidence, or disable the relevant skill gate only if the requirement is no longer intended.";
  }
  if (primary.code === "quality_gate_failed") {
    return "Resume with a specific instruction to satisfy the final Build quality gate, using the gate details in this report as the acceptance checklist.";
  }
  if (primary.code === "incomplete_tasks") {
    return "Resume so the unfinished tasks are dispatched again, or add a note naming the incomplete task that should be fixed next.";
  }
  return fallback;
}

export function createBuildStopReport(input: BuildStopReportInput): BuildStopReport {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const currentRunProblems = filterCurrentRunItems(
    input.problems,
    input.currentRunStartedAt
  );
  const currentRunCommandProblems = filterCurrentRunItems(
    input.commandProblems,
    input.currentRunStartedAt
  );
  const problems = sortNewestProblems(currentRunProblems).slice(0, 12);
  const commandProblems = enrichCommandProblems(
    currentRunCommandProblems,
    problems
  ).slice(0, 8);
  const primary = pickPrimaryCause(
    currentRunCommandProblems,
    problems,
    input.verifyCommand
  );
  const incompleteTasks = input.tasks
    .filter((task) => task.status !== "done")
    .map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      failCount: task.failCount,
    }));
  const tasksDone = input.tasks.filter((task) => task.status === "done").length;
  const repeatedFailureCount = maxRepeatedFailureCount(input.failureFingerprints);
  const fallbackNextAction =
    input.stopReason === "budget" || input.stopReason === "time"
      ? "Resume starts a fresh budget window and keeps the checkpoint."
      : "Resume keeps the checkpoint. Add a note with the failing command or unfinished task if you want to steer the next pass.";

  return {
    id: `report:${input.discussionId}:${createdAt}`,
    discussionId: input.discussionId,
    createdAt,
    topic: input.topic,
    status: input.status,
    stopReason: input.stopReason,
    stopMessage: input.stopMessage,
    wave: input.wave,
    branch: input.branch ?? null,
    prUrl: input.prUrl ?? null,
    verifyCommand: input.verifyCommand ?? "",
    summary: buildSummary(input, primary),
    nextAction: buildNextAction(primary, fallbackNextAction),
    tasksDone,
    tasksTotal: input.tasks.length,
    incompleteTasks,
    primaryCause: primary,
    problems,
    commandProblems,
    repeatedFailureCount,
    recoveryLog: input.recoveryLog.slice(-8),
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

export function formatBuildStopReportMarkdown(report: BuildStopReport): string {
  const primary = report.primaryCause
    ? [
        `Code: \`${report.primaryCause.code}\``,
        `Source: \`${report.primaryCause.source}\``,
        report.primaryCause.modelName
          ? `Model: ${report.primaryCause.modelName}${
              report.primaryCause.providerId ? ` (${report.primaryCause.providerId})` : ""
            }`
          : "",
        `Message: ${report.primaryCause.message}`,
        report.primaryCause.details ? fence(report.primaryCause.details) : "",
      ]
        .filter(Boolean)
        .join("\n\n")
    : "No primary cause was recorded.";

  const commands = report.commandProblems
    .map(
      (command) =>
        `- \`${command.command}\` -> exit ${command.exitCode} (${(
          command.durationMs / 1000
        ).toFixed(1)}s)${
          command.cwd ? `\ncwd: \`${command.cwd}\`` : ""
        }\n${fence(command.outputPreview)}`
    )
    .join("\n");

  const problems = bullet(
    report.problems.map((problem) => {
      const actor = [problem.modelName, problem.providerId].filter(Boolean).join(" / ");
      return `\`${problem.code}\` ${problem.severity} from ${problem.source}${
        actor ? ` (${actor})` : ""
      }: ${problem.message}`;
    })
  );

  const incompleteTasks = bullet(
    report.incompleteTasks.map(
      (task) =>
        `${task.id} (${task.status}${task.failCount ? `, ${task.failCount} failed attempts` : ""}): ${task.title}`
    )
  );

  return [
    `# Build Stop Report`,
    `Generated: ${report.createdAt}`,
    "",
    section(
      "What I need help with",
      "This Build run stopped before it finished. Use the report below to identify the root cause and propose a fix."
    ),
    section(
      "Run",
      bullet([
        `Topic: ${report.topic}`,
        `Status: ${report.status}`,
        `Stop reason: ${report.stopReason}`,
        `Wave: ${report.wave}`,
        `Tasks: ${report.tasksDone}/${report.tasksTotal} done`,
        report.branch ? `Branch: ${report.branch}` : "",
        report.prUrl ? `PR: ${report.prUrl}` : "",
        report.verifyCommand ? `Verify command: \`${report.verifyCommand}\`` : "",
      ])
    ),
    section("Summary", report.summary),
    section("Primary Cause", primary),
    section("Next Action", report.nextAction),
    section(
      "Repeated Failure State",
      bullet([
        `Highest repeated failure count: ${report.repeatedFailureCount}`,
        ...report.recoveryLog,
      ])
    ),
    section("Incomplete Tasks", incompleteTasks || "No incomplete tasks recorded."),
    section("Failed Commands", commands || "No failed commands recorded."),
    section("Recent Tool And Build Problems", problems || "No recent problems recorded."),
  ]
    .filter(Boolean)
    .join("\n\n");
}
