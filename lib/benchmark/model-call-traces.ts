import { saveBenchmarkTrace } from "@/lib/benchmark/store";
import type {
  BenchmarkModelCallTrace,
  BenchmarkModelCallTraceAttempt,
} from "@/lib/benchmark/types";
import type { ReasoningEffort } from "@/lib/db/schema";

const TRACE_TEXT_LIMIT = 8_000;

export interface GameAIDiagnosticLike {
  attempt: number;
  type: "parse" | "illegal" | "request";
  message: string;
  rawResponse?: string;
}

export interface CreateGameModelCallTraceInput {
  modelId: string;
  providerId: string;
  participantId?: string;
  runId?: string;
  caseId?: string;
  attemptId?: string;
  reasoningEffort?: ReasoningEffort | string;
  schemaMode?: BenchmarkModelCallTrace["schemaMode"];
  promptText?: string;
  startedAt: string;
  completedAt?: string;
  latencyMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  estimatedUsd?: number | null;
  rawResponse?: string;
  parsedResponseJson?: string;
  diagnostics?: GameAIDiagnosticLike[];
  finalStatus?: BenchmarkModelCallTraceAttempt["status"];
  fallbackReason?: string;
  error?: string;
}

export function createGameModelCallTrace(
  input: CreateGameModelCallTraceInput
): BenchmarkModelCallTrace {
  const retryHistory =
    input.diagnostics?.map(diagnosticToTraceAttempt) ?? [];

  if (input.finalStatus) {
    const terminalAttempt: BenchmarkModelCallTraceAttempt = {
      attempt:
        retryHistory.reduce((max, attempt) => Math.max(max, attempt.attempt), 0) +
        1,
      status: input.finalStatus,
      message:
        input.finalStatus === "parsed"
          ? "Response parsed successfully."
          : input.error ?? "Model call finished.",
      rawResponse: capTraceText(input.rawResponse),
      parsedJson: capTraceText(input.parsedResponseJson),
      latencyMs: input.latencyMs,
    };
    const lastAttempt = retryHistory[retryHistory.length - 1];
    if (lastAttempt && lastAttempt.status === input.finalStatus && input.finalStatus !== "parsed") {
      retryHistory[retryHistory.length - 1] = {
        ...lastAttempt,
        message: input.error ?? lastAttempt.message,
        rawResponse: capTraceText(input.rawResponse) ?? lastAttempt.rawResponse,
        parsedJson: capTraceText(input.parsedResponseJson) ?? lastAttempt.parsedJson,
        latencyMs: input.latencyMs ?? lastAttempt.latencyMs,
      };
    } else {
      retryHistory.push(terminalAttempt);
    }
  }

  return {
    id: createTraceId(),
    modelId: input.modelId,
    providerId: input.providerId,
    ...(input.runId ? { runId: input.runId } : {}),
    ...(input.caseId ? { caseId: input.caseId } : {}),
    ...(input.attemptId ? { attemptId: input.attemptId } : {}),
    ...(input.participantId ? { participantId: input.participantId } : {}),
    ...(input.reasoningEffort ? { reasoningEffort: input.reasoningEffort } : {}),
    schemaMode: input.schemaMode ?? "structured",
    ...(input.promptText ? { promptHash: hashPrompt(input.promptText) } : {}),
    startedAt: input.startedAt,
    ...(input.completedAt ? { completedAt: input.completedAt } : {}),
    ...(input.latencyMs !== undefined ? { latencyMs: input.latencyMs } : {}),
    ...(input.inputTokens !== undefined ? { inputTokens: input.inputTokens } : {}),
    ...(input.outputTokens !== undefined
      ? { outputTokens: input.outputTokens }
      : {}),
    ...(input.estimatedUsd !== undefined
      ? { estimatedUsd: input.estimatedUsd }
      : {}),
    ...(input.rawResponse ? { rawResponse: capTraceText(input.rawResponse) } : {}),
    ...(input.parsedResponseJson
      ? { parsedResponseJson: capTraceText(input.parsedResponseJson) }
      : {}),
    retryHistory,
    ...(input.fallbackReason ? { fallbackReason: input.fallbackReason } : {}),
    ...(input.error ? { error: input.error } : {}),
  };
}

export async function recordBenchmarkModelCallTrace(
  trace: BenchmarkModelCallTrace
): Promise<void> {
  try {
    await saveBenchmarkTrace(trace);
  } catch {
    // Benchmark tracing must never break gameplay or Build execution.
  }
}

function diagnosticToTraceAttempt(
  diagnostic: GameAIDiagnosticLike
): BenchmarkModelCallTraceAttempt {
  return {
    attempt: diagnostic.attempt,
    status: diagnosticStatus(diagnostic.type),
    message: diagnostic.message,
    ...(diagnostic.rawResponse
      ? { rawResponse: capTraceText(diagnostic.rawResponse) }
      : {}),
  };
}

function diagnosticStatus(
  type: GameAIDiagnosticLike["type"]
): BenchmarkModelCallTraceAttempt["status"] {
  if (type === "parse") return "parse_error";
  if (type === "illegal") return "illegal";
  return "provider_error";
}

function capTraceText(value: string | undefined): string | undefined {
  if (!value) return value;
  if (value.length <= TRACE_TEXT_LIMIT) return value;
  return `${value.slice(0, TRACE_TEXT_LIMIT)}\n[truncated ${value.length - TRACE_TEXT_LIMIT} chars]`;
}

function hashPrompt(prompt: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < prompt.length; i++) {
    hash ^= prompt.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

function createTraceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `trace-${Date.now()}-${Math.random()}`;
}
