import assert from "node:assert/strict";
import test from "node:test";
import { createStreamingRequestOperation } from "../src/streaming-request-operation.js";
import type { SessionOperationAuthorization, OperationAuthorizationAssertion } from "../src/session-authority.js";
const authorization = () => Object.freeze({}) as SessionOperationAuthorization;
const assertion = { sessionId: "lsp", operation: "language_request", binding: { runId: "run", sessionId: "agent", actor: { role: "worker", id: "worker" }, callId: "code-call", toolName: "code.definition", permissionProfile: "full" }, requestAccess: [], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false } as unknown as OperationAuthorizationAssertion;
function fixture() {
  const writes: string[] = []; const assertions: string[] = []; let current = true;
  const input = { operation: "language_request" as const, sessionId: "lsp",
    assert: (_auth: SessionOperationAuthorization, expected: OperationAuthorizationAssertion) => { assert.equal(expected.operation, "language_request"); if (!current) throw new Error("revoked exact language authority"); assertions.push(expected.binding.callId); },
    write: async (bytes: Uint8Array, _timeout: number, check: () => void) => { check(); writes.push(Buffer.from(bytes).toString()); },
    waitForOutput: async () => true,
    deliver: async (_auth: SessionOperationAuthorization, expected: OperationAuthorizationAssertion, deliver: (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>, check: () => void) => { assert.equal(expected.operation, "language_request"); check(); await deliver("stdout", Buffer.from("reply")); return true; },
  };
  return { writes, assertions, input, operation: createStreamingRequestOperation(input), revoke: () => { current = false; } };
}
test("LSP compound call permits bounded document notifications and query under one exact authorization", async () => {
  const f = fixture(); const grant = authorization();
  const result = await f.operation(grant, assertion, async (io) => {
    await io.write(Buffer.from("didOpen"), 100); await io.write(Buffer.from("definition"), 100);
    assert.equal(await io.waitForOutput(), true); let reply = "";
    await io.deliverOutput(async (_stream, bytes) => { reply = Buffer.from(bytes).toString(); }); return reply;
  }, 1000);
  assert.equal(result, "reply"); assert.deepEqual(f.writes, ["didOpen", "definition"]);
  assert.ok(f.assertions.length >= 6); assert.ok(f.assertions.every((id) => id === "code-call"));
  await assert.rejects(f.operation(grant, assertion, async () => undefined, 100), /used|replay/);
});
test("LSP compound call stops at its protocol-write ceiling and retains revocation checks", async () => {
  const f = fixture();
  await f.operation(authorization(), assertion, async (io) => {
    for (let i = 0; i < 256; i++) await io.write(Buffer.from("bounded"), 100);
    await assert.rejects(io.write(Buffer.from("overflow"), 100), /bound|limit|writes/);
  }, 1000);
  assert.equal(f.writes.length, 256);
  await assert.rejects(f.operation(authorization(), assertion, async (io) => { f.revoke(); await io.write(Buffer.from("forbidden"), 100); }, 100), /revoked/);
  assert.equal(f.writes.length, 256);
});
test("LSP and MCP operation kinds share exclusivity without widening MCP single-write authority", async () => {
  const state = { active: false }; let release!: () => void; const held = new Promise<void>((r) => { release = r; });
  const base = { sessionId: "lsp", executionState: state, assert: () => undefined, write: async () => undefined, waitForOutput: async () => false, deliver: async () => false };
  const lsp = createStreamingRequestOperation({ ...base, operation: "language_request" } as Parameters<typeof createStreamingRequestOperation>[0]);
  const mcp = createStreamingRequestOperation(base);
  const running = lsp(authorization(), assertion, async () => held, 1000);
  try { await Promise.resolve(); await assert.rejects(mcp(authorization(), { ...assertion, operation: "request" }, async () => undefined, 100), /progress/); }
  finally { release(); await running; }
  await mcp(authorization(), { ...assertion, operation: "request" }, async (io) => {
    await io.write(Buffer.from("one"), 100); await assert.rejects(io.write(Buffer.from("two"), 100), /one request write/);
  }, 1000);
});
