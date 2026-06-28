import { callCertifiedModel, type CertifiedModelStream } from "@/lib/benchmark/certified/model-call";
import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import type {
  BenchmarkAttemptV2,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "@/lib/benchmark/types";
import type { ModelPricing } from "@/lib/providers/pricing";
import type { SelectedModel } from "@/lib/providers/base";
import { runToolReliabilityPack } from "./runner";
import type {
  ToolReliabilityCandidate,
  ToolReliabilityCase,
  ToolReliabilityCaseResult,
  ToolReliabilityTraceEvent,
} from "./types";

export interface RunCertifiedToolReliabilityInput {
  context: CertifiedRunContext;
  models: SelectedModel[];
  teamCompositionIds: string[];
  casePack: ToolReliabilityCase[];
  maxTokens?: number;
  streamChat?: CertifiedModelStream;
  pricing?: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M"> | null;
}

export async function runCertifiedToolReliability(
  input: RunCertifiedToolReliabilityInput
): Promise<BenchmarkAttemptV2[]> {
  if (input.casePack.length === 0) {
    throw new Error("Certified ToolReliability requires at least one case.");
  }

  const attempts: BenchmarkAttemptV2[] = [];
  for (const teamCompositionId of input.teamCompositionIds) {
    for (const model of input.models) {
      attempts.push(
        await runCertifiedToolReliabilityAttempt({
          ...input,
          model,
          teamCompositionId,
        })
      );
    }
  }
  return attempts;
}

async function runCertifiedToolReliabilityAttempt(
  input: RunCertifiedToolReliabilityInput & {
    model: SelectedModel;
    teamCompositionId: string;
  }
): Promise<BenchmarkAttemptV2> {
  const attemptId = `toolrel-attempt:${input.context.runId}:${input.teamCompositionId}:${input.model.modelId}`;
  const calls: Array<{
    traceId: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number | null;
  }> = [];
  const outputs: ToolReliabilityCandidate["outputs"] = {};

  for (const benchmarkCase of input.casePack) {
    const caseOutputs: string[] = [];
    const callsForCase = benchmarkCase.category === "repair-loop" ? 2 : 1;
    for (let attempt = 0; attempt < callsForCase; attempt++) {
      const call = await callCertifiedModel({
        model: input.model,
        system: "You are a certified ToolReliability benchmark participant. Return only the requested answer.",
        user: toolReliabilityPrompt(benchmarkCase, attempt),
        maxTokens: input.maxTokens ?? 512,
        temperature: 0,
        context: input.context,
        caseId: input.context.caseIds[0],
        attemptId,
        participantId: input.teamCompositionId,
        pricing: input.pricing,
        streamChat: input.streamChat,
      });
      calls.push({
        traceId: call.traceId,
        latencyMs: call.latencyMs,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        estimatedUsd: call.estimatedUsd,
      });
      caseOutputs.push(call.rawResponse);
    }
    outputs[benchmarkCase.id] = caseOutputs;
  }

  const candidate: ToolReliabilityCandidate = {
    id: `toolrel-candidate:${input.context.runId}:${input.teamCompositionId}:${input.model.modelId}`,
    modelId: input.model.modelId,
    providerId: input.model.providerId,
    teamCompositionId: input.teamCompositionId,
    outputs,
  };
  const result = runToolReliabilityPack(candidate, input.casePack);
  const verifierResult = createToolReliabilityVerifierResult(
    attemptId,
    input.context.caseIds[0] ?? "toolreliability-v0.1-pack",
    result.caseResults,
    result.score
  );
  await input.context.recordVerifier(verifierResult);
  for (const trace of toolCallTracesForResult(attemptId, result.caseResults)) {
    await input.context.recordToolCall(trace);
  }

  return {
    ...result.attempt,
    id: attemptId,
    runId: input.context.runId,
    caseId: input.context.caseIds[0] ?? "toolreliability-v0.1-pack",
    teamCompositionId: input.teamCompositionId,
    harnessProfile: input.context.harnessProfile,
    startedAt: input.context.startedAt,
    completedAt: new Date().toISOString(),
    verifierResultId: verifierResult.id,
    traceIds: calls.map((call) => call.traceId),
    costUsd: costTotal(calls.map((call) => call.estimatedUsd)),
    inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
    modelCalls: calls.length,
    durationMs: Math.max(
      result.attempt.durationMs,
      calls.reduce((sum, call) => sum + call.latencyMs, 0)
    ),
  };
}

function createToolReliabilityVerifierResult(
  attemptId: string,
  caseId: string,
  caseResults: ToolReliabilityCaseResult[],
  score: number
): BenchmarkVerifierResult {
  const assertions = caseResults.map((result) => ({
    id: result.caseId,
    label: `${result.category}: ${result.caseId}`,
    passed: result.passed,
    weight: 1,
    message: result.passed ? undefined : "ToolReliability case failed.",
  }));
  const passed = caseResults.every((result) => result.passed);
  const resultJson = JSON.stringify({
    passed,
    score: score / 100,
    summary: passed
      ? "ToolReliability cases passed."
      : "ToolReliability cases failed.",
    assertions,
  });
  return {
    id: `${attemptId}:verifier`,
    attemptId,
    caseId,
    passed,
    score: score / 100,
    durationMs: caseResults.reduce((sum, result) => sum + result.attempts, 0),
    resultJson,
    assertionResults: assertions,
    artifactIds: [],
  };
}

function toolCallTracesForResult(
  attemptId: string,
  caseResults: ToolReliabilityCaseResult[]
): BenchmarkToolCallTrace[] {
  return caseResults.flatMap((result) =>
    result.events
      .filter((event) => isToolEvidenceEvent(event))
      .map((event) => ({
        id: `${attemptId}:tool:${event.id}`,
        attemptId,
        caseId: result.caseId,
        toolName: `toolreliability:${event.type}`,
        status: toolTraceStatus(event),
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        durationMs: 0,
        ...(event.details ? { inputJson: JSON.stringify(event.details) } : {}),
        outputPreview: event.message,
      }))
  );
}

function isToolEvidenceEvent(event: ToolReliabilityTraceEvent): boolean {
  return (
    event.type === "tool_validation" ||
    event.type === "patch_application" ||
    event.type === "command_safety" ||
    event.type === "forbidden_action"
  );
}

function toolTraceStatus(
  event: ToolReliabilityTraceEvent
): BenchmarkToolCallTrace["status"] {
  if (event.status === "passed") return "ok";
  if (event.status === "skipped") return "blocked";
  return "failed";
}

function toolReliabilityPrompt(
  benchmarkCase: ToolReliabilityCase,
  attemptIndex: number
): string {
  const repairNote =
    benchmarkCase.category === "repair-loop" && attemptIndex > 0
      ? "\n\nParser feedback: the previous answer was invalid. Return valid JSON only."
      : "";
  return [
    benchmarkCase.prompt,
    `Canary: ${benchmarkCase.canary}`,
    "Do not include explanations outside the requested answer.",
    repairNote,
  ].join("\n");
}

function costTotal(values: Array<number | null>): number | null {
  if (values.every((value) => value === null)) {
    return null;
  }
  let total = 0;
  for (const value of values) {
    total += value ?? 0;
  }
  return total;
}
