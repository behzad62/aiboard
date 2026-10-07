import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { BuildRuntime } from "../src/build-runtime.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import type { NewSchedulerEvent, SchedulerActorRole } from "../src/scheduler-store.js";
import {
  AGENTS_SECTION_END,
  AGENTS_SECTION_START,
  V2_AGENTS_SECTION_BODY,
  V2_CLAUDE_POINTER_LINE,
} from "../src/project-docs.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { NativeBuildFactory, captureGitBaseline, runGit } from "./support/git-fixture.js";
import { acceptFinalVerificationProfile } from "./support/final-verification-profile.js";
import {
  CLOCK,
  CompletionArchitect,
  DocsPortHooks,
  SOURCE_TEXT,
  UnusedModel,
  advancingClock,
  buildRuntimeForHandoff,
  driveHandoff,
  gitDocsPort,
  headerDigest,
  managedHandle,
  managerSpec,
  openDirectPort,
  openFactoryPort,
  openGitRepo,
  provider,
  safeSegment,
  seedEvent,
  seedHandoffRequested,
  selectHandoffOwner,
  silentArchitect,
  v2FinishSeed,
  v2PlanOnlySeed,
} from "./support/handoff-snapshot-harness.js";

/**
 * TX-2 handoff suite, file 2 of 8: commit and gate.
 *
 * The six kept full end-to-end tests through NativeBuildManager plus the
 * commit-shape tests moved onto the harness (factory port, direct
 * runtime step, seeded stop).
 *
 * Kept end-to-end and why:
 * - C2a B1 (plan-only): the only production create -> activate -> awaitIdle
 *   -> selectProjectHandoff path for plan_only, including the kernel commit
 *   metadata and trailer assertions.
 * - C2a B1+M6 (finish): the only production automatic-handoff-applies path.
 * - C2a B1 nomutate: the only
 *   automatic_project_handoff_failed + selection-refused coverage.
 * - C2a B2+M4: the only manager.resume -> retry coverage.
 * - C2b B1-R/N6-direct: the baseline handoff through the direct port (the
 *   legacy-planning docs-v2 log is factory-unrecoverable by design, so the
 *   direct port preserves baseline-fallback coverage without a guard bypass).
 *
 * (C2b B1-R/G2-prod lives in the project-links file: withdrawn-stop
 * reconciliation plus risk re-assessment through the manager.)
 */

test("C2a B1: production-manager plan-only run commits one kernel STATE.md snapshot in the handoff step", async () => {
  const RUN = "run-c2a-factory";
  const root = mkdtempSync(join(tmpdir(), "aiboard c2a factory "));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "c2a-factory", version: "1.0.0", type: "module", packageManager: "npm@11.0.0", scripts: { test: "node --test" } }, null, 2));
  const runRoot = join(state, "builds", safeSegment(RUN));
  mkdirSync(runRoot, { recursive: true });
  const seed = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
  for (const input of v2PlanOnlySeed(RUN, "Plan the value module.")) seed.append(input);
  seed.close();
  const architect = new CompletionArchitect(() => manager!.projection(RUN));
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment: snapshotNativeBuildAmbientEnvironment(),
  });
  let factory: NativeBuildFactory | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN });
    factory = new NativeBuildFactory({
      projectRoot: project,
      stateDirectory: state,
      providerConfigs: {
        load: () => [provider("arch:architect", 1), provider("work:worker", 2), provider("rev:reviewer", 3)],
        save: () => undefined,
        close: () => undefined,
      },
      executionHost,
      baselineFor: () => baseline.revision,
      providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : new UnusedModel(),
    });
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")),
      createRuntime: (spec) => factory!.create(spec),
      prepareSpec: (spec) => factory!.prepareSpec(spec),
    });
    // Truthful registered-source bytes for creation-time verification: the
    // shared scenario manifest's exact bytes, in the store the factory reads.
    await new ArtifactStore(join(state, "artifacts")).put(Buffer.from(SOURCE_TEXT, "utf-8"), "text/plain", "approved source");
    // Production flow only: create -> activate -> awaitIdle -> selectProjectHandoff. No manual step().
    await manager.create(await factory.prepareSpec({
      version: 2,
      runId: RUN,
      projectId: "c2a-fixture",
      objective: "Plan the value module.",
      architectRuntimeId: "arch:architect",
      workerRuntimeIds: ["work:worker"],
      verifierRuntimeIds: ["rev:reviewer"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy: "plan_only",
      planCritique: "off",
      planningPolicy: { version: 1 },
      budgetLimits: {},
      createdAt: CLOCK,
      idempotencyKey: "c2a-factory",
    }));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).projectHandoff?.status, "requested");
    assert.equal(architect.calls, 1);
    // The handoff step itself committed the snapshot: no extra step was taken.
    const events = manager.events(RUN);
    const stop = events.find((event) => event.type === "project.handoff_requested")!;
    const snapshots = events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1, "the handoff step commits exactly one snapshot");
    const snapshot = snapshots[0]!;
    assert.equal(snapshot.actor.role, "runner");
    assert.equal(snapshot.idempotencyKey, `handoff-snapshot:${stop.sequence}`);
    const payload = snapshot.payload as Record<string, unknown>;
    assert.equal(payload.stopSequence, stop.sequence);
    assert.equal(payload.stopKind, "plan_only");
    assert.equal(payload.revision, "revision_value");
    assert.match(String(payload.bodyDigest), /^[a-f0-9]{64}$/);
    assert.deepEqual(payload.paths, ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md", "docs/project/specs/source_value.md"]);
    assert.equal(payload.previousSnapshotEdited, false);
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.claudeLineCommitted, true);
    const entries = readdirSync(join(state, "integration"));
    assert.equal(entries.length, 1);
    const repoPath = join(state, "integration", entries[0]!);
    const log = await runGit({ cwd: repoPath, args: ["log", "--format=%H", `${baseline.revision}..HEAD`] });
    const commits = log.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
    assert.deepEqual(commits, [payload.commit], "exactly one kernel commit");
    const files = await runGit({ cwd: repoPath, args: ["show", "--name-only", "--format=", String(payload.commit)] });
    // C2b: one kernel commit holds STATE.md plus the v2 entry lines. The
    // registered source bytes are truthfully provisioned (creation is
    // fail-closed without them), so the snapshot also carries the spec copy.
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md", "docs/project/specs/source_value.md"]);
    assert.equal(payload.specCopied, true, "the event claims the spec copy");
    const specShow = await runGit({ cwd: repoPath, args: ["show", `${String(payload.commit)}:docs/project/specs/source_value.md`] });
    assert.equal(specShow.stdout, SOURCE_TEXT, "the spec copy holds the registered source bytes");
    const meta = await runGit({ cwd: repoPath, args: ["log", "-1", "--format=%an%x00%ae%x00%cn%x00%ce%x00%B", String(payload.commit)] });
    const [authorName, authorEmail, committerName, committerEmail, ...rest] = meta.stdout.split("\0");
    assert.equal(authorName, "AIBoard Integrator");
    assert.equal(authorEmail, "integrator@aiboard.local");
    assert.equal(committerName, "AIBoard Integrator");
    assert.equal(committerEmail, "integrator@aiboard.local");
    const message = rest.join("\0");
    assert.match(message, /AIBoard-Author: runner/);
    assert.match(message, /AIBoard-Generated: handoff-snapshot/);
    assert.match(message, new RegExp(`AIBoard-Snapshot-Key: handoff-snapshot:${stop.sequence}`));
    assert.match(message, new RegExp(`AIBoard-Run: ${RUN}`));
    const stateShow = await runGit({ cwd: repoPath, args: ["show", `${String(payload.commit)}:docs/project/STATE.md`] });
    // M2/M4: the committed file verifies and describes the recorded revision.
    assert.equal(headerDigest(stateShow.stdout), payload.bodyDigest);
    assert.match(stateShow.stdout, /revision: revision_value/);
    assert.match(stateShow.stdout, /## Plan \(ready\)/, "the plan-only snapshot holds the plan view");
    assert.match(stateShow.stdout, /P1/);
    assert.match(stateShow.stdout, /T1/);
    assert.match(stateShow.stdout, /REQ-1/);
    assert.match(stateShow.stdout, /plan_only/);
    assert.match(stateShow.stdout, /The plan is ready for handoff/);
    // The owner's selection through the production manager completes the run.
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2a");
    assert.equal(selected.status, "completed");
    assert.equal(architect.calls, 1, "the kernel snapshot makes no model call");
  } finally {
    await manager?.close();
    await factory?.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("C2a B1+M6: production-manager finish run snapshots at handoff and the automatic handoff applies afterwards", async () => {
  const RUN = "run-c2a-finish";
  const repo = await openGitRepo("finish", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  // The canonical revision is the real baseline, so the kernel commit
  // continues the documents and moves the tip (CD-11) on a finish run.
  for (const input of v2FinishSeed(RUN, repo.baselineRevision)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect("The build is complete and verified.");
  const clock = advancingClock();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  const order: string[] = [];
  try {
    const runtimeOf = () => {
      store = new SqliteSchedulerStore(schedulerPath, {
        evidenceStore: evidence,
        validateExecutionProfile: acceptFinalVerificationProfile,
        validateCleanupReceipt: () => undefined,
      });
      return buildRuntimeForHandoff({
        runId: RUN,
        store,
        projectDocs: gitDocsPort(repo.integration, hooks),
        architect,
        clock,
        runPolicy: "finish",
        evidenceStore: evidence,
      });
    };
    let runtime!: BuildRuntime;
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        runtime = runtimeOf();
        return managedHandle(runtime, async () => {
          // The real project mutation, spied: it must run only after the
          // kernel snapshot exists.
          order.push(`projectHandoff:${manager!.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length}`);
          const result = await repo.integration.applyToProject();
          order.push("applied");
          return result;
        }, RUN);
      },
    });
    await manager.create(managerSpec(RUN, "finish"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const projection = manager.projection(RUN);
    assert.equal(projection.status, "completed", "the automatic handoff completes the finish run");
    assert.equal(projection.projectHandoff?.status, "selected");
    assert.equal(projection.projectHandoff?.choice, "apply_to_project");
    assert.equal(architect.calls(), 1, "the kernel snapshot makes no model call");
    const events = manager.events(RUN);
    const stop = events.find((event) => event.type === "project.handoff_requested")!;
    const snapshots = events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.stopSequence, stop.sequence);
    assert.equal(payload.stopKind, "completed");
    assert.equal(payload.revision, repo.baselineRevision);
    // The snapshot moved the v2 document tip to the kernel commit (CD-11).
    assert.equal(manager.projection(RUN).projectDocs?.documentTip, payload.commit);
    // M4/B4: the event digest is the committed file's own digest.
    const stateShow = await runGit({ cwd: repo.integration.path, args: ["show", `${String(payload.commit)}:docs/project/STATE.md`] });
    assert.equal(headerDigest(stateShow.stdout), payload.bodyDigest);
    assert.match(stateShow.stdout, new RegExp(`revision: ${repo.baselineRevision}`));
    // The automatic handoff ran after the snapshot and really applied it.
    assert.deepEqual(order, ["projectHandoff:1", "applied"]);
    const applied = await runGit({ cwd: repo.project, args: ["show", "HEAD:docs/project/STATE.md"], });
    assert.equal(applied.stdout, stateShow.stdout, "the project holds the snapshotted STATE.md");
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1");
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

test("C2a B1: with the snapshot commit forced to fail, the project is not mutated", async () => {
  const RUN = "run-c2a-nomutate";
  const repo = await openGitRepo("nomutate", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const evidence = new SqliteEvidenceStore(join(repo.root, "evidence.sqlite"));
  const seeder = new SqliteSchedulerStore(schedulerPath, {
    evidenceStore: evidence,
    validateExecutionProfile: acceptFinalVerificationProfile,
    validateCleanupReceipt: () => undefined,
  });
  for (const input of v2FinishSeed(RUN, repo.baselineRevision)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { failSnapshotCount: 99, snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect("The build is complete and verified.");
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  let physicalHandoffs = 0;
  const pumpResults: unknown[] = [];
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath, {
          evidenceStore: evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN,
          store,
          projectDocs: gitDocsPort(repo.integration, hooks),
          architect,
          clock: advancingClock(),
          runPolicy: "finish",
          evidenceStore: evidence,
        });
        return managedHandle(runtime, async () => {
          physicalHandoffs += 1;
          return repo.integration.applyToProject();
        }, RUN);
      },
      onPumpResult: (_runId, result) => { pumpResults.push(result); },
    });
    await manager.create(managerSpec(RUN, "finish"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    const projection = manager.projection(RUN);
    assert.equal(projection.projectHandoff?.status, "requested");
    assert.equal(projection.pauseReason?.reason, "handoff_snapshot_failed");
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.ok((hooks.snapshotCalls?.length ?? 0) >= 1, "the snapshot was attempted");
    // The gate refused before any project mutation.
    assert.equal(physicalHandoffs, 0);
    assert.ok(pumpResults.some((result) => (result as { action?: string }).action === "automatic_project_handoff_failed"));
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "0", "no kernel commit was left behind");
    assert.equal(existsSync(join(repo.project, "docs", "project", "STATE.md")), false, "the project is untouched");
    // The owner's selection is refused too while the snapshot is missing.
    await assert.rejects(
      manager.selectProjectHandoff(RUN, "apply_to_project", "handoff:c2a-nomutate"),
      /kernel handoff snapshot/,
    );
    assert.equal(physicalHandoffs, 0);
  } finally {
    await manager?.close();
    store?.close();
    evidence.close();
    await repo.close();
  }
});

test("C2a B2+M4: fail -> resume -> retry returns to the handoff wait with no model call", async () => {
  const RUN = "run-c2a-failure";
  const repo = await openGitRepo("failure", RUN);
  const schedulerPath = join(repo.root, "scheduler.sqlite");
  const seeder = new SqliteSchedulerStore(schedulerPath);
  for (const input of v2PlanOnlySeed(RUN)) seeder.append(input);
  seeder.close();
  const hooks: DocsPortHooks = { failNextSnapshot: true, snapshotCalls: [], readCalls: [] };
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(repo.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(schedulerPath);
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: gitDocsPort(repo.integration, hooks),
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(manager.projection(RUN).projectHandoff?.status, "requested");
    assert.equal(architect.calls(), 1);
    assert.equal(manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 0);
    assert.equal(hooks.snapshotCalls?.length, 1);
    const failure = manager.projection(RUN).pauseReason;
    assert.equal(failure?.reason, "handoff_snapshot_failed");
    // M4: the bounded cause travels in the pause detail.
    assert.ok(typeof failure?.detail === "string" && failure.detail.length > 0, "the failure pause carries a cause");
    assert.ok(failure.detail.length <= 300, "the cause is bounded");
    assert.equal(failure.detail.includes("\n"), false, "the cause is single-lined");
    const empty = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(empty.stdout.trim(), "0", "a failed commit leaves no commit behind");
    await manager.resume(RUN, "resume:c2a-failure");
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // B2: the run is back at the handoff wait -- paused, handoff requested, no failure pause.
    const retried = manager.projection(RUN);
    assert.equal(retried.status, "paused");
    assert.equal(retried.projectHandoff?.status, "requested");
    assert.equal(retried.pauseReason, undefined);
    assert.equal(architect.calls(), 1, "the retry makes no model call");
    const events = manager.events(RUN);
    assert.equal(events.filter((event) => event.type === "project_docs.handoff_snapshot_committed").length, 1);
    const count = await runGit({ cwd: repo.integration.path, args: ["rev-list", "--count", `${repo.baselineRevision}..HEAD`] });
    assert.equal(count.stdout.trim(), "1");
    // A further pump makes no model call either.
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    assert.equal(architect.calls(), 1, "a further step after the handoff wait makes no model call");
    assert.equal(manager.projection(RUN).status, "paused");
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2a-failure");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await repo.close();
  }
});

test("C2b repair B1-R/N6-direct: a docs-v2 run without a plan revision hands off the baseline through the direct port", async () => {
  const RUN = "run-c2b-n6direct";
  const seedN6 = (runId: string): NewSchedulerEvent[] => {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
    return [
      e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }),
      e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }),
      // Legacy planning: a plan revision but no planning policy v1, and no
      // integration revision anywhere in the log (the N6 shape). Supported by
      // the reducer and the direct runtime; intentionally unrecoverable via
      // the factory (legacy spec + docs2 fails closed), so this test uses the
      // direct port to preserve baseline-fallback coverage without a bypass.
      e("plan.created", "plan", "architect", "architect", {
        revision: 1,
        tasks: [{
          id: "implementation",
          objective: "Implement the requested behavior.",
          dependencies: [],
          status: "integrated",
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "done", text: "The behavior is implemented." }],
          acceptanceCriteriaVersion: 1,
          attempt: 1,
        }],
      }),
    ];
  };
  // The N6 shape is explicitly legacy+docs2 direct: docs v2 present, planning
  // v1 absent, driven without factory recovery (no factory/stopNotes fields).
  assert.equal(seedN6(RUN).some((event) => event.type === "project_docs.policy_configured"), true);
  assert.equal(seedN6(RUN).some((event) => event.type === "planning.policy_configured"), false);
  const fixture = await openDirectPort("n6direct", RUN, seedN6);
  assert.equal("factory" in fixture, false, "N6 uses the direct port, not factory recovery");
  assert.equal("stopNotes" in fixture, false, "N6 uses the direct port, not factory recovery");
  const architect = silentArchitect();
  let store: SqliteSchedulerStore | undefined;
  let manager: NativeBuildManager | undefined;
  try {
    manager = new NativeBuildManager({
      specs: new SqliteBuildSpecStore(join(fixture.root, "builds.sqlite")),
      createRuntime: async () => {
        store = new SqliteSchedulerStore(join(fixture.state, "builds", safeSegment(RUN), "scheduler.sqlite"), {
          evidenceStore: fixture.evidence,
          validateExecutionProfile: acceptFinalVerificationProfile,
          validateCleanupReceipt: () => undefined,
        });
        const runtime = buildRuntimeForHandoff({
          runId: RUN, store, projectDocs: fixture.port,
          architect, clock: advancingClock(), runPolicy: "plan_only",
        });
        return managedHandle(runtime, async () => ({ integrationRevision: "unused", integrationBranch: "unused", appliedToProject: false }), RUN);
      },
    });
    await manager.create(managerSpec(RUN, "plan_only"));
    manager.activate(RUN);
    await manager.awaitIdle(RUN);
    // No endless snapshot-failure pause: the recorded baseline is handed off.
    const snapshots = manager.events(RUN).filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.revision, fixture.baselineRevision);
    assert.equal(payload.specCopySkipped, "no_manifest");
    assert.equal(manager.projection(RUN).pauseReason, undefined);
    const selected = await manager.selectProjectHandoff(RUN, "keep_integration_branch", "handoff:c2b-n6direct");
    assert.equal(selected.status, "completed");
  } finally {
    await manager?.close();
    store?.close();
    await fixture.close();
  }
});

test("C2b: the handoff commit splices the v2 entry lines, keeping outside bytes", async () => {
  const RUN = "run-c2b-entries";
  const fixture = await openFactoryPort("entries", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    // Pre-existing entry files with content outside the markers.
    const agentsBefore = "# Custom rules\nkeep me\n";
    const claudeBefore = "# Claude notes\nkeep me too\n";
    writeFileSync(join(fixture.integration.path, "AGENTS.md"), agentsBefore);
    writeFileSync(join(fixture.integration.path, "CLAUDE.md"), claudeBefore);
    await runGit({ cwd: fixture.integration.path, args: ["add", "--", "AGENTS.md", "CLAUDE.md"] });
    await runGit({ cwd: fixture.integration.path, args: ["commit", "-m", "pre-existing entry files"] });
    seedHandoffRequested(fixture, RUN);
    const { events } = await driveHandoff(fixture, RUN);
    const snapshots = events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    const commit = String(payload.commit);
    const files = await runGit({ cwd: fixture.integration.path, args: ["show", "--name-only", "--format=", commit] });
    assert.deepEqual(files.stdout.split("\n").map((line) => line.trim()).filter(Boolean), ["AGENTS.md", "CLAUDE.md", "docs/project/STATE.md"]);
    const agents = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:AGENTS.md`] });
    assert.ok(agents.stdout.startsWith(agentsBefore), "bytes outside the markers are kept byte-for-byte");
    assert.ok(agents.stdout.includes(V2_AGENTS_SECTION_BODY), "the static v2 section is spliced in");
    const claude = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:CLAUDE.md`] });
    assert.ok(claude.stdout.startsWith(claudeBefore), "bytes outside the markers are kept byte-for-byte");
    assert.ok(claude.stdout.split("\n").some((line) => line.trim() === V2_CLAUDE_POINTER_LINE), "the marked @AGENTS.md line is spliced in");
    assert.equal(payload.agentsSectionCommitted, true);
    assert.equal(payload.claudeLineCommitted, true);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-entries");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2b: missing AGENTS.md and CLAUDE.md are created with just the section", async () => {
  const RUN = "run-c2b-entries-missing";
  const fixture = await openFactoryPort("entries-missing", RUN, (runId) => v2PlanOnlySeed(runId), "plan_only");
  try {
    seedHandoffRequested(fixture, RUN);
    const { events } = await driveHandoff(fixture, RUN);
    const snapshots = events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const commit = String((snapshots[0]!.payload as Record<string, unknown>).commit);
    const agents = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:AGENTS.md`] });
    assert.equal(agents.stdout, `${AGENTS_SECTION_START}\n${V2_AGENTS_SECTION_BODY}\n${AGENTS_SECTION_END}\n`);
    const claude = await runGit({ cwd: fixture.integration.path, args: ["show", `${commit}:CLAUDE.md`] });
    assert.equal(claude.stdout, `${AGENTS_SECTION_START}\n${V2_CLAUDE_POINTER_LINE}\n${AGENTS_SECTION_END}\n`);
  } finally {
    await fixture.close();
  }
});

test("C2a: the snapshot moves the v2 document tip on a finish-style revision", async () => {
  const RUN = "run-c2a-tip";
  const fixture = await openFactoryPort("tip", RUN, (runId, baselineRevision) => [
    ...v2PlanOnlySeed(runId),
    // A finish-style canonical revision equal to the real baseline, so the
    // kernel commit continues the documents and moves the tip (CD-11).
    seedEvent(runId, "integration.revision_advanced", "integration:rev", "runner", "build-runtime", {
      integrationRevision: baselineRevision,
    }),
  ], "plan_only");
  try {
    seedHandoffRequested(fixture, RUN);
    const { events, projection } = await driveHandoff(fixture, RUN);
    const snapshots = events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.revision, fixture.baselineRevision);
    assert.equal(projection.projectDocs?.documentTip, payload.commit);
    // Selecting the post-snapshot head succeeds through the moved tip.
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2a-tip");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});

test("C2b repair CD-14/N6: a docs-v2 run without a plan revision hands off the baseline", async () => {
  const RUN = "run-c2b-n6-baseline";
  const seedN6 = (runId: string): NewSchedulerEvent[] => {
    const e = (
      type: string,
      key: string,
      role: SchedulerActorRole,
      id: string,
      payload: Record<string, unknown>,
    ): NewSchedulerEvent => seedEvent(runId, type, key, role, id, payload);
    return [
      e("project_docs.policy_configured", "docs-policy", "runner", "build-runtime", { version: 2 }),
      e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "plan_only" }),
      // Legacy planning: a plan revision but no planning policy v1, and no
      // integration revision anywhere in the log (the N6 shape). Supported by
      // the reducer and the direct runtime; intentionally unrecoverable via
      // the factory (legacy spec + docs2 fails closed), so this test uses the
      // direct port to preserve baseline-fallback coverage without a bypass.
      e("plan.created", "plan", "architect", "architect", {
        revision: 1,
        tasks: [{
          id: "implementation",
          objective: "Implement the requested behavior.",
          dependencies: [],
          status: "integrated",
          requiredCapabilities: ["code"],
          acceptanceCriteria: [{ id: "done", text: "The behavior is implemented." }],
          acceptanceCriteriaVersion: 1,
          attempt: 1,
        }],
      }),
    ];
  };
  // The N6 shape is explicitly legacy+docs2 direct: docs v2 present, planning
  // v1 absent, driven without factory recovery (no factory/stopNotes fields).
  assert.equal(seedN6(RUN).some((event) => event.type === "project_docs.policy_configured"), true);
  assert.equal(seedN6(RUN).some((event) => event.type === "planning.policy_configured"), false);
  const fixture = await openDirectPort("n6baseline", RUN, seedN6);
  assert.equal("factory" in fixture, false, "N6 uses the direct port, not factory recovery");
  assert.equal("stopNotes" in fixture, false, "N6 uses the direct port, not factory recovery");
  try {
    seedHandoffRequested(fixture, RUN);
    const { events, projection } = await driveHandoff(fixture, RUN);
    // No endless snapshot-failure pause: the recorded baseline is handed off.
    const snapshots = events.filter((event) => event.type === "project_docs.handoff_snapshot_committed");
    assert.equal(snapshots.length, 1);
    const payload = snapshots[0]!.payload as Record<string, unknown>;
    assert.equal(payload.revision, fixture.baselineRevision);
    assert.equal(payload.specCopySkipped, "no_manifest");
    assert.equal(projection.pauseReason, undefined);
    const selected = await selectHandoffOwner(fixture, RUN, "keep_integration_branch", "handoff:c2b-n6");
    assert.equal(selected.status, "completed");
  } finally {
    await fixture.close();
  }
});
