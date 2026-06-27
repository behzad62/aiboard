/** Build prompt regression checks (run: npx tsx scripts/test-build-prompts.mts) */
import {
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
  status: "fixing",
};

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
  patches: 1,
  appends: 1,
  mcpToolsDoc:
    "playwright.browser_navigate args: url: string\nplaywright.browser_snapshot args: none",
  mcpCallsLeft: 2,
  localServerUrls: ["http://localhost:3001"],
});
check(
  "worker tool instructions advertise MCP tools",
  workerTools.includes('"action":"tool"') &&
    workerTools.includes("playwright.browser_navigate") &&
    /2 tool calls? left/i.test(workerTools),
  workerTools
);
check(
  "worker tool instructions include active local server URL",
  workerTools.includes("http://localhost:3001") &&
    /browser MCP navigation/i.test(workerTools),
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

const serverUrls = extractLocalServerUrls(
  "npx next dev --turbopack -p 3001 &\nLocal: http://localhost:3001"
);
check(
  "local server URL extraction detects command port",
  serverUrls.includes("http://localhost:3001"),
  serverUrls
);

process.exit(failed === 0 ? 0 : 1);
