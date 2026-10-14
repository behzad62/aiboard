import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setImmediate } from "node:timers/promises";
import type { Page, Request } from "@playwright/test";
import { readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { attachPlanningHttpDiagnostic } from "./support/planning-http-diagnostic.js";
import { finishOwnedFixture } from "./support/owned-fixture-teardown.js";

const planningUiFile = new URL("../../tests/e2e/runner-v2-t8-planning-journey.spec.ts", import.meta.url);
function planningUiAst() {
 return ts.createSourceFile("ui.ts", readFileSync(planningUiFile, "utf8"), ts.ScriptTarget.Latest, true);
}
function nodesMatching<T extends ts.Node>(source: ts.SourceFile, predicate: (node: ts.Node) => node is T): T[] {
 const found: T[] = [];
 function visit(node: ts.Node) { if (predicate(node)) found.push(node); ts.forEachChild(node, visit); }
 visit(source); return found;
}

const diagnosticOrigin = "http://127.0.0.1:9876";
function diagnosticFixture() {
 const emitter = new EventEmitter(); let clock = 0;
 const diagnostic = attachPlanningHttpDiagnostic(emitter as unknown as Page, diagnosticOrigin, "fixture-run", () => ++clock);
 return { emitter, diagnostic };
}
function diagnosticRequest(url = diagnosticOrigin + "/v2/runs/fixture-run/build/files", errorText = "net::ERR_ABORTED") {
 return { url: () => url, method: () => "GET", failure: () => ({ errorText }), headers: () => assert.fail("No diagnostic header reads"), postData: () => assert.fail("No diagnostic body reads") } as unknown as Request;
}

test("actual browser rendering waits for its same-request response and held transfer", async () => {
 const source = planningUiAst();
 const navigation = nodesMatching(source, ts.isExpressionStatement).find(node => ts.isAwaitExpression(node.expression) && node.getText(source).includes("/discussion?id="));
 const panel = nodesMatching(source, ts.isVariableStatement).find(node => node.getText(source).includes('const planningPanel = page.getByLabel("Evidence-gated planning")'));
 const visible = nodesMatching(source, ts.isExpressionStatement).find(node => node.getText(source) === "await expect(planningPanel).toBeVisible();");
 assert.ok(navigation && panel && visible);
 const helper = nodesMatching(source, ts.isFunctionDeclaration).find(node => node.name?.text === "openPlanningAttachment");
 let releaseResponse!: () => void, releaseTransfer!: () => void, transferred = false, renders = 0;
 const order: string[] = [];
 const transfer = new Promise<null>(resolve => { releaseTransfer = () => { transferred = true; order.push("transferred"); resolve(null); }; });
 const response = { url: () => diagnosticOrigin + "/v2/runs/fixture-run/build/files", request: () => ({ method: () => "GET" }), status: () => 200, finished: () => { order.push("finished"); return transfer; } };
 const responsePromise = new Promise<typeof response>(resolve => { releaseResponse = () => { order.push("response"); resolve(response); }; });
 const context = { URL, DISCUSSION_ID: "discussion", RUN_ID: "fixture-run", address: { url: diagnosticOrigin },
  page: { waitForResponse: (...args: unknown[]) => { order.push("waiter"); assert.equal(args.length, 1, "Do not add a custom timeout"); assert.ok((args[0] as (value: typeof response) => boolean)(response)); return responsePromise; }, goto: async () => { order.push("goto"); }, getByLabel: () => ({}) },
  expect: (value: unknown) => ({ toBe: (expected: unknown) => assert.equal(value, expected), toBeNull: () => assert.equal(value, null), toBeVisible: async () => { renders += 1; assert.equal(transferred, true, "The original render assertion must follow actual transfer readiness"); order.push("render"); } }) };
 if (helper) runInNewContext(ts.transpileModule(helper.getText(source), { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, context);
 const operation = runInNewContext("(async()=>{" + navigation.getText(source) + panel.getText(source) + visible.getText(source) + "})()", context) as Promise<void>;
 const outcome = operation.then(() => ({ ok: true as const }), error => ({ ok: false as const, error }));
 try {
  await setImmediate(); assert.equal(renders, 0, "Pending response/transfer must hold the original UI assertion");
  releaseResponse(); await setImmediate(); assert.equal(renders, 0, "Response headers alone do not prove transfer readiness");
  releaseTransfer(); const result = await outcome; if (!result.ok) throw result.error;
  assert.equal(renders, 1); assert.deepEqual(order, ["waiter", "goto", "response", "finished", "transferred", "render"]);
 } finally { releaseResponse(); releaseTransfer(); await outcome; }
});

function readinessHelper(context: object) {
 const source = planningUiAst();
 const helper = nodesMatching(source, ts.isFunctionDeclaration).find(node => node.name?.text === "openPlanningAttachment");
 assert.ok(helper);
 return runInNewContext(ts.transpileModule("(" + helper.getText(source) + ")", { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText, context) as (page: unknown, input: { pageUrl: string; runnerUrl: string; runId: string }) => Promise<void>;
}

test("actual readiness matcher observes the exact page run GET including non200, without a custom timeout", async () => {
 const response = (url: string, method = "GET") => ({ url: () => url, request: () => ({ method: () => method }), status: () => 200, finished: async () => null });
 let matcher: (candidate: ReturnType<typeof response>) => boolean = () => false;
 const context = { URL, expect: (value: unknown) => ({ toBe: (expected: unknown) => assert.equal(value, expected) }) };
 const open = readinessHelper(context);
 const order: string[] = [];
 await open({ waitForResponse: (...args: unknown[]) => { order.push("waiter"); assert.equal(args.length, 1); matcher = args[0] as typeof matcher; return Promise.resolve(response(diagnosticOrigin + "/v2/runs/fixture-run/build/files")); }, goto: async () => { order.push("goto"); } }, { pageUrl: "/discussion", runnerUrl: diagnosticOrigin, runId: "fixture-run" });
 assert.deepEqual(order, ["waiter", "goto"]);
 for (const candidate of [response("http://127.0.0.1:9877/v2/runs/fixture-run/build/files"), response(diagnosticOrigin + "/v2/runs/other/build/files"), response(diagnosticOrigin + "/v2/runs/fixture-run/build/files-extra"), response(diagnosticOrigin + "/v2/runs/fixture-run/build/files", "POST")]) assert.equal(matcher(candidate), false);
 assert.equal(matcher({ ...response(diagnosticOrigin + "/v2/runs/fixture-run/build/files?ignored=1"), status: () => { throw new Error("Status must be asserted after matching, not hidden by a predicate"); } }), true);
});

test("actual readiness retains non200, transfer and navigation failures without an unhandled waiter", async () => {
 const context = { URL, expect: (value: unknown) => ({ toBe: (expected: unknown) => assert.equal(value, expected) }) };
 const open = readinessHelper(context);
 for (const scenario of ["status", "transfer-error", "transfer-rejection", "navigation"]) {
  const sentinel = new Error(scenario); let finishedCalls = 0, rejectWaiting!: (error: Error) => void;
  const waiting = new Promise<never>((_, reject) => { rejectWaiting = reject; });
  const response = { url: () => diagnosticOrigin + "/v2/runs/fixture-run/build/files", request: () => ({ method: () => "GET" }), status: () => scenario === "status" ? 503 : 200,
   finished: async () => { finishedCalls += 1; if (scenario === "transfer-rejection") throw sentinel; return sentinel; } };
  const unhandled: unknown[] = []; const onUnhandled = (error: unknown) => { unhandled.push(error); }; process.on("unhandledRejection", onUnhandled);
  try {
   const operation = open({ waitForResponse: () => scenario === "navigation" ? waiting : Promise.resolve(response), goto: async () => { if (scenario === "navigation") throw sentinel; } }, { pageUrl: "/discussion", runnerUrl: diagnosticOrigin, runId: "fixture-run" });
   await assert.rejects(operation, error => scenario === "status" ? error instanceof assert.AssertionError : error === sentinel);
   rejectWaiting(new Error("page closed after original navigation failure"));
   // Only the navigation case consumes this waiter through the actual Promise.all.
   if (scenario !== "navigation") await waiting.catch(() => undefined);
   await setImmediate(); assert.deepEqual(unhandled, []);
   assert.equal(finishedCalls, scenario === "status" || scenario === "navigation" ? 0 : 1);
  } finally { process.off("unhandledRejection", onUnhandled); }
 }
});

test("passive HTTP diagnostic filters exact origin/routes and retains request identity and event order", () => {
 const { emitter, diagnostic } = diagnosticFixture();
 try {
  for (const url of ["http://127.0.0.1:9877/v2/builds", diagnosticOrigin + "/v2evil", "https://example.invalid/v2/builds"]) emitter.emit("request", diagnosticRequest(url));
  const first = diagnosticRequest(diagnosticOrigin + "/v2/runs/fixture-run/build/files?token=SECRET#SECRET");
  emitter.emit("request", first);
  emitter.emit("response", { request: () => first, status: () => 503, headers: () => assert.fail("No response header reads"), body: () => assert.fail("No response body reads") });
  emitter.emit("requestfinished", first);
  const second = diagnosticRequest(); emitter.emit("request", second); emitter.emit("requestfailed", second);
  emitter.emit("request", diagnosticRequest(diagnosticOrigin + "/v2/private/SECRET?SECRET"));
  const snapshot = diagnostic.snapshot();
  assert.deepEqual(snapshot.facts.map(fact => fact.phase), ["request", "response", "requestfinished", "request", "requestfailed", "request"]);
  assert.deepEqual(snapshot.facts.map(fact => fact.requestId), [1, 1, 1, 2, 2, 3]);
  assert.deepEqual(snapshot.facts.map(fact => fact.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(snapshot.facts.map(fact => fact.elapsedMs), [1, 2, 3, 4, 5, 6]);
  assert.equal(snapshot.facts[1].status, 503); assert.equal(snapshot.facts[5].route, "/v2/<other>");
  assert.equal(snapshot.facts[0].route, "/v2/runs/:run/build/files");
  assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|token=|fixture-run|example\.invalid/);
  diagnostic.assertComplete();
 } finally { diagnostic.detach(); }
});

test("passive diagnostic records only whitelisted error categories and never page error messages", () => {
 const { emitter, diagnostic } = diagnosticFixture();
 try {
  const error = new TypeError(); Object.defineProperty(error, "message", { get: () => assert.fail("Page error messages are not read") });
  emitter.emit("pageerror", error); emitter.emit("pageerror", { name: "SECRET", message: "SECRET", stack: "SECRET" });
  emitter.emit("requestfailed", diagnosticRequest(undefined, "SECRET"));
  emitter.emit("requestfailed", diagnosticRequest());
  assert.deepEqual(diagnostic.snapshot().facts.map(fact => fact.errorKind), ["TypeError", "other", "other", "net::ERR_ABORTED"]);
  assert.doesNotMatch(JSON.stringify(diagnostic.snapshot()), /SECRET/); diagnostic.assertComplete();
 } finally { diagnostic.detach(); }
});

test("pre-teardown diagnostic snapshots are immutable and distinct from page-close cancellation", () => {
 const { emitter, diagnostic } = diagnosticFixture(); const request = diagnosticRequest();
 emitter.emit("request", request); const before = diagnostic.snapshot(); const bytes = JSON.stringify(before);
 emitter.emit("requestfailed", request); const after = diagnostic.snapshot();
 assert.equal(JSON.stringify(before), bytes); assert.equal(before.facts.length, 1); assert.equal(after.facts.length, 2);
 assert.ok(Object.isFrozen(before) && Object.isFrozen(before.facts) && Object.isFrozen(before.facts[0]));
 diagnostic.detach(); emitter.emit("request", request); assert.equal(diagnostic.snapshot().facts.length, 2);
});

test("diagnostic event overflow and bounded capture failures remain explicitly incomplete", () => {
 const { emitter, diagnostic } = diagnosticFixture(); const request = diagnosticRequest();
 try {
  for (let index = 0; index < 513; index += 1) emitter.emit("request", request);
  for (let index = 0; index < 40; index += 1) emitter.emit("request", { url: () => { throw new Error("SECRET"); } });
  const snapshot = diagnostic.snapshot(); assert.equal(snapshot.complete, false); assert.equal(snapshot.facts.length, 512);
  assert.equal(snapshot.overflow, 1); assert.equal(snapshot.failureCount, 40); assert.equal(snapshot.failures.length, 32);
  assert.throws(diagnostic.assertComplete, /1 dropped events; 40 capture failures/); assert.doesNotMatch(JSON.stringify(snapshot), /SECRET/);
 } finally { diagnostic.detach(); }
});

test("diagnostic owns listener detachment even when registration throws after its effect", () => {
 const emitter = new EventEmitter();
 const page = { on: (event: string, listener: (value: unknown) => void) => { emitter.on(event, listener); if (event === "request") throw new Error("SECRET"); }, off: (event: string, listener: (value: unknown) => void) => emitter.off(event, listener) } as unknown as Page;
 const diagnostic = attachPlanningHttpDiagnostic(page, diagnosticOrigin, "fixture-run");
 assert.equal(emitter.listenerCount("request"), 1); diagnostic.detach();
 assert.equal(emitter.eventNames().length, 0); assert.equal(diagnostic.snapshot().failureCount, 1);
 assert.throws(diagnostic.assertComplete, /capture failures/); assert.doesNotMatch(JSON.stringify(diagnostic.snapshot()), /SECRET/);
});

test("actual diagnostic catch/finally preserves body, owner and report failures and original removal", async () => {
 const source = planningUiAst();
 const envelope = nodesMatching(source, ts.isTryStatement).find(node => node.finallyBlock?.getText(source).includes("finishOwnedFixture"));
 const emit = nodesMatching(source, ts.isVariableDeclaration).find(node => node.name.getText(source) === "emitBrowserDiagnostic");
 assert.ok(envelope?.catchClause && envelope.finallyBlock && emit?.initializer);
 for (const scenario of ["body", "owner-report", "capture", "success"]) {
  const { emitter, diagnostic } = diagnosticFixture(); const request = diagnosticRequest(); emitter.emit("request", request);
  if (scenario === "capture") emitter.emit("request", { url: () => { throw new Error("SECRET"); } });
  const originalBody = new Error("body"), originalOwner = new Error("owner"), originalReport = new Error("report");
  const order: string[] = [], output: unknown[] = [];
  const context = { originalBody, scenario, bodyFailed: false, bodyError: undefined, atBodyFailure: undefined, browserHttp: diagnostic, root: "inert", finishOwnedFixture,
   page: { close: async () => { order.push("page"); emitter.emit("requestfailed", request); } }, server: { close: async () => { order.push("server"); } }, supervisor: { close: () => { order.push("supervisor"); } },
   manager: { close: async () => { order.push("manager"); if (scenario === "owner-report") throw originalOwner; } }, factory: { close: async () => { order.push("factory"); } }, executionHost: { close: async () => { order.push("host"); } },
   rmSync: () => { order.push("remove"); }, console: { error: () => undefined, dir: (value: { diagnostic?: string }) => { if (value.diagnostic) { output.push(value); if (scenario === "owner-report") throw originalReport; } } }, emitBrowserDiagnostic: () => undefined };
  context.emitBrowserDiagnostic = runInNewContext("(" + emit.initializer.getText(source) + ")", context);
  let failure: unknown;
  try { await runInNewContext("(async()=>{try{if(scenario!=='success')throw originalBody;}catch(error)" + envelope.catchClause.block.getText(source) + "finally" + envelope.finallyBlock.getText(source) + "})()", context); } catch (error) { failure = error; }
  if (scenario === "body") assert.equal(failure, originalBody);
  if (scenario === "owner-report") { assert.ok(failure instanceof AggregateError); assert.deepEqual(failure.errors, [originalBody, originalOwner, originalReport]); }
  if (scenario === "capture") { assert.ok(failure instanceof AggregateError); assert.equal(failure.errors[0], originalBody); assert.match(failure.errors[1].message, /diagnostic incomplete/); }
  if (scenario === "success") assert.equal(failure, undefined);
  assert.deepEqual(order, scenario === "owner-report" ? ["page", "server", "supervisor", "manager", "factory", "host"] : ["page", "server", "supervisor", "manager", "factory", "host", "remove"]);
  assert.equal(output.length, 1); assert.equal(emitter.eventNames().length, 0);
  if (scenario !== "success") assert.equal((context.atBodyFailure as unknown as { facts: unknown[] }).facts.length, 1);
 }
});

test("actual planning preparation enters the durable owner-start pause within its original step bound", async () => {
 const source = planningUiAst();
 const loop = nodesMatching(source, ts.isForStatement).find(node => node.getText(source).includes("ready plan: not reached within 200 steps"));
 assert.ok(loop);
 let steps = 0;
 const projection: { status: string; planning: { readiness: string }; pauseReason?: { reason: string } } = { status: "running", planning: { readiness: "ready" } };
 const runtime = { projection: () => projection, step: async () => { steps += 1; projection.status = "paused"; projection.pauseReason = { reason: "plan_start_required" }; return { status: "paused", action: "plan_start_required" }; } };
 const code = ts.transpileModule("(async () => {" + loop.getText(source) + "})()", { compilerOptions: { target: ts.ScriptTarget.ES2023 } }).outputText;
 await runInNewContext(code, { runtime, expect: (value: unknown) => ({ toBe: (expected: unknown) => assert.equal(value, expected) }) });
 assert.equal(steps, 1, "Ready is not the durable paused state; the original fixture must reach the real start gate");
 assert.equal(projection.status, "paused");
});

test("actual browser seed derives its observation status from the durable paused Build", () => {
 const source = planningUiAst();
 const seedFunction = nodesMatching(source, ts.isFunctionDeclaration).find(node => node.name?.text === "seedBuildDiscussion");
 assert.ok(seedFunction);
 const store = nodesMatching(source, ts.isVariableDeclaration).find(node => node.name.getText(source) === "store" && node.pos > seedFunction.pos && node.end < seedFunction.end);
 assert.ok(store?.initializer);
 const liveSource = ts.createSourceFile("live.ts", readFileSync(new URL("../../lib/client/discussion-live-state.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
 const statusFunction = nodesMatching(liveSource, ts.isFunctionDeclaration).find(node => node.name?.text === "nativeBuildDiscussionStatus");
 assert.ok(statusFunction);
 const exports: Record<string, (projection: { status: string }) => string> = {};
 runInNewContext(ts.transpileModule(statusFunction.getText(liveSource), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
 const status = exports.nativeBuildDiscussionStatus({ status: "paused" });
 const data = runInNewContext("(" + store.initializer.getText(source) + ")", { now: "fixture", seed: { discussionId: "discussion", runId: "run", runnerUrl: "http://127.0.0.1:1", runnerToken: "unused", status } });
 assert.equal(data.discussions[0].status, status, "A paused native observation must not bootstrap the active browser engine");
 const seedCall = nodesMatching(source, ts.isCallExpression).find(node => ts.isIdentifier(node.expression) && node.expression.text === "seedBuildDiscussion");
 assert.ok(seedCall);
 const options = seedCall.arguments[1]; assert.ok(options && ts.isObjectLiteralExpression(options));
 const property = options.properties.find(node => ts.isPropertyAssignment(node) && node.name.getText(source) === "status");
 assert.ok(property && ts.isPropertyAssignment(property), "Pass the actual durable status to the browser seed");
 assert.equal(runInNewContext(property.initializer.getText(source).replaceAll("runtime!", "runtime"), { runtime: { projection: () => ({ status: "paused" }) }, nativeBuildDiscussionStatus: exports.nativeBuildDiscussionStatus }), status);
});

test("actual start assertions require exactly authorization then durable resume", () => {
 const source = planningUiAst();
 const assertions = nodesMatching(source, ts.isExpressionStatement).filter(node => node.getText(source).startsWith("expect(afterStart"));
 assert.ok(assertions.length > 0);
 const beforePreview = [{ type: "planning.plan_ready" }];
 const check = (types: string[]) => {
  const afterStart = [...beforePreview, ...types.map(type => ({ type }))];
  const expect = (value: unknown) => ({ toBe: (expected: unknown) => assert.equal(value, expected), toEqual: (expected: unknown) => assert.deepEqual(JSON.parse(JSON.stringify(value)), JSON.parse(JSON.stringify(expected))) });
  for (const assertion of assertions) runInNewContext(assertion.getText(source), { expect, beforePreview, afterStart });
 };
 check(["planning.execution_authorized", "run.resumed"]);
 for (const invalid of [["planning.execution_authorized"], ["run.resumed"], ["run.resumed", "planning.execution_authorized"], ["planning.execution_authorized", "run.resumed", "task.transitioned"]]) assert.throws(() => check(invalid));
});

test("actual supervisor pause and attachment controller retain manual ownership until an explicit wake", async () => {
 const source = planningUiAst();
 const supervisor = new RunSupervisor(new SqliteEventStore(":memory:"));
 const RUN_ID = "fixture-observer";
 supervisor.createRun({ runId: RUN_ID, projectPath: realpathSync.native(tmpdir()), permissionProfile: "full", idempotencyKey: "create" });
 supervisor.captureBaseline(RUN_ID, "baseline", "a".repeat(40), "refs/fixture/baseline");
 const transitions = nodesMatching(source, ts.isExpressionStatement).filter(node => {
  const expression = node.expression;
  return ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression) &&
   expression.expression.expression.getText(source) === "supervisor" && ["start", "pause"].includes(expression.expression.name.text);
 });
 for (const transition of transitions) runInNewContext(transition.getText(source), { supervisor, RUN_ID });
 const liveSource = ts.createSourceFile("live.ts", readFileSync(new URL("../../lib/client/discussion-live-state.ts", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true);
 const functions = nodesMatching(liveSource, ts.isFunctionDeclaration).filter(node => ["createNativeBuildAttachmentController", "nativeBuildDiscussionStatus"].includes(node.name?.text ?? ""));
 assert.equal(functions.length, 2);
 const exports = {};
 runInNewContext(ts.transpileModule(functions.map(node => node.getText(liveSource)).join("\n"), { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, { exports });
 const clientSource = ts.createSourceFile("client.tsx", readFileSync(new URL("../../app/discussion/discussion-client.tsx", import.meta.url), "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
 const engineEffect = nodesMatching(clientSource, ts.isArrowFunction).find(node => node.getText(clientSource).includes("startedRef.current = true") && node.getText(clientSource).includes("runClientDiscussion("));
 assert.ok(engineEffect);
 let loads = 0, engineAdmissions = 0, buildStatus = "paused", browserStatus = "stopped", nextHandle = 0;
 const scheduled = new Map<number, () => Promise<void>>();
 const startedRef = { current: false };
 const options = {
  initialSavedRunId: RUN_ID, resolveRunId: async () => RUN_ID,
  load: async () => { loads += 1; return { runState: supervisor.getRun(RUN_ID).state, projection: { status: buildStatus } }; },
  apply: (snapshot: { projection: { status: string } }) => {
   browserStatus = runInNewContext("exports.nativeBuildDiscussionStatus(projection)", { exports, projection: snapshot.projection });
   runInNewContext("(" + engineEffect.getText(clientSource) + ")()", { id: RUN_ID, discussion: {}, status: browserStatus, folderGrant: "ready", startedRef,
    setStreamConnected: () => undefined, handleEventRef: { current: () => undefined }, requestCommandApproval: () => assert.fail("No command approval expected"),
    runClientDiscussion: async () => { engineAdmissions += 1; } });
  },
  schedule: (callback: () => Promise<void>) => { const handle = ++nextHandle; scheduled.set(handle, callback); return handle; },
  cancelScheduled: (handle: unknown) => { scheduled.delete(handle as number); }, intervalMs: 2000,
 };
 const controller: { start: () => Promise<void>; wake: () => void; cancel: () => void } = runInNewContext("exports.createNativeBuildAttachmentController(options)", { exports, options });
 async function tick() { const entry = scheduled.entries().next().value; assert.ok(entry); scheduled.delete(entry[0]); await entry[1](); }
 try {
  await controller.start();
  assert.equal(loads, 1, "The real attachment controller must perform the initial snapshot load");
  assert.equal(engineAdmissions, 0);
  buildStatus = "running"; // Actual owner authorization resumes Build; supervisor remains the paused manual observer.
  await tick();
  assert.equal(loads, 1, "The fixture supervisor must already be paused so polling cannot re-admit the active browser engine");
  assert.equal(browserStatus, "stopped");
  assert.equal(engineAdmissions, 0);
  controller.wake();
  await tick();
  assert.equal(loads, 2, "An explicit wake must still load the current state");
  assert.equal(browserStatus, "running");
  assert.equal(engineAdmissions, 1, "The real page effect remains enabled when explicitly woken to active state");
 } finally { controller.cancel(); supervisor.close(); }
});

test("planning UI fixture supplies actual project and Node metadata to the authenticated health route", async () => {
 const file = new URL("../../tests/e2e/runner-v2-t8-planning-journey.spec.ts", import.meta.url);
 const source = ts.createSourceFile("ui.ts",readFileSync(file,"utf8"),ts.ScriptTarget.Latest,true);let metadata: ts.Expression | undefined;
 function walk(node:ts.Node){if(ts.isNewExpression(node)&&ts.isIdentifier(node.expression)&&node.expression.text==="ControlServer"){
   const options=node.arguments?.[0];assert.ok(options&&ts.isObjectLiteralExpression(options));
   const property=options.properties.find(p=>ts.isPropertyAssignment(p)&&p.name.getText(source)==="runnerInfo");
   if(property&&ts.isPropertyAssignment(property))metadata=property.initializer;
  }ts.forEachChild(node,walk);}
 walk(source);const project=realpathSync.native(tmpdir());
 const runnerInfo=metadata?runInNewContext("("+metadata.getText(source)+")",{project,process}):undefined;
 const supervisor=new RunSupervisor(new SqliteEventStore(":memory:"));
 const server=new ControlServer({supervisor,token:"fixture-health-control",runnerInfo,bootstrapRun:async()=>{throw new Error("Health control must not bootstrap a Build");}});
 try{const address=await server.start(0);const response=await fetch(address.url+"/v2/health",{headers:{Authorization:"Bearer fixture-health-control"}});
  assert.equal(response.status,200,"The real planning fixture must expose current runner metadata instead of health503");
  const data=await response.json();assert.equal(data.protocolVersion,2);assert.equal(data.projectPath,project);assert.equal(data.nodeVersion,process.versions.node);
 }finally{await server.close();supervisor.close();}
});
