import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import {
  CertifiedRunPanel,
  HarnessBenchModelPicker,
} from "../components/benchmark/certified/CertifiedRunPanel";
import { ModelChecklist } from "../components/benchmark/run/ModelChecklist";
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
// Custom models declare their own reasoning support (docs/custom-model-reasoning.md):
// the choice stays open up to High, never the provider-specific xhigh/max.
const plainChatSelect =
  checklistMarkup.match(/<select[^>]*aria-label="Reasoning effort for Plain Chat"[\s\S]*?<\/select>/)?.[0] ?? "";
assert.match(plainChatSelect, /<option value="high" selected="">High<\/option>/);
assert.doesNotMatch(plainChatSelect, /disabled=""/);
assert.doesNotMatch(plainChatSelect, /<option value="(xhigh|max)"/);

// A model with no effort setting gets one locked Default choice.
const noEffortMarkup = renderToStaticMarkup(
  <ModelChecklist
    models={[{ modelId: "xai:grok-4-fast-non-reasoning", providerId: "xai", displayName: "Grok Fast" }]}
    selectedModelIds={["xai:grok-4-fast-non-reasoning"]}
    effortByModelId={{ "xai:grok-4-fast-non-reasoning": "high" }}
    onChange={() => undefined}
    onEffortChange={() => undefined}
  />
);
assert.match(
  noEffortMarkup,
  /<select[^>]*aria-label="Reasoning effort for Grok Fast"[^>]*disabled=""[^>]*>[\s\S]*?<option value="default" selected="">Default<\/option>/
);
assert.doesNotMatch(
  noEffortMarkup,
  /aria-label="Reasoning effort for Grok Fast"[\s\S]*?<option value="(none|low|medium|high|xhigh|max)"/
);

const harnessMarkup = renderToStaticMarkup(
  <HarnessBenchModelPicker
    models={models}
    selectedModelIds={[
      "openai:gpt-5.6-terra",
      "custom:plain-chat",
      "openai:gpt-5.6-terra",
    ]}
    effortByModelId={effortByModelId}
    onChange={() => undefined}
    onEffortChange={() => undefined}
  />
);
assert.equal(
  harnessMarkup.match(/aria-label="Reasoning effort for /g)?.length,
  3,
  "every occupied HarnessBench role must render an effort selector"
);
assert.equal(
  harnessMarkup.match(/aria-label="Reasoning effort for GPT-5\.6"/g)
    ?.length,
  2,
  "repeated HarnessBench models must render from the same model-keyed effort"
);
assert.match(harnessMarkup, />Extra high<\/option>/);
assert.doesNotMatch(harnessMarkup, /<option value="(?:solo|architect_worker|architect_worker_reviewer)"/);
assert.match(harnessMarkup, /Reviewer\/Verifier/);

const runMarkup = renderToStaticMarkup(<CertifiedRunPanel onComplete={async () => {}} setMessage={() => {}} />);
assert.match(runMarkup, /Run HarnessBench/);
assert.match(runMarkup, /Configure ToolBench/);
assert.doesNotMatch(runMarkup, /Advanced|integration smoke|experimental suites|Run selected benchmark|Run certified benchmark/);
assert.equal((runMarkup.match(/type="radio"/g) ?? []).length, 2, "Only the two primary benchmarks can be selected.");

console.log("benchmark model effort UI: PASS");
