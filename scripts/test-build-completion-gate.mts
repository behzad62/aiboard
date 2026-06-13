/** Build completion gate checks (run: npx tsx scripts/test-build-completion-gate.mts) */
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

process.exit(failed === 0 ? 0 : 1);
