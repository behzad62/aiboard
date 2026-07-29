import { expect, test, type Locator } from "@playwright/test";
import { withCompletedResultSetFixtures } from "../../scripts/benchmark-result-set-test-fixtures";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkReportBundleV2,
  BenchmarkTeamComposition,
} from "../../lib/benchmark/types";

const configurationKey = () => fixture.resultSets[0]!.configurationKey;

const benchmarkCase: BenchmarkCaseV2 = {
  id: "history-case",
  schemaVersion: 2,
  track: "gameiq",
  title: "History interaction case",
  description: "Local browser-only result history fixture.",
  difficulty: "easy",
  tags: ["e2e"],
  caseVersion: "case-v3",
  createdAt: "2026-07-20T08:00:00.000Z",
  updatedAt: "2026-07-20T08:00:00.000Z",
  prompt: { userRequest: "Use the imported deterministic result." },
  environment: {
    type: "browser",
    timeoutSeconds: 1,
    network: "none",
  },
  verifier: { scorer: "rule-checker" },
  budget: {},
  scoring: {
    scoringVersion: "score-v5",
    primary: "verified_quality",
  },
  contamination: {
    originalTask: true,
    canary: "history-e2e-canary",
    referenceSolutionPrivate: false,
  },
};

const team: BenchmarkTeamComposition = {
  id: "history-model",
  name: "History Model",
  comboHash: "history-model-medium",
  strategy: "solo",
  roles: [
    {
      role: "single",
      slot: "single",
      providerId: "account",
      modelId: "gpt-history",
      displayName: "History Model",
      reasoningEffort: "medium",
      temperature: 0,
      maxTokens: 4096,
    },
  ],
};

const attempts: BenchmarkAttemptV2[] = Array.from(
  { length: 8 },
  (_, index) => {
    const day = String(20 + index).padStart(2, "0");
    const completedAt = `2026-07-${day}T10:00:00.000Z`;
    return {
      id: `history-attempt-${index + 1}`,
      runId: `history-run-${index + 1}`,
      caseId: benchmarkCase.id,
      teamCompositionId: team.id,
      mode: "certified",
      track: "gameiq",
      harnessProfile: "raw-single-model",
      status: "passed",
      startedAt: completedAt,
      completedAt,
      verifiedQuality: 0.6 + index / 100,
      jobSuccessScore: 60 + index,
      efficiencyScore: 70 + index,
      costUsd: null,
      inputTokens: 100 + index,
      outputTokens: 20 + index,
      modelCalls: 1,
      toolCalls: 0,
      durationMs: 1000 + index,
      artifactIds: [],
      traceIds: [],
      failureIds: [],
      harnessVersion: "harness-v2",
      promptSetVersion: "prompt-v2",
      scoringVersion: benchmarkCase.scoring.scoringVersion,
    };
  }
);

const fixture = withCompletedResultSetFixtures({
  caseV2: [benchmarkCase],
  attemptsV2: attempts,
  verifierResults: [],
  teamCompositions: [team],
  harnessCertifications: [],
});

const bundle: BenchmarkReportBundleV2 = {
  version: 2,
  exportedAt: "2026-07-29T12:00:00.000Z",
  suites: [],
  runs: fixture.runs,
  cases: [],
  attempts: [],
  metricValues: [],
  artifacts: fixture.artifacts,
  failures: fixture.failures,
  traces: fixture.traces,
  caseV2: fixture.caseV2,
  attemptsV2: fixture.attemptsV2,
  verifierResults: fixture.verifierResults,
  runEvents: fixture.runEvents,
  toolCallTraces: fixture.toolCallTraces,
  teamCompositions: fixture.teamCompositions,
  harnessCertifications: fixture.harnessCertifications,
  resultSets: fixture.resultSets,
};

const orderedSets = [...fixture.resultSets].sort(
  (left, right) =>
    Date.parse(right.completedAt!) - Date.parse(left.completedAt!) ||
    right.id.localeCompare(left.id)
);
const latestId = orderedSets[0]!.id;
const olderIds = orderedSets.slice(1).map((resultSet) => resultSet.id);
const singleResultSet = orderedSets[0]!;
const singleAttemptIds = new Set(
  fixture.attemptsV2
    .filter((attempt) => attempt.resultSetId === singleResultSet.id)
    .map((attempt) => attempt.id)
);
const singleBundle: BenchmarkReportBundleV2 = {
  ...bundle,
  runs: fixture.runs.filter((run) => singleResultSet.runIds.includes(run.id)),
  attemptsV2: fixture.attemptsV2.filter((attempt) =>
    singleAttemptIds.has(attempt.id)
  ),
  verifierResults: fixture.verifierResults.filter((result) =>
    singleAttemptIds.has(result.attemptId)
  ),
  resultSets: [singleResultSet],
};

test("imported snapshot history supports real keyboard, pagination, profile, and guarded deletion interactions", async ({
  page,
}) => {
  await page.goto("/benchmark");
  await page.getByRole("tab", { name: "Data" }).click();
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .setInputFiles({
      name: "benchmark-history-e2e.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(bundle)),
    });
  await expect(page.getByText(/Imported \d+ run\(s\)/)).toBeVisible();

  await page.reload();
  await page.getByRole("tab", { name: "Results" }).click();
  await expect(page.getByText("History Model", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("max 4,096 tokens").first()).toBeVisible();
  await expect(page.getByText(/case-v3/).first()).toBeVisible();
  await expect(page.getByText(/score-v5/).first()).toBeVisible();

  const desktopRuns = visible(page.getByRole("button", { name: "8 runs" }));
  await desktopRuns.focus();
  await page.keyboard.press("Enter");
  await expect(desktopRuns).toHaveAttribute("aria-expanded", "true");

  const desktopHistory = page.locator(
    'tbody tr[data-result-set-id]'
  );
  await expect(desktopHistory).toHaveCount(5);
  expect(
    await desktopHistory.evaluateAll((rows) =>
      rows.map((row) => row.getAttribute("data-result-set-id"))
    )
  ).toEqual(olderIds.slice(0, 5));
  await visible(page.getByRole("button", { name: "Show more" })).click();
  await expect(desktopHistory).toHaveCount(7);
  expect(await desktopHistory.evaluateAll((rows) =>
    rows.map((row) => row.getAttribute("data-result-set-id"))
  )).toEqual(olderIds);

  const profileTargetId = olderIds[0]!;
  const profileButton = page
    .locator(`tbody tr[data-result-set-id="${profileTargetId}"]`)
    .getByRole("button", { name: "View profile" });
  await profileButton.focus();
  await page.keyboard.press("Enter");
  const profileId = await profileButton.getAttribute("aria-controls");
  await expect(page.locator(`#${profileId}`)).toBeVisible();
  const closeProfile = page
    .locator(`#${profileId}`)
    .getByRole("button", { name: "Close evidence profile" });
  await closeProfile.focus();
  await page.keyboard.press("Enter");
  await expect(profileButton).toBeFocused();

  let dialogCount = 0;
  page.on("dialog", async (dialog) => {
    dialogCount += 1;
    expect(dialog.message()).toContain("History Model");
    await dialog.accept();
  });
  const deleteTarget = page
    .locator(`tbody tr[data-result-set-id="${profileTargetId}"]`)
    .getByRole("button", { name: "Delete snapshot" });
  await deleteTarget.focus();
  await deleteTarget.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.click();
  });
  await expect(
    page.locator(`tr[data-result-set-id="${profileTargetId}"]`)
  ).toHaveCount(0);
  await expect(page.getByText("Deleted the snapshot.", { exact: true })).toBeVisible();
  expect(dialogCount).toBe(1);
  await expect(
    page.locator(`tr[data-result-set-id="${olderIds[1]}"]`)
  ).toHaveCount(1);
  await expect(
    page.locator(`button[data-result-set-id="${latestId}"]`).filter({
      visible: true,
    })
  ).toHaveCount(2);
  await expect(
    page.locator(
      `[data-focus-return="desktop:${configurationKey()}"]:focus`
    )
  ).toHaveCount(1);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileRuns = visible(page.getByRole("button", { name: "7 runs" }));
  await expect(mobileRuns).toHaveAttribute("aria-expanded", "true");
  const mobileHistory = page.locator('ul.md\\:hidden > li[data-result-set-id]');
  await expect(mobileHistory).toHaveCount(6);
  await expect(
    page
      .locator(`ul.md\\:hidden > li[data-result-set-id="${olderIds[1]}"]`)
      .getByRole("button", { name: "View profile" })
  ).toBeVisible();

  const latestDelete = visible(
    page.locator(
      `button[aria-label="Delete snapshot"][data-result-set-id="${latestId}"]`
    )
  );
  await latestDelete.focus();
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(
      "Deleted the snapshot. The previous completed run is now latest.",
      { exact: true }
    )
  ).toBeVisible();
  expect(dialogCount).toBe(2);
});

test("deleting a sole latest snapshot does not claim predecessor promotion", async ({
  page,
}) => {
  await page.goto("/benchmark");
  await page.getByRole("tab", { name: "Data" }).click();
  await page
    .locator('input[type="file"][accept="application/json,.json"]')
    .setInputFiles({
      name: "benchmark-single-snapshot-e2e.json",
      mimeType: "application/json",
      buffer: Buffer.from(JSON.stringify(singleBundle)),
    });
  await expect(page.getByText(/Imported \d+ run\(s\)/)).toBeVisible();
  await page.reload();
  await page.getByRole("tab", { name: "Results" }).click();

  let dialogCount = 0;
  page.on("dialog", async (dialog) => {
    dialogCount += 1;
    await dialog.accept();
  });
  await visible(
    page.locator(
      `button[aria-label="Delete snapshot"][data-result-set-id="${singleResultSet.id}"]`
    )
  ).click();
  await expect(page.getByText("Deleted the snapshot.", { exact: true })).toBeVisible();
  await expect(
    page.getByText(
      "Deleted the snapshot. The previous completed run is now latest.",
      { exact: true }
    )
  ).toHaveCount(0);
  await expect(
    page.locator(`button[data-result-set-id="${singleResultSet.id}"]`)
  ).toHaveCount(0);
  expect(dialogCount).toBe(1);
});

function visible(locator: Locator): Locator {
  return locator.filter({ visible: true }).first();
}
