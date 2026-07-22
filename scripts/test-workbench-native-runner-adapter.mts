import assert from "node:assert/strict";

import {
  mapNativeToolsToBenchmarkTraces,
  mapNativeUsageToBenchmarkTraces,
  nativePauseDisposition,
  NativeWorkBenchExecutionError,
  runNativeWorkBenchBuild,
} from "../lib/benchmark/workbench/native-runner-adapter";

assert.deepEqual(
  nativePauseDisposition("task_attempt_budget"),
  {
    action: "fail",
    key: "task_attempt_budget",
    limit: 0,
    certifiedStatus: "failed_budget",
    certifiedCode: "task_attempt_budget",
    message: "Runner V2 paused: task_attempt_budget",
  }
);
assert.equal(
  nativePauseDisposition("protocol_error:duplicate_call_id:duplicate").certifiedCode,
  "duplicate_call_id"
);
assert.equal(
  nativePauseDisposition("protocol_error:invalid_provider_turn:malformed").action,
  "fail"
);
assert.equal(
  nativePauseDisposition("protocol_error:invalid_provider_turn:malformed").certifiedStatus,
  "failed_model"
);
assert.equal(
  nativePauseDisposition("unexpected_new_pause").certifiedStatus,
  "invalid_harness"
);

const usage = {
  scopeId: "native-attempt",
  reservations: {
    call_1: {
      reservationId: "call_1",
      kind: "model" as const,
      status: "settled" as const,
      attribution: {
        runtimeId: "chatgpt:gpt-5.4-mini",
        providerId: "chatgpt",
        modelId: "gpt-5.4-mini",
        role: "worker" as const,
        sessionId: "worker:1",
        taskId: "task_1",
      },
      estimate: {},
      actual: {
        inputTokens: 120,
        cachedInputTokens: 20,
        outputTokens: 30,
        estimatedCostMicros: 2500,
      },
      tokenSources: { inputTokens: "reported" as const, outputTokens: "reported" as const },
      costBasis: { kind: "api_estimate" as const },
      settledAt: "2026-07-22T10:00:00.000Z",
      windowIndex: 0,
    },
    tool_1: {
      reservationId: "tool_1",
      kind: "tool" as const,
      status: "settled" as const,
      estimate: {},
      actual: {},
      windowIndex: 0,
    },
  },
  activeSegments: {},
  effective: {
    modelCalls: 1,
    toolCalls: 2,
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 30,
    estimatedCostMicros: 2500,
    activeMs: 400,
    artifactBytes: 0,
  },
  lifetime: {
    modelCalls: 1,
    toolCalls: 2,
    inputTokens: 120,
    cachedInputTokens: 20,
    outputTokens: 30,
    estimatedCostMicros: 2500,
    activeMs: 400,
    artifactBytes: 0,
  },
  lastSequence: 2,
};

const traces = mapNativeUsageToBenchmarkTraces({
  attemptId: "attempt_1",
  runId: "run_1",
  caseId: "case_1",
  usage,
});
assert.equal(traces.length, 1);
assert.deepEqual(traces[0], {
  id: "attempt_1:native-model:call_1",
  runId: "run_1",
  caseId: "case_1",
  attemptId: "attempt_1",
  modelId: "chatgpt:gpt-5.4-mini",
  providerId: "chatgpt",
  participantId: "worker:worker:1",
  startedAt: "2026-07-22T10:00:00.000Z",
  completedAt: "2026-07-22T10:00:00.000Z",
  inputTokens: 120,
  cachedInputTokens: 20,
  outputTokens: 30,
  totalTokens: 150,
  usageSource: "reported",
  providerCost: 0.0025,
  providerCostUnit: "usd",
  estimatedUsd: 0.0025,
  retryHistory: [],
});

const tools = mapNativeToolsToBenchmarkTraces({
  attemptId: "attempt_1",
  caseId: "case_1",
  tools: [
    {
      sequence: 3,
      sessionId: "worker:1",
      callId: "read_1",
      toolName: "fs.read",
      status: "completed",
      occurredAt: "2026-07-22T10:00:01.000Z",
    },
    {
      sequence: 4,
      sessionId: "worker:1",
      callId: "run_1",
      toolName: "process.run",
      status: "completed",
      occurredAt: "2026-07-22T10:00:02.000Z",
      isError: true,
      errorCode: "process_exit",
    },
    {
      sequence: 5,
      sessionId: "worker:1",
      callId: "pending",
      toolName: "fs.write",
      status: "started",
      occurredAt: "2026-07-22T10:00:03.000Z",
    },
  ],
});
assert.equal(tools.length, 2);
assert.equal(tools[0].status, "ok");
assert.equal(tools[1].status, "failed");
assert.equal(tools[1].error, "process_exit");

const nativeAudit = {
  protocolVersion: 2,
  usage,
  observability: { tools: tools.map((tool) => ({
    sequence: Number(tool.id.endsWith("read_1") ? 3 : 4),
    sessionId: "worker:1",
    callId: tool.id.split(":").at(-1)!,
    toolName: tool.toolName,
    status: "completed",
    occurredAt: tool.startedAt,
    isError: tool.status === "failed",
    ...(tool.error ? { errorCode: tool.error } : {}),
  })) },
  run: {},
  build: {},
  runEvents: [],
  buildEvents: [],
} as never;

const calls: string[] = [];
const recordedTraces: unknown[] = [];
const recordedTools: unknown[] = [];
const recordedArtifacts: unknown[] = [];
let projectionReads = 0;
let createdBuild: Record<string, unknown> | undefined;
const result = await runNativeWorkBenchBuild(
  {
    attemptId: "attempt_1",
    runId: "certified_run",
    teamCompositionId: "team_1",
    harnessProfile: "aiboard-build-multi-worker",
    allowedCommands: ["npm test"],
    runner: { url: "http://127.0.0.1:8797", token: "bench-token" },
    case: {
      id: "case_1",
      title: "Native fixture",
      description: "Edit the fixture",
      prompt: { userRequest: "Fix the fixture" },
      budget: {
        maxUsd: 1,
        maxWallClockSeconds: 60,
        maxModelCalls: 10,
        maxToolCalls: 20,
        maxInputTokens: 1000,
        maxOutputTokens: 1000,
      },
    },
    models: [{ modelId: "chatgpt:gpt-5.4-mini", providerId: "chatgpt", displayName: "GPT" }],
    context: {
      recordTrace: async (trace: unknown) => { recordedTraces.push(trace); },
      recordToolCall: async (trace: unknown) => { recordedTools.push(trace); },
      recordArtifact: async (artifact: unknown) => { recordedArtifacts.push(artifact); },
    },
  } as never,
  {
    startManagedAttemptRunner: async () => {
      calls.push("start-child");
      return {
        attemptId: "attempt_1",
        running: true,
        url: "http://127.0.0.1:18888",
        token: "native-token-native-token",
        projectPath: "C:\\fixture",
        statePath: "C:\\runner-state",
      };
    },
    restoreManagedAttemptOracle: async () => {
      calls.push("restore-oracle");
      return { attemptId: "attempt_1", restored: true };
    },
    stopManagedAttemptRunner: async () => {
      calls.push("stop-child");
      return {
        attemptId: "attempt_1",
        running: false,
        projectPath: "C:\\fixture",
        statePath: "C:\\runner-state",
      };
    },
    getNativeRunnerHealth: async () => ({
      ok: true,
      protocolVersion: 2,
      projectPath: "C:\\fixture",
      nodeVersion: "24.18.0",
    }),
    createProviderConfigs: () => [{ runtimeId: "chatgpt:gpt-5.4-mini" }] as never,
    configureNativeProviders: async () => { calls.push("configure"); },
    createNativeBuild: async (_connection, input) => {
      calls.push("create-build");
      createdBuild = input as unknown as Record<string, unknown>;
    },
    commandNativeRun: async (_connection, _runId, command) => { calls.push(`${command}-build`); },
    getNativeRun: async () => ({ state: "running" }) as never,
    getNativeBuild: async () => {
      projectionReads++;
      return projectionReads === 1
        ? ({ status: "running", runtime: { architect: {} } } as never)
        : projectionReads === 2
          ? ({
              status: "paused",
              pauseReason: { reason: "model_ended_without_lifecycle:" },
              runtime: { architect: {} },
            } as never)
          : projectionReads === 3
            ? ({
                status: "paused",
                pauseReason: {
                  reason: "worker_model_ended_without_lifecycle",
                  taskId: "T1",
                },
                runtime: { architect: {} },
              } as never)
            : projectionReads === 4
              ? ({
                  status: "paused",
                  pauseReason: { reason: "model_ended_without_lifecycle:" },
                  runtime: { architect: {} },
                } as never)
        : ({
            status: "paused",
            runtime: { architect: {} },
            projectHandoff: { status: "requested", options: ["apply_to_project"] },
          } as never);
    },
    selectNativeArchitectHandoff: async () => { throw new Error("unexpected"); },
    selectNativeProjectHandoff: async () => {
      calls.push("apply-handoff");
      return { status: "completed" } as never;
    },
    getNativeBuildAudit: async () => nativeAudit,
    wait: async () => undefined,
  }
);
assert.deepEqual(calls, [
  "start-child",
  "restore-oracle",
  "configure",
  "create-build",
  "start-build",
  "continue-build",
  "continue-build",
  "continue-build",
  "apply-handoff",
  "stop-child",
]);
const benchmarkPolicy = ((createdBuild?.build as Record<string, unknown>)?.benchmark ?? {}) as {
  allowedCommands?: string[];
  hiddenPaths?: string[];
  protectedPaths?: string[];
};
assert.match(
  String((createdBuild?.build as Record<string, unknown>)?.objective ?? ""),
  /exactly one implementation task/i
);
assert.ok(benchmarkPolicy.allowedCommands?.includes("git diff --check"));
assert.ok(benchmarkPolicy.hiddenPaths?.includes("case-meta.json"));
assert.ok(benchmarkPolicy.protectedPaths?.includes("verifier.mjs"));
assert.equal(result.modelCalls, 1);
assert.equal(result.toolCalls, 2);
assert.equal(result.validToolCalls, 1);
assert.equal(recordedTraces.length, 1);
assert.equal(recordedTools.length, 2);
assert.equal(recordedArtifacts.length, 1);

const failureCalls: string[] = [];
const failureTraces: unknown[] = [];
const failureTools: unknown[] = [];
const failureArtifacts: unknown[] = [];
let failureProjectionReads = 0;
let failure: unknown;
try {
  await runNativeWorkBenchBuild(
    {
      attemptId: "attempt_protocol_failure",
      runId: "certified_protocol_failure",
      teamCompositionId: "team_1",
      harnessProfile: "aiboard-build-multi-worker",
      allowedCommands: ["npm test"],
      runner: { url: "http://127.0.0.1:8797", token: "bench-token" },
      case: {
        id: "case_protocol_failure",
        title: "Protocol fixture",
        description: "Edit the fixture",
        prompt: { userRequest: "Fix the fixture" },
        budget: { maxModelCalls: 10, maxInputTokens: 10_000 },
      },
      models: [{ modelId: "chatgpt:gpt-5.4-mini", providerId: "chatgpt", displayName: "GPT" }],
      context: {
        recordTrace: async (trace: unknown) => {
          failureTraces.push(trace);
          throw new Error("trace recorder unavailable");
        },
        recordToolCall: async (trace: unknown) => { failureTools.push(trace); },
        recordArtifact: async (artifact: unknown) => { failureArtifacts.push(artifact); },
      },
    } as never,
    {
      startManagedAttemptRunner: async () => ({
        attemptId: "attempt_protocol_failure",
        running: true,
        url: "http://127.0.0.1:18889",
        token: "native-token-native-token",
        projectPath: "C:\\fixture-failure",
        statePath: "C:\\runner-state-failure",
      }),
      restoreManagedAttemptOracle: async () => ({ attemptId: "attempt_protocol_failure", restored: true }),
      stopManagedAttemptRunner: async () => {
        failureCalls.push("stop-child");
        return { attemptId: "attempt_protocol_failure", running: false } as never;
      },
      getNativeRunnerHealth: async () => ({
        ok: true,
        protocolVersion: 2,
        projectPath: "C:\\fixture-failure",
        nodeVersion: "24.18.0",
      }),
      createProviderConfigs: () => [{ runtimeId: "chatgpt:gpt-5.4-mini" }] as never,
      configureNativeProviders: async () => undefined,
      createNativeBuild: async () => undefined,
      commandNativeRun: async (_connection, _runId, command) => {
        failureCalls.push(`${command}-build`);
      },
      getNativeRun: async () => ({ state: "running" }) as never,
      getNativeBuild: async () => {
        failureProjectionReads += 1;
        return ({
          status: "paused",
          pauseReason: {
            reason: "worker_model_ended_without_lifecycle",
            taskId: "T1",
          },
          runtime: { architect: {} },
        } as never);
      },
      selectNativeArchitectHandoff: async () => { throw new Error("unexpected"); },
      selectNativeProjectHandoff: async () => { throw new Error("unexpected"); },
      getNativeBuildAudit: async () => nativeAudit,
      wait: async () => undefined,
    }
  );
} catch (error) {
  failure = error;
}
assert.ok(failure instanceof NativeWorkBenchExecutionError);
assert.equal(failure.certifiedStatus, "failed_model");
assert.equal(failure.certifiedCode, "model_ended_without_lifecycle");
assert.equal(failure.buildResult?.inputTokens, 120);
assert.equal(failure.buildResult?.modelCalls, 1);
assert.equal(failureProjectionReads, 3);
assert.deepEqual(failureCalls, [
  "start-build",
  "continue-build",
  "continue-build",
  "stop-child",
]);
assert.equal(failureTraces.length, 1);
assert.equal(failureTools.length, 2);
assert.equal(failureArtifacts.length, 1);

console.log("PASS");
