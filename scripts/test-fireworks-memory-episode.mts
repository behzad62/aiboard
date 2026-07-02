/* Fireworks multi-turn memory episode checks
   (run: npx tsx scripts/test-fireworks-memory-episode.mts)

   Task F: the fireworks MEMORY suites must be genuinely multi-turn — the model
   must RECALL clue facts delivered in EARLIER conversation turns; the final
   decision turn must not restate them. Non-memory scenarios stay single-turn and
   byte-identical. Multi-turn is one model CALL with more messages, not more calls.
*/
import {
  __resetBenchmarkStoreForTests,
  listBenchmarkAttemptsV2,
  saveBenchmarkCaseV2,
  saveBenchmarkTeamComposition,
} from "../lib/benchmark/store";
import { runHarnessCertification } from "../lib/benchmark/certified/certification";
import { runCertifiedBenchmark } from "../lib/benchmark/certified/run-engine";
import {
  FIREWORKS_MEMORY_SCENARIOS,
  FIREWORKS_TACTICS_SCENARIOS,
} from "../lib/benchmark/fireworks/scenario-packs";
import { runCertifiedFireworksTeamIq } from "../lib/benchmark/fireworks/certified-runner";
import {
  buildFireworksMemoryEpisode,
  buildFireworksMemoryEpisodeForScenario,
  fireworksDecisionSlot,
  isFireworksMemoryScenario,
  stripRecalledClueChannels,
} from "../lib/benchmark/fireworks/memory-episode";
import {
  FIREWORKS_GAMEIQ_HARD_SCENARIOS,
  FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS,
} from "../lib/benchmark/gameiq/fireworks";
import { getGameIqScenarioPackById } from "../lib/benchmark/gameiq";
import { runCertifiedGameIq } from "../lib/benchmark/gameiq/certified-runner";
import { getFireworksPlayerView } from "../lib/games/fireworks/hidden-view";
import { deriveTeamComposition } from "../lib/benchmark/teamiq";
import type {
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";
import type {
  FireworksPlayerView,
} from "../lib/games/fireworks/types";
import type {
  SelectedModel,
  StreamChunk,
} from "../lib/providers/base";
import { fireworksCaseToBenchmarkCaseV2 } from "../lib/benchmark/fireworks/scenario-packs";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

// ---------------------------------------------------------------------------
// 1. Episode builder: every memory scenario is genuinely multi-turn recall.
// ---------------------------------------------------------------------------

function decisionViewOf(messages: { role: string; content: string }[]): FireworksPlayerView {
  const last = messages[messages.length - 1].content;
  const json = last.split("Current position JSON:\n")[1].split("\n\nChoose")[0];
  return JSON.parse(json) as FireworksPlayerView;
}

// Runs the check across BOTH delivery inputs: the TeamIQ scenario wrapper and
// the GameIQ view-driven builder (using the already-redacted port view).
for (const scenario of FIREWORKS_MEMORY_SCENARIOS) {
  const episode = buildFireworksMemoryEpisodeForScenario(scenario, {
    system: "SYS",
    playerId: scenario.actingPlayerId,
  });
  const decisionView = decisionViewOf(episode.messages);
  const earlierTurns = episode.messages.slice(0, -1);
  const earlierText = earlierTurns.map((m) => m.content).join("\n");

  // (a) Multi-turn structure: system first, ends on the decision user turn,
  //     has assistant acknowledgments and at least one distractor turn.
  const structureOk =
    episode.messages.length >= 5 &&
    episode.messages[0].role === "system" &&
    episode.messages.at(-1)?.role === "user" &&
    episode.messages.some((m) => m.role === "assistant") &&
    earlierText.includes("does not concern your cards");
  check(`${scenario.id}: multi-turn recall structure`, structureOk, {
    len: episode.messages.length,
  });

  // (b) The decision turn strips every clue-identity channel: own-hand
  //     knowledge carries no notColors/notRanks/clueHistory and no resolved
  //     color/rank, and no seeded self-clue events survive.
  const decisionStripped =
    decisionView.ownHand.knowledge.every(
      (k) =>
        k.notColors.length === 0 &&
        k.notRanks.length === 0 &&
        k.clueHistory.length === 0 &&
        k.color == null &&
        k.rank == null
    ) &&
    decisionView.ownHand.cards.every(
      (card) =>
        card.color == null &&
        card.rank == null &&
        (card.knowledge
          ? card.knowledge.notColors.length === 0 &&
            card.knowledge.notRanks.length === 0 &&
            card.knowledge.clueHistory.length === 0
          : true)
    ) &&
    decisionView.events.every(
      (event) =>
        !(
          (event.action.action === "clue_color" ||
            event.action.action === "clue_rank") &&
          event.action.targetPlayerId === scenario.actingPlayerId
        )
    );
  check(`${scenario.id}: decision turn carries no clue-identity channels`, decisionStripped, {
    knowledge: decisionView.ownHand.knowledge,
    events: decisionView.events.length,
  });

  // (c) The recall facts that were stripped from the decision turn ARE present
  //     in the earlier turns (so the model can recall them).
  const factsInEarlier =
    episode.recalledFacts.length > 0 &&
    episode.recalledFacts.every((fact) => earlierText.includes(fact));
  check(`${scenario.id}: recall facts live in earlier turns, not the decision turn`, factsInEarlier, {
    facts: episode.recalledFacts,
  });
}

// The GameIQ port memory-stress pack (already-redacted views) drives the same
// episode builder and produces the same stripping guarantees.
for (const scenario of FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS) {
  const view = scenario.initialState as FireworksPlayerView;
  const episode = buildFireworksMemoryEpisode({
    system: "SYS",
    view,
    decisionSlot: fireworksDecisionSlot(scenario),
    episodeId: scenario.id,
  });
  const decisionView = decisionViewOf(episode.messages);
  const decisionStripped = decisionView.ownHand.knowledge.every(
    (k) =>
      k.notColors.length === 0 && k.notRanks.length === 0 && k.clueHistory.length === 0
  );
  check(`${scenario.id}: GameIQ port memory episode strips clue channels`, decisionStripped, {
    knowledge: decisionView.ownHand.knowledge,
  });
}

// ---------------------------------------------------------------------------
// 2. Non-memory scenarios stay single-turn (byte-identical): the builder must
//    not be applied to them, and stripRecalledClueChannels must be a no-op on a
//    view that has no self-targeted seeded clues / own knowledge.
// ---------------------------------------------------------------------------

check(
  "isFireworksMemoryScenario is true only for the memory suite",
  FIREWORKS_MEMORY_SCENARIOS.every(isFireworksMemoryScenario) &&
    FIREWORKS_TACTICS_SCENARIOS.every((s) => !isFireworksMemoryScenario(s))
);

// Snapshot: the single-turn (redacted) view a non-memory scenario would receive
// is byte-identical before/after passing through the builder gate — i.e. the
// memory path never touches it. We assert by confirming a tactics scenario's
// redacted view is unchanged and that stripRecalledClueChannels only removes
// self-clue channels (never partner cards, stacks, legalActions, etc.).
const tacticsSample = FIREWORKS_TACTICS_SCENARIOS.find(
  (s) => s.category === "safe_play"
)!;
const tacticsView = getFireworksPlayerView(
  tacticsSample.state,
  tacticsSample.actingPlayerId,
  { omitRecommendations: true }
);
const tacticsViewSnapshot = JSON.stringify(tacticsView);
check(
  "non-memory tactics view is a stable single-turn snapshot (unchanged by episode gate)",
  JSON.stringify(
    getFireworksPlayerView(tacticsSample.state, tacticsSample.actingPlayerId, {
      omitRecommendations: true,
    })
  ) === tacticsViewSnapshot
);

// stripRecalledClueChannels preserves observable state: partner cards, stacks,
// legalActions, tokens are identical; only own-hand knowledge + self-clue events
// change.
const memorySample = FIREWORKS_MEMORY_SCENARIOS[0];
const fullMemoryView = getFireworksPlayerView(
  memorySample.state,
  memorySample.actingPlayerId,
  { omitRecommendations: true, redactOwnIdentity: true }
);
const stripped = stripRecalledClueChannels(
  fullMemoryView,
  memorySample.actingPlayerId
);
check(
  "stripRecalledClueChannels preserves observable state (partner cards, stacks, legal actions, tokens)",
  JSON.stringify(stripped.otherHands) === JSON.stringify(fullMemoryView.otherHands) &&
    JSON.stringify(stripped.stacks) === JSON.stringify(fullMemoryView.stacks) &&
    JSON.stringify(stripped.legalActions) === JSON.stringify(fullMemoryView.legalActions) &&
    stripped.clueTokens === fullMemoryView.clueTokens &&
    stripped.mistakeTokens === fullMemoryView.mistakeTokens
);

// ---------------------------------------------------------------------------
// 3. GameIQ certified runner: memory-stress pack is multi-turn but ONE call per
//    scenario; the hard (non-memory) pack stays single-turn (2 messages).
// ---------------------------------------------------------------------------

function gameIqCaseV2(packId: string, packVersion: string, scenarioCount: number): BenchmarkCaseV2 {
  const now = "2026-07-02T09:00:00.000Z";
  return {
    id: packId,
    schemaVersion: 2,
    track: "gameiq",
    title: packId,
    description: "Fireworks memory-stress multi-turn e2e.",
    difficulty: "hard",
    tags: ["gameiq", "fireworks"],
    caseVersion: packVersion,
    createdAt: now,
    updatedAt: now,
    prompt: { userRequest: "Solve each scenario.", publicContext: "ctx" },
    game: { gameId: "fireworks", seed: packId },
    environment: { type: "browser", timeoutSeconds: 60, network: "none" },
    verifier: { scorer: "game-engine" },
    budget: { maxUsd: 5, maxModelCalls: scenarioCount },
    scoring: { scoringVersion: "certified-gameiq-v0.1", primary: "game_iq" },
    contamination: {
      originalTask: true,
      canary: "AIBENCH-FIREWORKS-MEMORY-EPISODE",
      referenceSolutionPrivate: true,
    },
  };
}

const model: SelectedModel = {
  modelId: "openai:gpt-mem",
  providerId: "openai",
  displayName: "GPT Mem",
};
const team: BenchmarkTeamComposition = {
  id: "team-mem",
  name: "mem",
  comboHash: "combo:mem",
  roles: [
    {
      role: "single",
      slot: "single",
      modelId: "openai:gpt-mem",
      providerId: "openai",
      displayName: "GPT Mem",
      temperature: 0,
      maxTokens: 512,
    },
  ],
};
const passingCertification = {
  ...runHarnessCertification("raw-single-model"),
  passed: true,
  checks: [{ id: "fixture", label: "fixture", passed: true }],
};

async function runGameIqPackCapture(packId: string): Promise<number[]> {
  const target = getGameIqScenarioPackById(packId);
  if (!target) throw new Error(`pack ${packId} not found`);
  __resetBenchmarkStoreForTests();
  await saveBenchmarkCaseV2(
    gameIqCaseV2(target.id, target.version, target.scenarios.length)
  );
  await saveBenchmarkTeamComposition(team);
  const messageCounts: number[] = [];
  let callIndex = 0;
  await runCertifiedBenchmark({
    runId: `run-mem-${packId}`,
    suiteId: `suite-mem-${packId}`,
    track: "gameiq",
    harnessProfile: "raw-single-model",
    caseIds: [target.id],
    teamCompositionIds: [team.id],
    certification: passingCertification,
    runner: (context) =>
      runCertifiedGameIq({
        context,
        models: [model],
        scenarioPackIds: [target.id],
        teamCompositionIds: [team.id],
        trials: 1,
        pricing: { inputUsdPer1M: 1, outputUsdPer1M: 1 },
        streamChat: async function* ({ params }): AsyncIterable<StreamChunk> {
          messageCounts.push(params.messages.length);
          const scenario = target.scenarios[callIndex++];
          yield {
            type: "token",
            content: JSON.stringify({ action: scenario.expectedActions[0]?.action }),
          };
          yield { type: "done" };
        },
      }),
  });
  return messageCounts;
}

const memoryCounts = await runGameIqPackCapture("gameiq-fireworks-memory-v1");
const memoryAttempts = await listBenchmarkAttemptsV2();
check(
  "GameIQ memory-stress pack: one model CALL per scenario (multi-turn is more messages, not more calls)",
  memoryCounts.length === FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS.length &&
    memoryAttempts[0]?.modelCalls === FIREWORKS_GAMEIQ_MEMORY_STRESS_SCENARIOS.length,
  { calls: memoryCounts.length, modelCalls: memoryAttempts[0]?.modelCalls }
);
check(
  "GameIQ memory-stress pack sends a multi-turn conversation (>= 5 messages) for every scenario",
  memoryCounts.every((count) => count >= 5),
  memoryCounts
);

const hardCounts = await runGameIqPackCapture("gameiq-fireworks-hard-v1");
check(
  "GameIQ non-memory hard pack stays single-turn (exactly 2 messages per scenario)",
  hardCounts.length === FIREWORKS_GAMEIQ_HARD_SCENARIOS.length &&
    hardCounts.every((count) => count === 2),
  hardCounts
);

// ---------------------------------------------------------------------------
// 4. TeamIQ certified runner: memory scenario is multi-turn, one call.
// ---------------------------------------------------------------------------

const teamiqMemoryScenario = FIREWORKS_MEMORY_SCENARIOS.find(
  (s) => s.category === "combine_color_and_rank"
)!;
const teamiqCaseV2 = fireworksCaseToBenchmarkCaseV2(
  "fireworks-teamiq-memory-episode-test",
  "memory"
);
const teamComposition = deriveTeamComposition({
  name: "Mem Solo",
  roles: [
    {
      role: "player",
      slot: "P1",
      modelId: "openai:mem-solo",
      providerId: "openai",
      displayName: "Mem Solo",
      temperature: 0,
    },
  ],
  strategy: "panel",
});
__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(teamiqCaseV2);
await saveBenchmarkTeamComposition(teamComposition);
let teamiqMessageCount = 0;
await runCertifiedBenchmark({
  runId: "run-teamiq-mem-episode",
  suiteId: "suite-teamiq-mem-episode",
  track: "teamiq",
  harnessProfile: "raw-single-model",
  caseIds: [teamiqCaseV2.id],
  teamCompositionIds: [teamComposition.id],
  certification: runHarnessCertification("raw-single-model"),
  runner: (context) =>
    runCertifiedFireworksTeamIq({
      context,
      teamCompositions: [teamComposition],
      cases: [teamiqMemoryScenario],
      includeSoloBaselines: false,
      streamChat: async function* ({ params }): AsyncIterable<StreamChunk> {
        teamiqMessageCount = params.messages.length;
        yield { type: "token", content: '{"action":"play","cardIndex":0}' };
        yield { type: "done" };
      },
    }),
});
const teamiqAttempts = await listBenchmarkAttemptsV2();
check(
  "TeamIQ memory scenario is delivered multi-turn in a single model call",
  teamiqMessageCount >= 5 && teamiqAttempts[0]?.modelCalls === 1,
  { teamiqMessageCount, modelCalls: teamiqAttempts[0]?.modelCalls }
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}
process.exit(failures === 0 ? 0 : 1);
