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

console.log("PASS build task board UI");
