import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { BuildRuntime } from "../src/build-runtime.js";
import { withBuildCrew, type NativeBuildSpec } from "../src/build-spec.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

const spec: NativeBuildSpec = {
  version: 2,
  runId: "run_1",
  projectId: "project_1",
  objective: "Build a reliable application.",
  architectRuntimeId: "deepseek:flash",
  workerRuntimeIds: ["deepseek:flash"],
  verifierRuntimeIds: ["deepseek:flash", "openrouter:mimo"],
  alwaysRequireIndependentVerifier: false,
  maxConcurrency: 1,
  permissionProfile: "full",
  runPolicy: "finish",
  budgetLimits: {},
  createdAt: "2026-10-25T00:00:00.000Z",
  idempotencyKey: "build-spec:run_1",
};

const newCrew = {
  architectRuntimeId: "openai:architect",
  workerRuntimeIds: ["openai:worker-a", "openai:worker-b"],
  verifierRuntimeIds: ["openrouter:mimo", "openai:reviewer"],
  reviewerRuntimeId: "openai:reviewer",
};

test("a crew change retires every runtime that loses its role and keeps it as a candidate", () => {
  const next = withBuildCrew(spec, newCrew);
  assert.equal(next.architectRuntimeId, "openai:architect");
  assert.deepEqual(next.workerRuntimeIds, ["openai:worker-a", "openai:worker-b"]);
  assert.equal(next.reviewerRuntimeId, "openai:reviewer");
  assert.deepEqual(next.retiredRuntimeIds, ["deepseek:flash"], "mimo keeps a verifier role, so only flash retires");
  assert.equal(next.maxConcurrency, 2, "concurrency follows the worker count as at creation");
  assert.equal(next.idempotencyKey, spec.idempotencyKey);
  const back = withBuildCrew(next, { architectRuntimeId: "deepseek:flash", workerRuntimeIds: ["deepseek:flash"], verifierRuntimeIds: ["deepseek:flash"] });
  assert.deepEqual(back.retiredRuntimeIds?.sort(), ["openai:architect", "openai:reviewer", "openai:worker-a", "openai:worker-b", "openrouter:mimo"]);
  assert.equal(back.reviewerRuntimeId, undefined, "a crew without a Reviewer pick drops the old one");
  assert.throws(() => withBuildCrew(spec, { ...newCrew, reviewerRuntimeId: "openai:worker-a" }), /reviewer runtime must be one of its verifier/);
});

interface Fixture {
  root: string;
  manager: NativeBuildManager;
  specs: SqliteBuildSpecStore;
  created: NativeBuildSpec[];
  scheduler(): SqliteSchedulerStore;
  close(): Promise<void>;
}

async function fixture(options: { refuseCrew?: string; closeFailures?: number } = {}): Promise<Fixture> {
  let closeFailures = options.closeFailures ?? 0;
  const root = mkdtempSync(join(tmpdir(), "aiboard-crew-change-"));
  const schedulerPath = join(root, "scheduler.sqlite");
  const evidenceStore = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  const seed = new SqliteSchedulerStore(schedulerPath, { evidenceStore });
  seed.append({ runId: spec.runId, type: "run.initialized", occurredAt: "2026-10-25T00:00:00.500Z", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "run-initialized", payload: { objective: spec.objective } });
  seed.append({ runId: spec.runId, type: "architect.runtime_assigned", occurredAt: "2026-10-25T00:00:01.000Z", actor: { role: "user", id: "local-user" }, idempotencyKey: "architect:assigned", payload: { runtimeId: "deepseek:flash" } });
  // The tunnel run's leftover: a transient provider failure asked for an Architect handoff.
  seed.append({ runId: spec.runId, type: "architect.handoff_required", occurredAt: "2026-10-25T00:00:02.000Z", actor: { role: "runner", id: "runtime-router" }, idempotencyKey: "architect:handoff", payload: { reason: "fetch failed", requiredCapabilities: ["code"], candidateRuntimeIds: ["deepseek:flash"] } });
  seed.close();
  const savedSpecs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  savedSpecs.save(spec);
  savedSpecs.close();
  const specs = new SqliteBuildSpecStore(join(root, "builds.sqlite"));
  const created: NativeBuildSpec[] = [];
  let scheduler: SqliteSchedulerStore | undefined;
  const manager = new NativeBuildManager({
    specs,
    validateCrewSpec: (next) => {
      if (options.refuseCrew && next.workerRuntimeIds.includes(options.refuseCrew)) throw new Error(`Provider runtime ${options.refuseCrew} is not configured.`);
    },
    createRuntime: async (current) => {
      created.push(current);
      scheduler = new SqliteSchedulerStore(schedulerPath, { evidenceStore });
      const runtime = new BuildRuntime({
        runId: current.runId,
        initialObjective: current.objective,
        runPolicy: "finish",
        store: scheduler,
        evidenceStore,
        workerDriver: { run: async () => ({ type: "paused", reason: "unused" }) },
        architectDriver: { run: async () => undefined },
        integrationDriver: { integrate: async () => ({ status: "integrated", integrationRevision: "a".repeat(40) }) },
        maxConcurrency: current.maxConcurrency,
        workspaceFor: async () => "unused",
        // As in production: the verifier policy is configured from the spec on every construction.
        independentVerifier: {
          candidateRuntimeIds: [...current.verifierRuntimeIds],
          alwaysRequireIndependentVerifier: current.alwaysRequireIndependentVerifier,
          twoPass: true,
          assessRisk: async () => { throw new Error("unused"); },
          verify: async () => { throw new Error("unused"); },
        },
      });
      const store = scheduler;
      return {
        runtime,
        usage: () => { throw new Error("unused"); },
        observability: async () => { throw new Error("unused"); },
        transcript: async () => ({ turns: [], cursor: 0 }),
        files: async () => { throw new Error("unused"); },
        compact: async () => undefined,
        projectHandoff: async () => { throw new Error("unused"); },
        cleanup: async () => undefined,
        close: async () => {
          if (closeFailures > 0) {
            closeFailures -= 1;
            throw new AggregateError([new Error("Subprocess inv-1 cleanup remains unverified in orphaned.")], "Could not close all native Build handle resources.");
          }
          store.close();
        },
      };
    },
  });
  await manager.recover();
  return {
    root, manager, specs, created,
    scheduler: () => scheduler!,
    close: async () => {
      await manager.close();
      evidenceStore.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("the owner changes a paused run's models: recorded, spec rewritten, runtime rebuilt", async () => {
  const f = await fixture();
  try {
    assert.equal(f.manager.projection(spec.runId).status, "paused");
    assert.equal(f.created.length, 1);
    const projection = await f.manager.changeCrew(spec.runId, newCrew, "crew:1");
    assert.equal(projection.status, "paused", "a crew change never resumes the run");
    assert.deepEqual(projection.runtime.architect, { runtimeId: "openai:architect" }, "the new Architect takes over and the stale handoff closes");
    assert.equal(f.created.length, 2, "the runtime was rebuilt");
    assert.deepEqual(f.created[1]!.workerRuntimeIds, newCrew.workerRuntimeIds);
    assert.deepEqual(f.specs.get(spec.runId).retiredRuntimeIds, ["deepseek:flash"]);
    assert.deepEqual(projection.verifierPolicy?.candidateRuntimeIds, newCrew.verifierRuntimeIds, "the recorded verifier policy follows the crew");
    assert.equal(projection.verifierPolicy?.twoPass, true);
    const changes = f.manager.events(spec.runId).filter((event) => event.type === "run.crew_changed");
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.actor.role, "user");

    await f.manager.changeCrew(spec.runId, newCrew, "crew:2");
    assert.equal(f.created.length, 2, "the same crew again is a no-op");
    assert.equal(f.manager.events(spec.runId).filter((event) => event.type === "run.crew_changed").length, 1);

    await f.manager.resume(spec.runId, "resume:1");
    await assert.rejects(
      f.manager.changeCrew(spec.runId, { ...newCrew, workerRuntimeIds: ["openai:worker-a"] }, "crew:3"),
      /Pause the Build/,
    );
  } finally {
    await f.close();
  }
});

test("a crew change whose old session will not close keeps the session for shutdown and says how to apply", async () => {
  const f = await fixture({ closeFailures: 1 });
  try {
    await assert.rejects(f.manager.changeCrew(spec.runId, newCrew, "crew:1"), (error: Error) => {
      assert.match(error.message, /new models are saved.*Restart the runner/);
      assert.match(String((error.cause as Error).message), /Could not close all/);
      return true;
    });
    assert.deepEqual(f.specs.get(spec.runId).workerRuntimeIds, newCrew.workerRuntimeIds, "the restarted runner builds the new crew");
    assert.equal(f.created.length, 1, "no second runtime was built over the unclosed one");
    assert.equal(f.manager.projection(spec.runId).status, "paused", "the old session stays registered so shutdown retries its teardown");
  } finally {
    await f.close();
  }
});

test("a crew the runner cannot construct is refused before anything changes", async () => {
  const f = await fixture({ refuseCrew: "openai:worker-b" });
  try {
    await assert.rejects(f.manager.changeCrew(spec.runId, newCrew, "crew:1"), /is not configured/);
    assert.deepEqual(f.specs.get(spec.runId).workerRuntimeIds, spec.workerRuntimeIds);
    assert.equal(f.manager.events(spec.runId).some((event) => event.type === "run.crew_changed"), false);
    assert.equal(f.created.length, 1);
  } finally {
    await f.close();
  }
});

test("resuming over a pending Architect handoff keeps the current Architect and closes the handoff", async () => {
  const f = await fixture();
  try {
    assert.equal(f.manager.projection(spec.runId).runtime.architect.handoff?.reason, "fetch failed");
    const resumed = await f.manager.resume(spec.runId, "resume:1");
    assert.equal(resumed.status, "running");
    assert.equal(resumed.runtime.architect.handoff, undefined);
    assert.equal(resumed.runtime.architect.runtimeId, "deepseek:flash");
    const kept = f.manager.events(spec.runId).find((event) => event.type === "architect.handoff_selected");
    assert.equal(kept?.actor.role, "user");
    assert.equal((kept?.payload as { runtimeId?: string }).runtimeId, "deepseek:flash");
  } finally {
    await f.close();
  }
});

test("the kernel accepts a crew change only from the owner of a paused run", async () => {
  const f = await fixture();
  try {
    const events = f.manager.events(spec.runId);
    const paused = rebuildSchedulerProjection(events);
    const payload = { architectRuntimeId: "openai:architect", workerRuntimeIds: ["openai:worker-a"], verifierRuntimeIds: ["openai:reviewer"] };
    const store = f.scheduler();
    assert.throws(
      () => store.append({ runId: spec.runId, type: "run.crew_changed", occurredAt: "2026-10-25T00:00:03.000Z", actor: { role: "architect", id: "architect" }, idempotencyKey: "crew:architect", payload }),
      /requires the user/,
    );
    assert.equal(paused.status, "paused");
    await f.manager.resume(spec.runId, "resume:1");
    assert.throws(
      () => store.append({ runId: spec.runId, type: "run.crew_changed", occurredAt: "2026-10-25T00:00:04.000Z", actor: { role: "user", id: "local-user" }, idempotencyKey: "crew:running", payload }),
      /only while the run is paused/,
    );
  } finally {
    await f.close();
  }
});
