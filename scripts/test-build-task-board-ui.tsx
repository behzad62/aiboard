/* Build task board UI checks (run: npx tsx scripts/test-build-task-board-ui.tsx) */
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { BuildTaskBoard } from "../components/BuildTaskBoard";

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

console.log("PASS build task board UI");
