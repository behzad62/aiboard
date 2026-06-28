import {
  callCertifiedModel,
  type CertifiedModelStream,
} from "@/lib/benchmark/certified/model-call";
import type {
  CertifiedRunContext,
  PersistentCertifiedRunContext,
} from "@/lib/benchmark/certified/run-context";
import { createJsonArtifact } from "@/lib/benchmark/artifacts";
import { saveBenchmarkTeamComposition } from "@/lib/benchmark/store";
import type {
  BenchmarkAttemptV2,
  BenchmarkFailure,
  BenchmarkTeamComposition,
  BenchmarkTeamCompositionRole,
  BenchmarkVerifierResult,
  CertifiedAttemptStatus,
} from "@/lib/benchmark/types";
import { linkTeamLiftBaselines } from "@/lib/benchmark/teamiq/baselines";
import {
  deriveSoloTeamComposition,
  getTeamCompositionModelIds,
} from "@/lib/benchmark/teamiq/compositions";
import type { ModelPricing } from "@/lib/providers/pricing";
import type { ReasoningEffort } from "@/lib/db/schema";
import type { SelectedModel } from "@/lib/providers/base";
import {
  applyFireworksAction,
  createFireworksGame,
  getCurrentPlayer,
  scoreFireworksState,
} from "@/lib/games/fireworks/engine";
import {
  buildFireworksActionSchema,
  buildFireworksPrompt,
  chooseDeterministicFireworksFallback,
  parseFireworksActionResponseResult,
} from "@/lib/games/fireworks/ai";
import {
  computeFireworksGameMetrics,
  scoreFireworksTeamIq,
} from "@/lib/games/fireworks/scoring";
import type {
  FireworksAction,
  FireworksGameMetrics,
  FireworksGameState,
} from "@/lib/games/fireworks/types";
import {
  scoreFireworksScenarioAction,
} from "./scenario-packs";
import type {
  FireworksBenchmarkCase,
  FireworksFullGameCase,
  FireworksScenario,
} from "./types";

export interface RunCertifiedFireworksTeamIqInput {
  context: CertifiedRunContext;
  teamCompositions: BenchmarkTeamComposition[];
  cases: FireworksBenchmarkCase[];
  includeSoloBaselines: boolean;
  maxTokens?: number;
  streamChat?: CertifiedModelStream;
  pricing?: Pick<ModelPricing, "inputUsdPer1M" | "outputUsdPer1M"> | null;
}

interface FireworksCallRecord {
  traceId?: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  estimatedUsd: number | null;
  legal: boolean;
  fallbackUsed: boolean;
  failureCode?: string;
  error?: string;
}

interface FireworksActionCall {
  action: FireworksAction;
  rawResponse: string;
  parsedResponseJson?: string;
  call: FireworksCallRecord;
}

interface FireworksCaseRunResult {
  caseId: string;
  kind: "scenario" | "full_game";
  score: number;
  state: FireworksGameState;
  transcript: unknown;
  assertions: Array<{ id: string; label: string; passed: boolean; weight: number; message?: string }>;
}

const FIREWORKS_HARNESS_VERSION = "fireworks-teamiq-runner-v0.1";
const FIREWORKS_PROMPT_SET_VERSION = "fireworks-action-prompts-v0.1";
const FIREWORKS_SCORING_VERSION = "fireworks-teamiq-v0.1";
const CERTIFIED_REASONING_EFFORTS = new Set<ReasoningEffort>([
  "default",
  "low",
  "medium",
  "high",
  "max",
]);

export async function runCertifiedFireworksTeamIq(
  input: RunCertifiedFireworksTeamIqInput
): Promise<BenchmarkAttemptV2[]> {
  if (input.cases.length === 0) {
    throw new Error("Certified Fireworks TeamIQ requires at least one case.");
  }

  const allTeams = await expandFireworksCompositions(input);
  const attempts: BenchmarkAttemptV2[] = [];
  for (const team of allTeams) {
    attempts.push(await runFireworksAttempt(input, team));
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

async function expandFireworksCompositions(
  input: RunCertifiedFireworksTeamIqInput
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

async function runFireworksAttempt(
  input: RunCertifiedFireworksTeamIqInput,
  team: BenchmarkTeamComposition
): Promise<BenchmarkAttemptV2> {
  const attemptId = `fireworks-teamiq:${input.context.runId}:${team.id}`;
  const caseId = input.context.caseIds[0] ?? "fireworks-teamiq-v0.1";
  const startedMs = Date.now();
  const calls: FireworksCallRecord[] = [];
  const failures: BenchmarkFailure[] = [];
  const caseResults: FireworksCaseRunResult[] = [];

  for (const benchmarkCase of input.cases) {
    const result = isScenarioCase(benchmarkCase)
      ? await runScenarioCase({
          input,
          team,
          attemptId,
          benchmarkCase,
          calls,
          failures,
        })
      : await runFullGameCase({
          input,
          team,
          attemptId,
          benchmarkCase,
          calls,
          failures,
        });
    caseResults.push(result);
  }

  for (const failure of failures) {
    await input.context.recordFailure(failure);
  }

  const score = roundScore(
    average(caseResults.map((result) => result.score)) * 100
  );
  const metrics = aggregateMetrics(caseResults, calls, Date.now() - startedMs);
  const transcriptArtifact = createJsonArtifact({
    id: `${attemptId}:fireworks-transcript`,
    runId: input.context.runId,
    caseId,
    attemptId,
    label: "Fireworks transcript",
    content: {
      team: team.name,
      cases: caseResults.map((result) => result.transcript),
    },
  });
  const summaryArtifact = createJsonArtifact({
    id: `${attemptId}:fireworks-summary`,
    runId: input.context.runId,
    caseId,
    attemptId,
    label: "Fireworks summary",
    content: {
      score,
      metrics,
      team: team.name,
      caseScores: caseResults.map((result) => ({
        caseId: result.caseId,
        score: result.score,
      })),
    },
  });
  await input.context.recordArtifact(transcriptArtifact);
  await input.context.recordArtifact(summaryArtifact);

  const verifier = createFireworksVerifierResult({
    attemptId,
    caseId,
    score,
    metrics,
    caseResults,
    artifactIds: [transcriptArtifact.id, summaryArtifact.id],
  });
  await input.context.recordVerifier(verifier);

  const traceIds = traceIdsForAttempt(input.context, attemptId, calls);
  const status = statusForAttempt(score, calls, metrics);
  return {
    id: attemptId,
    runId: input.context.runId,
    caseId,
    teamCompositionId: team.id,
    mode: "certified",
    track: "teamiq",
    harnessProfile: input.context.harnessProfile,
    status,
    startedAt: input.context.startedAt,
    completedAt: new Date().toISOString(),
    verifiedQuality: score / 100,
    jobSuccessScore: score,
    efficiencyScore: score,
    costUsd: costTotal(calls.map((call) => call.estimatedUsd)),
    inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
    modelCalls: calls.length,
    toolCalls: 0,
    durationMs: Math.max(
      Date.now() - startedMs,
      calls.reduce((sum, call) => sum + call.latencyMs, 0)
    ),
    verifierResultId: verifier.id,
    artifactIds: [transcriptArtifact.id, summaryArtifact.id],
    traceIds,
    failureIds: failures.map((failure) => failure.id),
    harnessVersion: FIREWORKS_HARNESS_VERSION,
    promptSetVersion: FIREWORKS_PROMPT_SET_VERSION,
    scoringVersion: FIREWORKS_SCORING_VERSION,
  };
}

async function runScenarioCase(params: {
  input: RunCertifiedFireworksTeamIqInput;
  team: BenchmarkTeamComposition;
  attemptId: string;
  benchmarkCase: FireworksScenario;
  calls: FireworksCallRecord[];
  failures: BenchmarkFailure[];
}): Promise<FireworksCaseRunResult> {
  const state = params.benchmarkCase.state;
  const call = await callFireworksAction({
    input: params.input,
    team: params.team,
    attemptId: params.attemptId,
    state,
    playerId: params.benchmarkCase.actingPlayerId,
    caseId: params.benchmarkCase.id,
    calls: params.calls,
    failures: params.failures,
  });
  const nextState = applyFireworksAction(
    state,
    params.benchmarkCase.actingPlayerId,
    call.action,
    { fallbackUsed: call.call.fallbackUsed }
  );
  const score = scoreFireworksScenarioAction(params.benchmarkCase, call.action);
  const assertions = [
    {
      id: `${params.benchmarkCase.id}:expected-action`,
      label: `${params.benchmarkCase.category}: expected action`,
      passed: score >= 0.7,
      weight: 1,
      message: score >= 0.7 ? undefined : `Received ${JSON.stringify(call.action)}`,
    },
  ];
  return {
    caseId: params.benchmarkCase.id,
    kind: "scenario",
    score,
    state: nextState,
    transcript: {
      id: params.benchmarkCase.id,
      suite: params.benchmarkCase.suite,
      category: params.benchmarkCase.category,
      actingPlayerId: params.benchmarkCase.actingPlayerId,
      action: call.action,
      rawResponse: call.rawResponse,
      parsedResponseJson: call.parsedResponseJson,
      fallbackUsed: call.call.fallbackUsed,
      score,
      finalState: nextState,
    },
    assertions,
  };
}

async function runFullGameCase(params: {
  input: RunCertifiedFireworksTeamIqInput;
  team: BenchmarkTeamComposition;
  attemptId: string;
  benchmarkCase: FireworksFullGameCase;
  calls: FireworksCallRecord[];
  failures: BenchmarkFailure[];
}): Promise<FireworksCaseRunResult> {
  let state = createFireworksGame({
    seed: params.benchmarkCase.seed,
    playerCount: params.benchmarkCase.playerCount,
    clueTokens: params.benchmarkCase.clueTokens,
    mistakeTokens: params.benchmarkCase.mistakeTokens,
    players: Array.from({ length: params.benchmarkCase.playerCount }, (_, index) => ({
      id: `P${index + 1}`,
      label: `Player P${index + 1}`,
      kind: "ai" as const,
      modelId: roleForPlayer(params.team, `P${index + 1}`)?.modelId,
    })),
  });
  const actions: unknown[] = [];

  while (
    state.status === "playing" &&
    state.turn < params.benchmarkCase.maxTurns
  ) {
    const playerId = getCurrentPlayer(state).id;
    const call = await callFireworksAction({
      input: params.input,
      team: params.team,
      attemptId: params.attemptId,
      state,
      playerId,
      caseId: params.benchmarkCase.id,
      calls: params.calls,
      failures: params.failures,
    });
    actions.push({
      turn: state.turn,
      playerId,
      action: call.action,
      fallbackUsed: call.call.fallbackUsed,
    });
    state = applyFireworksAction(state, playerId, call.action, {
      fallbackUsed: call.call.fallbackUsed,
    });
  }

  const metrics = computeFireworksGameMetrics({ state });
  const score = scoreFireworksTeamIq({ metrics }) / 100;
  return {
    caseId: params.benchmarkCase.id,
    kind: "full_game",
    score,
    state,
    transcript: {
      id: params.benchmarkCase.id,
      suite: params.benchmarkCase.suite,
      seed: params.benchmarkCase.seed,
      playerCount: params.benchmarkCase.playerCount,
      actions,
      finalState: state,
      metrics,
      score,
    },
    assertions: [
      {
        id: `${params.benchmarkCase.id}:final-score`,
        label: "Final stack score",
        passed: scoreFireworksState(state) >= 10,
        weight: 0.4,
      },
      {
        id: `${params.benchmarkCase.id}:legal-actions`,
        label: "Legal action rate",
        passed: metrics.illegalActions === 0,
        weight: 0.15,
      },
      {
        id: `${params.benchmarkCase.id}:critical-discards`,
        label: "Avoided critical discards",
        passed: metrics.criticalDiscards === 0,
        weight: 0.1,
      },
    ],
  };
}

async function callFireworksAction(params: {
  input: RunCertifiedFireworksTeamIqInput;
  team: BenchmarkTeamComposition;
  attemptId: string;
  state: FireworksGameState;
  playerId: string;
  caseId: string;
  calls: FireworksCallRecord[];
  failures: BenchmarkFailure[];
}): Promise<FireworksActionCall> {
  const role = roleForPlayer(params.team, params.playerId);
  if (!role) {
    throw new Error(`No Fireworks role mapped for ${params.playerId}.`);
  }

  const { system, user } = buildFireworksPrompt(params.state, params.playerId);
  try {
    const call = await callCertifiedModel({
      model: selectedModelForRole(role),
      system,
      user,
      structuredOutput: buildFireworksActionSchema(),
      maxTokens: params.input.maxTokens ?? role.maxTokens ?? 512,
      temperature: 0,
      reasoningEffort: certifiedReasoningEffort(role.reasoningEffort),
      context: params.input.context,
      caseId: params.input.context.caseIds[0],
      attemptId: params.attemptId,
      participantId: `fireworks:${params.playerId}`,
      pricing: params.input.pricing,
      streamChat: params.input.streamChat,
    });
    const parsed = parseFireworksActionResponseResult(
      params.state,
      params.playerId,
      call.rawResponse
    );
    if (parsed.ok) {
      const record: FireworksCallRecord = {
        traceId: call.traceId,
        latencyMs: call.latencyMs,
        inputTokens: call.inputTokens,
        outputTokens: call.outputTokens,
        estimatedUsd: call.estimatedUsd,
        legal: true,
        fallbackUsed: false,
      };
      params.calls.push(record);
      return {
        action: parsed.action,
        rawResponse: call.rawResponse,
        parsedResponseJson: parsed.parsedResponseJson,
        call: record,
      };
    }

    const fallback = chooseDeterministicFireworksFallback(
      params.state,
      params.playerId
    );
    const record: FireworksCallRecord = {
      traceId: call.traceId,
      latencyMs: call.latencyMs,
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      estimatedUsd: call.estimatedUsd,
      legal: false,
      fallbackUsed: true,
      failureCode: "fireworks_illegal_action",
      error: parsed.message,
    };
    params.calls.push(record);
    params.failures.push(
      createFireworksFailure({
        context: params.input.context,
        attemptId: params.attemptId,
        caseId: params.caseId,
        modelId: role.modelId,
        code: "fireworks_illegal_action",
        source: "rules",
        message: parsed.message,
      })
    );
    return {
      action: fallback,
      rawResponse: call.rawResponse,
      call: record,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const fallback = chooseDeterministicFireworksFallback(
      params.state,
      params.playerId
    );
    const failureCode = /provider|api key|unauthorized|rate.?limit|quota|timeout/i.test(
      message
    )
      ? "fireworks_provider_failure"
      : "fireworks_invalid_json";
    const record: FireworksCallRecord = {
      latencyMs: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedUsd: null,
      legal: false,
      fallbackUsed: true,
      failureCode,
      error: message,
    };
    params.calls.push(record);
    params.failures.push(
      createFireworksFailure({
        context: params.input.context,
        attemptId: params.attemptId,
        caseId: params.caseId,
        modelId: role.modelId,
        code: failureCode,
        source: failureCode === "fireworks_provider_failure" ? "provider" : "parser",
        message,
      })
    );
    return {
      action: fallback,
      rawResponse: "",
      call: record,
    };
  }
}

function createFireworksVerifierResult(input: {
  attemptId: string;
  caseId: string;
  score: number;
  metrics: FireworksGameMetrics;
  caseResults: FireworksCaseRunResult[];
  artifactIds: string[];
}): BenchmarkVerifierResult {
  const caseAssertions = input.caseResults.flatMap((result) => result.assertions);
  const normalizedScore = input.score / 100;
  const primaryAssertion =
    input.metrics.scoreKind === "scenario"
      ? {
          id: "scenario-quality",
          label: "Scenario quality",
          passed: (input.metrics.scenarioQualityScore ?? 0) >= 0.7,
          weight: 0.4,
        }
      : input.metrics.scoreKind === "full_game"
        ? {
            id: "full-game-team-score",
            label: "Full-game team score",
            passed: (input.metrics.fullGameTeamScore ?? 0) >= 0.7,
            weight: 0.4,
          }
        : {
            id: "mixed-benchmark-score",
            label: "Mixed benchmark score",
            passed: input.metrics.normalizedScore >= 0.7,
            weight: 0.4,
          };
  const assertions = [
    primaryAssertion,
    {
      id: "legal-actions",
      label: "Legal action rate",
      passed: input.metrics.illegalActions === 0,
      weight: 0.15,
    },
    {
      id: "critical-discard-safety",
      label: "Avoided critical discards",
      passed: input.metrics.criticalDiscards === 0,
      weight: 0.1,
    },
    ...caseAssertions,
  ];
  const passed = input.score >= 70 && assertions.every((assertion) => assertion.passed);
  return {
    id: `${input.attemptId}:verifier`,
    attemptId: input.attemptId,
    caseId: input.caseId,
    passed,
    score: normalizedScore,
    durationMs: input.metrics.durationMs,
    resultJson: JSON.stringify({
      passed,
      score: normalizedScore,
      summary: passed
        ? "Fireworks TeamIQ cases passed."
        : "Fireworks TeamIQ cases failed.",
      assertions,
      metrics: input.metrics,
    }),
    assertionResults: assertions,
    artifactIds: input.artifactIds,
  };
}

function aggregateMetrics(
  caseResults: FireworksCaseRunResult[],
  calls: FireworksCallRecord[],
  durationMs: number
): FireworksGameMetrics {
  const eventStates = caseResults.map((result) => result.state);
  const scenarioResults = caseResults.filter((result) => result.kind === "scenario");
  const fullGameResults = caseResults.filter(
    (result) => result.kind === "full_game"
  );
  const scoreKind =
    scenarioResults.length > 0 && fullGameResults.length > 0
      ? "mixed"
      : fullGameResults.length > 0
        ? "full_game"
        : "scenario";
  const legalActions = eventStates.reduce(
    (sum, state) => sum + state.events.filter((event) => event.legal).length,
    0
  );
  const illegalActions = calls.filter((call) => !call.legal).length;
  const fallbackActions = calls.filter((call) => call.fallbackUsed).length;
  const clueEvents = eventStates.flatMap((state) =>
    state.events.filter(
      (event) =>
        event.action.action === "clue_color" || event.action.action === "clue_rank"
    )
  );
  const playEvents = eventStates.flatMap((state) =>
    state.events.filter((event) => event.action.action === "play")
  );
  const discardEvents = eventStates.flatMap((state) =>
    state.events.filter((event) => event.action.action === "discard")
  );
  const scenarioQualityScore =
    scenarioResults.length > 0
      ? average(scenarioResults.map((result) => result.score))
      : null;
  const fullGameStackScore =
    fullGameResults.length > 0
      ? average(fullGameResults.map((result) => scoreFireworksState(result.state)))
      : null;
  const fullGameTeamScore =
    fullGameResults.length > 0
      ? average(fullGameResults.map((result) => result.score))
      : null;
  const finalScore =
    fullGameStackScore ??
    average(caseResults.map((result) => scoreFireworksState(result.state)));
  return {
    scoreKind,
    scenarioQualityScore,
    fullGameStackScore,
    fullGameTeamScore,
    finalScore,
    maxScore: 15,
    normalizedScore: average(caseResults.map((result) => result.score)),
    legalActions,
    illegalActions,
    fallbackActions,
    cluesGiven: clueEvents.length,
    usefulClues: clueEvents.filter((event) => event.useful).length,
    wastedClues: clueEvents.filter((event) => !event.useful).length,
    plays: playEvents.length,
    safePlays: playEvents.filter((event) => event.playResult === "success").length,
    badPlays: playEvents.filter((event) => event.playResult === "misplay").length,
    discards: discardEvents.length,
    safeDiscards: discardEvents.filter((event) => !event.criticalDiscard).length,
    criticalDiscards: discardEvents.filter((event) => event.criticalDiscard).length,
    memoryConsistentActions: eventStates.reduce(
      (sum, state) =>
        sum + state.events.filter((event) => event.memoryConsistent !== false).length,
      0
    ),
    memoryInconsistentActions: eventStates.reduce(
      (sum, state) =>
        sum + state.events.filter((event) => event.memoryConsistent === false).length,
      0
    ),
    modelCalls: calls.length,
    inputTokens: calls.reduce((sum, call) => sum + call.inputTokens, 0),
    outputTokens: calls.reduce((sum, call) => sum + call.outputTokens, 0),
    costUsd: costTotal(calls.map((call) => call.estimatedUsd)),
    durationMs,
  };
}

function statusForAttempt(
  score: number,
  calls: FireworksCallRecord[],
  metrics: FireworksGameMetrics
): CertifiedAttemptStatus {
  if (calls.some((call) => call.failureCode === "fireworks_provider_failure")) {
    return "provider_unavailable";
  }
  if (calls.some((call) => call.failureCode === "fireworks_invalid_json" || call.failureCode === "fireworks_illegal_action")) {
    return "failed_tool_use";
  }
  if (metrics.badPlays > 0 || metrics.criticalDiscards > 0) return "failed_model";
  return score >= 70 ? "passed" : "failed_model";
}

function roleForPlayer(
  team: BenchmarkTeamComposition,
  playerId: string
): BenchmarkTeamCompositionRole | null {
  if (team.roles.length === 0) return null;
  if (team.roles.length === 1) return team.roles[0];
  const direct = team.roles.find((role) => role.slot === playerId);
  if (direct) return direct;
  const playerIndex = Math.max(0, Number(playerId.replace(/^P/, "")) - 1);
  return team.roles[playerIndex % team.roles.length] ?? team.roles[0];
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

function createFireworksFailure(input: {
  context: CertifiedRunContext;
  attemptId: string;
  caseId: string;
  modelId: string;
  code: string;
  source: BenchmarkFailure["source"];
  message: string;
}): BenchmarkFailure {
  return {
    id: `${input.attemptId}:failure:${input.caseId}:${input.code}:${Math.random().toString(16).slice(2, 8)}`,
    runId: input.context.runId,
    caseId: input.caseId,
    attemptId: input.attemptId,
    modelId: input.modelId,
    domain: "game",
    source: input.source,
    code: input.code,
    severity: "error",
    message: input.message,
    createdAt: new Date().toISOString(),
  };
}

function traceIdsForAttempt(
  context: CertifiedRunContext,
  attemptId: string,
  calls: FireworksCallRecord[]
): string[] {
  const ids = calls
    .map((call) => call.traceId)
    .filter((traceId): traceId is string => Boolean(traceId));
  if ("snapshot" in context) {
    const snapshot = (context as PersistentCertifiedRunContext).snapshot();
    for (const trace of snapshot.traces) {
      if (trace.attemptId === attemptId && !ids.includes(trace.id)) {
        ids.push(trace.id);
      }
    }
  }
  return ids;
}

function isScenarioCase(value: FireworksBenchmarkCase): value is FireworksScenario {
  return "state" in value;
}

function costTotal(values: Array<number | null>): number | null {
  if (values.every((value) => value === null)) return null;
  let total = 0;
  for (const value of values) total += value ?? 0;
  return total;
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function roundScore(value: number): number {
  return Math.round(value * 10) / 10;
}

function isSoloComposition(
  teams: BenchmarkTeamComposition[],
  teamCompositionId: string
): boolean {
  const team = teams.find((candidate) => candidate.id === teamCompositionId);
  return getTeamCompositionModelIds(team).length === 1;
}
