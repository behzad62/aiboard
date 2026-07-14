import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  ArtifactPanel,
  abbreviateArtifactRevision,
  artifactSourceLabel,
} from "../components/ArtifactPanel";
import { reconcileNativeBuildFiles } from "../lib/client/discussion-live-state";

const integrationSnapshot = {
  source: "integration" as const,
  revision: "1234567890abcdef1234567890abcdef12345678",
  appliedToProject: false,
  omittedFileCount: 2,
  files: [{ path: "src/native.ts", content: "export const native = true;" }],
};

assert.equal(artifactSourceLabel(integrationSnapshot), "Proposed integration");
assert.equal(abbreviateArtifactRevision(integrationSnapshot.revision), "1234567890ab");

const integrationMarkup = renderToStaticMarkup(
  React.createElement(ArtifactPanel, {
    files: integrationSnapshot.files.map((file) => ({ ...file, language: "ts" })),
    snapshot: integrationSnapshot,
  })
);
assert.match(integrationMarkup, /Proposed integration/);
assert.match(integrationMarkup, /1234567890ab/);
assert.match(integrationMarkup, /2 files omitted/);
assert.match(integrationMarkup, /binary, oversized, or outside the snapshot budget/i);

const omittedOnlyMarkup = renderToStaticMarkup(
  React.createElement(ArtifactPanel, {
    files: [],
    snapshot: { ...integrationSnapshot, omittedFileCount: 3 },
  })
);
assert.match(
  omittedOnlyMarkup,
  /<button[^>]*\sdisabled=""[^>]*>.*Download \.zip/s,
  "an omitted-only snapshot cannot offer an empty zip as though files were loaded",
);

const projectSnapshot = {
  source: "project" as const,
  revision: "abcdef1234567890abcdef1234567890abcdef12",
  appliedToProject: true,
  omittedFileCount: 0,
  files: [{ path: "src/applied.ts", content: "export const applied = true;" }],
};
assert.equal(artifactSourceLabel(projectSnapshot), "Applied project");

const firstAttachment = reconcileNativeBuildFiles(null, "run_1", integrationSnapshot);
const refreshedAttachment = reconcileNativeBuildFiles(
  firstAttachment,
  "run_1",
  projectSnapshot,
);
assert.deepEqual(
  refreshedAttachment.snapshot.files.map((file) => file.path),
  ["src/applied.ts"],
  "a new Runner revision replaces the earlier Runner snapshot instead of merging files",
);
assert.notEqual(firstAttachment.key, refreshedAttachment.key);

console.log("PASS native Build files");
