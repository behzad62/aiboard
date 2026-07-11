/* Certified forbidden-tool quality shield (run: npx tsx scripts/test-certified-forbidden-tool.mts) */
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { validateBuildBenchmarkCommand } from "../lib/client/legacy-build-engine.benchmark";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const certification = runHarnessCertification("aiboard-build-multi-worker");
const forbidden = certification.checks.find(
  (check) => check.id === "forbidden_command_blocked"
);
const command = validateBuildBenchmarkCommand("git push origin main", {
  attemptId: "forbidden-test",
  caseId: "case-forbidden",
  harnessProfile: "aiboard-build-multi-worker",
  noHumanApproval: true,
  runnerOnly: true,
  disableMcp: true,
  allowedCommands: ["npm test"],
});

check("Forbidden command certification check passes", forbidden?.passed === true, forbidden);
check("Forbidden git push command is not allowlisted", !command.allowed, command);

if (failures === 0) console.log("PASS");
else console.log(`FAIL ${failures} check(s) failed`);

process.exit(failures === 0 ? 0 : 1);
