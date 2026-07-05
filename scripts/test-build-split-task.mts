/** Worker split_task escape-hatch checks (run: npx tsx scripts/test-build-split-task.mts) */
import {
  applyTaskSplit,
  parseWorkerSplitAction,
  type BuildTask,
  type SplitTaskAction,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const MAX_CONTEXT_FILES = 8;

// ---------------------------------------------------------------------------
// Parser: parseWorkerSplitAction
// ---------------------------------------------------------------------------

const wrapInProse = (obj: unknown): string =>
  `Sure, this task is too large for one response. I'll split it.\n\n\`\`\`json\n${JSON.stringify(
    obj,
    null,
    2
  )}\n\`\`\`\n\nThat decomposition keeps each file independent.`;

// Valid 2-subtask action, wrapped in prose + a ```json fence.
{
  const text = wrapInProse({
    action: "split_task",
    reason: "The API layer and the UI layer are independent and each is large.",
    subtasks: [
      {
        title: "API layer",
        instructions: "Implement the API layer fully.",
        outputPaths: ["src/api.ts"],
        dependsOn: [],
        difficulty: 3,
      },
      {
        title: "UI layer",
        instructions: "Implement the UI layer fully.",
        outputPaths: ["src/ui.ts"],
        dependsOn: [],
        difficulty: 2,
      },
    ],
  });
  const parsed = parseWorkerSplitAction(text);
  check("valid 2-subtask action parses from prose + fence", parsed != null, parsed);
  check(
    "parsed action has 2 subtasks and trimmed reason",
    parsed?.subtasks.length === 2 && parsed.reason.startsWith("The API layer"),
    parsed
  );
}

// 1 subtask -> null (too few).
{
  const text = wrapInProse({
    action: "split_task",
    reason: "Only one piece.",
    subtasks: [{ title: "Only", instructions: "Do it.", outputPaths: ["src/a.ts"] }],
  });
  check("1 subtask -> null", parseWorkerSplitAction(text) === null);
}

// 5 subtasks -> null (too many).
{
  const text = wrapInProse({
    action: "split_task",
    reason: "Too many pieces.",
    subtasks: [1, 2, 3, 4, 5].map((n) => ({
      title: `Part ${n}`,
      instructions: "Do it.",
      outputPaths: [`src/p${n}.ts`],
    })),
  });
  check("5 subtasks -> null", parseWorkerSplitAction(text) === null);
}

// Subtask missing outputPaths -> null.
{
  const text = wrapInProse({
    action: "split_task",
    reason: "Missing outputs.",
    subtasks: [
      { title: "A", instructions: "Do it.", outputPaths: ["src/a.ts"] },
      { title: "B", instructions: "Do it." },
    ],
  });
  check("subtask missing outputPaths -> null", parseWorkerSplitAction(text) === null);
}

// difficulty 7 clamps to 5.
{
  const text = wrapInProse({
    action: "split_task",
    reason: "Clamp the difficulty.",
    subtasks: [
      { title: "A", instructions: "Do it.", outputPaths: ["src/a.ts"], difficulty: 7 },
      { title: "B", instructions: "Do it.", outputPaths: ["src/b.ts"], difficulty: 0 },
    ],
  });
  const parsed = parseWorkerSplitAction(text);
  check(
    "difficulty 7 clamps to 5 (and 0 clamps to 1)",
    parsed?.subtasks[0].difficulty === 5 && parsed?.subtasks[1].difficulty === 1,
    parsed?.subtasks.map((s) => s.difficulty)
  );
}

// ---------------------------------------------------------------------------
// applyTaskSplit
// ---------------------------------------------------------------------------

const makeTasks = (): BuildTask[] => [
  {
    id: "T4",
    title: "Earlier task",
    instructions: "...",
    contextFiles: [],
    outputPaths: ["src/z.ts"],
    status: "done",
  },
  {
    id: "T5",
    title: "Big task",
    instructions: "Do a big thing.",
    contextFiles: ["README.md"],
    outputPaths: ["src/a.ts", "src/b.ts"],
    status: "in_progress",
    difficulty: 4,
    workerIndex: 2,
    assignTo: "SomeModel",
  },
  {
    id: "T6",
    title: "Dependent task",
    instructions: "Uses T5 output.",
    contextFiles: [],
    outputPaths: ["src/c-consumer.ts"],
    status: "planned",
    dependsOn: ["T5"],
  },
];

const twoChildSplit = (
  aPaths: string[],
  bPaths: string[],
  extra?: Partial<SplitTaskAction["subtasks"][number]>[]
): SplitTaskAction => ({
  action: "split_task",
  reason: "Split into two independent files.",
  subtasks: [
    { title: "Part A", instructions: "Implement A.", outputPaths: aPaths, ...(extra?.[0] ?? {}) },
    { title: "Part B", instructions: "Implement B.", outputPaths: bPaths, ...(extra?.[1] ?? {}) },
  ],
});

// Happy path: T5 splits into 2 children owning src/a.ts / src/b.ts.
{
  const tasks = makeTasks();
  const parentRef = tasks[1];
  const t6Ref = tasks[2];
  const beforeLen = tasks.length;
  const result = applyTaskSplit(tasks, "T5", twoChildSplit(["src/a.ts"], ["src/b.ts"]), MAX_CONTEXT_FILES);

  check("happy: result ok", result.ok === true, result);
  check("happy: childIds T5.1/T5.2", JSON.stringify(result.childIds) === JSON.stringify(["T5.1", "T5.2"]), result.childIds);
  check("happy: parent SAME object reference", tasks.find((t) => t.id === "T5") === parentRef);
  check("happy: parent status done", parentRef.status === "done", parentRef.status);
  check("happy: parent title suffixed", parentRef.title === "Big task (split into T5.1, T5.2)", parentRef.title);
  check("happy: parent workerIndex/assignTo cleared", parentRef.workerIndex === undefined && parentRef.assignTo === undefined, parentRef);
  check("happy: array grew by 2", tasks.length === beforeLen + 2, tasks.length);

  const parentIdx = tasks.findIndex((t) => t.id === "T5");
  const c1 = tasks[parentIdx + 1];
  const c2 = tasks[parentIdx + 2];
  check("happy: children at parentIdx+1/+2", c1.id === "T5.1" && c2.id === "T5.2", [c1.id, c2.id]);
  check("happy: child1 outputPaths", JSON.stringify(c1.outputPaths) === JSON.stringify(["src/a.ts"]), c1.outputPaths);
  check("happy: child2 outputPaths", JSON.stringify(c2.outputPaths) === JSON.stringify(["src/b.ts"]), c2.outputPaths);
  check("happy: children splitDepth 1", c1.splitDepth === 1 && c2.splitDepth === 1, [c1.splitDepth, c2.splitDepth]);
  check("happy: children status planned", c1.status === "planned" && c2.status === "planned", [c1.status, c2.status]);
  check("happy: children include parent contextFile README.md", c1.contextFiles.includes("README.md") && c2.contextFiles.includes("README.md"), [c1.contextFiles, c2.contextFiles]);
  check("happy: children inherit difficulty 4", c1.difficulty === 4 && c2.difficulty === 4, [c1.difficulty, c2.difficulty]);

  // Dependent rewrite: T6 dependsOn ["T5"] -> ["T5.1","T5.2"], same object.
  check("happy: T6 SAME object reference", tasks.find((t) => t.id === "T6") === t6Ref);
  check("happy: T6 dependsOn rewritten to both child ids", JSON.stringify(t6Ref.dependsOn) === JSON.stringify(["T5.1", "T5.2"]), t6Ref.dependsOn);
}

// Scope violation: a child claims src/c.ts (outside parent's declared files).
{
  const tasks = makeTasks();
  const parentRef = tasks[1];
  const t6Ref = tasks[2];
  const beforeLen = tasks.length;
  const result = applyTaskSplit(tasks, "T5", twoChildSplit(["src/a.ts"], ["src/c.ts"]), MAX_CONTEXT_FILES);
  check("scope: ok false", result.ok === false, result);
  check("scope: reason names src/c.ts", (result.reason ?? "").includes("src/c.ts"), result.reason);
  check("scope: ZERO mutation — parent status still in_progress", parentRef.status === "in_progress", parentRef.status);
  check("scope: ZERO mutation — array length unchanged", tasks.length === beforeLen, tasks.length);
  check("scope: ZERO mutation — parent title unchanged", parentRef.title === "Big task", parentRef.title);
  check("scope: ZERO mutation — T6 dependsOn still [T5]", JSON.stringify(t6Ref.dependsOn) === JSON.stringify(["T5"]), t6Ref.dependsOn);
}

// Sibling overlap: both children claim src/a.ts.
{
  const tasks = makeTasks();
  const parentRef = tasks[1];
  const beforeLen = tasks.length;
  const result = applyTaskSplit(tasks, "T5", twoChildSplit(["src/a.ts"], ["src/a.ts"]), MAX_CONTEXT_FILES);
  check("overlap: ok false", result.ok === false, result);
  check("overlap: reason names src/a.ts", (result.reason ?? "").includes("src/a.ts"), result.reason);
  check("overlap: ZERO mutation — parent status in_progress", parentRef.status === "in_progress", parentRef.status);
  check("overlap: ZERO mutation — array length unchanged", tasks.length === beforeLen, tasks.length);
}

// Parent with splitDepth 1 -> rejected (cannot split again).
{
  const tasks = makeTasks();
  tasks[1].splitDepth = 1;
  const beforeLen = tasks.length;
  const result = applyTaskSplit(tasks, "T5", twoChildSplit(["src/a.ts"], ["src/b.ts"]), MAX_CONTEXT_FILES);
  check("splitDepth1: ok false", result.ok === false, result);
  check("splitDepth1: reason mentions already/split", /split/i.test(result.reason ?? ""), result.reason);
  check("splitDepth1: ZERO mutation — array length unchanged", tasks.length === beforeLen, tasks.length);
  check("splitDepth1: ZERO mutation — parent status in_progress", tasks[1].status === "in_progress", tasks[1].status);
}

// Ordinal dependsOn ["1"] on subtask 2 -> maps to first child id; forward/self refs dropped.
{
  const tasks = makeTasks();
  const split: SplitTaskAction = {
    action: "split_task",
    reason: "Second depends on the first.",
    subtasks: [
      { title: "Part A", instructions: "Implement A.", outputPaths: ["src/a.ts"], dependsOn: ["2"] }, // forward ref -> dropped
      { title: "Part B", instructions: "Implement B.", outputPaths: ["src/b.ts"], dependsOn: ["1", "2"] }, // "1" ok, "2" self -> dropped
    ],
  };
  const result = applyTaskSplit(tasks, "T5", split, MAX_CONTEXT_FILES);
  check("ordinal: ok", result.ok === true, result);
  const parentIdx = tasks.findIndex((t) => t.id === "T5");
  const c1 = tasks[parentIdx + 1];
  const c2 = tasks[parentIdx + 2];
  check("ordinal: child1 has no deps (forward ref dropped)", c1.dependsOn === undefined || c1.dependsOn.length === 0, c1.dependsOn);
  check("ordinal: child2 dependsOn = [first child id]", JSON.stringify(c2.dependsOn) === JSON.stringify(["T5.1"]), c2.dependsOn);
}

// Id collision: a pre-existing "T5.1" task -> suffixed child ids, no duplicate ids.
{
  const tasks = makeTasks();
  tasks.push({
    id: "T5.1",
    title: "Pre-existing collision",
    instructions: "...",
    contextFiles: [],
    outputPaths: ["src/pre.ts"],
    status: "planned",
  });
  const result = applyTaskSplit(tasks, "T5", twoChildSplit(["src/a.ts"], ["src/b.ts"]), MAX_CONTEXT_FILES);
  check("collision: ok", result.ok === true, result);
  check("collision: first child id suffixed to T5.1b", result.childIds?.[0] === "T5.1b", result.childIds);
  check("collision: second child id T5.2", result.childIds?.[1] === "T5.2", result.childIds);
  const ids = tasks.map((t) => t.id);
  check("collision: no duplicate ids in array", new Set(ids).size === ids.length, ids);
}

// Parent with NO outputPaths -> children may claim any non-suspicious paths.
{
  const tasks: BuildTask[] = [
    {
      id: "T5",
      title: "Unbounded task",
      instructions: "Do it.",
      contextFiles: ["README.md"],
      status: "in_progress",
      difficulty: 3,
    },
  ];
  const result = applyTaskSplit(
    tasks,
    "T5",
    twoChildSplit(["lib/anything.ts"], ["lib/other.ts"]),
    MAX_CONTEXT_FILES
  );
  check("no-outputs: ok (any non-suspicious path allowed)", result.ok === true, result);
  const parentIdx = tasks.findIndex((t) => t.id === "T5");
  check(
    "no-outputs: children own their claimed paths",
    JSON.stringify(tasks[parentIdx + 1].outputPaths) === JSON.stringify(["lib/anything.ts"]) &&
      JSON.stringify(tasks[parentIdx + 2].outputPaths) === JSON.stringify(["lib/other.ts"]),
    [tasks[parentIdx + 1].outputPaths, tasks[parentIdx + 2].outputPaths]
  );
}

// Suspicious artifact path is rejected even when parent has no declared outputs.
{
  const tasks: BuildTask[] = [
    {
      id: "T5",
      title: "Unbounded task",
      instructions: "Do it.",
      contextFiles: [],
      status: "in_progress",
    },
  ];
  const result = applyTaskSplit(
    tasks,
    "T5",
    twoChildSplit(["src/a.ts"], ["summary.md"]),
    MAX_CONTEXT_FILES
  );
  check("suspicious: ok false", result.ok === false, result);
  check("suspicious: array unchanged (length 1)", tasks.length === 1, tasks.length);
}

process.exit(failed === 0 ? 0 : 1);
