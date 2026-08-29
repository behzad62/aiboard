import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const ROOT = join(import.meta.dirname, "..", "src");
const FAMILIES = [
  "process-tools.ts",
  "evidence-tools.ts",
  "final-verification-runtime.ts",
] as const;

test("one-shot command families have no native execution escape route", () => {
  for (const file of FAMILIES) {
    const source = readFileSync(join(ROOT, file), "utf8");
    const escapes = executableEscapes(source, file);
    assert.deepEqual(escapes, [], `${file} contains executable bypasses: ${escapes.join(", ")}`);
    assert.match(source, /OneShotCommandExecutor/);
  }
});

function executableEscapes(source: string, file: string): string[] {
  const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const escapes: string[] = [];
  const launchNames = new Set(["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"]);
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && /^(?:node:)?child_process$/.test(node.moduleSpecifier.text)) {
      escapes.push("child-process import");
    }
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && launchNames.has(callee.text)) escapes.push(`direct ${callee.text}`);
      if (ts.isPropertyAccessExpression(callee) && (launchNames.has(callee.name.text) || callee.name.text === "kill")) {
        escapes.push(`direct .${callee.name.text}`);
      }
      if (ts.isIdentifier(callee) && ["require", "import"].includes(callee.text) && node.arguments.some((argument) => ts.isStringLiteral(argument) && /^(?:node:)?child_process$/.test(argument.text))) {
        escapes.push("dynamic child-process load");
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "env") {
      escapes.push("ambient process.env");
    }
    if (ts.isStringLiteralLike(node) && /(?:^|[\\/])taskkill(?:\.exe)?$/i.test(node.text)) escapes.push("taskkill");
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return [...new Set(escapes)].sort();
}

test("native factory owns one shared executor graph and injects it into worker and verification", () => {
  const source = readFileSync(join(ROOT, "native-build-factory.ts"), "utf8");
  assert.equal((source.match(/createSubprocessRuntimeKernel\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/createExecutionGrantAuthority\s*\(/g) ?? []).length, 1);
  assert.equal((source.match(/createRuntimeBackedOneShotCommandExecutor\s*\(/g) ?? []).length, 1);
  assert.ok((source.match(/execution:\s*commandExecution/g) ?? []).length >= 2);
});
