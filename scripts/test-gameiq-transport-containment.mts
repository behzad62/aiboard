/* GameIQ transport containment checks (run: npx tsx scripts/test-gameiq-transport-containment.mts) */
// NOTE on the createRequire below: lib/benchmark/gameiq/runner.ts is a plain
// .ts file (CommonJS by default, since this package has no "type": "module"),
// while this script is .mts (always ESM). runner.ts's own
// `import { CertifiedProviderError } from "@/lib/benchmark/certified/model-call"`
// therefore resolves via require() at runtime. If this script instead reaches
// CertifiedProviderError via a plain ESM `import`, tsx's CJS/ESM interop can
// load lib/benchmark/certified/model-call.ts a SECOND time under a distinct
// module instance (observable as a `?tsx-commonjs-export-preparse=1` copy),
// which mints a second CertifiedProviderError class — `instanceof` checks
// then silently fail across the two instances even though both sides "look"
// like the same import. Using createRequire to load it exactly like
// runner.ts does keeps both sides pointing at the same CJS singleton. This is
// purely a test-harness (tsx) artifact: the real production call path
// (certified-runner.ts -> callCertifiedModel -> throw, caught by
// runner.ts's evaluateScenario within a single module graph traversal) never
// crosses this boundary and is unaffected.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const {
  CertifiedProviderError,
} = require("../lib/benchmark/certified/model-call.ts") as typeof import("../lib/benchmark/certified/model-call");
const {
  CertifiedBudgetExceededError,
} = require("../lib/benchmark/certified/budget.ts") as typeof import("../lib/benchmark/certified/budget");
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
  fatalThrew instanceof CertifiedProviderError,
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
  budgetThrew instanceof CertifiedBudgetExceededError,
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
  otherThrew instanceof CertifiedProviderError,
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

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
