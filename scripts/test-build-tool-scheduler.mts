/** Build tool scheduler checks (run: npx tsx scripts/test-build-tool-scheduler.mts) */
import {
  classifyBuildToolActionForScheduling,
  isSafeQueuedRunCommand,
  packToolBatchResult,
  createToolReplayCache,
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
const searchAction = { action: "search" as const, query: "drawConnectors" };
replayCache.remember(searchAction, "search hit public/app.js:520");
check(
  "exact read/search duplicate can be replayed from cache",
  replayCache.replay(searchAction)?.includes("search hit"),
  replayCache.replay(searchAction)
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

process.exit(failed === 0 ? 0 : 1);
