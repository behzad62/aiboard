import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { buildCertifiedBenchmarkDashboardData } from "../lib/benchmark/metrics";
import { buildBenchmarkRunOutcomes } from "../lib/benchmark/run-outcomes";
import { materializeCertifiedResultSnapshotMetrics } from "../lib/benchmark/certified/result-set-selectors";
import { BenchmarkDecisionDashboard } from "../components/benchmark/results/BenchmarkDecisionDashboard";
import { withCompletedResultSetFixtures } from "./benchmark-result-set-test-fixtures";
import type { BenchmarkAttemptV2 } from "../lib/benchmark/types";

const now = "2026-10-26T12:00:00.000Z";
const fixture = withCompletedResultSetFixtures({
  caseV2: [],
  attemptsV2: Array.from({length:6}, (_, index): BenchmarkAttemptV2 => ({
    id:`attempt-${index}`, runId:"run", caseId:`native-case-${index}`, teamCompositionId:"solo", mode:"certified", track:"toolreliability", harnessProfile:"aiboard-build-single-worker",
    status:"failed_model", startedAt:now, completedAt:now, verifiedQuality:0, jobSuccessScore:0, efficiencyScore:0,
    costUsd:0.1, inputTokens:900000, outputTokens:1000, modelCalls:40, toolCalls:60, durationMs:600000,
    artifactIds:[], traceIds:[], failureIds:[], harnessVersion:"test", promptSetVersion:"test", scoringVersion:"test",
  })),
  verifierResults: [],
  teamCompositions: [{id:"solo", name:"Test model solo", comboHash:"solo", strategy:"solo", roles:[{role:"single", slot:"single", providerId:"test", modelId:"model", displayName:"Test model", temperature:0}]}],
  harnessCertifications: [],
});
for (const attempt of fixture.attemptsV2) attempt.status = "failed_budget";
fixture.resultSets[0].metrics = materializeCertifiedResultSnapshotMetrics(fixture.resultSets[0].id, fixture.attemptsV2, fixture.caseV2)!;

const valid = buildCertifiedBenchmarkDashboardData(fixture);
assert.equal(valid.leaderboard.length, 1, "a complete valid batch of budget failures remains a scored result");
assert.equal(valid.runOutcomes?.[0].ranked, true);
assert.equal(valid.runOutcomes?.[0].failed, 6);

fixture.resultSets[0].status = "failed";
fixture.resultSets[0].failure = {kind:"harness", code:"invalid_harness", message:"Two cases have invalid harness evidence."};
for (const index of [2, 3]) fixture.attemptsV2[index].status = "invalid_harness";
fixture.verifierResults[2].assertionResults = [{id:"runner_pause_reason_missing", label:"Harness invalid", passed:false, weight:1, message:"Runner paused without a structured reason."}];
fixture.verifierResults[3].assertionResults = [{id:"autonomous_pump_error", label:"Harness invalid", passed:false, weight:1, message:"Runner remained paused after bounded recovery."}];
const invalid = buildCertifiedBenchmarkDashboardData(fixture);
assert.equal(invalid.leaderboard.length, 0, "displaying diagnostic outcomes cannot bypass fail-closed publication");
const [row] = invalid.runOutcomes!;
assert.equal(row.recorded, 6);
assert.equal(row.failed, 4);
assert.equal(row.excluded, 2);
assert.equal(row.passed, 0);
assert.equal(row.ranked, false);
assert.match(row.cases[2].reason, /without a structured reason/);
assert.match(row.cases[3].reason, /bounded recovery/);
assert.equal(row.cases[0].inputTokens, 900000);
assert.equal(row.cases[0].costUsd, 0.1);

const markup = renderToStaticMarkup(createElement(BenchmarkDecisionDashboard, {certified:invalid, onRefresh:async()=>{}, setMessage:()=>{}}));
for (const text of ["Recorded benchmark outcomes", "6/6 cases recorded", "4 failed", "2 excluded", "Failed · budget exhausted", "Excluded · harness error", "No published ranking", "without a structured reason"]) assert.ok(markup.includes(text), text);
assert.ok(!markup.includes("Not measured yet"), "a finished invalid run shows its actual outcomes instead of empty verdict cards");

const pending = structuredClone(fixture);
pending.resultSets[0].status = "pending";
pending.attemptsV2 = pending.attemptsV2.slice(0,1);
assert.equal(buildBenchmarkRunOutcomes(pending, new Set())[0].recorded, 1);
assert.equal(buildBenchmarkRunOutcomes(pending, new Set())[0].cases[1].status, "not_recorded");
pending.attemptsV2.push({...pending.attemptsV2[0], id:"other-subject", resultSetId:"another-result"});
assert.equal(buildBenchmarkRunOutcomes(pending, new Set())[0].recorded, 1, "another subject's attempt cannot fill a missing case");
pending.attemptsV2.push({...pending.attemptsV2[0], id:"duplicate"});
assert.equal(buildBenchmarkRunOutcomes(pending, new Set())[0].cases[0].status, "conflicting_records");
pending.verifierResults[0].resultSetId = "another-result";
pending.verifierResults[0].stderrPreview = "must not leak a foreign subject's evidence";
pending.attemptsV2.pop();
assert.equal(buildBenchmarkRunOutcomes(pending, new Set())[0].cases[0].reason, "");
console.log("PASS failed/unpublished outcomes remain visible without ranking invalid batches; partial, duplicate, and foreign evidence controls");
