/* Benchmark corpus review checks (run: npx tsx scripts/review-benchmark-corpus.mts) */
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import {
  listGameIqScenarioPacks,
  stableGameIqScenarioPackDigest,
  validateGameIqScenario,
} from "../lib/benchmark/gameiq";
import {
  TOOL_RELIABILITY_CASE_CATEGORIES,
  TOOL_RELIABILITY_V0_1_CASES,
  validateToolReliabilityCasePack,
} from "../lib/benchmark/toolreliability";
import {
  listWorkBenchV1CaseOptions,
  listWorkBenchV2CaseOptions,
} from "../lib/benchmark/workbench";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

for (const doc of [
  "docs/bench/case-authoring.md",
  "docs/bench/scoring-rules.md",
  "docs/bench/failure-taxonomy.md",
  "docs/bench/suite-review-checklist.md",
]) {
  check(`bench doc exists: ${doc}`, existsSync(resolve(doc)));
}

const expectedGameIqCounts = new Map([
  ["connect-four", 40],
  ["chess", 60],
  ["battleship", 25],
  ["codenames", 25],
  ["fireworks", 20],
]);
const gamePacks = listGameIqScenarioPacks();
const allScenarioIds = gamePacks.flatMap((pack) => pack.scenarios.map((scenario) => scenario.id));
check("GameIQ scenario ids are globally unique", new Set(allScenarioIds).size === allScenarioIds.length, allScenarioIds);
for (const pack of gamePacks) {
  check(
    `GameIQ ${pack.gameId} has required scenario count`,
    pack.scenarios.length === expectedGameIqCounts.get(pack.gameId),
    { actual: pack.scenarios.length, expected: expectedGameIqCounts.get(pack.gameId) }
  );
  check(
    `GameIQ ${pack.gameId} digest is stable`,
    stableGameIqScenarioPackDigest(pack) === stableGameIqScenarioPackDigest(pack),
    stableGameIqScenarioPackDigest(pack)
  );
  for (const scenario of pack.scenarios) {
    const validation = validateGameIqScenario(scenario);
    check(`${scenario.id} validates`, validation.ok, validation);
  }
}

const toolValidation = validateToolReliabilityCasePack(TOOL_RELIABILITY_V0_1_CASES);
check("ToolReliability pack validates", toolValidation.valid, toolValidation);
check("ToolReliability has 125 cases", TOOL_RELIABILITY_V0_1_CASES.length === 125, TOOL_RELIABILITY_V0_1_CASES.length);
check(
  "ToolReliability has 50 large-file patch stress cases",
  TOOL_RELIABILITY_V0_1_CASES.filter((item) => item.id.startsWith("toolrel-v0.1-large-patch-")).length === 50,
  TOOL_RELIABILITY_V0_1_CASES.map((item) => item.id)
);
for (const category of TOOL_RELIABILITY_CASE_CATEGORIES) {
  check(
    `ToolReliability ${category} has at least 10 cases`,
    TOOL_RELIABILITY_V0_1_CASES.filter((item) => item.category === category).length >= 10,
    TOOL_RELIABILITY_V0_1_CASES.map((item) => item.category)
  );
}

const workBenchV1CasesDir = resolve("benchmarks", "workbench", "v1", "cases");
check("WorkBench v1 cases directory exists", existsSync(workBenchV1CasesDir));
if (existsSync(workBenchV1CasesDir)) {
  const v1CaseFiles = readdirSync(workBenchV1CasesDir).filter((file) => file.endsWith(".json"));
  check("WorkBench v1 has 10 fixture manifests", v1CaseFiles.length === 10, v1CaseFiles);
}

const combinedWorkBenchCases = listWorkBenchV1CaseOptions();
const workBenchV2Cases = listWorkBenchV2CaseOptions();
check("WorkBench picker exposes v1 + v2 cases", combinedWorkBenchCases.length === 10 + workBenchV2Cases.length, combinedWorkBenchCases.length);
check("WorkBench v2 has at least 19 generated challenges", workBenchV2Cases.length >= 19, workBenchV2Cases.map((item) => item.id));
const v2LanguageCounts = workBenchV2Cases.reduce<Record<string, number>>((counts, item) => {
  counts[item.fixtureLanguage] = (counts[item.fixtureLanguage] ?? 0) + 1;
  return counts;
}, {});
check("WorkBench v2 includes C# cases", v2LanguageCounts.csharp === 2, v2LanguageCounts);
check("WorkBench v2 includes C++ cases", v2LanguageCounts.cpp === 2, v2LanguageCounts);
check("WorkBench v2 includes Go cases", v2LanguageCounts.go === 2, v2LanguageCounts);
check("WorkBench v2 includes Rust cases", v2LanguageCounts.rust === 1, v2LanguageCounts);
check("WorkBench v2 includes Python cases", v2LanguageCounts.python === 2, v2LanguageCounts);
check("WorkBench v2 includes React UI cases", v2LanguageCounts["react-ui"] === 2, v2LanguageCounts);
check(
  "WorkBench v2 cases carry inline verifier fixtures",
  workBenchV2Cases.every((item) => item.case.fixtureFiles?.["verifier.mjs"] && item.case.fixtureFiles?.["case-meta.json"]),
  workBenchV2Cases.map((item) => item.id)
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
