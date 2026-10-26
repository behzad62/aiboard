/** Deterministic transport double for orchestration/publication tests. No network models. */
import { openaiProvider } from "../lib/providers/openai";
import type { runNativeWorkBenchBuild } from "../lib/benchmark/workbench/native-runner-adapter";

export function installNativeBenchmarkTestTransport(verifierPassed = true) {
  const originalFetch = globalThis.fetch;
  const unmockedStream = openaiProvider.streamChat;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("http://native-benchmark.test/")) return originalFetch(input, init);
    if (init?.signal?.aborted) throw init.signal.reason;
    const route = new URL(url).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const payload = route === "/bench/health" ? { ok: true, platform: "win32", nodeVersion: "24.18.0", runnerV2: { ready: true, sourceDigest: "a".repeat(64) } }
      : route === "/bench/prepare" ? { attemptId: body.attemptId, caseId: body.caseId }
      : route === "/bench/run-verifier" ? { passed: verifierPassed, score: verifierPassed ? 1 : 0, durationMs: 1, exitCode: verifierPassed ? 0 : 1, stdoutPreview: "", stderrPreview: "", resultJson: JSON.stringify({passed:verifierPassed,score:verifierPassed?1:0,summary:"fixture",assertions:[{id:"behavior",label:"fixture",passed:verifierPassed,weight:1}]}), artifactIds: [] }
      : route === "/bench/diff" ? { diff: "" } : { cleaned: true };
    return new Response(JSON.stringify(payload), { headers: { "content-type": "application/json" } });
  };
  const runBuild: typeof runNativeWorkBenchBuild = async (input) => {
    if (openaiProvider.streamChat === unmockedStream) throw new Error("Native orchestration tests must inject a model stream; live calls are forbidden.");
    const model = input.models[0]!;
    for await (const _chunk of openaiProvider.streamChat({ apiKey: "test", model: model.modelId.split(":").slice(1).join(":"), messages: [], maxTokens: 16384, signal: input.signal })) { /* consume the injected boundary */ }
    const traceId = input.attemptId + ":native-control";
    await input.context.recordTrace({ id: traceId, runId: input.runId, caseId: input.case.id, attemptId: input.attemptId, modelId: model.modelId, providerId: model.providerId, startedAt: new Date().toISOString(), completedAt: new Date().toISOString(), inputTokens: 1, outputTokens: 1, estimatedUsd: null, retryHistory: [] });
    return { traceIds: [traceId], modelCalls: 1, toolCalls: 1, validToolCalls: 1 };
  };
  return { runBuild, restore: () => { globalThis.fetch = originalFetch; } };
}
