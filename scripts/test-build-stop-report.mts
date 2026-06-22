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

process.exit(failed === 0 ? 0 : 1);
