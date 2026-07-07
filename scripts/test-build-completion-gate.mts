/** Build completion gate checks (run: npx tsx scripts/test-build-completion-gate.mts) */
import { readFileSync } from "node:fs";
import {
  buildIncompleteTaskFailure,
  findIncompleteBuildTasks,
  type BuildTask,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const task = (id: string, status: BuildTask["status"]): BuildTask => ({
  id,
  title: `${id} title`,
  instructions: "do it",
  contextFiles: [],
  status,
});

check(
  "all done tasks allow completion",
  findIncompleteBuildTasks([task("T1", "done"), task("T2", "done")]).length === 0
);

const incomplete = findIncompleteBuildTasks([
  task("T1", "done"),
  task("T2", "failed"),
  task("T3", "fixing"),
  task("T4", "planned"),
]);
check(
  "failed and unfinished tasks block completion",
  incomplete.map((t) => t.id).join(",") === "T2,T3,T4",
  incomplete
);

const message = buildIncompleteTaskFailure(incomplete);
check("failure message names failed task", /T2/.test(message), message);
check("failure message names fixing task", /T3/.test(message), message);
check("failure message says incomplete", /incomplete/i.test(message), message);

const buildEngineSource = readFileSync("lib/client/build-engine.ts", "utf8");
const incompleteBlockStart = buildEngineSource.indexOf(
  "const incompleteTasks = findIncompleteBuildTasks(tasks);"
);
const finalGateStart = buildEngineSource.indexOf(
  "let finalQualityGateSummary",
  incompleteBlockStart
);
const incompleteBlock = buildEngineSource.slice(incompleteBlockStart, finalGateStart);
check(
  "incomplete Build stop uses blocked stop helper instead of throwing failed discussion",
  incompleteBlock.includes('markStopped("blocked", message, report, toolReviewReport);') &&
    incompleteBlock.includes("return;") &&
    !incompleteBlock.includes("throw new Error(message);"),
  incompleteBlock
);

process.exit(failed === 0 ? 0 : 1);
