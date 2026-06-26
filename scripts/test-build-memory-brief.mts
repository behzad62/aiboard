/** Build memory brief checks (run: npx tsx scripts/test-build-memory-brief.mts) */
import {
  buildMemoryRecord,
  type BuildMemoryRecord,
} from "../lib/build-context/memory-store";
import {
  buildArchitectMemoryBrief,
  buildWorkerMemoryBrief,
  isMemoryRelevantToPaths,
  rankBuildMemories,
} from "../lib/build-context/memory-brief";
import { estimateTokens } from "../lib/build-context/token-estimator";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const projectKey = "repo:github.com/example/aiboard";
const rec = (
  partial: Omit<Parameters<typeof buildMemoryRecord>[0], "projectKey" | "evidence"> & {
    evidence?: Parameters<typeof buildMemoryRecord>[0]["evidence"];
  }
): BuildMemoryRecord =>
  buildMemoryRecord({
    projectKey,
    evidence: [{ kind: "problem", ref: `prob-${partial.summary.slice(0, 8)}` }],
    ...partial,
  });

const records: BuildMemoryRecord[] = [
  rec({
    kind: "decision",
    summary: "Keep memory native to AIBoard store instead of adding BuildContextManager.",
    createdAt: "2026-06-26T00:01:00.000Z",
  }),
  rec({
    kind: "user_correction",
    summary: "The user requires PowerShell-compatible commands.",
    createdAt: "2026-06-26T00:02:00.000Z",
  }),
  rec({
    kind: "failed_approach",
    summary: "Do not full-rewrite src/App.tsx; prior rewrite dropped existing state.",
    paths: ["src/App.tsx"],
    taskIds: ["T2"],
    createdAt: "2026-06-26T00:03:00.000Z",
  }),
  rec({
    kind: "fragile_file",
    summary: "src/components/Button.tsx had repeated SEARCH mismatch failures.",
    paths: ["src/components/Button.tsx"],
    createdAt: "2026-06-26T00:04:00.000Z",
  }),
  rec({
    kind: "reliable_command",
    summary: "npx tsc --noEmit passed repeatedly for this project.",
    command: "npx tsc --noEmit",
    createdAt: "2026-06-26T00:05:00.000Z",
  }),
  rec({
    kind: "failed_approach",
    summary: "Unrelated docs patch failed.",
    paths: ["docs/notes.md"],
    createdAt: "2026-06-26T00:06:00.000Z",
  }),
  rec({
    kind: "failed_approach",
    summary: "Prior discussion task T2 failed on unrelated files.",
    taskIds: ["T2"],
    createdAt: "2026-06-26T00:06:30.000Z",
  }),
  { ...rec({ kind: "decision", summary: "Stale decision", createdAt: "2026-06-26T00:07:00.000Z" }), status: "stale" },
  { ...rec({ kind: "decision", summary: "Dismissed decision", createdAt: "2026-06-26T00:08:00.000Z" }), status: "dismissed" },
  { ...rec({ kind: "decision", summary: "Superseded decision", createdAt: "2026-06-26T00:09:00.000Z" }), status: "superseded" },
];

check(
  "path matching is exact or ancestor/descendant aware",
  isMemoryRelevantToPaths(records[3], ["src/components/Button.tsx"]) &&
    isMemoryRelevantToPaths(records[3], ["src/components"]) &&
    !isMemoryRelevantToPaths(records[3], ["src/components2/Button.tsx"]),
  records[3]
);

const rankedForWorker = rankBuildMemories(records, {
  audience: "worker",
  taskId: "T2",
  paths: ["src/App.tsx"],
});
check(
  "worker ranking only includes task/path-relevant active memory",
  rankedForWorker[0].summary.includes("src/App.tsx") &&
    !rankedForWorker.some((m) => m.summary.includes("PowerShell")) &&
    !rankedForWorker.some((m) => m.summary.includes("native to AIBoard")) &&
    !rankedForWorker.some((m) => m.summary.includes("npx tsc")) &&
    !rankedForWorker.some((m) => m.summary.includes("Prior discussion task T2")) &&
    !rankedForWorker.some((m) => m.summary.includes("Stale decision")) &&
    !rankedForWorker.some((m) => m.summary.includes("Dismissed decision")) &&
    !rankedForWorker.some((m) => m.summary.includes("Superseded decision")),
  rankedForWorker.map((m) => m.summary)
);

const oldDecision = rec({
  kind: "decision",
  summary: "Same weight older decision.",
  createdAt: "2026-06-26T00:10:00.000Z",
});
const newDecision = rec({
  kind: "decision",
  summary: "Same weight newer decision.",
  createdAt: "2026-06-27T00:10:00.000Z",
});
const rankedByRecency = rankBuildMemories([oldDecision, newDecision], {
  audience: "architect",
});
check(
  "ranking uses monotonic recency as a tie-breaker",
  rankedByRecency[0].summary.includes("newer"),
  rankedByRecency.map((memory) => `${memory.lastSeenAt}: ${memory.summary}`)
);

const workerBrief = buildWorkerMemoryBrief(records, {
  taskId: "T2",
  paths: ["src/App.tsx"],
  tokenBudget: 180,
});
check(
  "worker receives only task/path-relevant memory, not unscoped project-level memory",
  workerBrief.text.includes("Build memory") &&
    workerBrief.text.includes("src/App.tsx") &&
    !workerBrief.text.includes("PowerShell") &&
    !workerBrief.text.includes("native to AIBoard") &&
    !workerBrief.text.includes("npx tsc --noEmit") &&
    !workerBrief.text.includes("Prior discussion task T2") &&
    !workerBrief.text.includes("Unrelated docs patch failed") &&
    estimateTokens(workerBrief.text) <= 180,
  workerBrief
);

const architectBrief = buildArchitectMemoryBrief(records, { tokenBudget: 260 });
check(
  "architect receives project-level memory including decisions and reliable commands",
  architectBrief.text.includes("native to AIBoard") &&
    architectBrief.text.includes("PowerShell") &&
    architectBrief.text.includes("npx tsc --noEmit") &&
    !architectBrief.text.includes("Stale decision"),
  architectBrief
);

const longRecords = Array.from({ length: 12 }, (_, index) =>
  rec({
    kind: "failed_approach",
    summary: `Long failed approach ${index} ${"x ".repeat(80)}`,
    paths: [`src/file-${index}.ts`],
    createdAt: `2026-06-26T00:${String(index + 10).padStart(2, "0")}:00.000Z`,
  })
);
const truncated = buildArchitectMemoryBrief(longRecords, { tokenBudget: 90 });
check(
  "memory brief truncates to the token budget and marks omission",
  truncated.truncated &&
    truncated.text.includes("[memory truncated]") &&
    estimateTokens(truncated.text) <= 90,
  { tokens: estimateTokens(truncated.text), text: truncated.text }
);

console.log(failed === 0 ? "\nAll build memory brief checks passed." : `\n${failed} check(s) failed.`);
process.exit(failed === 0 ? 0 : 1);
