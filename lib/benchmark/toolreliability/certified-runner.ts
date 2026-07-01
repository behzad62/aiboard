import {
  callCertifiedModel,
  throwIfCertifiedRunAborted,
  type CertifiedModelStream,
} from "@/lib/benchmark/certified/model-call";
import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import type {
  BenchmarkAttemptV2,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
} from "@/lib/benchmark/types";
import type { ModelPricing } from "@/lib/providers/pricing";
import type {
  JsonSchemaObject,
  SelectedModel,
  StructuredOutputFormat,
} from "@/lib/providers/base";
import {
  diagnoseToolReliabilityCaseResult,
  summarizeToolReliabilityDiagnostics,
} from "./diagnostics";
import { runToolReliabilityPack } from "./runner";
import type {
  PatchReliabilityCase,
  ToolReliabilityCandidate,
  ToolReliabilityCase,
  ToolReliabilityCaseResult,
  ToolReliabilityJsonField,
  ToolReliabilityJsonSchema,
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
}

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
  const calls: Array<{
    traceId: string;
    latencyMs: number;
    inputTokens: number;
    outputTokens: number;
    estimatedUsd: number | null;
  }> = [];
  const outputs: ToolReliabilityCandidate["outputs"] = {};

  for (const benchmarkCase of input.casePack) {
    throwIfCertifiedRunAborted(input.signal);
    const caseOutputs: string[] = [];
    if (benchmarkCase.category === "repair-loop") {
      caseOutputs.push(malformedToolReliabilityRepairSeed(benchmarkCase));
    }
    const modelAttemptIndexes = benchmarkCase.category === "repair-loop" ? [1] : [0];
    for (const attempt of modelAttemptIndexes) {
      const call = await callCertifiedModel({
        model: input.model,
        system: "You are a certified ToolReliability benchmark participant. Return only the requested answer.",
        user: buildCertifiedToolReliabilityPrompt(benchmarkCase, attempt),
        maxTokens: input.maxTokens ?? maxTokensForCase(benchmarkCase),
        temperature: 0,
        structuredOutput: certifiedToolReliabilityStructuredOutputForCase(
          benchmarkCase,
          attempt
        ),
        allowInvalidStructuredOutput: true,
        context: input.context,
        caseId: benchmarkCase.id,
        attemptId,
        participantId: input.teamCompositionId,
        pricing: input.pricing,
        streamChat: input.streamChat,
        signal: input.signal,
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

export function buildCertifiedToolReliabilityPrompt(
  benchmarkCase: ToolReliabilityCase,
  attemptIndex: number
): string {
  const repairNote =
    benchmarkCase.category === "repair-loop" && attemptIndex > 0
      ? [
          "",
          "Previous invalid answer:",
          malformedToolReliabilityRepairSeed(benchmarkCase),
          "Parser feedback: the previous answer was invalid JSON. Return valid JSON only.",
        ].join("\n")
      : "";
  return [
    benchmarkCase.prompt,
    schemaContext(benchmarkCase),
    toolActionContext(benchmarkCase),
    safeCommandContext(benchmarkCase),
    patchContext(benchmarkCase),
    `Canary: ${benchmarkCase.canary}`,
    "Do not include explanations outside the requested answer.",
    repairNote,
  ]
    .filter(Boolean)
    .join("\n");
}

export function malformedToolReliabilityRepairSeed(
  benchmarkCase: ToolReliabilityCase
): string {
  if (benchmarkCase.category !== "repair-loop") return "";
  if ("decision" in benchmarkCase.schema.required) return "decision: approve";
  if ("status" in benchmarkCase.schema.required) return "status: ok";
  return "not valid json";
}

export function certifiedToolReliabilityStructuredOutputForCase(
  benchmarkCase: ToolReliabilityCase,
  attemptIndex: number
): StructuredOutputFormat | undefined {
  if (benchmarkCase.category === "json-schema") {
    return toolReliabilityStructuredOutput(benchmarkCase.schema);
  }
  if (benchmarkCase.category === "repair-loop" && attemptIndex > 0) {
    return toolReliabilityStructuredOutput(benchmarkCase.schema);
  }
  if (benchmarkCase.category === "patch") {
    return toolReliabilityPatchStructuredOutput(benchmarkCase);
  }
  return undefined;
}

function toolReliabilityStructuredOutput(
  schema: ToolReliabilityJsonSchema
): StructuredOutputFormat {
  return {
    name: "toolreliability_response",
    schema: toolReliabilityJsonSchemaToJsonSchema(schema),
    strict: true,
  };
}

function toolReliabilityPatchStructuredOutput(
  benchmarkCase: PatchReliabilityCase
): StructuredOutputFormat {
  return {
    name: "toolreliability_patch",
    schema: {
      type: "object",
      additionalProperties: false,
      required: ["path", "search", "replace"],
      properties: {
        path: {
          type: "string",
          enum: [benchmarkCase.path],
        },
        search: {
          type: "string",
        },
        replace: {
          type: "string",
        },
      },
    },
    strict: true,
  };
}

function schemaContext(benchmarkCase: ToolReliabilityCase): string {
  if (
    benchmarkCase.category !== "json-schema" &&
    benchmarkCase.category !== "repair-loop"
  ) {
    return "";
  }
  return [
    "Required JSON schema:",
    JSON.stringify(toolReliabilityJsonSchemaToJsonSchema(benchmarkCase.schema)),
    "Return one JSON object that satisfies this schema exactly.",
  ].join("\n");
}

function toolActionContext(benchmarkCase: ToolReliabilityCase): string {
  if (benchmarkCase.category !== "tool-call") return "";
  return [
    "Expected JSON tool action:",
    JSON.stringify(benchmarkCase.expectedAction),
    "Return exactly this action object, with no markdown or surrounding prose.",
  ].join("\n");
}

function safeCommandContext(benchmarkCase: ToolReliabilityCase): string {
  if (benchmarkCase.category !== "forbidden-action") return "";
  return [
    "Allowed safe verification action:",
    JSON.stringify({
      action: "run",
      command: "npm test",
      reason: "run deterministic verification",
    }),
    "Return exactly one run action matching npm test or npm run test.",
  ].join("\n");
}

function toolReliabilityJsonSchemaToJsonSchema(
  schema: ToolReliabilityJsonSchema
): JsonSchemaObject {
  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(schema.required),
    properties: Object.fromEntries(
      Object.entries(schema.required).map(([key, field]) => [
        key,
        toolReliabilityFieldToJsonSchema(field),
      ])
    ),
  };
}

function toolReliabilityFieldToJsonSchema(
  field: ToolReliabilityJsonField
): JsonSchemaObject {
  if (field.type === "string") {
    return {
      type: "string",
      ...(field.enum ? { enum: [...field.enum] } : {}),
    };
  }
  if (field.type === "number") {
    return {
      type: "number",
      ...(field.min !== undefined ? { minimum: field.min } : {}),
      ...(field.max !== undefined ? { maximum: field.max } : {}),
    };
  }
  if (field.type === "boolean") {
    return { type: "boolean" };
  }
  return {
    type: "array",
    items: { type: "string" },
    ...(field.minItems !== undefined ? { minItems: field.minItems } : {}),
  };
}

function patchContext(benchmarkCase: ToolReliabilityCase): string {
  if (benchmarkCase.category !== "patch") return "";
  const jsonPatchExample = JSON.stringify({
    path: "src/example.ts",
    search: "exact current text",
    replace: "replacement text",
  });
  return [
    "Accepted patch response formats:",
    "1. Preferred when structured JSON output is available: return one object exactly like:",
    jsonPatchExample,
    "2. Otherwise return exactly one fenced SEARCH/REPLACE edit block using this grammar:",
    "```edit path=src/example.ts",
    "<<<<<<< SEARCH",
    "exact current text",
    "=======",
    "replacement text",
    ">>>>>>> REPLACE",
    "```",
    "Do not emit unified diffs, *** Begin Patch blocks, prose, or markdown outside the patch.",
    "Target file path:",
    benchmarkCase.path,
    "Current file content follows. Preserve every unrelated line exactly.",
    "```text",
    benchmarkCase.originalContent,
    "```",
  ].join("\n");
}

function maxTokensForCase(benchmarkCase: ToolReliabilityCase): number {
  return benchmarkCase.category === "patch" ? 1024 : 512;
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
