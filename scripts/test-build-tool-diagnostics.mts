/** Build file-tool diagnostic checks (run: npx tsx scripts/test-build-tool-diagnostics.mts) */
import { formatBuildFileToolDiagnostic } from "../lib/orchestrator/build";

let failed = 0;
const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`${ok ? "PASS" : "FAIL"} - ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
  if (!ok) failed++;
};

const read = formatBuildFileToolDiagnostic({
  actor: "Qwen 3.7 Plus",
  action: "read",
  paths: ["src/cli.ts", "tests/run-tests.ts"],
});
check("read diagnostic names actor", read.includes("Qwen 3.7 Plus"), read);
check("read diagnostic names files", read.includes("src/cli.ts") && read.includes("tests/run-tests.ts"), read);

const range = formatBuildFileToolDiagnostic({
  actor: "Architect",
  action: "read_range",
  path: "src/cli.ts",
  startLine: 150,
  lineCount: 80,
});
check("range diagnostic includes requested line span", range.includes("150-229"), range);

const patch = formatBuildFileToolDiagnostic({
  actor: "Qwen 3.7 Plus",
  action: "patch",
  path: "src/cli.ts",
  summary: "Patch src/cli.ts: 1 applied, 0 failed",
});
check("patch diagnostic includes summary", patch.includes("1 applied"), patch);

const append = formatBuildFileToolDiagnostic({
  actor: "Qwen 3.7 Plus",
  action: "append",
  path: "tests/run-tests.ts",
  summary: "Append tests/run-tests.ts: +400 bytes",
});
check("append diagnostic includes byte summary", append.includes("+400 bytes"), append);

process.exit(failed === 0 ? 0 : 1);
