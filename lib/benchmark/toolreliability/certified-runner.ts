import {
  callCertifiedModel,
  throwIfCertifiedRunAborted,
  type CertifiedModelCallAttemptUsage,
  type CertifiedModelCallResult,
  type CertifiedModelStream,
} from "@/lib/benchmark/certified/model-call";
import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import type {
  BenchmarkAttemptV2,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "@/lib/benchmark/types";
import type { ModelPricing } from "@/lib/providers/pricing";
import type { SelectedModel } from "@/lib/providers/base";
import {
  diagnoseToolReliabilityCaseResult,
  summarizeToolReliabilityDiagnostics,
} from "./diagnostics";
import { runToolReliabilityPack } from "./runner";
import { createStatefulEnv } from "./stateful-env";
import type {
  StatefulToolReliabilityCase,
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
  signal?: AbortSignal;
  /**
   * Backoff between transient-failure retries, passed straight through to
   * `callCertifiedModel` (default `DEFAULT_RETRY_DELAYS_MS`, 2s/8s). Tests
   * pass `[0, 0]` to exercise the retry path without waiting out the backoff.
   */
  retryDelaysMs?: number[];
}

/**
 * Stateful cases get the SAME 16384-token reasoning-headroom cap as GameIQ's
 * DEFAULT_GAMEIQ_MAX_TOKENS (gameiq/types.ts) — a multi-turn scripted-
 * environment case can legitimately need substantial reasoning before
 * emitting its action(s)/final answer, and a completion-token cap is never
 * meant to be a length control (see CLAUDE.md's ToolReliability
 * conventions): the env's own truncationCharCap is the length discipline for
 * the truncation-recovery kind specifically. Exported so TeamIQ's stateful
 * turn loop (teamiq/certified-runner.ts) uses the identical cap rather than
 * re-declaring a drift-prone copy.
 */
export const TOOL_RELIABILITY_STATEFUL_MAX_TOKENS = 16384;

export async function runCertifiedToolReliability(
  input: RunCertifiedToolReliabilityInput
): Promise<BenchmarkAttemptV2[]> {
  if (input.casePack.length === 0) {
    throw new Error("Certified ToolReliability requires at least one case.");
  }

  const attempts: BenchmarkAttemptV2[] = [];
  for (const teamCompositionId of input.teamCompositionIds) {
    throwIfCertifiedRunAborted(input.signal);
    for (const model of input.models) {
      throwIfCertifiedRunAborted(input.signal);
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
  const caseId = input.context.caseIds[0] ?? "toolreliability-current-pack";
  const calls: CertifiedModelCallAttemptUsage[] = [];
  const outputs: ToolReliabilityCandidate["outputs"] = {};

  /**
   * Records every PHYSICAL model call the provider billed for: the attempt
   * that answered, plus any transient attempts retried away beneath it (a
   * dead stream still costs its input tokens). Counting only the answer
   * under-reports `modelCalls`, tokens and cost whenever a retry fires.
   */
  const recordCall = (call: CertifiedModelCallResult): void => {
    for (const retried of call.retryAttempts ?? []) calls.push(retried);
    calls.push({
      traceId: call.traceId,
      latencyMs: call.latencyMs,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      estimatedUsd: call.estimatedUsd,
    });
  };

  for (const benchmarkCase of input.casePack) {
    throwIfCertifiedRunAborted(input.signal);
    const caseOutputs: string[] = [];

    // Generalized repair-loop: drive a turn loop over the case's scripted
    // env — call model, parse action, env step, append the rendered tool
    // result to the transcript, repeat until the env reports done or the
    // case's maxTurns is exhausted. The prompt each turn is the FULL
    // rendered transcript so far (transcript-in-prompt; a documented
    // deliberate simplification of Build's ChatMessage[] — see the design
    // doc — acceptable because these scenarios are tiny and the transcript
    // is never truncated, so state discipline stays fully visible).
    const env = createStatefulEnv(benchmarkCase);
    let transcript = "";
    for (let turn = 0; turn < benchmarkCase.maxTurns; turn++) {
      throwIfCertifiedRunAborted(input.signal);
      const call = await callCertifiedModel({
        model: input.model,
        system:
          "You are a certified ToolReliability benchmark participant operating a scripted multi-turn environment. Return only the requested JSON tool action, or a short final plain-text answer once the task is complete.",
        user: buildStatefulTurnPrompt(benchmarkCase, transcript),
        maxTokens: input.maxTokens ?? TOOL_RELIABILITY_STATEFUL_MAX_TOKENS,
        temperature: 0,
        allowInvalidStructuredOutput: true,
        context: input.context,
        caseId: benchmarkCase.id,
        attemptId,
        participantId: input.teamCompositionId,
        pricing: input.pricing,
        streamChat: input.streamChat,
        signal: input.signal,
        retryDelaysMs: input.retryDelaysMs,
      });
      recordCall(call);
      // One turn consumes one OUTPUT, however many physical calls it took:
      // a transient attempt is retried away inside `callCertifiedModel` and
      // never reaches the env, so `caseOutputs` stays a clean turn-by-turn
      // transcript that replays to the identical verdict (runner.ts).
      caseOutputs.push(call.rawResponse);
      const stepResult = env.step(call.rawResponse);
      transcript += `\n\nTurn ${turn + 1} - you replied:\n${call.rawResponse}\n\nTurn ${turn + 1} - tool result:\n${stepResult.renderedResult}`;
      if (stepResult.done) break;
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
  const verifierStartedMs = Date.now();
  const result = runToolReliabilityPack(candidate, input.casePack);
  const verifierResult = createToolReliabilityVerifierResult(
    attemptId,
    caseId,
    result.caseResults,
    result.score,
    Math.max(0, Date.now() - verifierStartedMs)
  );
  await input.context.recordVerifier(verifierResult);
  for (const trace of toolCallTracesForResult(attemptId, result.caseResults)) {
    await input.context.recordToolCall(trace);
  }

  return {
    ...result.attempt,
    id: attemptId,
    runId: input.context.runId,
    caseId,
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

export function createToolReliabilityVerifierResult(
  attemptId: string,
  caseId: string,
  caseResults: ToolReliabilityCaseResult[],
  score: number,
  durationMs: number
): BenchmarkVerifierResult {
  const diagnoses = caseResults.map(diagnoseToolReliabilityCaseResult);
  const diagnosesByCaseId = new Map(
    diagnoses.map((diagnosis) => [diagnosis.caseId, diagnosis])
  );
  const diagnosticSummary = summarizeToolReliabilityDiagnostics(diagnoses);
  const assertions = caseResults.map((result) => ({
    id: result.caseId,
    label: `${readableCategory(result.category)} - ${readableCaseId(result.caseId, result.category)}`,
    passed: result.passed,
    weight: 1,
    message: result.passed
      ? undefined
      : diagnosesByCaseId.get(result.caseId)?.reason ?? "ToolReliability case failed.",
  }));
  const passed = caseResults.every((result) => result.passed);
  const resultJson = JSON.stringify({
    passed,
    score: score / 100,
    summary: passed
      ? "ToolReliability cases passed."
      : "ToolReliability cases failed.",
    assertions,
    diagnostics: {
      summary: diagnosticSummary,
      cases: diagnoses,
    },
  });
  return {
    id: `${attemptId}:verifier`,
    attemptId,
    caseId,
    passed,
    score: score / 100,
    durationMs,
    resultJson,
    assertionResults: assertions,
    artifactIds: [],
  };
}

function readableCategory(category: string): string {
  if (category === "json-schema") return "JSON Schema";
  return category
    .split("-")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
}

function readableCaseId(caseId: string, category: string): string {
  const categoryPrefix = `toolrel-current-${category}-`;
  if (caseId.startsWith(categoryPrefix)) {
    return `Case ${caseId.slice(categoryPrefix.length)}`;
  }
  return caseId
    .replace(/^toolrel-current-/, "")
    .split("-")
    .map((word) => word[0]?.toUpperCase() + word.slice(1))
    .join(" ");
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
  return event.type === "forbidden_action";
}

function toolTraceStatus(
  event: ToolReliabilityTraceEvent
): BenchmarkToolCallTrace["status"] {
  if (event.status === "passed") return "ok";
  if (event.status === "skipped") return "blocked";
  return "failed";
}

/**
 * Per-turn prompt for a stateful case: task brief + the generic action
 * protocol (every action kind used across the six stateful kinds, so a
 * single generic doc string covers all of them without leaking which action
 * a specific case actually expects) + the full rendered transcript so far.
 * Transcript-in-prompt is a documented deliberate simplification (see the
 * design doc) — acceptable because these scenarios are tiny and the
 * transcript is never truncated.
 */
export function buildStatefulTurnPrompt(
  benchmarkCase: StatefulToolReliabilityCase,
  transcript: string
): string {
  return [
    benchmarkCase.prompt,
    [
      "Available JSON tool actions - you may respond with one OR SEVERAL JSON tool actions in a single reply when useful; the engine runs every action you send and reports which were served or skipped:",
      '{"action":"read_range","path":"<file path>","startLine":<n>,"lineCount":<n>} - read a bounded slice of an existing file.',
      '{"action":"patch","path":"<file path>","ops":[{"search":"<exact current text>","replace":"<replacement>"}]} - apply exact SEARCH/REPLACE edits to an existing file.',
      '{"action":"append","path":"<file path>","content":"<text>","reset":true|false} - append (or, with reset:true, start) a bounded content chunk.',
      '{"action":"run","command":"<shell command>"} - run a read-only verification command.',
      '{"action":"tool","server":"playwright","tool":"browser_click","args":{"target":"<ref>","element":"<label>"}} - interact with an element from the current page snapshot.',
      "Keep each individual JSON tool action well-formed and complete - an incomplete or truncated action gets rejected and costs you a turn.",
      "Once the task is fully complete, reply with a short final plain-text answer instead of any JSON action - that ends your turn loop.",
    ].join("\n"),
    `Canary: ${benchmarkCase.canary}`,
    transcript ? `Transcript so far:${transcript}` : "This is your first turn.",
  ]
    .filter(Boolean)
    .join("\n\n");
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
