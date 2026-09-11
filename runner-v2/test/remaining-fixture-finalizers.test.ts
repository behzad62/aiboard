import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const fixtures = [
  ["lsp-client.test.ts", "LSP client bounds a stalled Windows Job-host bootstrap without an unhandled rejection"],
  ["lsp-client.test.ts", "LSP client retries termination after a failed close while the server remains live"],
  ["lsp-client.test.ts", "LSP client shutdown owns and terminates language-server descendants"],
  ["managed-process.test.ts", "supervisor startup timeout aborts and reaps a late supervisor deterministically"],
  ["managed-process.test.ts", "controlled stop terminates a descendant after its launcher exits"],
  ["runner-internal-execution-context.test.ts", "MCP discovery verifies descendant cleanup before reporting cleanupVerified"],
] as const;

function executeActualFinalizer(file: string, name: string, scope: Record<string, unknown>) {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let block: ts.Block | undefined;
  for (const statement of tree.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "test" || !call.arguments[0] || !ts.isStringLiteral(call.arguments[0]) || call.arguments[0].text !== name) continue;
    const fn = call.arguments.find((argument) => ts.isArrowFunction(argument));
    if (!fn || !ts.isArrowFunction(fn) || !ts.isBlock(fn.body)) continue;
    for (const node of fn.body.statements) if (ts.isTryStatement(node) && node.finallyBlock) block = node.finallyBlock;
  }
  assert.ok(block, "execute the named test's real outer finalizer, not a copy of its behavior");
  const body = ts.transpileModule(`async function execute() ${block.getText(tree)}\nreturn execute();`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(scope), body)(...Object.values(scope)) as Promise<void>;
}

for (const [file, name] of fixtures) {
  for (const scenario of ["success", "primary-undefined", "cleanup-error", "unknown-observation"] as const) {
    test(`C closure remaining finalizer ${name}: ${scenario}`, async () => {
      let removals = 0; let rawSignals = 0;
      const cleanupFailure = new Error("controlled retained-owner failure");
      const close = () => { if (scenario === "cleanup-error") throw cleanupFailure; };
      const processState = { kill: (_pid: number, signal: number | string) => {
        if (signal !== 0) { rawSignals++; return true; }
        throw Object.assign(new Error("controlled observation"), { code: scenario === "unknown-observation" ? "EPERM" : "ESRCH" });
      }, removeListener: () => undefined };
      const scope = { assert, join, finalizeCertifiedFixture,
        root: "synthetic-root", state: "synthetic-state", marker: "marker", pidMarker: "marker", descendantMarker: "marker",
        hostPid: 42, pid: 42, supervisorPid: 42, descendantPid: 42,
        hasPrimaryFailure: scenario === "primary-undefined", primaryFailure: undefined,
        client: { close: async () => close(), stats: () => ({ state: "closed" }) },
        context: { close: async () => close() }, service: { close, stopRun: async () => close() },
        firstService: { close: () => undefined },
        ManagedProcessService: class { close() {} async stopRun() { close(); } listRun() { return [{ status: "stopped" }]; } },
        fixture: { root: "synthetic-root", close: async () => { removals++; } },
        process: processState, onUnhandled: () => undefined,
        processExists: () => false, isPidAlive: () => false, isProcessAlive: () => false,
        waitFor: async () => undefined, waitForPidExit: async () => undefined, waitUntilGone: async () => undefined,
        completesBefore: async (value: Promise<unknown>) => await value,
        existsSync: () => true,
        readFile: async () => "42",
        readFileSync: (path: string) => path.endsWith("timeout.json") ? JSON.stringify({ supervisor: { supervisorPid: 42 }, status: "stopped" }) : "42",
        readdirSync: () => [], rm: async () => { removals++; }, rmSync: () => { removals++; },
        t: { diagnostic: () => undefined },
      };
      const result = await executeActualFinalizer(file, name, scope).then(() => ({ rejected: false as const }), (reason: unknown) => ({ rejected: true as const, reason }));
      assert.equal(rawSignals, 0, "never replace retained cleanup authority with numeric PID control");
      if (scenario === "success") { assert.equal(result.rejected, false); assert.equal(removals, 1); }
      else {
        assert.equal(result.rejected, true); assert.equal(removals, 0, "primary or cleanup uncertainty must retain evidence");
        if (result.rejected && scenario === "primary-undefined") assert.equal(result.reason, undefined);
        if (result.rejected && scenario === "cleanup-error") {
          const contains = (error: unknown): boolean => error === cleanupFailure || error instanceof AggregateError && error.errors.some(contains);
          assert.ok(contains(result.reason));
        }
      }
    });
  }
}
