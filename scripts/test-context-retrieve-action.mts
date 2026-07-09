/** Context retrieve action checks (run: npx tsx scripts/test-context-retrieve-action.mts) */
import {
  compactToolConversation,
  createToolCallTracker,
  exactToolKey,
  isBuildToolAction,
  isRedundantToolCall,
  isSafeFirstToolAction,
  isWorkerBuildToolAction,
  parseArchitectAction,
  recordToolCall,
  type ConversationMessage,
} from "../lib/orchestrator/build";
import {
  buildToolExchangeDigest,
  createContextBlob,
} from "../lib/build-context/context-store";
import {
  __resetClientStoreForTests,
  getContextBlob,
  getContextBlobsForDiscussion,
  upsertContextBlob,
} from "../lib/client/store";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const parsed = parseArchitectAction(
  '{"action":"context_retrieve","ref":"ctx_tool_exchange_abc123XYZ","maxTokens":4000,"offsetChars":1200,"reason":"need old command output"}'
);
check(
  "parser accepts context_retrieve with safe ref",
  parsed?.action === "context_retrieve" &&
    parsed.ref === "ctx_tool_exchange_abc123XYZ" &&
    parsed.maxTokens === 4000 &&
    parsed.offsetChars === 1200,
  parsed
);
check(
  "schema/classifiers accept context_retrieve for architect and worker",
  !!parsed &&
    isBuildToolAction(parsed) &&
    isSafeFirstToolAction(parsed) &&
    isWorkerBuildToolAction(parsed),
  parsed
);
check(
  "parser clamps context_retrieve maxTokens and offsetChars",
  parseArchitectAction(
    '{"action":"context_retrieve","ref":"ctx_abc123","maxTokens":999999,"offsetChars":-99}'
  )?.action === "context_retrieve" &&
    (parseArchitectAction(
      '{"action":"context_retrieve","ref":"ctx_abc123","maxTokens":999999,"offsetChars":-99}'
    ) as { maxTokens?: number; offsetChars?: number } | null)?.maxTokens === 12000 &&
    (parseArchitectAction(
      '{"action":"context_retrieve","ref":"ctx_abc123","maxTokens":999999,"offsetChars":-99}'
    ) as { maxTokens?: number; offsetChars?: number } | null)?.offsetChars === 0
);
check(
  "parser rejects invalid context_retrieve refs",
  parseArchitectAction('{"action":"context_retrieve","ref":"../secret","maxTokens":4000}') === null &&
    parseArchitectAction('{"action":"context_retrieve","ref":"ctx_bad/slash","maxTokens":4000}') === null &&
    parseArchitectAction('{"action":"context_retrieve","ref":"ctx_","maxTokens":4000}') === null
);

const malformedMiniMaxRetrieve = parseArchitectAction(
  '{"action":"context_retrieve","<ref":"ctx_repo_diff_0cdbneg11qpfc0","maxTokens>4000]<]minimax[>[<\\/maxTokens>]<]minimax[>[<offsetChars>1200]<]minimax[>[<\\/offsetChars>]<]minimax[>[<reason>Inspect diff content"}'
);
check(
  "parser repairs MiniMax-marked context_retrieve payloads",
  malformedMiniMaxRetrieve?.action === "context_retrieve" &&
    malformedMiniMaxRetrieve.ref === "ctx_repo_diff_0cdbneg11qpfc0" &&
    malformedMiniMaxRetrieve.maxTokens === 4000 &&
    malformedMiniMaxRetrieve.offsetChars === 1200,
  malformedMiniMaxRetrieve
);

check(
  "parser does not repair context_retrieve without a safe ref",
  parseArchitectAction(
    '{"action":"context_retrieve","<ref":"../secret","maxTokens>4000]<]minimax[>[<\\/maxTokens>]'
  ) === null
);

if (parsed) {
  const keyA = exactToolKey(parsed);
  const keyB = exactToolKey({
    action: "context_retrieve",
    ref: "ctx_tool_exchange_abc123XYZ",
    maxTokens: 4000,
    offsetChars: 1200,
  });
  const keyC = exactToolKey({
    action: "context_retrieve",
    ref: "ctx_tool_exchange_abc123XYZ",
    maxTokens: 4000,
    offsetChars: 2400,
  });
  const tracker = createToolCallTracker();
  check("exactToolKey dedupes identical context_retrieve calls", keyA === keyB, {
    keyA,
    keyB,
  });
  check("exactToolKey distinguishes context_retrieve offsets", keyA !== keyC, {
    keyA,
    keyC,
  });
  check("first context_retrieve is not redundant", !isRedundantToolCall(tracker, parsed));
  recordToolCall(tracker, parsed);
  check("repeated context_retrieve is redundant", isRedundantToolCall(tracker, parsed));
}

{
  const big = "tool output ".repeat(1_000);
  const messages: ConversationMessage[] = [
    { role: "system", content: "sys" },
    { role: "user", content: "initial instructions" },
  ];
  for (let i = 0; i < 10; i++) {
    messages.push({ role: "assistant", content: `tool call ${i}` });
    messages.push({ role: "user", content: `tool result ${i}\n${big}` });
  }
  const before = messages.length;
  let omittedSeen = 0;
  const result = compactToolConversation(messages, 20_000, 6, ({ omitted }) => {
    omittedSeen = omitted.length;
    const text = omitted
      .map((message, index) => `## ${index + 1}. ${message.role}\n${message.content}`)
      .join("\n\n");
    const blob = createContextBlob({
      discussionId: "disc-action",
      kind: "tool_exchange",
      label: "Architect review omitted tool exchange",
      text,
      createdAt: "2026-06-26T00:00:00.000Z",
    });
    return {
      role: "user",
      content: buildToolExchangeDigest(blob),
    };
  });
  check("compaction placeholder callback sees omitted messages", omittedSeen > 0, omittedSeen);
  check("compaction with context digest keeps head and tail", result.messages[0].content === "sys" && result.messages[1].content === "initial instructions" && result.messages[result.messages.length - 1].content.startsWith("tool result 9"));
  check("compaction digest includes retrieve ref", result.messages[2].content.includes("ctx_") && result.messages[2].content.includes("context_retrieve"), result.messages[2].content);
  check("compaction does not mutate input", messages.length === before && !messages.some((message) => message.content.includes("context_retrieve")));
}

{
  __resetClientStoreForTests();
  const blob = createContextBlob({
    discussionId: "disc-action",
    kind: "tool_exchange",
    label: "stored omitted exchange",
    text: "exact omitted text",
    createdAt: "2026-06-26T00:00:00.000Z",
  });
  upsertContextBlob(blob);
  const snapshot = getContextBlobsForDiscussion("disc-action");
  __resetClientStoreForTests({ contextBlobs: snapshot });
  check("store helpers hydrate context blobs after reset", getContextBlob(blob.id)?.text === "exact omitted text");
}

console.log(failed === 0 ? "\nAll context retrieve action checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
