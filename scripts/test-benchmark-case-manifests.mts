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
