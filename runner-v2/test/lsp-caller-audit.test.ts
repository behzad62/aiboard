import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import * as ts from "typescript";
import { auditGitFamilySource } from "./support/git-caller-audit.js";

const root = fileURLToPath(new URL("../src/", import.meta.url));
const family = ["lsp-client.ts", "lsp-language-provider.ts", "lsp-transport.ts", "execution-host-lsp-transport.ts", "language-agent-lifecycle.ts", "language-provider-router.ts", "language-server-executable.ts"];
test("LSP migrated family contains no direct launch signal shell or ambient environment fallback", () => {
  assert.deepEqual(family.flatMap((name) => auditGitFamilySource(readFileSync(join(root, name), "utf8"), name)), []);
});
for (const [kind, source] of [
  ["aliased process launch", 'import {spawn as start} from "node:child_process"; start("lsp");'],
  ["dynamic process launch", 'const c=await import("node:child_process"); c.execFile("lsp");'],
  ["numeric cleanup", 'process.kill(id,"SIGKILL");'],
  ["shell fallback", 'launch({shell:true});'],
  ["ambient credentials", 'const e={...process.env};'],
] as const) test(`LSP caller policy rejects ${kind} without executing the source`, () => {
  assert.ok(auditGitFamilySource(source, "lsp-client.ts").length > 0);
});

test("LSP transport never mints a replacement model-call grant or launches through a private bootstrap", () => {
  const file = ts.createSourceFile("lsp-transport.ts", readFileSync(join(root, "execution-host-lsp-transport.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const findings: string[] = []; let sharedOpen = 0;
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      if (node.expression.name.text === "issue") findings.push("invented grant");
      if (node.expression.name.text === "openStreaming") sharedOpen++;
    }
    if (ts.isPropertyAssignment(node) && node.name.getText(file) === "role" && ts.isStringLiteral(node.initializer) && node.initializer.text === "runner_internal") findings.push("invented actor");
    ts.forEachChild(node, visit);
  };
  visit(file); assert.deepEqual(findings, []); assert.equal(sharedOpen, 1);
});

test("LSP worker architect and subagent loops join their language ownership boundary", () => {
  for (const name of ["worker-runtime.ts", "native-architect-runtime.ts", "subagent-tools.ts"]) {
    const file = ts.createSourceFile(name, readFileSync(join(root, name), "utf8"), ts.ScriptTarget.Latest, true);
    let count = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "withLanguageAgentLifecycle") {
        assert.equal(node.arguments.length, 3); count++;
      }
      ts.forEachChild(node, visit);
    };
    visit(file); assert.equal(count, 1, name);
  }
});
