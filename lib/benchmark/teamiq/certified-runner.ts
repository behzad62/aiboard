import {
  callCertifiedModel,
  type CertifiedModelStream,
} from "@/lib/benchmark/certified/model-call";
import type { CertifiedRunContext } from "@/lib/benchmark/certified/run-context";
import { saveBenchmarkTeamComposition } from "@/lib/benchmark/store";
import type {
  BenchmarkAttemptV2,
  BenchmarkTeamComposition,
  BenchmarkTeamCompositionRole,
  BenchmarkToolCallTrace,
  BenchmarkVerifierResult,
  CertifiedAttemptStatus,
} from "@/lib/benchmark/types";
import type { ModelPricing } from "@/lib/providers/pricing";
import type { SelectedModel } from "@/lib/providers/base";
import type { ReasoningEffort } from "@/lib/db/schema";
import {
  runToolReliabilityPack,
  type ToolReliabilityCandidate,
  type ToolReliabilityCase,
  type ToolReliabilityCaseResult,
  type ToolReliabilityTraceEvent,
} from "@/lib/benchmark/toolreliability";
import {
  buildCertifiedToolReliabilityPrompt,
  certifiedToolReliabilityStructuredOutputForCase,
  malformedToolReliabilityRepairSeed,
} from "@/lib/benchmark/toolreliability/certified-runner";
import {
  diagnoseToolReliabilityCaseResult,
  summarizeToolReliabilityDiagnostics,
} from "@/lib/benchmark/toolreliability/diagnostics";
import {
  deriveSoloTeamComposition,
  isSoloTeamComposition,
} from "./compositions";
import { linkTeamLiftBaselines } from "./baselines";
import {
  runCertifiedFireworksTeamIq,
  type FireworksBenchmarkCase,
  type FireworksBenchmarkSuite,
} from "@/lib/benchmark/fireworks";

export type TeamIqCertifiedTask =
  | {
      kind: "toolreliability";
      casePack: ToolReliabilityCase[];
    }
  | {
      kind: "fireworks";
      suite: FireworksBenchmarkSuite;
      cases: FireworksBenchmarkCase[];
    };

export interface RunCertifiedTeamIqInput {
  context: CertifiedRunContext;
  teamCompositions: BenchmarkTeamComposition[];
  task: TeamIqCertifiedTask;
  includeSoloBaselines: boolean;
  maxTokens?: number;
  streamChat?: CertifiedModelStream;
  pricing?: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M"> | null;
}

type TeamIqParticipantCall = {
  traceId: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number | null;
};

const TEAMIQ_HARNESS_VERSION = "teamiq-runner-v0.1";
const TEAMIQ_PROMPT_SET_VERSION = "teamiq-toolreliability-prompts-v0.1";
const TEAMIQ_SCORING_VERSION = "teamiq-toolreliability-current";
const CERTIFIED_REASONING_EFFORTS = new Set<ReasoningEffort>([
  "default",
  "low",
  "medium",
  "high",
  "max",
]);

export async function runCertifiedTeamIq(
  input: RunCertifiedTeamIqInput
): Promise<BenchmarkAttemptV2[]> {
  if (input.task.kind === "fireworks") {
    return runCertifiedFireworksTeamIq({
      context: input.context,
      teamCompositions: input.teamCompositions,
      cases: input.task.cases,
      includeSoloBaselines: input.includeSoloBaselines,
      maxTokens: input.maxTokens,
      streamChat: input.streamChat,
      pricing: input.pricing,
    });
  }

  if (input.task.casePack.length === 0) {
    throw new Error("Certified TeamIQ requires at least one task case.");
  }

  const allTeams = await expandTeamIqCompositions(input);
  const attempts: BenchmarkAttemptV2[] = [];
  for (const team of allTeams) {
    attempts.push(
      await runTeamIqToolReliabilityAttempt(input, team, input.task.casePack)
    );
  }

  const links = linkTeamLiftBaselines({
    soloAttempts: attempts.filter((attempt) =>
      isSoloComposition(allTeams, attempt.teamCompositionId)
    ),
    teamAttempts: attempts.filter(
      (attempt) => !isSoloComposition(allTeams, attempt.teamCompositionId)
    ),
    teamCompositions: allTeams,
    track: "teamiq",
  });
  for (const link of links) {
    link.teamAttempt.teamLift = link.score.teamLift;
  }

  return attempts;
}

async function expandTeamIqCompositions(
  input: RunCertifiedTeamIqInput
): Promise<BenchmarkTeamComposition[]> {
  const teams = [...input.teamCompositions];
  if (!input.includeSoloBaselines) return teams;

  const byModelId = new Map<string, BenchmarkTeamComposition>();
  for (const team of input.teamCompositions) {
    for (const role of team.roles) {
      if (byModelId.has(role.modelId)) continue;
      const solo = deriveSoloTeamComposition({
        modelId: role.modelId,
        providerId: role.providerId,
        displayName: role.displayName,
        reasoningEffort: role.reasoningEffort,
        temperature: role.temperature,
        maxTokens: role.maxTokens,
      });
      byModelId.set(role.modelId, solo);
    }
  }

  const solos = Array.from(byModelId.values());
  for (const solo of solos) {
    await saveBenchmarkTeamComposition(solo);
  }
  return [...solos, ...teams];
}

async function runTeamIqToolReliabilityAttempt(
  input: RunCertifiedTeamIqInput,
  team: BenchmarkTeamComposition,
  casePack: ToolReliabilityCase[]
): Promise<BenchmarkAttemptV2> {
  const attemptId = `teamiq-attempt:${input.context.runId}:${team.id}`;
  const calls: TeamIqParticipantCall[] = [];
  const outputs: ToolReliabilityCandidate["outputs"] = {};

  for (const benchmarkCase of casePack) {
    const caseOutputs: string[] = [];
    if (benchmarkCase.category === "repair-loop") {
      caseOutputs.push(malformedToolReliabilityRepairSeed(benchmarkCase));
    }
    const modelAttemptIndexes = benchmarkCase.category === "repair-loop" ? [1] : [0];
    for (const attemptIndex of modelAttemptIndexes) {
      const roleOutputs: string[] = [];
      for (const role of team.roles) {
        const call = await callCertifiedModel({
          model: selectedModelForRole(role),
          system:
            "You are participating in a certified TeamIQ benchmark. Return only the requested benchmark answer.",
          user: teamIqToolReliabilityPrompt({
            team,
            role,
            benchmarkCase,
            attemptIndex,
            previousOutputs: roleOutputs,
          }),
          maxTokens: input.maxTokens ?? role.maxTokens ?? 512,
          temperature: 0,
          reasoningEffort: certifiedReasoningEffort(role.reasoningEffort),
          structuredOutput: certifiedToolReliabilityStructuredOutputForCase(
            benchmarkCase,
            attemptIndex
          ),
          allowInvalidStructuredOutput: true,
          context: input.context,
          caseId: benchmarkCase.id,
          attemptId,
          participantId: `${team.id}:${role.slot}`,
          pricing: input.pricing,
          streamChat: input.streamChat,
        });
        calls.push(call);
        roleOutputs.push(call.rawResponse);
      }
      caseOutputs.push(finalOutputForTeam(team, roleOutputs));
    }
    outputs[benchmarkCase.id] = caseOutputs;
  }

  const candidate: ToolReliabilityCandidate = {
    id: `teamiq-candidate:${input.context.runId}:${team.id}`,
    teamCompositionId: team.id,
    outputs,
  };
  const result = runToolReliabilityPack(candidate, casePack);
  const verifier = createTeamIqVerifierResult({
    attemptId,
    caseId: input.context.caseIds[0] ?? "teamiq-toolreliability-current-pack",
    caseResults: result.caseResults,
    score: result.score,
  });
  const status = teamIqToolReliabilityStatus(result.caseResults);
  await input.context.recordVerifier(verifier);
  for (const trace of toolCallTracesForResult(attemptId, result.caseResults)) {
    await input.context.recordToolCall(trace);
  }

  return {
    ...result.attempt,
    id: attemptId,
    runId: input.context.runId,
    caseId: input.context.caseIds[0] ?? "teamiq-toolreliability-current-pack",
    teamCompositionId: team.id,
    track: "teamiq",
    status,
    harnessProfile: input.context.harnessProfile,
    startedAt: input.context.startedAt,
    completedAt: new Date().toISOString(),
    verifiedQuality: result.score / 100,
    jobSuccessScore: result.score,
    efficiencyScore: result.score,
    toolReliabilityScore: result.score,
    verifierResultId: verifier.id,
    traceIds: calls.map((call) => call.traceId),
    costUsd: costTotal(calls.map((call) => call.estimatedUsd)),
    inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
    modelCalls: calls.length,
    durationMs: Math.max(
      result.attempt.durationMs,
      calls.reduce((sum, call) => sum + call.latencyMs, 0)
    ),
    harnessVersion: TEAMIQ_HARNESS_VERSION,
    promptSetVersion: TEAMIQ_PROMPT_SET_VERSION,
    scoringVersion: TEAMIQ_SCORING_VERSION,
  };
}

function selectedModelForRole(role: BenchmarkTeamCompositionRole): SelectedModel {
  return {
    modelId: role.modelId,
    providerId: role.providerId,
    displayName: role.displayName,
  };
}

function certifiedReasoningEffort(
  value: BenchmarkTeamCompositionRole["reasoningEffort"]
): ReasoningEffort | undefined {
  return CERTIFIED_REASONING_EFFORTS.has(value as ReasoningEffort)
    ? (value as ReasoningEffort)
    : undefined;
}

function teamIqToolReliabilityPrompt(input: {
  team: BenchmarkTeamComposition;
  role: BenchmarkTeamCompositionRole;
  benchmarkCase: ToolReliabilityCase;
  attemptIndex: number;
  previousOutputs: string[];
}): string {
  const benchmarkPrompt = buildCertifiedToolReliabilityPrompt(
    input.benchmarkCase,
    input.attemptIndex
  );
  const collaborationNote =
    input.previousOutputs.length > 0
      ? `\n\nEarlier team outputs this turn:\n${input.previousOutputs.join("\n---\n")}`
      : "";
  return [
    `Team: ${input.team.name}`,
    input.team.strategy ? `Strategy: ${input.team.strategy}` : null,
    `Your role: ${input.role.role} (${input.role.slot})`,
    "Collaborate internally, but your answer must satisfy the benchmark contract below.",
    benchmarkPrompt,
    collaborationNote,
  ]
    .filter((line): line is string => Boolean(line))
    .join("\n");
}

function finalOutputForTeam(
  team: BenchmarkTeamComposition,
  roleOutputs: string[]
): string {
  const preferredRoles =
    team.strategy === "architect_worker"
      ? ["worker"]
      : team.strategy === "panel"
        ? ["specialist"]
        : ["reviewer", "judge", "worker", "specialist"];
  for (const preferredRole of preferredRoles) {
    const index = team.roles.findIndex((role) => role.role === preferredRole);
    if (index >= 0 && roleOutputs[index]) {
      return roleOutputs[index];
    }
  }
  return roleOutputs[roleOutputs.length - 1] ?? "";
}

function createTeamIqVerifierResult(input: {
  attemptId: string;
  caseId: string;
  caseResults: ToolReliabilityCaseResult[];
  score: number;
}): BenchmarkVerifierResult {
  const diagnoses = input.caseResults.map((result) =>
    diagnoseToolReliabilityCaseResult(result)
  );
  const diagnosisByCaseId = new Map(
    diagnoses.map((diagnosis) => [diagnosis.caseId, diagnosis])
  );
  const diagnosticSummary = summarizeToolReliabilityDiagnostics(diagnoses);
  const assertions = input.caseResults.map((result) => ({
    id: result.caseId,
    label: `${result.category}: ${result.caseId}`,
    passed: result.passed,
    weight: 1,
    message: result.passed
      ? undefined
      : diagnosisByCaseId.get(result.caseId)?.reason ??
        "TeamIQ ToolReliability case failed.",
  }));
  const passed = input.caseResults.every((result) => result.passed);
  const resultJson = JSON.stringify({
    passed,
    score: input.score / 100,
    summary: passed
      ? "TeamIQ ToolReliability cases passed."
      : "TeamIQ ToolReliability cases failed.",
    assertions,
    diagnostics: {
      summary: diagnosticSummary,
      cases: diagnoses,
    },
  });
  return {
    id: `${input.attemptId}:verifier`,
    attemptId: input.attemptId,
    caseId: input.caseId,
    passed,
    score: input.score / 100,
    durationMs: input.caseResults.reduce((sum, result) => sum + result.attempts, 0),
    resultJson,
    assertionResults: assertions,
    artifactIds: [],
  };
}

function teamIqToolReliabilityStatus(
  caseResults: ToolReliabilityCaseResult[]
): CertifiedAttemptStatus {
  if (caseResults.every((result) => result.passed)) return "passed";
  const failedCategories = new Set(
    caseResults
      .filter((result) => !result.passed)
      .map((result) => result.category)
  );
  if (
    failedCategories.has("tool-call") ||
    failedCategories.has("patch") ||
    failedCategories.has("forbidden-action")
  ) {
    return "failed_tool_use";
  }
  return "failed_model";
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
        toolName: `teamiq:${event.type}`,
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

function isSoloComposition(
  teams: BenchmarkTeamComposition[],
  teamCompositionId: string
): boolean {
  const team = teams.find((candidate) => candidate.id === teamCompositionId);
  return isSoloTeamComposition(team);
}

function costTotal(values: Array<number | null>): number | null {
  if (values.every((value) => value === null)) return null;
  let total = 0;
  for (const value of values) total += value ?? 0;
  return total;
}
