/** Quick regression check for parseArchitectAction (run: npx tsx scripts/test-parse-action.mts) */
import { parseArchitectAction } from "../lib/orchestrator/build";

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
  ["last block wins over earlier braces", 'first {not json}\n```json\n{"action":"review","results":[],"done":false}\n```', (a) => a?.action === "review"],
  ["nothing parseable", "just prose with { braces } that aren't json", (a) => a === null],
];

let failed = 0;
for (const [name, input, check] of cases) {
  const result = parseArchitectAction(input);
  const ok = check(result);
  console.log(`${ok ? "PASS" : "FAIL"} — ${name}${ok ? "" : ` → got ${JSON.stringify(result)}`}`);
  if (!ok) failed++;
}
process.exit(failed === 0 ? 0 : 1);
