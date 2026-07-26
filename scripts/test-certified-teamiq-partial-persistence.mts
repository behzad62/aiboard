/* Certified TeamIQ partial-persistence checks
 * (run: npx tsx scripts/test-certified-teamiq-partial-persistence.mts)
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
  STATEFUL_REFERENCE_TRANSCRIPTS,
  TOOL_RELIABILITY_CASES,
} from "../lib/benchmark/toolreliability";
import { runCertifiedTeamIq } from "../lib/benchmark/teamiq";
import type {
  BenchmarkCaseV2,
  BenchmarkTeamComposition,
} from "../lib/benchmark/types";
import type { StreamChunk } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const now = "2026-07-26T00:00:00.000Z";
const benchmarkCase: BenchmarkCaseV2 = {
  id: "teamiq-partial-persistence-case",
  schemaVersion: 2,
  track: "teamiq",
  title: "TeamIQ partial persistence",
  description: "One-case Tool Reliability task for TeamIQ persistence coverage.",
  difficulty: "easy",
  tags: ["teamiq", "partial-persistence"],
  caseVersion: "1.0.0",
  createdAt: now,
  updatedAt: now,
  prompt: {
    userRequest: "Complete the Tool Reliability case.",
  },
  environment: {
    type: "browser",
    timeoutSeconds: 30,
    network: "none",
  },
  verifier: {
    scorer: "rule-checker",
  },
  budget: {
    maxUsd: 1,
    maxModelCalls: 20,
  },
  scoring: {
    scoringVersion: "teamiq-toolreliability-v2",
    primary: "team_lift",
  },
  contamination: {
    originalTask: true,
    canary: "AIBENCH-TEAMIQ-PARTIAL-PERSISTENCE",
    referenceSolutionPrivate: true,
  },
};

function singleModelTeam(input: {
  id: string;
  providerId: string;
  modelId: string;
  displayName: string;
}): BenchmarkTeamComposition {
  return {
    id: input.id,
    name: input.displayName,
    comboHash: `combo:${input.id}`,
    strategy: "solo",
    roles: [
      {
        role: "single",
        slot: "single",
        providerId: input.providerId,
        modelId: input.modelId,
        displayName: input.displayName,
        reasoningEffort: "none",
        temperature: 0,
      },
    ],
  };
}

const firstTeam = singleModelTeam({
  id: "teamiq-partial-first",
  providerId: "first-provider",
  modelId: "first-provider:first-model",
  displayName: "First Team",
});
const secondTeam = singleModelTeam({
  id: "teamiq-partial-second",
  providerId: "second-provider",
  modelId: "second-provider:second-model",
  displayName: "Second Team",
});
const toolCase = TOOL_RELIABILITY_CASES.find(
  (candidate) => candidate.kind === "write-scope"
)!;

function turnIndex(prompt: string): number {
  return (prompt.match(/Turn \d+ - you replied:/g) ?? []).length;
}

__resetBenchmarkStoreForTests();
await saveBenchmarkCaseV2(benchmarkCase);
await saveBenchmarkTeamComposition(firstTeam);
await saveBenchmarkTeamComposition(secondTeam);

await runCertifiedBenchmark({
  runId: "run-certified-teamiq-partial-persistence",
  suiteId: "suite-certified-teamiq",
  track: "teamiq",
  harnessProfile: "raw-single-model",
  caseIds: [benchmarkCase.id],
  teamCompositionIds: [firstTeam.id, secondTeam.id],
  certification: runHarnessCertification("raw-single-model"),
  runner: (context) =>
    runCertifiedTeamIq({
      context,
      teamCompositions: [firstTeam, secondTeam],
      task: {
        kind: "toolreliability",
        casePack: [toolCase],
      },
      includeSoloBaselines: false,
      pricing: null,
      streamChat: async function* ({
        providerId,
        params,
      }): AsyncIterable<StreamChunk> {
        if (providerId === secondTeam.roles[0].providerId) {
          throw new Error(
            "Wall-clock budget exceeded in simulated later composition."
          );
        }
        const prompt = params.messages
          .map((message) => message.content)
          .join("\n");
        const content =
          STATEFUL_REFERENCE_TRANSCRIPTS[toolCase.id]?.[turnIndex(prompt)] ??
          "done";
        yield { type: "token", content };
        yield { type: "done" };
      },
    }),
});

const attempts = await listBenchmarkAttemptsV2();
const completed = attempts.find(
  (attempt) => attempt.teamCompositionId === firstTeam.id
);
const failed = attempts.find(
  (attempt) => attempt.teamCompositionId === secondTeam.id
);

check(
  "first TeamIQ composition survives a later failure",
  completed?.status === "passed"
);
check(
  "only the missing TeamIQ composition is synthesized as failed",
  failed?.status === "failed_budget" && attempts.length === 2,
  attempts
);
check(
  "completed TeamIQ attempt is not recorded twice",
  attempts.filter((attempt) => attempt.id === completed?.id).length === 1
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
