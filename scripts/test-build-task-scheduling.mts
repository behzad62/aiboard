/** Build task scheduling checks (run: npx tsx scripts/test-build-task-scheduling.mts) */
import {
  allocateIncrementalTaskIds,
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

check("duplicate review task ids are retained for renumbering", filtered.accepted.length === 2, filtered);
check("duplicate review task ids are not reported as stale", filtered.skipped.length === 0, filtered);

const allocated = allocateIncrementalTaskIds(existing, filtered.accepted);
check(
  "review-created task ids are reassigned after the highest existing task id",
  JSON.stringify(allocated.tasks.map((task) => task.id)) === JSON.stringify(["T9", "T10"]),
  allocated
);
check(
  "review task id remaps are reported",
  allocated.remapped.some((item) => item.from === "T3" && item.to === "T9") &&
    allocated.remapped.some((item) => item.from === "T7" && item.to === "T10"),
  allocated.remapped
);

const resumedCollision = allocateIncrementalTaskIds(
  [
    ...existing,
    {
      id: "T13",
      title: "Clean final static verification and browser acceptance",
      instructions: "Verify only.",
      contextFiles: [],
      status: "done",
    },
  ],
  [
    {
      id: "T13",
      title: "Upgrade arena presentation to voxel-style 3D",
      instructions: "Replace the flat paintball graphics with a voxel-style 3D arena.",
      outputPaths: ["src/game.js"],
      dependsOn: ["T13"],
    },
  ]
);
check(
  "resumed review task id collision becomes the next incremental id",
  resumedCollision.tasks[0]?.id === "T14",
  resumedCollision
);
check(
  "dependencies on existing colliding ids stay pointed at the existing task",
  JSON.stringify(resumedCollision.tasks[0]?.dependsOn) === JSON.stringify(["T13"]),
  resumedCollision.tasks[0]
);

const initialPlan = allocateIncrementalTaskIds(
  [],
  [
    { id: "T5", title: "First", instructions: "Do first." },
    { id: "T9", title: "Second", instructions: "Do second.", dependsOn: ["T5"] },
  ]
);
check(
  "initial plan task ids are normalized to T1..Tn",
  JSON.stringify(initialPlan.tasks.map((task) => task.id)) === JSON.stringify(["T1", "T2"]),
  initialPlan
);
check(
  "initial plan dependencies are remapped to normalized ids",
  JSON.stringify(initialPlan.tasks[1]?.dependsOn) === JSON.stringify(["T1"]),
  initialPlan.tasks[1]
);

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
