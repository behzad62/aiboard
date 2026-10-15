/*
 * Leaderboard rows must name WHICH packs/cases they came from.
 * Run: npx tsx scripts/test-benchmark-leaderboard-case-titles.mts
 *
 * A certified leaderboard row is a (team x tracks) aggregate. The TRACK column
 * alone ("WorkBench") does not say which challenges the row ran, so
 * CertifiedRunScore now carries `caseTitles`: the row's case ids resolved to
 * their case-record titles, unique, in first-appearance order, falling back to
 * the raw id when no case record is present. These checks guard that contract at
 * the aggregate layer (the UI shortens prefixes for display only).
 */
import {
  dedupeCrossTrackAttempts,
} from "../lib/benchmark/scoring/aggregate";
import { aggregateCompletedResultSetFixtures } from "./benchmark-result-set-test-fixtures";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

function attempt(
  id: string,
  teamCompositionId: string,
  track: BenchmarkAttemptV2["track"],
  caseId: string,
  overrides: Partial<BenchmarkAttemptV2> = {}
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId,
    teamCompositionId,
    mode: "certified",
    track,
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: "2026-07-02T10:00:00.000Z",
    completedAt: "2026-07-02T10:01:00.000Z",
    verifiedQuality: 0.9,
    jobSuccessScore: 90,
    efficiencyScore: 90,
    costUsd: 0.01,
    inputTokens: 100,
    outputTokens: 50,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1000,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "test",
    promptSetVersion: "test",
    scoringVersion: "certified-v0.1",
    ...overrides,
  };
}

function certifiedCase(
  id: string,
  track: BenchmarkCaseV2["track"],
  title: string,
  tags: string[] = []
): BenchmarkCaseV2 {
  return {
    id,
    schemaVersion: 2,
    track,
    title,
    description: `${track} case`,
    difficulty: "medium",
    tags,
    caseVersion: "test",
    createdAt: "2026-07-02T10:00:00.000Z",
    updatedAt: "2026-07-02T10:00:00.000Z",
    prompt: { userRequest: "Do the task" },
    environment: {
      type: "local-runner",
      timeoutSeconds: 600,
      network: "dependency-only",
    },
    verifier: { scorer: "verifier-json" },
    budget: {},
    scoring: { scoringVersion: "certified-v0.1", primary: "verified_quality" },
    contamination: {
      originalTask: true,
      canary: "test",
      referenceSolutionPrivate: true,
    },
  };
}

function soloTeam(id: string, modelId: string): BenchmarkTeamComposition {
  return {
    id,
    name: modelId,
    comboHash: `solo:${modelId}`,
    roles: [
      {
        role: "single",
        slot: "single",
        modelId,
        providerId: "test",
        displayName: modelId,
        temperature: 0,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// (1) Titles are resolved from case records, unique, and in first-appearance
//     order. A repeated case (two attempts, same case) lists its title once.
// ---------------------------------------------------------------------------
const parserRepair = certifiedCase(
  "workbench-parser-repair-01",
  "workbench",
  "Certified WorkBench v1: Parser Repair"
);
const cacheEviction = certifiedCase(
  "workbench-cache-eviction-01",
  "workbench",
  "Certified WorkBench v1: Cache Eviction"
);
const teamA = soloTeam("solo-a", "model:a");

const rowsBasic = aggregateCompletedResultSetFixtures({
  // Cache eviction appears first, then parser repair twice (repeat).
  attempts: [
    attempt("a1", teamA.id, "workbench", cacheEviction.id),
    attempt("a2", teamA.id, "workbench", parserRepair.id),
    attempt("a3", teamA.id, "workbench", parserRepair.id),
  ],
  cases: [parserRepair, cacheEviction],
  teamCompositions: [teamA],
  verifierResults: [],
});
const rowA = rowsBasic.find((r) => r.teamCompositionId === teamA.id);
check(
  "row carries caseTitles resolved from case records",
  rowA != null && Array.isArray(rowA.caseTitles),
  rowA?.caseTitles
);
check(
  "caseTitles are unique and in first-appearance order (cache eviction before parser repair, once each)",
  JSON.stringify(rowA?.caseTitles) ===
    JSON.stringify([
      "Certified WorkBench v1: Cache Eviction",
      "Certified WorkBench v1: Parser Repair",
    ]),
  rowA?.caseTitles
);
check(
  "full (unshortened) titles are kept in the data",
  rowA?.caseTitles.every((t) => t.startsWith("Certified WorkBench v1:")) === true,
  rowA?.caseTitles
);

// ---------------------------------------------------------------------------
// (2) Missing case record -> fall back to the raw case id.
// ---------------------------------------------------------------------------
const teamB = soloTeam("solo-b", "model:b");
const rowsMissing = aggregateCompletedResultSetFixtures({
  attempts: [
    attempt("b1", teamB.id, "workbench", parserRepair.id),
    attempt("b2", teamB.id, "workbench", "workbench-orphan-case-99"),
  ],
  // parserRepair record present, orphan record absent.
  cases: [parserRepair],
  teamCompositions: [teamB],
  verifierResults: [],
});
const rowB = rowsMissing.find((r) => r.teamCompositionId === teamB.id);
check(
  "missing case record falls back to the raw case id",
  JSON.stringify(rowB?.caseTitles) ===
    JSON.stringify(["Certified WorkBench v1: Parser Repair", "workbench-orphan-case-99"]),
  rowB?.caseTitles
);

// ---------------------------------------------------------------------------
// (3) A merged cross-track row unions its (deduped) case titles. The
//     source-tagged re-wrap drops the teamiq sample, so the surviving
//     toolreliability case supplies the title; a genuinely-distinct second
//     track case adds its own title.
// ---------------------------------------------------------------------------
const sourcedTool = certifiedCase(
  "toolrel-sourced-case-01",
  "toolreliability",
  "Certified ToolReliability v1: Stale Patch",
  ["sourced", "source:teamiq-scenario-42"]
);
const sourceTeamiq = certifiedCase(
  "teamiq-scenario-42",
  "teamiq",
  "Certified TeamIQ v1: Stale Patch Coordination"
);
const toolCase = certifiedCase(
  "workbench-parser-repair-02",
  "workbench",
  "Certified WorkBench v1: Parser Repair"
);
const teamC = soloTeam("solo-c", "model:c");
const mergedCases = [sourcedTool, sourceTeamiq, toolCase];
const mergedAttempts = [
  // Same decision via two tracks (source-tag overlap) -> dedups to the
  // toolreliability sample; only its title should survive for that decision.
  attempt("c-primary", teamC.id, "toolreliability", sourcedTool.id),
  attempt("c-teamiq", teamC.id, "teamiq", sourceTeamiq.id),
  // A genuinely distinct workbench case -> its title is added.
  attempt("c-tool", teamC.id, "workbench", toolCase.id),
];

// Unscoped evidence is audit-only and must not be cross-track deduplicated.
const deduped = dedupeCrossTrackAttempts(mergedAttempts, mergedCases);
check(
  "cross-track dedup preserves evidence without snapshot identity",
  deduped.some((a) => a.id === "c-primary") &&
    deduped.some((a) => a.id === "c-teamiq") &&
    deduped.some((a) => a.id === "c-tool"),
  deduped.map((a) => a.id)
);

const rowsMerged = aggregateCompletedResultSetFixtures({
  attempts: mergedAttempts,
  cases: mergedCases,
  teamCompositions: [teamC],
  verifierResults: [],
});
const rowC = rowsMerged.find((r) => r.teamCompositionId === teamC.id);
check(
  "merged cross-track row unions titles of its deduped decisions",
  JSON.stringify(rowC?.caseTitles) ===
    JSON.stringify([
      "Certified ToolReliability v1: Stale Patch",
      "Certified WorkBench v1: Parser Repair",
    ]),
  rowC?.caseTitles
);
check(
  "merged row does not list the dropped teamiq re-wrap title",
  rowC?.caseTitles.includes("Certified TeamIQ v1: Stale Patch Coordination") === false,
  rowC?.caseTitles
);

// ---------------------------------------------------------------------------
// (4) Two different case ids that resolve to the SAME title collapse to one
//     entry (title-level dedup), still in first-appearance order.
// ---------------------------------------------------------------------------
const dupTitleA = certifiedCase("dup-a", "workbench", "Shared Pack Name");
const dupTitleB = certifiedCase("dup-b", "workbench", "Shared Pack Name");
const teamD = soloTeam("solo-d", "model:d");
const rowsDupTitle = aggregateCompletedResultSetFixtures({
  attempts: [
    attempt("d1", teamD.id, "workbench", dupTitleA.id),
    attempt("d2", teamD.id, "workbench", dupTitleB.id),
  ],
  cases: [dupTitleA, dupTitleB],
  teamCompositions: [teamD],
  verifierResults: [],
});
const rowD = rowsDupTitle.find((r) => r.teamCompositionId === teamD.id);
check(
  "distinct ids resolving to the same title collapse to one caseTitle entry",
  JSON.stringify(rowD?.caseTitles) === JSON.stringify(["Shared Pack Name"]),
  rowD?.caseTitles
);
// The `cases` count still reflects the two distinct case ids.
check(
  "cases count still counts distinct case ids even when titles collapse",
  rowD?.cases === 2,
  rowD?.cases
);

// ---------------------------------------------------------------------------
// (5) Many-case bundle stays fully enumerated in data (UI applies +N pattern).
// ---------------------------------------------------------------------------
const teamE = soloTeam("solo-e", "model:e");
const manyCases = Array.from({ length: 7 }, (_, i) =>
  certifiedCase(`bundle-case-${i}`, "workbench", `Bundle Case ${i}`)
);
const rowsMany = aggregateCompletedResultSetFixtures({
  attempts: manyCases.map((c, i) =>
    attempt(`e${i}`, teamE.id, "workbench", c.id)
  ),
  cases: manyCases,
  teamCompositions: [teamE],
  verifierResults: [],
});
const rowE = rowsMany.find((r) => r.teamCompositionId === teamE.id);
check(
  "all case titles are retained in the data for a many-case bundle",
  rowE?.caseTitles.length === 7 &&
    JSON.stringify(rowE?.caseTitles) ===
      JSON.stringify(manyCases.map((c) => c.title)),
  rowE?.caseTitles
);

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
