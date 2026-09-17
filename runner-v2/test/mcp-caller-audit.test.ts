import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import test from "node:test";
import * as ts from "typescript";
import { auditGitFamilySource } from "./support/git-caller-audit.js";

const sourceRoot = fileURLToPath(new URL("../src/", import.meta.url));
const family = ["mcp-tools.ts", "mcp-configuration.ts", "mcp-rpc-peer.ts", "mcp-session-manager.ts", "mcp-agent-lifecycle.ts", "mcp-executable-digest.ts", "execution-host-mcp-transport.ts", "streaming-request-operation.ts"];

test("MCP migrated family has no raw launch, shell, numeric kill or ambient environment fallback", () => {
  assert.deepEqual(family.flatMap((file) => auditGitFamilySource(readFileSync(join(sourceRoot, file), "utf8"), file)), []);
});

for (const [name, source] of [
  ["aliased spawn", 'import { spawn as run } from "node:child_process"; run("server");'],
  ["dynamic shell module", 'const runtime = await import("child_process"); runtime.exec("server");'],
  ["ambient credentials", 'const environment = { ...process.env };'],
  ["numeric cleanup", 'process.kill(pid, "SIGKILL");'],
  ["shell option", 'transport({ shell: true });'],
] as const) test(`MCP family policy rejects ${name} without executing the snippet`, () => {
  assert.ok(auditGitFamilySource(source, "mcp-tools.ts").length > 0);
});

test("MCP host transport cannot mint a model call grant or fabricate an internal actor", () => {
  const source = ts.createSourceFile("transport.ts", readFileSync(join(sourceRoot, "execution-host-mcp-transport.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const findings: string[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "issue") findings.push("grant mint");
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === "role" && ts.isStringLiteral(node.initializer) && node.initializer.text === "runner_internal") findings.push("invented actor");
    ts.forEachChild(node, visit);
  };
  visit(source); assert.deepEqual(findings, []);
});

test("MCP startup catalog contains no live open effect and production factory supplies discovery identity", () => {
  const manager = ts.createSourceFile("manager.ts", readFileSync(join(sourceRoot, "mcp-session-manager.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  const definition = manager.statements.find((node): node is ts.ClassDeclaration => ts.isClassDeclaration(node) && node.name?.text === "McpSessionManager")!;
  const start = definition.members.find((node): node is ts.MethodDeclaration => ts.isMethodDeclaration(node) && node.name.getText(manager) === "start")!;
  const effects: string[] = [];
  const inspect = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["open", "launch", "issue"].includes(node.expression.name.text)) effects.push(node.expression.name.text);
    ts.forEachChild(node, inspect);
  };
  inspect(start); assert.deepEqual(effects, []);
  const factory = ts.createSourceFile("factory.ts", readFileSync(join(sourceRoot, "native-build-factory.ts"), "utf8"), ts.ScriptTarget.Latest, true);
  let managers = 0;
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "McpManager") {
      const options = node.arguments?.[0]; assert.ok(options && ts.isObjectLiteralExpression(options));
      const keys = options.properties.map((property) => property.name?.getText(factory));
      for (const required of ["runId", "discovery", "reattest", "transportFactory"]) assert.ok(keys.includes(required), `missing ${required}`);
      managers++;
    }
    ts.forEachChild(node, visit);
  };
  visit(factory); assert.equal(managers, 1);
});

test("MCP worker architect and subagent loops explicitly join their exact agent lifecycle", () => {
  for (const file of ["worker-runtime.ts", "native-architect-runtime.ts", "subagent-tools.ts"]) {
    const parsed = ts.createSourceFile(file, readFileSync(join(sourceRoot, file), "utf8"), ts.ScriptTarget.Latest, true);
    let joined = 0;
    const visit = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "withMcpAgentLifecycle") {
        assert.equal(node.arguments.length, 3); joined++;
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed); assert.equal(joined, 1, file);
  }
  for (const file of readdirSync(sourceRoot).filter((file) => file.endsWith(".ts"))) {
    const parsed = ts.createSourceFile(file, readFileSync(join(sourceRoot, file), "utf8"), ts.ScriptTarget.Latest, true);
    for (const node of parsed.statements) if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier))
      assert.equal(/(?:^|\/)test(?:s)?\//.test(node.moduleSpecifier.text), false, file);
  }
});
