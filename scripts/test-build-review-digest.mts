/** Build review digest regression checks (run: npx tsx scripts/test-build-review-digest.mts) */
import {
  buildWaveReviewDigest,
  summarizeFileChange,
  type BuildTask,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const task: BuildTask = {
  id: "T3",
  title: "Repair query and render modules",
  instructions: "Patch existing TypeScript files.",
  contextFiles: ["src/query.ts"],
  outputPaths: ["src/query.ts"],
  status: "review",
};

const before = Array.from({ length: 700 }, (_, i) => `old line ${i}`).join("\n");
const after = [
  ...Array.from({ length: 320 }, (_, i) => `old line ${i}`),
  "NEW_TARGETED_CHANGE();",
  ...Array.from({ length: 379 }, (_, i) => `old line ${i + 321}`),
  "SHOULD_NOT_LEAK_FULL_FILE_MARKER",
].join("\n");

const change = summarizeFileChange({
  path: "src/query.ts",
  operation: "patch",
  before,
  after,
});

check("change summary includes path", change.includes("src/query.ts"), change);
check("change summary includes operation", /patch/i.test(change), change);
check("change summary includes targeted changed text", change.includes("NEW_TARGETED_CHANGE"), change);
check(
  "change summary does not leak the whole file tail",
  !change.includes("SHOULD_NOT_LEAK_FULL_FILE_MARKER"),
  change.length
);
check("change summary is compact", change.length < 1800, change.length);

const digest = buildWaveReviewDigest([
  {
    task,
    workerName: "Qwen 3.7 Plus",
    files: ["src/query.ts"],
    notes: "Patched the filter branch.",
    changes: [change],
  },
]);

check("wave digest names task and worker", digest.includes("T3") && digest.includes("Qwen 3.7 Plus"), digest);
check("wave digest includes changed file", digest.includes("src/query.ts"), digest);
check("wave digest remains compact", digest.length < 2600, digest.length);
check("wave digest has no full file fence", !/```/.test(digest), digest);

process.exit(failed === 0 ? 0 : 1);
