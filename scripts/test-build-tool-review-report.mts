/** Build tool-call review checks (run: npx tsx scripts/test-build-tool-review-report.mts) */
import {
  createBuildToolReviewReport,
  formatBuildToolReviewMarkdown,
} from "../lib/orchestrator/build-tool-review-report";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const report = createBuildToolReviewReport({
  discussionId: "d1",
  topic: "Add a Games tab with chess.",
  status: "completed",
  wave: 2,
  problems: [
    {
      id: "p1",
      createdAt: "2026-06-22T19:51:57.000Z",
      code: "command_failed",
      severity: "error",
      source: "mcp",
      action:
        'mcp:playwright.browser_navigate {"url":"http://localhost:3001/games"}',
      message: "MCP playwright.browser_navigate returned ERROR.",
      details: "browser_navigate failed before page navigation completed",
      modelName: "GLM 5.2",
      providerId: "openrouter",
      wave: 2,
    },
    {
      id: "p2",
      createdAt: "2026-06-22T19:52:01.000Z",
      code: "empty_tool_batch",
      severity: "error",
      source: "architect",
      message: "Architect review batch served nothing (all duplicate or skipped)",
      details:
        "TOOL BATCH RESULT\n\nServed:\n- none\n\nSkipped:\n- read app/games/games-client.tsx: duplicate tool request (already delivered)",
      modelName: "GLM 5.2",
      providerId: "openrouter",
      wave: 2,
    },
    {
      id: "p3",
      createdAt: "2026-06-22T19:52:04.000Z",
      code: "tool_warning",
      severity: "warning",
      source: "worker",
      taskId: "T10",
      message:
        "claude-opus-4-5 tool-call warning for T10: TOOL CALL WARNING: tool calls should be JSON actions with no prose.",
      modelName: "claude-opus-4-5",
      providerId: "foundry",
      wave: 2,
    },
    {
      id: "p4",
      createdAt: "2026-06-22T19:52:10.000Z",
      code: "verification_repeated",
      severity: "error",
      source: "runner",
      action: "npx --yes tsc --noEmit",
      message: "Automated build check failed in wave 2: npx --yes tsc --noEmit",
      wave: 2,
    },
  ],
  commandProblems: [
    {
      command:
        "npx --yes tsc --noEmit",
      exitCode: 2,
      durationMs: 2600,
      outputPreview:
        "lib/games/chess/ai.ts(242,23): error TS2304: Cannot find name 'getCustomModelByFullId'.",
      createdAt: "2026-06-22T19:52:10.000Z",
    },
  ],
  createdAt: "2026-06-22T19:53:00.000Z",
});

check("tool review is created when tool problems exist", report !== null, report);
if (report) {
  check("tool review keeps completed status", report.status === "completed", report);
  check("tool review excludes verification-only problems", report.totalProblems === 3, report);
  check(
    "tool review synthesizes MCP command evidence",
    report.commandProblems.length === 1 &&
      report.commandProblems[0]?.command.includes("browser_navigate"),
    report
  );
  check(
    "tool review excludes non-tool verification command evidence",
    !report.commandProblems.some((command) => command.command.includes("tsc")),
    report
  );
  check(
    "tool review groups Playwright MCP failure",
    report.groups.some(
      (group) =>
        group.source === "mcp" &&
        group.code === "command_failed" &&
        group.count === 1
    ),
    report
  );
  check(
    "tool review groups architect empty batches",
    report.groups.some(
      (group) =>
        group.source === "architect" &&
        group.code === "empty_tool_batch" &&
        group.actor.includes("GLM 5.2")
    ),
    report
  );
  check(
    "tool review summary names problem count",
    /3 tool-call problem/.test(report.summary),
    report.summary
  );

  const markdown = formatBuildToolReviewMarkdown(report);
  check("markdown includes copy prompt", markdown.includes("What I need help with"), markdown);
  check("markdown includes Playwright navigate", markdown.includes("browser_navigate"), markdown);
  check("markdown includes skipped tool label", markdown.includes("read app/games/games-client.tsx"), markdown);
  check("markdown includes skipped tool reason", markdown.includes("duplicate tool request"), markdown);
  check("markdown includes grouped counts", markdown.includes("Problem Groups"), markdown);
  check("markdown includes worker warning", markdown.includes("tool_warning"), markdown);
  check("markdown excludes verification problem", !markdown.includes("verification_repeated"), markdown);
}

const clean = createBuildToolReviewReport({
  discussionId: "d2",
  topic: "No tool issues.",
  status: "completed",
  wave: 1,
  problems: [],
  commandProblems: [],
});
check("tool review is null when no problems exist", clean === null, clean);

process.exit(failed === 0 ? 0 : 1);
