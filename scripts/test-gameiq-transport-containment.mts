/* GameIQ transport containment checks (run: npx tsx scripts/test-gameiq-transport-containment.mts) */
// This is a plain .mts/ESM test that CONSTRUCTS CertifiedProviderError /
// CertifiedBudgetExceededError to feed the runner — exactly the shape a natural
// ESM caller has. Constructing across the CJS/ESM boundary is fine; only
// identity comparison (`instanceof`) was fragile there, because runner.ts is a
// .ts/CJS module and tsx interop can load model-call.ts twice (distinct class
// objects). The runner now contains transient failures via a STRUCTURAL guard
// (isCertifiedProviderError + classification check), and the assertions below
// likewise use structural checks (isCertifiedProviderError / name tag) — so
// these checks passing is the proof the production guard works across the
// boundary a real .mts caller hits.
import { CertifiedProviderError } from "../lib/benchmark/certified/model-call";
import { CertifiedBudgetExceededError } from "../lib/benchmark/certified/budget";
import {
  classifyProviderFailure,
  isCertifiedProviderError,
} from "../lib/benchmark/certified/classify-provider-failure";
import {
  runGameIqScenarios,
  listGameIqScenarioPacks,
  type GameIqScenario,
} from "../lib/benchmark/gameiq";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const pack = listGameIqScenarioPacks().find(
  (p) => p.id === "gameiq-v0.1-connect-four"
);
if (!pack) throw new Error("Connect Four GameIQ pack is required for this test.");
const scenarios: GameIqScenario[] = pack.scenarios.slice(0, 10);
if (scenarios.length !== 10) {
  throw new Error(
    `Connect Four pack must have at least 10 scenarios for this test (found ${scenarios.length}).`
  );
}
const perfectAction = (scenario: GameIqScenario) =>
  scenario.expectedActions[0]?.action;
const genericOpenAiProcessingError =
  "An error occurred while processing your request. You can retry your request, or contact us through our help center at help.openai.com if the error persists. Please include the request ID 12857d04-3d48-4f42-821c-7ef7eba4efc3 in your message.";

// --- 1/10 transient (index 3): excluded from scoring, attempt still passes ---
const one = await runGameIqScenarios({
  runId: "t-one",
  modelId: "m",
  teamCompositionId: "team",
  scenarios,
  moveProvider: ({ scenario, scenarioIndex }) => {
    if (scenarioIndex === 3) {
      throw new CertifiedProviderError("timed out", "transient");
    }
    return { action: perfectAction(scenario) };
  },
});
check(
  "1/10 transport: scenario marked unscored",
  one.caseResults[3]?.unscored === "transport",
  one.caseResults[3]
);
check(
  "1/10 transport: metrics exclude it from counts",
  one.metrics.scenarioCount === 10 &&
    one.metrics.scoredScenarioCount === 9 &&
    one.metrics.unscoredTransport === 1,
  one.metrics
);
check(
  "1/10 transport: outcome unaffected by the gap",
  one.metrics.outcomeScore === 1,
  one.metrics
);
check("1/10 transport: attempt still passes", one.attempt.status === "passed", one.attempt);
check(
  "1/10 transport: structuredReliability/legalActionRate stay perfect (no failed_tool_use trip)",
  one.metrics.structuredReliability === 1 && one.metrics.legalActionRate === 1,
  one.metrics
);

// --- 4/10 transient (indices 0,3,6,9 -> 0.4 > 0.1): attempt invalid ---
const many = await runGameIqScenarios({
  runId: "t-many",
  modelId: "m",
  teamCompositionId: "team",
  scenarios,
  moveProvider: ({ scenario, scenarioIndex }) => {
    if ([0, 3, 6, 9].includes(scenarioIndex)) {
      throw new CertifiedProviderError("503", "transient");
    }
    return { action: perfectAction(scenario) };
  },
});
check(
  "4/10 transport: attempt provider_unavailable",
  many.attempt.status === "provider_unavailable",
  many.attempt
);
check(
  "4/10 transport: metrics still report the counts honestly",
  many.metrics.scenarioCount === 10 &&
    many.metrics.scoredScenarioCount === 6 &&
    many.metrics.unscoredTransport === 4,
  many.metrics
);

// --- boundary pin: exactly 1/10 (0.1, NOT > 0.1) still scores; 2/10 (0.2 > 0.1) invalidates ---
const boundaryAtLimit = await runGameIqScenarios({
  runId: "t-boundary-at-limit",
  modelId: "m",
  teamCompositionId: "team",
  scenarios,
  moveProvider: ({ scenario, scenarioIndex }) => {
    if (scenarioIndex === 0) {
      throw new CertifiedProviderError("timed out", "transient");
    }
    return { action: perfectAction(scenario) };
  },
});
check(
  "boundary: 1/10 (0.1) unscored rate is NOT > 0.1, attempt still scored",
  boundaryAtLimit.attempt.status === "passed" &&
    boundaryAtLimit.metrics.unscoredTransport === 1,
  boundaryAtLimit.attempt
);

const boundaryOverLimit = await runGameIqScenarios({
  runId: "t-boundary-over-limit",
  modelId: "m",
  teamCompositionId: "team",
  scenarios,
  moveProvider: ({ scenario, scenarioIndex }) => {
    if (scenarioIndex === 0 || scenarioIndex === 1) {
      throw new CertifiedProviderError("timed out", "transient");
    }
    return { action: perfectAction(scenario) };
  },
});
check(
  "boundary: 2/10 (0.2) unscored rate IS > 0.1, attempt invalidated",
  boundaryOverLimit.attempt.status === "provider_unavailable" &&
    boundaryOverLimit.metrics.unscoredTransport === 2,
  boundaryOverLimit.attempt
);

// --- real-world regression: ChatGPT generic processing error in Fireworks
// Memory Stress scenario 12 under the UI's concurrency-4 pack shape. The saved
// failing run showed this exact message on gameiq-fireworks-memory-v1-12. Before
// the classifier fix it was "other", rethrew out of the pack, and the run engine
// synthesized invalid_harness. It must be a transient provider transport gap.
const memoryPack = listGameIqScenarioPacks().find(
  (p) => p.id === "gameiq-fireworks-memory-v1"
);
if (!memoryPack) {
  throw new Error("Fireworks Memory Stress GameIQ pack is required for this test.");
}
const memoryScenario12Index = memoryPack.scenarios.findIndex(
  (scenario) => scenario.id === "gameiq-fireworks-memory-v1-12"
);
if (memoryScenario12Index < 0) {
  throw new Error("Fireworks Memory Stress scenario 12 is required for this test.");
}
const memoryScenario12 = await runGameIqScenarios({
  runId: "t-memory-scenario-12-openai-processing-error",
  modelId: "chatgpt:gpt-5.5",
  teamCompositionId: "team-chatgpt",
  scenarios: memoryPack.scenarios,
  concurrency: 4,
  moveProvider: ({ scenario }) => {
    if (scenario.id === "gameiq-fireworks-memory-v1-12") {
      throw new CertifiedProviderError(
        genericOpenAiProcessingError,
        classifyProviderFailure(genericOpenAiProcessingError)
      );
    }
    return { action: perfectAction(scenario) };
  },
});
check(
  "Memory Stress scenario 12 generic ChatGPT processing error is contained as transport, not invalid_harness",
  memoryScenario12.caseResults[memoryScenario12Index]?.unscored === "transport" &&
    memoryScenario12.metrics.scenarioCount === memoryPack.scenarios.length &&
    memoryScenario12.metrics.unscoredTransport === 1 &&
    memoryScenario12.attempt.status === "passed",
  {
    attempt: memoryScenario12.attempt,
    metrics: memoryScenario12.metrics,
    scenario12: memoryScenario12.caseResults[memoryScenario12Index],
  }
);

// --- fatal provider error rethrows out of runGameIqScenarios ---
let fatalThrew: unknown = null;
try {
  await runGameIqScenarios({
    runId: "t-fatal",
    modelId: "m",
    teamCompositionId: "team",
    scenarios,
    moveProvider: () => {
      throw new CertifiedProviderError("credits depleted", "fatal");
    },
  });
} catch (error) {
  fatalThrew = error;
}
check(
  "fatal: rethrows a CertifiedProviderError instead of containing it",
  isCertifiedProviderError(fatalThrew) && fatalThrew.classification === "fatal",
  fatalThrew
);

// --- budget error rethrows (never swallowed as unscored) ---
let budgetThrew: unknown = null;
try {
  await runGameIqScenarios({
    runId: "t-budget",
    modelId: "m",
    teamCompositionId: "team",
    scenarios,
    moveProvider: () => {
      throw new CertifiedBudgetExceededError("budget exceeded");
    },
  });
} catch (error) {
  budgetThrew = error;
}
check(
  "budget: rethrows a CertifiedBudgetExceededError instead of containing it",
  (budgetThrew as { name?: string } | null)?.name === "CertifiedBudgetExceededError",
  budgetThrew
);

// --- "other" classification also rethrows (only "transient" is contained) ---
let otherThrew: unknown = null;
try {
  await runGameIqScenarios({
    runId: "t-other",
    modelId: "m",
    teamCompositionId: "team",
    scenarios,
    moveProvider: () => {
      throw new CertifiedProviderError("unexpected shape", "other");
    },
  });
} catch (error) {
  otherThrew = error;
}
check(
  "other: rethrows a CertifiedProviderError instead of containing it",
  isCertifiedProviderError(otherThrew) && otherThrew.classification === "other",
  otherThrew
);

// --- all-unscored: every call throws transient -> provider_unavailable, finite score, no NaN ---
const allUnscored = await runGameIqScenarios({
  runId: "t-all-unscored",
  modelId: "m",
  teamCompositionId: "team",
  scenarios,
  moveProvider: () => {
    throw new CertifiedProviderError("timed out", "transient");
  },
});
check(
  "all-unscored: attempt provider_unavailable with zero scored scenarios",
  allUnscored.attempt.status === "provider_unavailable" &&
    allUnscored.metrics.scoredScenarioCount === 0 &&
    allUnscored.metrics.unscoredTransport === 10,
  { attempt: allUnscored.attempt, metrics: allUnscored.metrics }
);
check(
  "all-unscored: score stays finite, no NaN, no divide-by-zero",
  Number.isFinite(allUnscored.score) &&
    Number.isFinite(allUnscored.metrics.outcomeScore) &&
    Number.isFinite(allUnscored.metrics.moveQuality) &&
    Number.isFinite(allUnscored.metrics.legalActionRate) &&
    Number.isFinite(allUnscored.metrics.structuredReliability) &&
    Number.isFinite(allUnscored.metrics.fallbackRate),
  { score: allUnscored.score, metrics: allUnscored.metrics }
);

// --- 0/10: no failures -> additive fields pinned, nothing unscored ---
const clean = await runGameIqScenarios({
  runId: "t-clean",
  modelId: "m",
  teamCompositionId: "team",
  scenarios,
  moveProvider: ({ scenario }) => ({ action: perfectAction(scenario) }),
});
check(
  "0/10: happy path pins unscoredTransport=0 and scoredScenarioCount=scenarioCount",
  clean.metrics.unscoredTransport === 0 &&
    clean.metrics.scoredScenarioCount === clean.metrics.scenarioCount &&
    clean.attempt.status === "passed",
  clean.metrics
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
