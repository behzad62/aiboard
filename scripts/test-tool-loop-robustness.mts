/** Tool-loop robustness checks (run: npx tsx scripts/test-tool-loop-robustness.mts) */
import {
  compactToolConversation,
  createToolCallTracker,
  exactToolKey,
  isRedundantToolCall,
  recordToolCall,
  shouldRecordToolCallResult,
  type ArchitectAction,
  type ConversationMessage,
} from "../lib/orchestrator/build";
import {
  createReadRangeLoopGuard,
  createToolReplayCache,
  packToolBatchResult,
  scheduleBuildToolActions,
} from "../lib/orchestrator/build-tool-scheduler";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const range = (path: string, startLine: number, lineCount: number): ArchitectAction => ({
  action: "read_range",
  path,
  startLine,
  lineCount,
});

// ── exact keys ───────────────────────────────────────────────────────────────
check(
  "read key is order/case-insensitive",
  exactToolKey({ action: "read", paths: ["B.ts", "a.TS"] }) ===
    exactToolKey({ action: "read", paths: ["a.ts", "b.ts"] })
);
check(
  "search key normalizes",
  exactToolKey({ action: "search", query: "  Fuse Timer  " }) === "search:fuse timer"
);

// ── exact dedup ──────────────────────────────────────────────────────────────
{
  const t = createToolCallTracker();
  const read: ArchitectAction = { action: "read", paths: ["src/entities.js", "src/game.js"] };
  check("first read not redundant", !isRedundantToolCall(t, read));
  recordToolCall(t, read);
  check("repeated read is redundant", isRedundantToolCall(t, read));
  check(
    "reordered same read is redundant",
    isRedundantToolCall(t, { action: "read", paths: ["src/game.js", "src/entities.js"] })
  );
}

// ── overlap-aware range dedup (the screenshot bug) ───────────────────────────
{
  const t = createToolCallTracker();
  const first = range("src/entities.js", 265, 100); // lines 265-364
  check("first range not redundant", !isRedundantToolCall(t, first));
  recordToolCall(t, first, { startLine: 265, endLine: 364 });

  // The exact evasion from the failing run: 265/100 then 265/80.
  check(
    "nudged smaller range (265/80) is caught as redundant",
    isRedundantToolCall(t, range("src/entities.js", 265, 80))
  );
  check(
    "fully-contained range is redundant",
    isRedundantToolCall(t, range("src/entities.js", 280, 40))
  );
  check(
    "a genuinely new range (continuing past endLine) is allowed",
    !isRedundantToolCall(t, range("src/entities.js", 365, 100))
  );
  check(
    "same range in a DIFFERENT file is allowed",
    !isRedundantToolCall(t, range("src/game.js", 265, 100))
  );
  // A mostly-new range that only slightly overlaps must be allowed.
  check(
    "mostly-new overlapping range (340-460) is allowed",
    !isRedundantToolCall(t, range("src/entities.js", 340, 120))
  );
}

// MCP errors such as "Target page has been closed" are transient tool failures,
// not delivered evidence. They must not poison the duplicate-call tracker.
{
  const mcpNavigate: ArchitectAction = {
    action: "tool",
    server: "playwright",
    tool: "browser_navigate",
    args: { url: "http://localhost:3001/games" },
  };
  check(
    "failed MCP calls are not remembered as delivered",
    !shouldRecordToolCallResult(mcpNavigate, "error")
  );
  check(
    "denied MCP calls are remembered as delivered",
    shouldRecordToolCallResult(mcpNavigate, "denied")
  );
}

// merged intervals: two adjacent reads should cover their union
{
  const t = createToolCallTracker();
  recordToolCall(t, range("a.ts", 1, 50), { startLine: 1, endLine: 50 });
  recordToolCall(t, range("a.ts", 51, 50), { startLine: 51, endLine: 100 });
  check(
    "union of adjacent ranges covers a spanning re-read",
    isRedundantToolCall(t, range("a.ts", 10, 80))
  );
}

// ── conversation compaction ──────────────────────────────────────────────────
{
  const big = "x".repeat(5_000);
  const messages: ConversationMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "initial instructions" },
  ];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "assistant", content: `tool call ${i}` });
    messages.push({ role: "user", content: `tool result ${i} ${big}` });
  }
  const before = messages.length;
  const { messages: out, compacted } = compactToolConversation(messages, 20_000, 6);
  check("compaction folded middle turns", compacted > 0, { compacted });
  check("compaction kept system + initial instruction", out[0].content === "sys" && out[1].content === "initial instructions");
  check("compaction kept the most recent turns verbatim", out[out.length - 1].content.startsWith("tool result 9"));
  check("compaction shrank the message list", out.length < before, { before, after: out.length });
  check("compaction left input array untouched", messages.length === before);

  // Under budget → untouched.
  const small: ConversationMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "hi" },
    { role: "assistant", content: "ok" },
  ];
  const noop = compactToolConversation(small, 20_000, 6);
  check("under-budget conversation is unchanged", noop.compacted === 0 && noop.messages === small);
}

// Context retrieval output reports exact returnedChars/next offsets; it must not
// be sliced again by the generic batch cap after retrieval succeeds.
{
  const exactBody = "EXACT_CONTEXT_BODY_" + "x".repeat(700);
  const packed = packToolBatchResult({
    served: [
      {
        label: "context_retrieve ctx_big@0",
        result: exactBody,
        preserveFullResult: true,
      },
      {
        label: "read src/after.ts",
        result: "SHOULD_BE_OMITTED_AFTER_PROTECTED_RESULT",
      },
    ],
    skipped: [],
    maxChars: 180,
  });
  const protectedSection = packed
    .slice(packed.indexOf("--- context_retrieve ctx_big@0 ---"))
    .split("--- read src/after.ts ---")[0];
  check(
    "protected context_retrieve batch result is preserved past maxChars",
    packed.includes(exactBody) &&
      !protectedSection.includes("[truncated: output cap reached]"),
    packed
  );
  check(
    "later unprotected batch result is omitted after protected result exhausts cap",
    packed.includes("--- read src/after.ts ---\n[omitted: output cap reached]"),
    packed
  );

  const normalPacked = packToolBatchResult({
    served: [{ label: "read src/big.ts", result: "NORMAL_RESULT_" + "y".repeat(700) }],
    skipped: [],
    maxChars: 180,
  });
  check(
    "normal unmarked batch result is still capped",
    normalPacked.includes("[truncated: output cap reached]") &&
      !normalPacked.includes("y".repeat(700)),
    normalPacked
  );
}

{
  const cache = createToolReplayCache();
  const searchAction: ArchitectAction = {
    action: "search",
    query: "function createWindowWallMesh",
  };
  const readAction = range("src/renderer.js", 758, 120);
  cache.remember(searchAction, 'Search results for "function createWindowWallMesh":\nsrc/renderer.js:758:function createWindowWallMesh');
  cache.remember(
    readAction,
    "--- src/renderer.js lines 758-877 of 1100 (partial range) ---\nfunction createWindowWallMesh() {}",
    { startLine: 758, endLine: 877 }
  );

  check(
    "replay cache summarizes already-inspected search and read_range context",
    cache
      .summary()
      .some((line) => line.includes("search function createWindowWallMesh")) &&
      cache
        .summary()
        .some((line) => line.includes("read_range src/renderer.js:758-877")),
    cache.summary()
  );
  check(
    "duplicate read_range replays cached context instead of becoming an empty skip",
    cache.replay(readAction)?.includes("REPLAYED DUPLICATE TOOL RESULT") === true,
    cache.replay(readAction)
  );

  const packedWithMemory = packToolBatchResult({
    served: [],
    skipped: [{ label: "read_range src/renderer.js:758", reason: "duplicate tool request" }],
    memory: cache.summary(),
    maxChars: 800,
  });
  check(
    "tool batch result carries inspected-context memory even when nothing is served",
    packedWithMemory.includes("Already available in this task") &&
      packedWithMemory.includes("read_range src/renderer.js:758-877"),
    packedWithMemory
  );
}

{
  const firstRetrieve: ArchitectAction = {
    action: "context_retrieve",
    ref: "ctx_first",
    maxTokens: 4000,
    offsetChars: 0,
  };
  const secondRetrieve: ArchitectAction = {
    action: "context_retrieve",
    ref: "ctx_second",
    maxTokens: 4000,
    offsetChars: 0,
  };
  const scheduled = scheduleBuildToolActions([firstRetrieve, secondRetrieve], {
    allowSafeRunQueue: false,
    maxSafeRuns: 0,
  });
  check(
    "scheduler serves only one context_retrieve per batch",
    scheduled.served.length === 1 &&
      scheduled.served[0].action === firstRetrieve &&
      scheduled.skipped.length === 1 &&
      scheduled.skipped[0].action === secondRetrieve,
    scheduled
  );
  check(
    "scheduler explains skipped extra context_retrieve",
    /context_retrieve/i.test(scheduled.skipped[0]?.reason ?? ""),
    scheduled.skipped
  );
}

// Sequential large-file paging is useful once, but when a worker has already
// covered nearly the whole file and starts the same sweep again, replaying cached
// chunks keeps the model busy without progress. Interrupt before replay.
{
  const guard = createReadRangeLoopGuard({
    minTotalLines: 1_000,
    coverageThreshold: 0.85,
    restartFraction: 0.25,
  });
  const linesFor = (start: number, end: number): string =>
    Array.from({ length: end - start + 1 }, (_, index) => `line ${start + index}`).join("\n");
  const record = (startLine: number, endLine: number) => {
    const action = range("src/game.js", startLine, endLine - startLine + 1);
    const before = guard.shouldInterrupt(action);
    check(`first pass ${startLine}-${endLine} is not interrupted`, before === null, before);
    guard.record(
      action,
      `--- src/game.js lines ${startLine}-${endLine} of 1972 (partial range) ---\n${linesFor(startLine, endLine)}`
    );
  };
  record(1, 200);
  record(201, 400);
  record(401, 600);
  record(601, 800);
  record(801, 1000);
  record(1001, 1200);
  record(1201, 1400);
  record(1401, 1600);
  record(1601, 1800);
  record(1801, 1972);

  const repeatedSweep = guard.shouldInterrupt(range("src/game.js", 200, 200));
  check(
    "second sweep over already-covered large file is interrupted",
    repeatedSweep?.includes("already delivered") === true &&
      repeatedSweep.includes("src/game.js"),
    repeatedSweep
  );
  check(
    "targeted reread far from the restart zone is still allowed",
    guard.shouldInterrupt(range("src/game.js", 1400, 80)) === null
  );
}

console.log(failed === 0 ? "\nAll robustness checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
