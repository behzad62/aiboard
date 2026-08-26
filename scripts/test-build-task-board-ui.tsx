/* Build task board UI checks (run: npx tsx scripts/test-build-task-board-ui.tsx) */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildTaskBoard } from "../components/BuildTaskBoard";
import { FinalVerificationManifest } from "../components/RunnerV2ObservabilityPanel";

const markup = renderToStaticMarkup(
  <BuildTaskBoard
    tasks={[
      {
        id: "T1",
        title: "Implement feature",
        status: "done",
        worker: "Worker A",
        acceptanceCriteria: [{
          id: "behavior",
          text: "The feature works for the requested input.",
          evidence: {
            evidenceId: "evidence_behavior",
            artifactHashes: ["a".repeat(64)],
          },
          verdict: {
            verdict: "satisfied",
            rationale: "The recorded evidence supports the requested behavior.",
            evidenceIds: ["evidence_behavior"],
            artifactHashes: ["a".repeat(64)],
          },
        }],
      },
    ]}
    files={[]}
    commands={[
      {
        command: "npm run lint",
        exitCode: 0,
        durationMs: 1250,
        outputPreview: "lint passed",
      },
    ]}
  />
);

assert.match(markup, /<details class="[^"]*mt-4/);
assert.doesNotMatch(markup, /<details[^>]* open/);
assert.match(markup, /<summary[^>]*>[\s\S]*Commands run \(1\)/);
assert.match(markup, /Click to expand/);
assert.match(markup, /npm run lint/);
assert.match(markup, /The feature works for the requested input\./);
assert.match(markup, /Evidence submitted/);
assert.match(markup, /Architect verdict: Satisfied/);
assert.match(markup, /The recorded evidence supports the requested behavior\./);
assert.match(markup, /Evidence is mechanical; Architect verdict is semantic\./);

const evidenceOnlyMarkup = renderToStaticMarkup(
  <BuildTaskBoard
    tasks={[{
      id: "T2",
      title: "Inspect feature",
      status: "review",
      acceptanceCriteria: [{
        id: "inspection",
        text: "The inspection evidence is recorded.",
        evidence: {
          evidenceId: "evidence_inspection",
          artifactHashes: ["b".repeat(64)],
        },
      }],
    }]}
    files={[]}
  />
);
assert.match(evidenceOnlyMarkup, /Evidence submitted/);
assert.match(evidenceOnlyMarkup, /Architect verdict: Not reviewed/);

const verificationMarkup = renderToStaticMarkup(
  <FinalVerificationManifest verification={{
    canonicalRevision: "abcdef1234567890",
    history: [],
    current: {
      generationId: "generation-3", taskId: "verify-3", targetRevision: "abcdef1234567890", revisionStatus: "current",
      categories: [
        { category: "build", applicability: "required", status: "passed", evidenceIds: ["e1"], issues: [] },
        { category: "tests", applicability: "required", status: "pending", evidenceIds: [], issues: [] },
        { category: "runtime_smoke", applicability: "not_applicable", rationale: "No server", repositoryInspection: { inspectedPaths: ["package.json"], summary: "No server" }, status: "not_applicable", evidenceIds: [], issues: [] },
        { category: "browser", applicability: "required", status: "failed", evidenceIds: ["e2"], issues: ["Console error"] },
      ],
      submission: { status: "pending" }, cleanup: { status: "succeeded", diagnosticsAvailable: true }, review: { status: "pending" }, repairs: [{ taskId: "repair-browser", status: "running" }],
    },
  }} />
);
assert.match(verificationMarkup, /Revision abcdef123456/);
assert.match(verificationMarkup, /Generation generation-3/);
assert.match(verificationMarkup, />Build</);
assert.match(verificationMarkup, />Tests</);
assert.match(verificationMarkup, />Runtime</);
assert.match(verificationMarkup, />Browser</);
assert.match(verificationMarkup, /Diagnostics saved/);
assert.match(verificationMarkup, /Repair required/);
assert.match(verificationMarkup, /Repair in progress/);

const kernelTaskMarkup = renderToStaticMarkup(<BuildTaskBoard tasks={[{
  id: "verify-3", title: "Verify integrated revision", kind: "final_verification", status: "review",
}]} files={[]} />);
assert.match(kernelTaskMarkup, /Final verification/);
assert.match(kernelTaskMarkup, /In review/);

console.log("PASS build task board UI");
