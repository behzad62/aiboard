/* Benchmark case manifest checks (run: npx tsx scripts/test-benchmark-case-manifests.mts) */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createWorkBenchCaseHash,
  loadWorkBenchCaseFromJson,
  toBenchmarkCaseV2,
} from "../lib/benchmark/workbench/case-loader";
import {
  listGameIqScenarioPacks,
  stableGameIqScenarioPackDigest,
} from "../lib/benchmark/gameiq/packs";
import {
  TOOL_RELIABILITY_V0_1_CASES,
  validateToolReliabilityCasePack,
} from "../lib/benchmark/toolreliability/cases";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const benchmarksRoot = join(repoRoot, "benchmarks");
const docsRoot = join(repoRoot, "docs", "bench");

async function readJson(path: string): Promise<Record<string, unknown>> {
  const content = await readFile(path, "utf8");
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${path} must be a JSON object.`);
  }
  return parsed as Record<string, unknown>;
}

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

const gameIqV1Files = new Map([
  ["connect-four.json", { gameId: "connect-four", count: 40 }],
  ["chess.json", { gameId: "chess", count: 60 }],
  ["battleship.json", { gameId: "battleship", count: 25 }],
  ["codenames.json", { gameId: "codenames", count: 25 }],
  ["fireworks.json", { gameId: "fireworks", count: 20 }],
]);
const canonicalGamePacks = new Map(
  listGameIqScenarioPacks().map((pack) => [pack.gameId, pack])
);
for (const [file, expected] of gameIqV1Files) {
  const filePath = join(benchmarksRoot, "gameiq", "v1", file);
  check(`GameIQ v1 file exists: ${file}`, await exists(filePath));
  if (!(await exists(filePath))) continue;

  const artifact = await readJson(filePath);
  const pack = canonicalGamePacks.get(expected.gameId);
  const scenarios = Array.isArray(artifact.scenarios) ? artifact.scenarios : [];
  const scenarioIds = scenarios
    .map((scenario) =>
      scenario && typeof scenario === "object"
        ? (scenario as { id?: unknown }).id
        : undefined
    )
    .filter((id): id is string => typeof id === "string");
  check(`${file} has v1 pack metadata`, artifact.schemaVersion === 1 && artifact.track === "gameiq" && artifact.gameId === expected.gameId, artifact);
  check(`${file} contains expected scenario count`, scenarios.length === expected.count && artifact.scenarioCount === expected.count, {
    scenarioCount: artifact.scenarioCount,
    scenarios: scenarios.length,
    expected: expected.count,
  });
  check(`${file} scenario ids are unique`, new Set(scenarioIds).size === scenarioIds.length && scenarioIds.length === expected.count, scenarioIds);
  check(
    `${file} mirrors canonical implemented pack`,
    Boolean(
      pack &&
        artifact.packId === pack.id &&
        artifact.digest === stableGameIqScenarioPackDigest(pack) &&
        scenarioIds.every((id, index) => id === pack.scenarios[index]?.id)
    ),
    { packId: artifact.packId, digest: artifact.digest, scenarioIds }
  );
}

const toolReliabilityV1Path = join(benchmarksRoot, "toolreliability", "v1", "cases.json");
check("ToolReliability v1 cases file exists", await exists(toolReliabilityV1Path));
if (await exists(toolReliabilityV1Path)) {
  const artifact = await readJson(toolReliabilityV1Path);
  const cases = Array.isArray(artifact.cases) ? artifact.cases : [];
  const caseIds = cases
    .map((item) =>
      item && typeof item === "object" ? (item as { id?: unknown }).id : undefined
    )
    .filter((id): id is string => typeof id === "string");
  const validation = validateToolReliabilityCasePack(cases as typeof TOOL_RELIABILITY_V0_1_CASES);
  check(
    "ToolReliability v1 file has metadata and 75 cases",
    artifact.schemaVersion === 1 &&
      artifact.track === "toolreliability" &&
      artifact.caseCount === 75 &&
      cases.length === 75,
    { caseCount: artifact.caseCount, cases: cases.length }
  );
  check("ToolReliability v1 cases validate", validation.valid, validation);
  check(
    "ToolReliability v1 mirrors canonical implemented cases",
    caseIds.length === TOOL_RELIABILITY_V0_1_CASES.length &&
      caseIds.every((id, index) => id === TOOL_RELIABILITY_V0_1_CASES[index]?.id),
    caseIds
  );
}

const workbenchDir = join(benchmarksRoot, "workbench", "v0");
const workbenchFiles = (await readdir(workbenchDir))
  .filter((file) => file.endsWith(".json"))
  .sort();
const workbenchCases = [];
for (const file of workbenchFiles) {
  const raw = await readFile(join(workbenchDir, file), "utf8");
  const loaded = loadWorkBenchCaseFromJson(raw);
  const caseV2 = toBenchmarkCaseV2(loaded, "2026-06-27T10:00:00.000Z");
  workbenchCases.push(loaded);
  check(`${file} has stable WorkBench hash`, createWorkBenchCaseHash(loaded).startsWith("workbench:"), loaded.id);
  check(`${file} converts to v2 WorkBench case`, caseV2.schemaVersion === 2 && caseV2.track === "workbench", caseV2);
  check(`${file} has canary and private reference`, loaded.contamination.canary.startsWith("AIBENCH-") && loaded.contamination.referenceSolutionPrivate === true, loaded.contamination);
  check(`${file} uses honest command network mode`, loaded.environment.network === "dependency-only" && loaded.allowedCommands.length > 0, {
    network: loaded.environment.network,
    allowedCommands: loaded.allowedCommands,
  });
  if (loaded.repo.url.startsWith("fixture://")) {
    const fixtureId = loaded.repo.url.slice("fixture://".length);
    check(
      `${file} fixture directory exists`,
      await exists(join(workbenchDir, "fixtures", fixtureId)),
      loaded.repo.url
    );
  }
}
check("WorkBench v0 has at least one manifest", workbenchCases.length > 0, workbenchFiles);

const workbenchV1CasesDir = join(benchmarksRoot, "workbench", "v1", "cases");
const workbenchV1FixturesDir = join(benchmarksRoot, "workbench", "v1", "fixtures");
check("WorkBench v1 cases directory exists", await exists(workbenchV1CasesDir));
check("WorkBench v1 fixtures directory exists", await exists(workbenchV1FixturesDir));
if ((await exists(workbenchV1CasesDir)) && (await exists(workbenchV1FixturesDir))) {
  const v1CaseFiles = (await readdir(workbenchV1CasesDir))
    .filter((file) => file.endsWith(".json"))
    .sort();
  check("WorkBench v1 has 10 fixture case manifests", v1CaseFiles.length === 10, v1CaseFiles);

  const languageCounts = new Map<string, number>();
  for (const file of v1CaseFiles) {
    const filePath = join(workbenchV1CasesDir, file);
    const raw = await readFile(filePath, "utf8");
    const artifact = await readJson(filePath);
    const loaded = loadWorkBenchCaseFromJson(raw);
    const hash = createWorkBenchCaseHash(loaded);
    const fixtureId = loaded.repo.url.startsWith("fixture://")
      ? loaded.repo.url.slice("fixture://".length)
      : "";
    const fixtureDir = join(workbenchV1FixturesDir, fixtureId);
    const language =
      typeof artifact.fixtureLanguage === "string"
        ? artifact.fixtureLanguage
        : "unknown";
    languageCounts.set(language, (languageCounts.get(language) ?? 0) + 1);

    check(`${file} is a valid WorkBench case`, loaded.schemaVersion === 1 && loaded.id === file.replace(/\.json$/, ""), loaded);
    check(`${file} has a stable case hash`, artifact.caseHash === hash && hash.startsWith("workbench:"), {
      actual: artifact.caseHash,
      expected: hash,
    });
    check(
      `${file} has reference notes and negative control metadata`,
      typeof artifact.referenceSolutionNotes === "string" &&
        artifact.referenceSolutionNotes.length > 20 &&
        typeof artifact.negativeControlWrongSolution === "string" &&
        artifact.negativeControlWrongSolution.length > 20,
      {
        referenceSolutionNotes: artifact.referenceSolutionNotes,
        negativeControlWrongSolution: artifact.negativeControlWrongSolution,
      }
    );
    check(`${file} has canary contamination marker`, loaded.contamination.canary.startsWith("AIBENCH-WORKBENCH-"), loaded.contamination);
    check(`${file} fixture directory exists`, fixtureId.length > 0 && (await exists(fixtureDir)), loaded.repo.url);
    check(`${file} fixture has reference solution notes`, await exists(join(fixtureDir, "reference-solution.md")));
    check(`${file} fixture has verifier result JSON`, await exists(join(fixtureDir, "verifier-result.json")));
    check(`${file} fixture has negative control JSON`, await exists(join(fixtureDir, "negative-control.json")));
  }

  check("WorkBench v1 has 3 TypeScript cases", languageCounts.get("typescript") === 3, Object.fromEntries(languageCounts));
  check("WorkBench v1 has 2 Python cases", languageCounts.get("python") === 2, Object.fromEntries(languageCounts));
  check("WorkBench v1 has 2 Go cases", languageCounts.get("go") === 2, Object.fromEntries(languageCounts));
  check("WorkBench v1 has 1 Rust case", languageCounts.get("rust") === 1, Object.fromEntries(languageCounts));
  check("WorkBench v1 has 2 React UI cases", languageCounts.get("react-ui") === 2, Object.fromEntries(languageCounts));
}

const gameIqManifest = await readJson(join(benchmarksRoot, "gameiq", "v0", "index.json"));
const gameIqPackIds = new Set(listGameIqScenarioPacks().map((pack) => pack.id));
const referencedPackIds = stringArray(gameIqManifest.packIds);
check("GameIQ manifest references implemented packs", referencedPackIds.length > 0 && referencedPackIds.every((id) => gameIqPackIds.has(id)), {
  referencedPackIds,
  implemented: Array.from(gameIqPackIds),
});
check("GameIQ packs have stable digests", listGameIqScenarioPacks().every((pack) => stableGameIqScenarioPackDigest(pack).startsWith(`gameiq-v0.1:${pack.gameId}:`)));

const toolReliabilityManifest = await readJson(join(benchmarksRoot, "toolreliability", "v0", "index.json"));
const toolCaseIds = new Set(TOOL_RELIABILITY_V0_1_CASES.map((item) => item.id));
const referencedToolCaseIds = stringArray(toolReliabilityManifest.caseIds);
const toolValidation = validateToolReliabilityCasePack(TOOL_RELIABILITY_V0_1_CASES);
check("ToolReliability manifest references implemented cases", referencedToolCaseIds.length > 0 && referencedToolCaseIds.every((id) => toolCaseIds.has(id)), {
  referencedToolCaseIds,
  implemented: Array.from(toolCaseIds),
});
check("ToolReliability pack covers required metrics", toolValidation.valid, toolValidation);

const teamIqManifest = await readJson(join(benchmarksRoot, "teamiq", "v0", "index.json"));
const baselineRequirements = teamIqManifest.baselineRequirements;
const scenarioGroups = Array.isArray(teamIqManifest.scenarioGroups)
  ? teamIqManifest.scenarioGroups
  : [];
check(
  "TeamIQ manifest requires complete solo baselines",
  Boolean(
    baselineRequirements &&
      typeof baselineRequirements === "object" &&
      (baselineRequirements as { completeSoloBaselinesRequired?: unknown })
        .completeSoloBaselinesRequired === true
  ),
  baselineRequirements
);
check("TeamIQ manifest defines scenario groups", scenarioGroups.length >= 3, scenarioGroups);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}
