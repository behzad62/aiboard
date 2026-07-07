/** Build prompt regression checks (run: npx tsx scripts/test-build-prompts.mts) */
import {
  buildArchitectGuidancePrompt,
  buildWorkerToolInstructions,
  buildWorkerTaskPrompt,
  buildArchitectReviewPrompt,
  extractLocalServerUrls,
  isWorkerBuildToolAction,
  scoreboardSection,
  type BuildTask,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` → ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const fixingTask: BuildTask = {
  id: "T3",
  title: "Final verification and fix strict/test failures",
  instructions:
    "Fix tests/run-tests.ts and src/query.ts. Do not modify unrelated files.",
  contextFiles: ["tests/run-tests.ts", "src/query.ts"],
  outputPaths: ["tests/run-tests.ts", "src/query.ts"],
  expectedOutputs: "targeted fixes to tests/run-tests.ts and src/query.ts",
  guidance: [
    {
      id: "G-T3-1",
      taskId: "T3",
      mode: "blocking",
      question: "Should I rewrite the query parser or patch the strict failure?",
      reason: "The task is scoped to two files.",
      status: "answered",
      answer: "Patch the strict failure only. Do not rewrite the parser.",
      requestedBy: "Worker A",
      requestedAtWave: 1,
      answeredAtWave: 1,
    },
    {
      id: "G-T3-2",
      taskId: "T3",
      mode: "async",
      question: "Should docs be updated too?",
      status: "pending",
      requestedAtWave: 1,
    },
  ],
  status: "fixing",
};
const answeredGuidance = fixingTask.guidance?.[0];
if (!answeredGuidance) {
  throw new Error("Expected fixingTask to include answered guidance");
}

const prompt = buildWorkerTaskPrompt({
  request: "Build a strict TypeScript CSV library and CLI.",
  treeText: "tests/run-tests.ts\nsrc/query.ts",
  task: fixingTask,
  contextFileText: "\nContext files:\n--- tests/run-tests.ts ---\n<large file>",
  architectNotes: "Use strict TypeScript.",
  toolInstructions: [
    'FILE TOOLS — use {"action":"read_range"}, {"action":"patch"}, and {"action":"append"} before final output. Do not emit full-file blocks for existing files.',
    "If a returned range is partial, continue from endLine + 1 instead of rereading overlapping lines.",
    "After search results, read_range around the returned path:line matches, not from the start of the file.",
  ].join(" "),
  verbosityInstruction: "Keep prose brief.",
});

check("fix prompt includes range-read guidance", prompt.includes('"action":"read_range"'));
check("fix prompt includes patch guidance", prompt.includes('"action":"patch"'));
check("fix prompt includes append guidance for large/missing files", prompt.includes('"action":"append"'));
check("fix prompt tells workers to continue partial ranges", /endLine \+ 1/i.test(prompt), prompt);
check("fix prompt tells workers to read around search matches", /path:line matches/i.test(prompt), prompt);
check(
  "fix prompt allows scheduled JSON tool actions",
  /one or more JSON tool actions/i.test(prompt),
  prompt
);
check(
  "fix prompt forbids full existing-file rewrites",
  /do not emit full-file blocks for existing files/i.test(prompt),
  prompt
);
check(
  "fix prompt no longer says re-emit complete corrected files",
  !/Re-emit the complete corrected files/i.test(prompt),
  prompt
);
check(
  "fix prompt no longer has unconditional complete-contents rule",
  !/give the COMPLETE contents of every file you write/i.test(prompt),
  prompt
);
check(
  "worker prompt warns against undeclared test tooling",
  /do not add or import a new test framework/i.test(prompt) &&
    /MCP browser tools/i.test(prompt),
  prompt
);
check(
  "worker prompt requires browser acceptance for web apps",
  /browser acceptance/i.test(prompt) &&
    /visible stuck loading/i.test(prompt) &&
    /console errors/i.test(prompt),
  prompt
);
const browserEvidenceFields = [
  "canvasPresent",
  "webglContext",
  "labelCount",
  "screenshotTaken",
  "visualQualityReviewed",
  "visibleOutputMatchesRequest",
  "requestedVisualCriteriaMet",
  "pixelChangedAfterRun",
  "startPauseWorked",
  "resetWorked",
  "newArenaChanged",
  "speedChanged",
  "ammoApplied",
  "consoleErrors",
];
check(
  "worker prompt gives a structured browser acceptance evidence schema",
  browserEvidenceFields.every((field) => prompt.includes(field)),
  prompt
);
check(
  "worker prompt includes answered Architect guidance section",
  prompt.includes("ARCHITECT GUIDANCE FOR THIS TASK") &&
    prompt.includes("Guidance G-T3-1") &&
    prompt.includes("Worker question:") &&
    prompt.includes("Should I rewrite the query parser or patch the strict failure?") &&
    prompt.includes("Architect answer:") &&
    prompt.includes("Patch the strict failure only. Do not rewrite the parser."),
  prompt
);
check(
  "worker prompt treats visual matching as conditional browser evidence",
  /visibleOutputMatchesRequest/i.test(prompt) &&
    /requestedVisualCriteriaMet/i.test(prompt) &&
    /visual, layout, media, animation, or interactive output/i.test(prompt),
  prompt
);
check(
  "worker prompt separates pending Architect guidance requests",
  prompt.includes("PENDING GUIDANCE REQUESTS") &&
    prompt.includes("Guidance G-T3-2 is still waiting for Architect response") &&
    prompt.includes("Continue only if the task is safe without it."),
  prompt
);

const architectGuidancePrompt = buildArchitectGuidancePrompt({
  request: "Build a strict TypeScript CSV library and CLI.",
  treeText: "tests/run-tests.ts\nsrc/query.ts",
  task: fixingTask,
  architectNotes: "Use strict TypeScript.",
  guidance: answeredGuidance,
});

check(
  "Architect guidance prompt asks for advisory task-scoped answer",
  architectGuidancePrompt.includes("Answer the worker's exact question") &&
    architectGuidancePrompt.includes("Do not change outputPaths") &&
    architectGuidancePrompt.includes("Guidance G-T3-1") &&
    architectGuidancePrompt.includes("Should I rewrite the query parser or patch the strict failure?") &&
    architectGuidancePrompt.includes('"action":"guidance_answer"'),
  architectGuidancePrompt
);
check(
  "Architect guidance prompt allows promoted build memory",
  architectGuidancePrompt.includes('"memory":"optional convention') &&
    architectGuidancePrompt.includes("affects conventions across the build"),
  architectGuidancePrompt
);

const skillEvidencePrompt = buildWorkerTaskPrompt({
  request: "Fix a failing web app test.",
  treeText: "server/app.js\ntests/app.test.js",
  task: fixingTask,
  contextFileText: "",
  architectNotes: "",
  skillContext:
    "Active skills: agent:test-driven-development, superpowers:systematic-debugging, aiboard:browser-acceptance",
  toolInstructions: "",
});
check(
  "worker prompt gives exact skill evidence template for TDD/debug/browser gates",
  /Skill evidence:/i.test(skillEvidencePrompt) &&
    /RED test\/check failure before implementation/i.test(skillEvidencePrompt) &&
    /GREEN test\/check pass after implementation/i.test(skillEvidencePrompt) &&
    /Root cause or reproduction identified before the fix/i.test(skillEvidencePrompt) &&
    /Fix verified against the reproduced failure/i.test(skillEvidencePrompt) &&
    /Trust boundary reviewed and unsafe case considered/i.test(skillEvidencePrompt) &&
    /browser_navigate/i.test(skillEvidencePrompt) &&
    /visibleOutputMatchesRequest/i.test(skillEvidencePrompt) &&
    /browser_console_messages/i.test(skillEvidencePrompt),
  skillEvidencePrompt
);

const scoreboard = scoreboardSection("- claude-opus-4-5: score 3\n- Gemini 3.5 Flash: score 0");
check(
  "scoreboard prompt tells Architect assignTo is a sparse preference",
  /assignTo sparingly/i.test(scoreboard) && /engine balances/i.test(scoreboard),
  scoreboard
);

const workerTools = buildWorkerToolInstructions({
  reads: 1,
  rangeReads: 1,
  searches: 1,
  runs: 1,
  patches: 1,
  appends: 1,
  mcpToolsDoc:
    "playwright.browser_navigate args: url: string\nplaywright.browser_snapshot args: none",
  mcpCallsLeft: 2,
  localServerUrls: ["http://localhost:3001"],
  shellHint:
    "SHELL: commands run on Windows via cmd.exe - use `py -3 -m http.server 8000`; prefer http://127.0.0.1:<port> for browser navigation.",
});
check(
  "worker tool instructions advertise MCP tools",
  workerTools.includes('"action":"tool"') &&
    workerTools.includes("playwright.browser_navigate") &&
    /2 tool calls? left/i.test(workerTools),
  workerTools
);
check(
  "worker tool instructions advertise blocking and async guidance requests",
  workerTools.includes('"action":"guidance_request"') &&
    /mode":"blocking"/.test(workerTools) &&
    /mode "async"/.test(workerTools),
  workerTools
);
check(
  "worker tool instructions include active local server URL",
  workerTools.includes("http://localhost:3001") &&
    /browser MCP navigation/i.test(workerTools),
  workerTools
);
check(
  "worker tool instructions tell workers to reuse active servers before new ports",
  /Reuse active local server URLs/i.test(workerTools) &&
    /do not start another server/i.test(workerTools),
  workerTools
);
check(
  "worker tool policy allows MCP tool actions",
  isWorkerBuildToolAction({
    action: "tool",
    server: "playwright",
    tool: "browser_navigate",
    args: { url: "http://localhost:3000/games" },
  }),
);
check(
  "worker tool instructions forbid Playwright for npm and shell checks",
  /Do NOT use Playwright\/MCP tools to run npm, shell, Node/i.test(workerTools) &&
    /"action":"run"/.test(workerTools),
  workerTools
);
check(
  "worker tool policy allows advertised run actions",
  isWorkerBuildToolAction({
    action: "run",
    command: "npm test",
    reason: "verify the reproduced failure",
  }),
);
check(
  "worker tool policy allows guidance_request actions",
  isWorkerBuildToolAction({
    action: "guidance_request",
    mode: "blocking",
    question: "Which helper should I use?",
  }),
);
check(
  "worker tool policy rejects guidance_answer actions",
  !isWorkerBuildToolAction({
    action: "guidance_answer",
    guidanceId: "G-T3-1",
    taskId: "T3",
    answer: "Use the existing helper.",
  }),
);
check(
  "worker tool instructions constrain shell checks to simple project-root commands",
  /project-root commands only/i.test(workerTools) &&
    /no cd, pipes, redirects/i.test(workerTools) &&
    /no installs/i.test(workerTools),
  workerTools
);
check(
  "worker tool instructions include runner shell guidance",
  /Windows via cmd\.exe/i.test(workerTools) &&
    /py -3 -m http\.server 8000/i.test(workerTools) &&
    /127\.0\.0\.1:<port>/i.test(workerTools),
  workerTools
);
check(
  "worker tool instructions constrain Playwright navigation and console levels",
  /never navigate to about:blank/i.test(workerTools) &&
    /browser_console_messages/i.test(workerTools) &&
    /error, warning, info, or debug/i.test(workerTools),
  workerTools
);
check(
  "worker tool instructions require settled visible UI acceptance",
  /real-browser acceptance/i.test(workerTools) &&
    /no visible stuck loading/i.test(workerTools) &&
    /post-action settled state/i.test(workerTools),
  workerTools
);
check(
  "worker tool instructions include exact Playwright action examples",
  /"server":"playwright","tool":"browser_navigate","args":\{"url":"http:\/\/localhost:3001"\}/.test(workerTools) &&
    /"tool":"browser_snapshot","args":\{\}/.test(workerTools) &&
    /"tool":"browser_console_messages","args":\{"level":"error"\}/.test(workerTools),
  workerTools
);
check(
  "worker tool instructions call out malformed Playwright action shapes",
  /Do not emit bare.*browser_snapshot/i.test(workerTools) &&
    /Do not use "arguments"/i.test(workerTools) &&
    /Do not put MCP actions in arrays/i.test(workerTools),
  workerTools
);
check(
  "worker tool instructions prevent oversized malformed JSON tool calls",
  /keep each JSON tool action small/i.test(workerTools) &&
    /one smaller JSON tool action/i.test(workerTools) &&
    /split.*patch/i.test(workerTools) &&
    /append chunks/i.test(workerTools),
  workerTools
);
check(
  "worker tool instructions show Playwright target refs for form/click/type actions",
  /browser_fill_form/i.test(workerTools) &&
    /"target":"e19"/.test(workerTools) &&
    /Do not use "ref"/i.test(workerTools) &&
    /browser_type/i.test(workerTools) &&
    /browser_click/i.test(workerTools),
  workerTools
);
check(
  "worker tool instructions tell Playwright workers to capture ONE acceptance screenshot",
  /"tool":"browser_take_screenshot","args":\{\}/.test(workerTools) &&
    /visual acceptance evidence/i.test(workerTools) &&
    /After the main workflow settles/i.test(workerTools),
  workerTools
);

const reviewPrompt = buildArchitectReviewPrompt({
  request: "Create a web app for exploring a local git repository.",
  treeText: "public/app.js\nserver/server.js",
  executedText: "T1 landed UI and backend changes. npm test passed.",
  outstandingTasks: "",
  maxNewTasks: 2,
  cyclesLeft: 1,
  workerNames: ["Worker A"],
  fileContext: "",
  readHopsLeft: 0,
  rangeReadsLeft: 0,
  runsLeft: 0,
  searchesLeft: 0,
  mcpToolsDoc: "playwright.browser_navigate args: url: string",
  mcpCallsLeft: 1,
  localRunner: true,
} as Parameters<typeof buildArchitectReviewPrompt>[0]);
check(
  "architect review prompt blocks done without browser acceptance for web apps",
  /browser acceptance/i.test(reviewPrompt) &&
    /do NOT set "done": true/i.test(reviewPrompt) &&
    /visible stuck loading/i.test(reviewPrompt),
  reviewPrompt
);
check(
  "architect review prompt requires request-fulfillment evidence for all builds",
  /requestFulfillment/i.test(reviewPrompt) &&
    /original user request/i.test(reviewPrompt) &&
    /landed output/i.test(reviewPrompt) &&
    /do NOT set "done": true/i.test(reviewPrompt),
  reviewPrompt
);
check(
  "architect review prompt names structured browser acceptance fields",
  browserEvidenceFields.every((field) => reviewPrompt.includes(field)),
  reviewPrompt
);
check(
  "architect review prompt lets reviewers revise the verifier",
  /verifyCommand/i.test(reviewPrompt) &&
    /replace the automated verifier/i.test(reviewPrompt) &&
    /wrong for this stack/i.test(reviewPrompt),
  reviewPrompt
);
check(
  "review prompt omits the diff-first line when hasDiffDigest is absent",
  !/PRIMARY evidence for this review/i.test(reviewPrompt),
  reviewPrompt
);
check(
  "review prompt omits the screenshot line when no screenshotTaskIds are attached",
  !/Screenshot\(s\) of the running app are ATTACHED/i.test(reviewPrompt),
  reviewPrompt
);

const reviewPromptWithShots = buildArchitectReviewPrompt({
  request: "Create a web app for exploring a local git repository.",
  treeText: "public/app.js\nserver/server.js",
  executedText: "T1 landed UI changes.",
  outstandingTasks: "",
  maxNewTasks: 2,
  cyclesLeft: 1,
  fileContext: "",
  readHopsLeft: 0,
  rangeReadsLeft: 0,
  runsLeft: 0,
  searchesLeft: 0,
  mcpToolsDoc: "",
  mcpCallsLeft: 0,
  screenshotTaskIds: ["T1", "T2"],
} as Parameters<typeof buildArchitectReviewPrompt>[0]);
check(
  "review prompt names attached screenshots and asks for visual acceptance when screenshotTaskIds present",
  /Screenshot\(s\) of the running app are ATTACHED for: T1, T2/i.test(reviewPromptWithShots) &&
    /judge visual acceptance from them/i.test(reviewPromptWithShots) &&
    /requested appearance\/behavior/i.test(reviewPromptWithShots) &&
    /do not set "done": true/i.test(reviewPromptWithShots),
  reviewPromptWithShots
);
const reviewPromptWithDiff = buildArchitectReviewPrompt({
  request: "Create a web app for exploring a local git repository.",
  treeText: "public/app.js\nserver/server.js",
  executedText: "T1 landed UI and backend changes.",
  outstandingTasks: "",
  maxNewTasks: 2,
  cyclesLeft: 1,
  fileContext: "",
  readHopsLeft: 0,
  rangeReadsLeft: 0,
  runsLeft: 0,
  searchesLeft: 0,
  mcpToolsDoc: "",
  mcpCallsLeft: 0,
  hasDiffDigest: true,
} as Parameters<typeof buildArchitectReviewPrompt>[0]);
check(
  "review prompt tells the reviewer to judge the Wave diff first when hasDiffDigest is true",
  /"Wave diff" pack .* PRIMARY evidence for this review/i.test(reviewPromptWithDiff) &&
    reviewPromptWithDiff.indexOf("PRIMARY evidence for this review") <
      reviewPromptWithDiff.indexOf("Review each task's output"),
  reviewPromptWithDiff
);

const serverUrls = extractLocalServerUrls(
  "npx next dev --turbopack -p 3001 &\nLocal: http://localhost:3001"
);
check(
  "local server URL extraction detects command port",
  serverUrls.includes("http://localhost:3001"),
  serverUrls
);

process.exit(failed === 0 ? 0 : 1);
