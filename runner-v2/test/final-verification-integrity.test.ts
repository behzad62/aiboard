import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { BuildRuntime } from "../src/build-runtime.js";
import type {
  FinalVerificationBrowserEventsFact,
  FinalVerificationBrowserScreenshotFact,
  FinalVerificationBrowserSnapshotFact,
  FinalVerificationCommandFact,
} from "../src/final-verification-runtime.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import {
  acceptFinalVerificationProfile,
  emptyFinalVerificationProfile,
} from "./support/final-verification-profile.js";

const RUN_ID = "final-verification-integrity";
const TASK_ID = "final-verification-task";
const GENERATION_ID = "final-verification-generation";
const REVISION = "a".repeat(40);

test("scheduler rejects a forged final-verification fact despite a matching evidence row", async () => {
  const fixture = await createFixture();
  try {
    const fact = await commandFact(fixture.artifacts);
    const malformed = { ...fact, startState: undefined } as unknown as FinalVerificationCommandFact;
    const record = fixture.evidence.record({
      runId: RUN_ID,
      taskId: TASK_ID,
      actor: { role: "architect", id: "forger" },
      fact: malformed,
      createdAt: "2026-08-26T00:00:04.000Z",
      idempotencyKey: `${GENERATION_ID}:1:build:0`,
      attempt: 1,
    });

    assert.throws(
      () => fixture.store.append(checkEvent(malformed, record.id)),
      /fact|state|schema|invalid/i,
    );
  } finally {
    fixture.close();
  }
});

test("scheduler rejects a forged green required check with no evidence", async () => {
  const fixture = await createFixture();
  try {
    const event = checkEvent(await commandFact(fixture.artifacts), "unused");
    event.payload.result.evidenceIds = [];
    event.payload.result.facts = [];
    assert.throws(
      () => fixture.store.append(event),
      /required.*evidence|missing evidence|requires exactly.*command facts/i,
    );
  } finally {
    fixture.close();
  }
});

test("scheduler rejects a self-consistent alternate command chain", async () => {
  const fixture = await createFixture();
  try {
    const fact = { ...(await commandFact(fixture.artifacts)), args: ["-e", "process.exit(99)"] };
    const record = fixture.evidence.record({
      runId: RUN_ID,
      taskId: TASK_ID,
      actor: { role: "architect", id: "forged-runtime" },
      fact,
      createdAt: "2026-08-26T00:00:04.000Z",
      idempotencyKey: `${GENERATION_ID}:1:build:0`,
      attempt: 1,
    });
    assert.throws(
      () => fixture.store.append(checkEvent(fact, record.id)),
      /exact runner-inspected command|execution profile|conflicts/i,
    );
  } finally {
    fixture.close();
  }
});

test("scheduler rejects a self-consistent nonzero-but-green chain", async () => {
  const fixture = await createFixture();
  try {
    const fact = { ...(await commandFact(fixture.artifacts)), exitCode: 7 };
    const record = fixture.evidence.record({
      runId: RUN_ID,
      taskId: TASK_ID,
      actor: { role: "architect", id: "forged-runtime" },
      fact,
      createdAt: "2026-08-26T00:00:04.000Z",
      idempotencyKey: `${GENERATION_ID}:1:build:0`,
      attempt: 1,
    });
    assert.throws(
      () => fixture.store.append(checkEvent(fact, record.id)),
      /non-green process semantics|exit/i,
    );
  } finally {
    fixture.close();
  }
});

test("scheduler append recomputes browser policy from captured events", async () => {
  const fixture = await createFixture({ requiredCategory: "browser" });
  try {
    const facts = await browserFacts(fixture.artifacts, {
      consoleEventCount: 1,
      consoleErrorCount: 1,
      consoleErrors: [{
        type: "error",
        text: "forged append console failure",
        source: "console",
        occurredAt: "2026-08-26T00:00:03.500Z",
      }],
      policyViolations: [],
    });
    const evidenceIds = facts.map((fact, index) => fixture.evidence.record({
      runId: RUN_ID,
      taskId: TASK_ID,
      actor: { role: "architect", id: "forged-browser" },
      fact,
      createdAt: "2026-08-26T00:00:04.000Z",
      idempotencyKey: `${GENERATION_ID}:1:browser:${index}`,
      attempt: 1,
    }).id);
    assert.throws(
      () => fixture.store.append(browserCheckEvent(facts, evidenceIds)),
      /policy violation|console error/i,
    );
  } finally {
    fixture.close();
  }
});

test("scheduler replay recomputes browser policy after durable event tampering", async () => {
  const fixture = await createFixture({ requiredCategory: "browser" });
  try {
    const facts = await browserFacts(fixture.artifacts);
    const records = facts.map((fact, index) => fixture.evidence.record({
      runId: RUN_ID,
      taskId: TASK_ID,
      actor: { role: "architect", id: "browser" },
      fact,
      createdAt: "2026-08-26T00:00:04.000Z",
      idempotencyKey: `${GENERATION_ID}:1:browser:${index}`,
      attempt: 1,
    }));
    fixture.store.append(browserCheckEvent(facts, records.map((record) => record.id)));
    fixture.closeStore();
    fixture.closeEvidence();

    const consoleFailure = {
      type: "error", text: "forged replay console failure", source: "console",
      occurredAt: "2026-08-26T00:00:03.500Z",
    };
    const raw = new DatabaseSync(fixture.database);
    const schedulerRow = raw.prepare(
      "SELECT payload_json FROM scheduler_events WHERE event_type = 'final_verification.check_completed'",
    ).get() as { payload_json: string };
    const schedulerPayload = JSON.parse(schedulerRow.payload_json) as {
      result: { facts: Array<Record<string, unknown>> };
    };
    Object.assign(schedulerPayload.result.facts[2]!, {
      consoleEventCount: 1,
      consoleErrorCount: 1,
      consoleErrors: [consoleFailure],
      policyViolations: [],
    });
    raw.prepare(
      "UPDATE scheduler_events SET payload_json = ? WHERE event_type = 'final_verification.check_completed'",
    ).run(JSON.stringify(schedulerPayload));
    raw.close();

    const rawEvidence = new DatabaseSync(join(fixture.root, "evidence.sqlite"));
    const evidenceRow = rawEvidence.prepare(
      "SELECT fact_json FROM evidence_records WHERE idempotency_key = ?",
    ).get(`${GENERATION_ID}:1:browser:2`) as { fact_json: string };
    const evidenceFact = JSON.parse(evidenceRow.fact_json) as Record<string, unknown>;
    Object.assign(evidenceFact, {
      consoleEventCount: 1,
      consoleErrorCount: 1,
      consoleErrors: [consoleFailure],
      policyViolations: [],
    });
    rawEvidence.prepare(
      "UPDATE evidence_records SET fact_json = ? WHERE idempotency_key = ?",
    ).run(JSON.stringify(evidenceFact), `${GENERATION_ID}:1:browser:2`);
    rawEvidence.close();

    const restartedEvidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
    const restarted = new SqliteSchedulerStore(fixture.database, {
      evidenceStore: restartedEvidence,
      artifacts: fixture.artifacts,
      validateExecutionProfile: acceptFinalVerificationProfile,
    });
    try {
      assert.throws(
        () => restarted.readRun(RUN_ID),
        /policy violation|console error/i,
      );
    } finally {
      restarted.close();
      restartedEvidence.close();
    }
  } finally {
    fixture.close();
  }
});

test("scheduler append requires explicit successful runtime cleanup", async () => {
  for (const cleanupSucceeded of [undefined, false] as const) {
    const fixture = await createFixture({ requiredCategory: "runtime_smoke" });
    try {
      const fact = await runtimeSmokeFact(fixture.artifacts, cleanupSucceeded);
      const record = fixture.evidence.record({
        runId: RUN_ID,
        taskId: TASK_ID,
        actor: { role: "architect", id: "forged-runtime" },
        fact,
        createdAt: "2026-08-26T00:00:04.000Z",
        idempotencyKey: `${GENERATION_ID}:1:runtime_smoke:0`,
        attempt: 1,
      });
      assert.throws(
        () => fixture.store.append(checkEvent(fact, record.id)),
        /cleanup.*success|cleanupSucceeded|runtime_smoke/i,
      );
    } finally {
      fixture.close();
    }
  }
});

test("scheduler replay revalidates explicit runtime cleanup success", async () => {
  const fixture = await createFixture({ requiredCategory: "runtime_smoke" });
  try {
    const fact = await runtimeSmokeFact(fixture.artifacts, true);
    const record = fixture.evidence.record({
      runId: RUN_ID,
      taskId: TASK_ID,
      actor: { role: "architect", id: "runtime" },
      fact,
      createdAt: "2026-08-26T00:00:04.000Z",
      idempotencyKey: `${GENERATION_ID}:1:runtime_smoke:0`,
      attempt: 1,
    });
    fixture.store.append(checkEvent(fact, record.id));
    fixture.closeStore();
    fixture.closeEvidence();

    const raw = new DatabaseSync(fixture.database);
    const row = raw.prepare(
      "SELECT payload_json FROM scheduler_events WHERE event_type = 'final_verification.check_completed'",
    ).get() as { payload_json: string };
    const payload = JSON.parse(row.payload_json) as {
      result: { facts: Array<Record<string, unknown>> };
    };
    payload.result.facts[0]!.cleanupSucceeded = false;
    raw.prepare(
      "UPDATE scheduler_events SET payload_json = ? WHERE event_type = 'final_verification.check_completed'",
    ).run(JSON.stringify(payload));
    raw.close();

    const rawEvidence = new DatabaseSync(join(fixture.root, "evidence.sqlite"));
    const evidenceRow = rawEvidence.prepare(
      "SELECT fact_json FROM evidence_records WHERE idempotency_key = ?",
    ).get(`${GENERATION_ID}:1:runtime_smoke:0`) as { fact_json: string };
    const evidenceFact = JSON.parse(evidenceRow.fact_json) as Record<string, unknown>;
    evidenceFact.cleanupSucceeded = false;
    rawEvidence.prepare(
      "UPDATE evidence_records SET fact_json = ? WHERE idempotency_key = ?",
    ).run(JSON.stringify(evidenceFact), `${GENERATION_ID}:1:runtime_smoke:0`);
    rawEvidence.close();

    const restartedEvidence = new SqliteEvidenceStore(join(fixture.root, "evidence.sqlite"));
    const restarted = new SqliteSchedulerStore(fixture.database, {
      evidenceStore: restartedEvidence,
      artifacts: fixture.artifacts,
      validateExecutionProfile: acceptFinalVerificationProfile,
    });
    try {
      assert.throws(() => restarted.readRun(RUN_ID), /cleanup.*success|cleanupSucceeded|runtime_smoke/i);
    } finally {
      restarted.close();
      restartedEvidence.close();
    }
  } finally {
    fixture.close();
  }
});

test("scheduler revalidates exact evidence facts and artifact integrity after restart", async () => {
  const fixture = await createFixture();
  try {
    const fact = await commandFact(fixture.artifacts);
    const record = fixture.evidence.record({
      runId: RUN_ID,
      taskId: TASK_ID,
      actor: { role: "architect", id: "runtime" },
      fact,
      createdAt: "2026-08-26T00:00:04.000Z",
      idempotencyKey: `${GENERATION_ID}:1:build:0`,
      attempt: 1,
    });
    const forged = { ...fact, label: "forged but plausible" };
    assert.throws(
      () => fixture.store.append(checkEvent(forged, record.id)),
      /authoritative|evidence|fact/i,
    );

    fixture.store.append(checkEvent(fact, record.id));
    await fixture.artifacts.remove(fact.stdoutArtifactHash);
    assert.throws(
      () => fixture.store.readRun(RUN_ID),
      /artifact.*not found|missing|integrity/i,
    );
  } finally {
    fixture.close();
  }
});

test("scheduler restart rejects a corrupt final-verification artifact", async () => {
  const fixture = await createFixture();
  try {
    const fact = await commandFact(fixture.artifacts);
    const record = fixture.evidence.record({
      runId: RUN_ID,
      taskId: TASK_ID,
      actor: { role: "architect", id: "runtime" },
      fact,
      createdAt: "2026-08-26T00:00:04.000Z",
      idempotencyKey: `${GENERATION_ID}:1:build:0`,
      attempt: 1,
    });
    fixture.store.append(checkEvent(fact, record.id));
    const artifact = await fixture.artifacts.stat(fact.stderrArtifactHash);
    writeFileSync(artifact.path, "corrupt");
    assert.throws(() => fixture.store.readRun(RUN_ID), /artifact.*hash mismatch|integrity/i);
  } finally {
    fixture.close();
  }
});

test("a forged end-to-end event chain cannot claim cleanup without an authentic owned receipt", async () => {
  const fixture = await createFixture({
    allNotApplicable: true,
    validateCleanupReceipt: () => {
      throw new Error("Final verification cleanup receipt is missing.");
    },
  });
  try {
    const runtime = new BuildRuntime({
      runId: RUN_ID,
      store: fixture.store,
      evidenceStore: fixture.evidence,
      artifacts: fixture.artifacts,
      finalVerificationDriver: {
        executeCheck: async ({ category, plan }) => ({
          workspacePath: "C:/verification",
          startedAt: "2026-08-26T00:00:03.000Z",
          finishedAt: "2026-08-26T00:00:04.000Z",
          check: {
            ...plan.checks.find((check) => check.category === category)!,
            green: true,
            evidenceIds: [],
            facts: [],
            issues: [],
          },
        }),
      },
      finalVerificationCleanupDriver: { cleanup: async () => ({}) },
      workerDriver: { run: async () => ({ type: "failed", reason: "unused" }) },
      architectDriver: { run: async () => undefined },
      integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: REVISION }) },
      maxConcurrency: 1,
      workspaceFor: async () => "C:/unused",
    });
    for (let index = 0; index < 5; index += 1) await runtime.step();
    assert.deepEqual(await runtime.step(), {
      status: "idle",
      action: "final_verification_cleanup_failed",
    });
    assert.equal(runtime.projection().finalVerification?.current?.cleanup?.status, "failed");
    assert.equal(
      fixture.store.readRun(RUN_ID).some((event) => event.type === "final_verification.cleanup_succeeded"),
      false,
    );
  } finally {
    fixture.close();
  }
});

async function createFixture(options: {
  allNotApplicable?: boolean;
  requiredCategory?: "build" | "runtime_smoke" | "browser";
  validateCleanupReceipt?: () => void;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 verification integrity "));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const database = join(root, "scheduler.sqlite");
  const store = new SqliteSchedulerStore(database, {
    evidenceStore: evidence,
    artifacts,
    validateExecutionProfile: acceptFinalVerificationProfile,
    ...(options.validateCleanupReceipt
      ? { validateCleanupReceipt: options.validateCleanupReceipt }
      : {}),
  });
  store.append({
    runId: RUN_ID,
    type: "run.initialized",
    occurredAt: "2026-08-26T00:00:00.000Z",
    actor: { role: "runner", id: "runner" },
    idempotencyKey: "run:init",
    payload: {},
  });
  store.append({
    runId: RUN_ID,
    type: "plan.created",
    occurredAt: "2026-08-26T00:00:01.000Z",
    actor: { role: "architect", id: "architect" },
    idempotencyKey: "plan:one",
    payload: { revision: 1, tasks: [] },
  });
  store.append({
    runId: RUN_ID,
    type: "integration.revision_advanced",
    occurredAt: "2026-08-26T00:00:02.000Z",
    actor: { role: "runner", id: "integration" },
    idempotencyKey: "integration:one",
    payload: { integrationRevision: REVISION },
  });
  store.append({
    runId: RUN_ID,
    type: "final_verification.generation_created",
    occurredAt: "2026-08-26T00:00:03.000Z",
    actor: { role: "runner", id: "runtime" },
    idempotencyKey: "verification:generation",
    payload: {
      taskId: TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      planVersion: 1,
      executionProfile: options.allNotApplicable
        ? emptyFinalVerificationProfile(REVISION)
        : options.requiredCategory === "runtime_smoke"
          ? runtimeExecutionProfile()
          : options.requiredCategory === "browser"
            ? browserExecutionProfile()
          : buildExecutionProfile(),
      plan: {
        checks: [
          ...["build", "tests", "runtime_smoke", "browser"].map((category) => ({
            category,
            ...(category !== (options.requiredCategory ?? "build") || options.allNotApplicable
              ? {
                  status: "not_applicable",
                  rationale: `No ${category} surface.`,
                  repositoryInspection: { paths: ["package.json"], summary: `No ${category} surface.` },
                }
              : { status: "required" }),
          })),
        ],
      },
    },
  });
  let storeClosed = false;
  let evidenceClosed = false;
  return {
    root,
    database,
    artifacts,
    evidence,
    store,
    closeStore() {
      if (!storeClosed) {
        store.close();
        storeClosed = true;
      }
    },
    closeEvidence() {
      if (!evidenceClosed) {
        evidence.close();
        evidenceClosed = true;
      }
    },
    close() {
      if (!storeClosed) store.close();
      if (!evidenceClosed) evidence.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function runtimeSmokeFact(
  artifacts: ArtifactStore,
  cleanupSucceeded: boolean | undefined,
): Promise<FinalVerificationCommandFact> {
  const base = await commandFact(artifacts);
  return {
    ...base,
    category: "runtime_smoke",
    label: "runtime_smoke",
    args: [],
    endpoint: "http://127.0.0.1:4173/",
    readinessSatisfied: true,
    cleanupRequested: true,
    ...(cleanupSucceeded === undefined ? {} : { cleanupSucceeded }),
  };
}

async function commandFact(artifacts: ArtifactStore): Promise<FinalVerificationCommandFact> {
  const stdout = await artifacts.put(Buffer.from("ok\n"), "text/plain", "stdout");
  const stderr = await artifacts.put(Buffer.from(""), "text/plain", "stderr");
  const state = { revision: REVISION, status: "" };
  return {
    kind: "command",
    category: "build",
    label: "build",
    executable: process.execPath,
    command: process.execPath,
    args: ["-e", "process.exit(0)"],
    cwd: "C:/verification",
    startedAt: "2026-08-26T00:00:03.000Z",
    finishedAt: "2026-08-26T00:00:04.000Z",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    stdoutArtifactHash: stdout.hash,
    stderrArtifactHash: stderr.hash,
    repositoryRevision: REVISION,
    targetRevision: REVISION,
    startState: state,
    endState: state,
  };
}

function buildExecutionProfile() {
  return {
    version: 1 as const,
    targetRevision: REVISION,
    inspectedPaths: ["package.json"],
    detectedSignals: [{ category: "build" as const, source: "fixture", detail: "build" }],
    commands: {
      build: [{
        label: "build",
        executable: process.execPath,
        args: ["-e", "process.exit(0)"],
      }],
    },
  };
}

function runtimeExecutionProfile() {
  return {
    version: 1 as const,
    targetRevision: REVISION,
    inspectedPaths: ["package.json"],
    detectedSignals: [{ category: "runtime_smoke" as const, source: "fixture", detail: "runtime" }],
    commands: {},
    runtimeSmoke: {
      label: "runtime_smoke",
      executable: process.execPath,
      args: [],
      endpoint: "http://127.0.0.1:4173/",
      readiness: { expectedStatus: 200 },
    },
  };
}

function browserExecutionProfile() {
  return {
    version: 1 as const,
    targetRevision: REVISION,
    inspectedPaths: ["package.json"],
    detectedSignals: [{ category: "browser" as const, source: "fixture", detail: "browser" }],
    commands: {},
    browser: {
      label: "browser",
      url: "http://127.0.0.1:4173/",
      policy: { consoleErrors: "fail" as const, pageErrors: "fail" as const, failedNetworkEvents: "fail" as const },
    },
  };
}

async function browserFacts(
  artifacts: ArtifactStore,
  eventOverrides: Partial<FinalVerificationBrowserEventsFact> = {},
): Promise<[FinalVerificationBrowserSnapshotFact, FinalVerificationBrowserScreenshotFact, FinalVerificationBrowserEventsFact]> {
  const html = await artifacts.put(Buffer.from("<main>ok</main>"), "text/html", "browser html");
  const screenshot = await artifacts.put(Buffer.from("png"), "image/png", "browser screenshot");
  const events = await artifacts.put(Buffer.from("{}"), "application/json", "browser events");
  const state = { revision: REVISION, status: "" };
  const common = {
    category: "browser" as const,
    label: "browser",
    capturedAt: "2026-08-26T00:00:04.000Z",
    sessionId: "browser-session",
    url: "http://127.0.0.1:4173/home",
    requestedUrl: "http://127.0.0.1:4173/",
    startedAt: "2026-08-26T00:00:03.000Z",
    finishedAt: "2026-08-26T00:00:04.000Z",
    targetRevision: REVISION,
    startState: state,
    endState: state,
  };
  return [{
    ...common,
    kind: "browser_snapshot",
    title: "fixture",
    htmlArtifactHash: html.hash,
    htmlBytes: 15,
    truncated: false,
  }, {
    ...common,
    kind: "browser_screenshot",
    screenshotArtifactHash: screenshot.hash,
    mediaType: "image/png",
    byteLength: 3,
  }, {
    ...common,
    kind: "browser_events",
    eventsArtifactHash: events.hash,
    consoleEventCount: 0,
    consoleErrorCount: 0,
    networkEventCount: 0,
    networkFailureCount: 0,
    consoleErrors: [],
    pageErrors: [],
    failedNetworkEvents: [],
    policyViolations: [],
    timedOut: false,
    cancelled: false,
    ...eventOverrides,
  }];
}

function checkEvent(fact: FinalVerificationCommandFact, evidenceId: string) {
  return {
    runId: RUN_ID,
    type: "final_verification.check_completed" as const,
    occurredAt: "2026-08-26T00:00:04.000Z",
    actor: { role: "runner" as const, id: "runtime" },
    idempotencyKey: `${GENERATION_ID}:check:${fact.category}`,
    payload: {
      taskId: TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      attempt: 1,
      workspacePath: "C:/verification",
      startedAt: "2026-08-26T00:00:03.000Z",
      finishedAt: "2026-08-26T00:00:04.000Z",
      result: {
        category: fact.category,
        status: "required",
        green: true,
        evidenceIds: [evidenceId],
        facts: [fact],
        issues: [],
      },
    },
  };
}

function browserCheckEvent(
  facts: readonly [FinalVerificationBrowserSnapshotFact, FinalVerificationBrowserScreenshotFact, FinalVerificationBrowserEventsFact],
  evidenceIds: string[],
) {
  return {
    runId: RUN_ID,
    type: "final_verification.check_completed" as const,
    occurredAt: "2026-08-26T00:00:04.000Z",
    actor: { role: "runner" as const, id: "runtime" },
    idempotencyKey: `${GENERATION_ID}:check:browser`,
    payload: {
      taskId: TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      attempt: 1,
      workspacePath: "C:/verification",
      startedAt: "2026-08-26T00:00:03.000Z",
      finishedAt: "2026-08-26T00:00:04.000Z",
      result: {
        category: "browser" as const,
        status: "required" as const,
        green: true,
        evidenceIds,
        facts,
        issues: [],
      },
    },
  };
}
