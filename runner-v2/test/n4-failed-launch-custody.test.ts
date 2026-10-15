/** New pure controls only: actual source bodies, fake process/owner effects, no native launch. */
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve, join, dirname, basename } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { types as nodeTypes } from "node:util";
import vm from "node:vm";
import ts from "typescript";

const sourceRoot = resolve(import.meta.dirname, "..");
const baselineRoot = process.env.N4_CUSTODY_BASELINE_ROOT;
function readSource(relative: string): string {
  const baseline = baselineRoot && ["src/windows-process-semantic-probes.ts", "test/support/handoff-snapshot-harness.ts"].includes(relative)
    ? join(baselineRoot, basename(relative)) : join(sourceRoot, relative);
  return readFileSync(baseline, "utf8");
}
function bodies(text: string, names: readonly string[]): string {
  const parsed = ts.createSourceFile("actual.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const selected: string[] = [];
  function walk(node: ts.Node): void {
    if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name && names.includes(node.name.text)) selected.push(node.getText(parsed));
    ts.forEachChild(node, walk);
  }
  walk(parsed);
  return selected.join("\n").replaceAll("export ", "");
}
function execute(text: string, bindings: Record<string, unknown>): vm.Context {
  const context = vm.createContext({ Buffer, Date, Promise, AggregateError, Error, Object, JSON, ...bindings });
  const compiled = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
  vm.runInContext(compiled, context);
  return context;
}
function probeControl(overrides: { errorFor?: (context: vm.Context, actual: unknown) => unknown; failedRootRelease?: boolean } = {}) {
  const source = readSource("src/windows-process-semantic-probes.ts");
  const root = resolve("mock-semantic-tree"), workspace = join(root, "workspace"), directory = join(root, "state/owned-exact");
  const observed: string[] = [];
  const identity = { version: 1, backendId: "runner-windows-supervisor-v1", directory, nonce: "test-only-nonce", supervisorPid: 4242,
    supervisorBirth: "2026-10-14T15:16:33.936340Z", fence: { ownerId: "windows-semantic-probe", fencingToken: 1 } };
  const launch = { opaqueIdentity: Buffer.from(JSON.stringify(identity)).toString("base64url"), rootPid: 4242,
    birthFingerprint: { observedAt: identity.supervisorBirth, discriminator: createHash("sha256").update(`${identity.nonce}\0${identity.supervisorBirth}`).digest("hex") }, startedAt: identity.supervisorBirth };
  let primary: unknown;
  const ownerText = readSource("src/inspection-cleanup.ts");
  const parser = readSource("src/process-backend.ts");
  const context = execute([
    bodies(readSource("src/native-process-backend.ts"), ["NativeProcessLaunchBlockedError"]),
    bodies(ownerText, ["InspectionConstructionOwner", "awaitInspectionConstruction"]),
    bodies(parser, ["parseProcessLaunchResult", "record", "keys", "text", "integer", "bad", "freeze"]),
    'const FENCE = Object.freeze({ownerId:"windows-semantic-probe",fencingToken:1}); const PROBE_DEADLINE_MS = 15000;',
    'const WINDOWS_PROBE_ENVIRONMENT_KEYS = Object.freeze(["SystemRoot","windir","ComSpec","Path","PATHEXT","TEMP","TMP"]);',
    bodies(source, ["probeExactTreeBirth", "withPortableProbe", "launchProbeWithCustody", "failedProbeLaunch", "bindingFor", "validProbeOwner", "probeBirthTime", "remainingProbeDeadlineMs", "request", "minimalWindowsSemanticProbeEnvironment"]),
    bodies(readSource("src/process-host-semantic-probes.ts"), ["settle"]),
    "globalThis.runProbe = creator => probeExactTreeBirth(15000,15000,{},creator); globalThis.settleFact = settle; globalThis.failedLaunch = typeof failedProbeLaunch === 'function' ? failedProbeLaunch : undefined; globalThis.launchOwned = typeof launchProbeWithCustody === 'function' ? launchProbeWithCustody : undefined; globalThis.makeProbeRequest=request;",
  ].join("\n"), {
    process: { execPath: "node.exe" }, createHash, randomUUID, nodeTypes, resolve, join, dirname, basename,
    tmpdir: () => dirname(root), mkdtempSync: () => root, mkdirSync: () => undefined, recordTempCreation: () => undefined,
    probeGlobalProcessInventory: () => [],
    removeUnboundSemanticProbeRoot: () => { observed.push("unbound-refused"); return false; },
    removeInactiveSemanticProbeRoot: (_root: string, binding: { rootPid: number }) => { assert.equal(binding.rootPid, 4242); observed.push("exact-owned-fallback"); return overrides.failedRootRelease !== true; },
    rmSync: () => { observed.push("remove"); },
    settleProbeOutput: async () => { observed.push("settle-output"); },
    requireEmptyAndRelease: async () => { observed.push("release-refused"); throw new Error("controlled not-yet-terminal"); },
    setTimeout: () => ({ fake: true }), clearTimeout: () => undefined,
    WindowsProcessBackend: class {
      registerInspectionCleanup(register: (close: () => Promise<void>) => void) { register(async () => { observed.push("inspection-close"); }); }
      async prepareInspection() {}
      async launch() { observed.push("original-launch"); throw primary; }
      async signal(binding: { rootPid: number }, action: string) { assert.equal(binding.rootPid, 4242); assert.equal(action, "force_terminate"); observed.push("original-owner-signal"); }
    },
  });
  const actual = vm.runInContext("new NativeProcessLaunchBlockedError([], " + JSON.stringify(directory) + ", JSON.parse(" + JSON.stringify(JSON.stringify(launch)) + "), 'controlled blocked launch')", context);
  primary = overrides.errorFor ? overrides.errorFor(context, actual) : actual;
  return { context, primary, observed, launch, directory, workspace, request: context.makeProbeRequest(workspace, "node.exe", [], {}) };
}

test("N4 actual API custody: failed native launch preserves primary/unavailable fact and original exact owner cleanup", async () => {
  const f = probeControl();
  const creator = { owners: new Set(), isClosed: () => false };
  const fact = await f.context.settleFact(() => f.context.runProbe(creator));
  assert.equal(fact, "unavailable", "failed launch never upgrades a semantic capability");
  assert.deepEqual(f.observed, ["original-launch", "original-owner-signal", "settle-output", "release-refused", "release-refused", "exact-owned-fallback", "inspection-close", "remove"]);
  assert.equal(creator.owners.size, 0);
  const direct = probeControl();
  await assert.rejects(direct.context.runProbe({ owners: new Set(), isClosed: () => false }), error => error === direct.primary);
});

test("N4 new custody: foreign/accessor/proxy/wrong-scope failures retain unknown owner without invoking authenticated cleanup", async () => {
  let getterCalls = 0;
  const variations: Array<(context: vm.Context, error: unknown) => unknown> = [
    () => ({ code: "native_process_launch_cleanup_blocked", launchResult: {} }),
    (_context, error) => Object.defineProperty(error, "launchResult", { get() { getterCalls += 1; throw new Error("must not read"); } }),
    (_context, error) => new Proxy(error as object, { get() { getterCalls += 1; throw new Error("must not read"); } }),
    (_context, error) => { const result = (error as { launchResult: object }).launchResult; Object.defineProperty(result, "opaqueIdentity", { get() { getterCalls += 1; throw new Error("must not read"); } }); return error; },
    (_context, error) => { (error as { evidenceDirectory: string }).evidenceDirectory = resolve("wrong-owner"); return error; },
  ];
  for (const errorFor of variations) {
    const f = probeControl({ errorFor });
    assert.ok(f.context.launchOwned);
    let custodyClaims = 0;
    let caught: unknown;
    try { await f.context.launchOwned({ launch: async () => { throw f.primary; } }, f.workspace, () => { custodyClaims += 1; }, f.request); }
    catch (error) { caught = error; }
    assert.equal(caught, f.primary, "original rejection identity retained without assertion-library error inspection");
    assert.equal(custodyClaims, 0);
    assert.equal(f.observed.includes("original-owner-signal"), false);
    assert.equal(f.observed.includes("exact-owned-fallback"), false);
    assert.equal(f.observed.includes("remove"), false);
  }
  assert.equal(getterCalls, 0);
  const f = probeControl(); assert.ok(f.context.failedLaunch);
  assert.equal(f.context.failedLaunch(f.primary, f.workspace, { ...f.request, intent: { ...f.request.intent, runId: "another-operation" } }), undefined);
  assert.equal(f.context.failedLaunch(f.primary, resolve("other-workspace"), f.request), undefined);
});

test("N4 actual API custody: cleanup refusal retains primary and owner; successful launch remains exactly once", async () => {
  const f = probeControl({ failedRootRelease: true });
  const creator = { owners: new Set(), isClosed: () => false };
  await assert.rejects(f.context.runProbe(creator), (error: unknown) => error instanceof AggregateError && error.cause === f.primary);
  assert.equal(creator.owners.size, 1); assert.equal(f.observed.includes("inspection-close"), false); assert.equal(f.observed.includes("remove"), false);
  assert.equal(f.observed.filter(item => item === "original-launch").length, 1);
  const launch = Object.freeze({ original: true }); let calls = 0, ownCalls = 0;
  const successful = execute(bodies(readSource("src/windows-process-semantic-probes.ts"), ["launchProbeWithCustody"]) + "\nglobalThis.launchOnce=launchProbeWithCustody;", {});
  assert.equal(await successful.launchOnce({ async launch() { calls += 1; return launch; } }, "workspace", () => { ownCalls += 1; }, {}), launch);
  assert.equal(calls, 1); assert.equal(ownCalls, 0, "original successful caller still owns its binding");
});

function fixtureControl(failure: "none" | "create" | "cleanup" | "onBuilt" | "host" | "multi" | "seed-dual") {
  const calls: string[] = [], primary = new Error(`controlled ${failure}`), secondary = new Error("controlled factory close failure");
  class Integration { async initialize() {} }
  const originalInitialize = Integration.prototype.initialize;
  const built = { runtime: { projectDocs: {}, stopNotes: {} }, async cleanup() { calls.push("built.cleanup"); if (failure === "cleanup" || failure === "multi") throw primary; }, async close() { calls.push("built.close"); } };
  const text = bodies(readSource("test/support/handoff-snapshot-harness.ts"), ["openFactoryPort"]);
  const context = execute(bodies(readSource("test/support/owned-fixture-teardown.ts"), ["finishOwnedFixture"]) + "\n" + text + "\nglobalThis.open=openFactoryPort;", {
    assert, join, tmpdir: () => "mock", mkdtempSync: () => "mock/root", mkdirSync() {}, writeFileSync() {}, rmSync() { calls.push("remove"); },
    captureGitBaseline: async () => ({ revision: "baseline" }), safeSegment: (value: string) => value,
    acceptFinalVerificationProfile() {}, FACTORY_PORT_OBJECTIVE: "test", CLOCK: "clock", SOURCE_TEXT: "source",
    snapshotNativeBuildAmbientEnvironment: () => ({}), provider: () => ({}), UnusedModel: class {}, ProductionIntegrationManager: Integration,
    ArtifactStore: class {}, SqliteEvidenceStore: class { close() { calls.push("evidence"); } },
    SqliteSchedulerStore: class { append() { if (failure === "seed-dual") throw primary; } close() { calls.push("seeder"); if (failure === "seed-dual") throw secondary; } },
    createExecutionHost() { if (failure === "host") throw primary; return { async close() { calls.push("executionHost"); } }; },
    NativeBuildFactory: class {
      async prepareSpec(spec: unknown) { return spec; }
      async create() { if (failure === "create") throw primary; const integration = new Integration(); await integration.initialize(); return built; }
      async close() { calls.push("factory"); if (failure === "multi") throw secondary; }
    },
  });
  return { context, calls, primary, secondary, Integration, originalInitialize };
}
test("N4 new fixture escrow: early close failure still attempts all later owners and preserves root/error", async () => {
  const f = fixtureControl("cleanup"); const fixture = await f.context.open("n4", "run", () => [], "plan_only");
  await assert.rejects(fixture.close(), error => error === f.primary);
  assert.deepEqual(f.calls, ["seeder", "built.cleanup", "built.close", "factory", "executionHost", "evidence"]);
  assert.equal(f.Integration.prototype.initialize, f.originalInitialize);
});
test("N4 new fixture escrow: failed construction/hooks close every registered owner but never delete evidence root", async () => {
  for (const failure of ["create", "onBuilt", "host"] as const) {
    const f = fixtureControl(failure);
    await assert.rejects(f.context.open("n4", "run", () => [], "plan_only", {}, { onBuilt: async () => { if (failure === "onBuilt") throw f.primary; } }), error => error === f.primary);
    const expected = failure === "host" ? ["seeder", "evidence"] : failure === "create"
      ? ["seeder", "factory", "executionHost", "evidence"] : ["seeder", "built.cleanup", "built.close", "factory", "executionHost", "evidence"];
    assert.deepEqual(f.calls, expected); assert.equal(f.Integration.prototype.initialize, f.originalInitialize);
  }
});
test("N4 new fixture escrow: successful close retains original order and removes root only after required owner success", async () => {
  const f = fixtureControl("none"); const fixture = await f.context.open("n4", "run", () => [], "plan_only"); await fixture.close();
  assert.deepEqual(f.calls, ["seeder", "built.cleanup", "built.close", "factory", "executionHost", "evidence", "remove"]);
});
test("N4 new fixture escrow: multiple owner failures aggregate original identities in order without suppressing later closes", async () => {
  const f = fixtureControl("multi"); const fixture = await f.context.open("n4", "run", () => [], "plan_only");
  await assert.rejects(fixture.close(), (error: unknown) => error instanceof AggregateError && error.errors[0] === f.primary && error.errors[1] === f.secondary && error.errors.length === 2);
  assert.deepEqual(f.calls, ["seeder", "built.cleanup", "built.close", "factory", "executionHost", "evidence"]);
});
test("N4 actual API request: failed launch custody reaches exact fallback and retains failed owner on cleanup refusal", async () => {
  const failed = probeControl({ failedRootRelease: true });
  assert.equal(Object.hasOwn(failed.request, "runId"), false, "actual request has no synthetic top-level runId");
  assert.equal(failed.request.intent.runId, "windows-semantic-probe");
  assert.equal(failed.request.grant.invocationId, failed.request.intent.invocationId);
  const creator = { owners: new Set(), isClosed: () => false };
  await assert.rejects(failed.context.runProbe(creator), (error: unknown) => error instanceof AggregateError && error.cause === failed.primary);
  assert.ok(failed.observed.includes("original-owner-signal")); assert.ok(failed.observed.includes("exact-owned-fallback"));
  assert.equal(failed.observed.includes("inspection-close"), false); assert.equal(failed.observed.includes("remove"), false); assert.equal(creator.owners.size, 1);
  const success = probeControl();
  assert.equal(await success.context.settleFact(() => success.context.runProbe({ owners: new Set(), isClosed: () => false })), "unavailable");
  assert.ok(success.observed.includes("exact-owned-fallback")); assert.ok(success.observed.includes("inspection-close")); assert.ok(success.observed.includes("remove"));
  for (const request of [
    { ...success.request, intent: { ...success.request.intent, runId: "another-operation" } },
    { ...success.request, grant: { ...success.request.grant, invocationId: "wrong" } },
    { ...success.request, outputOwnerId: "other-owner" },
  ]) assert.equal(success.context.failedLaunch(success.primary, success.workspace, request), undefined);
});
test("N4 new seeder escrow: append and close failure preserve both original errors before later owner close", async () => {
  const f = fixtureControl("seed-dual");
  let caught: unknown;
  try { await f.context.open("n4", "run", () => [{ type: "controlled legacy seed" }], "plan_only"); }
  catch (error) { caught = error; }
  assert.ok(caught instanceof AggregateError);
  assert.equal(caught.errors.length, 2); assert.equal(caught.errors[0], f.primary); assert.equal(caught.errors[1], f.secondary);
  assert.deepEqual(f.calls, ["seeder", "evidence"]);
  assert.equal(f.Integration.prototype.initialize, f.originalInitialize);
});
