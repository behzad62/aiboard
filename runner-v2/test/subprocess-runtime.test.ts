import assert from "node:assert/strict";
import test from "node:test";
import {mkdtemp,readFile,rm} from "node:fs/promises";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {DatabaseSync} from "node:sqlite";

import { createChildEnvironmentFactory } from "../src/child-environment.js";
import type { ExecutionInvocationIntent } from "../src/execution-safety-contracts.js";
import { createInMemoryDurableProcessKernel, getDurableProcessRuntimeWriter, openSqliteDurableProcessKernel, type DurableProcessStoreKernel } from "../src/durable-process-store.js";
import { createProcessBackendRegistry, selectProcessBackend, type ProcessBackend, type ProcessBackendBinding, type ProcessLaunchRequest } from "../src/process-backend.js";
import { createSubprocessRuntimeKernel, SubprocessRuntimeError, type ProcessOutputFactory, type RunnerPrivateExecutionGrantAuthority, type SubprocessRuntime, type SubprocessRuntimeClock } from "../src/subprocess-runtime.js";

const capabilities = { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "enforced" } as const;
const intent = (id = "invoke-1", command = "tool"): ExecutionInvocationIntent => ({ invocationId: id, runId: "run-1", kind: "command", executable: command, arguments: ["--secret-value"], workingDirectory: "C:\\host\\project", requestedCapabilities: ["tree_termination", "verified_emptiness"] });

class Grants implements RunnerPrivateExecutionGrantAuthority {
  readonly calls: string[] = [];
  constructor(readonly values = new Map<string, unknown>()) {}
  bindingDigest(id:string):string{return Buffer.from(id).toString("hex").padEnd(64,"0").slice(0,64);}
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
  failFinalizeFor = new Set<string>(); failReopenFor = new Set<string>();prepareGate?:Promise<void>;failPrepare=false;
  async prepare(ownerId: string) { this.calls.push(`prepare:${ownerId}`);await this.prepareGate;if(this.failPrepare)throw new Error("prepare failed"); return this.session(ownerId); }
  async reopen(ownerId: string) { this.calls.push(`reopen:${ownerId}`); if (this.failReopenFor.has(ownerId)) throw new Error("reopen failed"); return this.session(ownerId); }
  private session(ownerId: string) { return { ownerId, write: async (_stream: "stdout"|"stderr", bytes: Uint8Array) => { this.chunks.push(Buffer.from(bytes).toString()); }, finalize: async () => { this.calls.push(`finalize:${ownerId}`); if (this.failFinalizeFor.has(ownerId)) throw new Error("finalize failed"); return { streams: [{ stream: "stdout" as const, tail: this.chunks.join(""), tailBytesBase64: Buffer.from(this.chunks.join("")).toString("base64"), tailByteLength: Buffer.byteLength(this.chunks.join("")), tailDisplayTruncated: false, totalBytes: Buffer.byteLength(this.chunks.join("")), truncated: false, spillBytes: 0, lossyBytes: 0, lossyOutput: false, lossReasons: [], spillState: "empty" as const }, { stream: "stderr" as const, tail: "", tailBytesBase64: "", tailByteLength: 0, tailDisplayTruncated: false, totalBytes: 0, truncated: false, spillBytes: 0, lossyBytes: 0, lossyOutput: false, lossReasons: [], spillState: "empty" as const }] }; }, cleanup: async () => { this.calls.push(`cleanup:${ownerId}`); } }; }
}

class Backend implements ProcessBackend {
  readonly calls: string[] = []; probeValue: unknown = { attestationVersion: 1, backendId: "fake", verified: true, platformLabel: "fixture", capabilities };
  launchValue: unknown = { opaqueIdentity: "opaque-1", birthFingerprint: { observedAt: "2026-01-01T00:00:00.000Z", discriminator: "birth-1" }, rootPid: 42, startedAt: "2026-01-01T00:00:00.000Z" };
  observeValue: unknown = { state: "exited", exitCode: 0 }; verifyValue: unknown = { empty: true, proofArtifactId: "proof" }; reconcileValue: unknown = { state: "exited", exitCode: 0 }; releaseValue: unknown = { released: true }; signalValues: unknown[] = [{ state: "exited" }]; launchGate?: Promise<void>; observeGate?:Promise<void>;onSignal?:(action:string)=>void;onRelease?:()=>void;
  probe = async () => { this.calls.push("probe"); return this.probeValue; };
  observe = async (_binding: ProcessBackendBinding, output: (stream:"stdout"|"stderr",bytes:Uint8Array)=>Promise<void>) => { this.calls.push("observe"); await output("stdout",Buffer.from("child"));await this.observeGate; return this.observeValue; };
  onLaunch?:(request:ProcessLaunchRequest)=>void;
  launch = async (request:ProcessLaunchRequest) => { this.calls.push("launch");this.onLaunch?.(request); await this.launchGate; return this.launchValue; };
  signal = async (_binding: ProcessBackendBinding, action: string) => { this.calls.push(`signal:${action}`);this.onSignal?.(action); return this.signalValues.shift() ?? { state: "exited" }; };
  verifyEmpty = async () => { this.calls.push("verify"); return this.verifyValue; };
  reconcile = async () => { this.calls.push("reconcile"); return this.reconcileValue; };
  release = async () => { this.calls.push("release");this.onRelease?.(); return this.releaseValue; };
}

function deferred() { let resolve!:()=>void; const promise = new Promise<void>((done)=>{resolve=done;}); return {promise,resolve}; }
function fixture(id = "invoke-1") {
  const stateKey=new Uint8Array(32).fill(9);const kernel=createInMemoryDurableProcessKernel(stateKey);const store=kernel.store; const backend = new Backend(); const grants = new Grants(new Map([[`grant-${id}`,grantValue(id)]])); const clock = new Clock(); const outputs = new Outputs();
  const registry=createProcessBackendRegistry([{ registryId:"registry-fake-v1",backendId:"fake",implementationGeneration:"fake-generation-v1",backend }]);
  const environments = createChildEnvironmentFactory({ credentialResolver:{consume:()=>{throw new Error("unused");}},now:()=>clock.now() });
  const runtime=createSubprocessRuntimeKernel({registry,storeKernel:kernel,stateKey,grants,clock,environments,outputs,createLogicalProcessId:(invocationId)=>`proc-${invocationId}`,escalationGraceMs:[10,20]});
  return {runtime,store,kernel,stateKey,backend,grants,clock,outputs,registry};
}
function runtimeFor(kernel:DurableProcessStoreKernel,stateKey:Uint8Array,backend:Backend,grants:Grants,clock:Clock,outputs:Outputs):SubprocessRuntime{const environments=createChildEnvironmentFactory({credentialResolver:{consume:()=>{throw new Error("unused");}},now:()=>clock.now()});return createSubprocessRuntimeKernel({registry:createProcessBackendRegistry([{registryId:"registry-fake-v1",backendId:"fake",implementationGeneration:"fake-generation-v1",backend}]),storeKernel:kernel,stateKey,grants,clock,environments,outputs,createLogicalProcessId:(invocationId)=>`proc-${invocationId}`,escalationGraceMs:[10,20]});}
async function seedRecoverable(f:ReturnType<typeof fixture>,state:"prepared"|"launching"|"running"|"stopping"|"backend_unavailable"|"exited"|"verifying_empty"){f.outputs.prepareGate=new Promise(()=>undefined);void f.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}});const writer=getDurableProcessRuntimeWriter(f.kernel);let record=f.store.readByInvocation("invoke-1")!;if(state==="prepared")return;record=writer.apply({type:"mark_output_prepared",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString(),environmentAudit:{inheritedNames:[],removedNames:[],explicitSafeNames:[],grantedNames:[]}});record=writer.apply({type:"mark_launching",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString()});if(state==="launching")return;const selected=await selectProcessBackend(f.registry,[]);record=writer.apply({type:"bind_launch",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString(),binding:{registryId:selected.registryId,backendId:selected.attestation.backendId,implementationGeneration:selected.implementationGeneration,implementationDigest:selected.implementationDigest,attestationVersion:1,attestationDigest:selected.attestationDigest,opaqueIdentity:"seed-identity",birthFingerprint:{observedAt:f.clock.now().toISOString(),discriminator:"seed-birth"},startedAt:f.clock.now().toISOString()}});if(state==="running")return;if(state==="stopping"){writer.apply({type:"request_stop",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString(),reason:"cancelled"});return;}if(state==="backend_unavailable"){writer.apply({type:"fail",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString(),state:"backend_unavailable",detail:"seed"});return;}record=writer.apply({type:"record_exit",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString(),observation:{exitCode:0,observedAt:f.clock.now().toISOString()}});if(state==="exited")return;writer.apply({type:"begin_verify",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString(),output:[{stream:"stdout",tail:"",totalBytes:0,truncated:false,spillBytes:0,lossyBytes:0},{stream:"stderr",tail:"",totalBytes:0,truncated:false,spillBytes:0,lossyBytes:0}]});}

test("caller can provide only an opaque grant id and forged grant/result fields are rejected", async () => {
  const {runtime,backend,grants}=fixture();
  await assert.rejects(runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{},grant:grantValue(),stopReason:"cancelled"} as never), /unknown invocation field/i);
  assert.equal(grants.calls.length,0); assert.equal(backend.calls.includes("launch"),false);
});

test("runtime factory rejects malicious structural authority and launch sees a deep immutable intent snapshot",async()=>{const f=fixture();assert.throws(()=>createSubprocessRuntimeKernel({registry:{} as never,storeKernel:f.kernel,stateKey:f.stateKey,grants:f.grants,clock:f.clock,environments:createChildEnvironmentFactory({credentialResolver:{consume:()=>{throw new Error("unused");}}}),outputs:f.outputs}),/registry authority/i);const mutable=intent() as unknown as ExecutionInvocationIntent & {arguments:string[];requestedCapabilities:string[]};f.backend.onLaunch=(request)=>{assert.deepEqual(request.intent.arguments,["--secret-value"]);assert.equal(Object.isFrozen(request.intent),true);assert.equal(Object.isFrozen(request.intent.arguments),true);};const operation=f.runtime.invoke({intent:mutable,grantId:"grant-invoke-1",ambientEnvironment:{}});mutable.arguments[0]="--mutated";mutable.requestedCapabilities.length=0;await operation;});

test("durable claim and output owner exist before first await so immediate cancel is queued",async()=>{const f=fixture();const gate=deferred();f.outputs.prepareGate=gate.promise;const operation=f.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}});assert.equal(f.store.readByInvocation("invoke-1")?.state,"prepared");assert.equal(f.store.readByInvocation("invoke-1")?.outputOwnerId,"output-proc-invoke-1");assert.equal(await f.runtime.cancel("invoke-1"),true);assert.equal(f.store.readByInvocation("invoke-1")?.stopIntent?.reason,"cancelled");gate.resolve();const result=await operation;assert.equal(result.outcome,"cancelled");});

test("crash-safe output intent precedes idempotent prepare and prepare failure is durable",async()=>{const f=fixture();f.outputs.failPrepare=true;const operation=f.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}});assert.equal(f.store.readByInvocation("invoke-1")?.outputPrepared,false);const result=await operation;assert.equal(result.outcome,"cleanup_failed");assert.equal(f.store.readByInvocation("invoke-1")?.state,"cleanup_blocked");assert.equal(f.grants.calls.length,0);});

test("Runner-private grant is atomically consumed, strictly snapshotted, run-bound, and expiry checked", async () => {
  const expired=fixture(); expired.grants.values.set("grant-invoke-1",grantValue("invoke-1",{expiresAt:"2025-01-01T00:00:00.000Z"}));
  await assert.rejects(expired.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}), /execution grant/i);
  assert.equal(expired.backend.calls.includes("launch"),false);assert.equal(expired.store.readByInvocation("invoke-1")?.state,"launch_not_proven");assert.ok(expired.outputs.calls.includes("cleanup:output-proc-invoke-1"));
  const forged=fixture(); forged.grants.values.set("grant-invoke-1",Object.defineProperty(grantValue(),"runId",{enumerable:true,get:()=>"run-1"}));
  await assert.rejects(forged.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}), /execution grant/i);
  const future=fixture();future.grants.values.set("grant-invoke-1",grantValue("invoke-1",{issuedAt:"2027-01-01T00:00:00.000Z"}));await assert.rejects(future.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}),/execution grant/i);
});

test("concurrent exact invocations share one operation while divergent retries conflict", async () => {
  const {runtime,backend}=fixture();
  const [left,right]=await Promise.all([runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{PATH:"safe"}}),runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{PATH:"safe"}})]);
  assert.deepEqual(right,left); assert.equal(backend.calls.filter((call)=>call==="launch").length,1);
  await assert.rejects(runtime.invoke({intent:intent("invoke-1","different"),grantId:"grant-invoke-1",ambientEnvironment:{PATH:"safe"}}), /idempotency conflict/i);
  await assert.rejects(runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{PATH:"other-value"}}), /idempotency conflict/i);
});

test("separate SQLite runtime contenders durably elect one winner before grant or output effects",async(t)=>{const root=await mkdtemp(join(tmpdir(),"runner-v2-runtime-sqlite-"));t.after(async()=>rm(root,{recursive:true,force:true}));const path=join(root,"process.sqlite");const stateKey=new Uint8Array(32).fill(4);const firstKernel=openSqliteDurableProcessKernel(path,stateKey);const secondKernel=openSqliteDurableProcessKernel(path,stateKey);const backend=new Backend();const grants=new Grants(new Map([["grant-invoke-1",grantValue()]]));const clock=new Clock();const outputs=new Outputs();const first=runtimeFor(firstKernel,stateKey,backend,grants,clock,outputs);const second=runtimeFor(secondKernel,stateKey,backend,grants,clock,outputs);const request={intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{API_KEY:"secret-value",PATH:"one"}};const [left,right]=await Promise.all([first.invoke(request),second.invoke(request)]);assert.deepEqual(right,left);assert.equal(backend.calls.filter((call)=>call==="launch").length,1);assert.equal(grants.calls.length,1);assert.equal(outputs.calls.filter((call)=>call.startsWith("prepare:")).length,1);await assert.rejects(second.invoke({...request,ambientEnvironment:{API_KEY:"different-secret",PATH:"one"}}),/idempotency conflict/i);assert.equal(grants.calls.length,1);firstKernel.store.close();secondKernel.store.close();const bytes=await readFile(path);for(const forbidden of ["secret-value","different-secret","--secret-value","C:\\host\\project","nativeHandle","spill.tmp"])assert.equal(bytes.includes(Buffer.from(forbidden)),false,forbidden);});

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

test("backend-unavailable with durable stop re-enters stopping and escalates when backend returns",async()=>{const f=fixture();f.backend.observeValue=new Proxy({},{});await assert.rejects(f.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}));const writer=getDurableProcessRuntimeWriter(f.kernel);let record=f.store.readByInvocation("invoke-1")!;record=writer.apply({type:"request_stop",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString(),reason:"cancelled"});record=writer.apply({type:"fail",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString(),state:"backend_unavailable",detail:"crash while stopped"});assert.equal(record.state,"backend_unavailable");f.backend.calls.length=0;f.backend.reconcileValue={state:"running"};f.backend.observeValue={state:"exited",exitCode:0};f.backend.signalValues=[{state:"exited"}];await f.runtime.reconcileStartup();assert.equal(f.store.readByInvocation("invoke-1")?.state,"cleaned");assert.deepEqual(f.backend.calls.filter((call)=>call.startsWith("signal:")),["signal:interrupt"]);});

test("restart resumes an escalation whose durable request preceded a crash",async()=>{const f=fixture();f.backend.observeValue=new Proxy({},{});await assert.rejects(f.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}));const writer=getDurableProcessRuntimeWriter(f.kernel);let record=f.store.readByInvocation("invoke-1")!;record=writer.apply({type:"request_stop",invocationId:record.invocationId,expectedRevision:record.revision,at:f.clock.now().toISOString(),reason:"cancelled"});record=writer.apply({type:"start_escalation",invocationId:record.invocationId,expectedRevision:record.revision,action:"interrupt",requestedAt:f.clock.now().toISOString()});assert.equal(record.escalation.at(-1)?.outcome,"requested");f.backend.reconcileValue={state:"running"};f.backend.observeValue={state:"exited",exitCode:0};f.backend.signalValues=[{state:"exited"}];await f.runtime.reconcileStartup();assert.equal(f.store.readByInvocation("invoke-1")?.state,"cleaned");assert.equal(f.store.readByInvocation("invoke-1")?.result?.outcome,"cancelled");assert.deepEqual(f.backend.calls.filter((call)=>call.startsWith("signal:")),["signal:interrupt"]);});

test("durable timeout and cancellation outrank later cleanup failure",async()=>{const f=fixture();f.backend.verifyValue={empty:false,detail:"descendant remains"};const result=await f.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{},deadline:new Date("2026-01-01T00:00:01.000Z")});assert.equal(result.outcome,"timed_out");assert.equal(f.store.readByInvocation("invoke-1")?.state,"cleanup_blocked");});

test("malformed backend results are classified and never become verified success", async () => {
  const launch=fixture(); launch.backend.launchValue={opaqueIdentity:"opaque",birthFingerprint:{observedAt:"x",discriminator:"d"},startedAt:"x",extra:true};
  await assert.rejects(launch.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}),(error:SubprocessRuntimeError)=>error.code==="launch_not_proven");
  const verify=fixture(); verify.backend.verifyValue={empty:"false",detail:"descendant"};
  const result=await verify.runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}}); assert.equal(result.outcome,"cleanup_failed"); assert.equal(verify.store.readByInvocation("invoke-1")?.state,"cleanup_blocked");
});

test("output ownership is prepared before launch and finalized before verified cleanup", async () => {
  const {runtime,backend,outputs}=fixture();backend.onLaunch=()=>assert.deepEqual(outputs.calls,["prepare:output-proc-invoke-1"]);backend.onRelease=()=>assert.ok(backend.calls.filter((call)=>call==="probe").length>=3); await runtime.invoke({intent:intent(),grantId:"grant-invoke-1",ambientEnvironment:{}});
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

test("recovery reports a corrupt first SQLite row and still reconciles the later valid row",async(t)=>{const root=await mkdtemp(join(tmpdir(),"runner-v2-runtime-corrupt-"));t.after(async()=>rm(root,{recursive:true,force:true}));const path=join(root,"process.sqlite");const stateKey=new Uint8Array(32).fill(5);const kernel=openSqliteDurableProcessKernel(path,stateKey);const backend=new Backend();const grants=new Grants(new Map([["grant-first",grantValue("first")],["grant-second",grantValue("second")]]));const clock=new Clock();const outputs=new Outputs();outputs.prepareGate=new Promise(()=>undefined);const registry=createProcessBackendRegistry([{registryId:"registry-fake-v1",backendId:"fake",implementationGeneration:"fake-generation-v1",backend}]);const environments=createChildEnvironmentFactory({credentialResolver:{consume:()=>{throw new Error("unused");}},now:()=>clock.now()});const runtime=createSubprocessRuntimeKernel({registry,storeKernel:kernel,stateKey,grants,clock,environments,outputs,createLogicalProcessId:(id)=>`proc-${id}`});void runtime.invoke({intent:intent("first"),grantId:"grant-first",ambientEnvironment:{}});void runtime.invoke({intent:intent("second"),grantId:"grant-second",ambientEnvironment:{}});assert.deepEqual(kernel.store.listRowIds(),["first","second"]);kernel.store.close();const raw=new DatabaseSync(path);raw.prepare("UPDATE durable_processes SET record_json = ? WHERE invocation_id = ?").run("{}","first");raw.close();outputs.calls.length=0;outputs.prepareGate=undefined;const reopened=openSqliteDurableProcessKernel(path,stateKey);const recovery=createSubprocessRuntimeKernel({registry,storeKernel:reopened,stateKey,grants,clock,environments,outputs,createLogicalProcessId:(id)=>`proc-${id}`});const outcomes=await recovery.reconcileStartup();assert.deepEqual(outcomes,[{invocationId:"first",state:"corrupt"},{invocationId:"second",state:"launch_not_proven"}]);assert.ok(outputs.calls.includes("prepare:output-proc-second"));reopened.store.close();});

test("exhaustive durable-state by reconcile-outcome matrix is fail-closed",async()=>{
  for(const [state,want] of [["prepared","launch_not_proven"],["launching","orphaned"],["exited","cleaned"],["verifying_empty","cleaned"]] as const){const f=fixture();await seedRecoverable(f,state);f.outputs.prepareGate=undefined;await f.runtime.reconcileStartup();assert.equal(f.store.readByInvocation("invoke-1")?.state,want,`${state}`);}
  const outcomes=[{value:{state:"running"},want:"cleaned"},{value:{state:"exited",exitCode:0},want:"cleaned"},{value:{state:"identity_mismatch"},want:"identity_mismatch"},{value:{state:"outcome_unknown"},want:"outcome_unknown"},{value:new Proxy({},{}),want:"outcome_unknown"}] as const;
  for(const state of ["running","stopping","backend_unavailable"] as const){for(const outcome of outcomes){const f=fixture();await seedRecoverable(f,state);f.outputs.prepareGate=undefined;f.backend.reconcileValue=outcome.value;f.backend.observeValue={state:"exited",exitCode:0};f.backend.signalValues=[{state:"exited"}];await f.runtime.reconcileStartup();assert.equal(f.store.readByInvocation("invoke-1")?.state,outcome.want,`${state}/${outcome.want}`);}}
});
