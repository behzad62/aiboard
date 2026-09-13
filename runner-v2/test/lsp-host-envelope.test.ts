import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost, type ExecutionHostRunBinding } from "../src/execution-host.js";
import { createExecutionHostLspTransportFactory } from "../src/execution-host-lsp-transport.js";
import { LspClient } from "../src/lsp-client.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import type { RunnerCapabilityContract } from "../src/runner-capability-contract.js";
import type { OpaqueExecutionGrant } from "../src/execution-grants.js";
import { finalizeCertifiedFixture } from "./support/certified-fixture-cleanup.js";

const serverSource = `let input=Buffer.alloc(0);
const send=(id,result)=>{const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',id,result}));process.stdout.write(Buffer.concat([Buffer.from('Content-Length: '+body.length+'\\r\\n\\r\\n'),body]));};
process.stdin.on('data',chunk=>{input=Buffer.concat([input,chunk]);for(;;){const boundary=input.indexOf('\\r\\n\\r\\n');if(boundary<0)return;const size=Number(/Content-Length: (\\d+)/i.exec(input.subarray(0,boundary).toString())[1]);if(input.length<boundary+4+size)return;const message=JSON.parse(input.subarray(boundary+4,boundary+4+size));input=input.subarray(boundary+4+size);
if(message.method==='initialize')send(message.id,{capabilities:{}});else if(message.method==='shutdown')send(message.id,null);else if(message.method==='exit')process.exit(0);else if(message.id!==undefined)send(message.id,{credentialPresent:['OPENAI_API_KEY','ANTHROPIC_FOUNDRY_API_KEY','AZURE_OPENAI_API_KEY','SERVICE_PRIVATE_KEY'].some(key=>process.env[key]!==undefined),safeValue:process.env.LSP_ENVELOPE_SAFE});}});`;

test("LSP actual shared launch scrubs inherited credentials and persists explicit unconfined Full disclosure", { timeout: 120_000 }, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "p683-lsp-envelope-")); t.diagnostic(`exact LSP envelope root acquired: ${root}`);
  const project = join(root, "project"), state = join(root, "state"), script = join(project, "server.mjs");
  await mkdir(project); await mkdir(state); await writeFile(script, serverSource);
  // Only synthetic credential values enter even a deliberate RED launch.
  const safe = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && /^(path|pathext|systemroot|windir|comspec|temp|tmp)$/i.test(key)));
  const ambientEnvironment = { ...safe, LSP_ENVELOPE_SAFE: "retained", OPENAI_API_KEY: "SYNTHETIC_LSP_OPENAI", ANTHROPIC_FOUNDRY_API_KEY: "SYNTHETIC_LSP_FOUNDRY", AZURE_OPENAI_API_KEY: "SYNTHETIC_LSP_AZURE", SERVICE_PRIVATE_KEY: "SYNTHETIC_LSP_PRIVATE" };
  const host = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment });
  let run: ExecutionHostRunBinding | undefined, client: LspClient | undefined, grant: OpaqueExecutionGrant | undefined;
  let failed = false, primary: unknown;
  try {
    run = await host.bindRun({ runId: "lsp-envelope", permissionProfile: "full", capabilityContract: { digest: "e".repeat(64) } as RunnerCapabilityContract, capabilitiesConfig: emptyRunnerCapabilitiesConfig() });
    const binding = { runId: run.runId, sessionId: "exact-agent", actor: { role: "worker" as const, id: "exact-worker" }, callId: "exact-call", toolName: "code.diagnostics", permissionProfile: "full" as const };
    grant = await run.executionGrants.issue({ ...binding, workspacePath: project, access: [{ path: project, mode: "read" }], externalApproved: false, destructiveApproved: false, networkApproved: false });
    client = new LspClient({ command: process.execPath, args: [script], workspaceRoot: project, requestTimeoutMs: 5000,
      transportFactory: createExecutionHostLspTransportFactory({ run, permissionProfile: "full", environment: host.filteredEnvironmentSource() }) });
    const result = await client.withInvocation({ ...binding, workspacePath: project, executionGrant: grant }, () => client!.request("fixture/environment", {}));
    assert.deepEqual(result, { credentialPresent: false, safeValue: "retained" });
    const ids = run.streamingState.listSessionIds(); assert.equal(ids.length, 1);
    const record = run.streamingState.readSession(ids[0]!)!;
    assert.equal(record.lease.providerId, "runner-unconfined-explicit-full");
    assert.deepEqual(record.envelope.credentialNames, []); assert.equal(record.envelope.networkApproved, false);
    const disclosure = (await run.isolation.enforcementState()).records.find((entry) => entry.invocationId === record.lease.invocationId);
    assert.equal(disclosure?.enforcement, "unconfined_explicit_full"); assert.equal(disclosure?.disclosure, "unconfined_explicit_full");
    await run.executionGrants.revoke(grant, "completed"); grant = undefined;
    await client.close();
    const released = run.streamingState.readSession(ids[0]!)!; assert.equal(released.state, "released");
    const facts = released.effects.flatMap((effect) => effect.progress?.resources ?? []); assert.equal(facts.length, 6); assert.ok(facts.every((fact) => fact.status === "verified"));
  } catch (error) { failed = true; primary = error; }
  finally { await finalizeCertifiedFixture({ fixtureName: "LSP native credential envelope", root, hasPrimaryFailure: failed, primaryFailure: primary,
    cleanup: async () => { const errors: unknown[] = []; for (const close of [async () => { if (grant) await run!.executionGrants.revoke(grant, "completed"); }, () => client?.close(), () => run?.close(), () => host.close()]) { try { await close(); } catch (error) { errors.push(error); } } if (errors.length) throw new AggregateError(errors, "Exact LSP envelope cleanup remains unverified"); },
    certify: async () => { assert.deepEqual(host.activeRunIds(), []); },
    removeRoot: async () => { await rm(root, { recursive: true }); t.diagnostic(`verified LSP envelope root removed: ${root}`); } }); }
});
