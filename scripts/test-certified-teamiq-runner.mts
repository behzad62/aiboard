/* Certified TeamIQ runner checks (run: npx tsx scripts/test-certified-teamiq-runner.mts) */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  listBenchmarkTeamCompositions,
  listBenchmarkVerifierResults,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  STATEFUL_REFERENCE_TRANSCRIPTS,
  TOOL_RELIABILITY_CASES,
} from "../lib/benchmark/toolreliability";
import {
  deriveTeamComposition,
  runCertifiedTeamIq,
} from "../lib/benchmark/teamiq";
import type { BenchmarkCaseV2, BenchmarkTeamCompositionRole } from "../lib/benchmark/types";
import type { ChatParams, StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const now = "2026-06-28T13:00:00.000Z";
const caseV2: BenchmarkCaseV2 = {
  id: "teamiq-toolreliability-current-pack",
  schemaVersion: 2,
  track: "teamiq",
  title: "TeamIQ over ToolReliability current pack",
  description:
    "TeamIQ benchmark using deterministic stateful ToolReliability tasks as the scored substrate.",
  difficulty: "medium",
  tags: ["teamiq", "toolreliability"],
  caseVersion: "0.1.0",
  createdAt: now,
  updatedAt: now,
  prompt: {
    userRequest: "Run solo baselines and a model team over stateful ToolReliability cases.",
  },
  environment: {
    type: "browser",
    timeoutSeconds: 60,
    network: "none",
  },
  verifier: {
    scorer: "rule-checker",
  },
  budget: {
    maxUsd: 1,
    maxModelCalls: 200,
  },
  scoring: {
    scoringVersion: "teamiq-toolreliability-current",
    primary: "team_lift",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CERTIFIED-TEAMIQ-RUNNER",
    referenceSolutionPrivate: true,
  },
};

const roles: BenchmarkTeamCompositionRole[] = [
  {
    role: "architect",
    slot: "architect",
    modelId: "openai:gpt-team-architect",
    providerId: "openai",
    displayName: "GPT Team Architect",
    temperature: 0,
  },
  {
    role: "worker",
    slot: "worker",
    modelId: "google:gemini-team-worker",
    providerId: "google",
    displayName: "Gemini Team Worker",
    temperature: 0,
  },
  {
    role: "reviewer",
    slot: "reviewer",
    modelId: "anthropic:claude-team-reviewer",
    providerId: "anthropic",
    displayName: "Claude Team Reviewer",
    temperature: 0,
  },
];
const team = deriveTeamComposition({
  name: "Architect Worker Reviewer",
  roles,
});

// Two small stateful cases (few turns each) keep this test's per-turn x
// per-role call multiplication cheap while still exercising a multi-turn
// case (redundant-read, 3 reference turns) and a shorter one (write-scope,
// 2 reference turns).
const selectedCases = [
  TOOL_RELIABILITY_CASES.find((benchmarkCase) => benchmarkCase.kind === "redundant-read")!,
  TOOL_RELIABILITY_CASES.find((benchmarkCase) => benchmarkCase.kind === "write-scope")!,
];

const callsByProvider = new Map<string, number>();
const capturedCalls: Array<{
  providerId: string;
  caseId: string;
  params: Pick<ChatParams, "messages" | "structuredOutput">;
}> = [];

/**
 * Which reference-transcript entry a call should answer with, derived
 * PURELY from that call's own prompt text — never from shared mutable
 * state. `buildStatefulTurnPrompt` folds the transcript-so-far into every
 * turn's prompt as `Turn N - you replied:` markers (one per completed
 * turn), and each COMPOSITION (a solo baseline or the main team) builds its
 * own transcript from scratch per case (`runTeamIqToolReliabilityAttempt`'s
 * `transcript` variable) -- so counting those markers in THIS prompt gives
 * the correct next-turn index for THIS composition's progress on THIS case,
 * with zero risk of one composition's turn count leaking into another's (a
 * shared/global counter would collide the moment solo baselines and the
 * main team both work the same case ids in one run, which they do here).
 */
function referenceTurnIndex(prompt: string): number {
  return (prompt.match(/Turn \d+ - you replied:/g) ?? []).length;
}

/**
 * Every physical call whose output actually becomes the case's scored
 * per-turn output (a solo team's one-and-only role call — its prompt says
 * "Your role: single (single)" per `deriveSoloTeamComposition` — or a
 * multi-role team's SYNTHESIS call) draws the correct reference-transcript
 * entry for its turn. `CertifiedModelStream`'s mock signature is only
 * `{providerId, params}` (no participantId), so team/solo/role attribution
 * is read from the PROMPT TEXT itself, exactly like the real harness's own
 * prompt-shape distinctions. Non-scored role calls (the other members of a
 * multi-role team, whose raw output is discarded once synthesis picks the
 * team's one turn answer) get an inert placeholder.
 */
function scoredTurnOutput(benchmarkCase: { id: string }, prompt: string): string | undefined {
  if (!isScoredTurnCall(prompt)) return undefined;
  const reference = STATEFUL_REFERENCE_TRANSCRIPTS[benchmarkCase.id] ?? [];
  return reference[referenceTurnIndex(prompt)];
}

function isScoredTurnCall(prompt: string): boolean {
  return prompt.includes("Synthesize the team's outputs") || prompt.includes("Your role: single (single)");
}

function findCaseByCanary(prompt: string): (typeof selectedCases)[number] | undefined {
  return selectedCases.find((benchmarkCase) => prompt.includes(benchmarkCase.canary));
}

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);

const summary = await runCertifiedBenchmark({
  runId: "run-certified-teamiq",
  suiteId: "suite-certified-teamiq",
  track: "teamiq",
  harnessProfile: "raw-single-model",
  caseIds: [caseV2.id],
  teamCompositionIds: [team.id],
  certification: runHarnessCertification("raw-single-model"),
  runner: (context) =>
    runCertifiedTeamIq({
      context,
      teamCompositions: [team],
      task: {
        kind: "toolreliability",
        casePack: selectedCases,
      },
      includeSoloBaselines: true,
      pricing: {
        inputUsdPer1M: 1,
        outputUsdPer1M: 1,
      },
      streamChat: async function* ({ providerId, params }): AsyncIterable<StreamChunk> {
        callsByProvider.set(providerId, (callsByProvider.get(providerId) ?? 0) + 1);
        const prompt = params.messages.map((message) => message.content).join("\n");
        const benchmarkCase = findCaseByCanary(prompt);
        capturedCalls.push({
          providerId,
          caseId: benchmarkCase?.id ?? "",
          params: {
            messages: params.messages,
            structuredOutput: params.structuredOutput,
          },
        });
        const content =
          (benchmarkCase && scoredTurnOutput(benchmarkCase, prompt)) ?? "Investigating the current state.";
        yield { type: "token", content };
        yield { type: "done" };
      },
    }),
});

const attempts = await listBenchmarkAttemptsV2();
const teamCompositions = await listBenchmarkTeamCompositions();
const verifiers = await listBenchmarkVerifierResults();
const bundle = exportBenchmarkReportBundleV2();
const soloAttempts = attempts.filter(
  (attempt) => attempt.track === "teamiq" && attempt.teamCompositionId !== team.id
);
const teamAttempt = attempts.find((attempt) => attempt.teamCompositionId === team.id);
const teamVerifier = verifiers.find((verifier) => verifier.attemptId === teamAttempt?.id);

check(
  "certified TeamIQ run completes",
  summary.status === "completed" &&
    summary.attemptCount === roles.length + 1 &&
    summary.verifierCount === roles.length + 1,
  summary
);
check(
  "certified TeamIQ verifier durationMs is not an attempt-count sum",
  teamVerifier?.durationMs === 0,
  { durationMs: teamVerifier?.durationMs }
);
check(
  "certified TeamIQ automatically saves solo baselines",
  soloAttempts.length === roles.length &&
    roles.every((role) =>
      teamCompositions.some(
        (composition) =>
          composition.roles.length === 1 &&
          composition.roles[0]?.modelId === role.modelId
      )
    ),
  { soloAttempts, teamCompositions }
);
check(
  "certified TeamIQ computes team lift after baselines",
  teamAttempt?.status === "passed" &&
    teamAttempt.teamLift === 0 &&
    teamAttempt.verifiedQuality === 1,
  teamAttempt
);

// Expected TEAM call count, by formula (not filtered from capturedCalls,
// since the mock's signature carries no participantId to distinguish team
// calls from the solo-baseline calls this same run also makes): every turn
// of every case costs (roles.length + 1) physical calls for this 3-role
// team (one per role, plus one synthesis call), and the number of turns a
// case takes equals its reference transcript's length (each entry is
// exactly one physical turn — see stateful-env.ts; the final entry is
// always the free-text answer that sets `done`).
const expectedTeamCallCount = selectedCases.reduce(
  (sum, benchmarkCase) =>
    sum + (STATEFUL_REFERENCE_TRANSCRIPTS[benchmarkCase.id]?.length ?? 0) * (roles.length + 1),
  0
);
check(
  "certified TeamIQ records one trace per physical team model call, matching the per-turn x per-role formula",
  teamAttempt?.traceIds.length === expectedTeamCallCount && bundle.traces.length >= expectedTeamCallCount,
  { traceCount: bundle.traces.length, expectedTeamCallCount, teamAttempt }
);

// The prompt contract for every stateful case is the SAME generic tool-
// action protocol (buildStatefulTurnPrompt) — no per-case JSON schema is
// ever stated, and no provider structured-output enforcement is ever
// requested (mirrors the solo turn loop's own stateful branch). This is the
// honest stateful-pack replacement for the old json-schema/tool-call/patch/
// forbidden-action per-category prompt-shape assertions, which no longer
// have anything to assert against post-cut.
check(
  "certified TeamIQ states the stateful action-protocol contract in the prompt, never a per-case JSON schema",
  capturedCalls.length > 0 &&
    capturedCalls.every((call) => {
      const prompt = call.params.messages.map((message) => message.content).join("\n");
      return (
        prompt.includes("Available JSON tool actions") &&
        !prompt.includes("Required JSON schema:")
      );
    }),
  capturedCalls.map((call) => call.params.messages.map((message) => message.content).join("\n").slice(0, 200))
);
check(
  "certified TeamIQ never requests provider structured-output enforcement on stateful turns",
  capturedCalls.every((call) => call.params.structuredOutput === undefined),
  capturedCalls.map((call) => call.params.structuredOutput)
);
check(
  "certified TeamIQ carries every case's canary into its prompts",
  selectedCases.every((benchmarkCase) =>
    capturedCalls.some((call) =>
      call.params.messages.some((message) => message.content.includes(benchmarkCase.canary))
    )
  ),
  selectedCases.map((item) => item.canary)
);

check(
  "certified TeamIQ model traces are keyed to individual ToolReliability cases",
  teamAttempt?.traceIds.every((traceId) => {
    const trace = bundle.traces.find((candidate) => candidate.id === traceId);
    return trace?.caseId ? selectedCases.some((benchmarkCase) => benchmarkCase.id === trace.caseId) : false;
  }) === true,
  teamAttempt?.traceIds.map((traceId) => bundle.traces.find((candidate) => candidate.id === traceId)?.caseId)
);
const parsedTeamVerifier = JSON.parse(teamVerifier?.resultJson ?? "{}") as {
  diagnostics?: { summary?: { total?: number }; cases?: unknown[] };
};
check(
  "certified TeamIQ verifier includes ToolReliability diagnostics",
  parsedTeamVerifier.diagnostics?.summary?.total === selectedCases.length &&
    parsedTeamVerifier.diagnostics.cases?.length === selectedCases.length,
  parsedTeamVerifier
);
check(
  "certified TeamIQ verifier results export",
  verifiers.length === roles.length + 1 &&
    bundle.verifierResults.length === verifiers.length,
  { verifiers, bundleVerifierCount: bundle.verifierResults.length }
);
check(
  "certified TeamIQ calls every team provider",
  roles.every((role) => (callsByProvider.get(role.providerId) ?? 0) > 0),
  Object.fromEntries(callsByProvider)
);

// --- Multi-turn mechanics: a multi-role team makes exactly one synthesis
// call PER TURN (not once per case), stopping as soon as the env reports
// done -- proving the turn loop actually iterates rather than collapsing
// a multi-turn case into a single round. ---

__resetBenchmarkStoreForTests();
const synthesisCase = TOOL_RELIABILITY_CASES.find((item) => item.kind === "write-scope")!;
const synthesisReferenceTurns = (STATEFUL_REFERENCE_TRANSCRIPTS[synthesisCase.id] ?? []).length;
const twoRoleTeam = deriveTeamComposition({
  name: "Synthesis required team",
  roles: roles.slice(0, 2),
});
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(twoRoleTeam);
let synthesisModelCalls = 0;
let synthesisPrompts = 0;
const synthesisSummary = await runCertifiedBenchmark({
  runId: "run-certified-teamiq-synthesis",
  suiteId: "suite-certified-teamiq",
  track: "teamiq",
  harnessProfile: "raw-single-model",
  caseIds: [caseV2.id],
  teamCompositionIds: [twoRoleTeam.id],
  certification: runHarnessCertification("raw-single-model"),
  runner: (context) =>
    runCertifiedTeamIq({
      context,
      teamCompositions: [twoRoleTeam],
      task: {
        kind: "toolreliability",
        casePack: [synthesisCase],
      },
      includeSoloBaselines: false,
      pricing: {
        inputUsdPer1M: 1,
        outputUsdPer1M: 1,
      },
      streamChat: async function* ({ params }): AsyncIterable<StreamChunk> {
        synthesisModelCalls++;
        const prompt = params.messages.map((message) => message.content).join("\n");
        const isSynthesis = prompt.includes("Synthesize the team's outputs");
        if (isSynthesis) synthesisPrompts++;
        yield {
          type: "token",
          content: scoredTurnOutput(synthesisCase, prompt) ?? "Reviewing the task.",
        };
        yield { type: "done" };
      },
    }),
});
const synthesisAttempt = (await listBenchmarkAttemptsV2()).find(
  (attempt) => attempt.runId === synthesisSummary.runId
);
check(
  "multi-role TeamIQ adds exactly one synthesis call PER TURN, matching the case's reference turn count",
  synthesisPrompts === synthesisReferenceTurns &&
    synthesisModelCalls === (twoRoleTeam.roles.length + 1) * synthesisReferenceTurns,
  { synthesisModelCalls, synthesisPrompts, synthesisReferenceTurns }
);
check(
  "multi-role TeamIQ scores the synthesized transcript, not a member's raw output",
  synthesisAttempt?.status === "passed" &&
    synthesisAttempt.modelCalls === (twoRoleTeam.roles.length + 1) * synthesisReferenceTurns,
  synthesisAttempt
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
