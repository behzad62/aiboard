import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { T1A_SEEDED_HOST_PLANNING_CAPABILITIES } from "../src/planning-contracts.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import type { NewSchedulerEvent, SchedulerActorRole } from "../src/scheduler-store.js";
import { rebuildSchedulerProjection } from "../src/scheduler-store.js";
import { repairIssueIdentity, repairRootCauseForCheck } from "../src/repair-budget-contracts.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { buildPlanningFixtureScenario } from "./fixtures/planning-source-fixture.js";
import { captureGitBaseline, NativeBuildFactory } from "./support/git-fixture.js";

/**
 * T6b factory wiring: the final-verification pump built THROUGH
 * NativeBuildFactory opens a durable repair issue for a really failing
 * tests check. A scripted architect plans the verification through the real
 * plan_final_verification tool; the factory's real FinalVerificationRuntime
 * executes the fixture's failing tests; the pump records the issue, its
 * rerun decision, and a cleanup search with the real owned-process and
 * temp-path search. Removing the factory's T6b driver wiring turns this red.
 */

const RUN_ID = "run-t6b-repair-factory";
const CLOCK = "2026-09-26T00:00:00.000Z";

const FV_PLAN = {
  checks: (["tests", "build", "runtime_smoke", "browser"] as const).map((category) =>
    category === "tests"
      ? { category, status: "required" as const }
      : {
          category,
          status: "not_applicable" as const,
          rationale: `No ${category} fixture is configured.`,
          repositoryInspection: { paths: ["package.json"], summary: `No ${category} fixture is configured.` },
        }),
};

function call(name: string, args: unknown, id: string): ModelTurn {
  return {
    blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
    stopReason: "tool_calls",
    usage: { inputTokens: 8, outputTokens: 4 },
  };
}

class T6bFactoryArchitect implements AgentModel {
  private planned = false;
  constructor(
    private readonly storeOf: () => SqliteSchedulerStore | undefined,
    private readonly options: { planRepairs: boolean } = { planRepairs: false },
  ) {}
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    // Tool messages accumulate across turns in the architect session, so
    // this turn's progress is tracked by this fixture's own call ids.
    const toolCallIds = new Set(request.messages
      .filter((message) => message.role === "tool")
      .map((message) => (message.content as { callId?: string } | undefined)?.callId)
      .filter((callId): callId is string => typeof callId === "string"));
    const tools = request.messages.filter((message) => message.role === "tool").length;
    const store = this.storeOf();
    const current = store ? rebuildSchedulerProjection(store.readRun(RUN_ID)).finalVerification?.current : undefined;
    // T6b repair (R2-B5): the fail-again fixture's architect answers the
    // repair turn through the real tools — a fresh approach decision, then
    // the verification repair plan — reading every id from durable state.
    if (current?.failure && !current.repairTaskIds) {
      if (!this.options.planRepairs) throw new Error("Unexpected T6b factory repair turn.");
      const failure = current.failure;
      const issueId = repairIssueIdentity({
        projectId: "t6b-factory-fixture",
        rootCause: repairRootCauseForCheck({ category: "tests", failingIds: ["t6b red"] }),
      });
      const evidenceIds = [...failure.evidenceIds];
      if (!toolCallIds.has("t6b-repair-decision-1")) {
        return call("record_repair_approach_decision", {
          issueId,
          approachId: "t6b-factory-a1",
          repeat: false,
          hypothesis: "Fix the steadily failing t6b red test.",
          diagnosticSet: [],
          evidenceIds,
        }, "t6b-repair-decision-1");
      }
      if (!toolCallIds.has("t6b-repair-plan-1")) {
        const toolMessages = request.messages.filter((message) => message.role === "tool");
        const decisionResult = [...toolMessages].reverse().find((message) => (message.content as { callId?: string })?.callId === "t6b-repair-decision-1")?.content as { isError?: boolean } | undefined;
        assert.equal(decisionResult?.isError, false, `repair decision failed: ${JSON.stringify(decisionResult).slice(0, 500)}`);
        return call("plan_verification_repairs", {
          finalVerificationTaskId: current.taskId,
          generationId: current.generationId,
          targetRevision: current.targetRevision,
          source: { type: "mechanical_failure", failureId: failure.failureId, issueIds: [...failure.issueIds], factIds: [...failure.factIds] },
          tasks: [{
            id: "t6b-fix-1",
            objective: "Fix the steadily failing t6b red test.",
            categories: ["tests"],
            evidenceIds,
            dependencies: [],
            requiredCapabilities: ["code"],
            acceptanceCriteria: [{ id: "fix-1", text: "The t6b red test passes." }],
          }],
        }, "t6b-repair-plan-1");
      }
      const lastTool = request.messages.filter((message) => message.role === "tool").at(-1)?.content;
      throw new Error(`Unexpected T6b factory repair continuation (tools=${tools}): ${JSON.stringify(lastTool).slice(0, 500)}`);
    }
    if (tools === 0 && !this.planned) {
      this.planned = true;
      return call("plan_final_verification", { plan: FV_PLAN }, "t6b-fv-plan-1");
    }
    throw new Error(`Unexpected T6b factory architect turn (tools=${tools}).`);
  }
}

class NeverCalledModel implements AgentModel {
  constructor(private readonly role: string) {}
  async complete(): Promise<ModelTurn> {
    throw new Error(`The T6b factory run must not call the ${this.role} model.`);
  }
}

function provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

function safeSegment(value: string): string {
  const readable = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "run";
  return `${readable}-${createHash("sha256").update(value).digest("hex").slice(0, 10)}`;
}

function seedEvents(revision: string): NewSchedulerEvent[] {
  const base = buildPlanningFixtureScenario();
  const manifest = {
    ...base.manifest,
    amendment: {
      ...base.manifest.amendment!,
      recordedImpact: { addsSectionIds: ["s8"], retiresSectionIds: ["s7"], addsRequirementIds: [], retiresRequirementIds: ["REQ-RETIRED"] },
    },
  };
  const e = (type: string, key: string, role: SchedulerActorRole, id: string, payload: Record<string, unknown>): NewSchedulerEvent =>
    ({ runId: RUN_ID, type: type as NewSchedulerEvent["type"], occurredAt: CLOCK, actor: { role, id }, idempotencyKey: key, payload });
  return [
    e("run.policy_configured", "policy", "runner", "build-runtime", { runPolicy: "finish" }),
    e("planning.policy_configured", "planning-policy", "runner", "build-runtime", { version: 1 }),
    e("planning.source_registered", "source", "user", "owner", { manifest: base.priorManifest }),
    e("planning.source_amended", "source-amendment", "user", "owner", { manifest }),
    e("request.triaged", "triage", "architect", "architect", { decision: "build", rationale: "Build the fixture." }),
    e("planning.ledger_persisted", "ledger", "architect", "architect", { id: "ledger", requirements: base.requirements, phases: base.phases, nonNormativeSections: [] }),
    ...manifest.sections.map((section) => e("planning.source_section_read", `read:${section.id}`, "architect", "architect", { manifestId: manifest.manifestId, manifestDigest: manifest.artifactDigest, sectionId: section.id, sectionDigest: section.digest, readAt: CLOCK })),
    e("planning.plan_drafted", "plan", "architect", "architect", { revision: base.revision, expectedRevisionId: null, expectedDigest: null }),
    e("planning.coverage_review_requested", "coverage-request", "architect", "architect", { reviewId: base.coverageReview.id, planRevisionId: base.revision.revisionId, planRevisionDigest: base.revision.digest, sourceManifestId: manifest.manifestId, requestedAt: CLOCK }),
    e("planning.coverage_obligations_recorded", "coverage-obligations", "verifier", "coverage-reviewer", { reviewId: base.coverageReview.id, sourceManifestId: manifest.manifestId, sourceManifestDigest: manifest.artifactDigest, obligations: base.coverageReview.derivedObligations, sectionCoverage: manifest.sections.map((section) => ({ sectionId: section.id, obligationIds: base.coverageReview.derivedObligations.map((obligation) => obligation.id) })), recordedAt: CLOCK }),
    e("planning.coverage_plan_delivered", "coverage-plan", "runner", "build-runtime", { reviewId: base.coverageReview.id, planRevisionId: base.revision.revisionId, planRevisionDigest: base.revision.digest, sourceManifestId: manifest.manifestId, deliveredAt: CLOCK }),
    e("planning.coverage_review_recorded", "coverage-review", "verifier", "coverage-reviewer", { review: base.coverageReview }),
    e("planning.plan_ready", "ready", "runner", "build-runtime", { hostCapabilities: T1A_SEEDED_HOST_PLANNING_CAPABILITIES }),
    // The ready plan's contracts materialize as scheduler tasks through the
    // kernel; cancel them so this run exercises final verification only and
    // never schedules workers.
    ...["T1", "T2", "T3", "T4", "T5", "T-INV"].map((taskId) =>
      e("task.transitioned", `cancel:${taskId}`, "architect", "architect", { taskId, status: "cancelled" })),
    e("integration.revision_advanced", "integration:revision", "runner", "integration-manager", { integrationRevision: revision }),
  ];
}

async function runFactoryScenario(kind: "fail-again" | "really-flaky"): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "aiboard-t6b-factory-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(state, { recursive: true });
  // T6b (N1): the reviewed harness never leaks its own test-runner
  // context into the child — NODE_TEST_CONTEXT would make node --test exit
  // 0 with a failing file — so the fixture strips it from the ambient
  // snapshot, exactly as production final verification strips it from
  // every child. T6b repair (R2-B4): the script is the plain
  // `node --test` a real project writes (normal node resolution), so the
  // production `npm run test` command is the one whose failing ids and
  // rerun counts are captured.
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "t6b-factory-fixture", version: "1.0.0", type: "module", packageManager: "npm@11.0.0", scripts: { test: "node --test test/failing.test.mjs" } }, null, 2));
  // The really-flaky test fails on its first run and passes on every later
  // run (a marker file outside the checkout).
  const marker = JSON.stringify(join(root, "flaky-marker"));
  writeFileSync(join(project, "test", "failing.test.mjs"), kind === "fail-again"
    ? 'import test from "node:test";\ntest("t6b steady", () => {});\ntest("t6b red", () => { throw new Error("t6b fixture failure"); });\n'
    // "t6b steady" fails once the marker exists, so an un-narrowed rerun
    // would be red: only a rerun of exactly "t6b red" is green.
    : `import test from "node:test";\nimport { existsSync, writeFileSync } from "node:fs";\ntest("t6b steady", () => { if (existsSync(${marker})) throw new Error("the rerun must select only the failing test"); });\ntest("t6b red", () => { if (!existsSync(${marker})) { writeFileSync(${marker}, "seen"); throw new Error("t6b first-run failure"); } });\n`);
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  const lock = spawnSync(process.execPath, [npmCli, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd: project, encoding: "utf8" });
  assert.equal(lock.status, 0, lock.stderr);
  const runRoot = join(state, "builds", safeSegment(RUN_ID));
  mkdirSync(runRoot, { recursive: true });
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: RUN_ID });
  const seed = new SqliteSchedulerStore(join(runRoot, "scheduler.sqlite"));
  for (const input of seedEvents(baseline.revision)) seed.append(input);
  seed.close();
  let liveStore: SqliteSchedulerStore | undefined;
  const architect = new T6bFactoryArchitect(() => liveStore, { planRepairs: kind === "fail-again" });
  const { NODE_TEST_CONTEXT: _stripped, ...ambientEnvironment } = snapshotNativeBuildAmbientEnvironment();
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts: new ArtifactStore(join(state, "artifacts")),
    ambientEnvironment,
  });
  let factory: NativeBuildFactory | undefined;
  let handle: Awaited<ReturnType<NativeBuildFactory["create"]>> | undefined;
  try {
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
      providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : new NeverCalledModel(config.runtimeId),
    });
    handle = await factory.create(await factory.prepareSpec({
      version: 2,
      runId: RUN_ID,
      projectId: "t6b-factory-fixture",
      objective: "Verify the fixture; the tests fail.",
      architectRuntimeId: "arch:architect",
      workerRuntimeIds: ["work:worker"],
      verifierRuntimeIds: ["rev:reviewer"],
      alwaysRequireIndependentVerifier: false,
      maxConcurrency: 1,
      permissionProfile: "full",
      runPolicy: "finish",
      planCritique: "off",
      budgetLimits: {},
      createdAt: CLOCK,
      idempotencyKey: "t6b-repair-factory",
    }));
    liveStore = (handle.runtime as unknown as { store: SqliteSchedulerStore }).store;
    const actions: string[] = [];
    // The fail-again run continues past cleanup through the repair turn
    // until the fix is dispatched; the flaky run stops at cleanup because
    // its architect never plans repairs.
    const dispatched = kind === "fail-again";
    for (let step = 0; step < 30; step += 1) {
      const before = handle.runtime.projection();
      if (dispatched && (before.finalVerification?.current?.repairTaskIds?.length ?? 0) > 0) break;
      if (!dispatched && before.finalVerification?.current?.cleanup?.status === "succeeded") break;
      const result = await handle.runtime.step();
      actions.push(result.action ?? result.status);
    }
    const projection = handle.runtime.projection();
    assert.equal(projection.finalVerification?.current?.cleanup?.status, "succeeded", actions.join(","));
    if (dispatched) {
      assert.equal(projection.finalVerification?.current?.repairTaskIds?.length, 1, actions.join(","));
    }
    const issues = Object.values(projection.repairIssues ?? {});
    assert.equal(issues.length, 1, actions.join(","));
    // T6b repair (R2-B5): the issue identity is the category plus the
    // failing test ids, never the category alone.
    assert.equal(issues[0]!.rootCause, 'final-verification:tests:["t6b red"]');
    assert.equal(issues[0]!.limit, 3);
    const store = (handle.runtime as unknown as { store: SqliteSchedulerStore }).store;
    const events = store.readRun(RUN_ID);
    assert.equal(events.filter((event) => event.type === "repair.issue_recorded").length, 1);
    const cycles = events.filter((event) => event.type === "repair.cycle_recorded");
    if (dispatched) {
      // T6b repair (R2-B5): the fail-again correction is charged exactly
      // once at dispatch, bound to its live recorded approach.
      assert.equal(issues[0]!.used, 1, actions.join(","));
      assert.equal(cycles.length, 1, actions.join(","));
      assert.equal(cycles[0]!.payload.outcome, "dispatched");
      assert.equal(cycles[0]!.payload.approachId, "t6b-factory-a1");
      assert.ok((cycles[0]!.payload.evidenceIds as string[]).length > 0);
    } else {
      // T6b repair (B5): the failing check opens the issue; the cycle is
      // charged only when a correction is dispatched.
      assert.equal(issues[0]!.used, 0);
      assert.equal(cycles.length, 0);
    }
    const checked = events.filter((event) => event.type === "cleanup.checked");
    assert.ok(checked.length >= 1, actions.join(","));
    assert.ok(checked.some((event) => event.payload.trigger === "verification"), actions.join(","));
    // T6b repair (R2-B4): the production `npm run test` command reports
    // through the runner-owned junit file, so the failing id is captured
    // and ONLY that test is rerun through the audited path.
    const flaky = events.filter((event) => event.type === "repair.flaky_isolated");
    assert.equal(flaky.length, 1, actions.join(","));
    assert.deepEqual(flaky[0]!.payload.failingTestIds, ["t6b red"]);
    const finding = flaky[0]!.payload.finding as string;
    if (kind === "really-flaky") {
      // Flaky: no charge (used stays 0 above), and acceptance still needs
      // a clean run: the failing check keeps the run from completing.
      assert.equal(flaky[0]!.payload.rerunGreen, true, finding);
      assert.ok(finding.startsWith("flaky:") && finding.includes("still requires a clean run"), finding);
      assert.notEqual(projection.status, "completed");
    } else {
      // Consistent failure: the rerun of only "t6b red" failed again. The
      // correction planned above is charged exactly once at dispatch
      // (asserted with the cycle events).
      assert.equal(flaky[0]!.payload.rerunGreen, false, finding);
      assert.ok(finding.startsWith("consistent failure:"), finding);
    }
    assert.ok((flaky[0]!.payload.rerunEvidenceIds as string[]).length > 0, finding);
    // T6b repair (R2-B6): both junit report files (check + rerun) are
    // creation-recorded and removed by the OA-17 search; the verification
    // checkout is recorded retained (its own manager removes it).
    const reports = events.filter((event) => event.type === "temp.creation_recorded" && /\.aiboard-report-fv-[^\/]+\.xml$/.test(String(event.payload.path)));
    assert.equal(reports.length, 2, actions.join(","));
    for (const report of reports) assert.equal(existsSync(String(report.payload.path)), false, String(report.payload.path));
    const records = Object.values(projection.tempRecords ?? {});
    assert.ok(records.some((record) => record.retained === true && record.path.includes("verification-workspaces")), JSON.stringify(records));
    assert.ok(checked.some((event) => (event.payload.findings as { kind: string; action: string; path?: string }[]).some((entry) => entry.kind === "temp_path" && entry.action === "cleaned" && /aiboard-report-fv/.test(entry.path ?? ""))), actions.join(","));
  } finally {
    await handle?.close();
    await factory?.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("T6b factory run: a consistently failing npm tests check reruns only its failing test and records a consistent failure", async () => {
  await runFactoryScenario("fail-again");
});

test("T6b factory run: a really flaky npm test passes its narrowed rerun, is recorded flaky with no charge, and still needs a clean run", async () => {
  await runFactoryScenario("really-flaky");
});
