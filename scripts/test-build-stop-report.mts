/** Build stop report checks (run: npx tsx scripts/test-build-stop-report.mts) */
import {
  createBuildStopReport,
  formatBuildStopReportMarkdown,
} from "../lib/orchestrator/build-stop-report";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const report = createBuildStopReport({
  discussionId: "d1",
  topic: "Add a Games tab with chess.",
  status: "blocked",
  stopReason: "blocked",
  stopMessage:
    "Build stopped after repeated no-progress recovery attempts. Resume keeps the checkpoint.",
  wave: 4,
  branch: "codex/games-chess-wip",
  prUrl: "https://github.com/behzad62/aiboard/pull/23",
  verifyCommand: "npx --yes tsc --noEmit",
  tasks: [
    { id: "T1", title: "Chess engine", status: "done" },
    { id: "T2", title: "Games page", status: "done" },
    { id: "T3", title: "AI bridge", status: "done" },
    { id: "T4", title: "Benchmark wiring", status: "done" },
    { id: "T5", title: "Fix Games client types", status: "fixing", failCount: 2 },
  ],
  problems: [
    {
      id: "p1",
      createdAt: "2026-06-22T07:08:07.000Z",
      code: "malformed_tool_call",
      severity: "error",
      source: "architect",
      message:
        "Architect review tool-call rejected: TOOL CALL REJECTED: your JSON tool action looks incomplete.",
      modelName: "GLM 5.2",
      providerId: "openrouter",
      wave: 4,
    },
    {
      id: "p2",
      createdAt: "2026-06-22T07:11:39.000Z",
      code: "repeated_no_progress",
      severity: "blocked",
      source: "engine",
      message: "Stopped after 4 no-progress waves.",
      wave: 4,
    },
  ],
  commandProblems: [
    {
      command: "npx --yes tsc --noEmit",
      exitCode: 2,
      durationMs: 4000,
      outputPreview:
        "app/games/games-client.tsx(90,24): error TS2345: Argument of type 'AvailableModel[]' is not assignable to parameter of type 'SetStateAction<{ id: string; name: string; }[]>'.",
      createdAt: "2026-06-22T07:08:50.000Z",
    },
  ],
  failureFingerprints: {
    "npx --yes tsc --noEmit|TS2345": 3,
  },
  recoveryLog: [
    "Verification failure changed after wave 3.",
    "Stopped as blocked after wave 4: 3 repeated failure(s), 4 no-progress wave(s).",
  ],
  createdAt: "2026-06-22T07:11:39.000Z",
});

check("report keeps stop reason", report.stopReason === "blocked", report);
check("report keeps wave", report.wave === 4, report);
check("report counts completed tasks", report.tasksDone === 4 && report.tasksTotal === 5, report);
check("report promotes failed command", report.primaryCause?.code === "verification_failed", report);
check("report includes repeated failure count", report.repeatedFailureCount === 3, report);
check("report creates next action from failed command", /Fix the failing command/i.test(report.nextAction), report);
check("report preserves local branch", report.branch === "codex/games-chess-wip", report);

const markdown = formatBuildStopReportMarkdown(report);
check("markdown includes topic", markdown.includes("Add a Games tab with chess."), markdown);
check("markdown includes TypeScript error", markdown.includes("TS2345"), markdown);
check("markdown includes malformed tool call", markdown.includes("malformed_tool_call"), markdown);
check("markdown includes unfinished task", markdown.includes("T5"), markdown);
check("markdown is paste-oriented", markdown.includes("## What I need help with"), markdown);

const missingCommandReport = createBuildStopReport({
  discussionId: "d2",
  topic: "Add a Games tab with chess.",
  status: "blocked",
  stopReason: "blocked",
  stopMessage:
    "Build stopped after repeated no-progress recovery attempts. Resume keeps the checkpoint.",
  wave: 1,
  verifyCommand: "npx --yes tsc --noEmit",
  tasks: [
    { id: "T1", title: "Chess board", status: "done" },
    { id: "T9", title: "Build the app and fix runtime errors", status: "planned" },
  ],
  problems: [
    {
      id: "p3",
      createdAt: "2026-06-22T19:00:00.000Z",
      code: "verification_repeated",
      severity: "error",
      source: "runner",
      action: "npm run build",
      message: "Automated build check failed in wave 1: npm run build",
      details: "Failed to compile.\n./components/games/ChessBoard.tsx\n42:7  Error: 'bgColor' is never reassigned. Use 'const' instead.  prefer-const",
      wave: 1,
    },
    {
      id: "p4",
      createdAt: "2026-06-22T19:02:00.000Z",
      code: "repeated_no_progress",
      severity: "blocked",
      source: "engine",
      message:
        "Build stopped after repeated no-progress recovery attempts: 5 repeated failure(s), 0 no-progress wave(s).",
      wave: 1,
    },
  ],
  commandProblems: [],
  failureFingerprints: {
    "npm run build|prefer-const": 5,
  },
  recoveryLog: [
    "Verification failure changed after wave 1.",
    "Stopped as blocked after wave 1: 5 repeated failure(s), 0 no-progress wave(s).",
  ],
  createdAt: "2026-06-22T19:02:33.605Z",
});

check(
  "report promotes verification problem when command log is missing",
  missingCommandReport.primaryCause?.code === "verification_repeated" &&
    missingCommandReport.primaryCause.action === "npm run build",
  missingCommandReport
);
check(
  "report reconstructs failed command from verification problem",
  missingCommandReport.commandProblems.some(
    (command) =>
      command.command === "npm run build" &&
      command.exitCode === 1 &&
      command.outputPreview.includes("prefer-const")
  ),
  missingCommandReport
);
check(
  "markdown does not say failed commands are missing when verification details exist",
  !formatBuildStopReportMarkdown(missingCommandReport).includes("No failed commands recorded.") &&
    formatBuildStopReportMarkdown(missingCommandReport).includes("npm run build"),
  formatBuildStopReportMarkdown(missingCommandReport)
);

const truncatedCommandReport = createBuildStopReport({
  discussionId: "d3",
  topic: "Fix tests.",
  status: "blocked",
  stopReason: "blocked",
  stopMessage: "Blocked after repeated verification failures.",
  wave: 2,
  verifyCommand: "npm test",
  tasks: [{ id: "T1", title: "Fix test", status: "fixing", failCount: 1 }],
  problems: [],
  commandProblems: [
    {
      command: "npm test",
      exitCode: 1,
      durationMs: 800,
      outputPreview:
        "[runner output truncated to its size cap; preview keeps the received tail]\nstdout:\n...\nstderr:\nSyntaxError: Unexpected token",
      createdAt: "2026-06-22T20:00:00.000Z",
    },
  ],
  failureFingerprints: {
    "npm test|SyntaxError": 3,
  },
  recoveryLog: [],
  createdAt: "2026-06-22T20:01:00.000Z",
});

check(
  "truncated failed command report asks for narrower reproduction",
  /output was capped/i.test(truncatedCommandReport.nextAction) &&
    /rerun a narrower command/i.test(truncatedCommandReport.nextAction),
  truncatedCommandReport.nextAction
);

process.exit(failed === 0 ? 0 : 1);
