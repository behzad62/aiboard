/** Build tool scheduler checks (run: npx tsx scripts/test-build-tool-scheduler.mts) */
import {
  classifyBuildToolActionForScheduling,
  isSafeQueuedRunCommand,
  packToolBatchResult,
  createToolReplayCache,
  replayDuplicateToolAction,
  scheduleBuildToolActions,
  skippedOnlyToolBatchRecoveryInstruction,
} from "../lib/orchestrator/build-tool-scheduler";
import { inspectStrictToolActionBatchOutput } from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const inspected = inspectStrictToolActionBatchOutput(
  [
    '{"action":"read","paths":["package.json","app/page.tsx"]}',
    '{"action":"search","query":"BUILD_LIMITS"}',
  ].join("\n")
);
check("multiple safe read actions parse as a batch", inspected.valid && inspected.actions.length === 2, inspected);

check("read action is batch safe", classifyBuildToolActionForScheduling({ action: "read", paths: ["a.ts"] }) === "batch_read");
check("patch action is queued mutation", classifyBuildToolActionForScheduling({ action: "patch", path: "a.ts", ops: [] }) === "queued_mutation");
check("npm build is safe queued command", isSafeQueuedRunCommand("npm run build"));
check("npm install is not safe queued command", !isSafeQueuedRunCommand("npm install"));

const scheduled = scheduleBuildToolActions(inspected.actions, { allowSafeRunQueue: true, maxSafeRuns: 3 });
check("safe reads are served", scheduled.served.length === 2, scheduled);
check("no skipped actions for safe batch", scheduled.skipped.length === 0, scheduled);

const mixed = scheduleBuildToolActions(
  [
    { action: "run", command: "npm run build" },
    { action: "run", command: "npm install" },
  ],
  { allowSafeRunQueue: true, maxSafeRuns: 3 }
);
check("unsafe command is skipped from safe queue", mixed.served.length === 1 && mixed.skipped.length === 1, mixed);

// Ask mode (no safe-run queue): a single safe command must still run alone
// (approval-gated downstream), not be dropped.
const askModeSingleRun = scheduleBuildToolActions(
  [{ action: "run", command: "npm test" }],
  { allowSafeRunQueue: false, maxSafeRuns: 0 }
);
check(
  "single safe command still runs when batching is off",
  askModeSingleRun.served.length === 1 && askModeSingleRun.skipped.length === 0,
  askModeSingleRun
);

const mcpTool = scheduleBuildToolActions(
  [
    {
      action: "tool",
      server: "playwright",
      tool: "browser_navigate",
      args: { url: "http://localhost:3000/games" },
    },
  ],
  { allowSafeRunQueue: true, maxSafeRuns: 3 }
);
check(
  "mcp tool action runs alone with descriptive label",
  mcpTool.served.length === 1 &&
    mcpTool.served[0]?.label === "mcp:playwright.browser_navigate",
  mcpTool
);

const packed = packToolBatchResult({
  served: [{ label: "read package.json", result: "x".repeat(100) }],
  skipped: [{ label: "run npm install", reason: "unsafe command" }],
  maxChars: 80,
});
check("packed result lists served", /Served/.test(packed), packed);
check("packed result lists skipped", /Skipped/.test(packed), packed);
check("packed result caps output", packed.length < 500, packed);
check(
  "skipped-only tool batches instruct worker to finalize without more tools",
  /stop using tools now/i.test(
    skippedOnlyToolBatchRecoveryInstruction({ servedCount: 0, skippedCount: 1 })
  ),
);
check(
  "partially served tool batches do not force final output",
  skippedOnlyToolBatchRecoveryInstruction({ servedCount: 1, skippedCount: 1 }) === "",
);
check(
  "terminal skipped tool batches force final output even when other actions served",
  /stop using tools now/i.test(
    skippedOnlyToolBatchRecoveryInstruction({
      servedCount: 1,
      skippedCount: 1,
      terminalSkippedCount: 1,
    })
  ),
);

const replayCache = createToolReplayCache();
const rangeAction = {
  action: "read_range" as const,
  path: "public/app.js",
  startLine: 520,
  lineCount: 80,
};
replayCache.remember(rangeAction, "line 520 result", { startLine: 520, endLine: 599 });
const exactReplay = replayCache.replay(rangeAction);
check(
  "read_range duplicate can be replayed from cache",
  exactReplay?.includes("REPLAYED") && exactReplay.includes("line 520 result"),
  exactReplay
);
const overlappingReplay = replayCache.replay({
  action: "read_range",
  path: "public/app.js",
  startLine: 535,
  lineCount: 40,
});
check(
  "overlapping read_range duplicate can be replayed from cache",
  overlappingReplay?.includes("line 520 result"),
  overlappingReplay
);
const replayedDuplicate = replayDuplicateToolAction({
  action: rangeAction,
  label: "read_range public/app.js:520",
  replayCache,
});
check(
  "duplicate read_range action is served from replay cache instead of skipped",
  replayedDuplicate.served?.label === "read_range public/app.js:520 (replayed)" &&
    replayedDuplicate.served.result.includes("line 520 result") &&
    replayedDuplicate.skipped === null,
  replayedDuplicate
);
const skippedDuplicate = replayDuplicateToolAction({
  action: { action: "read_range", path: "missing.js", startLine: 1, lineCount: 20 },
  label: "read_range missing.js:1",
  replayCache,
});
check(
  "duplicate action without replay remains skipped",
  skippedDuplicate.served === null &&
    skippedDuplicate.skipped?.reason === "duplicate tool request (already delivered)",
  skippedDuplicate
);

const spanningCache = createToolReplayCache();
const numberedLines = (start: number, end: number): string =>
  Array.from({ length: end - start + 1 }, (_, index) => `line ${start + index}`).join("\n");
spanningCache.remember(
  { action: "read_range", path: "src/game.js", startLine: 400, lineCount: 200 },
  `--- src/game.js lines 400-599 of 1000 (partial range) ---\n${numberedLines(400, 599)}`,
  { startLine: 400, endLine: 599 }
);
spanningCache.remember(
  { action: "read_range", path: "src/game.js", startLine: 600, lineCount: 200 },
  `--- src/game.js lines 600-799 of 1000 (partial range) ---\n${numberedLines(600, 799)}`,
  { startLine: 600, endLine: 799 }
);
const spanningReplay = spanningCache.replay({
  action: "read_range",
  path: "src/game.js",
  startLine: 550,
  lineCount: 200,
});
check(
  "read_range spanning multiple cached ranges can be replayed",
  spanningReplay?.includes("REPLAYED") === true &&
    spanningReplay.includes("lines 550-749") &&
    spanningReplay.includes("line 550") &&
    spanningReplay.includes("line 599") &&
    spanningReplay.includes("line 600") &&
    spanningReplay.includes("line 749") &&
    !spanningReplay.includes("line 549") &&
    !spanningReplay.includes("line 750"),
  spanningReplay
);
const searchAction = { action: "search" as const, query: "drawConnectors" };
replayCache.remember(searchAction, "search hit public/app.js:520");
check(
  "exact read/search duplicate can be replayed from cache",
  replayCache.replay(searchAction)?.includes("search hit"),
  replayCache.replay(searchAction)
);
const runAction = { action: "run" as const, command: "node --check src/game.js" };
replayCache.remember(runAction, "exit 0\nSYNTAX_OK");
const replayedRunDuplicate = replayDuplicateToolAction({
  action: runAction,
  label: "run node --check src/game.js",
  replayCache,
});
check(
  "duplicate run action is served from replay cache instead of skipped",
  replayedRunDuplicate.served?.label === "run node --check src/game.js (replayed)" &&
    replayedRunDuplicate.served.result.includes("SYNTAX_OK") &&
    replayedRunDuplicate.skipped === null,
  replayedRunDuplicate
);

check("fetch action is batch safe",
  classifyBuildToolActionForScheduling({ action: "fetch", url: "https://x.dev/docs", reason: "docs" }) === "batch_read");
const withFetch = scheduleBuildToolActions(
  [{ action: "read", paths: ["a.ts"] }, { action: "fetch", url: "https://x.dev/docs", reason: "docs" }],
  { allowSafeRunQueue: true, maxSafeRuns: 3 });
check("fetch batches with reads and gets a url label",
  withFetch.served.length === 2 && withFetch.skipped.length === 0 &&
    withFetch.served.some((s) => s.label === "fetch https://x.dev/docs"), withFetch);
const fetchAction = { action: "fetch" as const, url: "https://x.dev/docs", reason: "docs" };
replayCache.remember(fetchAction, "fetched docs body");
check("exact fetch duplicate can be replayed from cache",
  !!replayCache.replay(fetchAction)?.includes("fetched docs body"), replayCache.replay(fetchAction));

const consoleMessagesAction = {
  action: "tool" as const,
  server: "playwright",
  tool: "browser_console_messages",
  args: { level: "error", all: true },
  reason: "check browser errors",
};
replayCache.remember(consoleMessagesAction, "[] no console errors");
const replayedConsoleMessages = replayDuplicateToolAction({
  action: consoleMessagesAction,
  label: "mcp:playwright.browser_console_messages",
  replayCache,
});
check(
  "duplicate read-only MCP browser tool is replayed from cache instead of skipped",
  replayedConsoleMessages.served?.label === "mcp:playwright.browser_console_messages (replayed)" &&
    replayedConsoleMessages.served.result.includes("no console errors") &&
    replayedConsoleMessages.skipped === null,
  replayedConsoleMessages
);

const clickAction = {
  action: "tool" as const,
  server: "playwright",
  tool: "browser_click",
  args: { target: "#toggleRunBtn", element: "Start button" },
};
replayCache.remember(clickAction, "clicked");
check(
  "interactive MCP browser actions are not replayed from cache",
  replayCache.replay(clickAction) === null,
  replayCache.replay(clickAction)
);

process.exit(failed === 0 ? 0 : 1);
