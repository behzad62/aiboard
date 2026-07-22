/* Benchmark case manifest checks (run: npx tsx scripts/test-benchmark-case-manifests.mts) */
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listGameIqScenarioPacks,
  stableGameIqScenarioPackDigest,
} from "../lib/benchmark/gameiq/packs";
import {
  TOOL_RELIABILITY_CASES,
  validateToolReliabilityCasePack,
} from "../lib/benchmark/toolreliability/cases";
import {
  listWorkBenchCaseOptions,
} from "../lib/benchmark/workbench/corpus";
import { toBenchmarkCaseV2 } from "../lib/benchmark/workbench/case-loader";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const benchmarksRoot = join(repoRoot, "benchmarks");
const docsRoot = join(repoRoot, "docs", "bench");

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

for (const doc of [
  "case-authoring.md",
  "scoring-rules.md",
  "failure-taxonomy.md",
  "suite-review-checklist.md",
]) {
  check(`bench doc exists: ${doc}`, await exists(join(docsRoot, doc)));
}

for (const path of [
  join(benchmarksRoot, "toolreliability", "v0"),
  join(benchmarksRoot, "toolreliability", "v1", "cases.json"),
  join(benchmarksRoot, "workbench", "v0"),
  join(benchmarksRoot, "workbench", "v1"),
  join(benchmarksRoot, "gameiq", "v0"),
  join(benchmarksRoot, "gameiq", "v1"),
  join(benchmarksRoot, "teamiq", "v0"),
]) {
  check(`legacy benchmark artifact is removed: ${path}`, !(await exists(path)));
}

const expectedGameIqCounts = new Map([
  ["gameiq-v0.2-connect-four", 12],
  ["gameiq-v0.2-chess", 12],
  ["gameiq-v0.2-battleship", 15],
  ["gameiq-fireworks-basic-v1", 20],
  ["gameiq-fireworks-hard-v1", 40],
  ["gameiq-fireworks-memory-v1", 30],
]);
for (const pack of listGameIqScenarioPacks()) {
  check(
    `${pack.id} has expected canonical scenario count`,
    pack.scenarios.length === expectedGameIqCounts.get(pack.id),
    { id: pack.id, gameId: pack.gameId, count: pack.scenarios.length }
  );
  check(
    `${pack.id} has stable digest`,
    stableGameIqScenarioPackDigest(pack).startsWith(`gameiq-v1:${pack.id}:`),
    stableGameIqScenarioPackDigest(pack)
  );
}

const toolValidation = validateToolReliabilityCasePack(TOOL_RELIABILITY_CASES);
check("ToolReliability pack covers required metrics", toolValidation.valid, toolValidation);
check("ToolReliability canonical pack has 35 cases", TOOL_RELIABILITY_CASES.length === 35, TOOL_RELIABILITY_CASES.length);
check(
  "ToolReliability canonical pack has 5 large patch cases",
  TOOL_RELIABILITY_CASES.filter((item) => item.id.startsWith("toolrel-current-large-patch-")).length === 5
);

const workBenchCases = listWorkBenchCaseOptions();
check("WorkBench current picker has generated challenge cases", workBenchCases.length >= 19, workBenchCases.map((item) => item.id));
check(
  "WorkBench current picker has no legacy case ids or labels",
  workBenchCases.every((item) => !item.id.includes("-v1-") && !/\bv[12]\b/i.test(item.label)),
  workBenchCases.map((item) => ({ id: item.id, label: item.label }))
);

const workBenchLanguages = workBenchCases.reduce<Record<string, number>>((counts, item) => {
  counts[item.fixtureLanguage] = (counts[item.fixtureLanguage] ?? 0) + 1;
  return counts;
}, {});
check("WorkBench current corpus includes C#", workBenchLanguages.csharp === 2, workBenchLanguages);
check("WorkBench current corpus includes C++", workBenchLanguages.cpp === 2, workBenchLanguages);
check("WorkBench current corpus includes Go", workBenchLanguages.go === 2, workBenchLanguages);
check("WorkBench current corpus includes Rust", workBenchLanguages.rust === 1, workBenchLanguages);
check("WorkBench current corpus includes Python", workBenchLanguages.python === 2, workBenchLanguages);
check("WorkBench current corpus includes React UI", workBenchLanguages["react-ui"] === 2, workBenchLanguages);

for (const option of workBenchCases) {
  const caseV2 = toBenchmarkCaseV2(option.case, "2026-06-27T10:00:00.000Z");
  check(`${option.id} converts to BenchmarkCaseV2`, caseV2.schemaVersion === 2 && caseV2.track === "workbench", caseV2);
  check(`${option.id} has inline fixture files`, Boolean(option.case.fixtureFiles?.["verifier.mjs"] && option.case.fixtureFiles?.["case-meta.json"]), option.case.fixtureFiles);
  check(`${option.id} has canary and private reference`, option.case.contamination.canary.startsWith("AIBENCH-") && option.case.contamination.referenceSolutionPrivate === true, option.case.contamination);
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
