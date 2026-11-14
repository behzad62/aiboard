/**
 * VF9 (VD-5): this repository's own aiboard-validation.json, read with the Runner's own reader and
 * parser, and every mandatory check's tools found with the lookup the final check and the
 * pre-planning inventory share. Also parses the example in docs/runner-v2/guide.md, so the guide
 * cannot show a file the Runner refuses. In memory: no process is started. Required PR CI runs this
 * file (Portable contract job).
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCheckToolLookup, mandatoryProjectCheckTools } from "../src/check-tool-lookup.js";
import { readProjectValidationConfig } from "../src/final-verification-profile.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { parseProjectValidationConfigText } from "../src/project-validation-config.js";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function repositoryConfig() {
  const config = await readProjectValidationConfig(repoRoot);
  assert.ok(config, "aiboard-validation.json is at the repository root");
  return config;
}

test("this repository's aiboard-validation.json is version 2 and makes exactly the VD-5 checks mandatory", async () => {
  const config = await repositoryConfig();
  assert.equal(config.version, 2);
  assert.equal(config.tiers, undefined, "the per-task boundary keeps the Runner's detection");
  const checks = config.checks ?? [];
  const mandatory = checks.filter((check) => check.mandatory).map((check) => [check.id, check.run?.executable, ...(check.run?.args ?? [])]);
  assert.deepEqual(mandatory, [
    ["typecheck-runner-v2", "npm", "run", "typecheck:runner-v2"],
    ["typecheck-web", "npx", "--no", "--", "tsc", "--noEmit"],
    ["lint", "npm", "run", "lint"],
  ]);
  assert.ok(checks.some((check) => !check.mandatory), "targeted test groups are suggested, not mandatory");
  for (const check of checks) {
    assert.ok(check.line !== undefined, `check ${check.id} records its line for a pause`);
    assert.ok(check.run, `check ${check.id} is a run check`);
  }
});

test("this repository's checks never run the full test:runner-v2 suite, and name scripts and test files that exist", async () => {
  const { scripts } = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { scripts: Record<string, string> };
  for (const check of (await repositoryConfig()).checks ?? []) {
    const args = check.run?.args ?? [];
    assert.ok(!args.some((arg) => arg.includes("test:runner-v2")), `check ${check.id} does not run the hours-long suite`);
    assert.ok(!args.some((arg) => arg.includes("*")), `check ${check.id} names its test files`);
    if (check.run?.executable === "npm" && args[0] === "run") {
      assert.ok(scripts[args[1]!], `check ${check.id} runs the package.json script ${args[1]}`);
    }
    for (const file of args.filter((arg) => arg.endsWith(".test.ts"))) {
      assert.ok(existsSync(join(repoRoot, file)), `check ${check.id} names ${file}, which exists`);
    }
    if (check.run?.executable === "npx") {
      assert.deepEqual(args.slice(0, 2), ["--no", "--"], `check ${check.id} never lets npx download a package`);
    }
  }
});

test("every mandatory check's tool resolves with the Runner's own lookup", async () => {
  const lookup = createCheckToolLookup({ environment: () => snapshotNativeBuildAmbientEnvironment() });
  const rows = await mandatoryProjectCheckTools({ checks: (await repositoryConfig()).checks ?? [], workspacePath: repoRoot, lookup });
  assert.deepEqual(rows.map((row) => row.checkId), ["typecheck-runner-v2", "typecheck-web", "lint"]);
  for (const row of rows) {
    assert.ok(row.tools.length > 0, `check ${row.checkId} launches a tool the lookup searches for`);
    assert.deepEqual(row.missing, [], `check ${row.checkId}: ${row.missing.join(", ")} not found on PATH`);
  }
});

test("the aiboard-validation.json example in the Runner guide parses with the Runner's parser", () => {
  const guide = readFileSync(join(repoRoot, "docs", "runner-v2", "guide.md"), "utf8");
  const example = /~~~json\r?\n([\s\S]*?)\r?\n~~~/.exec(guide)?.[1];
  assert.ok(example, "the guide has a ~~~json example");
  const config = parseProjectValidationConfigText(example);
  assert.equal(config.version, 2);
  assert.deepEqual(config.checks?.map((check) => [check.id, check.kind, check.mandatory]), [
    ["typecheck", "build", true],
    ["unit", "tests", false],
    ["serve", "start", false],
  ]);
});
