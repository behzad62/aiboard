/* Benchmark corpus review checks (run: npx tsx scripts/review-benchmark-corpus.mts) */
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  listGameIqScenarioPacks,
  stableGameIqScenarioPackDigest,
  validateGameIqScenario,
} from "../lib/benchmark/gameiq";
import {
  TOOL_RELIABILITY_CASE_CATEGORIES,
  TOOL_RELIABILITY_CASES,
  validateToolReliabilityCasePack,
} from "../lib/benchmark/toolreliability";
import {
  listWorkBenchCaseOptions,
} from "../lib/benchmark/workbench/corpus";

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
  ["gameiq-v0.1-connect-four", 40],
  ["gameiq-v0.1-chess", 15],
  ["gameiq-v0.1-battleship", 11],
  ["gameiq-v0.1-codenames", 10],
  ["gameiq-fireworks-basic-v1", 20],
  ["gameiq-fireworks-hard-v1", 40],
  ["gameiq-fireworks-memory-v1", 30],
]);
const gamePacks = listGameIqScenarioPacks();
const allScenarioIds = gamePacks.flatMap((pack) => pack.scenarios.map((scenario) => scenario.id));
check("GameIQ scenario ids are globally unique", new Set(allScenarioIds).size === allScenarioIds.length, allScenarioIds);
for (const pack of gamePacks) {
  check(
    `GameIQ ${pack.id} has required scenario count`,
    pack.scenarios.length === expectedGameIqCounts.get(pack.id),
    { actual: pack.scenarios.length, expected: expectedGameIqCounts.get(pack.id) }
  );
  const distinctScenarioTuples = new Set(
    pack.scenarios.map((scenario) =>
      JSON.stringify({
        initialState: scenario.initialState,
        expectedActions: scenario.expectedActions,
      })
    )
  );
  check(
    `GameIQ ${pack.id} has no duplicate scenario tuples`,
    distinctScenarioTuples.size === pack.scenarios.length,
    { distinct: distinctScenarioTuples.size, scenarios: pack.scenarios.length }
  );
  check(
    `GameIQ ${pack.id} digest is stable`,
    stableGameIqScenarioPackDigest(pack) === stableGameIqScenarioPackDigest(pack),
    stableGameIqScenarioPackDigest(pack)
  );
  for (const scenario of pack.scenarios) {
    const validation = validateGameIqScenario(scenario);
    check(`${scenario.id} validates`, validation.ok, validation);
  }
}

const toolValidation = validateToolReliabilityCasePack(TOOL_RELIABILITY_CASES);
check("ToolReliability pack validates", toolValidation.valid, toolValidation);
check("ToolReliability has 44 distinct cases", TOOL_RELIABILITY_CASES.length === 44, TOOL_RELIABILITY_CASES.length);
check(
  "ToolReliability has 10 large-file patch cases",
  TOOL_RELIABILITY_CASES.filter((item) => item.id.startsWith("toolrel-current-large-patch-")).length === 10,
  TOOL_RELIABILITY_CASES.map((item) => item.id)
);
for (const category of TOOL_RELIABILITY_CASE_CATEGORIES) {
  check(
    `ToolReliability ${category} has at least 4 cases`,
    TOOL_RELIABILITY_CASES.filter((item) => item.category === category).length >= 4,
    TOOL_RELIABILITY_CASES.map((item) => item.category)
  );
}

for (const legacyPath of [
  resolve("benchmarks", "workbench", "v0"),
  resolve("benchmarks", "workbench", "v1"),
  resolve("benchmarks", "toolreliability", "v0"),
  resolve("benchmarks", "toolreliability", "v1", "cases.json"),
  resolve("benchmarks", "gameiq", "v0"),
  resolve("benchmarks", "teamiq", "v0"),
  resolve("benchmarks", "fireworks", "v0.1", "full-games.json"),
  resolve("benchmarks", "fireworks", "v0.1", "memory.json"),
  resolve("benchmarks", "fireworks", "v0.1", "tactics.json"),
]) {
  check(`legacy benchmark artifact removed: ${legacyPath}`, !existsSync(legacyPath));
}

const workBenchCases = listWorkBenchCaseOptions();
check("WorkBench current corpus has at least 19 generated challenges", workBenchCases.length >= 19, workBenchCases.map((item) => item.id));
const workBenchLanguageCounts = workBenchCases.reduce<Record<string, number>>((counts, item) => {
  counts[item.fixtureLanguage] = (counts[item.fixtureLanguage] ?? 0) + 1;
  return counts;
}, {});
check("WorkBench current corpus includes C# cases", workBenchLanguageCounts.csharp === 2, workBenchLanguageCounts);
check("WorkBench current corpus includes C++ cases", workBenchLanguageCounts.cpp === 2, workBenchLanguageCounts);
check("WorkBench current corpus includes Go cases", workBenchLanguageCounts.go === 2, workBenchLanguageCounts);
check("WorkBench current corpus includes Rust cases", workBenchLanguageCounts.rust === 1, workBenchLanguageCounts);
check("WorkBench current corpus includes Python cases", workBenchLanguageCounts.python === 2, workBenchLanguageCounts);
check("WorkBench current corpus includes React UI cases", workBenchLanguageCounts["react-ui"] === 2, workBenchLanguageCounts);
check(
  "WorkBench current cases carry inline verifier fixtures",
  workBenchCases.every((item) => item.case.fixtureFiles?.["verifier.mjs"] && item.case.fixtureFiles?.["case-meta.json"]),
  workBenchCases.map((item) => item.id)
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
