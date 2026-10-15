import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";
import { withInspectionFixture } from "./support/inspection-fixture.js";
const names: readonly string[] = [
  "Windows portable supervisor preserves historical proof without traversing a PID replacement",
  "Windows portable supervisor rejects a child edge whose birth predates its exact parent",
  "Windows supervisor treats unavailable CIM inspection as unknown and ignores destructive control",
  "Windows supervisor watchdog terminates a hung CIM inspector and reaches durable unknown",
  "Windows portable startup retries an exact birth inspection with an adaptive bounded budget",
  "Windows supervisor adapts its default inventory attempt budget to a slower host",
  "Windows destructive control bounds a hung fresh inspector and never signals under uncertainty",
  "Windows destructive control bounds taskkill and treats timeout as durable uncertainty",
  "Windows supervisor reattests exact live members before a higher-sequence force retry",
  "Windows supervisor rejects successful empty CIM inventory as consecutive uncertainty",
  "Windows native supervisor owns a surviving descendant after launcher exit",
  "optional Windows Job adapter terminates and verifies a TERM-ignoring descendant tree",
  "Windows Job producer pauses at the retained chunk and byte window until exact acknowledgement",
  "Windows Job coalesced read acknowledges every exact retained chunk boundary through its end",
  "Windows Job signal reports exact empty while retained output drains and exits after acknowledgement"
];
function actualBody(file: string, name: string, scope: Record<string, unknown>): Promise<void> {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  let block: ts.Block | undefined;
  let inspectionInput: ts.ObjectLiteralExpression | undefined;
  for (const statement of tree.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "test" || !call.arguments[0] || !ts.isStringLiteral(call.arguments[0]) || call.arguments[0].text !== name) continue;
    const fn = call.arguments.find((argument) => ts.isArrowFunction(argument));
    if (!fn || !ts.isArrowFunction(fn) || !ts.isBlock(fn.body)) continue;
    const inspect = (node: ts.Node) => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "withInspectionFixture") {
        assert.ok(node.arguments.length === 1 && ts.isObjectLiteralExpression(node.arguments[0]!), "actual inspection fixture must retain its explicit creator callbacks");
        assert.equal(inspectionInput, undefined, "the named fixture must have one inspection owner");
        inspectionInput = node.arguments[0] as ts.ObjectLiteralExpression;
      }
      if (ts.isTryStatement(node) && node.finallyBlock && node.finallyBlock.getText(tree).includes("root")) block = node.finallyBlock;
      ts.forEachChild(node, inspect);
    };
    inspect(fn.body);
  }
  assert.ok(block || inspectionInput, "the named actual fixture cleanup body must exist");
  // Run the actual creator registration/cleanup/certification/removal callbacks,
  // replacing only the native body with the controlled primary outcome.
  const execution = inspectionInput
    ? `return withInspectionFixture({ ...${inspectionInput.getText(tree)}, body: async () => { if (hasPrimaryFailure) throw primaryFailure; } });`
    : `async function execute() ${block!.getText(tree)}\nreturn execute();`;
  const compiled = ts.transpileModule(execution, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  return new Function(...Object.keys(scope), compiled)(...Object.values(scope)) as Promise<void>;
}
for (const name of [...names, "two real concurrent run bindings cannot cross grants outputs or cleanup effects"]) {
  for (const scenario of ["success", "primary-undefined", "cleanup-error"] as const) {
    test(`C closure actual finalizer ${name}: ${scenario}`, async () => {
      let signals = 0; let removals = 0; let closes = 0;
      let inspectionCloses = 0; const cleanupOrder: string[] = [];
      const error = new Error("controlled exact-owner failure");
      const close = async () => { closes++; cleanupOrder.push("workload"); if (scenario === "cleanup-error") throw error; };
      const scope = { assert, Buffer, join, finalizeCertifiedFixture, withInspectionFixture,
        root: "synthetic-root", stateDirectory: "synthetic-state", directory: "synthetic-directory",
        hasPrimaryFailure: scenario === "primary-undefined", primaryFailure: undefined,
        cleanupReleased: false, containedOwner: { close },
        child: { pid: 41 }, supervisor: { pid: 41 },
        hostRecord: { supervisor: { supervisorPid: 41 } }, record: { supervisor: { supervisorPid: 41 } },
        backend: { signal: close, release: close, verifyEmpty: async () => ({ empty: true }),
          registerInspectionCleanup: (register: (cleanup: (deadline: number) => Promise<void>) => void) => register(async (deadline) => {
            assert.ok(Number.isFinite(deadline), "inspection cleanup retains its explicit deadline");
            inspectionCloses++; cleanupOrder.push("inspection");
          }),
        },
        cleanupWindowsProcessFixture: close, drainAndCleanupWindowsFixture: close,
        binding: {}, fence: { ownerId: "test", fencingToken: 1 }, takeoverFence: { ownerId: "test2", fencingToken: 2 },
        service: { stopRun: close, close: () => undefined }, host: { close }, fixture: { close: async () => { removals++; } },
        channel: { detach: close }, resume: () => undefined, releaseFirst: () => undefined,
        launch: { opaqueIdentity: Buffer.from(JSON.stringify({ directory: "synthetic-directory", supervisorPid: 41 })).toString("base64url") },
        readFileSync: () => JSON.stringify({ knownProcesses: [{ pid: 42, birth: "fake-observation-only" }] }),
        readdirSync: () => [], existsSync: () => false, rmSync: () => { removals++; cleanupOrder.push("remove"); },
        processIsAlive: () => false, waitForCondition: async () => undefined,
        execFileSync: () => { signals++; }, process: { kill: () => { signals++; } },
        t: { diagnostic: () => undefined },
      };
      const file = name.startsWith("two real") ? "execution-host.test.ts" : "windows-process-backend.test.ts";
      const outcome = await actualBody(file, name, scope).then(() => ({ rejected: false as const }), (reason: unknown) => ({ rejected: true as const, reason }));
      assert.equal(signals, 0, "no raw numeric-PID fallback may replace an owned cleanup capability");
      if (name === "Windows native supervisor owns a surviving descendant after launcher exit") {
        assert.equal(inspectionCloses, scenario === "cleanup-error" ? 0 : 1, "inspection owner retires only after exact workload release certification");
        assert.deepEqual(cleanupOrder, scenario === "cleanup-error" ? ["workload"] : scenario === "success" ? ["workload", "inspection", "remove"] : ["workload", "inspection"]);
      }
      if (scenario === "success") { assert.equal(outcome.rejected, false); assert.equal(removals, 1); assert.ok(closes > 0); }
      else {
        assert.equal(outcome.rejected, true, "failed or uncertain cleanup cannot become a passing fixture");
        assert.equal(removals, 0, "failed assertions and failed owners retain their exact evidence");
        if (outcome.rejected && scenario === "primary-undefined") assert.equal(outcome.reason, undefined);
        if (outcome.rejected && scenario === "cleanup-error") {
          const contains = (value: unknown): boolean => value === error || value instanceof AggregateError && value.errors.some(contains);
          assert.ok(contains(outcome.reason), "retain the original cleanup cause");
        }
      }
    });
  }
}
