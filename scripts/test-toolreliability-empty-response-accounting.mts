/* Empty-response turn handling + trace-per-call accounting for stateful
   ToolReliability cases
   (run: npx tsx scripts/test-toolreliability-empty-response-accounting.mts)

   Pins the two halves of the 2026-07-22 gate-3 finding, where one 5-maxTurns
   case recorded SIX model-call traces:

   (1) TRACE ACCOUNTING. A provider that streams nothing raises "Certified
       provider returned an empty response." inside `callCertifiedModelOnce`;
       `classifyProviderFailure` calls that transient, so `callCertifiedModel`
       retries it, and every physical attempt records its own trace. Six
       traces therefore mean four TURNS, not a sixth iteration of a
       `turn < maxTurns` loop. Each trace's `retryHistory` describes only its
       own call (length 1 always) — the retry trail lives in the trace COUNT
       plus the `attempt` marker on the run events.

   (2) REPLAY DETERMINISM. The live turn loop can never hand an empty string
       to the env (empties are retried away one layer down), but a run file
       persists TRACES, not `candidate.outputs` — so anything reconstructing
       outputs from traces replays the empty attempts too. An empty output
       must therefore be a non-event for the env: it must not consume a turn
       and must not be mistaken for the model's final prose answer. */
import {
  __resetBenchmarkStoreForTests,
  exportBenchmarkReportBundleV2,
  listBenchmarkAttemptsV2,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  STATEFUL_REFERENCE_TRANSCRIPTS,
  TOOL_RELIABILITY_CASES,
} from "../lib/benchmark/toolreliability/cases";
import { runToolReliabilityPack } from "../lib/benchmark/toolreliability/runner";
import { runCertifiedToolReliability } from "../lib/benchmark/toolreliability/certified-runner";
import { createStatefulEnv } from "../lib/benchmark/toolreliability/stateful-env";
import type {
  StatefulToolReliabilityCase,
  ToolReliabilityCaseResult,
} from "../lib/benchmark/toolreliability/types";
import type {
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";
import type { SelectedModel, StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

const STATEFUL_CASES = TOOL_RELIABILITY_CASES.filter(
  (benchmarkCase): benchmarkCase is StatefulToolReliabilityCase =>
    benchmarkCase.category === "stateful"
);

/** The shapes a dead provider stream produces: nothing, or only whitespace. */
const EMPTY_RESPONSES = ["", "   ", "\n\n"];

function replayCase(
  benchmarkCase: StatefulToolReliabilityCase,
  outputs: string[]
): ToolReliabilityCaseResult {
  const result = runToolReliabilityPack(
    {
      id: "toolrel-empty-accounting-candidate",
      modelId: "deterministic:empty-accounting",
      providerId: "deterministic",
      teamCompositionId: "toolrel-empty-accounting",
      outputs: { [benchmarkCase.id]: outputs },
    },
    [benchmarkCase]
  );
  return result.caseResults[0]!;
}

/** Reference transcript with an empty attempt spliced in before every turn. */
function withEmptiesInterleaved(turns: string[]): string[] {
  return turns.flatMap((turn, index) => [
    EMPTY_RESPONSES[index % EMPTY_RESPONSES.length]!,
    turn,
  ]);
}

// --- (1) env level: an empty response is not a turn and not a final answer ---

for (const benchmarkCase of STATEFUL_CASES) {
  const env = createStatefulEnv(benchmarkCase);
  const emptyStep = env.step("");
  check(
    `${benchmarkCase.kind}: an empty response does not end the episode`,
    emptyStep.done === false && emptyStep.renderedResult === "",
    { caseId: benchmarkCase.id, emptyStep }
  );
}

{
  // A turn budget is spent by real turns only. `redundant-read-001` has
  // maxTurns === reference turns, so a consumed turn would starve the case.
  const benchmarkCase = STATEFUL_CASES.find(
    (candidate) => candidate.id === "toolrel-current-stateful-redundant-read-001"
  )!;
  const turns = STATEFUL_REFERENCE_TRANSCRIPTS[benchmarkCase.id]!;
  const env = createStatefulEnv(benchmarkCase);
  for (const empty of EMPTY_RESPONSES) env.step(empty);
  const rendered = turns.map((turn) => env.step(turn));
  check(
    "empty responses do not consume a turn from the case budget",
    env.verdict().passed && rendered[rendered.length - 1]!.done,
    { caseId: benchmarkCase.id, verdict: env.verdict(), rendered }
  );
}

{
  // Guard the semantics the fix must NOT change: real prose still ends it.
  const benchmarkCase = STATEFUL_CASES[0]!;
  const env = createStatefulEnv(benchmarkCase);
  const finalStep = env.step("All done - the file is complete.");
  check(
    "a non-empty prose reply is still the model's final answer",
    finalStep.done === true,
    { caseId: benchmarkCase.id, finalStep }
  );
}

// --- (2) replay determinism: trace-derived outputs score like the live run ---

for (const benchmarkCase of STATEFUL_CASES) {
  const turns = STATEFUL_REFERENCE_TRANSCRIPTS[benchmarkCase.id]!;
  const live = replayCase(benchmarkCase, turns);
  const traceDerived = replayCase(benchmarkCase, withEmptiesInterleaved(turns));
  const envSteps = (result: ToolReliabilityCaseResult) =>
    result.events.filter((traceEvent) => traceEvent.type === "env_step");
  check(
    `${benchmarkCase.kind}: replaying empty attempts matches the live verdict`,
    traceDerived.passed === live.passed &&
      traceDerived.metrics.stateful === live.metrics.stateful &&
      JSON.stringify(envSteps(traceDerived)) === JSON.stringify(envSteps(live)),
    {
      caseId: benchmarkCase.id,
      live: { passed: live.passed, steps: envSteps(live).length },
      traceDerived: {
        passed: traceDerived.passed,
        steps: envSteps(traceDerived).length,
      },
    }
  );
}

// --- (3) certified turn loop: physical calls vs turns ---

const now = "2026-07-22T04:18:00.000Z";
const ACCOUNTING_CASE = STATEFUL_CASES.find(
  (candidate) => candidate.id === "toolrel-current-stateful-redundant-read-001"
)!;
const ACCOUNTING_TURNS = STATEFUL_REFERENCE_TRANSCRIPTS[ACCOUNTING_CASE.id]!;
// Two dead attempts on the second turn, exactly like the gate-3 recording.
const EMPTY_ATTEMPTS_ON_TURN = 1;
const EMPTY_ATTEMPTS = 2;

const caseV2: BenchmarkCaseV2 = {
  id: "toolreliability-empty-accounting-pack",
  schemaVersion: 2,
  track: "toolreliability",
  title: "ToolReliability empty-response accounting pack",
  description: "One stateful case driven through the real certified turn loop.",
  difficulty: "easy",
  tags: ["toolreliability"],
  caseVersion: "current",
  createdAt: now,
  updatedAt: now,
  prompt: { userRequest: "Complete the stateful case." },
  environment: { type: "browser", timeoutSeconds: 60, network: "none" },
  verifier: { scorer: "rule-checker" },
  budget: { maxUsd: 1, maxModelCalls: 20 },
  scoring: {
    scoringVersion: "toolreliability-current",
    primary: "tool_reliability",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-CERTIFIED-TOOLREL-EMPTY-ACCOUNTING",
    referenceSolutionPrivate: true,
  },
};

const team: BenchmarkTeamComposition = {
  id: "team-toolrel-empty-accounting",
  name: "ToolReliability empty-response accounting",
  comboHash: "combo:toolrel-empty-accounting",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "openai:gpt-toolrel",
      providerId: "openai",
      displayName: "GPT ToolRel",
      temperature: 0,
      maxTokens: 512,
    },
  ],
};

const model: SelectedModel = {
  modelId: "openai:gpt-toolrel",
  providerId: "openai",
  displayName: "GPT ToolRel",
};

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(caseV2);
await saveBenchmarkTeamComposition(team);

let turnIndex = 0;
let emptiesServed = 0;
const servedResponses: string[] = [];

const summary = await runCertifiedBenchmark({
  runId: "run-toolrel-empty-accounting",
  suiteId: "suite-toolrel-empty-accounting",
  track: "toolreliability",
  harnessProfile: "raw-single-model",
  caseIds: [caseV2.id],
  teamCompositionIds: [team.id],
  certification: {
    ...runHarnessCertification("raw-single-model"),
    passed: true,
    checks: [
      {
        id: "toolrel-empty-accounting-fixture",
        label: "ToolReliability empty-response accounting fixture",
        passed: true,
      },
    ],
  },
  runner: (context) =>
    runCertifiedToolReliability({
      context,
      models: [model],
      teamCompositionIds: [team.id],
      casePack: [ACCOUNTING_CASE],
      pricing: { inputUsdPer1M: 1, outputUsdPer1M: 1 },
      // Near-instant retries (jitter only) so the hermetic test does not wait
      // out the real 2s/8s backoff.
      retryDelaysMs: [0, 0],
      streamChat: async function* emptyThenRecover(): AsyncIterable<StreamChunk> {
        const dead =
          turnIndex === EMPTY_ATTEMPTS_ON_TURN && emptiesServed < EMPTY_ATTEMPTS;
        if (dead) {
          emptiesServed++;
          servedResponses.push("");
          yield { type: "done" };
          return;
        }
        const response = ACCOUNTING_TURNS[turnIndex++] ?? "Done.";
        servedResponses.push(response);
        yield { type: "token", content: response };
        yield { type: "done" };
      },
    }),
});

const attempt = (await listBenchmarkAttemptsV2())[0];
const bundle = exportBenchmarkReportBundleV2();
const caseTraces = bundle.traces.filter(
  (trace) => trace.caseId === ACCOUNTING_CASE.id
);
const expectedPhysicalCalls = ACCOUNTING_TURNS.length + EMPTY_ATTEMPTS;

check(
  "certified run completes with the empty attempts retried away",
  summary.status === "completed" && attempt?.status === "passed",
  { status: summary.status, attempt }
);
check(
  "the env sees one turn per non-empty response, not per physical call",
  turnIndex === ACCOUNTING_TURNS.length && emptiesServed === EMPTY_ATTEMPTS,
  { turnIndex, emptiesServed, expected: ACCOUNTING_TURNS.length }
);
check(
  "every physical model call records its own trace",
  caseTraces.length === expectedPhysicalCalls &&
    attempt?.modelCalls === expectedPhysicalCalls &&
    attempt?.traceIds.length === expectedPhysicalCalls,
  {
    traces: caseTraces.length,
    modelCalls: attempt?.modelCalls,
    traceIds: attempt?.traceIds.length,
    expected: expectedPhysicalCalls,
  }
);
check(
  "the dead attempts are traced as provider errors with empty output",
  caseTraces.filter(
    (trace) =>
      (trace.rawResponse ?? "") === "" &&
      trace.retryHistory.some((entry) => entry.status === "provider_error")
  ).length === EMPTY_ATTEMPTS,
  caseTraces.map((trace) => ({
    len: (trace.rawResponse ?? "").length,
    statuses: trace.retryHistory.map((entry) => entry.status),
  }))
);
check(
  "retryHistory stays per-call - the retry trail is the trace count and the event attempt marker",
  caseTraces.every((trace) => trace.retryHistory.length === 1) &&
    JSON.stringify(
      bundle.runEvents
        .filter((runEvent) => runEvent.type === "model_call_started")
        .map((runEvent) => JSON.parse(runEvent.detailsJson ?? "{}").attempt)
    ) === JSON.stringify([1, 1, 2, 3, 1]),
  {
    retryHistoryLengths: caseTraces.map((trace) => trace.retryHistory.length),
    attempts: bundle.runEvents
      .filter((runEvent) => runEvent.type === "model_call_started")
      .map((runEvent) => JSON.parse(runEvent.detailsJson ?? "{}").attempt),
  }
);

// The live loop's verdict must equal a replay of what it actually served the
// env, AND a replay of the raw trace stream (empties included) — otherwise a
// run file cannot be re-scored from its own traces.
const liveReplay = replayCase(ACCOUNTING_CASE, ACCOUNTING_TURNS);
const traceReplay = replayCase(
  ACCOUNTING_CASE,
  caseTraces.map((trace) => trace.rawResponse ?? "")
);
check(
  "live verdict, served-output replay and raw-trace replay all agree",
  attempt?.toolReliabilityScore === 100 &&
    liveReplay.passed === true &&
    traceReplay.passed === liveReplay.passed &&
    traceReplay.metrics.stateful === liveReplay.metrics.stateful,
  {
    score: attempt?.toolReliabilityScore,
    live: liveReplay.passed,
    trace: traceReplay.passed,
    servedResponses: servedResponses.map((response) => response.length),
  }
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
