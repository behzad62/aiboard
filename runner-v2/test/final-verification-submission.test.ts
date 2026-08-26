import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import type { EvidenceFact } from "../src/evidence-store.js";
import {
  type FinalVerificationBrowserEventsFact,
  type FinalVerificationBrowserScreenshotFact,
  type FinalVerificationBrowserSnapshotFact,
  type FinalVerificationCommandFact,
  type FinalVerificationPlan,
  type FinalVerificationRun,
} from "../src/final-verification-runtime.js";
import {
  createSubmitFinalVerificationTool,
  submit_final_verification,
} from "../src/final-verification-submission.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";

const TARGET_REVISION = "a".repeat(40);
const OTHER_REVISION = "b".repeat(40);

test("submit_final_verification accepts one exact, current four-category generation", async () => {
  const fixture = await createFixture();
  try {
    const submission = await submit_final_verification(
      { plan: fixture.plan, run: fixture.run },
      {
        evidenceStore: fixture.evidence,
        artifacts: fixture.artifacts,
        currentIntegrationRevision: () => TARGET_REVISION,
        clock: () => "2026-08-26T00:00:02.000Z",
      },
    );

    assert.equal(submission.kind, "final_verification_submission");
    assert.equal(submission.generationId, fixture.run.generationId);
    assert.equal(submission.taskId, fixture.run.taskId);
    assert.equal(submission.attempt, 1);
    assert.equal(submission.targetRevision, TARGET_REVISION);
    assert.equal(submission.green, true);
    assert.deepEqual(
      submission.checks.map((check) => check.category),
      ["build", "tests", "runtime_smoke", "browser"],
    );
    assert.equal(submission.checks.length, 4);
    assert.equal(Object.isFrozen(submission), true);
    assert.equal(Object.isFrozen(submission.plan), true);
    assert.equal(Object.isFrozen(submission.checks), true);
    assert.equal("changeSet" in submission, false);
    assert.equal("completionDecision" in submission, false);

    const tool = createSubmitFinalVerificationTool({
      evidenceStore: fixture.evidence,
      artifacts: fixture.artifacts,
      currentIntegrationRevision: () => TARGET_REVISION,
      clock: () => "2026-08-26T00:00:02.000Z",
    });
    assert.equal(tool.definition.name, "submit_final_verification");
    assert.equal(tool.definition.lifecycle, true);
    assert.equal(tool.validate({ plan: fixture.plan, run: fixture.run }).ok, true);
  } finally {
    fixture.evidence.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("submission rejects omitted and duplicate final-verification categories", async () => {
  const fixture = await createFixture();
  try {
    const omittedPlan = {
      checks: fixture.plan.checks.filter((check) => check.category !== "browser"),
    };
    await assert.rejects(
      () => submit_final_verification({ plan: omittedPlan, run: fixture.run }, options(fixture)),
      /missing.*browser/i,
    );

    const duplicatePlan: FinalVerificationPlan = {
      checks: [
        ...fixture.plan.checks,
        { category: "build", status: "required" },
      ],
    };
    await assert.rejects(
      () => submit_final_verification({ plan: duplicatePlan, run: fixture.run }, options(fixture)),
      /duplicate.*build/i,
    );

    const omittedRun = cloneRun(fixture.run);
    omittedRun.checks = omittedRun.checks.filter((check) => check.category !== "browser");
    await assert.rejects(
      () => submit_final_verification({ plan: fixture.plan, run: omittedRun }, options(fixture)),
      /missing|four categories|exactly once/i,
    );
  } finally {
    fixture.evidence.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("submission rereads integration revision and rejects a stale target", async () => {
  const fixture = await createFixture();
  try {
    await assert.rejects(
      () => submit_final_verification(
        { plan: fixture.plan, run: fixture.run },
        {
          ...options(fixture),
          currentIntegrationRevision: () => OTHER_REVISION,
        },
      ),
      /stale|integration revision|target revision/i,
    );
  } finally {
    fixture.evidence.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("submission rejects fabricated, foreign, and artifact-only evidence citations", async () => {
  const fixture = await createFixture();
  try {
    const fabricated = cloneRun(fixture.run);
    const build = fabricated.checks.find((check) => check.category === "build");
    assert.ok(build);
    const buildFact = build.facts[0] as FinalVerificationCommandFact;
    buildFact.stdoutArtifactHash = "c".repeat(64);
    await assert.rejects(
      () => submit_final_verification({ plan: fixture.plan, run: fabricated }, options(fixture)),
      /authoritative|fact|evidence/i,
    );

    const foreign = cloneRun(fixture.run);
    const tests = foreign.checks.find((check) => check.category === "tests");
    assert.ok(tests);
    tests.evidenceIds[0] = fixture.foreignEvidenceId;
    await assert.rejects(
      () => submit_final_verification({ plan: fixture.plan, run: foreign }, options(fixture)),
      /foreign|evidence|authoritative/i,
    );

    const staleGeneration = cloneRun(fixture.run);
    staleGeneration.generationId = "final-verification:stale-generation";
    await assert.rejects(
      () => submit_final_verification({ plan: fixture.plan, run: staleGeneration }, options(fixture)),
      /generation|authoritative|evidence/i,
    );

    const artifactOnly = cloneRun(fixture.run);
    const runtime = artifactOnly.checks.find((check) => check.category === "runtime_smoke");
    assert.ok(runtime);
    runtime.evidenceIds = [];
    await assert.rejects(
      () => submit_final_verification({ plan: fixture.plan, run: artifactOnly }, options(fixture)),
      /evidence|citation|runtime_smoke/i,
    );
  } finally {
    fixture.evidence.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("submission rejects non-green required results and missing browser/runtime evidence", async () => {
  const fixture = await createFixture();
  try {
    const nonGreen = cloneRun(fixture.run);
    const build = nonGreen.checks.find((check) => check.category === "build");
    assert.ok(build);
    build.green = false;
    build.issues = ["build failed"];
    await assert.rejects(
      () => submit_final_verification({ plan: fixture.plan, run: nonGreen }, options(fixture)),
      /green|non-zero|issue|required/i,
    );

    const missingBrowser = cloneRun(fixture.run);
    const browser = missingBrowser.checks.find((check) => check.category === "browser");
    assert.ok(browser);
    browser.facts = browser.facts.filter((fact) => fact.kind !== "browser_screenshot");
    browser.evidenceIds = browser.evidenceIds.slice(0, 2);
    await assert.rejects(
      () => submit_final_verification({ plan: fixture.plan, run: missingBrowser }, options(fixture)),
      /browser|screenshot|evidence/i,
    );

    const missingRuntime = cloneRun(fixture.run);
    const runtime = missingRuntime.checks.find((check) => check.category === "runtime_smoke");
    assert.ok(runtime);
    runtime.facts = [];
    runtime.evidenceIds = [];
    await assert.rejects(
      () => submit_final_verification({ plan: fixture.plan, run: missingRuntime }, options(fixture)),
      /runtime_smoke|evidence/i,
    );

    const wrongRequestedUrl = cloneRun(fixture.run);
    const snapshot = wrongRequestedUrl.checks.find((check) => check.category === "browser")!.facts[0] as FinalVerificationBrowserSnapshotFact;
    snapshot.requestedUrl = "http://127.0.0.1:4173/forged";
    await assert.rejects(
      () => submit_final_verification({ plan: fixture.plan, run: wrongRequestedUrl }, options(fixture)),
      /requested URL|runner-inspected/i,
    );
  } finally {
    fixture.evidence.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("submission preserves validated not-applicable rationale and inspection", async () => {
  const fixture = await createFixture();
  try {
    const rationale = "This fixture has no build script.";
    const inspection = { paths: ["package.json"], summary: rationale };
    const plan: FinalVerificationPlan = {
      checks: fixture.plan.checks.map((check) => check.category === "build"
        ? {
            category: "build" as const,
            status: "not_applicable" as const,
            rationale,
            repositoryInspection: inspection,
          }
        : check),
    };
    const run = cloneRun(fixture.run);
    run.plan = plan;
    const build = run.checks.find((check) => check.category === "build");
    assert.ok(build);
    build.status = "not_applicable";
    build.green = true;
    build.rationale = rationale;
    build.repositoryInspection = inspection;
    build.evidenceIds = [];
    build.facts = [];
    build.issues = [];
    run.executionProfile.detectedSignals = run.executionProfile.detectedSignals.filter(
      (signal) => signal.category !== "build",
    );
    delete run.executionProfile.commands.build;
    const submission = await submit_final_verification({ plan, run }, options(fixture));
    const submittedBuild = submission.checks.find((check) => check.category === "build");
    assert.ok(submittedBuild);
    assert.equal(submittedBuild.status, "not_applicable");
    assert.equal(submittedBuild.rationale, rationale);
    assert.deepEqual(submittedBuild.repositoryInspection, inspection);
  } finally {
    fixture.evidence.close();
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

interface Fixture {
  root: string;
  evidence: SqliteEvidenceStore;
  artifacts: ArtifactStore;
  plan: FinalVerificationPlan;
  run: FinalVerificationRun;
  foreignEvidenceId: string;
}

async function createFixture(): Promise<Fixture> {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 final verification submission "));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const actor = { role: "architect" as const, id: "submission-test" };
  const workspacePath = join(root, "verification workspace with spaces");
  const plan: FinalVerificationPlan = {
    checks: [
      { category: "build", status: "required" },
      { category: "tests", status: "required" },
      { category: "runtime_smoke", status: "required" },
      { category: "browser", status: "required" },
    ],
  };
  const generationId = `final-verification:submission-run:${TARGET_REVISION}`;
  const commandStdout = (await artifacts.put(Buffer.from("ok\n"), "text/plain", "stdout")).hash;
  const commandStderr = (await artifacts.put(Buffer.from(""), "text/plain", "stderr")).hash;
  const html = (await artifacts.put(Buffer.from("<main>ok</main>"), "text/html", "snapshot")).hash;
  const screenshot = (await artifacts.put(Buffer.from("png"), "image/png", "screenshot")).hash;
  const events = (await artifacts.put(Buffer.from("{\"console\":[],\"network\":[]}"), "application/json", "events")).hash;
  const state = { revision: TARGET_REVISION, status: "" };
  const commandFact = (category: "build" | "tests" | "runtime_smoke", label: string): FinalVerificationCommandFact => ({
    kind: "command",
    category,
    label,
    executable: "node",
    command: "node",
    args: ["-e", "process.stdout.write('ok')"],
    cwd: workspacePath,
    startedAt: "2026-08-26T00:00:00.000Z",
    finishedAt: "2026-08-26T00:00:01.000Z",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    stdoutArtifactHash: commandStdout,
    stderrArtifactHash: commandStderr,
    repositoryRevision: TARGET_REVISION,
    targetRevision: TARGET_REVISION,
    startState: state,
    endState: state,
    ...(category === "runtime_smoke" ? {
      endpoint: "http://127.0.0.1:4173/health",
      readinessSatisfied: true,
      cleanupRequested: true,
      cleanupSucceeded: true,
    } : {}),
  });
  const snapshot: FinalVerificationBrowserSnapshotFact = {
    kind: "browser_snapshot",
    category: "browser",
    label: "browser acceptance",
    url: "http://127.0.0.1:4173/health?space=hello%20world",
    requestedUrl: "http://127.0.0.1:4173/health?space=hello%20world",
    title: "Fixture",
    capturedAt: "2026-08-26T00:00:01.000Z",
    htmlArtifactHash: html,
    htmlBytes: 15,
    truncated: false,
    sessionId: "submission-run:final-verification",
    startedAt: "2026-08-26T00:00:00.000Z",
    finishedAt: "2026-08-26T00:00:01.000Z",
    targetRevision: TARGET_REVISION,
    startState: state,
    endState: state,
  };
  const browserScreenshot: FinalVerificationBrowserScreenshotFact = {
    kind: "browser_screenshot",
    category: "browser",
    label: "browser acceptance",
    capturedAt: "2026-08-26T00:00:01.000Z",
    screenshotArtifactHash: screenshot,
    mediaType: "image/png",
    byteLength: 3,
    sessionId: "submission-run:final-verification",
    url: snapshot.url,
    requestedUrl: snapshot.requestedUrl,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    targetRevision: TARGET_REVISION,
    startState: state,
    endState: state,
  };
  const browserEvents: FinalVerificationBrowserEventsFact = {
    kind: "browser_events",
    category: "browser",
    label: "browser acceptance",
    capturedAt: "2026-08-26T00:00:01.000Z",
    eventsArtifactHash: events,
    consoleEventCount: 0,
    consoleErrorCount: 0,
    networkEventCount: 0,
    networkFailureCount: 0,
    sessionId: "submission-run:final-verification",
    url: snapshot.url,
    requestedUrl: snapshot.requestedUrl,
    startedAt: snapshot.startedAt,
    finishedAt: snapshot.finishedAt,
    targetRevision: TARGET_REVISION,
    startState: state,
    endState: state,
    consoleErrors: [],
    pageErrors: [],
    failedNetworkEvents: [],
    policyViolations: [],
    timedOut: false,
    cancelled: false,
  };
  const facts: Array<{ category: "build" | "tests" | "runtime_smoke" | "browser"; fact: EvidenceFact; index: number }> = [
    { category: "build", fact: commandFact("build", "build"), index: 0 },
    { category: "tests", fact: commandFact("tests", "tests"), index: 0 },
    { category: "runtime_smoke", fact: commandFact("runtime_smoke", "runtime"), index: 0 },
    { category: "browser", fact: snapshot, index: 0 },
    { category: "browser", fact: browserScreenshot, index: 1 },
    { category: "browser", fact: browserEvents, index: 2 },
  ];
  const records = facts.map(({ category, fact, index }) => evidence.record({
    runId: "submission-run",
    taskId: "final-verification",
    actor,
    fact,
    createdAt: "2026-08-26T00:00:01.000Z",
    idempotencyKey: `${generationId}:1:${category}:${index}`,
    attempt: 1,
  }));
  const byCategory = (category: "build" | "tests" | "runtime_smoke" | "browser") => records
    .filter((record) => (record.fact as unknown as { category?: string }).category === category)
    .map((record) => record.id);
  const checks = [
    { category: "build" as const, status: "required" as const, green: true, evidenceIds: byCategory("build"), facts: [facts[0].fact as FinalVerificationCommandFact], issues: [] },
    { category: "tests" as const, status: "required" as const, green: true, evidenceIds: byCategory("tests"), facts: [facts[1].fact as FinalVerificationCommandFact], issues: [] },
    { category: "runtime_smoke" as const, status: "required" as const, green: true, evidenceIds: byCategory("runtime_smoke"), facts: [facts[2].fact as FinalVerificationCommandFact], issues: [] },
    { category: "browser" as const, status: "required" as const, green: true, evidenceIds: byCategory("browser"), facts: [snapshot, browserScreenshot, browserEvents], issues: [] },
  ];
  const foreign = evidence.record({
    runId: "foreign-run",
    taskId: "foreign-task",
    actor,
    fact: facts[0].fact,
    createdAt: "2026-08-26T00:00:01.000Z",
    idempotencyKey: "foreign-evidence",
    attempt: 1,
  });
  return {
    root,
    evidence,
    artifacts,
    plan,
    foreignEvidenceId: foreign.id,
    run: {
      generationId,
      runId: "submission-run",
      taskId: "final-verification",
      attempt: 1,
      plan,
      executionProfile: {
        version: 1,
        targetRevision: TARGET_REVISION,
        inspectedPaths: ["package.json"],
        detectedSignals: [
          { category: "build", source: "fixture", detail: "build" },
          { category: "tests", source: "fixture", detail: "tests" },
          { category: "runtime_smoke", source: "fixture", detail: "runtime" },
          { category: "browser", source: "fixture", detail: "browser" },
        ],
        commands: {
          build: [{ label: "build", executable: "node", args: ["-e", "process.stdout.write('ok')"] }],
          tests: [{ label: "tests", executable: "node", args: ["-e", "process.stdout.write('ok')"] }],
        },
        runtimeSmoke: {
          label: "runtime",
          executable: "node",
          args: ["-e", "process.stdout.write('ok')"],
          endpoint: "http://127.0.0.1:4173/health",
          readiness: { expectedStatus: 200 },
        },
        browser: { label: "browser acceptance", url: snapshot.requestedUrl, policy: {} },
      },
      targetRevision: TARGET_REVISION,
      workspacePath,
      startedAt: "2026-08-26T00:00:00.000Z",
      finishedAt: "2026-08-26T00:00:01.000Z",
      checks,
      green: true,
    } as FinalVerificationRun,
  };
}

function options(fixture: Fixture) {
  return {
    evidenceStore: fixture.evidence,
    artifacts: fixture.artifacts,
    currentIntegrationRevision: () => TARGET_REVISION,
    clock: () => "2026-08-26T00:00:02.000Z",
  };
}

function cloneRun(run: FinalVerificationRun): FinalVerificationRun {
  return JSON.parse(JSON.stringify(run)) as FinalVerificationRun;
}
