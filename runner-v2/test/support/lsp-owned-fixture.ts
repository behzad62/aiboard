import { registerLspTestOwner, disposeLspTestRoot } from "./lsp-test-scope.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ArtifactStore } from "../../src/artifact-store.js";
import { createExecutionHost, type ExecutionHost, type ExecutionHostRunBinding } from "../../src/execution-host.js";
import { createExecutionHostLspTransportFactory } from "../../src/execution-host-lsp-transport.js";
import { LspClient, type LspClientOptions } from "../../src/lsp-client.js";
import type { LspTransportFactory, LspOwnedTransport } from "../../src/lsp-transport.js";
import type { LanguageInvocationContext } from "../../src/language-intelligence.js";
import type { RunnerCapabilityContract } from "../../src/runner-capability-contract.js";
import { emptyRunnerCapabilitiesConfig } from "../../src/runner-capabilities-config.js";

let sequence = 0;
/** Test-only composition of the real execution host, real grants and LSP adapter.
 * No private process launch, PID control or global production default is added. */
export function createOwnedLspFixture(root: string, workspace: string,
  ambientEnvironment: Readonly<Record<string, string | undefined>> = {}) {
  const state = root === workspace ? mkdtempSync(join(tmpdir(), "p683-external-state-")) : join(root, `lsp-shared-state-${++sequence}`); mkdirSync(state, { recursive: true });
  const runId = `lsp-fixture-${sequence}`;
  let host: ExecutionHost | undefined; let run: ExecutionHostRunBinding | undefined;
  let preparing: Promise<ExecutionHostRunBinding> | undefined;
  const clients = new Set<LspClient>(); let call = 0; let closed = false;
  const ensure = async () => {
    if (closed) throw new Error("Exact LSP fixture owner is closed.");
    return await (preparing ??= (async () => {
      host = createExecutionHost({ projectRoot: workspace, stateDirectory: state, ambientEnvironment, artifacts: new ArtifactStore(join(state, "artifacts")) });
      run = await host.bindRun({ runId, permissionProfile: "full", capabilityContract: { digest: "a".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
      return run;
    })());
  };
  const transportFactory: LspTransportFactory = { open: async (request) => {
    const current = await ensure();
    return await createExecutionHostLspTransportFactory({ run: current, permissionProfile: "full", environment: host!.filteredEnvironmentSource() }).open(request);
  } };
  async function invoke<T>(perform: (context: LanguageInvocationContext) => Promise<T>, signal?: AbortSignal, agent = "fixture-agent", toolName = "code.diagnostics"): Promise<T> {
    const current = await ensure();
    const binding = { runId, sessionId: agent, actor: { role: "worker" as const, id: "fixture-worker" }, callId: `fixture-call-${++call}`, toolName, permissionProfile: "full" as const };
    const grant = await current.executionGrants.issue({ ...binding, workspacePath: workspace, access: [{ path: workspace, mode: "read" }], externalApproved: false, destructiveApproved: false, networkApproved: false });
    let failed = false; let primary: unknown; let result: T | undefined;
    try { result = await perform(Object.freeze({ ...binding, actor: Object.freeze(binding.actor), workspacePath: workspace, executionGrant: grant, ...(signal ? { signal } : {}) })); }
    catch (error) { failed = true; primary = error; }
    try { await current.executionGrants.revoke(grant, signal?.aborted ? "cancelled" : "completed"); }
    catch (cleanup) { throw new AggregateError(failed ? [primary, cleanup] : [cleanup], "LSP test call grant cleanup failed."); }
    if (failed) throw primary; return result!;
  }
  const fixture = {
    root, state, runId, transportFactory, ensure, invoke,
    client(options: LspClientOptions, hook?: (close: () => Promise<void>) => Promise<void>): LspClient {
      const injected: LspTransportFactory = hook ? { open: async (request) => {
        const actual = await transportFactory.open(request);
        return { withInvocation: actual.withInvocation.bind(actual), closeVerified: (shutdown, timeout) => hook(() => actual.closeVerified(shutdown, timeout)) } satisfies LspOwnedTransport;
      } } : transportFactory;
      const actual = new LspClient({ ...options, transportFactory: injected }); clients.add(actual);
      const operations = new Set(["start", "request", "openDocument", "updateDocument", "closeDocument", "diagnosticSupport", "waitForPublishedDiagnostics", "waitForPublishedDiagnosticSnapshot"]);
      return new Proxy(actual, { get(target, key) {
        const value = Reflect.get(target, key, target);
        if (typeof value !== "function") return value;
        if (!operations.has(String(key))) return value.bind(target);
        return (...args: unknown[]) => {
          const signal = args.find((arg) => arg instanceof AbortSignal) as AbortSignal | undefined;
          return invoke((context) => target.withInvocation(context, async () => await Reflect.apply(value, target, args)), signal);
        };
      } });
    },
    async close(): Promise<void> {
      const failures: unknown[] = [];
      try { await preparing; } catch (error) { failures.push(error); }
      for (const client of [...clients].reverse()) { try { await client.close(); } catch (error) { failures.push(error); } }
      try { await run?.close(); } catch (error) { failures.push(error); }
      try { await host?.close(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, `LSP fixture retains exact unverified state at ${state}.`);
      if (run) {
        assert.equal(run.snapshot().closed, true);
        assert.deepEqual(host!.activeRunIds(), []);
        assert.deepEqual(readdirSync(join(run.runRoot, "process-backend")), []);
      }
      closed = true;
      if (root === workspace) await disposeLspTestRoot(state);
    },
  };
  registerLspTestOwner(fixture.close);
  return fixture;
}
