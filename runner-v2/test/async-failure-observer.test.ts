import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import ts from "typescript";
import { observeAsyncFailures } from "./support/async-failure-observer.js";

test("manual failure observer retains the exact rejection without changing promise, receiver or arguments", async () => {
  const error = new Error("original", { cause: new Error("inner") });
  const args = [{ marker: "argument" }];
  const seen: unknown[] = [];
  const settled: unknown[] = [];
  let reject!: (error: unknown) => void;
  const pending = new Promise((_, fail) => { reject = fail; });
  const target = { call(...actual: unknown[]) { assert.equal(this, target); assert.deepEqual(actual, args); return pending; } };
  const descriptor = Object.getOwnPropertyDescriptor(target, "call");
  const restore = observeAsyncFailures(true, [{ target, methods: ["call"], prefix: "host" }], (op, actual, failure) => seen.push([op, actual, failure]), (op, actual, outcome) => settled.push([op, actual, outcome]));
  try {
    assert.equal(target.call(...args), pending);
    reject(error);
    await assert.rejects(pending, actual => actual === error);
    assert.deepEqual(seen, [["host.call", args, error]]);
    assert.deepEqual(settled, [["host.call", args, "rejected"]]);
  } finally { restore(); }
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, "call"), descriptor);
});

test("manual failure observer preserves success and synchronous throws even when recording fails", async () => {
  const value = {}, error = new Error("same sync error");
  const pending = Promise.resolve(value);
  const settled: string[] = [];
  const target = { success: () => pending, sync: () => { throw error; }, fail: () => Promise.reject(error) };
  const restore = observeAsyncFailures(true, [{ target, methods: ["success", "sync", "fail"], prefix: "host" }], () => { throw new Error("observer failed"); }, (op, _args, outcome) => { settled.push(`${op}:${outcome}`); throw new Error("settlement observer failed"); });
  try {
    assert.equal(target.success(), pending); assert.equal(await pending, value);
    assert.throws(() => target.sync(), actual => actual === error);
    await assert.rejects(target.fail(), actual => actual === error);
    assert.deepEqual(settled, ["host.success:fulfilled", "host.sync:rejected", "host.fail:rejected"]);
  } finally { restore(); }
});

test("default scope never reads or replaces target methods", () => {
  const target = new Proxy({}, { getOwnPropertyDescriptor() { throw new Error("must remain untouched"); } });
  observeAsyncFailures(false, [{ target, methods: ["call"], prefix: "host" }], () => assert.fail())();
});

test("observer setup failure restores every previously replaced descriptor", () => {
  const target = { call: () => Promise.resolve() };
  const descriptor = Object.getOwnPropertyDescriptor(target, "call");
  assert.throws(() => observeAsyncFailures(true, [{ target, methods: ["call", "missing"], prefix: "host" }], () => undefined), /missing/);
  assert.deepEqual(Object.getOwnPropertyDescriptor(target, "call"), descriptor);
});

test("actual factory collector preserves bounded exceptions, settlement labels and both failure payloads", async () => {
  const source = readFileSync(new URL("./openrouter-apply-patch-factory.test.ts", import.meta.url), "utf8");
  const start = source.indexOf('const FACTORY_DIAGNOSTIC_SCENARIO =');
  const end = source.indexOf('test("native patch factory');
  assert.ok(start > 0 && end > start);
  class Host {}
  class Backend {}
  const methods = ["launchOwned", "claimOwnedFence", "claimAndAttachOwnedChannel", "reconcileOwned", "readOwnedOutput", "acknowledgeOwnedOutput", "releaseOwned"];
  let failure: Error | undefined;
  for (const method of methods) Object.defineProperty(Host.prototype, method, { configurable: true, writable: true, value: () => failure ? Promise.reject(failure) : Promise.resolve({ privateResult: "not retained" }) });
  Object.defineProperty(Backend.prototype, "observe", { configurable: true, writable: true, value: () => failure ? Promise.reject(failure) : Promise.resolve({ privateResult: "not retained" }) });
  const before = Object.getOwnPropertyDescriptors(Host.prototype);
  const builtins = { spawnSync: () => assert.fail("no native calls"), execFileSync: () => assert.fail("no native calls") };
  const context = vm.createContext({ Buffer, Error, Promise, Set, Object, Date, JSON, Math, Number, String, Array,
    observeAsyncFailures, AuthenticatedWindowsJobProcessHost: Host, WindowsJobObjectProcessBackend: Backend,
    childProcessBuiltin: builtins, childProcessObserverNamespace: builtins, syncBuiltinESMExports: () => undefined,
    process: { env: { RUNNER_V2_FACTORY_PROBE_OBSERVER: "1" }, cwd: () => "synthetic" },
    existsSync: () => true, join });
  vm.runInContext(ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext } }).outputText, context);
  vm.runInContext("var collector = createFactoryProbeObserverState(); installFactoryProbeObserverWrappers(collector);", context);
  const host = new Host() as Host & { reconcileOwned(id: string): Promise<unknown>; readOwnedOutput(id: string): Promise<unknown> };
  const backend = new Backend() as Backend & { observe(binding: unknown): Promise<unknown> };
  const id = "process_06cce908-b7a3-4cf7-b4ea-c4dfd8a86cb4";
  try {
    for (let index = 0; index < 20; index++) {
      failure = Object.assign(new Error(`${index}:` + "failure".repeat(1000), { cause: new Error("original cause") }), { code: "original_code" });
      await assert.rejects(host.reconcileOwned(id), actual => actual === failure);
    }
    failure = new Error("backend rejected");
    await assert.rejects(backend.observe({ opaqueIdentity: Buffer.from(JSON.stringify({ processId: id, privateField: "not retained" })).toString("base64url") }), actual => actual === failure);
    failure = undefined;
    await backend.observe({ opaqueIdentity: Buffer.from(JSON.stringify({ processId: id })).toString("base64url") });
    assert.deepEqual(JSON.parse(vm.runInContext("JSON.stringify(readFactoryProbeObserverSnapshot(collector).effectSettlements.at(-1))", context)),
      { operation: "jobBackend.observe", processId: id, outcome: "fulfilled" });
    for (let index = 0; index < 70; index++) await host.readOwnedOutput(id);
    const snapshot = JSON.parse(vm.runInContext("JSON.stringify(readFactoryProbeObserverSnapshot(collector))", context));
    assert.equal(snapshot.droppedEffectFailures, 5);
    assert.equal(snapshot.effectSettlements.length, 64);
    assert.equal(snapshot.droppedEffectSettlements, 28);
    assert.ok(snapshot.effectSettlements.every((entry: { processId: string; outcome: string }) => entry.processId === id && entry.outcome === "fulfilled"));
    for (const phase of ["primary", "post-close"]) {
      context.phase = phase;
      const payload = JSON.parse(vm.runInContext("JSON.stringify(buildFactoryDiagnosticPayload({phase,fixtureRoot:'synthetic',primary:null,hasPrimary:false,teardownErrors:[],probeObserver:readFactoryProbeObserverSnapshot(collector),effectFailures:collector.effectFailures}))", context));
      assert.equal(payload.boundedEffects.length, 16); assert.ok(payload.nodeCount <= 64);
      assert.equal(payload.boundedEffects[0].processId, id);
      assert.equal(payload.boundedEffects[0].operation, "jobHost.reconcileOwned");
      assert.equal(payload.boundedEffects[0].error.code, "original_code");
      assert.equal(payload.boundedEffects[0].error.cause.message, "original cause");
      const bounded = vm.runInContext("toBoundedFactoryDiagnosticJson(buildFactoryDiagnosticPayload({phase,fixtureRoot:'synthetic',primary:null,hasPrimary:false,teardownErrors:[],effectFailures:collector.effectFailures}))", context) as string;
      assert.ok(Buffer.byteLength(bounded) <= 131072);
      assert.equal(JSON.stringify(payload).includes("not retained"), false);
    }
  } finally { vm.runInContext("restoreFactoryProbeObserverWrappers(collector)", context); }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), before);
  // Exercise the actual factory flag, not just the generic wrapper's flag.
  vm.runInContext("process.env = {}; var disabled = createFactoryProbeObserverState(); installFactoryProbeObserverWrappers(disabled);", context);
  assert.deepEqual(Object.getOwnPropertyDescriptors(Host.prototype), before);
  assert.equal(vm.runInContext("readFactoryProbeObserverSnapshot(disabled)", context), null);
});
