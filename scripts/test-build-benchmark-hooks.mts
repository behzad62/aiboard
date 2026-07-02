/* Build benchmark hook checks (run: npx tsx scripts/test-build-benchmark-hooks.mts) */
import {
  buildBenchmarkTraceContext,
  resolveBuildModelContent,
  shouldBlockBuildBenchmarkAction,
  validateBuildBenchmarkCommand,
  type BuildHooks,
} from "../lib/client/build-engine";
import {
  createWorkBenchBenchmarkHooks,
  runWorkBenchBuild,
} from "../lib/benchmark/workbench/build-adapter";
import { createCertifiedRunContext } from "../lib/benchmark/certified/run-persistence";
import type { SelectedModel, StructuredOutputFormat } from "../lib/providers/base";
import type { WorkBenchCase } from "../lib/benchmark/workbench/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function expectReject(
  name: string,
  action: () => Promise<unknown>,
  messagePattern: RegExp
): Promise<void> {
  try {
    await action();
    check(name, false, "resolved");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    check(name, messagePattern.test(message), message);
  }
}

const benchmark: NonNullable<BuildHooks["benchmark"]> = {
  attemptId: "attempt-hook-test",
  runId: "run-hook-test",
  caseId: "case-hook-test",
  harnessProfile: "aiboard-build-multi-worker",
  noHumanApproval: true,
  runnerOnly: true,
  disableMcp: true,
  allowedCommands: ["npm test", "node verifier.mjs"],
};

check(
  "benchmark command allowlist accepts exact configured command",
  validateBuildBenchmarkCommand("npm test", benchmark).allowed
);
check(
  "benchmark command allowlist rejects unlisted shell command",
  !validateBuildBenchmarkCommand("git push origin main", benchmark).allowed,
  validateBuildBenchmarkCommand("git push origin main", benchmark)
);
check(
  "non-benchmark command policy stays permissive",
  validateBuildBenchmarkCommand("git push origin main", undefined).allowed
);

check(
  "benchmark policy blocks MCP when disabled",
  shouldBlockBuildBenchmarkAction("tool", benchmark).blocked,
  shouldBlockBuildBenchmarkAction("tool", benchmark)
);
check(
  "benchmark policy blocks external fetches",
  shouldBlockBuildBenchmarkAction("fetch", benchmark).blocked,
  shouldBlockBuildBenchmarkAction("fetch", benchmark)
);
check(
  "benchmark policy blocks repo side effects but allows repo inspection",
  shouldBlockBuildBenchmarkAction("repo_commit", benchmark).blocked &&
    shouldBlockBuildBenchmarkAction("repo_push", benchmark).blocked &&
    !shouldBlockBuildBenchmarkAction("repo_status", benchmark).blocked,
  {
    repoCommit: shouldBlockBuildBenchmarkAction("repo_commit", benchmark),
    repoStatus: shouldBlockBuildBenchmarkAction("repo_status", benchmark),
  }
);
check(
  "benchmark trace context links model calls to certified attempt",
  JSON.stringify(buildBenchmarkTraceContext(benchmark)) ===
    JSON.stringify({
      attemptId: "attempt-hook-test",
      runId: "run-hook-test",
      caseId: "case-hook-test",
    }),
  buildBenchmarkTraceContext(benchmark)
);

const model: SelectedModel = {
  modelId: "fake:oracle",
  providerId: "fake",
  displayName: "Oracle",
  contextProfile: {
    providerId: "fake",
    modelId: "oracle",
    fullModelId: "fake:oracle",
    contextWindowTokens: 32_768,
    maxOutputTokens: 4_096,
    buildOutputReserveTokens: 4_096,
    effectiveBuildInputCeilingTokens: 28_672,
    longContextQuality: "ok",
    promptCaching: false,
    recommendedBuildRoles: ["worker"],
    source: "default",
  },
};
const structuredOutput: StructuredOutputFormat = {
  name: "architect_action",
  schema: { type: "object", properties: { action: { type: "string" } } },
  strict: true,
};

let collected = false;
let overrideInput: unknown = null;
let emittedToken = "";
const resolved = await resolveBuildModelContent({
  model,
  messages: [{ role: "user", content: "Plan the work" }],
  maxTokens: 512,
  label: "Architect plan",
  reasoningEffort: "high",
  structuredOutput,
  hooks: {
    modelCallOverride: async (input) => {
      overrideInput = input;
      return "{\"action\":\"plan\",\"tasks\":[]}";
    },
  },
  collect: async () => {
    collected = true;
    return "provider";
  },
  emitToken: (token) => {
    emittedToken += token;
  },
});

check(
  "modelCallOverride supplies content without calling provider collector",
  resolved.overrideUsed &&
    resolved.content.includes("\"plan\"") &&
    !collected &&
    emittedToken === resolved.content,
  { resolved, collected, emittedToken }
);
check(
  "modelCallOverride receives structured output and reasoning metadata",
  (overrideInput as
    | { structuredOutput?: StructuredOutputFormat; reasoningEffort?: string }
    | null)?.structuredOutput?.name === "architect_action" &&
    (overrideInput as { reasoningEffort?: string } | null)?.reasoningEffort === "high",
  overrideInput
);

const fallback = await resolveBuildModelContent({
  model,
  messages: [{ role: "user", content: "No override" }],
  maxTokens: 64,
  label: "Fallback",
  reasoningEffort: "default",
  collect: async () => "provider-content",
});

check(
  "model content resolver falls back to provider collector",
  !fallback.overrideUsed && fallback.content === "provider-content",
  fallback
);

await expectReject(
  "benchmark model content resolver rejects empty provider output",
  () =>
    resolveBuildModelContent({
      model,
      messages: [{ role: "user", content: "No output" }],
      maxTokens: 64,
      label: "Benchmark fallback",
      reasoningEffort: "default",
      hooks: { benchmark },
      collect: async () => "",
    }),
  /empty response|empty output|provider/i
);

const workBenchCase: WorkBenchCase = {
  schemaVersion: 1,
  id: "workbench-hook-case",
  title: "Hook case",
  description: "Hook case",
  difficulty: "easy",
  tags: ["hook"],
  caseVersion: "0.1.0",
  prompt: { userRequest: "Fix it." },
  repo: {
    url: "fixture://inline",
    baseCommit: "fixture-base",
    shallowClone: true,
  },
  environment: {
    type: "local-runner",
    timeoutSeconds: 30,
    network: "dependency-only",
  },
  verifier: {
    command: "node verifier.js",
  },
  budget: {},
  scoring: { scoringVersion: "certified-v0.1" },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-WORKBENCH-HOOK",
    referenceSolutionPrivate: true,
  },
  allowedCommands: ["node verifier.js"],
};
const workBenchBuildInput = {
  case: workBenchCase,
  runner: { url: "http://127.0.0.1:8797", token: "token" },
  attemptId: "attempt-workbench-hook",
  runId: "run-workbench-hook",
  teamCompositionId: "team-workbench-hook",
  harnessProfile: "aiboard-build-multi-worker" as const,
  allowedCommands: ["node verifier.js"],
};
const workBenchHooks = createWorkBenchBenchmarkHooks(workBenchBuildInput);
check(
  "WorkBench build adapter creates locked certified benchmark hooks",
  workBenchHooks.noHumanApproval &&
    workBenchHooks.runnerOnly &&
    workBenchHooks.disableMcp &&
    workBenchHooks.allowedCommands?.includes("node verifier.js") === true,
  workBenchHooks
);
const workBenchBuild = await runWorkBenchBuild({
  ...workBenchBuildInput,
  executeBuild: async ({ benchmark }) => ({
    traceIds: [`${benchmark.attemptId}:trace:model`],
    modelCalls: 1,
    toolCalls: 1,
    validToolCalls: 1,
  }),
});
check(
  "WorkBench build adapter delegates to injected build executor",
  workBenchBuild.modelCalls === 1 &&
    workBenchBuild.traceIds.includes("attempt-workbench-hook:trace:model"),
  workBenchBuild
);

const directEvents: unknown[] = [];
const directToolCalls: unknown[] = [];
const directTraces: unknown[] = [];
const directTraceStore: Array<{
  id: string;
  runId?: string;
  attemptId?: string;
  caseId?: string;
  modelId: string;
  providerId: string;
  participantId?: string;
  schemaMode: "structured" | "json-instructions" | "text";
  startedAt: string;
  completedAt?: string;
  inputTokens?: number;
  outputTokens?: number;
  estimatedUsd?: number | null;
  retryHistory: Array<{ attempt: number; status: "parsed"; message: string }>;
}> = [];
let directRunCalled = false;
const directBuild = await runWorkBenchBuild({
  ...workBenchBuildInput,
  context: {
    runId: "run-workbench-hook",
    mode: "certified",
    track: "workbench",
    harnessProfile: "aiboard-build-multi-worker",
    suiteId: "suite-workbench-hook",
    startedAt: "2026-06-28T10:00:00.000Z",
    caseIds: [workBenchCase.id],
    teamCompositionIds: ["team-workbench-hook"],
    modelBudget: {},
    recordAttempt: async () => undefined,
    recordVerifier: async () => undefined,
    recordArtifact: async () => undefined,
    recordTrace: async (trace) => {
      directTraces.push(trace);
    },
    recordEvent: async (event) => {
      directEvents.push(event);
    },
    recordToolCall: async (trace) => {
      directToolCalls.push(trace);
    },
    recordFailure: async () => undefined,
  },
  models: [model],
  runBuildDiscussion: async (discussion, models, emit, hooks) => {
    directRunCalled = true;
    const benchmarkHook = hooks?.benchmark;
    if (!benchmarkHook) throw new Error("missing benchmark hook");
    benchmarkHook.recordEvent?.({
      id: "direct-event",
      attemptId: benchmarkHook.attemptId,
      caseId: benchmarkHook.caseId,
      type: "model_call_started",
      phase: "plan",
      at: "2026-06-28T10:00:00.000Z",
      message: "direct build started",
    });
    benchmarkHook.recordToolCall?.({
      id: "direct-tool",
      attemptId: benchmarkHook.attemptId,
      caseId: benchmarkHook.caseId,
      toolName: "run",
      status: "ok",
      startedAt: "2026-06-28T10:00:00.000Z",
    });
    benchmarkHook.recordToolCall?.({
      id: "direct-tool-failed",
      attemptId: benchmarkHook.attemptId,
      caseId: benchmarkHook.caseId,
      toolName: "run",
      status: "failed",
      exitCode: 1,
      startedAt: "2026-06-28T10:00:00.000Z",
      error: "command failed",
    });
    benchmarkHook.recordToolCall?.({
      id: "direct-tool-denied",
      attemptId: benchmarkHook.attemptId,
      caseId: benchmarkHook.caseId,
      toolName: "run",
      status: "denied",
      startedAt: "2026-06-28T10:00:00.000Z",
      error: "command denied",
    });
    emit({
      type: "diagnostic",
      phase: "initializing",
      message: `${discussion.mode}:${models.length}:${discussion.runnerUrl}`,
    });
    directTraceStore.push({
      id: `${benchmarkHook.attemptId}:trace:direct`,
      runId: benchmarkHook.runId,
      attemptId: benchmarkHook.attemptId,
      caseId: benchmarkHook.caseId,
      modelId: model.modelId,
      providerId: model.providerId,
      participantId: "architect",
      schemaMode: "text",
      startedAt: "2026-06-28T10:00:00.000Z",
      completedAt: "2026-06-28T10:00:01.000Z",
      inputTokens: 12,
      outputTokens: 8,
      estimatedUsd: 0.001,
      retryHistory: [{ attempt: 1, status: "parsed", message: "ok" }],
    });
  },
  getBenchmarkTraces: () => directTraceStore,
});
check(
  "WorkBench build adapter calls Build discussion with benchmark recorders",
  directRunCalled &&
    directBuild.modelCalls === 1 &&
    directBuild.traceIds.includes("attempt-workbench-hook:trace:direct") &&
    directBuild.inputTokens === 12 &&
    directBuild.outputTokens === 8 &&
    directEvents.length === 1 &&
    directToolCalls.length === 3 &&
    directTraces.length === 1,
  { directRunCalled, directBuild, directEvents, directToolCalls, directTraces }
);
check(
  "WorkBench build adapter counts executed nonzero commands as valid tool use",
  directBuild.toolCalls === 3 && directBuild.validToolCalls === 2,
  directBuild
);

const budgetContext = createCertifiedRunContext({
  runId: "run-workbench-budget-hook",
  suiteId: "suite-workbench-budget-hook",
  track: "workbench",
  harnessProfile: "aiboard-build-multi-worker",
  startedAt: new Date().toISOString(),
  caseIds: [workBenchCase.id],
  teamCompositionIds: ["team-workbench-hook"],
  modelBudget: { maxModelCalls: 0 },
});
let budgetHookRunCalled = false;
try {
  await runWorkBenchBuild({
    ...workBenchBuildInput,
    context: budgetContext,
    models: [model],
    runBuildDiscussion: async (_discussion, _models, _emit, hooks) => {
      budgetHookRunCalled = true;
      hooks?.benchmark?.reserveModelCall?.({ inputTokens: 1 });
    },
    getBenchmarkTraces: () => [],
  });
  check("WorkBench benchmark budget hook rejects over-budget Build calls", false, "resolved");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  check(
    "WorkBench benchmark budget hook rejects over-budget Build calls",
    /budget|model calls/i.test(message),
    message
  );
}
check("WorkBench Build discussion reached certified budget hook", budgetHookRunCalled, budgetHookRunCalled);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
