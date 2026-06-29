/* Benchmark case manifest checks (run: npx tsx scripts/test-benchmark-case-manifests.mts) */
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listGameIqScenarioPacks,
  stableGameIqScenarioPackDigest,
} from "../lib/benchmark/gameiq/packs";
import {
  TOOL_RELIABILITY_V0_1_CASES,
  validateToolReliabilityCasePack,
} from "../lib/benchmark/toolreliability/cases";
import {
  listWorkBenchV1CaseOptions,
} from "../lib/benchmark/workbench/v1-corpus";
import { listWorkBenchV2CaseOptions } from "../lib/benchmark/workbench/v2-corpus";
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

for (const track of ["workbench", "gameiq", "toolreliability", "teamiq"]) {
  check(`benchmark track directory exists: ${track}`, await exists(join(benchmarksRoot, track, "v0")));
}

const expectedGameIqCounts = new Map([
  ["connect-four", 40],
  ["chess", 60],
  ["battleship", 25],
  ["codenames", 25],
  ["fireworks", 20],
]);
for (const pack of listGameIqScenarioPacks()) {
  check(
    `${pack.gameId} has expected canonical scenario count`,
    pack.scenarios.length === expectedGameIqCounts.get(pack.gameId),
    { gameId: pack.gameId, count: pack.scenarios.length }
  );
  check(
    `${pack.gameId} has stable digest`,
    stableGameIqScenarioPackDigest(pack).startsWith(`gameiq-v0.1:${pack.gameId}:`),
    stableGameIqScenarioPackDigest(pack)
  );
}

const toolValidation = validateToolReliabilityCasePack(TOOL_RELIABILITY_V0_1_CASES);
check("ToolReliability pack covers required metrics", toolValidation.valid, toolValidation);
check("ToolReliability canonical pack has 125 cases", TOOL_RELIABILITY_V0_1_CASES.length === 125, TOOL_RELIABILITY_V0_1_CASES.length);
check(
  "ToolReliability canonical pack has 50 large patch stress cases",
  TOOL_RELIABILITY_V0_1_CASES.filter((item) => item.id.startsWith("toolrel-v0.1-large-patch-")).length === 50
);

const allWorkBenchCases = listWorkBenchV1CaseOptions();
const workBenchV2Cases = listWorkBenchV2CaseOptions();
check("WorkBench combined picker has v1 plus v2 cases", allWorkBenchCases.length === 10 + workBenchV2Cases.length, allWorkBenchCases.length);
check("WorkBench v2 has generated challenge cases", workBenchV2Cases.length >= 19, workBenchV2Cases.map((item) => item.id));

const v2Languages = workBenchV2Cases.reduce<Record<string, number>>((counts, item) => {
  counts[item.fixtureLanguage] = (counts[item.fixtureLanguage] ?? 0) + 1;
  return counts;
}, {});
check("WorkBench v2 includes C#", v2Languages.csharp === 2, v2Languages);
check("WorkBench v2 includes C++", v2Languages.cpp === 2, v2Languages);
check("WorkBench v2 includes Go", v2Languages.go === 2, v2Languages);
check("WorkBench v2 includes Rust", v2Languages.rust === 1, v2Languages);
check("WorkBench v2 includes Python", v2Languages.python === 2, v2Languages);
check("WorkBench v2 includes React UI", v2Languages["react-ui"] === 2, v2Languages);

for (const option of workBenchV2Cases) {
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
