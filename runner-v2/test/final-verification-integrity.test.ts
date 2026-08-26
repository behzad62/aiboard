import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { BuildRuntime } from "../src/build-runtime.js";
import type { FinalVerificationCommandFact } from "../src/final-verification-runtime.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

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
    assert.throws(() => fixture.store.append(event), /required.*evidence|missing evidence/i);
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
  validateCleanupReceipt?: () => void;
} = {}) {
  const root = mkdtempSync(join(tmpdir(), "runner-v2 verification integrity "));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const database = join(root, "scheduler.sqlite");
  const store = new SqliteSchedulerStore(database, {
    evidenceStore: evidence,
    artifacts,
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
      plan: {
        checks: [
          ...["build", "tests", "runtime_smoke", "browser"].map((category) => ({
            category,
            ...(category !== "build" || options.allNotApplicable
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
  return {
    root,
    artifacts,
    evidence,
    store,
    close() {
      store.close();
      evidence.close();
      rmSync(root, { recursive: true, force: true });
    },
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
    cwd: process.cwd(),
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

function checkEvent(fact: FinalVerificationCommandFact, evidenceId: string) {
  return {
    runId: RUN_ID,
    type: "final_verification.check_completed" as const,
    occurredAt: "2026-08-26T00:00:04.000Z",
    actor: { role: "runner" as const, id: "runtime" },
    idempotencyKey: `${GENERATION_ID}:check:build`,
    payload: {
      taskId: TASK_ID,
      generationId: GENERATION_ID,
      targetRevision: REVISION,
      attempt: 1,
      workspacePath: "C:/verification",
      startedAt: "2026-08-26T00:00:03.000Z",
      finishedAt: "2026-08-26T00:00:04.000Z",
      result: {
        category: "build",
        status: "required",
        green: true,
        evidenceIds: [evidenceId],
        facts: [fact],
        issues: [],
      },
    },
  };
}
