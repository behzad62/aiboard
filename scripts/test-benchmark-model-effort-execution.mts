import {
  deriveSoloTeamComposition,
  getTeamCompositionModelVariantKeys,
} from "../lib/benchmark/teamiq/compositions";
import { createTeamIqCompositionFromSelection } from "../lib/benchmark/teamiq/ui-selection";
import {
  createWorkBenchTeamComposition,
  teamIqCompositionsForRun,
} from "../lib/benchmark/certified/run-execution";
import { createNativeWorkBenchProviderConfigs } from "../lib/benchmark/workbench/native-runner-adapter";
import { createWorkBenchBuildDiscussion } from "../lib/benchmark/workbench/build-adapter";
import {
  __resetClientStoreForTests,
  upsertProviderKey,
} from "../lib/client/store";
import type { SelectedModel } from "../lib/providers/base";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const models: SelectedModel[] = [
  {
    modelId: "openai:gpt-5.6",
    providerId: "openai",
    displayName: "GPT 5.6",
  },
  {
    modelId: "anthropic:claude-opus-5",
    providerId: "anthropic",
    displayName: "Claude Opus 5",
  },
  {
    modelId: "google:gemini-reviewer",
    providerId: "google",
    displayName: "Gemini Reviewer",
  },
];
const effortByModelId = {
  "openai:gpt-5.6": "xhigh",
  "anthropic:claude-opus-5": "low",
} as const;

const solo = deriveSoloTeamComposition({
  modelId: models[0]!.modelId,
  providerId: models[0]!.providerId,
  displayName: models[0]!.displayName,
  reasoningEffort: effortByModelId["openai:gpt-5.6"],
});
check(
  "solo composition persists xhigh effort",
  solo.roles[0]?.reasoningEffort === "xhigh",
  solo
);
const defaultSolo = deriveSoloTeamComposition({
  modelId: models[1]!.modelId,
  providerId: models[1]!.providerId,
  displayName: models[1]!.displayName,
});
check(
  "solo composition persists explicit normalized default effort",
  defaultSolo.roles[0]?.reasoningEffort === "default",
  defaultSolo
);

const team = createTeamIqCompositionFromSelection({
  models,
  selectedModelIds: models.map((model) => model.modelId),
  strategy: "architect_worker",
  effortByModelId,
});
check(
  "TeamIQ composition persists matching role efforts",
  team.roles.find((role) => role.modelId === "openai:gpt-5.6")
    ?.reasoningEffort === "xhigh" &&
    team.roles.find((role) => role.modelId === "anthropic:claude-opus-5")
      ?.reasoningEffort === "low",
  team.roles
);

const defaultEffortTeam = createTeamIqCompositionFromSelection({
  models,
  selectedModelIds: models.map((model) => model.modelId),
  strategy: "architect_worker",
  effortByModelId: {
    "openai:gpt-5.6": "default",
    "anthropic:claude-opus-5": "low",
  },
});
check(
  "changing only effort changes TeamIQ composition identity",
  team.comboHash !== defaultEffortTeam.comboHash && team.id !== defaultEffortTeam.id,
  {
    xhigh: { comboHash: team.comboHash, id: team.id },
    default: {
      comboHash: defaultEffortTeam.comboHash,
      id: defaultEffortTeam.id,
    },
  }
);
check(
  "team composition variant keys are sorted model and effort keys",
  JSON.stringify(getTeamCompositionModelVariantKeys(team)) ===
    JSON.stringify([
      "anthropic:claude-opus-5\u0000low",
      "openai:gpt-5.6\u0000xhigh",
    ]),
  getTeamCompositionModelVariantKeys(team)
);

const runTeams = teamIqCompositionsForRun({
  models,
  selectedModelIds: models.map((model) => model.modelId),
  strategy: "architect_worker",
  suiteId: "teamiq-toolreliability-current-smoke",
  roleMode: "default",
  playerCount: 2,
  effortByModelId,
});
check(
  "TeamIQ run composition boundary preserves matching efforts",
  runTeams[0]?.roles.map((role) => role.reasoningEffort).join(",") ===
    "xhigh,low",
  runTeams
);

const workBenchTeam = createWorkBenchTeamComposition({
  models: models.slice(0, 2),
  roleMode: "architect_worker",
  effortByModelId,
});
check(
  "WorkBench composition persists matching role efforts",
  workBenchTeam.roles.map((role) => role.reasoningEffort).join(",") ===
    "xhigh,low",
  workBenchTeam.roles
);
const workBenchDiscussion = createWorkBenchBuildDiscussion(
  {
    attemptId: "attempt-effort",
    runId: "run-effort",
    teamCompositionId: workBenchTeam.id,
    harnessProfile: "aiboard-build-multi-worker",
    allowedCommands: [],
    runner: { url: "http://127.0.0.1:8787", token: "test-token" },
    case: {
      id: "case-effort",
      title: "Effort propagation",
      description: "Preserve configured effort",
      prompt: { userRequest: "Test" },
      budget: {},
    },
    teamComposition: workBenchTeam,
    discussion: { reasoningEffort: "default" },
  } as never,
  models
);
check(
  "WorkBench discussion keeps the configured Architect effort over global default",
  workBenchDiscussion.reasoningEffort === "xhigh",
  workBenchDiscussion.reasoningEffort
);

__resetClientStoreForTests();
for (const providerId of ["openai", "anthropic", "google"]) {
  upsertProviderKey({
    providerId,
    apiKey: `test-${providerId}-key`,
    defaultModel: null,
    enabled: true,
    keyHint: null,
  });
}
const providerConfigs = createNativeWorkBenchProviderConfigs(
  workBenchTeam,
  models.slice(0, 2)
);
check(
  "WorkBench native provider configs receive matching role efforts",
  providerConfigs.find((config) => config.runtimeId === "openai:gpt-5.6")
    ?.reasoningEffort === "xhigh" &&
    providerConfigs.find(
      (config) => config.runtimeId === "anthropic:claude-opus-5"
    )?.reasoningEffort === "low",
  providerConfigs
);
const reviewerTeam = createWorkBenchTeamComposition({
  models,
  roleMode: "architect_worker_reviewer",
  effortByModelId,
});
const reviewerProviderConfigs = createNativeWorkBenchProviderConfigs(
  reviewerTeam,
  models
);
check(
  "WorkBench native provider configs include every configured role runtime",
  reviewerProviderConfigs.some(
    (config) => config.runtimeId === "google:gemini-reviewer"
  ),
  reviewerProviderConfigs
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
