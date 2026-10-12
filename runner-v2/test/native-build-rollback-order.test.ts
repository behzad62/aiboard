import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { NativeBuildFactory } from "../src/native-build-factory.js";

interface CleanupStack {
  add(stage: string, cleanup: () => void | Promise<void>, closeOnHandle?: boolean): void;
  close(mode: "failure" | "handle"): Promise<void>;
  isComplete(mode: "failure" | "handle"): boolean;
}

// Exercise the private production stack without publishing a product API or
// starting native processes for a deterministic rollback-order regression.
const source = ts.createSourceFile("native-build-factory.ts", readFileSync(
  new URL("../src/native-build-factory.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
const declaration = source.statements.find(node => ts.isClassDeclaration(node) && node.name?.text === "NativeBuildResourceCleanupStack");
assert.ok(declaration);
const CleanupStack = runInNewContext(ts.transpileModule(
  `${declaration.getText(source)}; NativeBuildResourceCleanupStack;`,
  { compilerOptions: { target: ts.ScriptTarget.ES2022 } },
).outputText, { Map, Error, AggregateError }) as { new(): CleanupStack };

test("failed workspace rollback retains its binding and retries before releasing the owner", async () => {
  const stack = new CleanupStack();
  const calls: string[] = [];
  let bindingClosed = false;
  let workspaceFault = true;
  stack.add("execution_host_binding", () => { calls.push("binding"); bindingClosed = true; }, true);
  stack.add("evidence_store", () => { calls.push("independent-store"); });
  stack.add("integration_workspace", () => {
    assert.equal(bindingClosed, false, "workspace Git must retain its exact open binding");
    calls.push("workspace");
    if (workspaceFault) throw new Error("workspace cleanup failed");
  });
  stack.add("process_inspection", () => { calls.push("inspection"); }, true);

  await assert.rejects(stack.close("failure"), /Could not close all native Build/);
  assert.equal(bindingClosed, false);
  assert.equal(stack.isComplete("failure"), false);
  assert.deepEqual(calls, ["workspace", "independent-store"]);
  workspaceFault = false;
  await stack.close("failure");
  assert.deepEqual(calls, ["workspace", "independent-store", "workspace", "binding", "inspection"]);
  assert.equal(stack.isComplete("failure"), true);
  await stack.close("failure");
  assert.equal(calls.length, 5, "completed disposers must not run twice");
});

test("persistent rollback failure preserves factory prerequisites for a later close", async () => {
  const stack = new CleanupStack();
  const closed: string[] = [];
  let workspaceFault = true;
  stack.add("execution_host_binding", () => { closed.push("binding"); }, true);
  stack.add("workspace_manager", () => {
    assert.deepEqual(closed, [], "retry must retain binding and shared factory prerequisites");
    if (workspaceFault) throw new Error("persistent workspace cleanup failure");
  });
  // Use the real factory close and its real incomplete-construction retry loop.
  // The stores/services are finite sentinels; their lifetime is the assertion.
  const factory = Object.create(NativeBuildFactory.prototype) as NativeBuildFactory;
  Object.assign(factory, {
    incompleteConstructionCleanups: new Set([stack]),
    options: { providerConfigs: { close: () => { closed.push("providers"); } } },
    memoryStore: { close: () => { closed.push("memory"); } },
    managedProcesses: { close: async () => { closed.push("managed"); } },
    browserBackend: { closeAll: async () => { closed.push("browser"); } },
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(factory.close(), /Could not close native Build factory resources/);
    assert.deepEqual(closed, []);
    assert.equal(stack.isComplete("failure"), false);
  }
  workspaceFault = false;
  await factory.close();
  assert.deepEqual(closed, ["binding", "memory", "providers", "managed", "browser"]);
  await factory.close();
  assert.equal(closed.length, 5);
});
