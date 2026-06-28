/* Benchmark corpus review checks (run: npx tsx scripts/review-benchmark-corpus.mts) */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
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
  createWorkBenchCaseHash,
  loadWorkBenchCaseFromJson,
} from "../lib/benchmark/workbench/case-loader";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const expectedGameIqCounts = new Map([
  ["connect-four", 40],
  ["chess", 60],
  ["battleship", 25],
  ["codenames", 25],
  ["fireworks", 20],
]);

const gamePacks = listGameIqScenarioPacks();
const allScenarioIds = gamePacks.flatMap((pack) =>
  pack.scenarios.map((scenario) => scenario.id)
);
check(
  "GameIQ scenario ids are globally unique",
  new Set(allScenarioIds).size === allScenarioIds.length,
  allScenarioIds
);

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
    check(
      `${scenario.id} has prompt and tags`,
      scenario.prompt.length > 20 && scenario.tags.length > 0,
      { prompt: scenario.prompt, tags: scenario.tags }
    );
    const validation = validateGameIqScenario(scenario);
    check(`${scenario.id} validates`, validation.ok, validation);
  }
}

for (const [gameId, expectedCount] of expectedGameIqCounts) {
  const artifactPath = resolve(
    "benchmarks",
    "gameiq",
    "v1",
    `${gameId}.json`
  );
  check(`GameIQ v1 artifact exists for ${gameId}`, existsSync(artifactPath));
  if (!existsSync(artifactPath)) continue;
  const artifact = JSON.parse(readFileSync(artifactPath, "utf8")) as {
    gameId?: unknown;
    scenarioCount?: unknown;
    scenarios?: unknown;
    digest?: unknown;
  };
  const pack = gamePacks.find((candidate) => candidate.gameId === gameId);
  check(
    `GameIQ v1 ${gameId} mirrors canonical pack`,
    Boolean(
      pack &&
        artifact.gameId === gameId &&
        artifact.scenarioCount === expectedCount &&
        Array.isArray(artifact.scenarios) &&
        artifact.scenarios.length === expectedCount &&
        artifact.digest === stableGameIqScenarioPackDigest(pack)
    ),
    artifact
  );
}

const toolValidation = validateToolReliabilityCasePack(
  TOOL_RELIABILITY_V0_1_CASES
);
check("ToolReliability pack validates", toolValidation.valid, toolValidation);
check(
  "ToolReliability has 75 cases",
  TOOL_RELIABILITY_V0_1_CASES.length === 75,
  TOOL_RELIABILITY_V0_1_CASES.length
);
check(
  "ToolReliability case ids are unique",
  new Set(TOOL_RELIABILITY_V0_1_CASES.map((item) => item.id)).size ===
    TOOL_RELIABILITY_V0_1_CASES.length,
  TOOL_RELIABILITY_V0_1_CASES.map((item) => item.id)
);
check(
  "ToolReliability canaries are present",
  TOOL_RELIABILITY_V0_1_CASES.every((item) =>
    item.canary.startsWith("AIBENCH-TOOLREL-")
  ),
  TOOL_RELIABILITY_V0_1_CASES.map((item) => item.canary)
);
for (const category of TOOL_RELIABILITY_CASE_CATEGORIES) {
  check(
    `ToolReliability ${category} has at least 10 cases`,
    TOOL_RELIABILITY_V0_1_CASES.filter((item) => item.category === category)
      .length >= 10,
    TOOL_RELIABILITY_V0_1_CASES.map((item) => item.category)
  );
}

const toolReliabilityV1Path = resolve(
  "benchmarks",
  "toolreliability",
  "v1",
  "cases.json"
);
check("ToolReliability v1 artifact exists", existsSync(toolReliabilityV1Path));
if (existsSync(toolReliabilityV1Path)) {
  const artifact = JSON.parse(readFileSync(toolReliabilityV1Path, "utf8")) as {
    caseCount?: unknown;
    cases?: unknown;
  };
  check(
    "ToolReliability v1 artifact mirrors canonical pack",
    artifact.caseCount === TOOL_RELIABILITY_V0_1_CASES.length &&
      Array.isArray(artifact.cases) &&
      artifact.cases.length === TOOL_RELIABILITY_V0_1_CASES.length,
    artifact
  );
  if (Array.isArray(artifact.cases)) {
    check(
      "ToolReliability v1 artifact validates",
      validateToolReliabilityCasePack(
        artifact.cases as typeof TOOL_RELIABILITY_V0_1_CASES
      ).valid,
      artifact
    );
  }
}

for (const fixturePath of [
  "benchmarks/workbench/v0/workbench-ts-cli-csv.json",
  "benchmarks/workbench/v0/fixtures/workbench-ts-cli-csv-0001/package.json",
  "benchmarks/workbench/v0/fixtures/workbench-ts-cli-csv-0001/src/report.mjs",
  "benchmarks/workbench/v0/fixtures/workbench-ts-cli-csv-0001/verifier.mjs",
]) {
  check(`WorkBench fixture exists: ${fixturePath}`, existsSync(resolve(fixturePath)));
}

const workBenchV1CasesDir = resolve("benchmarks", "workbench", "v1", "cases");
const workBenchV1FixturesDir = resolve("benchmarks", "workbench", "v1", "fixtures");
check("WorkBench v1 cases directory exists", existsSync(workBenchV1CasesDir));
check("WorkBench v1 fixtures directory exists", existsSync(workBenchV1FixturesDir));
if (existsSync(workBenchV1CasesDir) && existsSync(workBenchV1FixturesDir)) {
  const caseFiles = readdirSync(workBenchV1CasesDir)
    .filter((file) => file.endsWith(".json"))
    .sort();
  const languageCounts = new Map<string, number>();
  check("WorkBench v1 has 10 fixture cases", caseFiles.length === 10, caseFiles);
  for (const file of caseFiles) {
    const artifactPath = join(workBenchV1CasesDir, file);
    const raw = readFileSync(artifactPath, "utf8");
    const artifact = JSON.parse(raw) as {
      fixtureLanguage?: unknown;
      caseHash?: unknown;
      referenceSolutionNotes?: unknown;
      negativeControlWrongSolution?: unknown;
    };
    const loaded = loadWorkBenchCaseFromJson(raw);
    const language =
      typeof artifact.fixtureLanguage === "string"
        ? artifact.fixtureLanguage
        : "unknown";
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);
    const fixtureId = loaded.repo.url.replace(/^fixture:\/\//, "");
    check(
      `WorkBench v1 ${loaded.id} has stable hash`,
      artifact.caseHash === createWorkBenchCaseHash(loaded),
      artifact
    );
    check(
      `WorkBench v1 ${loaded.id} has reference and negative controls`,
      typeof artifact.referenceSolutionNotes === "string" &&
        artifact.referenceSolutionNotes.length > 20 &&
        typeof artifact.negativeControlWrongSolution === "string" &&
        artifact.negativeControlWrongSolution.length > 20,
      artifact
    );
    for (const requiredFixtureFile of [
      "reference-solution.md",
      "verifier-result.json",
      "negative-control.json",
      "verifier.mjs",
    ]) {
      check(
        `WorkBench v1 ${loaded.id} fixture has ${requiredFixtureFile}`,
        existsSync(join(workBenchV1FixturesDir, fixtureId, requiredFixtureFile))
      );
    }
  }
  check("WorkBench v1 language mix has 3 TypeScript cases", languageCounts.get("typescript") === 3, Object.fromEntries(languageCounts));
  check("WorkBench v1 language mix has 2 Python cases", languageCounts.get("python") === 2, Object.fromEntries(languageCounts));
  check("WorkBench v1 language mix has 2 Go cases", languageCounts.get("go") === 2, Object.fromEntries(languageCounts));
  check("WorkBench v1 language mix has 1 Rust case", languageCounts.get("rust") === 1, Object.fromEntries(languageCounts));
  check("WorkBench v1 language mix has 2 React UI cases", languageCounts.get("react-ui") === 2, Object.fromEntries(languageCounts));
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
