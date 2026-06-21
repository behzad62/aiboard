/* build-runner produces a valid single-file public/runner.mjs (run: npx tsx scripts/test-runner-panel-build.mts) */
import { execSync } from "node:child_process";
import fs from "node:fs";

let failures = 0;
function check(name: string, cond: boolean) {
  if (!cond) failures++;
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
}

execSync("node scripts/build-runner.mjs", { stdio: "pipe" });
const out = fs.readFileSync("public/runner.mjs", "utf8");

check("contains panel markup", out.includes("AI&nbsp;Board") && out.includes("Project folder"));
check("no leftover panel marker", !out.includes("__RUNNER_PANEL_HTML__"));
check("no runner-lib import remains", !out.includes('from "./runner-lib.mjs"'));
check("inlined confine()", out.includes("function confine("));
check("inlined createLog()", out.includes("function createLog("));
check("single node:crypto import", (out.match(/from "node:crypto"/g) || []).length === 1);
check("single node:path import", (out.match(/from "node:path"/g) || []).length === 1);
check("single node:fs import", (out.match(/from "node:fs"/g) || []).length === 1);

try {
  execSync("node --check public/runner.mjs", { stdio: "pipe" });
  check("node --check passes (valid single file)", true);
} catch {
  check("node --check passes (valid single file)", false);
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
