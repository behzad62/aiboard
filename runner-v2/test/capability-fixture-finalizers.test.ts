import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const fixtures = [
  { file: "native-build-capabilities.test.ts", name: "capability startup retries a failed partial-start disposer until its child exits", owners: 0, lifecycle: "start\nextension:1\nextension:2\n" },
  { file: "native-build-capabilities.test.ts", name: "capability startup retries post-start router-collision cleanup in exact order", owners: 0, lifecycle: "start\nprovider:1\nextension:1\nprovider:2\nextension:2\n" },
  { file: "native-build-capabilities.test.ts", name: "NativeBuildFactory retains a persistently failed pre-handle disposer for a later close", owners: 1, lifecycle: "start\nextension:1\nextension:2\nextension:3\nextension:4\nextension:5\nextension:6\n" },
  { file: "native-build-manager.test.ts", name: "manager close shares failures then retries only the handle that still owns a child", owners: 3, lifecycle: "start\nclose:1\nclose:2\n" },
] as const;

// Execute the ACTUAL named test's outer finalizer, with inert OS boundary
// substitutes. This safely tests old destructive branches without signaling a
// real process. Assertions concern executed behavior, not source-string matches.
function actualFinalizer(file: string, name: string, scope: Record<string, unknown>): Promise<void> {
  const source = readFileSync(new URL(`./${file}`, import.meta.url), "utf8");
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let block: ts.Block | undefined;
  for (const statement of tree.statements) {
    if (!ts.isExpressionStatement(statement) || !ts.isCallExpression(statement.expression)) continue;
    const call = statement.expression;
    if (!ts.isIdentifier(call.expression) || call.expression.text !== "test" || !call.arguments[0] ||
        !ts.isStringLiteral(call.arguments[0]) || call.arguments[0].text !== name) continue;
    const body = call.arguments.find((argument) => ts.isArrowFunction(argument) || ts.isFunctionExpression(argument));
    if (!body || !(ts.isArrowFunction(body) || ts.isFunctionExpression(body)) || !ts.isBlock(body.body)) continue;
    for (const entry of body.body.statements) if (ts.isTryStatement(entry) && entry.finallyBlock) block = entry.finallyBlock;
  }
  assert.ok(block, "the named fixture must expose its actual outer cleanup boundary");
  const compiled = ts.transpileModule(`async function execute() ${block.getText(tree)}\nreturn execute();`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
  const execute = new Function(...Object.keys(scope), compiled) as (...values: unknown[]) => Promise<void>;
  return execute(...Object.values(scope));
}

for (const fixture of fixtures) {
  for (const scenario of ["success", "primary-undefined", "live-child", "unknown-observation", "missing-marker", "pending-execution", "cleanup-failure", "held-cleanup"] as const) {
    if (fixture.owners === 0 && (scenario === "cleanup-failure" || scenario === "held-cleanup")) continue;
    test(`C5 finalizer10 ${fixture.name}: ${scenario}`, async () => {
      let removed = 0; let signals = 0; let closes = 0; let settled = false;
      const cleanupError = new Error("controlled owner-close failure");
      let release!: () => void;
      const pending = new Promise<void>((resolve) => { release = resolve; });
      const close = async () => {
        closes++;
        if (scenario === "held-cleanup") await pending;
        if (scenario === "cleanup-failure") throw cleanupError;
      };
      const root = "synthetic-exact-root";
      const scope = {
        assert, join, finalizeCertifiedFixture,
        root, state: "state", pidPath: "child.pid", extensionState: "extension", failedState: "failed-state", successState: "success-state",
        expectedLifecycle: fixture.lifecycle,
        childPid: scenario === "missing-marker" ? 0 : 42,
        hasPrimaryFailure: scenario === "primary-undefined", primaryFailure: undefined,
        factory: fixture.owners === 1 ? { close } : undefined,
        manager: fixture.owners === 3 ? { close } : undefined,
        failedExtensions: fixture.owners === 3 ? { close } : undefined,
        successExtensions: fixture.owners === 3 ? { close } : undefined,
        fixture: { root, state: "state", cleanup: () => { removed++; } },
        t: { diagnostic: () => undefined },
        process: { kill: (_pid: number, signal: number | string) => {
          if (signal !== 0) { signals++; return true; }
          if (scenario === "live-child") return true;
          throw Object.assign(new Error("controlled process observation"), { code: scenario === "unknown-observation" ? "EPERM" : "ESRCH" });
        } },
        processExists: () => scenario === "live-child",
        processExistsForManagerTest: () => scenario === "live-child",
        existsSync: () => scenario !== "missing-marker",
        readFileSync: (path: string) => path.endsWith("child.pid") ? "42" : path.includes("success-state") ? "start\nclose:1\n" : fixture.lifecycle,
        readdirSync: () => scenario === "pending-execution" ? ["unreleased-exact-copy"] : [],
        rmSync: () => { removed++; },
      };
      const operation = actualFinalizer(fixture.file, fixture.name, scope).then(
        () => { settled = true; return { rejected: false as const }; },
        (reason: unknown) => { settled = true; return { rejected: true as const, reason }; },
      );
      if (scenario === "held-cleanup") {
        try {
          await new Promise<void>((resolve) => setImmediate(resolve));
          assert.equal(settled, false); assert.equal(removed, 0, "owned close must settle before any deletion");
        } finally { release(); }
      }
      const result = await operation;
      assert.equal(signals, 0, "the finalizer must never replace ownership with a numeric PID signal");
      if (scenario === "success" || scenario === "held-cleanup") {
        assert.deepEqual(result, { rejected: false }); assert.equal(removed, 1);
        assert.equal(closes, fixture.owners);
      } else {
        assert.equal(result.rejected, true, "failure or uncertain ownership must remain visible");
        assert.equal(removed, 0, "retain the exact diagnostics instead of deleting uncertainty");
        if (result.rejected && scenario === "primary-undefined") assert.equal(result.reason, undefined);
        if (result.rejected && scenario === "cleanup-failure") {
          assert.ok(result.reason instanceof AggregateError);
          assert.equal(closes, fixture.owners, "one failed owner cannot prevent other retained owners being closed");
          const contains = (value: unknown): boolean => value === cleanupError || value instanceof AggregateError && value.errors.some(contains);
          assert.ok(contains(result.reason), "retain actual cleanup causes");
        }
      }
    });
  }
}
