/** Quick regression check for parseArchitectAction (run: npx tsx scripts/test-parse-action.mts) */
import {
  buildArchitectSpecPrompt,
  buildArchitectPlanPrompt,
  buildArchitectReviewPrompt,
  buildWorkerTaskPrompt,
  buildReviewGateFixInstructions,
  buildOutstandingTasksDigest,
  isArchitectTerminalActionForExpected,
  isBuildTaskDependencySatisfied,
  isReviewResultApproved,
  isBuildToolAction,
  isSafeFirstToolAction,
  outputPathsForTask,
  parseArchitectAction,
} from "../lib/orchestrator/build";

// Reproduction of the real round-4 failure: code blocks BEFORE the json action.
const round4 = [
  "Regarding the files in your project folder: I have authored them.",
  "",
  "```javascript src/calculations.js",
  "export function calculateBMI(weight, height) {",
  "  if (height <= 0) return 0;",
  "  return weight / (height * height);",
  "}",
  "```",
  "",
  "```jsx src/App.jsx",
  "function App() {",
  "  return <div className=\"p-4\">hello</div>;",
  "}",
  "export default App;",
  "```",
  "",
  "```json",
  '{"action":"review","results":[{"taskId":"T1","verdict":"approve"}],"newTasks":[],"done":true,"notes":"ok"}',
  "```",
].join("\n");

const cases: Array<[string, string, (a: ReturnType<typeof parseArchitectAction>) => boolean]> = [
  ["round4: json action after code blocks", round4, (a) => a?.action === "review" && (a as { done: boolean }).done === true],
  ["bare json, no fence", '{"action":"read","paths":["a.ts"]}', (a) => a?.action === "read"],
  ["json with chatty prose around", 'Sure!\n```json\n{"action":"plan","tasks":[{"title":"t","instructions":"i"}]}\n```\nDone.', (a) => a?.action === "plan"],
  [
    "spec action preserves detailed architect-owned requirements",
    '{"action":"spec","spec":{"id":"S1","objective":"Ship a provider settings editor","requirements":["Users can save provider defaults"],"nonGoals":["Do not add server routes"],"acceptanceCriteria":["Defaults persist after reload"],"qualityCriteria":["Reuse the client store boundary"],"verification":["npm run lint"],"constraints":["Fully client-side"]},"notes":"Use existing settings APIs.","verifyCommand":"npm run lint"}',
    (a) =>
      a?.action === "spec" &&
      (a as { spec?: { requirements?: string[]; nonGoals?: string[] } }).spec?.requirements?.[0] ===
        "Users can save provider defaults" &&
      (a as { spec?: { nonGoals?: string[] } }).spec?.nonGoals?.[0] === "Do not add server routes" &&
      (a as { verifyCommand?: string }).verifyCommand === "npm run lint",
  ],
  [
    "build_plan action preserves implementation contracts for workers",
    '{"action":"build_plan","spec":{"id":"S1","objective":"Ship review gates","requirements":["Parse the new plan protocol"],"acceptanceCriteria":["Workers receive architect-owned contracts"],"qualityCriteria":["Parser remains backward-compatible"],"verification":["npx tsx scripts/test-parse-action.mts"]},"phaseSpec":{"id":"P1","objective":"Wire build planning","acceptanceCriteria":["Task contracts are visible"],"qualityCriteria":["No hidden worker design decisions"],"verification":["npx tsx scripts/test-parse-action.mts"]},"implementationPlan":"Use a separate spec step, then emit worker tasks with contracts.","tasks":[{"id":"T1","title":"Parser","instructions":"Update parser","implementationContract":"Add SpecAction and BuildPlanAction without removing legacy plan support.","contextFiles":["lib/orchestrator/build.ts"],"outputPaths":["lib/orchestrator/build.ts"],"difficulty":3}],"notes":"Keep legacy plan parsing."}',
    (a) =>
      a?.action === "build_plan" &&
      (a as { implementationPlan?: string }).implementationPlan?.includes("separate spec step") === true &&
      (a as { tasks: Array<{ implementationContract?: string }> }).tasks[0]?.implementationContract ===
        "Add SpecAction and BuildPlanAction without removing legacy plan support.",
  ],
  [
    "review action preserves new-task implementation contracts",
    '{"action":"review","results":[],"newTasks":[{"id":"T9","title":"Follow-up","instructions":"Wire the saved settings","implementationContract":"Use the existing settings API and do not add routes.","contextFiles":["lib/client/settings-api.ts"],"outputPaths":["app/settings/page.tsx"],"difficulty":2}],"done":false}',
    (a) =>
      a?.action === "review" &&
      (a as { newTasks?: Array<{ implementationContract?: string }> }).newTasks?.[0]
        ?.implementationContract === "Use the existing settings API and do not add routes.",
  ],
  ["unlabelled fence", '```\n{"action":"run","command":"npm test"}\n```', (a) => a?.action === "run"],
  ["shell alias parses as run", '{"action":"shell","command":"npm test"}', (a) => a?.action === "run" && (a as { command: string }).command === "npm test"],
  ["shell cmd alias parses as run", '{"action":"shell","cmd":"node -e \\"console.log(1)\\""}', (a) => a?.action === "run" && (a as { command: string }).command.includes("console.log")],
  ["read_file alias parses as read", '{"action":"read_file","path":"src/game.js"}', (a) => a?.action === "read" && (a as { paths: string[] }).paths[0] === "src/game.js"],
  ["read action normalizes single path string", '{"action":"read","paths":"README.md"}', (a) => a?.action === "read" && (a as { paths: string[] }).paths[0] === "README.md"],
  ["last block wins over earlier braces", 'first {not json}\n```json\n{"action":"review","results":[],"done":false}\n```', (a) => a?.action === "review"],
  [
    "plan action preserves current phase spec",
    '{"action":"plan","phaseSpec":{"id":"P1","objective":"Ship review gates","acceptanceCriteria":["Both gates are parsed"],"qualityCriteria":["Legacy verdicts still work"],"verification":["npm run lint"]},"tasks":[{"id":"T1","title":"Parser","instructions":"Update parser"}]}',
    (a) =>
      a?.action === "plan" &&
      (a as { phaseSpec?: { acceptanceCriteria?: string[] } }).phaseSpec?.acceptanceCriteria?.[0] ===
        "Both gates are parsed",
  ],
  [
    "review action preserves explicit spec and quality gates",
    '{"action":"review","results":[{"taskId":"T1","specVerdict":"approve","qualityVerdict":"fix","qualityIssues":"Missing test","fixInstructions":"Add parser test"}],"done":false}',
    (a) =>
      a?.action === "review" &&
      (a as { results: Array<{ specVerdict?: string; qualityVerdict?: string; qualityIssues?: string }> }).results[0]
        ?.specVerdict === "approve" &&
      (a as { results: Array<{ specVerdict?: string; qualityVerdict?: string; qualityIssues?: string }> }).results[0]
        ?.qualityVerdict === "fix" &&
      (a as { results: Array<{ specVerdict?: string; qualityVerdict?: string; qualityIssues?: string }> }).results[0]
        ?.qualityIssues === "Missing test",
  ],
  [
    "review action preserves replacement verifyCommand",
    '{"action":"review","results":[{"taskId":"T1","specVerdict":"fix","qualityVerdict":"approve","specIssues":"Wrong verifier"}],"verifyCommand":"node --check src/main.js","done":false}',
    (a) =>
      a?.action === "review" &&
      (a as { verifyCommand?: string }).verifyCommand === "node --check src/main.js",
  ],
  [
    "review action preserves request fulfillment evidence",
    '{"action":"review","results":[{"taskId":"T1","specVerdict":"approve","qualityVerdict":"approve"}],"requestFulfillment":{"reviewed":true,"satisfied":true,"summary":"Request satisfied","evidence":["src/index.ts","npm test"],"gaps":[]},"done":true}',
    (a) =>
      a?.action === "review" &&
      (a as { requestFulfillment?: { reviewed?: boolean; satisfied?: boolean; evidence?: string[] } })
        .requestFulfillment?.reviewed === true &&
      (a as { requestFulfillment?: { reviewed?: boolean; satisfied?: boolean; evidence?: string[] } })
        .requestFulfillment?.satisfied === true &&
      (a as { requestFulfillment?: { reviewed?: boolean; satisfied?: boolean; evidence?: string[] } })
        .requestFulfillment?.evidence?.includes("npm test") === true,
  ],
  [
    "legacy approve review maps to both gates approved",
    '{"action":"review","results":[{"taskId":"T1","verdict":"approve"}],"done":true}',
    (a) =>
      a?.action === "review" &&
      (a as { results: Array<{ specVerdict?: string; qualityVerdict?: string }> }).results[0]?.specVerdict ===
        "approve" &&
      (a as { results: Array<{ specVerdict?: string; qualityVerdict?: string }> }).results[0]?.qualityVerdict ===
        "approve",
  ],
  [
    "legacy fix review preserves explicit approved spec gate and maps missing quality gate to fix",
    '{"action":"review","results":[{"taskId":"T1","verdict":"fix","specVerdict":"approve","qualityIssues":"Needs cleanup"}],"done":false}',
    (a) =>
      a?.action === "review" &&
      (a as { results: Array<{ specVerdict?: string; qualityVerdict?: string; qualityIssues?: string }> }).results[0]
        ?.specVerdict === "approve" &&
      (a as { results: Array<{ specVerdict?: string; qualityVerdict?: string; qualityIssues?: string }> }).results[0]
        ?.qualityVerdict === "fix" &&
      (a as { results: Array<{ specVerdict?: string; qualityVerdict?: string; qualityIssues?: string }> }).results[0]
        ?.qualityIssues === "Needs cleanup",
  ],
  [
    "read_range action",
    '{"action":"read_range","path":"src/index.ts","startLine":25,"lineCount":40}',
    (a) =>
      a?.action === "read_range" &&
      (a as { path: string }).path === "src/index.ts" &&
      (a as { startLine: number }).startLine === 25 &&
      (a as { lineCount: number }).lineCount === 40,
  ],
  [
    "patch action",
    '{"action":"patch","path":"src/index.ts","ops":[{"search":"old","replace":"new"}],"reason":"targeted edit"}',
    (a) =>
      a?.action === "patch" &&
      (a as { path: string }).path === "src/index.ts" &&
      (a as { ops: Array<{ search: string; replace: string }> }).ops.length === 1,
  ],
  [
    "edit alias parses as patch",
    '{"action":"edit","path":"src/index.ts","ops":[{"search":"old","replace":"new"}]}',
    (a) =>
      a?.action === "patch" &&
      (a as { path: string }).path === "src/index.ts" &&
      (a as { ops: Array<{ search: string; replace: string }> }).ops.length === 1,
  ],
  [
    "append action",
    '{"action":"append","path":"tests/run-tests.ts","content":"first chunk","reset":true,"reason":"create large file safely"}',
    (a) =>
      a?.action === "append" &&
      (a as { path: string }).path === "tests/run-tests.ts" &&
      (a as { content: string }).content === "first chunk" &&
      (a as { reset: boolean }).reset === true,
  ],
  [
    "worker guidance_request parses blocking mode",
    '{"action":"guidance_request","mode":"blocking","question":"Should I reuse the settings store?","reason":"The task touches provider defaults."}',
    (a) =>
      a?.action === "guidance_request" &&
      (a as { mode?: string }).mode === "blocking" &&
      (a as { question?: string }).question === "Should I reuse the settings store?" &&
      (a as { reason?: string }).reason === "The task touches provider defaults.",
  ],
  [
    "worker guidance_request defaults missing mode to blocking",
    '{"action":"guidance_request","question":"Which existing helper should I use?"}',
    (a) =>
      a?.action === "guidance_request" &&
      (a as { mode?: string }).mode === "blocking",
  ],
  [
    "worker guidance_request rejects empty question",
    '{"action":"guidance_request","mode":"async","question":"   "}',
    (a) => a === null,
  ],
  [
    "architect guidance_answer parses advisory answer",
    '{"action":"guidance_answer","guidanceId":"G-T4-1","taskId":"T4","answer":"Reuse the settings store and keep changes scoped."}',
    (a) =>
      a?.action === "guidance_answer" &&
      (a as { guidanceId?: string }).guidanceId === "G-T4-1" &&
      (a as { taskId?: string }).taskId === "T4" &&
      (a as { answer?: string }).answer === "Reuse the settings store and keep changes scoped.",
  ],
  [
    "architect guidance_answer parses optional promoted build memory",
    '{"action":"guidance_answer","guidanceId":"G-T4-1","taskId":"T4","answer":"Reuse the settings store.","memory":"Across this build, reuse the settings store for provider defaults."}',
    (a) =>
      a?.action === "guidance_answer" &&
      (a as { memory?: string }).memory ===
        "Across this build, reuse the settings store for provider defaults.",
  ],
  [
    "architect guidance_answer rejects empty answer",
    '{"action":"guidance_answer","guidanceId":"G-T4-1","taskId":"T4","answer":"   "}',
    (a) => a === null,
  ],
  [
    "skill_request action",
    '{"action":"skill_request","ids":["agent:security-and-hardening"],"reason":"runner path validation","target":"reviewer","mode":"compact"}',
    (a) =>
      a?.action === "skill_request" &&
      (a as { ids: string[] }).ids[0] === "agent:security-and-hardening" &&
      (a as { target?: string }).target === "reviewer" &&
      isBuildToolAction(a),
  ],
  [
    "code_intel search_symbols action",
    '{"action":"code_intel","op":"search_symbols","query":"BuildContextManager","limit":99,"reason":"find definitions"}',
    (a) =>
      a?.action === "code_intel" &&
      (a as { op: string }).op === "search_symbols" &&
      (a as { query?: string }).query === "BuildContextManager" &&
      (a as { limit?: number }).limit === 10 &&
      isBuildToolAction(a),
  ],
  [
    "code_intel rejects unknown op",
    '{"action":"code_intel","op":"index_repository","query":"x"}',
    (a) => a === null,
  ],
  [
    "skill_request rejects empty ids",
    '{"action":"skill_request","ids":[],"reason":"nothing"}',
    (a) => a === null,
  ],
  [
    "skill_request rejects unknown target",
    '{"action":"skill_request","ids":["agent:security-and-hardening"],"reason":"bad","target":"worker"}',
    (a) => a === null,
  ],
  [
    "repo_status action",
    '{"action":"repo_status","reason":"check branch"}',
    (a) => a?.action === "repo_status",
  ],
  [
    "repo_init action",
    '{"action":"repo_init","branch":"main","reason":"create a local git repo"}',
    (a) =>
      a?.action === "repo_init" &&
      (a as { branch?: string }).branch === "main" &&
      isBuildToolAction(a),
  ],
  [
    "repo_init rejects malformed branch",
    '{"action":"repo_init","branch":"bad branch"}',
    (a) => a === null,
  ],
  [
    "repo_diff action with options",
    '{"action":"repo_diff","paths":["src/a.ts"],"staged":true,"stat":true,"reason":"see staged changes"}',
    (a) =>
      a?.action === "repo_diff" &&
      Array.isArray((a as { paths?: string[] }).paths) &&
      (a as { paths: string[] }).paths[0] === "src/a.ts" &&
      (a as { staged: boolean }).staged === true &&
      (a as { stat: boolean }).stat === true,
  ],
  [
    "repo_diff action with no options",
    '{"action":"repo_diff"}',
    (a) => a?.action === "repo_diff",
  ],
  [
    "repo_branch_create action",
    '{"action":"repo_branch_create","name":"feature/issue-42","base":"main","checkout":false,"reason":"work on issue 42"}',
    (a) =>
      a?.action === "repo_branch_create" &&
      (a as { name: string }).name === "feature/issue-42" &&
      (a as { base?: string }).base === "main" &&
      (a as { checkout?: boolean }).checkout === false,
  ],
  [
    "repo_branch_create minimal (name only)",
    '{"action":"repo_branch_create","name":"fix-1"}',
    (a) => a?.action === "repo_branch_create" && (a as { name: string }).name === "fix-1",
  ],
  [
    "repo_branch_create rejects leading-dash name",
    '{"action":"repo_branch_create","name":"-evil"}',
    (a) => a === null,
  ],
  [
    "repo_branch_create rejects '..' in name",
    '{"action":"repo_branch_create","name":"a..b"}',
    (a) => a === null,
  ],
  [
    "repo_branch_create rejects whitespace in name",
    '{"action":"repo_branch_create","name":"foo bar"}',
    (a) => a === null,
  ],
  [
    "repo_branch_create rejects trailing slash",
    '{"action":"repo_branch_create","name":"a/"}',
    (a) => a === null,
  ],
  [
    "repo_branch_create rejects backslash in name",
    '{"action":"repo_branch_create","name":"a\\\\b"}',
    (a) => a === null,
  ],
  [
    "repo_branch_create rejects malformed base",
    '{"action":"repo_branch_create","name":"ok","base":"-bad"}',
    (a) => a === null,
  ],
  [
    "repo_commit action with paths",
    '{"action":"repo_commit","message":"feat: add X","paths":["src/a.ts"],"reason":"land work"}',
    (a) =>
      a?.action === "repo_commit" &&
      (a as { message: string }).message === "feat: add X" &&
      Array.isArray((a as { paths?: string[] }).paths) &&
      (a as { paths: string[] }).paths[0] === "src/a.ts",
  ],
  [
    "repo_commit action minimal (message only) trims message",
    '{"action":"repo_commit","message":"  fix: trim me  "}',
    (a) =>
      a?.action === "repo_commit" &&
      (a as { message: string }).message === "fix: trim me" &&
      (a as { paths?: string[] }).paths === undefined,
  ],
  [
    "repo_commit rejects empty message",
    '{"action":"repo_commit","message":"   "}',
    (a) => a === null,
  ],
  [
    "repo_commit rejects missing message",
    '{"action":"repo_commit","reason":"oops"}',
    (a) => a === null,
  ],
  [
    "repo_commit rejects >200-char message",
    `{"action":"repo_commit","message":"${"x".repeat(201)}"}`,
    (a) => a === null,
  ],
  ["nothing parseable", "just prose with { braces } that aren't json", (a) => a === null],
];

let failed = 0;
for (const [name, input, check] of cases) {
  const result = parseArchitectAction(input);
  const ok = check(result);
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` → got ${JSON.stringify(result)}`}`);
  if (!ok) failed++;
}

const reviewGateChecks: Array<[string, boolean]> = [
  [
    "terminal matcher accepts exact spec action",
    isArchitectTerminalActionForExpected(
      parseArchitectAction(
        '{"action":"spec","spec":{"objective":"x","requirements":["r"],"acceptanceCriteria":["a"],"qualityCriteria":["q"],"verification":["v"]}}'
      ),
      "spec"
    ),
  ],
  [
    "terminal matcher accepts legacy plan as build_plan fallback",
    isArchitectTerminalActionForExpected(
      parseArchitectAction('{"action":"plan","tasks":[{"title":"t","instructions":"i"}]}'),
      "build_plan"
    ),
  ],
  [
    "terminal matcher does not accept legacy plan for spec",
    !isArchitectTerminalActionForExpected(
      parseArchitectAction('{"action":"plan","tasks":[{"title":"t","instructions":"i"}]}'),
      "spec"
    ),
  ],
  [
    "review gate helper approves only when both gates approve",
    isReviewResultApproved({
      taskId: "T1",
      specVerdict: "approve",
      qualityVerdict: "approve",
    }),
  ],
  [
    "review gate helper rejects spec failures",
    !isReviewResultApproved({
      taskId: "T1",
      specVerdict: "fix",
      qualityVerdict: "approve",
    }),
  ],
  [
    "review gate helper rejects quality failures",
    !isReviewResultApproved({
      taskId: "T1",
      specVerdict: "approve",
      qualityVerdict: "fix",
    }),
  ],
  [
    "review gate fix instructions label spec and quality issues",
    buildReviewGateFixInstructions({
      taskId: "T1",
      specVerdict: "fix",
      qualityVerdict: "fix",
      specIssues: "Missing setting",
      qualityIssues: "No test",
      fixInstructions: "Update files",
    }).includes("Spec-compliance issues: Missing setting") &&
      buildReviewGateFixInstructions({
        taskId: "T1",
        specVerdict: "fix",
        qualityVerdict: "fix",
        specIssues: "Missing setting",
        qualityIssues: "No test",
        fixInstructions: "Update files",
      }).includes("Code-quality issues: No test") &&
      buildReviewGateFixInstructions({
        taskId: "T1",
        specVerdict: "fix",
        qualityVerdict: "fix",
        specIssues: "Missing setting",
        qualityIssues: "No test",
        fixInstructions: "Update files",
      }).includes("Fix instructions: Update files"),
  ],
];

for (const [name, ok] of reviewGateChecks) {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}`);
  if (!ok) failed++;
}

const pathCases: Array<[string, Parameters<typeof outputPathsForTask>[0], string[]]> = [
  [
    "explicit outputPaths are normalized",
    {
      outputPaths: ["src\\cli.ts", "./tests/run-tests.ts", "/README.md"],
      expectedOutputs: "ignored.md",
    },
    ["src/cli.ts", "tests/run-tests.ts", "README.md"],
  ],
  [
    "expectedOutputs fallback extracts comma/newline paths",
    {
      expectedOutputs:
        "Create src/cli.ts, update `src/query.ts`, and tests/run-tests.ts\nNo path here",
    },
    ["src/cli.ts", "src/query.ts", "tests/run-tests.ts"],
  ],
  [
    "duplicate paths collapse case-insensitively",
    {
      outputPaths: ["SRC/CLI.ts", "src/cli.ts", "src/render.ts"],
    },
    ["SRC/CLI.ts", "src/render.ts"],
  ],
  [
    "explicit outputPaths accept extensionless project files",
    {
      outputPaths: ["Makefile", "Dockerfile", "scripts/build"],
    },
    ["Makefile", "Dockerfile", "scripts/build"],
  ],
];

for (const [name, task, expected] of pathCases) {
  const result = outputPathsForTask(task);
  const ok = JSON.stringify(result) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` → got ${JSON.stringify(result)}`}`);
  if (!ok) failed++;
}

const dependencyCases: Array<
  [string, Parameters<typeof isBuildTaskDependencySatisfied>[0], boolean]
> = [
  ["missing dependency id does not deadlock", null, true],
  ["done dependency is satisfied", { status: "done" }, true],
  ["review dependency waits for Architect verdict", { status: "review" }, false],
  ["failed dependency blocks dependent task", { status: "failed" }, false],
  ["fixing dependency blocks dependent task", { status: "fixing" }, false],
];

for (const [name, dep, expected] of dependencyCases) {
  const result = isBuildTaskDependencySatisfied(dep);
  const ok = result === expected;
  console.log(`${ok ? "PASS" : "FAIL"} â€” ${name}${ok ? "" : ` â†’ got ${result}`}`);
  if (!ok) failed++;
}

const outstandingDigest = buildOutstandingTasksDigest([
  {
    id: "T1",
    title: "Already done",
    instructions: "",
    contextFiles: [],
    status: "done",
  },
  {
    id: "T2",
    title: "Shotgun wiring",
    instructions: "",
    contextFiles: [],
    status: "failed",
    failCount: 3,
    dependsOn: ["T1"],
  },
  {
    id: "T3",
    title: "Weapon help",
    instructions: "",
    contextFiles: [],
    status: "planned",
    dependsOn: ["T2"],
  },
]);

const outstandingChecks: Array<[string, boolean]> = [
  [
    "outstanding digest lists failed task",
    outstandingDigest.includes("T2 (failed") &&
      outstandingDigest.includes("Shotgun wiring"),
  ],
  ["outstanding digest omits done task", !outstandingDigest.includes("Already done")],
  ["outstanding digest includes blocked dependency", outstandingDigest.includes("blocked by: T2")],
];

const reviewPrompt = buildArchitectReviewPrompt({
  request: "build game",
  treeText: "src/game.js",
  executedText: "No worker output landed in this wave.",
  maxNewTasks: 3,
  cyclesLeft: 1,
  outstandingTasks: outstandingDigest,
});
outstandingChecks.push(
  [
    "review prompt includes outstanding tasks",
    reviewPrompt.includes("Required tasks still not done") &&
      reviewPrompt.includes("T2 (failed"),
  ],
  [
    "review prompt forbids done with unfinished tasks",
    reviewPrompt.includes('Do NOT set "done": true'),
  ]
);

for (const [name, ok] of outstandingChecks) {
  console.log(`${ok ? "PASS" : "FAIL"} â€” ${name}`);
  if (!ok) failed++;
}

// ── Typed repo actions: safe-first classification (NRW-004) ─────────────────
const safeFirstChecks: Array<[string, boolean]> = [
  [
    "repo_status is a safe-first inspection action",
    isSafeFirstToolAction({ action: "repo_status" }),
  ],
  [
    "repo_diff is a safe-first inspection action",
    isSafeFirstToolAction({ action: "repo_diff" }),
  ],
  [
    "repo_branch_create is NOT safe-first (it mutates)",
    !isSafeFirstToolAction({ action: "repo_branch_create", name: "feature/x" }),
  ],
  [
    "repo_commit is NOT safe-first (it mutates)",
    !isSafeFirstToolAction({ action: "repo_commit", message: "feat: x" }),
  ],
];

for (const [name, ok] of safeFirstChecks) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}`);
  if (!ok) failed++;
}

// ── Typed repo actions: prompt doc gating (NRW-004) ─────────────────────────
// Phase spec protocol prompt coverage.
const parsedPhaseSpec = {
  id: "P1",
  objective: "Ship phase review gates",
  acceptanceCriteria: ["Both review gates are enforced"],
  qualityCriteria: ["Review parsing stays backward-compatible"],
  verification: ["npx tsx scripts/test-parse-action.mts"],
};
const parsedTaskWithPhaseSpec = {
  id: "T1",
  title: "Wire review gates",
  instructions: "Update Build mode review handling.",
  implementationContract:
    "Preserve legacy plan parsing, add spec/build_plan parsing, and pass the contract to workers.",
  contextFiles: [],
  outputPaths: ["lib/orchestrator/build.ts"],
  status: "planned" as const,
  phaseSpec: parsedPhaseSpec,
};
const specPlanPrompt = buildArchitectSpecPrompt({
  request: "build review gates",
  treeText: "lib/orchestrator/build.ts",
  fileContext: "",
  workerNames: ["W1"],
  readHopsLeft: 0,
});
const phasePlanPrompt = buildArchitectPlanPrompt({
  request: "build review gates",
  treeText: "lib/orchestrator/build.ts",
  fileContext: "",
  maxTasks: 3,
  workerNames: ["W1"],
  readHopsLeft: 0,
  spec: {
    id: "S1",
    objective: "Ship phase review gates",
    requirements: ["Workers receive architect-owned implementation contracts"],
    acceptanceCriteria: ["Both review gates are enforced"],
    qualityCriteria: ["Review parsing stays backward-compatible"],
    verification: ["npx tsx scripts/test-parse-action.mts"],
  },
});
const phaseWorkerPrompt = buildWorkerTaskPrompt({
  request: "build review gates",
  treeText: "lib/orchestrator/build.ts",
  task: parsedTaskWithPhaseSpec,
  contextFileText: "",
  architectNotes: "",
});
const phaseReviewPrompt = buildArchitectReviewPrompt({
  request: "build review gates",
  treeText: "lib/orchestrator/build.ts",
  executedText: "T1 changed lib/orchestrator/build.ts",
  maxNewTasks: 3,
  cyclesLeft: 1,
  spec: {
    id: "S1",
    objective: "Ship phase review gates",
    requirements: ["Workers receive architect-owned implementation contracts"],
    acceptanceCriteria: ["Both review gates are enforced"],
    qualityCriteria: ["Review parsing stays backward-compatible"],
    verification: ["npx tsx scripts/test-parse-action.mts"],
    implementationDecisions: ["Keep implementation contracts visible during review"],
  },
  phaseSpec: parsedPhaseSpec,
} as Parameters<typeof buildArchitectReviewPrompt>[0] & {
  phaseSpec: typeof parsedPhaseSpec;
});

const phasePromptChecks: Array<[string, boolean]> = [
  [
    "spec prompt requires detailed spec without worker tasks",
    specPlanPrompt.includes('"action":"spec"') &&
      specPlanPrompt.includes("requirements") &&
      specPlanPrompt.includes("nonGoals") &&
      !specPlanPrompt.includes('"tasks"'),
  ],
  [
    "build plan prompt requires build_plan tasks and implementation contracts",
    phasePlanPrompt.includes('"action":"build_plan"') &&
      phasePlanPrompt.includes('"phaseSpec"') &&
      phasePlanPrompt.includes("implementationContract"),
  ],
  [
    "worker prompt includes current phase spec",
    phaseWorkerPrompt.includes("Current phase spec") &&
      phaseWorkerPrompt.includes("Both review gates are enforced"),
  ],
  [
    "worker prompt includes architect implementation contract",
    phaseWorkerPrompt.includes("Implementation contract from Architect") &&
      phaseWorkerPrompt.includes("Preserve legacy plan parsing"),
  ],
  [
    "review prompt requests spec verdict",
    phaseReviewPrompt.includes("specVerdict"),
  ],
  [
    "review prompt requests quality verdict",
    phaseReviewPrompt.includes("qualityVerdict"),
  ],
  [
    "review prompt treats implementation contracts as review evidence",
    phaseReviewPrompt.includes("implementation contract") ||
      phaseReviewPrompt.includes("implementationContract"),
  ],
  [
    "review prompt includes Architect spec",
    phaseReviewPrompt.includes("Architect spec") &&
      phaseReviewPrompt.includes("Keep implementation contracts visible during review"),
  ],
  [
    "review prompt requires new-task implementation contracts",
    /"newTasks":\[\{[^\n]+implementationContract/.test(phaseReviewPrompt) &&
      phaseReviewPrompt.includes("Every new task must include an implementationContract"),
  ],
];

for (const [name, ok] of phasePromptChecks) {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}`);
  if (!ok) failed++;
}

const repoPlanPrompt = buildArchitectPlanPrompt({
  request: "fix a bug",
  treeText: "src/index.ts",
  fileContext: "",
  maxTasks: 3,
  workerNames: ["W1"],
  readHopsLeft: 2,
  repoWorkflow: true,
});
const noRepoPlanPrompt = buildArchitectPlanPrompt({
  request: "fix a bug",
  treeText: "src/index.ts",
  fileContext: "",
  maxTasks: 3,
  workerNames: ["W1"],
  readHopsLeft: 2,
});
const repoReviewPrompt = buildArchitectReviewPrompt({
  request: "fix a bug",
  treeText: "src/index.ts",
  executedText: "",
  maxNewTasks: 3,
  cyclesLeft: 1,
  repoWorkflow: true,
});

const repoDocChecks: Array<[string, boolean]> = [
  [
    "plan prompt documents repo_status when repoWorkflow is on",
    repoPlanPrompt.includes('"action":"repo_status"'),
  ],
  [
    "plan prompt documents repo_init when repoWorkflow is on",
    repoPlanPrompt.includes('"action":"repo_init"') &&
      /create a local Git repo/i.test(repoPlanPrompt),
  ],
  [
    "plan prompt documents repo_branch_create when repoWorkflow is on",
    repoPlanPrompt.includes('"action":"repo_branch_create"'),
  ],
  [
    "plan prompt documents repo_commit when repoWorkflow is on",
    repoPlanPrompt.includes('"action":"repo_commit"'),
  ],
  [
    "repo_commit doc warns against raw git commit",
    /git commit/i.test(repoPlanPrompt) && repoPlanPrompt.includes('"action":"repo_commit"'),
  ],
  [
    "repo doc states exactly one JSON action per turn",
    /one JSON action per turn/i.test(repoPlanPrompt),
  ],
  [
    "repo doc states branch creation needs user approval",
    /approval/i.test(repoPlanPrompt) && repoPlanPrompt.includes("repo_branch_create"),
  ],
  [
    "plan prompt omits repo actions when repoWorkflow is off",
    !noRepoPlanPrompt.includes('"action":"repo_status"'),
  ],
  [
    "review prompt documents repo actions when repoWorkflow is on",
    repoReviewPrompt.includes('"action":"repo_status"') &&
      repoReviewPrompt.includes('"action":"repo_diff"'),
  ],
];

for (const [name, ok] of repoDocChecks) {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}`);
  if (!ok) failed++;
}

process.exit(failed === 0 ? 0 : 1);
