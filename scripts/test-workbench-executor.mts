/* WorkBench executor checks (run: npx tsx scripts/test-workbench-executor.mts) */
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { checkBenchRunner, runBenchCommand } from "../lib/client/bench-runner";
import { executeWorkBenchVerifierOnly } from "../lib/benchmark/workbench/executor";
import { createRecoverableJobServiceCase } from "../lib/benchmark/workbench/recoverable-job-service/case-pack";
import {
  RECOVERABLE_JOB_SERVICE_FAMILIES,
  RECOVERABLE_JOB_SERVICE_INPUT_HASHES,
  RECOVERABLE_JOB_SERVICE_METADATA,
  RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE,
} from "../lib/benchmark/workbench/recoverable-job-service/fixture";
import type { CertifiedAttemptStatus } from "../lib/benchmark/types";
import type { WorkBenchCase, WorkBenchExecutionInput } from "../lib/benchmark/workbench/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function waitForHealth(url: string, token: string): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 60; attempt++) {
    const health = await checkBenchRunner({ url, token });
    if (health.ok) return;
    lastError = health.error ?? JSON.stringify(health);
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`bench runner did not become healthy: ${lastError}`);
}

function stop(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolveStop) => {
    if (child.killed || child.exitCode !== null) {
      resolveStop();
      return;
    }
    child.once("exit", () => resolveStop());
    child.kill();
    setTimeout(() => {
      if (child.exitCode === null) child.kill("SIGKILL");
    }, 1000).unref();
  });
}

interface FakeRunnerOptions {
  prepareStatus?: number;
  prepareError?: string;
  prepareDelayMs?: number;
  verifierStatus?: number;
  verifierError?: string;
  verifierDelayMs?: number;
  verifierResultJson?: string;
  verifierPassed?: boolean;
  verifierScore?: number;
  verifierExitCode?: number;
  diff?: string;
  prepareGate?: Promise<void>;
  verifierGate?: Promise<void>;
  cleanupGate?: Promise<void>;
}

async function startCanonicalAttemptRunner(preparedAttemptId: string, options: FakeRunnerOptions = {}): Promise<{
  url: string;
  token: string;
  requests: Array<{ path: string; body: Record<string, unknown> }>;
  abortedPaths: string[];
  stop: () => Promise<void>;
}> {
  const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
  const abortedPaths: string[] = [];
  const token = `fake-runner-${Date.now()}`;
  const verifierJson = JSON.stringify({
    passed: true,
    score: 1,
    summary: "ok",
    assertions: [{ id: "result", label: "result", passed: true, weight: 1 }],
  });
  const server = createServer(async (req, res) => {
    const path = req.url ?? "/";
    const body = await readJsonRequest(req);
    requests.push({ path, body });
    res.on("close", () => {
      if (!res.writableEnded) abortedPaths.push(path);
    });
    if (req.headers["x-runner-token"] !== token) {
      sendJsonResponse(res, 401, { error: "token required" });
      return;
    }
    switch (path) {
      case "/bench/prepare":
        if (options.prepareGate) await options.prepareGate;
        if (options.prepareDelayMs) await delay(options.prepareDelayMs);
        if (options.prepareStatus && options.prepareStatus >= 400) {
          sendJsonResponse(res, options.prepareStatus, { error: options.prepareError ?? "prepare failed" });
          return;
        }
        sendJsonResponse(res, 200, {
          attemptId: preparedAttemptId,
          caseId: body.caseId,
          root: "/fake/workspace",
        });
        return;
      case "/bench/run-verifier":
        if (options.verifierGate) await options.verifierGate;
        if (options.verifierDelayMs) await delay(options.verifierDelayMs);
        if (options.verifierStatus && options.verifierStatus >= 400) {
          sendJsonResponse(res, options.verifierStatus, { error: options.verifierError ?? "verifier failed" });
          return;
        }
        sendJsonResponse(res, 200, {
          passed: options.verifierPassed ?? true,
          score: options.verifierScore ?? 1,
          durationMs: 12,
          exitCode: options.verifierExitCode ?? 0,
          stdoutPreview: options.verifierResultJson ?? verifierJson,
          stderrPreview: "",
          resultJson: options.verifierResultJson ?? verifierJson,
          artifactIds: ["verifier-result.json"],
        });
        return;
      case "/bench/diff":
        sendJsonResponse(res, 200, { diff: options.diff ?? "--- a/index.js\n+++ b/index.js\n+fixed\n" });
        return;
      case "/bench/cleanup":
        if (options.cleanupGate) await options.cleanupGate;
        sendJsonResponse(res, 200, { removed: true });
        return;
      default:
        sendJsonResponse(res, 404, { error: `unknown endpoint ${path}` });
    }
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fake runner did not bind a TCP port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    token,
    requests,
    abortedPaths,
    stop: () => stopServer(server),
  };
}

function invalidRecoverableJobServiceResult(): string {
  const families = RECOVERABLE_JOB_SERVICE_FAMILIES.map((family) => ({
    id: family.id,
    group: family.group,
    mandatory: true,
    passed: false,
    safetyChecked: false,
    scheduleId: "not-executed",
    reason: "Evaluation input was invalid.",
    assertions: [{ label: "Trusted input accepted", passed: false }],
    operations: 0,
    promiseJobs: 0,
    variants: RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE.variantIds
      .filter((variantId) => variantId.startsWith(`${family.id}/`))
      .map((variantId) => ({
        id: variantId,
        passed: false,
        safetyChecked: false,
        reason: "Evaluation input was invalid.",
        assertions: [{ label: "Trusted input accepted", passed: false }],
        operations: 0,
        promiseJobs: 0,
        inputIdentity: null,
      })),
  }));
  const groups = Object.fromEntries(
    ["A", "B", "C", "D", "E"].map((group) => [
      group,
      {
        passed: 0,
        total: families.filter((family) => family.group === group).length,
        coverage: 0,
      },
    ])
  );
  const diagnostics = {
    schemaVersion: RECOVERABLE_JOB_SERVICE_METADATA.schemaVersion,
    benchmark: "recoverable-job-service",
    profile: RECOVERABLE_JOB_SERVICE_METADATA.profile,
    contractVersion: RECOVERABLE_JOB_SERVICE_METADATA.contractVersion,
    suiteVersion: RECOVERABLE_JOB_SERVICE_METADATA.suiteVersion,
    candidateHash: "0".repeat(64),
    contractHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash,
    suiteHash: RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash,
    inputIdentity: null,
    provenance: RECOVERABLE_JOB_SERVICE_PRODUCTION_PROVENANCE,
    status: "invalid_harness",
    resolved: false,
    families,
    groups,
    macroCoverage: 0,
    safetyFailures: [],
    error: {
      kind: "invalid_replay_input",
      message: "Trusted replay input was rejected.",
      familyId: null,
    },
  };
  return JSON.stringify({
    passed: false,
    score: 0,
    summary: "Recoverable Job Service evaluation invalid",
    assertions: families.map((family) => ({
      id: family.id,
      label: `${family.id} — ${family.reason}`,
      passed: false,
      weight: 1,
    })),
    recoverableJobService: diagnostics,
  });
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (predicate()) return;
    await delay(5);
  }
  throw new Error("Timed out waiting for fake WorkBench runner state.");
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function readJsonRequest(req: NodeJS.ReadableStream): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw.trim()) return {};
  const parsed = JSON.parse(raw) as unknown;
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : {};
}

function sendJsonResponse(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function stopServer(server: Server): Promise<void> {
  return new Promise((resolveStop, rejectStop) => {
    server.close((error) => {
      if (error) rejectStop(error);
      else resolveStop();
    });
  });
}

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const root = await mkdtemp(join(tmpdir(), "aiboard-workbench-executor-"));
const fixtureRoot = join(root, "fixture");
const runsRoot = join(root, ".aiboard-bench", "runs");
const port = 20_000 + Math.floor(Math.random() * 10_000);
const token = `test-token-${Date.now()}`;
const url = `http://127.0.0.1:${port}`;
const modelCommand = `node -e "require('fs').writeFileSync('index.js','module.exports = (a,b) => a * b;')"`;
const verifierCommand = "node verifier.js";

await mkdir(fixtureRoot, { recursive: true });
await writeFile(join(fixtureRoot, ".keep"), "", "utf8");
await writeFile(join(fixtureRoot, "index.js"), "module.exports = (a,b) => a - b;\n", "utf8");
await writeFile(
  join(fixtureRoot, "verifier.js"),
  [
    "const fs = require('fs');",
    "const add = require('./index.js');",
    "const passed = add(2, 3) === 5;",
    "const result = {",
    "  passed,",
    "  score: passed ? 1 : 0,",
    "  summary: passed ? 'ok' : 'bad math',",
    "  assertions: [{ id: 'add', label: 'add returns a sum', passed, weight: 1 }],",
    "};",
    "fs.writeFileSync('verifier-result.json', JSON.stringify(result));",
    "console.log(JSON.stringify(result));",
    "process.exit(passed ? 0 : 1);",
  ].join("\n"),
  "utf8"
);

const caseRecord: WorkBenchCase = {
  schemaVersion: 1,
  id: "workbench-executor-0001",
  title: "Fix add",
  description: "The exported function must return a sum.",
  difficulty: "easy",
  tags: ["fixture"],
  caseVersion: "0.1.0",
  prompt: {
    userRequest: "Fix the add function so it returns a + b.",
    publicContext: "Run the verifier before reporting success.",
  },
  repo: {
    url: fixtureRoot,
    baseCommit: "fixture-base",
    shallowClone: true,
    fixtureHash: "fixture:add",
  },
  environment: {
    type: "local-runner",
    timeoutSeconds: 30,
    network: "dependency-only",
  },
  verifier: {
    command: verifierCommand,
    resultFile: "verifier-result.json",
    timeoutSeconds: 10,
  },
  budget: { maxUsd: 1, maxWallClockSeconds: 30 },
  scoring: {
    scoringVersion: "certified-v0.1",
    costTargetUsd: 1,
    timeTargetSeconds: 30,
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-WORKBENCH-EXECUTOR",
    referenceSolutionPrivate: true,
  },
  allowedCommands: [modelCommand, verifierCommand],
};

{
  const prepareGate = deferred<void>();
  const cleanupGate = deferred<void>();
  const runner = await startCanonicalAttemptRunner("cancelled-prepare-attempt", {
    prepareGate: prepareGate.promise,
    cleanupGate: cleanupGate.promise,
  });
  const controller = new AbortController();
  const cancellation = new Error("cancel during WorkBench prepare");
  let settled = false;
  try {
    const pending = executeWorkBenchVerifierOnly({
      case: caseRecord,
      runner: { url: runner.url, token: runner.token },
      attemptId: "cancelled-prepare-attempt",
      runId: "run-cancelled-prepare",
      teamCompositionId: "team-fixture",
      signal: controller.signal,
      cleanup: true,
      runBuild: async () => {
        throw new Error("cancelled prepare must not enter build");
      },
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await waitFor(() =>
      runner.requests.some((request) => request.path === "/bench/prepare")
    );
    controller.abort(cancellation);
    await waitFor(() => runner.abortedPaths.includes("/bench/prepare"));
    await waitFor(() =>
      runner.requests.some((request) => request.path === "/bench/cleanup")
    );
    await delay(20);
    assert.equal(settled, false, "cancelled prepare waits for cleanup");
    cleanupGate.resolve();
    await assert.rejects(pending, (error) => error === cancellation);
    assert.equal(
      runner.requests.some((request) => request.path === "/bench/run-verifier"),
      false
    );
  } finally {
    prepareGate.resolve();
    cleanupGate.resolve();
    await runner.stop();
  }
}

{
  const verifierGate = deferred<void>();
  const cleanupGate = deferred<void>();
  const runner = await startCanonicalAttemptRunner("cancelled-verifier-attempt", {
    verifierGate: verifierGate.promise,
    cleanupGate: cleanupGate.promise,
  });
  const controller = new AbortController();
  const cancellation = new Error("cancel during WorkBench verifier");
  let settled = false;
  try {
    const pending = executeWorkBenchVerifierOnly({
      case: caseRecord,
      runner: { url: runner.url, token: runner.token },
      attemptId: "cancelled-verifier-attempt",
      runId: "run-cancelled-verifier",
      teamCompositionId: "team-fixture",
      signal: controller.signal,
      cleanup: true,
      runBuild: async () => ({
        traceIds: ["trace-cancelled-verifier"],
        modelCalls: 1,
      }),
    });
    void pending.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      }
    );
    await waitFor(() =>
      runner.requests.some((request) => request.path === "/bench/run-verifier")
    );
    controller.abort(cancellation);
    await waitFor(() => runner.abortedPaths.includes("/bench/run-verifier"));
    await waitFor(() =>
      runner.requests.some((request) => request.path === "/bench/cleanup")
    );
    await delay(20);
    assert.equal(settled, false, "cancelled verifier waits for cleanup");
    cleanupGate.resolve();
    await assert.rejects(pending, (error) => error === cancellation);
    assert.equal(
      runner.requests.some((request) => request.path === "/bench/diff"),
      false
    );
  } finally {
    verifierGate.resolve();
    cleanupGate.resolve();
    await runner.stop();
  }
}

async function expectStructuredFailure(
  name: string,
  input: WorkBenchExecutionInput,
  expectedStatus: CertifiedAttemptStatus
): Promise<Awaited<ReturnType<typeof executeWorkBenchVerifierOnly>> | null> {
  try {
    const result = await executeWorkBenchVerifierOnly(input);
    check(`${name} returns ${expectedStatus}`, result.attempt.status === expectedStatus, result.attempt);
    check(`${name} returns zero score`, result.attempt.verifiedQuality === 0 && result.attempt.jobSuccessScore === 0 && result.attempt.efficiencyScore === 0, result.attempt);
    check(`${name} returns synthetic verifier result`, result.verifierResult.attemptId === result.attempt.id && result.verifierResult.passed === false && result.parsedVerifierResult.passed === false, result.verifierResult);
    check(`${name} records a structured failure id`, result.attempt.failureIds.length === 1 && result.attempt.failureIds[0].startsWith(`${result.attempt.id}:failure:`), result.attempt.failureIds);
    check(`${name} emits a failure log artifact`, result.artifacts.some((artifact) => artifact.kind === "log" && artifact.id === `${result.attempt.id}:failure-log`), result.artifacts);
    return result;
  } catch (error) {
    check(`${name} does not throw`, false, error instanceof Error ? error.message : String(error));
    return null;
  }
}

const missingRunBuildFailure = await expectStructuredFailure(
  "missing runBuild callback",
  {
    case: caseRecord,
    runner: { url: "http://127.0.0.1:9", token },
    attemptId: "attempt-missing-runbuild",
    runId: "run-missing-runbuild",
    teamCompositionId: "team-fixture",
  },
  "invalid_harness"
);
check(
  "failed WorkBench attempt with no tool calls omits tool reliability score",
  missingRunBuildFailure?.attempt.toolReliabilityScore == null,
  missingRunBuildFailure?.attempt
);

await expectStructuredFailure(
  "runner unavailable",
  {
    case: caseRecord,
    runner: { url: "http://127.0.0.1:9", token },
    attemptId: "attempt-runner-unavailable",
    runId: "run-runner-unavailable",
    teamCompositionId: "team-fixture",
    runBuild: async () => ({
      traceIds: ["trace-never-used"],
      modelCalls: 1,
    }),
  },
  "invalid_environment"
);

const setupFailureRunner = await startCanonicalAttemptRunner("setup-failure-attempt", {
  prepareStatus: 422,
  prepareError: "Setup command failed with exit 1.",
});
try {
  await expectStructuredFailure(
    "setup failure",
    {
      case: caseRecord,
      runner: { url: setupFailureRunner.url, token: setupFailureRunner.token },
      attemptId: "attempt-setup-failure",
      runId: "run-setup-failure",
      teamCompositionId: "team-fixture",
      runBuild: async () => ({
        traceIds: ["trace-never-used"],
        modelCalls: 1,
      }),
    },
    "invalid_case"
  );
} finally {
  await setupFailureRunner.stop();
}

const buildCrashRunner = await startCanonicalAttemptRunner("build-crash-attempt");
try {
  await expectStructuredFailure(
    "runBuild crash",
    {
      case: caseRecord,
      runner: { url: buildCrashRunner.url, token: buildCrashRunner.token },
      attemptId: "attempt-build-crash",
      runId: "run-build-crash",
      teamCompositionId: "team-fixture",
      cleanup: true,
      runBuild: async () => {
        throw new Error("Harness callback crashed while applying edits.");
      },
    },
    "invalid_harness"
  );
  check(
    "failed WorkBench attempts retain their prepared workspace",
    !buildCrashRunner.requests.some((request) => request.path === "/bench/cleanup"),
    buildCrashRunner.requests
  );
} finally {
  await buildCrashRunner.stop();
}

const typedBuildFailureRunner = await startCanonicalAttemptRunner("typed-build-failure-attempt");
try {
  const typedFailure = await expectStructuredFailure(
    "typed lifecycle protocol failure",
    {
      case: caseRecord,
      runner: { url: typedBuildFailureRunner.url, token: typedBuildFailureRunner.token },
      attemptId: "attempt-typed-build-failure",
      runId: "run-typed-build-failure",
      teamCompositionId: "team-fixture",
      cleanup: true,
      runBuild: async () => {
        throw Object.assign(new Error("Lifecycle protocol repair was exhausted."), {
          certifiedStatus: "failed_tool_use",
          certifiedCode: "invalid_lifecycle_batch",
          runnerProjectPath: "C:\\retained-project",
          runnerStatePath: "C:\\retained-state",
          buildResult: {
            traceIds: ["trace-protocol-failure"],
            artifactIds: ["audit-protocol-failure"],
            modelCalls: 3,
            toolCalls: 7,
            validToolCalls: 5,
            inputTokens: 12_345,
            outputTokens: 678,
          },
        });
      },
    },
    "failed_tool_use"
  );
  check(
    "typed build failure preserves usage metrics",
    typedFailure?.attempt.modelCalls === 3 &&
      typedFailure.attempt.toolCalls === 7 &&
      typedFailure.attempt.inputTokens === 12_345 &&
      typedFailure.attempt.outputTokens === 678,
    typedFailure?.attempt
  );
  check(
    "typed build failure preserves trace and audit references",
    typedFailure?.attempt.traceIds.includes("trace-protocol-failure") === true &&
      typedFailure.attempt.artifactIds.includes("audit-protocol-failure") === true,
    typedFailure?.attempt
  );
} finally {
  await typedBuildFailureRunner.stop();
}

const providerFailureRunner = await startCanonicalAttemptRunner("provider-failure-attempt");
try {
  await expectStructuredFailure(
    "provider unavailable during build",
    {
      case: caseRecord,
      runner: { url: providerFailureRunner.url, token: providerFailureRunner.token },
      attemptId: "attempt-provider-failure",
      runId: "run-provider-failure",
      teamCompositionId: "team-fixture",
      cleanup: true,
      runBuild: async () => {
        throw new Error("Provider 429 rate limit before output.");
      },
    },
    "provider_unavailable"
  );
} finally {
  await providerFailureRunner.stop();
}

const noTraceRunner = await startCanonicalAttemptRunner("no-trace-attempt");
try {
  await expectStructuredFailure(
    "missing trace evidence",
    {
      case: caseRecord,
      runner: { url: noTraceRunner.url, token: noTraceRunner.token },
      attemptId: "attempt-no-trace",
      runId: "run-no-trace",
      teamCompositionId: "team-fixture",
      cleanup: true,
      runBuild: async () => ({
        traceIds: [],
        modelCalls: 1,
      }),
    },
    "invalid_harness"
  );
} finally {
  await noTraceRunner.stop();
}

const budgetRunner = await startCanonicalAttemptRunner("budget-attempt");
try {
  await expectStructuredFailure(
    "budget exceeded",
    {
      case: {
        ...caseRecord,
        id: "workbench-executor-budget",
        budget: { ...caseRecord.budget, maxModelCalls: 1 },
      },
      runner: { url: budgetRunner.url, token: budgetRunner.token },
      attemptId: "attempt-budget",
      runId: "run-budget",
      teamCompositionId: "team-fixture",
      cleanup: true,
      runBuild: async () => ({
        traceIds: ["trace-budget"],
        modelCalls: 2,
      }),
    },
    "failed_budget"
  );
} finally {
  await budgetRunner.stop();
}

const verifierCrashRunner = await startCanonicalAttemptRunner("verifier-crash-attempt", {
  verifierStatus: 500,
  verifierError: "Verifier process crashed.",
});
try {
  await expectStructuredFailure(
    "verifier crash",
    {
      case: caseRecord,
      runner: { url: verifierCrashRunner.url, token: verifierCrashRunner.token },
      attemptId: "attempt-verifier-crash",
      runId: "run-verifier-crash",
      teamCompositionId: "team-fixture",
      cleanup: true,
      runBuild: async () => ({
        traceIds: ["trace-verifier-crash"],
        modelCalls: 1,
      }),
    },
    "invalid_case"
  );
} finally {
  await verifierCrashRunner.stop();
}

const rjsCase = createRecoverableJobServiceCase();
const invalidRjsResult = invalidRecoverableJobServiceResult();
const invalidRjsRunner = await startCanonicalAttemptRunner("invalid-rjs-attempt", {
  verifierResultJson: invalidRjsResult,
  verifierPassed: false,
  verifierScore: 0,
  verifierExitCode: 2,
});
try {
  const invalidRjs = await executeWorkBenchVerifierOnly({
    case: rjsCase,
    runner: { url: invalidRjsRunner.url, token: invalidRjsRunner.token },
    attemptId: "invalid-rjs-attempt",
    runId: "run-invalid-rjs",
    teamCompositionId: "team-fixture",
    runBuild: async () => ({
      traceIds: ["trace-invalid-rjs"],
      modelCalls: 1,
    }),
  });
  check(
    "trusted invalid diagnostics remain excluded from candidate scoring",
    invalidRjs.attempt.status === "invalid_harness" &&
      invalidRjs.attempt.verifiedQuality === 0 &&
      invalidRjs.parsedVerifierResult.failureClass === "invalid_harness",
    invalidRjs.attempt
  );
  check(
    "trusted invalid diagnostics retain their complete result artifact",
    invalidRjs.artifacts.some(
      (artifact) =>
        artifact.id === "invalid-rjs-attempt:verifier-result" &&
        artifact.content.includes('"recoverableJobService"') &&
        artifact.content.includes('"families"')
    ),
    invalidRjs.artifacts
  );
  check(
    "trusted attempts persist their exact public contract snapshot",
    invalidRjs.artifacts.some(
      (artifact) =>
        artifact.id === "invalid-rjs-attempt:rjs-public-contract" &&
        artifact.content.includes(RECOVERABLE_JOB_SERVICE_INPUT_HASHES.contractHash) &&
        artifact.content.includes(RECOVERABLE_JOB_SERVICE_INPUT_HASHES.suiteHash) &&
        artifact.content.includes('"problem.md"')
    ),
    invalidRjs.artifacts
  );
} catch (error) {
  check(
    "trusted invalid diagnostics contract did not throw",
    false,
    error instanceof Error ? error.message : String(error)
  );
} finally {
  await invalidRjsRunner.stop();
}

const mismatchedRjsExitRunner = await startCanonicalAttemptRunner("mismatched-rjs-exit", {
  verifierResultJson: invalidRjsResult,
  verifierPassed: false,
  verifierScore: 0,
  verifierExitCode: 1,
});
try {
  const mismatch = await executeWorkBenchVerifierOnly({
    case: rjsCase,
    runner: { url: mismatchedRjsExitRunner.url, token: mismatchedRjsExitRunner.token },
    attemptId: "mismatched-rjs-exit",
    runId: "run-mismatched-rjs-exit",
    teamCompositionId: "team-fixture",
    runBuild: async () => ({
      traceIds: ["trace-mismatched-rjs-exit"],
      modelCalls: 1,
    }),
  });
  check(
    "trusted verifier exit and diagnostics must agree",
    mismatch.attempt.status === "invalid_harness" &&
      mismatch.artifacts.some(
        (artifact) =>
          artifact.id === "mismatched-rjs-exit:failure-log" &&
          /exit code/i.test(artifact.content)
      ),
    mismatch.artifacts
  );
} catch (error) {
  check(
    "trusted verifier exit consistency failure stays structured",
    false,
    error instanceof Error ? error.message : String(error)
  );
} finally {
  await mismatchedRjsExitRunner.stop();
}

const canonicalRunner = await startCanonicalAttemptRunner("prepared-attempt-id");
try {
  const preparedHookIds: string[] = [];
  let preparedHookCompleted = false;
  const canonicalResult = await executeWorkBenchVerifierOnly({
    case: caseRecord,
    runner: { url: canonicalRunner.url, token: canonicalRunner.token },
    attemptId: "input-attempt-id",
    runId: "run-canonical-attempt-id",
    teamCompositionId: "team-fixture",
    cleanup: true,
    onAttemptPrepared: async (attemptId) => {
      await Promise.resolve();
      preparedHookIds.push(attemptId);
      preparedHookCompleted = true;
    },
    runBuild: async (context) => {
      check(
        "executor awaits prepared-attempt hook before canonical build callback",
        preparedHookCompleted,
        { preparedHookCompleted, preparedHookIds }
      );
      check("executor passes prepared attempt id to canonical build callback", context.attemptId === "prepared-attempt-id", context);
      return {
        traceIds: ["trace-canonical-attempt"],
        costUsd: 0.02,
        inputTokens: 12,
        outputTokens: 8,
        modelCalls: 1,
        toolCalls: 2,
        validToolCalls: 1,
      };
    },
  });
  check("attempt record uses prepared attempt id", canonicalResult.attempt.id === "prepared-attempt-id", canonicalResult.attempt);
  check(
    "executor publishes the authoritative prepared attempt id exactly once",
    JSON.stringify(preparedHookIds) === JSON.stringify(["prepared-attempt-id"]),
    preparedHookIds
  );
  check("verifier record uses prepared attempt id", canonicalResult.verifierResult.id === "prepared-attempt-id:verifier" && canonicalResult.verifierResult.attemptId === "prepared-attempt-id", canonicalResult.verifierResult);
  check("artifact records use prepared attempt id", canonicalResult.artifacts.every((artifact) => artifact.id.startsWith("prepared-attempt-id:") && artifact.attemptId === "prepared-attempt-id"), canonicalResult.artifacts);
  check("attempt artifact ids use prepared attempt id", canonicalResult.attempt.artifactIds.includes("prepared-attempt-id:verifier-result") && canonicalResult.attempt.artifactIds.includes("prepared-attempt-id:patch"), canonicalResult.attempt.artifactIds);
  check("attempt records tool reliability score 0-100", canonicalResult.attempt.toolReliabilityScore === 50, canonicalResult.attempt);
  check("cleanup uses prepared attempt id", canonicalRunner.requests.some((request) => request.path === "/bench/cleanup" && request.body.attemptId === "prepared-attempt-id"), canonicalRunner.requests);
} catch (error) {
  check("canonical attempt id contract did not throw", false, error instanceof Error ? error.message : String(error));
} finally {
  await canonicalRunner.stop();
}

const rejectedPreparedOwnerRunner = await startCanonicalAttemptRunner(
  "prepared-owner-conflict"
);
try {
  let rejectedOwnerBuildCalls = 0;
  let rejectedOwnerError: unknown = null;
  try {
    await executeWorkBenchVerifierOnly({
      case: caseRecord,
      runner: {
        url: rejectedPreparedOwnerRunner.url,
        token: rejectedPreparedOwnerRunner.token,
      },
      attemptId: "planned-owner-conflict",
      runId: "run-owner-conflict",
      teamCompositionId: "team-fixture",
      cleanup: true,
      onAttemptPrepared: async () => {
        throw new Error(
          "Certified attempt owner prepared-owner-conflict has conflicting metadata."
        );
      },
      runBuild: async () => {
        rejectedOwnerBuildCalls++;
        return {
          traceIds: ["trace-owner-conflict"],
          modelCalls: 1,
        };
      },
    });
  } catch (error) {
    rejectedOwnerError = error;
  }
  check(
    "prepared-owner rejection propagates instead of becoming an invalid_harness result",
    rejectedOwnerError instanceof Error &&
      rejectedOwnerError.message ===
        "Certified attempt owner prepared-owner-conflict has conflicting metadata.",
    rejectedOwnerError
  );
  check(
    "prepared-owner rejection aborts before build/model/tool work",
    rejectedOwnerBuildCalls === 0,
    { rejectedOwnerBuildCalls }
  );
} finally {
  await rejectedPreparedOwnerRunner.stop();
}

const noToolRunner = await startCanonicalAttemptRunner("no-tool-attempt");
try {
  const noToolResult = await executeWorkBenchVerifierOnly({
    case: caseRecord,
    runner: { url: noToolRunner.url, token: noToolRunner.token },
    attemptId: "input-no-tool-attempt",
    runId: "run-no-tool-attempt",
    teamCompositionId: "team-fixture",
    cleanup: true,
    runBuild: async () => ({
      traceIds: ["trace-no-tool-attempt"],
      modelCalls: 1,
      toolCalls: 0,
      validToolCalls: 0,
    }),
  });
  check(
    "WorkBench attempts with no tool calls do not record zero tool reliability",
    noToolResult.attempt.toolReliabilityScore == null,
    noToolResult.attempt
  );
} catch (error) {
  check("no-tool WorkBench attempt contract did not throw", false, error instanceof Error ? error.message : String(error));
} finally {
  await noToolRunner.stop();
}

const timeScoreRunner = await startCanonicalAttemptRunner("time-score-attempt", {
  verifierDelayMs: 50,
});
try {
  const timeScoreResult = await executeWorkBenchVerifierOnly({
    case: {
      ...caseRecord,
      id: "workbench-executor-time-score",
      scoring: {
        ...caseRecord.scoring,
        timeTargetSeconds: 0.01,
      },
      budget: {
        ...caseRecord.budget,
        maxWallClockSeconds: 1,
      },
    },
    runner: { url: timeScoreRunner.url, token: timeScoreRunner.token },
    attemptId: "attempt-time-score",
    runId: "run-time-score",
    teamCompositionId: "team-fixture",
    cleanup: true,
    runBuild: async () => ({
      traceIds: ["trace-time-score"],
      modelCalls: 1,
      toolCalls: 1,
      validToolCalls: 1,
      durationMs: 5,
    }),
  });
  check(
    "WorkBench timeFactor scores model-attributable build time, not verifier wall clock",
    timeScoreResult.score.timeFactor === 1,
    timeScoreResult.score
  );
} catch (error) {
  check("WorkBench timeFactor build-time contract did not throw", false, error instanceof Error ? error.message : String(error));
} finally {
  await timeScoreRunner.stop();
}

const slowBuildTimeRunner = await startCanonicalAttemptRunner("slow-build-time-attempt");
try {
  const slowBuildTimeResult = await executeWorkBenchVerifierOnly({
    case: {
      ...caseRecord,
      id: "workbench-executor-slow-build-time",
      scoring: {
        ...caseRecord.scoring,
        timeTargetSeconds: 0.01,
      },
    },
    runner: { url: slowBuildTimeRunner.url, token: slowBuildTimeRunner.token },
    attemptId: "attempt-slow-build-time",
    runId: "run-slow-build-time",
    teamCompositionId: "team-fixture",
    cleanup: true,
    runBuild: async () => ({
      traceIds: ["trace-slow-build-time"],
      modelCalls: 1,
      toolCalls: 1,
      validToolCalls: 1,
      durationMs: 50,
    }),
  });
  check(
    "WorkBench timeFactor still penalizes slow model-attributable build time",
    slowBuildTimeResult.score.timeFactor < 1,
    slowBuildTimeResult.score
  );
} catch (error) {
  check("WorkBench slow build-time contract did not throw", false, error instanceof Error ? error.message : String(error));
} finally {
  await slowBuildTimeRunner.stop();
}

const budgetBuildTimeRunner = await startCanonicalAttemptRunner("budget-buildtime-attempt", {
  prepareDelayMs: 50,
});
try {
  const budgetBuildTimeResult = await executeWorkBenchVerifierOnly({
    case: {
      ...caseRecord,
      id: "workbench-executor-buildtime-budget",
      budget: {
        ...caseRecord.budget,
        maxWallClockSeconds: 0.01,
      },
    },
    runner: { url: budgetBuildTimeRunner.url, token: budgetBuildTimeRunner.token },
    attemptId: "attempt-buildtime-budget",
    runId: "run-buildtime-budget",
    teamCompositionId: "team-fixture",
    cleanup: true,
    runBuild: async () => ({
      traceIds: ["trace-buildtime-budget"],
      modelCalls: 1,
      toolCalls: 1,
      validToolCalls: 1,
      durationMs: 5,
    }),
  });
  check(
    "WorkBench wall-clock budget uses build time, not prepare overhead",
    budgetBuildTimeResult.attempt.status !== "failed_budget",
    budgetBuildTimeResult.attempt
  );
} catch (error) {
  check("WorkBench build-time budget contract did not throw", false, error instanceof Error ? error.message : String(error));
} finally {
  await budgetBuildTimeRunner.stop();
}

const child = spawn(process.execPath, [
  join(repoRoot, "scripts", "bench-runner.mjs"),
  "--port",
  String(port),
  "--token",
  token,
  "--root",
  runsRoot,
], {
  cwd: repoRoot,
  stdio: ["ignore", "pipe", "pipe"],
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += String(chunk);
});

try {
  await waitForHealth(url, token);
  const result = await executeWorkBenchVerifierOnly({
    case: caseRecord,
    runner: { url, token },
    attemptId: "attempt-workbench-executor",
    runId: "run-workbench-executor",
    teamCompositionId: "team-fixture",
    cleanup: true,
    runBuild: async (context) => {
      check("executor passes canonical attempt id to build callback", context.attemptId === "attempt-workbench-executor", context);
      const commandResult = await runBenchCommand(context.runner, {
        attemptId: context.attemptId,
        command: modelCommand,
        timeoutSeconds: 10,
      });
      return {
        traceIds: ["trace-model-call-1"],
        costUsd: 0.01,
        inputTokens: 100,
        outputTokens: 50,
        modelCalls: 1,
        toolCalls: 1,
        validToolCalls: commandResult.exitCode === 0 ? 1 : 0,
      };
    },
  });

  check("executor runs model path before verifier", result.attempt.modelCalls === 1 && result.attempt.traceIds.includes("trace-model-call-1"), result.attempt);
  check("failed verifier maps to failed_verifier", result.attempt.status === "failed_verifier", result.attempt);
  check("executor returns verifier result", result.verifierResult.passed === false && result.parsedVerifierResult.score === 0, result.verifierResult);
  check("executor creates patch artifact", result.artifacts.some((artifact) => artifact.kind === "patch" && artifact.content.includes("a * b")), result.artifacts);
  check("executor creates verifier artifact", result.artifacts.some((artifact) => artifact.id === "attempt-workbench-executor:verifier-result"), result.artifacts);
  check("attempt references concrete artifacts", result.attempt.artifactIds.includes("attempt-workbench-executor:patch") && result.attempt.artifactIds.includes("attempt-workbench-executor:verifier-result"), result.attempt.artifactIds);
} catch (error) {
  check("workbench executor contract did not throw", false, {
    error: error instanceof Error ? error.message : String(error),
    stderr,
  });
} finally {
  await stop(child);
  await rm(root, { recursive: true, force: true });
}

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
