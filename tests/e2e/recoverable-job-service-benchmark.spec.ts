import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { withCompletedResultSetFixtures } from "../../scripts/benchmark-result-set-test-fixtures";
import { createRecoverableJobServiceCase } from "../../lib/benchmark/workbench/recoverable-job-service/case-pack";
import { toBenchmarkCaseV2 } from "../../lib/benchmark/workbench/case-loader";
import {
  createWorkBenchPublicContractArtifact,
  createWorkBenchVerifierArtifact,
} from "../../lib/benchmark/workbench/artifacts";
import type {
  BenchmarkAttemptV2,
  BenchmarkReportBundleV2,
  BenchmarkTeamComposition,
} from "../../lib/benchmark/types";

const calibratedCase = createRecoverableJobServiceCase();
const calibratedCaseV2 = toBenchmarkCaseV2(calibratedCase, "2026-09-21T05:30:00.000Z");
const calibratedAttemptId = "rjs-qualified-calibration-attempt";
const calibratedResult = JSON.parse(readFileSync(
  "benchmarks/recoverable-job-service/private/fixtures/qualified-calibration-verifier-result.json",
  "utf8"
));
const calibrationTeam: BenchmarkTeamComposition = {
  id: "rjs-qualified-calibration-fixture",
  name: "Qualified calibration fixture — not a model score",
  comboHash: "rjs-qualified-calibration-fixture",
  strategy: "solo",
  roles: [{
    role: "single",
    slot: "single",
    providerId: "fixture",
    modelId: "qualified-calibration-control",
    displayName: "Qualified calibration fixture — not a model score",
    reasoningEffort: "medium",
    temperature: 0,
    maxTokens: 1,
  }],
};
const calibrationAttempt: BenchmarkAttemptV2 = {
  id: calibratedAttemptId,
  runId: "rjs-qualified-calibration-run",
  caseId: calibratedCase.id,
  teamCompositionId: calibrationTeam.id,
  mode: "certified",
  track: "workbench",
  harnessProfile: "aiboard-build-single-worker",
  status: "passed",
  startedAt: "2026-09-21T05:30:00.000Z",
  completedAt: "2026-09-21T05:31:00.000Z",
  verifiedQuality: 1,
  jobSuccessScore: 100,
  efficiencyScore: 100,
  costUsd: null,
  inputTokens: 0,
  outputTokens: 0,
  modelCalls: 1,
  toolCalls: 0,
  durationMs: 60_000,
  artifactIds: [],
  traceIds: [],
  failureIds: [],
  harnessVersion: "qualified-calibration-fixture-v1",
  promptSetVersion: "rjs-contract-2.0.1",
  scoringVersion: calibratedCase.scoring.scoringVersion,
};
const olderCalibrationAttempt: BenchmarkAttemptV2 = {
  ...calibrationAttempt,
  id: "rjs-qualified-calibration-attempt-older",
  runId: "rjs-qualified-calibration-run-older",
  startedAt: "2026-09-20T05:30:00.000Z",
  completedAt: "2026-09-20T05:31:00.000Z",
};
const calibrationFixture = withCompletedResultSetFixtures({
  caseV2: [calibratedCaseV2],
  attemptsV2: [olderCalibrationAttempt, calibrationAttempt],
  verifierResults: [olderCalibrationAttempt, calibrationAttempt].map((attempt) => ({
      id: `${attempt.id}:verifier`,
      attemptId: attempt.id,
      caseId: calibratedCase.id,
      passed: true,
      score: 1,
      durationMs: 60_000,
      resultJson: JSON.stringify(calibratedResult),
      assertionResults: calibratedResult.assertions,
      artifactIds: [],
    })),
  teamCompositions: [calibrationTeam],
  harnessCertifications: [],
});
const calibrationArtifacts = calibrationFixture.attemptsV2.flatMap((attempt) => {
  if (!attempt.resultSetId) throw new Error(`Calibration attempt ${attempt.id} has no result set.`);
  const artifacts = [
    {
      ...createWorkBenchVerifierArtifact({
        id: `${attempt.id}:verifier-result`,
        attemptId: attempt.id,
        caseId: calibratedCase.id,
        result: calibratedResult,
      }),
      resultSetId: attempt.resultSetId,
    },
    {
      ...createWorkBenchPublicContractArtifact({
        id: `${attempt.id}:rjs-public-contract`,
        attemptId: attempt.id,
        case: calibratedCase,
      }),
      resultSetId: attempt.resultSetId,
    },
  ];
  attempt.artifactIds = artifacts.map((artifact) => artifact.id);
  const verifier = calibrationFixture.verifierResults.find(
    (candidate) => candidate.attemptId === attempt.id
  );
  if (!verifier) throw new Error(`Calibration verifier ${attempt.id} is missing.`);
  verifier.artifactIds = artifacts.map((artifact) => artifact.id);
  return artifacts;
});
const calibrationBundle: BenchmarkReportBundleV2 = {
  version: 2,
  exportedAt: "2026-09-21T05:32:00.000Z",
  suites: [],
  runs: calibrationFixture.runs,
  cases: [],
  attempts: [],
  metricValues: [],
  artifacts: calibrationArtifacts,
  failures: [],
  traces: [],
  caseV2: calibrationFixture.caseV2,
  attemptsV2: calibrationFixture.attemptsV2,
  verifierResults: calibrationFixture.verifierResults,
  runEvents: [],
  toolCallTraces: [],
  teamCompositions: calibrationFixture.teamCompositions,
  harnessCertifications: [],
  resultSets: calibrationFixture.resultSets,
};

// Recoverable Job Service runs as the HarnessBench preset since 959805e6; 516c7b6e removed the Advanced
// single-pack picker this test used to open.
test("Recoverable Job Service runs as the HarnessBench preset behind its readiness gate", async ({
  page,
}) => {
  await page.goto("/benchmark");
  await page.getByRole("tab", { name: "Run" }).click();

  const preset = page.getByRole("radio", { name: /^HarnessBench / });
  await expect(preset).toBeChecked();
  await expect(preset).toHaveAccessibleName(/Recoverable Job Service through the full Build workflow/);
  await expect(preset).toHaveAccessibleName(/All 69 modeled families and 302 variants must pass/);
  await expect(page.getByText("Recoverable Job Service runtime not checked", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download Recoverable Job Service runner" })
  ).toHaveAttribute("href", "/aiboard-rjs-workbench-runner.zip");
  await expect(page.getByText(/Requires Node\.js 24\.18\.0/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Run HarnessBench" })).toBeDisabled();
});

// WorkBench Recoverable Job Service evidence is historical since HarnessBench replaced it (959805e6,
// lib/benchmark/retired.ts): it stays stored and exportable but never feeds a leaderboard.
test("qualified calibration evidence survives import, reload, and export but stays out of results", async ({ page }) => {
  await page.goto("/benchmark");
  await page.getByRole("tab", { name: "Data" }).click();
  await page.locator('input[type="file"][accept="application/json,.json"]').setInputFiles({
    name: "rjs-qualified-calibration-fixture.json",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify(calibrationBundle)),
  });
  await expect(page.getByText(/Imported 2 run\(s\)/)).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Results" }).click();
  // Both runs stay visible as recorded outcomes, not ranked; nothing is published as a ranking.
  const outcomes = page.getByRole("region", { name: "Recorded benchmark outcomes" });
  await expect(outcomes.getByText(/Qualified calibration fixture — not a model score/).first()).toBeVisible();
  await expect(outcomes.getByText(/not ranked/).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "No published ranking" })).toBeVisible();

  await page.getByRole("tab", { name: "Data" }).click();
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export Benchmark Bundle" }).click();
  const exported = await download;
  const exportedPath = await exported.path();
  expect(exportedPath).not.toBeNull();
  const exportedBundle = JSON.parse(
    readFileSync(exportedPath!, "utf8")
  ) as BenchmarkReportBundleV2;
  const exportedVerifier = exportedBundle.verifierResults.find(
    (item) => item.attemptId === calibratedAttemptId
  );
  expect(exportedVerifier).toBeTruthy();
  if (!exportedVerifier) throw new Error("Exported calibration verifier is missing.");
  const exportedDiagnostics = JSON.parse(exportedVerifier.resultJson).recoverableJobService;
  expect(exportedDiagnostics.resolved).toBe(true);
  expect(exportedDiagnostics.families).toHaveLength(69);
  expect(exportedDiagnostics.provenance.variantIds).toHaveLength(302);
});
