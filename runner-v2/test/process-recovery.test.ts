import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { ProcessRecoveryController, createAgentProcessRecoveryGenerator, createSubprocessProcessRecoveryRuntime, recoveryScope,
  type RecoveryAuditRecord, type RecoveryTarget, type RecoveryProposal } from "../src/process-recovery.js";
import { createExecutionGrantAuthority } from "../src/execution-grants.js";
import { exceptionalRecoveryCallId } from "../src/subprocess-runtime.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";

const now = new Date("2026-09-15T00:00:00.000Z");
function target(state = "orphaned"): RecoveryTarget {
  return { scope: { kind: "subprocess", runId: "run", invocationId: "invocation", logicalProcessId: "logical",
    taskId: "task", sessionId: "session", revision: 3, ownerId: "owner", fencingToken: 2, rootPid: 123,
    state, backendIdentity: "a".repeat(64), birthFingerprint: "b".repeat(64) },
    owned: true, pendingEffects: false,
    lifecycle: { scope: "process_group", termination: "enforced", emptiness: "enforced" },
    requiredLifecycleScope: "process_group",
    capabilities: { tree_termination: "enforced", crash_cleanup: "enforced", verified_emptiness: "enforced", write_confinement: "unverified" },
    cleanup: { state: "pending" } };
}
function proposal(t: RecoveryTarget, id = "proposal"): RecoveryProposal {
  return { version: 1, proposalId: id, callId: "recovery:" + id, scope: recoveryScope(t),
    requestedAction: "inspect", targetScope: [t.scope.logicalProcessId], requestedCapabilities: [],
    expiresAt: new Date(now.getTime() + 60000).toISOString(), rationale: "Inspect exact owned process" };
}
function fixture(name: string, run: (f: { controller: ProcessRecoveryController; store: SqliteSchedulerStore;
  get current(): RecoveryTarget; set current(v: RecoveryTarget); effects: string[]; generated: string[]; path: string }) => Promise<void>) {
  test("process recovery: " + name, async () => {
    const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task11-recovery-")); const path = join(root,"scheduler.sqlite");
    const store = new SqliteSchedulerStore(path); let current = target(); const effects: string[] = [], generated: string[] = [];
    store.append({ runId:"run", type:"run.initialized", actor:{role:"runner",id:"scheduler"}, occurredAt:now.toISOString(), idempotencyKey:"init",payload:{} });
    const controller = new ProcessRecoveryController({ runId:"run", store, clock:()=>now,
      runtime: { inspect:()=>structuredClone(current), execute:async(request, authority)=>{
        authority.assertCurrent(); effects.push(request.requestedAction);
        // Inspection observes; only a terminate effect may ever report proven emptiness.
        return request.requestedAction === "terminate"
          ? { observation:"exited" as const, cleanup:{state:"verified_empty" as const, verifiedAt: now.toISOString()} }
          : { observation:"running" as const, cleanup:{state:"pending" as const} };
      } }, generate:async()=>{generated.push("model"); return proposal(current);} });
    let passed=false;
    try { await run({controller,store,get current(){return current;},set current(v){current=v;},effects,generated,path});passed=true; }
    finally { store.close(); if(passed)fs.rmSync(root,{recursive:true,force:true}); else console.error("Task11 RED root retained: "+root); }
  });
}
for(const state of ["prepared","launching","running","stopping","exited","verifying_empty","cleaned","cleanup_blocked"])
  fixture("routine state " + state + " cannot call a model or effect", async f=>{
    f.current=target(state);
    await assert.rejects(()=>f.controller.generate("invocation","proposal"),{code:"routine_recovery_forbidden"});
    await assert.rejects(()=>f.controller.submit(proposal(f.current)),{code:"routine_recovery_forbidden"});
    assert.deepEqual(f.generated,[]);assert.deepEqual(f.effects,[]);
  });
for(const state of ["orphaned","identity_mismatch","backend_unavailable","outcome_unknown"])
  fixture("exceptional " + state + " accepts only a validated proposal",async f=>{
    f.current=target(state); const receipt=await f.controller.submit(proposal(f.current));
    assert.equal(receipt.state,"authorized"); assert.deepEqual(f.effects,[]);
    const result=await f.controller.execute("proposal",receipt.proposalFingerprint);
    assert.equal(result.state,"executed");assert.deepEqual(f.effects,["inspect"]);
  });
for(const field of ["runId","taskId","sessionId","invocationId","logicalProcessId","ownerId","revision","fencingToken","backendIdentity","birthFingerprint","rootPid"] as const)
  fixture("changed " + field + " is rejected before execution",async f=>{
    const p=proposal(f.current); const v=p.scope[field];
    const changed={...p,scope:{...p.scope,[field]:typeof v==="number"?v+1:"different"}};
    await assert.rejects(()=>f.controller.submit(changed),{code:"recovery_scope_mismatch"});assert.deepEqual(f.effects,[]);
  });
fixture("same PID with recycled birth invalidates an authorized action",async f=>{
  const receipt=await f.controller.submit(proposal(f.current));
  f.current={...f.current,scope:{...f.current.scope,birthFingerprint:"c".repeat(64)}};
  assert.equal((await f.controller.execute("proposal",receipt.proposalFingerprint)).state,"rejected");assert.deepEqual(f.effects,[]);
});
fixture("destructive action pauses and binds exact local-user approval",async f=>{
  const p={...proposal(f.current),requestedAction:"terminate" as const,requestedCapabilities:[]};
  const r=await f.controller.submit(p);assert.equal(r.state,"user_decision_required");
  await assert.rejects(()=>f.controller.execute(p.proposalId,r.proposalFingerprint),{code:"recovery_approval_required"});
  await assert.rejects(()=>f.controller.decide(p.proposalId,"0".repeat(64),"approve"),{code:"recovery_scope_mismatch"});
  await f.controller.decide(p.proposalId,r.proposalFingerprint,"approve");
  assert.equal((await f.controller.execute(p.proposalId,r.proposalFingerprint)).state,"executed");assert.deepEqual(f.effects,["terminate"]);
});
for(const invalid of ["expired","scope","call","shell","capability","ownership","identity","pending"])
  fixture("rejects " + invalid + " authority",async f=>{
    const p: Record<string,unknown>=proposal(f.current) as unknown as Record<string,unknown>;
    if(invalid==="expired")p.expiresAt=now.toISOString();
    if(invalid==="scope")p.targetScope=["logical","other"];
    if(invalid==="call")p.callId="different";
    if(invalid==="shell")p.command="powershell -Command Remove-Item *";
    if(invalid==="capability") { p.requestedCapabilities=["crash_cleanup"]; f.current={...f.current,capabilities:{...f.current.capabilities,crash_cleanup:"unverified"}}; }
    if(invalid==="ownership")f.current={...f.current,owned:false};
    if(invalid==="identity")f.current={...f.current,scope:{...f.current.scope,backendIdentity:""}};
    if(invalid==="pending")f.current={...f.current,pendingEffects:true};
    await assert.rejects(()=>f.controller.submit(p));assert.deepEqual(f.effects,[]);
  });
fixture("scope-less legacy target is inspectable but cannot generate or submit new recovery authority", async f=>{
  f.current={...f.current,lifecycle:undefined,requiredLifecycleScope:undefined};
  await assert.rejects(()=>f.controller.generate("invocation","legacy-scope"),{code:"recovery_capability_unavailable"});
  await assert.rejects(()=>f.controller.submit(proposal(f.current,"legacy-submit")),{code:"recovery_capability_unavailable"});
  assert.deepEqual(f.generated,[]);assert.deepEqual(f.effects,[]);
});
fixture("new proposals cannot request deprecated lifecycle capability names",async f=>{
  await assert.rejects(()=>f.controller.submit({...proposal(f.current,"legacy-cap"),requestedCapabilities:["verified_emptiness"]}),
    {code:"recovery_capability_unavailable"});
  assert.deepEqual(f.effects,[]);
});
fixture("durable replay executes at most once and stores no raw model secrets",async f=>{
  const secret="unusual-password-without-a-known-prefix";
  const r=await f.controller.submit({...proposal(f.current),rationale:secret});
  await f.controller.execute("proposal",r.proposalFingerprint);
  const restarted=new ProcessRecoveryController({runId:"run",store:f.store,clock:()=>now,
    runtime:{inspect:()=>f.current,execute:async()=>{throw Error("must not replay");}}});
  assert.equal((await restarted.execute("proposal",r.proposalFingerprint)).state,"executed");
  assert.deepEqual(f.effects,["inspect"]);
  assert.equal(JSON.stringify(f.store.readRun("run")).includes(secret),false);
  assert.equal(fs.readFileSync(f.path).includes(Buffer.from(secret)),false);
});
// Task11.SPEC.pending-cleanup-not-success
fixture("a terminate whose cleanup stays pending is never reported as executed",async f=>{
  const store=f.store; const inspected=structuredClone(f.current);
  const controller=new ProcessRecoveryController({runId:"run",store,clock:()=>now,
    runtime:{inspect:()=>structuredClone(inspected),execute:async()=>({observation:"running",cleanup:{state:"pending"}})}});
  const p={...proposal(f.current,"pending-terminate"),requestedAction:"terminate" as const,
    requestedCapabilities:[]};
  const r=await controller.submit(p);
  await controller.decide(p.proposalId,r.proposalFingerprint,"approve");
  const done=await controller.execute(p.proposalId,r.proposalFingerprint);
  assert.equal(done.state,"outcome_unknown");
  assert.equal(done.reason,"effect_outcome_unknown");
  assert.equal(done.cleanupState,"pending");
  // An unresolved destructive recovery blocks resume and completion.
  assert.throws(()=>store.append({runId:"run",type:"run.resumed",actor:{role:"runner",id:"scheduler"},
    occurredAt:now.toISOString(),idempotencyKey:"resume-blocked",payload:{}}),/Unresolved exceptional recovery/);
});
// Task11.SPEC.missing-backend-identity
fixture("a process with no durable backend identity refuses every action",async f=>{
  const p=proposal(f.current); // Captured while identity was still provable.
  f.current={...f.current,scope:{...f.current.scope,backendIdentity:"",birthFingerprint:""}};
  await assert.rejects(()=>f.controller.submit(p),{code:"recovery_identity_unavailable"});
  await assert.rejects(()=>f.controller.generate("invocation","proposal"),{code:"recovery_identity_unavailable"});
  // An all-empty identity cannot even be expressed as a closed proposal.
  await assert.rejects(()=>f.controller.submit({...p,scope:{...p.scope,backendIdentity:""}}),
    {code:"invalid_recovery_proposal"});
  assert.deepEqual(f.effects,[]);assert.deepEqual(f.generated,[]);
});
// Task11.SPEC.model-failure-no-effect
fixture("a failing generator yields a typed refusal and no durable record",async f=>{
  const controller=new ProcessRecoveryController({runId:"run",store:f.store,clock:()=>now,
    runtime:{inspect:()=>structuredClone(f.current),execute:async()=>{throw Error("must not execute");}},
    generate:async()=>{throw Error("provider exploded with token sk-live-DEADBEEF");}});
  await assert.rejects(()=>controller.generate("invocation","from-model"),{code:"recovery_model_failed"});
  assert.equal(Object.keys(controller.records()).length,0);
  assert.equal(JSON.stringify(f.store.readRun("run")).includes("sk-live-DEADBEEF"),false);
});
// Task11.SPEC.generated-scope-must-match
fixture("a generator may not widen or retarget the validated scope",async f=>{
  const controller=new ProcessRecoveryController({runId:"run",store:f.store,clock:()=>now,
    runtime:{inspect:()=>structuredClone(f.current),execute:async()=>{throw Error("must not execute");}},
    generate:async()=>({...proposal(f.current,"widened"),targetScope:["logical","another-process"]})});
  await assert.rejects(()=>controller.generate("invocation","widened"),{code:"recovery_scope_mismatch"});
  assert.equal(Object.keys(controller.records()).length,0);
});
// Task11.SPEC.concurrent-execution-claim
fixture("concurrent execution requests share one durable claim",async f=>{
  let entered=0; let release=()=>{};
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const controller=new ProcessRecoveryController({runId:"run",store:f.store,clock:()=>now,
    runtime:{inspect:()=>structuredClone(f.current),execute:async()=>{
      entered+=1; await gate; return {observation:"running",cleanup:{state:"pending"}};}}});
  const r=await controller.submit(proposal(f.current,"concurrent"));
  const runs=[controller.execute("concurrent",r.proposalFingerprint),
    controller.execute("concurrent",r.proposalFingerprint),
    controller.execute("concurrent",r.proposalFingerprint)];
  release();
  const settled=await Promise.all(runs);
  assert.equal(entered,1);
  for(const value of settled) assert.equal(value.state,"executed");
});
// Task11.SPEC.restart-inflight-becomes-unknown
fixture("an in-flight claim observed after restart becomes outcome_unknown and never replays",async f=>{
  const p={...proposal(f.current,"inflight"),requestedAction:"terminate" as const,
    requestedCapabilities:[]};
  const r=await f.controller.submit(p);
  await f.controller.decide(p.proposalId,r.proposalFingerprint,"approve");
  let started=0;
  const crashing=new ProcessRecoveryController({runId:"run",store:f.store,clock:()=>now,
    runtime:{inspect:()=>structuredClone(f.current),execute:async()=>{started+=1;throw Error("runner died mid-effect");}}});
  assert.equal((await crashing.execute("inflight",r.proposalFingerprint)).state,"outcome_unknown");
  const restarted=new ProcessRecoveryController({runId:"run",store:f.store,clock:()=>now,
    runtime:{inspect:()=>structuredClone(f.current),execute:async()=>{started+=1;return {observation:"running",cleanup:{state:"pending"}};}}});
  assert.equal((await restarted.execute("inflight",r.proposalFingerprint)).state,"outcome_unknown");
  assert.equal(started,1);
});

// Task11.SPEC.native-grant-adapter
test("process recovery: subprocess adapter issues one exact native recovery grant and revokes it", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task11-adapter-"));
  const executionGrants = createExecutionGrantAuthority({ clock: () => now });
  const t = target(); const expiresAt = new Date(now.getTime() + 60_000).toISOString();
  let observed = false;
  const runtime = createSubprocessProcessRecoveryRuntime({
    runtime: { recoverExceptional: async (request) => {
      observed = true;
      const active = executionGrants.activeSnapshots(); assert.equal(active.length, 1);
      assert.equal(active[0]!.toolName, "process.recovery");
      assert.equal(active[0]!.callId, exceptionalRecoveryCallId({ ...request, authorization: undefined, assertGrant: undefined, userApproved: undefined } as never));
      assert.deepEqual(active[0]!.access, []); assert.equal(active[0]!.networkApproved, false);
      return { invocationId: request.invocationId, state: "outcome_unknown", observation: "running",
        cleanup: { state: "pending" }, identityProof: request.backendIdentityFingerprint, revision: request.expectedRevision };
    } }, store: { readByInvocation: () => ({}) as never }, capabilities: () => t.capabilities,
    canRecoverExceptional: () => true,
    executionGrants, permissionProfile: "full", workspacePath: root,
  });
  const audit = { requestedAction: "inspect", scope: t.scope, expiresAt } as RecoveryAuditRecord;
  try {
    const result = await runtime.execute(audit, { userApproved: false, signal: new AbortController().signal, assertCurrent() {} });
    assert.equal(observed, true); assert.equal(result.observation, "running");
    assert.deepEqual(executionGrants.activeSnapshots(), []);
  } finally { await executionGrants.revokeAll("cleanup"); fs.rmSync(root, { recursive: true, force: true }); }
});

// Task11.SPEC.kernel-owned-recoverability
 test("process recovery: adapter never invents ownership when the shared kernel refuses recovery", () => {
  const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task11-ownership-"));
  const executionGrants = createExecutionGrantAuthority({ clock: () => now });
  const binding = {
    registryId: "registry", backendId: "backend", implementationGeneration: "generation",
    implementationDigest: "1".repeat(64), attestationVersion: 2, attestationDigest: "2".repeat(64),
    capabilities: target().capabilities, lifecycle: target().lifecycle, opaqueIdentity: "opaque",
    birthFingerprint: { observedAt: now.toISOString(), discriminator: "birth" },
    rootPid: 123, startedAt: now.toISOString(),
  };
  const record = {
    runId: "run", invocationId: "invocation", logicalProcessId: "logical", taskId: "task", sessionId: "session",
    revision: 3, ownerId: "other-owner", fencingToken: 2,
    leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(), state: "orphaned",
    pendingEffects: [], cleanup: { state: "pending" }, requiredLifecycleScope: "process_group", requiredCapabilities: [], backendBinding: binding,
  } as never;
  try {
    const runtime = createSubprocessProcessRecoveryRuntime({
      runtime: { recoverExceptional: async () => { throw Error("must not execute"); } },
      store: { readByInvocation: () => record }, capabilities: () => target().capabilities,
      canRecoverExceptional: () => false,
      executionGrants, permissionProfile: "full", workspacePath: root,
    });
    assert.equal(runtime.inspect("invocation")?.owned, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Task11.SPEC.closed-model-generator
test("process recovery: model generator cannot author scope, target, call identity or expiry", async () => {
  const seen: unknown[] = [];
  const generate = createAgentProcessRecoveryGenerator({
    model: { complete: async request => { seen.push(request); return { stopReason: "end_turn" as const, blocks: [{ type: "text" as const,
      text: JSON.stringify({ requestedAction: "inspect", requestedCapabilities: [], rationale: "Inspect the exact exceptional process" }) }] }; } },
    clock: () => now,
  });
  const t = target("orphaned");
  const value = await generate(recoveryScope(t), "model-proposal", new AbortController().signal) as RecoveryProposal;
  assert.equal(value.proposalId, "model-proposal");
  assert.equal(value.callId, "recovery:model-proposal");
  assert.deepEqual(value.scope, recoveryScope(t));
  assert.deepEqual(value.targetScope, ["logical"]);
  assert.equal(value.expiresAt, new Date(now.getTime() + 60_000).toISOString());
  const request = seen[0] as { tools: unknown[]; messages: Array<{ content: string }> };
  assert.deepEqual(request.tools, []);
  assert.equal(request.messages.some(message => message.content.includes("sk-live")), false);
});

test("process recovery: model generator rejects extra command/scope authority", async () => {
  const generate = createAgentProcessRecoveryGenerator({ model: { complete: async () => ({ stopReason: "end_turn" as const, blocks: [{ type: "text" as const,
    text: JSON.stringify({ requestedAction: "terminate", requestedCapabilities: ["tree_termination"], rationale: "stop", command: "taskkill /F", targetScope: ["other"] }) }] }) }, clock: () => now });
  await assert.rejects(() => generate(recoveryScope(target()), "bad-model", new AbortController().signal), { code: "invalid_recovery_proposal" });
});

// Task11.REVIEW.completed-run-immutable
test("process recovery: a completed scheduler run rejects later recovery events", async () => {
  const { makeRecoveryAudit } = await import("../src/process-recovery.js");
  const { reduceSchedulerEvent } = await import("../src/scheduler-store.js");
  const p = proposal(target("orphaned"), "after-complete");
  const record = makeRecoveryAudit(p, now.toISOString());
  const current = {
    runId: "run", status: "completed", acceptanceContractStatus: "current",
    planRevision: 0, tasks: {}, guidance: {}, userGuidance: {}, userGuidanceVersion: 0,
    architectQuestions: {}, architectQuestionVersion: 0, reviews: {},
    submissionHistory: {}, reviewHistory: {},
    runtime: { providerHealth: {}, workerAssignments: {}, architect: {} }, lastSequence: 1,
  } as never;
  assert.throws(() => reduceSchedulerEvent(current, {
    eventId: "recovery-after-complete", runId: "run", sequence: 2,
    type: "process.recovery_updated", occurredAt: now.toISOString(),
    actor: { role: "runner", id: "process-recovery" }, idempotencyKey: "recovery-after-complete",
    payload: { record },
  }), /completed|terminal/i);
});

// Task11.REVIEW.outcome-unknown-resolution
test("process recovery: outcome_unknown resolves from durable verified-empty proof without replay", () => fixture("verified-empty reconciliation", async f => {
  let effects = 0;
  const crashing = new ProcessRecoveryController({ runId: "run", store: f.store, clock: () => now,
    runtime: { inspect: () => structuredClone(f.current), execute: async () => { effects += 1; throw Error("lost response"); } } });
  const p = { ...proposal(f.current, "unknown-clean"), requestedAction: "terminate" as const,
    requestedCapabilities: [] };
  const accepted = await crashing.submit(p);
  await crashing.decide(p.proposalId, accepted.proposalFingerprint, "approve");
  assert.equal((await crashing.execute(p.proposalId, accepted.proposalFingerprint)).state, "outcome_unknown");
  f.current = { ...f.current, scope: { ...f.current.scope, revision: f.current.scope.revision + 5, state: "cleaned" },
    cleanup: { state: "verified_empty", verifiedAt: now.toISOString() } };
  const restarted = new ProcessRecoveryController({ runId: "run", store: f.store, clock: () => now,
    runtime: { inspect: () => structuredClone(f.current), execute: async () => { effects += 1; throw Error("must not replay"); } } });
  const resolved = await restarted.execute(p.proposalId, accepted.proposalFingerprint);
  assert.equal(resolved.state, "rejected");
  assert.equal(resolved.reason, "resolved_by_verified_cleanup");
  assert.equal(resolved.cleanupState, "verified_empty");
  assert.equal(effects, 1);
}));

test("process recovery: later verified cleanup resolves older unknown recovery for the same identity", () => fixture("later cleanup resolves unknown", async f => {
  let calls = 0;
  const controller = new ProcessRecoveryController({ runId: "run", store: f.store, clock: () => now,
    runtime: { inspect: () => structuredClone(f.current), execute: async () => {
      calls += 1;
      if (calls === 1) return { observation: "outcome_unknown" as const, cleanup: { state: "pending" as const } };
      f.current = { ...f.current, scope: { ...f.current.scope, revision: f.current.scope.revision + 4, state: "cleaned" },
        cleanup: { state: "verified_empty", verifiedAt: now.toISOString() } };
      return { observation: "exited" as const, cleanup: { state: "verified_empty" as const, verifiedAt: now.toISOString() } };
    } } });
  const terminate = (id: string) => ({ ...proposal(f.current, id), requestedAction: "terminate" as const,
    requestedCapabilities: [] });
  const first = terminate("unknown-first");
  const firstReceipt = await controller.submit(first);
  await controller.decide(first.proposalId, firstReceipt.proposalFingerprint, "approve");
  assert.equal((await controller.execute(first.proposalId, firstReceipt.proposalFingerprint)).state, "outcome_unknown");
  const second = terminate("cleanup-second");
  const secondReceipt = await controller.submit(second);
  await controller.decide(second.proposalId, secondReceipt.proposalFingerprint, "approve");
  assert.equal((await controller.execute(second.proposalId, secondReceipt.proposalFingerprint)).state, "executed");
  const resolved = controller.records()[first.proposalId]!;
  assert.equal(resolved.state, "rejected");
  assert.equal(resolved.reason, "resolved_by_verified_cleanup");
  assert.equal(resolved.cleanupState, "verified_empty");
}));

test("process recovery: grant issuance failure is failed before dispatch, never outcome_unknown", async () => {
  const root = fs.mkdtempSync(join(tmpdir(), "aiboard-task11-no-dispatch-"));
  const scheduler = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  scheduler.append({ runId: "run", type: "run.initialized", actor: { role: "runner", id: "scheduler" },
    occurredAt: now.toISOString(), idempotencyKey: "init", payload: {} });
  const binding = { registryId: "registry", backendId: "backend", implementationGeneration: "generation",
    implementationDigest: "1".repeat(64), attestationVersion: 2, attestationDigest: "2".repeat(64),
    capabilities: target().capabilities, lifecycle: target().lifecycle, opaqueIdentity: "opaque",
    birthFingerprint: { observedAt: now.toISOString(), discriminator: "birth" }, rootPid: 123, startedAt: now.toISOString() };
  const record = { runId: "run", invocationId: "invocation", logicalProcessId: "logical", taskId: "task", sessionId: "session",
    revision: 3, ownerId: "owner", fencingToken: 2, leaseExpiresAt: new Date(now.getTime() + 60_000).toISOString(),
    state: "orphaned", pendingEffects: [], cleanup: { state: "pending" }, requiredLifecycleScope: "process_group", requiredCapabilities: [],
    backendBinding: binding } as never;
  let dispatched = 0;
  const executionGrants = createExecutionGrantAuthority({ clock: () => now, beforeIssueCommit: async () => { throw Error("issuer unavailable"); } });
  const runtime = createSubprocessProcessRecoveryRuntime({
    runtime: { recoverExceptional: async () => { dispatched += 1; throw Error("must not dispatch"); } },
    canRecoverExceptional: () => true, store: { readByInvocation: () => record }, capabilities: () => target().capabilities,
    executionGrants, permissionProfile: "full", workspacePath: root,
  });
  const controller = new ProcessRecoveryController({ runId: "run", store: scheduler, clock: () => now, runtime });
  try {
    const exact = runtime.inspect("invocation")!;
    const receipt = await controller.submit(proposal(exact, "grant-fails"));
    const result = await controller.execute("grant-fails", receipt.proposalFingerprint);
    assert.equal(result.state, "failed");
    assert.equal(result.reason, "effect_failed");
    assert.equal(dispatched, 0);
  } finally {
    await executionGrants.revokeAll("cleanup"); scheduler.close(); fs.rmSync(root, { recursive: true, force: true });
  }
});


test("process recovery: read-only inspection uncertainty completes without blocking the Build", () => fixture("inspect uncertainty stays nonblocking", async f => {
  const controller = new ProcessRecoveryController({ runId: "run", store: f.store, clock: () => now,
    runtime: { inspect: () => structuredClone(f.current), execute: async () => ({
      observation: "outcome_unknown" as const, cleanup: { state: "pending" as const },
    }) } });
  const receipt = await controller.submit(proposal(f.current, "inspect-uncertain"));
  const result = await controller.execute("inspect-uncertain", receipt.proposalFingerprint);
  assert.equal(result.state, "executed");
  assert.equal(result.reason, "inspection_completed");
  assert.equal(result.observation, "outcome_unknown");
  assert.doesNotThrow(() => f.store.append({ runId: "run", type: "run.resumed",
    actor: { role: "runner", id: "scheduler" }, occurredAt: now.toISOString(),
    idempotencyKey: "resume-after-inspect", payload: {} }));
}));

test("process recovery: failed read-only inspection is failed, never ambiguous destructive state", () => fixture("inspect failure stays nonblocking", async f => {
  const controller = new ProcessRecoveryController({ runId: "run", store: f.store, clock: () => now,
    runtime: { inspect: () => structuredClone(f.current), execute: async () => { throw Error("probe failed"); } } });
  const receipt = await controller.submit(proposal(f.current, "inspect-failed"));
  const result = await controller.execute("inspect-failed", receipt.proposalFingerprint);
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "effect_failed");
  assert.doesNotThrow(() => f.store.append({ runId: "run", type: "run.resumed",
    actor: { role: "runner", id: "scheduler" }, occurredAt: now.toISOString(),
    idempotencyKey: "resume-after-inspect-failure", payload: {} }));
}));


test("process recovery: executing inspect never pauses the scheduler run", () => fixture("inspect executing stays running", async f => {
  const { rebuildSchedulerProjection } = await import("../src/scheduler-store.js");
  const receipt = await f.controller.submit(proposal(f.current, "inspect-running"));
  assert.equal(receipt.state, "authorized");
  const executing = { ...receipt, state: "executing" as const, reason: "execution_started" as const,
    attemptId: "inspect-attempt", updatedAt: now.toISOString() };
  f.store.append({ runId: "run", type: "process.recovery_updated",
    actor: { role: "runner", id: "process-recovery" }, occurredAt: now.toISOString(),
    idempotencyKey: "inspect-running:executing", payload: { record: executing } });
  const projection = rebuildSchedulerProjection(f.store.readRun("run"));
  assert.equal(projection.status, "running");
  assert.equal(projection.pauseReason, undefined);
}));

test("process recovery: restarted executing inspect fails closed without becoming a destructive blocker", () => fixture("restart inspect becomes failed", async f => {
  const receipt = await f.controller.submit(proposal(f.current, "inspect-restart"));
  const executing = { ...receipt, state: "executing" as const, reason: "execution_started" as const,
    attemptId: "inspect-restart-attempt", updatedAt: now.toISOString() };
  f.store.append({ runId: "run", type: "process.recovery_updated",
    actor: { role: "runner", id: "process-recovery" }, occurredAt: now.toISOString(),
    idempotencyKey: "inspect-restart:executing", payload: { record: executing } });
  let effects = 0;
  const restarted = new ProcessRecoveryController({ runId: "run", store: f.store, clock: () => now,
    runtime: { inspect: () => structuredClone(f.current), execute: async () => { effects += 1; throw Error("must not replay"); } } });
  const result = await restarted.execute("inspect-restart", receipt.proposalFingerprint);
  assert.equal(result.state, "failed");
  assert.equal(result.reason, "effect_failed");
  assert.equal(effects, 0);
  assert.doesNotThrow(() => f.store.append({ runId: "run", type: "run.resumed",
    actor: { role: "runner", id: "scheduler" }, occurredAt: now.toISOString(),
    idempotencyKey: "resume-after-inspect-restart", payload: {} }));
}));


test("process recovery: model generator rejects unsupported artifact-removal action", async () => {
  const generate = createAgentProcessRecoveryGenerator({
    model: { complete: async () => ({ stopReason: "end_turn" as const, blocks: [{ type: "text" as const,
      text: JSON.stringify({ requestedAction: "remove_owned_artifact", requestedCapabilities: [], rationale: "remove it" }) }] }) },
    clock: () => now,
  });
  await assert.rejects(() => generate(recoveryScope(target("orphaned")), "unsupported-action", new AbortController().signal),
    { code: "invalid_recovery_proposal" });
});
