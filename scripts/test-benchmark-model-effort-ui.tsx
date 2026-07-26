import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AdvancedModelEffortControl,
  WorkBenchTeamBuilder,
} from "../components/benchmark/certified/CertifiedRunPanel";
import { ModelChecklist } from "../components/benchmark/run/ModelChecklist";
import { TeamCompositionBuilder } from "../components/benchmark/teamiq/TeamCompositionBuilder";
import { ReasoningControl } from "../components/ReasoningControl";
import type { SelectedModel } from "../lib/providers/base";

const models: SelectedModel[] = [
  {
    modelId: "openai:gpt-5.6-terra",
    providerId: "openai",
    displayName: "GPT-5.6",
  },
  {
    modelId: "custom:plain-chat",
    providerId: "custom",
    displayName: "Plain Chat",
  },
];
const effortByModelId = {
  "openai:gpt-5.6-terra": "xhigh" as const,
  "custom:plain-chat": "high" as const,
};

const reasoningControlMarkup = renderToStaticMarkup(
  <ReasoningControl value="default" onChange={() => undefined} />
);
assert.match(
  reasoningControlMarkup,
  /grid-cols-2[^"]*sm:grid-cols-3[^"]*lg:grid-cols-4[^"]*xl:grid-cols-7/,
  "the seven effort choices should reflow without a six-column orphan"
);

const checklistMarkup = renderToStaticMarkup(
  <ModelChecklist
    models={models}
    selectedModelIds={models.map((model) => model.modelId)}
    effortByModelId={effortByModelId}
    onChange={() => undefined}
    onEffortChange={() => undefined}
  />
);
assert.match(
  checklistMarkup,
  /<select[^>]*aria-label="Reasoning effort for GPT-5\.6"[^>]*>[\s\S]*?<option value="xhigh" selected="">Extra high<\/option>/
);
assert.match(
  checklistMarkup,
  /<select[^>]*aria-label="Reasoning effort for Plain Chat"[^>]*disabled=""[^>]*>[\s\S]*?<option value="default" selected="">Default<\/option>/
);
assert.doesNotMatch(
  checklistMarkup,
  /aria-label="Reasoning effort for Plain Chat"[\s\S]*?<option value="(low|medium|high|xhigh|max)"/
);

const teamMarkup = renderToStaticMarkup(
  <TeamCompositionBuilder
    models={models}
    selectedModelIds={[
      "openai:gpt-5.6-terra",
      "custom:plain-chat",
      "openai:gpt-5.6-terra",
    ]}
    effortByModelId={effortByModelId}
    strategy="architect_worker_reviewer"
    onChange={() => undefined}
    onEffortChange={() => undefined}
    onStrategyChange={() => undefined}
  />
);
assert.match(teamMarkup, /Reasoning effort for GPT-5\.6/);
assert.match(teamMarkup, />Extra high<\/option>/);
assert.match(
  teamMarkup,
  /aria-label="Reasoning effort for Plain Chat"[^>]*disabled=""/
);

const advancedMarkup = renderToStaticMarkup(
  <AdvancedModelEffortControl
    models={models}
    modelId="openai:gpt-5.6-terra"
    effortByModelId={effortByModelId}
    onEffortChange={() => undefined}
  />
);
assert.match(advancedMarkup, /Reasoning effort for GPT-5\.6/);
assert.match(advancedMarkup, />Extra high<\/option>/);

const workBenchTeamMarkup = renderToStaticMarkup(
  <WorkBenchTeamBuilder
    models={models}
    roleMode="architect_worker_reviewer"
    selectedModelIds={[
      "openai:gpt-5.6-terra",
      "custom:plain-chat",
      "openai:gpt-5.6-terra",
    ]}
    effortByModelId={effortByModelId}
    onRoleModeChange={() => undefined}
    onChange={() => undefined}
    onEffortChange={() => undefined}
  />
);
assert.equal(
  workBenchTeamMarkup.match(/aria-label="Reasoning effort for /g)?.length,
  3,
  "every occupied WorkBench role must render an effort selector"
);
assert.equal(
  workBenchTeamMarkup.match(/aria-label="Reasoning effort for GPT-5\.6"/g)
    ?.length,
  2,
  "repeated WorkBench models must render from the same model-keyed effort"
);
assert.match(workBenchTeamMarkup, />Extra high<\/option>/);

const workBenchSoloMarkup = renderToStaticMarkup(
  <WorkBenchTeamBuilder
    models={models}
    roleMode="solo"
    selectedModelIds={["openai:gpt-5.6-terra"]}
    effortByModelId={effortByModelId}
    onRoleModeChange={() => undefined}
    onChange={() => undefined}
    onEffortChange={() => undefined}
  />
);
assert.match(
  workBenchSoloMarkup,
  /aria-label="Reasoning effort for GPT-5\.6"/,
  "an Advanced WorkBench solo model remains configurable without preset checklist membership"
);
assert.match(workBenchSoloMarkup, />Extra high<\/option>/);

console.log("benchmark model effort UI: PASS");
