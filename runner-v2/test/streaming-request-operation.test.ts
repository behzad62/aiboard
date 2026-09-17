import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingRequestOperation } from "../src/streaming-request-operation.js";
import type { SessionOperationAuthorization, OperationAuthorizationAssertion } from "../src/session-authority.js";
const auth = () => Object.freeze({}) as SessionOperationAuthorization;
const assertion: OperationAuthorizationAssertion = { sessionId: "session", operation: "request", binding: {
  runId: "run", sessionId: "agent", actor: { role: "worker", id: "worker" }, callId: "call", toolName: "mcp.docs.lookup", permissionProfile: "full" },
  requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false };
function gate() { let resolve!: () => void; const promise = new Promise<void>((r) => { resolve = r; }); return { promise, resolve }; }

for (const phase of ["callback", "write", "unawaited-write", "delivery"] as const)
test(`MCP request retains ${phase} ownership after caller timeout until its actual effect settles`, async () => {
  const held = gate(); let entered = false; let effects = 0;
  const operation = createStreamingRequestOperation({ sessionId: "session", assert: () => undefined,
    write: async () => { entered = true; effects++; await held.promise; }, waitForOutput: async () => true,
    deliver: async (_auth, _expected, deliver) => { entered = true; effects++; await held.promise; await deliver("stdout", Buffer.from("owned")); return true; } });
  const first = operation(auth(), assertion, async (io) => {
    if (phase === "callback") { entered = true; await held.promise; }
    if (phase === "write") await io.write(Buffer.from("owned"), 100);
    if (phase === "unawaited-write") { void io.write(Buffer.from("owned"), 100).catch(() => undefined); }
    if (phase === "delivery") await io.deliverOutput(async () => undefined);
  }, 25);
  try {
    await assert.rejects(first, /timed out/); assert.equal(entered, true);
    await assert.rejects(operation(auth(), assertion, async () => { effects++; }, 100), /progress|pending|unsettled/i);
    assert.equal(effects, phase === "callback" ? 0 : 1);
  } finally { held.resolve(); await Promise.resolve(); await new Promise<void>((resolve) => setImmediate(resolve)); }
  await operation(auth(), assertion, async () => undefined, 100);
});


test("MCP request preserves one exact typed effect failure rather than aggregating its awaited replay", async () => {
  const reason = Object.assign(new Error("authorization revoked"), { code: "grant_revoked" });
  const operation = createStreamingRequestOperation({ sessionId: "session", assert: () => undefined,
    write: async () => { throw reason; }, waitForOutput: async () => false, deliver: async () => false });
  await assert.rejects(operation(auth(), assertion, async (io) => { await io.write(Buffer.from("owned"), 100); }, 100),
    (error: unknown) => error === reason);
});
