import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  applyPresetProgressEvent,
  RunProgressList
} from "../components/benchmark/run/RunProgressList";
import { BENCHMARK_PRESETS } from "../lib/benchmark/certified/run-presets";

// The team preset leg (HarnessBench since the presets dropped TeamIQ).
const leg = BENCHMARK_PRESETS.flatMap((preset) => preset.legs).find(
  (candidate) => candidate.mode === "team"
);
assert.ok(leg);

const detail = "Temporary provider failure (HTTP 503); retry 1/5 in 2s.";
const rows = applyPresetProgressEvent([], {
  type: "retry",
  legIndex: 0,
  leg,
  modelId: "openai:retry-visible",
  displayName: "Retry Visible",
  resultSetId: "result-set-retry-visible",
  retry: 1,
  maxRetries: 5,
  delayMs: 2_000,
  detail
});

assert.equal(rows.length, 1);
assert.equal(rows[0]?.status, "running");
assert.equal(rows[0]?.models.length, 1);
assert.equal(rows[0]?.models[0]?.displayName, "Retry Visible");
assert.equal(rows[0]?.models[0]?.detail, detail);

const markup = renderToStaticMarkup(
  <RunProgressList rows={rows} running onCancel={() => {}} />
);
assert.match(markup, /Retry Visible/);
assert.match(markup, /retry 1\/5 in 2s/);
assert.match(markup, /Running/);
console.log("PASS team-preset retry creates and renders a visible running row");

const updated = applyPresetProgressEvent(rows, {
  type: "retry",
  legIndex: 0,
  leg,
  modelId: "openai:retry-visible",
  displayName: "Retry Visible",
  retry: 2,
  maxRetries: 5,
  delayMs: 5_000,
  detail: "Temporary provider failure; retry 2/5 in 5s."
});
assert.equal(updated[0]?.models.length, 1);
assert.match(updated[0]?.models[0]?.detail ?? "", /retry 2\/5/);
console.log(
  "PASS retry progress updates rather than duplicates an existing row"
);
