import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { createRunnerInternalExecutionContext } from "../src/runner-internal-execution-context.js";
import type { RunnerInternalOwnedProcess, RunnerInternalProcessKernel } from "../src/runner-internal-process-kernel.js";

for (const timing of ["before-discover", "during-launch"] as const) {
  test(`MCP discovery close ${timing} cannot publish or omit a late-owned process`, async (t) => {
    const root = await mkdtemp(join(tmpdir(), "p682-discovery-close-"));
    t.diagnostic(`exact synthetic discovery lifecycle root: ${root}`);
    let launches = 0; let closes = 0; let active = false; let passed = false;
    let sink: Parameters<RunnerInternalOwnedProcess["setOutputSink"]>[0] | undefined;
    let entered!: () => void; const entering = new Promise<void>((resolve) => { entered = resolve; });
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    let sequence = 0; let offset = 0;
    const owned = {
      setOutputSink(value: typeof sink) { sink = value; return () => { sink = undefined; }; },
      async write(bytes: Uint8Array) {
        const message = JSON.parse(Buffer.from(bytes).toString());
        if (message.id === undefined) return;
        const reply = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id,
          result: message.method === "tools/list" ? { tools: [] } : {} }) + "\n");
        await sink?.({ stream: "stdout", sequence: ++sequence, startOffset: offset, endOffset: offset + reply.length,
          byteLength: reply.length, digest: createHash("sha256").update(reply).digest("hex") }, reply);
        offset += reply.length;
      },
      async closeVerified() { closes++; active = false; return { exitCode: 0 }; },
    } as unknown as RunnerInternalOwnedProcess;
    const kernel = {
      async launch() { launches++; entered(); if (timing === "during-launch") await gate; active = true; return owned; },
      activeCount: () => active ? 1 : 0,
      async close() { if (active) await owned.closeVerified({ shutdownTimeoutMs: 1, terminationTimeoutMs: 1 }); },
    } as RunnerInternalProcessKernel;
    const context = createRunnerInternalExecutionContext({ projectDirectory: root, stateDirectory: join(root, "state"), processKernel: kernel });
    const servers = [{ name: "docs", command: `"${process.execPath}"` }];
    let running: Promise<unknown> | undefined; let closing: Promise<void> | undefined;
    try {
      const attestation = await context.attestConfiguredCapabilities({ mcpServers: servers, capabilitiesConfig: { extensions: [], languageServers: [] } });
      const executor = context.createMcpDiscoveryExecutor({ runId: `close-${timing}`, servers, attestation: attestation.mcp, requestTimeoutMs: 100 });
      if (timing === "before-discover") {
        await executor.close();
        await assert.rejects(executor.discover(), /closed|completed|unavailable/i);
        assert.equal(launches, 0);
      } else {
        running = executor.discover(); void running.catch(() => undefined);
        await entering;
        let completed = false;
        closing = executor.close().then(() => { completed = true; });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(completed, false, "close must join the exact in-flight acquisition before claiming cleanup");
        release(); await Promise.allSettled([running]); await closing;
        assert.equal(closes, 1, "the late-acquired exact process must be closed once");
        assert.equal(active, false);
      }
      passed = true;
    } finally {
      release(); await Promise.allSettled([running, closing]); await context.close();
      // Only a synthetic in-memory process exists. This RED finalizer never
      // signals native PIDs and does not turn a failed assertion into acceptance.
      await kernel.close(); assert.equal(active, false);
      if (passed) { await rm(root, { recursive: true }); t.diagnostic(`closed synthetic root removed: ${root}`); }
      else t.diagnostic(`failed synthetic evidence retained: ${root}`);
    }
  });
}
