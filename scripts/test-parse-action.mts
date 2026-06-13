/** Quick regression check for parseArchitectAction (run: npx tsx scripts/test-parse-action.mts) */
import {
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
  ["unlabelled fence", '```\n{"action":"run","command":"npm test"}\n```', (a) => a?.action === "run"],
  ["shell alias parses as run", '{"action":"shell","command":"npm test"}', (a) => a?.action === "run" && (a as { command: string }).command === "npm test"],
  ["shell cmd alias parses as run", '{"action":"shell","cmd":"node -e \\"console.log(1)\\""}', (a) => a?.action === "run" && (a as { command: string }).command.includes("console.log")],
  ["last block wins over earlier braces", 'first {not json}\n```json\n{"action":"review","results":[],"done":false}\n```', (a) => a?.action === "review"],
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
    "append action",
    '{"action":"append","path":"tests/run-tests.ts","content":"first chunk","reset":true,"reason":"create large file safely"}',
    (a) =>
      a?.action === "append" &&
      (a as { path: string }).path === "tests/run-tests.ts" &&
      (a as { content: string }).content === "first chunk" &&
      (a as { reset: boolean }).reset === true,
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

process.exit(failed === 0 ? 0 : 1);
