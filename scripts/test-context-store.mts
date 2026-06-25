/** Context blob store checks (run: npx tsx scripts/test-context-store.mts) */
import {
  buildCommandOutputDigest,
  buildFetchDigest,
  buildJsonDigest,
  buildRepoDiffDigest,
  buildToolExchangeDigest,
  createContextBlob,
  retrieveContextBlobText,
} from "../lib/build-context/context-store";
import {
  __resetClientStoreForTests,
  deleteDiscussion,
  getContextBlob,
  getContextBlobsForDiscussion,
  insertDiscussion,
  upsertContextBlob,
} from "../lib/client/store";
import type { Discussion } from "../lib/db/schema";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const longOutput = [
  "$ npm test",
  "exit 1 (2.2s)",
  "stdout:",
  ...Array.from({ length: 250 }, (_, index) => `line ${index}: ${"x".repeat(60)}`),
].join("\n");

const blobA = createContextBlob({
  discussionId: "disc-ctx",
  kind: "command_output",
  label: "npm test output",
  text: longOutput,
  createdAt: "2026-06-26T00:00:00.000Z",
});
const blobB = createContextBlob({
  discussionId: "disc-ctx",
  kind: "command_output",
  label: "npm test output",
  text: longOutput,
  createdAt: "2030-01-01T00:00:00.000Z",
});

check(
  "context blob id is deterministic for discussion/kind/label/text",
  blobA.id === blobB.id && blobA.id.startsWith("ctx_") && /^[A-Za-z0-9_-]+$/.test(blobA.id),
  { idA: blobA.id, idB: blobB.id }
);
check(
  "context blob records token estimate and digest",
  blobA.tokenEstimate > 0 && blobA.digest.includes(blobA.id) && blobA.digest.includes("npm test output"),
  blobA
);

const commandDigest = buildCommandOutputDigest(blobA);
check(
  "long command output digest includes retrieve ref and bounded preview",
  commandDigest.includes(blobA.id) &&
    commandDigest.includes('"action":"context_retrieve"') &&
    commandDigest.length < longOutput.length,
  { digestLength: commandDigest.length, outputLength: longOutput.length }
);

const jsonBlob = createContextBlob({
  discussionId: "disc-ctx",
  kind: "json",
  label: "runner response",
  text: JSON.stringify({ ok: true, files: ["src/a.ts", "src/b.ts"], nested: { count: 2 } }, null, 2),
});
const diffBlob = createContextBlob({
  discussionId: "disc-ctx",
  kind: "repo_diff",
  label: "working tree diff",
  text: "diff --git a/src/a.ts b/src/a.ts\n+added\n-removed\n".repeat(80),
});
const fetchBlob = createContextBlob({
  discussionId: "disc-ctx",
  kind: "fetch",
  label: "https://example.test/docs",
  text: "Fetched docs\n\n" + "body ".repeat(1_000),
});
const exchangeBlob = createContextBlob({
  discussionId: "disc-ctx",
  kind: "tool_exchange",
  label: "Architect omitted tool exchange",
  text: "assistant: {\"action\":\"run\"}\nuser: result\n".repeat(200),
});
check(
  "all digest builders mention retrieve refs",
  [buildJsonDigest(jsonBlob), buildRepoDiffDigest(diffBlob), buildFetchDigest(fetchBlob), buildToolExchangeDigest(exchangeBlob)].every(
    (digest) => /ctx_[A-Za-z0-9_-]+/.test(digest) && digest.includes("context_retrieve")
  )
);

const bounded = retrieveContextBlobText(blobA, { maxTokens: 120 });
check(
  "bounded retrieval returns exact prefix with truncation metadata",
  bounded.truncated &&
    bounded.text === longOutput.slice(0, bounded.returnedChars) &&
    bounded.returnedChars < bounded.totalChars &&
    bounded.returnedTokens <= 120,
  bounded
);
const exact = retrieveContextBlobText(blobA, { maxTokens: blobA.tokenEstimate + 100 });
check(
  "unbounded-enough retrieval returns exact full text",
  !exact.truncated && exact.text === longOutput,
  exact
);

__resetClientStoreForTests();
const discussion: Discussion = {
  id: "disc-ctx",
  topic: "store context",
  mode: "build",
  effort: "medium",
  status: "running",
  modelIds: "[]",
  judgeModelId: null,
  attachmentIds: null,
  currentRound: 0,
  maxRounds: 1,
  convergenceScore: null,
  createdAt: "2026-06-26T00:00:00.000Z",
  updatedAt: "2026-06-26T00:00:00.000Z",
};
insertDiscussion(discussion);
upsertContextBlob(blobA);
upsertContextBlob(blobB);
check(
  "client store dedupes repeated context blob upserts",
  getContextBlobsForDiscussion("disc-ctx").length === 1 &&
    getContextBlob(blobA.id)?.createdAt === blobB.createdAt,
  getContextBlobsForDiscussion("disc-ctx")
);

const persisted = getContextBlobsForDiscussion("disc-ctx");
__resetClientStoreForTests({ discussions: [discussion], contextBlobs: persisted });
check(
  "context blobs survive store resume/hydration",
  getContextBlob(blobA.id)?.text === longOutput &&
    getContextBlobsForDiscussion("disc-ctx").length === 1
);

deleteDiscussion("disc-ctx");
check(
  "deleting a discussion deletes its context blobs",
  getContextBlobsForDiscussion("disc-ctx").length === 0 && !getContextBlob(blobA.id)
);

console.log(failed === 0 ? "\nAll context store checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
