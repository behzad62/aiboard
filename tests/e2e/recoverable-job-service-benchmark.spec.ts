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

test("Recoverable Job Service pack exposes its exact public scope and readiness gate", async ({
  page,
}) => {
  await page.goto("/benchmark");
  await page.getByText("Advanced: run a single suite or pack", { exact: true }).click();

  await page.getByRole("combobox", { name: "Track" }).click();
  await page.getByRole("option", { name: "WorkBench" }).click();
  await page.getByRole("combobox", { name: "WorkBench case pack" }).click();
  await page
    .getByRole("option", { name: "Recoverable Job Service", exact: true })
    .focus();
  await page.keyboard.press("Enter");

  await expect(page.getByText("Published evaluation scope", { exact: true })).toBeVisible();
  await expect(page.getByText(/69 mandatory families/)).toBeVisible();
  await expect(page.getByText(/302 variants/)).toBeVisible();
  await expect(page.getByText(/11 model-visible files/)).toBeVisible();
  await expect(page.getByText(/Binary scoring/)).toBeVisible();
  await expect(page.getByText("node verify.mjs", { exact: true })).toBeVisible();
  await expect(page.getByText("Recoverable Job Service runtime not checked", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Download Recoverable Job Service runner" })
  ).toHaveAttribute("href", "/aiboard-rjs-workbench-runner.zip");
  await expect(page.getByText(/Requires Node\.js 24\.18\.0/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Run selected benchmark" })).toBeDisabled();
});

test("qualified calibration evidence survives import, reload, history, clause display, and export", async ({ page }) => {
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
  await expect(page.getByText("Qualified calibration fixture — not a model score", { exact: true }).first()).toBeVisible();
  const historyButton = page.getByRole("button", { name: "2 runs" }).filter({ visible: true }).first();
  await historyButton.click();
  await expect(historyButton).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator('tbody tr[data-result-set-id]')).toHaveCount(1);
  const profileButton = page.getByRole("button", { name: "View profile" }).filter({ visible: true }).first();
  await profileButton.click();
  const profileId = await profileButton.getAttribute("aria-controls");
  const profile = page.locator(`#${profileId}`);
  await expect(profile.getByText("Recoverable Job Service evidence", { exact: true })).toBeVisible();
  await expect(profile.getByText(/69\/69 mandatory families passed/)).toBeVisible();
  await expect(profile.getByText(/302\/302 variants passed/)).toBeVisible();
  await expect(profile.getByText(/A01/).first()).toBeVisible();

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
