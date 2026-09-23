import assert from "node:assert/strict";
import { getTrustedBenchRunnerReadiness } from "../lib/client/bench-runner";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { RecoverableJobServiceSummary } from "../components/benchmark/certified/RecoverableJobServiceSummary";
import { WorkBenchRunnerStatus } from "../components/benchmark/workbench/WorkBenchRunnerStatus";
import { WorkBenchAttemptDetail } from "../components/benchmark/workbench/WorkBenchAttemptDetail";
import { createRecoverableJobServiceCasePack } from "../lib/benchmark/workbench/recoverable-job-service/case-pack";
import { createWorkBenchPublicContractArtifact } from "../lib/benchmark/workbench/artifacts";
import { createRecoverableJobServiceCase } from "../lib/benchmark/workbench/recoverable-job-service/case-pack";
import { evaluateBounded, toVerifierResult } from "../benchmarks/recoverable-job-service/private/runtime.mjs";

assert.match(getTrustedBenchRunnerReadiness({
  ok: true, runnerV2: { ready: true },
  rjs: { ready: true, managedBuildSupported: false },
}, createRecoverableJobServiceCase()).error ?? "", /Windows/);

const attemptId = "history/attempt:unicode-Δ";
const benchmarkCase = createRecoverableJobServiceCase();
const diagnostics = await evaluateBounded("globalThis.createService = () => ({})", {
  replayInput: { invalid: true },
});
const verifier = {
  id: `${attemptId}:verifier`,
  attemptId,
  caseId: benchmarkCase.id,
  passed: false,
  score: 0,
  durationMs: 2,
  resultJson: JSON.stringify(toVerifierResult(diagnostics)),
  assertionResults: [],
  artifactIds: [],
};
const contract = createWorkBenchPublicContractArtifact({
  id: `${attemptId}:rjs-public-contract`,
  attemptId,
  case: benchmarkCase,
});

const html = renderToStaticMarkup(
  createElement(RecoverableJobServiceSummary, {
    attemptId,
    verifier,
    artifacts: [contract],
  })
);
assert.match(html, /Recoverable Job Service evidence/);
assert.match(html, new RegExp(String(diagnostics.profile).replace(/[+]/g, "\\+")));
assert.match(html, /Invalid private replay input/);
assert.match(html, /Move ownership before/);
assert.match(html, /Safety unmeasured/);
assert.match(html, /A01/);
assert.match(html, /Variant evidence/);
assert.doesNotMatch(html, /replayInput|replayRecord|authenticationKey|trusted-rjs-replay/i);

const mismatched = {
  ...contract,
  content: contract.content.replace(benchmarkCase.trustedPolicy!.suiteHash, "0".repeat(64)),
};
const rejectedHtml = renderToStaticMarkup(
  createElement(RecoverableJobServiceSummary, {
    attemptId,
    verifier,
    artifacts: [mismatched],
  })
);
assert.match(rejectedHtml, /does not match the recorded verifier identity/i);

const readinessHtml = renderToStaticMarkup(
  createElement(WorkBenchRunnerStatus, {
    idPrefix: "rjs-test",
    url: "http://127.0.0.1:8797",
    token: "secret",
    checking: false,
    workBenchCase: benchmarkCase,
    health: {
      ok: true,
      runnerV2: { ready: true, nodeVersion: "24.18.0" },
      rjs: {
        ready: true,
        nodeVersion: "24.18.0",
        quickjsVersion: "0.32.0",
        contractHash: benchmarkCase.trustedPolicy!.contractHash,
        suiteHash: "0".repeat(64),
        profile: JSON.parse(benchmarkCase.fixtureFiles!["case-meta.json"]).profile,
      },
    },
    onUrlChange() {},
    onTokenChange() {},
    onCheck() {},
  })
);
assert.match(readinessHtml, /suite identity does not match/i);
assert.match(readinessHtml, /href="\/aiboard-rjs-workbench-runner\.zip"/);
assert.match(readinessHtml, /download="aiboard-rjs-workbench-runner\.zip"/);
assert.match(readinessHtml, /Download Recoverable Job Service runner/);
assert.match(readinessHtml, /Node\.js 24\.18\.0/);
assert.match(readinessHtml, /npm ci/);

const uncheckedReadinessHtml = renderToStaticMarkup(
  createElement(WorkBenchRunnerStatus, {
    idPrefix: "rjs-unchecked",
    url: "http://127.0.0.1:8797",
    token: "secret",
    checking: false,
    workBenchCase: benchmarkCase,
    health: null,
    onUrlChange() {},
    onTokenChange() {},
    onCheck() {},
  })
);
assert.match(uncheckedReadinessHtml, /Recoverable Job Service runtime not checked/);

const selectionHtml = renderToStaticMarkup(
  createElement(WorkBenchAttemptDetail, {
    selectedPack: createRecoverableJobServiceCasePack(),
  })
);
for (const expected of [
  /69 mandatory families/,
  /302 variants/,
  /11 model-visible files/,
  /Binary scoring/,
  /120 model calls/,
  /500 tool calls/,
  /3,000,000 input tokens/,
  /200,000 output tokens/,
]) {
  assert.match(selectionHtml, expected);
}

console.log("PASS");
