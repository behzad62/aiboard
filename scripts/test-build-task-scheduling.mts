/** Build task scheduling checks (run: npx tsx scripts/test-build-task-scheduling.mts) */
import {
  buildReviewFixTaskUpdate,
  filterNovelReviewTasks,
  selectBalancedWorkerIndex,
  shouldApplyReviewResultToTask,
  type BuildTask,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const existing: BuildTask[] = [
  {
    id: "T2",
    title: "AI bridge",
    instructions: "Create ai.ts",
    contextFiles: [],
    status: "planned",
    assignTo: "claude-opus-4-5",
  },
  {
    id: "T3",
    title: "Board UI",
    instructions: "Create board",
    contextFiles: [],
    status: "planned",
    assignTo: "Gemini 3.5 Flash",
  },
  {
    id: "T8",
    title: "Fix ammo limit",
    instructions: "Fix setAmmoLimit",
    contextFiles: ["src/game.js"],
    outputPaths: ["src/game.js"],
    status: "fixing",
  },
];

const filtered = filterNovelReviewTasks(existing, [
  {
    id: "T3",
    title: "Board UI duplicate",
    instructions: "Replanned board",
    assignTo: "claude-opus-4-5",
  },
  {
    id: "T7",
    title: "Fresh task",
    instructions: "New work",
    assignTo: "Gemini 3.5 Flash",
  },
]);

check("duplicate review task ids are skipped", filtered.accepted.length === 1, filtered);
check("duplicate skip reports existing id", filtered.skipped[0]?.id === "T3", filtered);
check("novel review task is retained", filtered.accepted[0]?.id === "T7", filtered);

const staleDuplicate = filterNovelReviewTasks(existing, [
  {
    id: "T12",
    title: "Fix ammo limit API and complete final browser acceptance",
    instructions: "Repeat the ammo-limit fix.",
    contextFiles: ["src/game.js"],
    outputPaths: ["src/game.js"],
  },
]);
check(
  "review-created task with overlapping unfinished output paths is skipped",
  staleDuplicate.accepted.length === 0 &&
    staleDuplicate.skipped[0]?.id === "T12" &&
    staleDuplicate.skipped[0]?.title === "Fix ammo limit",
  staleDuplicate
);

const counts = new Map<number, number>([
  [0, 2],
  [1, 0],
]);
const balanced = selectBalancedWorkerIndex({
  activeWorkerIndexes: [0, 1],
  assignmentCounts: counts,
  assignCursor: 0,
  requestedIndex: 0,
});

check("overused requested worker is treated as a preference", balanced.index === 1, balanced);
check("balanced assignment advances cursor", balanced.assignCursor === 1, balanced);
check("balanced assignment increments chosen worker count", counts.get(1) === 1, [...counts]);

const equalCounts = new Map<number, number>([
  [0, 1],
  [1, 1],
]);
const requested = selectBalancedWorkerIndex({
  activeWorkerIndexes: [0, 1],
  assignmentCounts: equalCounts,
  assignCursor: 0,
  requestedIndex: 0,
});

check("requested worker is honored when not overloaded", requested.index === 0, requested);
check("honored requested assignment does not consume cursor", requested.assignCursor === 0, requested);

const fixing: BuildTask = {
  id: "T2",
  title: "AI bridge",
  instructions: "Create ai.ts",
  contextFiles: ["lib/games/chess/types.ts"],
  status: "review",
  workerIndex: 0,
  assignTo: "claude-opus-4-5",
};
const fixUpdate = buildReviewFixTaskUpdate(
  fixing,
  "Compile and fix imports",
  ["lib/games/chess/ai.ts"],
  8
);

check("review fix clears pinned worker", fixUpdate.workerIndex === undefined, fixUpdate);
check("review fix clears assignTo preference", fixUpdate.assignTo === undefined, fixUpdate);
check(
  "review fix keeps previous output files in context",
  fixUpdate.contextFiles.includes("lib/games/chess/ai.ts"),
  fixUpdate
);
check("review fix appends instructions", /Compile and fix imports/.test(fixUpdate.instructions), fixUpdate);

check(
  "review verdicts only mutate tasks currently awaiting review",
  shouldApplyReviewResultToTask({ status: "review" }) &&
    !shouldApplyReviewResultToTask({ status: "planned" }) &&
    !shouldApplyReviewResultToTask({ status: "fixing" }) &&
    !shouldApplyReviewResultToTask({ status: "done" }) &&
    !shouldApplyReviewResultToTask({ status: "failed" }),
);

process.exit(failed === 0 ? 0 : 1);
