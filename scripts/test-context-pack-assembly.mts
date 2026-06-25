/** Context pack assembly checks (run: npx tsx scripts/test-context-pack-assembly.mts) */
import { createBuildPromptBudget } from "../lib/build-context/budgets";
import {
  assembleContextPacks,
  type ContextPack,
} from "../lib/build-context/context-packs";
import { renderContextPackSection } from "../lib/build-context/prompt-assembly";
import { estimateTokens } from "../lib/build-context/token-estimator";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const text = (label: string, words: number) =>
  Array.from({ length: words }, (_, index) => `${label}_${index}`).join(" ");

const requiredFirst = assembleContextPacks(
  [
    {
      id: "optional-source",
      title: "Current source",
      kind: "source",
      content: text("source", 80),
      exact: true,
      priority: 100,
    },
    {
      id: "required-brief",
      title: "Required brief",
      kind: "note",
      content: "This brief is mandatory.",
      required: true,
      priority: 0,
    },
  ],
  { tokenBudget: 240 }
);
check(
  "required packs are selected first even when optional packs score higher",
  requiredFirst.selected[0]?.id === "required-brief",
  requiredFirst.selected.map((pack) => pack.id)
);

const smallRequiredContent = "Keep this small required instruction.";
const requiredReservation = assembleContextPacks(
  [
    {
      id: "large-required",
      title: "Large required context",
      kind: "note",
      content: text("large_required", 500),
      required: true,
      priority: 10,
    },
    {
      id: "small-required",
      title: "Small required context",
      kind: "note",
      content: smallRequiredContent,
      required: true,
      priority: 1,
    },
  ],
  { tokenBudget: estimateTokens(smallRequiredContent) + 45 }
);
const requiredReservationIds = requiredReservation.selected.map((pack) => pack.id);
check(
  "oversized required packs truncate without starving later required packs that fit",
  requiredReservationIds.includes("large-required") &&
    requiredReservationIds.includes("small-required") &&
    requiredReservation.selected.find((pack) => pack.id === "large-required")?.mode ===
      "truncated" &&
    requiredReservation.selected.find((pack) => pack.id === "small-required")
      ?.includedContent === smallRequiredContent,
  requiredReservation
);

const exactBeatsSummary = assembleContextPacks(
  [
    {
      id: "summary",
      title: "Summary",
      kind: "summary",
      content: text("summary", 32),
      priority: 50,
    },
    {
      id: "exact-source",
      title: "Exact current file",
      kind: "source",
      content: text("exact", 32),
      exact: true,
      priority: 0,
    },
  ],
  { tokenBudget: 90 }
);
check(
  "exact current source outranks summaries under a tight budget",
  exactBeatsSummary.selected.map((pack) => pack.id).join(",") === "exact-source" &&
    exactBeatsSummary.omitted.some((pack) => pack.id === "summary"),
  exactBeatsSummary
);

const digestFallback = assembleContextPacks(
  [
    {
      id: "oversized-history",
      title: "Long previous wave",
      kind: "history",
      content: text("history", 1_000),
      digest: "Earlier worker wave changed the router and left two failing tests.",
      retrieveRef: {
        id: "history:wave-4",
        label: "Worker wave 4 full transcript",
        kind: "history",
      },
      priority: 10,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  { tokenBudget: 45 }
);
check(
  "oversized non-exact packs use digest plus retrieve ref when possible",
  digestFallback.selected.length === 1 &&
    digestFallback.selected[0].id === "oversized-history" &&
    digestFallback.selected[0].mode === "digest" &&
    digestFallback.selected[0].retrieveRef?.id === "history:wave-4",
  digestFallback
);

const priorityDrop = assembleContextPacks(
  [
    {
      id: "old-low-history",
      title: "Old low-priority history",
      kind: "history",
      content: text("old", 42),
      priority: 1,
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "new-high-history",
      title: "New high-priority history",
      kind: "history",
      content: text("new", 42),
      priority: 10,
      createdAt: "2026-06-01T00:00:00.000Z",
    },
  ],
  { tokenBudget: 120 }
);
check(
  "low-priority old history drops before higher-priority history",
  priorityDrop.selected.map((pack) => pack.id).join(",") === "new-high-history" &&
    priorityDrop.omitted.some((pack) => pack.id === "old-low-history"),
  priorityDrop
);

const contextPacks: ContextPack[] = [
  {
    id: "task",
    title: "Task brief",
    kind: "note",
    content: text("task", 100),
    required: true,
  },
  {
    id: "current-file",
    title: "Current file",
    kind: "source",
    content: text("file", 700),
    exact: true,
    priority: 20,
  },
  ...Array.from({ length: 8 }, (_, index): ContextPack => ({
    id: `history-${index}`,
    title: `History ${index}`,
    kind: "history",
    content: text(`history${index}`, 500),
    priority: 8 - index,
    createdAt: `2026-05-${String(index + 1).padStart(2, "0")}T00:00:00.000Z`,
  })),
];
const tinyBudget = createBuildPromptBudget({ role: "worker", tier: "tiny" });
const hugeBudget = createBuildPromptBudget({ role: "worker", tier: "huge" });
const tinyAssembly = assembleContextPacks(contextPacks, {
  tokenBudget: tinyBudget.contextPackTokens,
});
const hugeAssembly = assembleContextPacks(contextPacks, {
  tokenBudget: hugeBudget.contextPackTokens,
});
check(
  "huge-context models include additional context that tiny models drop",
  hugeAssembly.selected.length > tinyAssembly.selected.length &&
    tinyAssembly.omitted.length > 0,
  {
    tinySelected: tinyAssembly.selected.map((pack) => pack.id),
    hugeSelected: hugeAssembly.selected.map((pack) => pack.id),
  }
);

const rendered = renderContextPackSection(tinyAssembly, {
  heading: "Selected build context",
  includeOmissionNotes: true,
});
check(
  "prompt renderer exposes selected packs, token totals, and omission notes",
  rendered.text.includes("Selected build context") &&
    rendered.text.includes("Task brief") &&
    rendered.tokenTotal === tinyAssembly.usedTokens &&
    rendered.omissionNotes.length === tinyAssembly.omitted.length,
  rendered
);

process.exit(failed === 0 ? 0 : 1);
