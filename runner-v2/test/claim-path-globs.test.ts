import assert from "node:assert/strict";
import test from "node:test";

import { claimPathContains, claimPathsOverlap } from "../src/task-resource-claims.js";
import { inspectSubmissionScope } from "../src/submission-guard.js";

test("claim surfaces written as globs contain the files they name", () => {
  const cases: Array<[string, string, boolean]> = [
    ["packages/shared/**", "packages/shared/src/ids.ts", true],
    ["packages/shared/**", "packages/shared", true],
    ["packages/shared/**", "packages/relay/src/index.ts", false],
    ["packages/*/package.json", "packages/relay/package.json", true],
    ["packages/*/package.json", "packages/relay/src/package.json", false],
    ["src/**/*.ts", "src/a/b/c.ts", true],
    ["src/**/*.ts", "src/c.ts", true],
    ["src/**/*.ts", "src/c.js", false],
    ["a.b/**", "axb/c", false],
    ["packages", "packages/shared/**", true],
    ["packages/shared/**", "packages/shared/src/**", true],
    ["packages/relay", "packages/shared/**", false],
    ["packages/shared", "packages/shared/src/ids.ts", true],
  ];
  for (const [outer, inner, expected] of cases) assert.equal(claimPathContains(outer, inner), expected, `${outer} ⊇ ${inner}`);
  assert.equal(claimPathsOverlap("packages/*/src/**", "packages/shared/**"), true);
  assert.equal(claimPathsOverlap("packages/relay/**", "packages/shared/**"), false);
});

test("a glob write surface covers its files at submission (tunnel run: 13 false outside_claim findings)", () => {
  const files = ["packages/shared/src/ids.ts", "packages/shared/test/ids.test.ts", "packages/relay/src/index.ts"]
    .map((path) => ({ path, added: true, addedLines: [] }));
  const findings = inspectSubmissionScope(files, { writableSurfaces: ["packages/shared/**"], forbiddenSurfaces: [] });
  assert.deepEqual(findings.map((finding) => [finding.path, finding.code]), [["packages/relay/src/index.ts", "outside_claim"]]);
});
