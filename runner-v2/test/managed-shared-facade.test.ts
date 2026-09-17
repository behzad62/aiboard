import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { ManagedProcessService, type ManagedProcessSnapshot } from "../src/managed-process.js";
import type { ToolExecutionContext } from "../src/agent-contracts.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";

type Identity = Pick<ToolExecutionContext, "runId" | "sessionId" | "actor"> & { processId: string };
type Start = { identity: Identity; context: ToolExecutionContext; command: string; args: readonly string[]; cwd: string; environment: Readonly<Record<string, string>> };
const gate = () => { let release!: () => void; const promise = new Promise<void>(r => { release = r; }); return { promise, release }; };
async function fixture(t: TestContext, hooks: { start?: () => Promise<void>; observe?: () => Promise<void>; stop?: () => Promise<void> } = {}) {
  const root = await mkdtemp(join(tmpdir(), "p684-managed-facade-")); t.diagnostic(`exact synthetic managed root: ${root}`);
  const events: string[] = [], requests: Start[] = []; let snapshot: ManagedProcessSnapshot | undefined; let call = 0;
  const runtime = { runId: "run", async start(request: Start) { events.push("start"); requests.push(request); await hooks.start?.();
    snapshot = { processId: request.identity.processId, pid: 42, status: "running", exitCode: null, signal: null, startedAt: "2026-09-14T00:00:00.000Z", updatedAt: "2026-09-14T00:00:00.000Z", stdout: "owned", stderr: "" }; return snapshot; },
    async observe(_identity: Identity, context?: ToolExecutionContext) { if (context) events.push(`observe:${context.callId}`); await hooks.observe?.(); return { ...snapshot! }; },
    async stop(_identity: Identity, _context?: ToolExecutionContext) { events.push("stop"); await hooks.stop?.(); snapshot = { ...snapshot!, status: "stopped", exitCode: 0 }; return { ...snapshot }; } };
  const service = new ManagedProcessService({ stateDirectory: join(root, "state"), platform: "linux", runtime,
    idFactory: () => "managed-exact" } as unknown as ConstructorParameters<typeof ManagedProcessService>[0]);
  const context = (toolName = "process.start", signal?: AbortSignal): ToolExecutionContext => ({ runId: "run", sessionId: "agent", actor: { role: "worker", id: "worker" },
    workspacePath: root, callId: `call-${++call}`, toolName, executionGrant: Object.freeze({}) as OpaqueExecutionGrant, ...(signal ? { signal } : {}) });
  return { root, service, runtime, events, requests, context, async close(passed: boolean) { await service.close();
    if (passed) { await rm(root, { recursive: true }); t.diagnostic(`closed synthetic managed root removed: ${root}`); } else t.diagnostic(`closed synthetic managed failure retained: ${root}`); } };
}

test("managed facade uses an injected portable runtime and preserves exact immutable call identity", async t => {
  const f = await fixture(t); let passed = false;
  try {
    const context = f.context(); const input = { command: "fixture", args: ["one"], env: { SAFE_VALUE: "value" } };
    const started = await f.service.start(input, context, f.root);
    assert.equal(started.processId, "managed-exact"); assert.equal(started.status, "running");
    assert.equal(f.requests.length, 1); assert.equal(f.requests[0]!.context.executionGrant, context.executionGrant);
    assert.deepEqual(f.requests[0]!.context.actor, context.actor); assert.ok(Object.isFrozen(f.requests[0]!.context));
    input.args.push("mutated"); input.env.SAFE_VALUE = "changed";
    assert.deepEqual(f.requests[0]!.args, ["one"]); assert.equal(f.requests[0]!.environment.SAFE_VALUE, "value");
    const polled = await f.service.poll(started.processId, f.context("process.poll")); assert.equal(polled.stdout, "owned");
    const files = await readdir(join(f.root, "state")); const record = JSON.parse(await readFile(join(f.root, "state", "managed-exact.json"), "utf8"));
    assert.ok(files.includes("managed-exact.json")); assert.equal(record.schemaVersion, 2); assert.equal(record.recordKind, "runner.managed-process");
    assert.doesNotMatch(JSON.stringify(record), /executionGrant|supervisor|Bearer|controlPort|"SAFE_VALUE":"value"/);
    passed = true;
  } finally { await f.close(passed); }
});

test("managed facade rejects a different actor before exposing output or requesting stop", async t => {
  const f = await fixture(t); let passed = false;
  try {
    const started = await f.service.start({ command: "fixture" }, f.context(), f.root);
    const context = { ...f.context("process.poll"), actor: { role: "worker" as const, id: "foreign" } };
    await assert.rejects(async () => await f.service.poll(started.processId, context), /another|owner|owned/i);
    await assert.rejects(f.service.signal(started.processId, "SIGTERM", { ...context, toolName: "process.signal" }), /another|owner|owned/i);
    assert.deepEqual(f.events, ["start"]); passed = true;
  } finally { await f.close(passed); }
});

test("managed cancelled start and async close join an exact late acquisition", async t => {
  const entered = gate(), held = gate(), controller = new AbortController();
  const f = await fixture(t, { start: async () => { entered.release(); await held.promise; } }); let passed = false;
  const starting = f.service.start({ command: "fixture" }, f.context("process.start", controller.signal), f.root); void starting.catch(() => undefined);
  try {
    await Promise.race([entered.promise, starting]); controller.abort();
    let closed = false; const closing = Promise.resolve(f.service.close()).then(() => { closed = true; });
    await Promise.resolve(); assert.equal(closed, false); assert.equal(f.events.includes("stop"), false);
    held.release(); await assert.rejects(starting, /cancel/i); await closing;
    assert.deepEqual(f.events, ["start", "stop"]); passed = true;
  } finally { held.release(); await starting.catch(() => undefined); await f.close(passed); }
});

test("managed cancelled poll returns promptly without stopping its background child", async t => {
  const entered = gate(), held = gate(), controller = new AbortController();
  const f = await fixture(t, { observe: async () => { entered.release(); await held.promise; } }); let passed = false;
  try {
    const started = await f.service.start({ command: "fixture" }, f.context(), f.root);
    const polling = Promise.resolve(f.service.poll(started.processId, f.context("process.poll", controller.signal))); void polling.catch(() => undefined);
    await Promise.race([entered.promise, polling]); controller.abort();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { await assert.rejects(Promise.race([polling, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("poll did not settle promptly")), 200); })]), /cancel/i); }
    finally { if (timer) clearTimeout(timer); held.release(); await polling.catch(() => undefined); }
    assert.equal(f.events.includes("stop"), false); passed = true;
  } finally { held.release(); await f.close(passed); }
});

test("managed durable stop keeps joining cleanup after its caller cancels", async t => {
  const entered = gate(), held = gate(), controller = new AbortController();
  const f = await fixture(t, { stop: async () => { entered.release(); await held.promise; } }); let passed = false;
  try {
    const started = await f.service.start({ command: "fixture" }, f.context(), f.root);
    let settled = false; const stopping = f.service.signal(started.processId, "SIGTERM", f.context("process.signal", controller.signal)).then(value => { settled = true; return value; });
    await Promise.race([entered.promise, stopping]); controller.abort(); await Promise.resolve(); assert.equal(settled, false);
    held.release(); assert.equal((await stopping).status, "stopped"); assert.deepEqual(f.events, ["start", "stop"]); passed = true;
  } finally { held.release(); await f.close(passed); }
});

test("managed async close preserves failed cleanup and retries the same exact owner", async t => {
  let attempts = 0;
  const f = await fixture(t, { stop: async () => { if (++attempts === 1) throw new Error("exact cleanup unavailable"); } }); let passed = false;
  try {
    await f.service.start({ command: "fixture" }, f.context(), f.root);
    await assert.rejects(async () => await f.service.close(), /cleanup|close/i); assert.equal(attempts, 1);
    await f.service.close(); assert.equal(attempts, 2); assert.deepEqual(f.events, ["start", "stop", "stop"]); passed = true;
  } finally { await f.close(passed); }
});
