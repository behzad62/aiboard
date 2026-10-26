import { createJsonArtifact } from "../artifacts";
import { startManagedAttemptRunner, stopManagedAttemptRunner } from "@/lib/client/bench-runner";
import { configureNativeProviders, getNativeRunnerHealth, startNativeToolBenchSession, getNativeToolBenchSession, stopNativeToolBenchSession, type NativeToolBenchSnapshot, type NativeRunnerConnection } from "@/lib/client/runner-v2";
import { createNativeProviderConfig } from "@/lib/client/native-build-engine";
import { mapNativeUsageToBenchmarkTraces, mapNativeToolsToBenchmarkTraces, NativeWorkBenchExecutionError, type NativeWorkBenchBuildInput } from "../workbench/native-runner-adapter";
import type { WorkBenchBuildExecutionResult } from "../workbench/types";
import type { CertifiedAttemptStatus } from "../types";
import { qualifyNativeToolBench } from "./native-qualification";
import { normalizeBenchmarkReasoningEffort } from "../model-effort";

const PRIVATE_FILES = ["case-meta.json", "negative-control.json", "reference-solution.md", ".bench-run.json", "verifier.mjs", "verifier-result.json"];
export const SOLO_TOOLBENCH_DEPENDENCIES = { startManagedAttemptRunner, stopManagedAttemptRunner, configureNativeProviders, getNativeRunnerHealth,
  startNativeToolBenchSession, getNativeToolBenchSession, stopNativeToolBenchSession, createNativeProviderConfig,
  wait: (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(signal.reason); return; }
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", abort); resolve(); }, ms);
    signal?.addEventListener("abort", abort, { once: true });
  }),
};

/** ToolBench intentionally never calls createNativeBuild or any Build lifecycle API. */
export async function runSoloToolBench(input: NativeWorkBenchBuildInput, dependencies = SOLO_TOOLBENCH_DEPENDENCIES): Promise<WorkBenchBuildExecutionResult> {
  const roles = input.teamComposition?.roles;
  const modelId = roles?.[0]?.modelId ?? input.models[0]?.modelId;
  if (!modelId || (roles && (roles.length !== 1 || roles[0].role !== "single"))) throw new Error("ToolBench requires exactly one solo model.");
  const started = Date.now();
  const sessionId = `toolbench-${input.attemptId}`.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 120);
  const controller = new AbortController();
  const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(new Error("ToolBench wall-clock guard exceeded.")), (input.case.budget.maxWallClockSeconds ?? 4500) * 1000);
  let connection: NativeRunnerConnection | undefined;
  let managed: Awaited<ReturnType<typeof startManagedAttemptRunner>> | undefined;
  let snapshot: NativeToolBenchSnapshot | undefined;
  let result: WorkBenchBuildExecutionResult | undefined;
  let failure: { status: CertifiedAttemptStatus; code: string; message: string } | undefined;
  const recorded = new Set<string>();
  const record = async (current: NativeToolBenchSnapshot) => {
    if (!current.usage) return;
    const traces = mapNativeUsageToBenchmarkTraces({ attemptId: input.attemptId, runId: input.runId, caseId: input.case.id, usage: current.usage, effortByRuntimeId: { [modelId]: roles?.[0]?.reasoningEffort } });
    const tools = mapNativeToolsToBenchmarkTraces({ attemptId: input.attemptId, caseId: input.case.id, tools: current.tools });
    for (const trace of traces) if (!recorded.has(trace.id)) { await input.context.recordTrace(trace); recorded.add(trace.id); }
    for (const trace of tools) if (!recorded.has(trace.id)) { await input.context.recordToolCall(trace); recorded.add(trace.id); }
    const usage = current.usage.lifetime ?? current.usage.effective;
    result = { traceIds: traces.map(t => t.id), artifactIds: [], costUsd: current.usage.models?.some(m => m.calls > 0 && m.costBasis === "api_estimate") ? usage.estimatedCostMicros / 1e6 : null,
      inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, modelCalls: traces.length, toolCalls: tools.length,
      validToolCalls: tools.filter(t => t.status === "ok" || t.error === "process_exit" || input.case.nativeQualification?.requiredRecoveryErrors?.includes(t.error ?? "")).length,
      durationMs: Math.max(0, (current.completedAt ? Date.parse(current.completedAt) : Date.now()) - (current.startedAt ? Date.parse(current.startedAt) : started)), runnerProjectPath: managed?.projectPath, runnerStatePath: managed?.statePath };
  };
  try {
    signal.throwIfAborted();
    managed = await dependencies.startManagedAttemptRunner(input.runner, { attemptId: input.attemptId }, signal);
    if (!managed.running || !managed.url || !managed.token) throw new Error("Managed ToolBench runner did not start.");
    if (input.expectedRunnerEnvironment && (managed.sourceDigest !== input.expectedRunnerEnvironment.runnerSourceDigest || managed.nodeVersion !== input.expectedRunnerEnvironment.nodeVersion || managed.platform !== input.expectedRunnerEnvironment.platform)) throw new Error("Runner identity changed after preflight; check the runner again.");
    connection = { url: managed.url, token: managed.token };
    const health = await dependencies.getNativeRunnerHealth(connection, undefined, signal);
    if (!health.capabilities?.soloToolBench || health.projectPath !== managed.projectPath) throw new Error("Managed runner does not support solo ToolBench sessions for this attempt. Update the benchmark runner before measuring models.");
    // Bench preparation keeps hidden scoring files outside the model workspace.
    // Only /bench/run-verifier restores them, after this session has stopped.
    await dependencies.configureNativeProviders(connection, [dependencies.createNativeProviderConfig(modelId, 0, normalizeBenchmarkReasoningEffort(roles?.[0]?.reasoningEffort))], undefined, signal);
    const policy = input.case.executionPolicy;
    if (!policy || !input.case.nativeQualification) throw new Error("Solo ToolBench requires a qualified tool fixture and explicit file scope.");
    const budget = input.case.budget;
    snapshot = await dependencies.startNativeToolBenchSession(connection, {
      sessionId, runtimeId: modelId, prompt: [input.case.prompt.userRequest, input.case.prompt.publicContext].filter(Boolean).join("\n\n"),
      allowedCommands: input.allowedCommands.filter(command => command.trim() !== input.case.verifier.command.trim()), hiddenPaths: [...PRIVATE_FILES, ...(policy.hiddenPaths ?? [])], protectedPaths: [...PRIVATE_FILES, ...policy.protectedPaths], editablePaths: input.case.nativeQualification.requiresBrowser ? [] : policy.editablePaths,
      budget: { maxInputTokens: budget.maxInputTokens, maxOutputTokens: budget.maxOutputTokens, maxModelCalls: budget.maxModelCalls, maxToolCalls: budget.maxToolCalls, ...(budget.maxUsd !== undefined ? { maxEstimatedCostMicros: Math.round(budget.maxUsd * 1e6) } : {}) },
      maxWallClockMs: (budget.maxWallClockSeconds ?? 4500) * 1000,
      browser: Boolean(input.case.nativeQualification.requiresBrowser), skills: input.case.nativeQualification.profile.includes("skill"),
    }, signal);
    for (;;) {
      await record(snapshot);
      if (snapshot.status !== "running") break;
      await dependencies.wait(500, signal);
      snapshot = await dependencies.getNativeToolBenchSession(connection, sessionId, signal);
    }
    if (snapshot.status !== "completed") {
      const reason = snapshot.reason;
      failure = { status: /budget_exhausted|turn_limit|wall_clock/.test(reason) ? "failed_budget" : /provider_error/.test(reason) ? "provider_unavailable" : /protocol_error/.test(reason) ? "failed_tool_use" : /model_ended|max_tokens|read_only_stall/.test(reason) ? "failed_model" : "invalid_harness", code: reason || "solo_session_failed", message: `Solo ToolBench stopped: ${reason || snapshot.status}.` };
    } else {
      const qualification = qualifyNativeToolBench(input.case, { observability: { tools: snapshot.tools, evidence: snapshot.evidence } }, snapshot.toolEvidence);
      if (!qualification.passed) failure = { status: "failed_tool_use", code: "native_tool_qualification_failed", message: `Tool qualification failed: ${qualification.checks.filter(c => !c.passed).map(c => c.id).join(", ")}` };
    }
  } catch (error) {
    failure = { status: controller.signal.aborted && !input.signal?.aborted ? "failed_budget" : "invalid_harness", code: controller.signal.aborted ? "wall_clock_limit" : "solo_session_error", message: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timeout);
    // Use a fresh bounded cleanup signal: the parent may already be cancelled.
    const cleanup = AbortSignal.timeout(30_000);
    try {
      if (connection) {
        snapshot = await dependencies.stopNativeToolBenchSession(connection, sessionId, cleanup);
        await record(snapshot);
      }
      if (snapshot) {
        const artifact = createJsonArtifact({ id: `${input.attemptId}:solo-session`, runId: input.runId, caseId: input.case.id, attemptId: input.attemptId, label: "Solo ToolBench session", content: snapshot });
        await input.context.recordArtifact(artifact);
        if (result) result.artifactIds = [artifact.id];
      }
    } catch (error) {
      if (!failure && !input.signal?.aborted) failure = { status: "invalid_harness", code: "solo_evidence_unavailable", message: `ToolBench final evidence unavailable: ${error instanceof Error ? error.message : String(error)}` };
    }
    try { await dependencies.stopManagedAttemptRunner(input.runner, { attemptId: input.attemptId }, cleanup); }
    catch (error) { if (!failure && !input.signal?.aborted) failure = { status: "invalid_harness", code: "solo_cleanup_failed", message: String(error) }; }
  }
  if (input.signal?.aborted) throw input.signal.reason;
  if (failure || !result) throw new NativeWorkBenchExecutionError(failure?.message ?? "Solo ToolBench produced no usage evidence.", managed?.projectPath ?? "", managed?.statePath ?? "", { certifiedStatus: failure?.status ?? "invalid_harness", certifiedCode: failure?.code ?? "solo_evidence_missing", buildResult: result });
  return result;
}
