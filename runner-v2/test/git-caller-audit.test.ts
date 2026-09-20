import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import * as ts from "typescript";
import { auditGitFamilySource, GIT_FAMILY_MODULES } from "./support/git-caller-audit.js";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
test("migrated Git execution paths have no raw launch ambient environment or stateless compatibility fallback", () => {
  const failures = GIT_FAMILY_MODULES.flatMap((file) => auditGitFamilySource(readFileSync(join(sourceRoot, file), "utf8"), file));
  assert.deepEqual(failures, []);
  const wrappers = ts.createSourceFile("git-command.ts", readFileSync(join(sourceRoot, "git-command.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  for (const name of ["runGit", "runGitBytes"]) {
    const declaration = wrappers.statements.find((item): item is ts.FunctionDeclaration => ts.isFunctionDeclaration(item) && item.name?.text === name)!;
    assert.equal(declaration.parameters.length, 2);
    assert.equal(declaration.parameters[1]!.initializer, undefined);
    assert.equal(declaration.parameters[1]!.questionToken, undefined);
  }
});

for (const [label, code] of [
  ["aliased spawn", 'import { spawn as start } from "node:child_process"; start("git");'],
  ["namespace exec", 'import * as processApi from "child_process"; processApi.execFile("git");'],
  ["dynamic import", 'const api = await import("node:child_process"); api.fork("git");'],
  ["require destructuring", 'const { execFile: run } = require("child_process"); run("git");'],
  ["ambient merge", 'const environment = { ...process.env };'],
  ["indexed ambient", 'const environment = process["env"];'],
  ["numeric signal", 'process.kill(42);'],
  ["child handle kill", 'child.kill("SIGTERM");'],
  ["shell execution", 'executor({ shell: true });'],
  ["PowerShell launcher", 'executor({ executable: "powershell.exe" });'],
] as const) test(`Git family audit rejects ${label} without executing it`, () => {
  assert.ok(auditGitFamilySource(code, "git-command.ts").length > 0);
});

test("Git audit does not confuse documentation strings with process effects", () => {
  assert.deepEqual(auditGitFamilySource('const description = "process.env and child.kill are forbidden"; // spawn("git")\nexport { description };', "git-command.ts"), []);
});

test("every active production Git owner is explicitly composed and no test adapter is product-reachable", () => {
  for (const file of readdirSync(sourceRoot).filter((file) => file.endsWith(".ts"))) {
    const text = readFileSync(join(sourceRoot, file), "utf8");
    const parsed = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    for (const item of parsed.statements) {
      if (ts.isImportDeclaration(item) && ts.isStringLiteral(item.moduleSpecifier))
        assert.equal(/(?:^|\/)test(?:s)?\//.test(item.moduleSpecifier.text), false, file);
    }
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && ["runGit", "runGitBytes"].includes(node.expression.text))
        assert.ok(node.arguments.length >= 2, `${file}: missing explicit compatibility runner`);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "createGitTools")
        assert.equal(node.arguments.length, 1, `${file}: missing exact Git tool context`);
      if (file === "native-build-factory.ts" && ts.isNewExpression(node) && ts.isIdentifier(node.expression) &&
          ["WorkspaceManager", "IntegrationManager", "VerificationWorkspaceManager", "FinalVerificationDiagnosticsArchive"].includes(node.expression.text)) {
        const argument = node.arguments?.[0]; assert.ok(argument && ts.isObjectLiteralExpression(argument));
        assert.ok(argument.properties.some((property) => property.name?.getText(parsed) === "execute"), `${file}: ${node.expression.text} lacks its owner`);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
});


test("the non-Git package resolver scope is not a blanket ambient-environment exemption", () => {
  assert.deepEqual(auditGitFamilySource('function npmInvocation() { return process.env.npm_execpath; }', "final-verification-profile.ts"), []);
  assert.ok(auditGitFamilySource('function npmInvocation() { return { ...process.env }; }', "final-verification-profile.ts").length > 0);
  assert.ok(auditGitFamilySource('function npmInvocation() { return process.env.SECRET; }', "final-verification-profile.ts").length > 0);
  assert.ok(auditGitFamilySource('function gitInvocation() { return process.env.npm_execpath; }', "final-verification-profile.ts").length > 0);
});
