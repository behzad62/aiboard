/** Build task retry policy checks (run: npx tsx scripts/test-build-task-retry-policy.mts) */
import {
  decideBuildTaskFailure,
  type BuildTask,
} from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const task = (failCount = 0): BuildTask => ({
  id: "T2",
  title: "Create audit JSON report",
  instructions: "Create docs/tool-call-audit-2.json",
  contextFiles: [],
  status: "planned",
  failCount,
});

const first = decideBuildTaskFailure(task(0), "bad", "returned no files");
check("first bad-output failure requeues", first.status === "fixing", first);
check("first failure count increments", first.failCount === 1, first);
check("bad-output note asks for file tool correction", /no usable output/i.test(first.instructionNote), first);

const second = decideBuildTaskFailure(task(1), "unavailable", "was unavailable (429 Rate limit exceeded)");
check("second transient failure still requeues", second.status === "fixing", second);
check("second failure count increments", second.failCount === 2, second);
check("transient note explains rate-limit retry", /transient provider failure/i.test(second.instructionNote), second);
check("transient retries include backoff", (second.retryDelayMs ?? 0) > 0, second);

const third = decideBuildTaskFailure(task(2), "unavailable", "was unavailable (429 Rate limit exceeded)");
check("third failure gives up", third.status === "failed", third);
check("third failure count increments", third.failCount === 3, third);

process.exit(failed === 0 ? 0 : 1);
