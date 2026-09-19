import { McpManager } from "../src/mcp-tools.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";
import type { RunnerInternalOwnedProcess, RunnerInternalProcessKernel } from "../src/runner-internal-process-kernel.js";

for (const mode of ["valid", "mixed-schema-keys", "wrong-version", "duplicate-tools", "invalid-schema", "notification-write-timeout", "wrong-id-before-valid", "invalid-utf8"] as const)
test(`MCP ephemeral discovery ${mode} cannot advertise readiness before bounded protocol and cleanup`, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p682-discovery-protocol-")); t.diagnostic(`exact synthetic discovery root acquired: ${root}`);
  let sink: Parameters<RunnerInternalOwnedProcess["setOutputSink"]>[0] | undefined;
  let closes = 0; let active = false; let offset = 0; let sequence = 0; const methods: string[] = [];
  let release!: () => void; const pending = new Promise<void>((resolve) => { release = resolve; });
  const emit = async (bytes: Buffer) => {
    await sink?.({ stream: "stdout", sequence: ++sequence, startOffset: offset, endOffset: offset + bytes.length, byteLength: bytes.length, digest: createHash("sha256").update(bytes).digest("hex") }, bytes);
    offset += bytes.length;
  };
  const owned = {
    setOutputSink: (value: typeof sink) => { sink = value; return () => { sink = undefined; }; },
    write: async (bytes: Uint8Array) => {
      const request = JSON.parse(Buffer.from(bytes).toString()); methods.push(request.method);
      if (request.method === "notifications/initialized") { if (mode === "notification-write-timeout") await pending; return; }
      const result = request.method === "tools/list" ? { tools: mode === "duplicate-tools" ? [{ name: "dup" }, { name: "dup" }] :
        mode === "invalid-schema" ? [{ name: "bad", inputSchema: "string-not-schema" }] : [{ name: "lookup", inputSchema: { type: "object", ...(mode === "mixed-schema-keys" ? { properties: { a: { type: "string" }, Z: { type: "number" }, _key: { type: "boolean" } } } : {}) } }] } : {};
      if (mode === "wrong-id-before-valid") await emit(Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: request.id + 99, result }) + "\n"));
      if (mode === "invalid-utf8") await emit(Buffer.concat([Buffer.from('{"jsonrpc":"2.0","id":'), Buffer.from(String(request.id)), Buffer.from(',"result":"'), Buffer.from([255]), Buffer.from('"}\n')]));
      else await emit(Buffer.from(JSON.stringify({ jsonrpc: mode === "wrong-version" ? "1.0" : "2.0", id: request.id, result }) + "\n"));
    },
    closeVerified: async () => { closes++; active = false; release(); return { exitCode: 0 }; },
  } as unknown as RunnerInternalOwnedProcess;
  const kernel = { launch: async () => { active = true; return owned; }, activeCount: () => active ? 1 : 0,
    close: async () => { if (active) await owned.closeVerified({ shutdownTimeoutMs: 1, terminationTimeoutMs: 1 }); } } as RunnerInternalProcessKernel;
  const context = createRunnerInternalExecutionContext({ projectDirectory: root, stateDirectory: join(root, "state"), processKernel: kernel });
  let passed = false;
  try {
    const servers = [{ name: "docs", command: `"${process.execPath}"` }];
    const attested = await context.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig: { extensions: [], languageServers: [] } });
    const discoverer = context.createMcpDiscoveryExecutor({ runId: `discovery-${mode}`, servers, attestation: attested.mcp, requestTimeoutMs: 25, shutdownTimeoutMs: 25, terminationTimeoutMs: 25 });
    const result = await discoverer.discover(); await discoverer.close();
    assert.equal(result.servers[0]!.status, mode === "valid" || mode === "mixed-schema-keys" ? "ready" : "error");
    assert.equal(result.servers[0]!.cleanupVerified, true); assert.equal(closes, 1); assert.equal(active, false);
    assert.equal(methods.includes("tools/call"), false);
    if (mode === "notification-write-timeout") assert.equal(methods.includes("tools/list"), false, "cannot issue next RPC before initialized write acknowledgement");
    if (mode === "mixed-schema-keys") {
      const manager = new McpManager({ cwd: root, servers, runId: result.runId, discovery: result,
        transportFactory: { open: async () => assert.fail("readiness cannot open a transport") } });
      await manager.start();
      try { assert.equal(manager.status()[0]!.status, "ready", "discovery and live manager must hash arbitrary schema keys identically"); }
      finally { await manager.close(); }
    }
    passed = true;
  } finally { release(); await context.close(); if (passed) { await rm(root, { recursive: true }); t.diagnostic(`synthetic discovery root removed: ${root}`); } }
});
