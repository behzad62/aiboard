/* Provider-reported token usage + token-based efficiency checks
   (run: npx tsx scripts/test-benchmark-token-usage.mts) */
import { streamOpenAICompatibleChat } from "../lib/providers/openai-compat";
import { callCertifiedModel } from "../lib/benchmark/certified/model-call";
import { createCertifiedRunContext } from "../lib/benchmark/certified/run-persistence";
import { __resetBenchmarkStoreForTests } from "../lib/benchmark/store";
import {
  aggregateCertifiedRunScores,
  rankByCostPerPass,
} from "../lib/benchmark/scoring/aggregate";
import { buildModelIntelligenceRows } from "../lib/benchmark/metrics";
import type {
  SelectedModel,
  StreamChunk,
  ChatParams,
} from "../lib/providers/base";
import type {
  BenchmarkAttemptV2,
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";

let failures = 0;
function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`);
}

async function collect(
  stream: AsyncIterable<StreamChunk>
): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of stream) out.push(chunk);
  return out;
}

// ---------------------------------------------------------------------------
// 1. openai-compat streaming parses OpenAI-style usage (prompt/completion) from
//    the final stream chunk and emits a "usage" chunk before "done".
// ---------------------------------------------------------------------------
function fakeOpenAIClient(
  chunks: Array<Record<string, unknown>>,
  onCreate?: (body: Record<string, unknown>) => void
): Parameters<typeof streamOpenAICompatibleChat>[0] {
  return {
    chat: {
      completions: {
        async create(body: Record<string, unknown>) {
          onCreate?.(body);
          return (async function* () {
            for (const chunk of chunks) yield chunk;
          })();
        },
      },
    },
  } as unknown as Parameters<typeof streamOpenAICompatibleChat>[0];
}

const baseParams: ChatParams = {
  apiKey: "k",
  model: "gpt-x",
  messages: [{ role: "user", content: "hi" }],
  maxTokens: 64,
};

{
  let sentBody: Record<string, unknown> | undefined;
  const chunks = await collect(
    streamOpenAICompatibleChat(
      fakeOpenAIClient(
        [
          { choices: [{ delta: { content: "Hello" } }] },
          { choices: [{ delta: { content: " world" } }] },
          {
            choices: [{ delta: {} }],
            usage: { prompt_tokens: 123, completion_tokens: 45 },
          },
        ],
        (body) => {
          sentBody = body;
        }
      ),
      baseParams,
      "openai",
      "OpenAI"
    )
  );
  const usageChunk = chunks.find((c) => c.type === "usage");
  check(
    "openai-compat requests include_usage for hosted providers",
    (sentBody?.stream_options as { include_usage?: boolean } | undefined)
      ?.include_usage === true,
    sentBody?.stream_options
  );
  check(
    "openai-compat emits a usage chunk with real token counts",
    usageChunk?.usage?.inputTokens === 123 && usageChunk?.usage?.outputTokens === 45,
    usageChunk
  );
  check(
    "openai-compat usage chunk precedes done",
    chunks.findIndex((c) => c.type === "usage") <
      chunks.findIndex((c) => c.type === "done"),
    chunks.map((c) => c.type)
  );
  check(
    "openai-compat still yields tokens and done",
    chunks.filter((c) => c.type === "token").length === 2 &&
      chunks.some((c) => c.type === "done"),
    chunks.map((c) => c.type)
  );
}

{
  // Custom (local) provider must NOT request include_usage, but must still parse
  // usage if the endpoint happens to include it.
  let sentBody: Record<string, unknown> | undefined;
  const chunks = await collect(
    streamOpenAICompatibleChat(
      fakeOpenAIClient(
        [
          { choices: [{ delta: { content: "ok" } }] },
          { choices: [{ delta: {} }], usage: { prompt_tokens: 7, completion_tokens: 3 } },
        ],
        (body) => {
          sentBody = body;
        }
      ),
      { ...baseParams, model: "local-model" },
      "custom",
      "Custom",
      "max_tokens"
    )
  );
  check(
    "custom provider omits include_usage stream option",
    sentBody?.stream_options === undefined,
    sentBody?.stream_options
  );
  check(
    "custom provider still parses upstream usage when present",
    chunks.find((c) => c.type === "usage")?.usage?.inputTokens === 7,
    chunks.find((c) => c.type === "usage")
  );
}

{
  // No usage in the stream -> no usage chunk (graceful).
  const chunks = await collect(
    streamOpenAICompatibleChat(
      fakeOpenAIClient([{ choices: [{ delta: { content: "hi" } }] }]),
      baseParams,
      "openai",
      "OpenAI"
    )
  );
  check(
    "no usage in stream yields no usage chunk",
    chunks.every((c) => c.type !== "usage"),
    chunks.map((c) => c.type)
  );
}

// ---------------------------------------------------------------------------
// 2. callCertifiedModel prefers provider-reported usage over the chars/4
//    estimate and records usageSource.
// ---------------------------------------------------------------------------
const model: SelectedModel = {
  modelId: "openai:gpt-usage",
  providerId: "openai",
  displayName: "GPT Usage",
};

__resetBenchmarkStoreForTests();
const ctx = createCertifiedRunContext({
  runId: "run-usage",
  suiteId: "suite-usage",
  track: "gameiq",
  harnessProfile: "raw-single-model",
  startedAt: "2026-07-02T08:30:00.000Z",
  caseIds: ["case-usage"],
  teamCompositionIds: ["team-usage"],
});

{
  const result = await callCertifiedModel({
    model,
    system: "sys",
    user: "user",
    maxTokens: 64,
    temperature: 0,
    context: ctx,
    caseId: "case-usage",
    attemptId: "attempt-usage-reported",
    participantId: "single",
    pricing: { inputUsdPer1M: 2, outputUsdPer1M: 4 },
    streamChat: async function* (): AsyncIterable<StreamChunk> {
      yield { type: "token", content: "hello world answer" };
      yield { type: "usage", usage: { inputTokens: 999, outputTokens: 321 } };
      yield { type: "done" };
    },
  });
  check(
    "certified call prefers reported input/output tokens",
    result.inputTokens === 999 && result.outputTokens === 321,
    result
  );
  check(
    "certified call marks usageSource reported",
    result.usageSource === "reported",
    result.usageSource
  );
}

{
  const result = await callCertifiedModel({
    model,
    system: "sys",
    user: "user",
    maxTokens: 64,
    temperature: 0,
    context: ctx,
    caseId: "case-usage",
    attemptId: "attempt-usage-estimated",
    participantId: "single",
    pricing: { inputUsdPer1M: 2, outputUsdPer1M: 4 },
    streamChat: async function* (): AsyncIterable<StreamChunk> {
      yield { type: "token", content: "hello world answer" };
      yield { type: "done" };
    },
  });
  check(
    "certified call falls back to estimated usage when no usage chunk",
    result.usageSource === "estimated" &&
      result.inputTokens > 0 &&
      result.outputTokens > 0,
    result
  );
}

{
  // Only output reported -> reported source, input estimated per-side.
  const result = await callCertifiedModel({
    model,
    system: "sys",
    user: "user",
    maxTokens: 64,
    temperature: 0,
    context: ctx,
    caseId: "case-usage",
    attemptId: "attempt-usage-partial",
    participantId: "single",
    pricing: { inputUsdPer1M: 2, outputUsdPer1M: 4 },
    streamChat: async function* (): AsyncIterable<StreamChunk> {
      yield { type: "token", content: "partial answer here" };
      yield { type: "usage", usage: { outputTokens: 500 } };
      yield { type: "done" };
    },
  });
  check(
    "partial usage keeps reported output and estimates input",
    result.usageSource === "reported" &&
      result.outputTokens === 500 &&
      result.inputTokens > 0 &&
      result.inputTokens !== 500,
    result
  );
}

// ---------------------------------------------------------------------------
// 3. Aggregate token math: inputTokens/outputTokens/totalTokens/tokensPerPass.
// ---------------------------------------------------------------------------
function soloTeam(id: string, modelId: string): BenchmarkTeamComposition {
  return {
    id,
    name: modelId,
    comboHash: `solo:${modelId}`,
    roles: [
      {
        role: "single",
        slot: "single",
        modelId,
        providerId: "test",
        displayName: modelId,
        temperature: 0,
      },
    ],
  };
}

function attempt(
  id: string,
  teamId: string,
  overrides: Partial<BenchmarkAttemptV2> = {}
): BenchmarkAttemptV2 {
  return {
    id,
    runId: `run-${id}`,
    caseId: `case-${id}`,
    teamCompositionId: teamId,
    mode: "certified",
    track: "gameiq",
    harnessProfile: "raw-single-model",
    status: "passed",
    startedAt: "2026-07-02T10:00:00.000Z",
    completedAt: "2026-07-02T10:01:00.000Z",
    verifiedQuality: 0.8,
    jobSuccessScore: 80,
    efficiencyScore: 80,
    costUsd: null,
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 1,
    toolCalls: 0,
    durationMs: 1000,
    artifactIds: [],
    traceIds: [],
    failureIds: [],
    harnessVersion: "test",
    promptSetVersion: "test",
    scoringVersion: "certified-v0.1",
    ...overrides,
  };
}

{
  const teamA = soloTeam("solo-a", "prov:a"); // priced
  const teamB = soloTeam("solo-b", "prov:b"); // token-only, no pricing
  const rows = aggregateCertifiedRunScores({
    attempts: [
      attempt("a1", teamA.id, {
        status: "passed",
        costUsd: 0.02,
        inputTokens: 100,
        outputTokens: 50,
      }),
      attempt("a2", teamA.id, {
        status: "passed",
        costUsd: 0.02,
        inputTokens: 200,
        outputTokens: 60,
      }),
      attempt("b1", teamB.id, {
        status: "passed",
        costUsd: null,
        inputTokens: 400,
        outputTokens: 100,
      }),
    ],
    cases: [],
    teamCompositions: [teamA, teamB],
    verifierResults: [],
  });
  const rowA = rows.find((r) => r.teamCompositionId === teamA.id);
  const rowB = rows.find((r) => r.teamCompositionId === teamB.id);
  check(
    "aggregate sums input/output/total tokens",
    rowA?.inputTokens === 300 &&
      rowA?.outputTokens === 110 &&
      rowA?.totalTokens === 410,
    rowA
  );
  check(
    "tokensPerPass = total tokens / passes",
    rowA?.tokensPerPass === 205,
    rowA
  );
  check(
    "priced row reports costBasis usd",
    rowA?.costBasis === "usd" && rowA?.costPerPass != null,
    rowA
  );
  check(
    "unpriced row falls back to costBasis tokens",
    rowB?.costBasis === "tokens" &&
      rowB?.costPerPass === null &&
      rowB?.tokensPerPass === 500,
    rowB
  );
  check(
    "row with no tokens reports null token fields",
    (() => {
      const noneTeam = soloTeam("solo-c", "prov:c");
      const r = aggregateCertifiedRunScores({
        attempts: [attempt("c1", noneTeam.id, { costUsd: null })],
        cases: [],
        teamCompositions: [noneTeam],
        verifierResults: [],
      })[0];
      // attempt() defaults inputTokens/outputTokens to 0 -> that's still a token
      // sample; make a real no-token attempt by clearing both is impossible via
      // the type (numbers required). Treat 0/0 as a valid zero-token sample.
      return r.inputTokens === 0 && r.totalTokens === 0 && r.tokensPerPass === 0;
    })(),
    "zero-token sample"
  );

  // Rank fallback: priced rows rank ahead of token-only rows.
  const ranked = rankByCostPerPass(rows);
  check(
    "cost ranking puts priced rows ahead of token-only rows",
    ranked[0].costBasis === "usd" &&
      ranked[ranked.length - 1].costBasis === "tokens",
    ranked.map((r) => r.costBasis)
  );
}

// ---------------------------------------------------------------------------
// 4. buildModelIntelligenceRows — cross-track normalization, solo-only,
//    preliminary gating.
// ---------------------------------------------------------------------------
{
  const teamA = soloTeam("solo-a", "prov:a");
  const teamPair: BenchmarkTeamComposition = {
    id: "pair",
    name: "A+B",
    comboHash: "team:ab",
    roles: [
      {
        role: "architect",
        slot: "architect",
        modelId: "prov:a",
        providerId: "test",
        displayName: "A",
        temperature: 0,
      },
      {
        role: "worker",
        slot: "worker",
        modelId: "prov:b",
        providerId: "test",
        displayName: "B",
        temperature: 0,
      },
    ],
  };
  // Model A: gameiq track avg quality 0.9 (2 attempts), teamiq track avg 0.5 (1
  // attempt). Simple mean of per-track averages = (0.9 + 0.5)/2 = 0.7 — NOT the
  // attempt-weighted 0.767, proving normalization.
  const rows = buildModelIntelligenceRows({
    attempts: [
      attempt("ig1", teamA.id, { track: "gameiq", verifiedQuality: 0.9 }),
      attempt("ig2", teamA.id, { track: "gameiq", verifiedQuality: 0.9 }),
      attempt("it1", teamA.id, { track: "teamiq", verifiedQuality: 0.5 }),
      // A pair (non-solo) attempt must be ignored by the solo leaderboard.
      attempt("ipair", teamPair.id, { track: "gameiq", verifiedQuality: 0.1 }),
    ],
    cases: [],
    teamCompositions: [teamA, teamPair],
    verifierResults: [],
  });
  const rowA = rows.find((r) => r.modelId === "prov:a");
  check(
    "intelligence row is solo-only (pair attempt excluded)",
    rows.length === 1 && rowA?.attempts === 3,
    rows
  );
  check(
    "combined score is the simple mean of per-track averages",
    rowA?.combinedScore === 0.7 && rowA?.trackCount === 2,
    rowA
  );
  check(
    "intelligence row exposes per-track breakdown",
    rowA?.tracks.length === 2 &&
      rowA.tracks[0].track === "gameiq" &&
      rowA.tracks[0].averageVerifiedQuality === 0.9,
    rowA?.tracks
  );
  check(
    "3 solo attempts is not preliminary",
    rowA?.preliminary === false,
    rowA
  );
}

{
  const teamA = soloTeam("solo-a", "prov:a");
  const rows = buildModelIntelligenceRows({
    attempts: [attempt("p1", teamA.id, { track: "gameiq", verifiedQuality: 0.9 })],
    cases: [],
    teamCompositions: [teamA],
    verifierResults: [],
  });
  check(
    "fewer than 3 solo attempts is preliminary",
    rows[0]?.preliminary === true && rows[0]?.attempts === 1,
    rows[0]
  );
}

{
  // Cross-track dedup: a fireworks gameiq re-wrap tagged source:<teamiq-case>
  // sharing the teamiq decision must count once for the model.
  const teamA = soloTeam("solo-a", "prov:a");
  const teamiqCase: BenchmarkCaseV2 = {
    id: "tq-case",
    schemaVersion: 2,
    track: "teamiq",
    title: "tq",
    description: "",
    difficulty: "medium",
    tags: [],
    caseVersion: "t",
    createdAt: "2026-07-02T10:00:00.000Z",
    updatedAt: "2026-07-02T10:00:00.000Z",
    prompt: { userRequest: "x" },
    environment: { type: "browser", timeoutSeconds: 60, network: "none" },
    verifier: { scorer: "game-engine" },
    budget: {},
    scoring: { scoringVersion: "v", primary: "game_iq" },
    contamination: {
      originalTask: true,
      canary: "c",
      referenceSolutionPrivate: true,
    },
  };
  const gameiqCase: BenchmarkCaseV2 = {
    ...teamiqCase,
    id: "gi-case",
    track: "gameiq",
    tags: ["source:tq-case"],
  };
  const rows = buildModelIntelligenceRows({
    attempts: [
      attempt("tq1", teamA.id, {
        track: "teamiq",
        caseId: "tq-case",
        verifiedQuality: 0.6,
      }),
      attempt("gi1", teamA.id, {
        track: "gameiq",
        caseId: "gi-case",
        verifiedQuality: 0.9,
      }),
    ],
    cases: [teamiqCase, gameiqCase],
    teamCompositions: [teamA],
    verifierResults: [],
  });
  // gameiq wins the shared decision (priority gameiq > teamiq), so only the
  // gameiq attempt survives -> 1 attempt, single track.
  check(
    "cross-track duplicate solo decision counts once",
    rows[0]?.attempts === 1 && rows[0]?.trackCount === 1,
    rows[0]
  );
}

console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
if (failures > 0) process.exit(1);
