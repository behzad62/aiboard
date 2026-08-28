import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";

import { createChildEnvironmentFactory } from "../src/child-environment.js";
import type { ExecutionInvocationIntent } from "../src/execution-safety-contracts.js";
import { InMemoryDurableProcessStore, SqliteDurableProcessStore, type DurableProcessStore } from "../src/durable-process-store.js";
import type { ProcessBackend, ProcessBackendBinding, ProcessBackendRegistryEntry } from "../src/process-backend.js";
import { SubprocessRuntime, SubprocessRuntimeError, type ProcessOutputFactory, type RunnerPrivateExecutionGrantAuthority, type SubprocessRuntimeClock } from "../src/subprocess-runtime.js";

const capabilities = { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" } as const;
const intent = (id = "invoke-1", command = "tool"): ExecutionInvocationIntent => ({ invocationId: id, runId: "run-1", kind: "command", executable: command, arguments: ["--secret-value"], workingDirectory: "C:\\host\\project", requestedCapabilities: ["tree_termination", "verified_emptiness"] });

class Grants implements RunnerPrivateExecutionGrantAuthority {
  readonly calls: string[] = [];
  constructor(readonly values = new Map<string, unknown>()) {}
  consume(id: string): unknown { this.calls.push(id); const value = this.values.get(id); if (!value) throw new Error("missing"); this.values.delete(id); return value; }
}
const grantValue = (invocationId = "invoke-1", overrides: Record<string, unknown> = {}) => ({ grantId: `grant-${invocationId}`, runId: "run-1", invocationId, issuedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2026-01-01T01:00:00.000Z", access: [], ...overrides });

class Clock implements SubprocessRuntimeClock {
  current = new Date("2026-01-01T00:00:00.000Z"); readonly sleeps: number[] = [];
  now = () => new Date(this.current);
  sleep = async (ms: number) => { this.sleeps.push(ms); this.current = new Date(this.current.getTime() + ms); };
}

class Outputs implements ProcessOutputFactory {
  readonly calls: string[] = []; readonly chunks: string[] = [];
  failFinalizeFor = new Set<string>(); failReopenFor = new Set<string>();
  async prepare(ownerId: string) { this.calls.push(`prepare:${ownerId}`); return this.session(ownerId); }
  async reopen(ownerId: string) { this.calls.push(`reopen:${ownerId}`); if (this.failReopenFor.has(ownerId)) throw new Error("reopen failed"); return this.session(ownerId); }
  private session(ownerId: string) { return { ownerId, write: async (_stream: "stdout"|"stderr", bytes: Uint8Array) => { this.chunks.push(Buffer.from(bytes).toString()); }, finalize: async () => { this.calls.push(`finalize:${ownerId}`); if (this.failFinalizeFor.has(ownerId)) throw new Error("finalize failed"); return { streams: [{ stream: "stdout" as const, tail: this.chunks.join(""), tailBytesBase64: Buffer.from(this.chunks.join("")).toString("base64"), tailByteLength: Buffer.byteLength(this.chunks.join("")), tailDisplayTruncated: false, totalBytes: Buffer.byteLength(this.chunks.join("")), truncated: false, spillBytes: 0, lossyBytes: 0, lossyOutput: false, lossReasons: [], spillState: "empty" as const }, { stream: "stderr" as const, tail: "", tailBytesBase64: "", tailByteLength: 0, tailDisplayTruncated: false, totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0, lossyOutput: false, lossReasons: [], spillState: "empty" as const }] }; }, cleanup: async () => { this.calls.push(`cleanup:${ownerId}`); } }; }
}

class Backend implements ProcessBackend {
  readonly calls: string[] = []; probeValue: unknown = { attestationVersion: 1, backendId: "fake", verified: true, platformLabel: "fixture", capabilities };
  launchValue: unknown = { opaqueIdentity: "opaque-1", birthFingerprint: { observedAt: "2026-01-01T00:00:00.000Z", discriminator: "birth-1" }, rootPid: 42, startedAt: "2026-01-01T00:00:00.000Z" };
  observeValue: unknown = { state: "exited", exitCode: 0 }; verifyValue: unknown = { empty: true, proofArtifactId: "proof" }; reconcileValue: unknown = { state: "exited", exitCode: 0 }; releaseValue: unknown = { released: true }; signalValues: unknown[] = [{ state: "exited" }]; launchGate?: Promise<void>; observeGate?:Promise<void>;onSignal?:(action:string)=>void;
  probe = async () => { this.calls.push("probe"); return this.probeValue; };
  observe = async (_binding: ProcessBackendBinding, output: (stream:"stdout"|"stderr",bytes:Uint8Array)=>Promise<void>) => { this.calls.push("observe"); await output("stdout",Buffer.from("child"));await this.observeGate; return this.observeValue; };
  onLaunch?:()=>void;
  launch = async () => { this.calls.push("launch");this.onLaunch?.(); await this.launchGate; return this.launchValue; };
  signal = async (_binding: ProcessBackendBinding, action: string) => { this.calls.push(`signal:${action}`);this.onSignal?.(action); return this.signalValues.shift() ?? { state: "exited" }; };
  verifyEmpty = async () => { this.calls.push("verify"); return this.verifyValue; };
  reconcile = async () => { this.calls.push("reconcile"); return this.reconcileValue; };
  release = async () => { this.calls.push("release"); return this.releaseValue; };
}

function deferred() { let resolve!:()=>void; const promise = new Promise<void>((done)=>{resolve=done;}); return {promise,resolve}; }
function fixture(id = "invoke-1") {
  const key = Object.freeze({}); const store = new InMemoryDurableProcessStore(key); const backend = new Backend(); const grants = new Grants(new Map([[`grant-${id}`,grantValue(id)]])); const clock = new Clock(); const outputs = new Outputs();
  const entries: ProcessBackendRegistryEntry[] = [{ registryId:"registry-fake-v1",backendId:"fake",backend }];
  const environments = createChildEnvironmentFactory({ credentialResolver:{consume:()=>{throw new Error("unused");}},now:()=>clock.now() });
  const runtime = new SubprocessRuntime({ backends:entries,store,storeAuthority:key,grants,clock,environments,outputs,createLogicalProcessId:(invocationId)=>`proc-${invocationId}`,escalationGraceMs:[10,20] });
  return {runtime,store,backend,grants,clock,outputs,entries,key};
}
function runtimeFor(store:DurableProcessStore,key:object,backend:Backend,grants:Grants,clock:Clock,outputs:Outputs){const environments=createChildEnvironmentFactory({credentialResolver:{consume:()=>{throw new Error("unused");}},now:()=>clock.now()});return new SubprocessRuntime({backends:[{registryId:"registry-fake-v1",backendId:"fake",backend}],store,storeAuthority:key,grants,clock,environments,outputs,createLogicalProcessId:(invocationId)=>`proc-${invocationId}`,escalationGraceMs:[10,20]});}

test("caller can provide only an opaque grant id and forged grant/result fields are rejected", async () => {
  const {runtime,backend,grants}=fixture();
  await assert.rejects(runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{},grant:grantValue(),stopReason:"cancelled"} as never), /unknown invocation field/i);
  assert.equal(grants.calls.length,0); assert.equal(backend.calls.includes("launch"),false);
});

test("Runner-private grant is atomically consumed, strictly snapshotted, run-bound, and expiry checked", async () => {
  const expired=fixture(); expired.grants.values.set("grant-invoke-1",grantValue("invoke-1",{expiresAt:"2025-01-01T00:00:00.000Z"}));
  await assert.rejects(expired.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}), /execution grant/i);
  assert.equal(expired.backend.calls.includes("launch"),false);
  const forged=fixture(); forged.grants.values.set("grant-invoke-1",Object.defineProperty(grantValue(),"runId",{enumerable:true,get:()=>"run-1"}));
  await assert.rejects(forged.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}), /execution grant/i);
  const future=fixture();future.grants.values.set("grant-invoke-1",grantValue("invoke-1",{issuedAt:"2027-01-01T00:00:00.000Z"}));await assert.rejects(future.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}),/execution grant/i);
});

test("concurrent exact invocations share one operation while divergent retries conflict", async () => {
  const {runtime,backend}=fixture();
  const [left,right]=await Promise.all([runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{PATH:"safe"}}),runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{PATH:"other-value"}})]);
  assert.deepEqual(right,left); assert.equal(backend.calls.filter((call)=>call==="launch").length,1);
  await assert.rejects(runtime.invoke({intent:intent("invoke-1","different"),grantId:"grant-invoke-1",ambientEnvironment:{PATH:"safe"}}), /idempotency conflict/i);
});

test("concurrent runtimes over separate SQLite connections observe one operation and persist no request secrets",async(t)=>{const root=await mkdtemp(join(tmpdir(),"runner-v2-runtime-sqlite-"));t.after(async()=>rm(root,{recursive:true,force:true}));const path=join(root,"process.sqlite");const key=Object.freeze({});const firstStore=new SqliteDurableProcessStore(path,{runtimeAuthority:key});const secondStore=new SqliteDurableProcessStore(path,{runtimeAuthority:key});const backend=new Backend();const grants=new Grants(new Map([["grant-invoke-1",grantValue()]]));const clock=new Clock();const outputs=new Outputs();const first=runtimeFor(firstStore,key,backend,grants,clock,outputs);const second=runtimeFor(secondStore,key,backend,grants,clock,outputs);const [left,right]=await Promise.all([first.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{API_KEY:"secret-value",PATH:"one"}}),second.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{API_KEY:"different-secret",PATH:"two"}})]);assert.deepEqual(right,left);assert.equal(backend.calls.filter((call)=>call==="launch").length,1);firstStore.close();secondStore.close();const bytes=await readFile(path);for(const forbidden of ["secret-value","different-secret","--secret-value","C:\\host\\project","nativeHandle","spill.tmp"])assert.equal(bytes.includes(Buffer.from(forbidden)),false,forbidden);});

test("deadline is runtime-owned and persists interrupt terminate force escalation before effects", async () => {
  const {runtime,store,backend}=fixture(); backend.signalValues=[{state:"running"},{state:"running"},{state:"exited"}];backend.onSignal=()=>assert.equal(store.readByInvocation("invoke-1")?.escalation.at(-1)?.outcome,"requested");
  const result=await runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{},deadline:new Date("2026-01-01T00:00:01.000Z")});
  assert.equal(result.outcome,"timed_out"); assert.deepEqual(backend.calls.filter((call)=>call.startsWith("signal:")),["signal:interrupt","signal:terminate","signal:force_terminate"]);
  assert.deepEqual(store.readByInvocation("invoke-1")?.escalation.map(({action})=>action),["interrupt","terminate","force_terminate"]);
});

test("cancellation during launch queues durable stop and signals only after identity bind", async () => {
  const {runtime,store,backend}=fixture(); const gate=deferred(); backend.launchGate=gate.promise;
  const running=runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}});
  await Promise.resolve(); await Promise.resolve();
  const cancellation=runtime.cancel("invoke-1");
  assert.equal(backend.calls.some((call)=>call.startsWith("signal:")),false); assert.equal(store.readByInvocation("invoke-1")?.stopIntent?.reason,"cancelled");
  gate.resolve(); await Promise.all([running,cancellation]);
  assert.equal(backend.calls.some((call)=>call.startsWith("signal:")),true);
});

test("terminal cancel is a read-only no-op and never signals a cleaned process", async () => {
  const {runtime,store,backend}=fixture(); await runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}); const before=store.readByInvocation("invoke-1");
  assert.equal(await runtime.cancel("invoke-1"),false); assert.deepEqual(store.readByInvocation("invoke-1"),before); assert.equal(backend.calls.filter((call)=>call.startsWith("signal:")).length,0);
});

test("fresh attestation mismatch blocks cancellation authority before signal", async () => {
  const {runtime,backend,store}=fixture();const gate=deferred();backend.observeGate=gate.promise;const operation=runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}});for(let i=0;i<20&&store.readByInvocation("invoke-1")?.state!=="running";i+=1)await Promise.resolve();
  backend.probeValue={attestationVersion:1,backendId:"fake",verified:true,platformLabel:"replacement",capabilities};
  assert.equal(await runtime.cancel("invoke-1"),false); assert.equal(backend.calls.filter((call)=>call.startsWith("signal:")).length,0);assert.equal(store.readByInvocation("invoke-1")?.state,"identity_mismatch");gate.resolve();await assert.rejects(operation);
});

test("restart preserves durable timeout precedence after observation loss",async()=>{const f=fixture();f.backend.observeValue=new Proxy({},{});await assert.rejects(f.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{},deadline:new Date("2026-01-01T00:00:01.000Z")}));assert.equal(f.store.readByInvocation("invoke-1")?.stopIntent?.reason,"timed_out");f.backend.observeValue={state:"exited",exitCode:0};await f.runtime.reconcileStartup();assert.equal(f.store.readByInvocation("invoke-1")?.result?.outcome,"timed_out");});

test("restart resumes an escalation whose durable request preceded a crash",async()=>{const f=fixture();f.backend.observeValue=new Proxy({},{});await assert.rejects(f.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}));const writer=f.store.connectRuntime(f.key);let record=f.store.readByInvocation("invoke-1")!;record=writer.apply({type:"request_stop",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString(),reason:"cancelled"});record=writer.apply({type:"start_escalation",invocationId:record.invocationId,expectedRevision:record.revision,action:"interrupt",requestedAt:f.clock.now().toISOString()});assert.equal(record.escalation.at(-1)?.outcome,"requested");f.backend.reconcileValue={state:"running"};f.backend.observeValue={state:"exited",exitCode:0};f.backend.signalValues=[{state:"exited"}];await f.runtime.reconcileStartup();assert.equal(f.store.readByInvocation("invoke-1")?.state,"cleaned");assert.equal(f.store.readByInvocation("invoke-1")?.result?.outcome,"cancelled");assert.deepEqual(f.backend.calls.filter((call)=>call.startsWith("signal:")),["signal:interrupt"]);});

test("durable timeout and cancellation outrank later cleanup failure",async()=>{const f=fixture();f.backend.verifyValue={empty:false,detail:"descendant remains"};const result=await f.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{},deadline:new Date("2026-01-01T00:00:01.000Z")});assert.equal(result.outcome,"timed_out");assert.equal(f.store.readByInvocation("invoke-1")?.state,"cleanup_blocked");});

test("malformed backend results are classified and never become verified success", async () => {
  const launch=fixture(); launch.backend.launchValue={opaqueIdentity:"opaque",birthFingerprint:{observedAt:"x",discriminator:"d"},startedAt:"x",extra:true};
  await assert.rejects(launch.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}),(error:SubprocessRuntimeError)=>error.code==="launch_not_proven");
  const verify=fixture(); verify.backend.verifyValue={empty:"false",detail:"descendant"};
  const result=await verify.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}); assert.equal(result.outcome,"cleanup_failed"); assert.equal(verify.store.readByInvocation("invoke-1")?.state,"cleanup_blocked");
});

test("output ownership is prepared before launch and finalized before verified cleanup", async () => {
  const {runtime,backend,outputs}=fixture();backend.onLaunch=()=>assert.deepEqual(outputs.calls,["prepare:output-proc-invoke-1"]); await runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}});
  assert.deepEqual(outputs.calls,["prepare:output-proc-invoke-1","finalize:output-proc-invoke-1"]);
});

test("restart reopens output, preserves stop precedence, and isolates one record failure from later recovery", async () => {
  const first=fixture("first"); const secondIntent=intent("second");
  // Build two recoverable rows through real runtime/store commands by crashing observation.
  first.backend.observeValue=new Proxy({},{}); first.grants.values.set("grant-second",grantValue("second"));
  await assert.rejects(first.runtime.invoke({intent:intent("first"),grantId:"grant-first",ambientEnvironment:{}}));
  await assert.rejects(first.runtime.invoke({intent:secondIntent,grantId:"grant-second",ambientEnvironment:{}}));
  const firstRecord=first.store.readByInvocation("first")!; first.outputs.failReopenFor.add(firstRecord.outputOwnerId);
  first.backend.observeValue={state:"exited",exitCode:0};
  const outcomes=await first.runtime.reconcileStartup();
  assert.equal(outcomes.length,2); assert.equal(outcomes[0]?.state,"outcome_unknown"); assert.equal(first.store.readByInvocation("second")?.state,"cleaned");
  assert.ok(first.outputs.calls.includes(`reopen:${first.store.readByInvocation("second")?.outputOwnerId}`));
});

test("reconciliation matrix maps running exited mismatch and unknown without illegal stale transitions", async () => {
  for (const [state,want] of [["identity_mismatch","identity_mismatch"],["outcome_unknown","outcome_unknown"],["exited","cleaned"]] as const) {
    const f=fixture(); f.backend.observeValue=new Proxy({},{}); await assert.rejects(f.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}));
    f.backend.reconcileValue=state==="exited"?{state:"exited",exitCode:0}:{state}; f.backend.observeValue={state:"exited",exitCode:0};
    await f.runtime.reconcileStartup(); assert.equal(f.store.readByInvocation("invoke-1")?.state,want);
  }
});
