import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildCrewPicker, reviewerDuties } from "../components/build/BuildCrewPicker";
import {
  buildCrewFromDiscussion,
  buildCrewModelIds,
  parseBuildWorkers,
  runtimeModelId,
  selectBuildCrewRuntimes,
  serializeBuildWorkers,
  type BuildCrew,
} from "../lib/client/build-crew";
import { getModelDisplayName } from "../lib/providers/catalog";

// Runtimes: one per (model, effort); a model's second effort gets `model#effort`, the Reviewer is
// reported separately, and every runtime is a verifier candidate behind it.
const crew: BuildCrew = {
  architect: { modelId: "deepseek:flash", reasoningEffort: "high" },
  reviewer: { modelId: "deepseek:flash", reasoningEffort: "medium" },
  workers: [
    { modelId: "deepseek:flash", reasoningEffort: "low" },
    { modelId: "openrouter:mimo", reasoningEffort: "default" },
    { modelId: "deepseek:flash", reasoningEffort: "high" },
  ],
};
const runtimes = selectBuildCrewRuntimes(crew);
assert.deepEqual(runtimes.runtimes.map((runtime) => [runtime.runtimeId, runtime.reasoningEffort]), [
  ["deepseek:flash", "high"],
  ["deepseek:flash#medium", "medium"],
  ["deepseek:flash#low", "low"],
  ["openrouter:mimo", "default"],
]);
assert.equal(runtimes.architectRuntimeId, "deepseek:flash");
assert.equal(runtimes.reviewerRuntimeId, "deepseek:flash#medium");
assert.deepEqual(runtimes.workerRuntimeIds, ["deepseek:flash#low", "openrouter:mimo", "deepseek:flash"]);
assert.deepEqual(runtimes.verifierRuntimeIds, runtimes.runtimes.map((runtime) => runtime.runtimeId));
assert.equal(runtimeModelId("deepseek:flash#medium"), "deepseek:flash");
assert.equal(runtimeModelId("openrouter:mimo"), "openrouter:mimo");
assert.match(getModelDisplayName("deepseek:flash#low"), /· low reasoning$/);
assert.deepEqual(buildCrewModelIds(crew), ["deepseek:flash", "openrouter:mimo"]);

// No workers: the Architect's runtime implements; no reviewer: none is preferred.
const solo = selectBuildCrewRuntimes({ architect: { modelId: "a:x", reasoningEffort: "default" }, reviewer: null, workers: [] });
assert.deepEqual(solo.workerRuntimeIds, ["a:x"]);
assert.equal(solo.reviewerRuntimeId, null);

// Sessions saved before per-role efforts keep their meaning.
const legacy = buildCrewFromDiscussion({
  modelIds: JSON.stringify(["a:arch", "b:rev", "c:w1", "d:w2"]),
  judgeModelId: "a:arch",
  reviewerModelId: "b:rev",
  reasoningEffort: "medium",
  buildReviewerReasoningEffort: "high",
});
assert.deepEqual(legacy, {
  architect: { modelId: "a:arch", reasoningEffort: "medium" },
  reviewer: { modelId: "b:rev", reasoningEffort: "high" },
  workers: [
    { modelId: "c:w1", reasoningEffort: "medium" },
    { modelId: "d:w2", reasoningEffort: "medium" },
  ],
});
const explicit = buildCrewFromDiscussion({
  modelIds: JSON.stringify(["a:arch"]),
  judgeModelId: "a:arch",
  reviewerModelId: "a:arch",
  reasoningEffort: "default",
  buildArchitectReasoningEffort: "max",
  buildWorkers: serializeBuildWorkers([{ modelId: "a:arch", reasoningEffort: "low" }]),
});
assert.deepEqual(explicit?.workers, [{ modelId: "a:arch", reasoningEffort: "low" }]);
assert.equal(explicit?.architect.reasoningEffort, "max");
assert.equal(explicit?.reviewer?.modelId, "a:arch", "the Reviewer may be the Architect's model");
assert.equal(parseBuildWorkers("not json"), null);

// Reviewer duties follow the planning options.
const gated = reviewerDuties({ evidenceGatedPlanning: true, answerReview: true, alwaysRequireIndependentVerifier: false, runPolicy: "finish" });
assert.deepEqual(gated.map((duty) => [duty.step, duty.runs]), [
  ["Requirement coverage", true],
  ["Plan critique", true],
  ["Independent task review", true],
  ["Final integrated verification", true],
  ["Answer review", true],
]);
assert.match(gated[2]!.detail, /Every submitted task is checked/);
assert.match(gated[3]!.detail, /high-risk builds/);
const classic = reviewerDuties({ evidenceGatedPlanning: false, answerReview: true, alwaysRequireIndependentVerifier: true, runPolicy: "finish" });
assert.deepEqual(classic.map((duty) => [duty.step, duty.runs]), [
  ["Plan critique", true],
  ["Independent task review", false],
  ["Final integrated verification", true],
]);
assert.match(classic[0]!.detail, /every executable plan/);
assert.match(classic[1]!.detail, /no mandatory separate task Reviewer/);
assert.match(classic[2]!.detail, /even for low-risk builds/);
const planOnly = reviewerDuties({ evidenceGatedPlanning: false, answerReview: false, alwaysRequireIndependentVerifier: false, runPolicy: "plan_only" });
assert.ok(planOnly.every((duty) => !duty.runs));
const gatedPlanOnly = reviewerDuties({ evidenceGatedPlanning: true, answerReview: false, alwaysRequireIndependentVerifier: true, runPolicy: "plan_only" });
assert.deepEqual(gatedPlanOnly.map((duty) => [duty.step, duty.runs]), [
  ["Requirement coverage", true],
  ["Plan critique", false],
  ["Independent task review", false],
  ["Final integrated verification", false],
]);

// The picker: full guidance on the composer, compact in session settings.
const models = [
  { fullId: "deepseek:flash", name: "DeepSeek Flash" },
  { fullId: "openrouter:mimo", name: "MiMo" },
];
const render = (value: BuildCrew, guidance: "full" | "compact", strict = false) =>
  renderToStaticMarkup(
    <BuildCrewPicker
      models={models}
      value={value}
      onChange={() => undefined}
      guidance={guidance}
      planning={{ evidenceGatedPlanning: true, answerReview: false, alwaysRequireIndependentVerifier: strict, runPolicy: "finish" }}
      probeStatus={(id) => (id === "openrouter:mimo" ? "not_passed" : "passed")}
    />
  );
const full = render(crew, "full");
assert.match(full, /A Build has three roles/);
assert.match(full, /pick your most capable model/);
assert.match(full, /DeepSeek Flash is also the Architect\. It reviews in a fresh session/);
assert.match(full, /DeepSeek Flash is also a worker\. It never reviews its own tasks/);
assert.match(full, /Requirement coverage:/);
assert.match(full, /Independent task review:/);
assert.match(full, /Final integrated verification:/);
assert.match(full, /Which review checks will run/);
assert.match(full, /Every worker is used: each new task goes to the least busy one/);
assert.match(full, /Build probe failed/);
assert.match(full, /Up to 3 tasks run at a time/);
const strict = render(crew, "full", true);
assert.match(strict, /reviews go to a different model in this build whenever one is available/);
const compact = render({ ...crew, workers: [] }, "compact");
assert.doesNotMatch(compact, /A Build has three roles/);
assert.match(compact, /No workers: the Architect&#x27;s model \(DeepSeek Flash, high reasoning\) implements the tasks itself\./);

console.log("build crew: PASS");
