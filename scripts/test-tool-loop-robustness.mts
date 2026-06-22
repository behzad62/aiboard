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

console.log(failed === 0 ? "\nAll robustness checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
