import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import { ArtifactStore } from "../../src/artifact-store.js";
import {
  createDeliveryBoundaryDriver,
  createDeliveryWorkspaceSlot,
} from "../../src/delivery-execution.js";
import {
  DELIVERY_ACCEPTANCE_RUNNER_ID,
  assertTestsOutcome,
  type DeliveryBoundaryCheck,
  type DeliveryBoundaryRecord,
} from "../../src/delivery-acceptance.js";
import {
  finalVerificationEventArtifactHashes,
  validateSchedulerEvidenceEvent,
  type SchedulerEvent,
  type SchedulerProjection,
} from "../../src/scheduler-store.js";
import { createExecutionHost } from "../../src/execution-host.js";
import { requireGitRunner } from "../../src/git-command.js";
import type { RunnerCapabilityContract } from "../../src/runner-capability-contract.js";
import { emptyRunnerCapabilitiesConfig } from "../../src/runner-capabilities-config.js";
import { SqliteEvidenceStore } from "../../src/sqlite-evidence-store.js";
import { VerificationWorkspaceManager } from "../../src/verification-workspace.js";
import {
  snapshotNativeBuildAmbientEnvironment,
} from "../../src/native-build-factory.js";
import { runGit } from "./git-fixture.js";
import { VALUE_TEST } from "./delivery-factory-scenario.js";

/**
 * TX-1 fast boundary harness. Drives the SAME production post-integration
 * boundary the NativeBuildFactory wires (createDeliveryBoundaryDriver with
 * the real audited execution host from createExecutionHost, the real
 * delivery workspace slot, the real FinalVerificationRuntime and report
 * planning inside runDeliveryCategory; no fakes on the execution path),
 * but against a real temp git project committed straight to an integration
 * revision — without the plan/worker/review/integration pump.
 *
 * The returned boundary record is assembled exactly the way the kernel
 * records `delivery.boundary_checked` in build-runtime.ts (`passed` is
 * every check `passed`; `executedScope` is `full_test_script`) — and,
 * before cleanup, it is run through the SAME kernel record validation the
 * scheduler runs when it records a boundary (`assertTestsOutcome` on the
 * tests check, the passed-check rules, `validateSchedulerEvidenceEvent`
 * against the live evidence store, and report-artifact existence), via the
 * real exported kernel functions. Accepted records additionally re-check
 * HEAD's accepted-path assertions, so every accepted matrix test checks
 * them again.
 */

const RUN_ID = "run-delivery-boundary";
const BOUNDARY_ID = "boundary:T1:1";
const ATTEMPT = 1;

function withPathPrefix(
  environment: Readonly<Record<string, string>>,
  prefix: string | undefined,
): Readonly<Record<string, string>> {
  if (!prefix) return environment;
  const name =
    Object.keys(environment).find((key) => key.toUpperCase() === "PATH") ??
    "PATH";
  const current = environment[name];
  return {
    ...environment,
    [name]: current ? `${prefix}${delimiter}${current}` : prefix,
  };
}

/**
 * B1 repair (test-only): run a produced boundary record through the same
 * kernel record validation the scheduler runs when it records
 * `delivery.boundary_checked` and an acceptance. The per-check rules mirror
 * the `deliveryBoundaryChecked` reducer in scheduler-store.ts; the three
 * substantive gates are the REAL exported kernel functions, not copies:
 * `assertTestsOutcome` (delivery-acceptance.ts), `validateSchedulerEvidenceEvent`
 * (scheduler-store.ts, against the harness's live evidence store with a
 * non-undefined projection so the command-evidence path runs), and
 * `finalVerificationEventArtifactHashes` + `ArtifactStore.verifySync` (the
 * artifact-existence gate sqlite-scheduler-store.ts applies on append).
 * Throws exactly when the kernel would reject the record.
 */
export function assertKernelRecordsBoundary(
  boundary: DeliveryBoundaryRecord,
  stores: { evidenceStore: SqliteEvidenceStore; artifacts: ArtifactStore },
): void {
  // The event is exactly what build-runtime.ts appends for
  // `delivery.boundary_checked`.
  const event: SchedulerEvent = {
    eventId: `kernel-check:${boundary.boundaryId}`,
    runId: RUN_ID,
    sequence: 0,
    type: "delivery.boundary_checked",
    occurredAt: new Date().toISOString(),
    actor: { role: "runner", id: DELIVERY_ACCEPTANCE_RUNNER_ID },
    idempotencyKey: `delivery-boundary:${boundary.boundaryId}`,
    payload: {
      taskId: boundary.taskId,
      boundaryId: boundary.boundaryId,
      generation: boundary.generation,
      attempt: boundary.attempt,
      integrationRevision: boundary.integrationRevision,
      executedScope: boundary.executedScope,
      changedFiles: [...boundary.changedFiles],
      selection: {
        rung: boundary.selection.rung,
        selectedTests: [...boundary.selection.selectedTests],
      },
      checks: boundary.checks.map((check) => ({
        ...check,
        evidenceIds: [...check.evidenceIds],
      })),
      passed: boundary.passed,
    },
  };
  if (boundary.executedScope !== "full_test_script") {
    throw new Error("Boundary checks must state that the whole project scripts ran.");
  }
  if (boundary.checks.length === 0) {
    throw new Error("Boundary checks require real check outcomes.");
  }
  for (const check of boundary.checks) {
    if (check.outcome === "passed" && (check.exitCode !== 0 || check.evidenceIds.length === 0)) {
      throw new Error("A passed boundary check requires exit code 0 and its evidence.");
    }
    if (check.checkId === "tests") {
      if (!check.report) throw new Error("The boundary tests check requires this run's test report reading.");
      assertTestsOutcome("Boundary tests", check.exitCode, check.outcome, check.report);
    }
    if (check.outcome === "failed" && check.evidenceIds.length === 0 && typeof check.reason !== "string") {
      throw new Error("A failed boundary check requires its evidence or reason.");
    }
  }
  if (boundary.passed !== boundary.checks.every((check) => check.outcome === "passed")) {
    throw new Error("Boundary passed must equal every check passing.");
  }
  validateSchedulerEvidenceEvent({} as SchedulerProjection, event, stores.evidenceStore);
  for (const hash of finalVerificationEventArtifactHashes(event)) {
    stores.artifacts.verifySync(hash);
  }
}

/**
 * HEAD's `runDeliveryFactoryScenario` accepted-path assertions that survive
 * without a pump projection (report status, real counts, artifact hash, the
 * passed tests check carrying evidence). Runs in the shared accepted path so
 * every accepted matrix test checks them again.
 */
function assertAcceptedBoundaryShape(boundary: DeliveryBoundaryRecord): void {
  const tests = boundary.checks.find((check) => check.checkId === "tests");
  assert.equal(tests?.report?.status, "passed", JSON.stringify(tests));
  assert.ok((tests?.report?.counts?.passed ?? 0) >= 1, "real counts: at least one executed test");
  assert.match(tests?.report?.artifactHash ?? "", /^[a-f0-9]{64}$/);
  assert.equal(boundary.passed, true, JSON.stringify(boundary));
  assert.ok(boundary.checks.some(
    (check) => check.checkId === "tests" && check.outcome === "passed" && check.evidenceIds.length > 0,
  ));
}

export async function runDeliveryBoundaryDirect(
  content: string,
  scripts: Record<string, string> = { test: "node --test" },
  options: {
    testFile?: string | null;
    extraFiles?: Record<string, string>;
    pathPrefix?: string;
    /**
     * Test-only fault injection: edits the assembled boundary record before
     * the kernel record validation runs (the negative test uses it to prove
     * the kernel rejects an edited tests report).
     */
    mutateBoundaryForTest?: (boundary: DeliveryBoundaryRecord) => void;
  } = {},
): Promise<{ boundary: DeliveryBoundaryRecord; integrationRevision: string }> {
  const root = mkdtempSync(join(tmpdir(), "aiboard delivery boundary "));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(
    join(project, "package.json"),
    JSON.stringify(
      {
        name: "delivery-boundary-fixture",
        version: "1.0.0",
        type: "module",
        packageManager: "npm@11.0.0",
        scripts,
      },
      null,
      2,
    ),
  );
  // The integrated state: the worker's file as committed by integration.
  writeFileSync(join(project, "src", "value.mjs"), content);
  // null = the project has no test files at all (the test command runs zero tests).
  if (options.testFile !== null)
    writeFileSync(
      join(project, "test", "value.test.mjs"),
      options.testFile ?? VALUE_TEST,
    );
  for (const [path, text] of Object.entries(options.extraFiles ?? {})) {
    mkdirSync(dirname(join(project, path)), { recursive: true });
    writeFileSync(join(project, path), text);
  }
  const npmCli = join(
    dirname(process.execPath),
    "node_modules",
    "npm",
    "bin",
    "npm-cli.js",
  );
  const lock = spawnSync(
    process.execPath,
    [npmCli, "install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund"],
    { cwd: project, encoding: "utf8" },
  );
  assert.equal(lock.status, 0, lock.stderr);
  // A real temp git project with a real integration revision.
  await runGit({ cwd: project, args: ["init", "-b", "main"] });
  await runGit({ cwd: project, args: ["add", "-A"] });
  await runGit({ cwd: project, args: ["commit", "-m", "integrated T1"] });
  const head = await runGit({ cwd: project, args: ["rev-parse", "HEAD"] });
  const integrationRevision = head.stdout.trim();
  assert.match(integrationRevision, /^[a-f0-9]{40}$/);

  const artifacts = new ArtifactStore(join(state, "artifacts"));
  const executionHost = createExecutionHost({
    projectRoot: project,
    stateDirectory: state,
    artifacts,
    ambientEnvironment: withPathPrefix(
      snapshotNativeBuildAmbientEnvironment(),
      options.pathPrefix,
    ),
  });
  // Existing test seam (as in final-verification-runtime-b1.test.ts): bind
  // the real audited host without a live capability snapshot.
  const binding = await executionHost.bindRun({
    runId: RUN_ID,
    permissionProfile: "full",
    capabilityContract: { digest: "f".repeat(64) } as RunnerCapabilityContract,
    capabilitiesConfig: emptyRunnerCapabilitiesConfig(),
  });
  // The same ambient source the factory's deliveryNodeOptions reads, so the
  // project's own NODE_OPTIONS is kept when the reporter flags are added.
  const ambientNodeOptions = (): string | undefined => {
    const source = executionHost.filteredEnvironmentSource();
    const name = Object.keys(source).find(
      (key) => key.toUpperCase() === "NODE_OPTIONS",
    );
    return name ? source[name] : undefined;
  };
  const deliveryGit = requireGitRunner(binding.git).lifecycle("verification").run;
  const evidenceStore = new SqliteEvidenceStore(join(state, "evidence.sqlite"));
  const boundaryWorkspace = createDeliveryWorkspaceSlot(
    (targetRevision?: string) =>
      new VerificationWorkspaceManager({
        execute: deliveryGit,
        repositoryRoot: project,
        stateDirectory: state,
        runId: RUN_ID,
        kind: "independent-verifier",
        workspaceSuffix: "delivery-boundary",
        ...(targetRevision ? { targetRevision } : {}),
      }),
  );
  // The same production driver construction the factory uses.
  const driver = createDeliveryBoundaryDriver({
    runId: RUN_ID,
    git: deliveryGit,
    artifacts,
    evidenceStore,
    execution: binding.commandExecution,
    boundaryWorkspace,
    ambientNodeOptions,
    changedFilesFor: async () => ["src/value.mjs"],
  });
  try {
    const outcome = await driver.check({
      runId: RUN_ID,
      taskId: "T1",
      boundaryId: BOUNDARY_ID,
      attempt: ATTEMPT,
      integrationRevision,
    });
    // Assembled exactly as the kernel records delivery.boundary_checked.
    const checks: DeliveryBoundaryCheck[] = outcome.checks.map((check) => ({
      ...check,
      evidenceIds: [...check.evidenceIds],
    }));
    const boundary: DeliveryBoundaryRecord = {
      taskId: "T1",
      boundaryId: BOUNDARY_ID,
      generation: 1,
      attempt: ATTEMPT,
      integrationRevision,
      executedScope: "full_test_script",
      changedFiles: [...outcome.changedFiles],
      selection: {
        rung: outcome.selection.rung,
        selectedTests: [...outcome.selection.selectedTests],
      },
      checks,
      passed: outcome.checks.every((check) => check.outcome === "passed"),
      sequence: 0,
    };
    options.mutateBoundaryForTest?.(boundary);
    // B1: every record — accepted or not — goes through the kernel's own
    // record validation before cleanup; accepted records additionally carry
    // HEAD's accepted-path assertions again in this shared path.
    if (boundary.passed) assertAcceptedBoundaryShape(boundary);
    assertKernelRecordsBoundary(boundary, { evidenceStore, artifacts });
    return { boundary, integrationRevision };
  } finally {
    await boundaryWorkspace.cleanup().catch(() => undefined);
    evidenceStore.close();
    await binding.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
}
