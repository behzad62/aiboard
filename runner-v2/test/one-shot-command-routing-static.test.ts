import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const ROOT = join(import.meta.dirname, "..", "src");
const FAMILIES = [
  "process-tools.ts",
  "evidence-tools.ts",
  "final-verification-runtime.ts",
] as const;

test("one-shot command families have no native execution escape route", () => {
  for (const file of FAMILIES) {
    const source = readFileSync(join(ROOT, file), "utf8");
    for (const [label, pattern] of [
      ["child-process import", /node:child_process/],
      ["spawn", /\bspawn\s*\(/],
      ["exec", /\bexec\s*\(/],
      ["taskkill", /taskkill/i],
      ["ambient environment merge", /process\.env/],
      ["direct kill", /\.kill\s*\(/],
    ] as const) {
      assert.equal(pattern.test(source), false, `${file} contains ${label}`);
    }
    assert.match(source, /OneShotCommandExecutor/);
  }
});

test("native factory owns one shared executor graph and injects it into worker and verification", () => {
  const source = readFileSync(join(ROOT, "native-build-factory.ts"), "utf8");
  assert.equal((source.match(/createSubprocessRuntimeKernel\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/createExecutionGrantAuthority\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/createRuntimeBackedOneShotCommandExecutor\s*\(/g) ?? []).length, 1);
  assert.ok((source.match(/execution:\s*commandExecution/g) ?? []).length >= 2);
});
