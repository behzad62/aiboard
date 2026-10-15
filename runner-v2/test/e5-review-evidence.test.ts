import assert from "node:assert/strict";
import test from "node:test";
import { rebuildSchedulerProjection, reduceSchedulerEvent, type SchedulerEvent, type SchedulerProjection } from "../src/scheduler-store.js";
import type { DeliveryReviewRecord } from "../src/delivery-acceptance.js";

const initial: SchedulerEvent = { runId: "e5-proof", eventId: "init", sequence: 1, type: "run.initialized", occurredAt: "2026-10-04T00:00:00Z", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "init", payload: {} };
function fixture(active: boolean, stage: DeliveryReviewRecord["stage"]): SchedulerProjection {
  const p = rebuildSchedulerProjection([initial]); p.planningPolicyVersion = 1;
  if (active) Object.assign(p, { reviewEvidencePolicyVersion: 1 });
  const review: DeliveryReviewRecord = {
    taskId: "T1", reviewId: "review_T1", generation: 1, submissionAttempt: 1, changeSetId: "changeset_T1", diffArtifactHash: "a".repeat(64), criteriaIds: ["c1"],
    authorRuntimeId: "work:author", authorModelIdentity: "author", architectRuntimeId: "arch:architect", architectModelIdentity: "architect",
    stage, startedSequence: 1, reviewerRuntimeId: "rev:reviewer", reviewerModelIdentity: "reviewer", independence: "distinct_model",
    risk: { tier: "medium", score: 2, digest: "b".repeat(64), signals: [] }, sessionIds: [],
    claims: [{ id: "claim:c1", text: "Value is delivered.", evidenceIds: ["evidence-1"] }], findings: [],
  };
  if (active) Object.assign(review, { reviewEvidencePolicyVersion: 1 });
  p.delivery = { reviews: { T1: review }, reviewHistory: {}, authorModelIdentities: {}, boundaries: {}, taskAcceptances: {}, phaseAcceptances: {} };
  return p;
}
function event(type: SchedulerEvent["type"], payload: Record<string, unknown>): SchedulerEvent {
  return { ...initial, eventId: "next", sequence: 2, type, actor: { role: "verifier", id: "rev:reviewer" }, idempotencyKey: "next", payload: { taskId: "T1", reviewId: "review_T1", sessionId: "verdict-session", ...payload } };
}

test("E5 fresh activation is recorded while historical initialization retains absent shape", () => {
  assert.equal(Object.hasOwn(rebuildSchedulerProjection([initial]), "reviewEvidencePolicyVersion"), false);
  const active = rebuildSchedulerProjection([{ ...initial, payload: { reviewEvidencePolicyVersion: 1 } }]) as SchedulerProjection & { reviewEvidencePolicyVersion?: number };
  assert.equal(active.reviewEvidencePolicyVersion, 1);
});

test("E5 probe survivors cannot disappear when a reviewer returns no findings", () => {
  const findings = event("delivery.findings_recorded", { findings: [], depth: { inspectionToolCalls: 1,
    probe: { rung: "builtin_mutator", mutantsGenerated: 1, mutantsExecuted: 1, mutantsCaught: 0, survivors: ["mutant1 src/value.ts:1: > -> >="], partial: false, evidenceIds: ["probe-evidence-1"], notes: [] } } });
  assert.deepEqual(reduceSchedulerEvent(fixture(false, "diff_delivered"), findings).delivery!.reviews.T1!.findings, []);
  const active = reduceSchedulerEvent(fixture(true, "diff_delivered"), findings);
  assert.ok(active.delivery!.reviews.T1!.findings!.some((finding) => finding.severity === "blocking"), "An undispositioned survivor must be a blocking mechanical finding.");
});

test("E5 verified claims require a citation actually read in the reviewing session", () => {
  const verdict = event("delivery.review_recorded", { summary: "Done", satisfied: true, claimVerdicts: [{ claimId: "claim:c1", status: "verified", rationale: "I believe it is complete." }] });
  assert.equal(reduceSchedulerEvent(fixture(false, "report_delivered"), verdict).delivery!.reviews.T1!.satisfied, true);
  assert.throws(() => reduceSchedulerEvent(fixture(true, "report_delivered"), verdict), /citation|read|inspection/i);
});

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArtifactStore } from "../src/artifact-store.js";
import { toolInvocationFingerprint } from "../src/tool-ledger.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { createFilesystemTools } from "../src/filesystem-tools.js";
import { createArtifactTools } from "../src/artifact-tools.js";
import { createEvidenceTools } from "../src/evidence-tools.js";
import { ToolBroker } from "../src/tool-broker.js";
import { captureReviewReads, validateCitations, validateReadCapture, type ReviewReadCapture } from "../src/review-evidence.js";
import { openBlockingFindings } from "../src/delivery-acceptance.js";

const binding = {runId: "e5-proof", taskId: "T1", reviewId: "review_T1", changeSetId: "changeset_T1", submissionAttempt: 1, reviewerRuntimeId: "rev:reviewer", reviewerModelIdentity: "reviewer", sessionId: "verdict-session"};

test("E5 real completed SQLite tool reads bound citations to returned ranges; failed, foreign, opaque and directory reads grant nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "e5-ledger-"));
  const ledger = new SqliteToolLedger(join(root,"tools.sqlite"));
  const artifacts = new ArtifactStore(join(root,"artifacts"));
  const broker = new ToolBroker({ permissionProfile:"guarded", workspacePath:root, ledger, artifacts });
  for (const tool of createFilesystemTools({artifacts})) broker.register(tool);
  writeFileSync(join(root,"lines.txt"), "one\n" + "x".repeat(3100) + "\n" + "y".repeat(3100) + "\nlast\n");
  writeFileSync(join(root,"large.txt"), "x".repeat(10000));
  writeFileSync(join(root,"empty.txt"), "");
  let ordinal=0;
  const invoke = (name:string, args:unknown, sessionId=binding.sessionId, actorId=binding.reviewerRuntimeId) => broker.invoke({type:"tool_call",callId:`read-${++ordinal}`,name,arguments:args}, {runId:binding.runId,sessionId,actor:{role:"verifier",id:actorId}});
  try {
    assert.equal((await invoke("fs.read", {path:"lines.txt",startLine:1,endLine:5})).isError,false);
    assert.equal((await invoke("fs.read", {path:"missing.txt"})).isError,true);
    await invoke("fs.read", {path:"large.txt"});
    await invoke("fs.read", {path:"empty.txt"});
    await invoke("fs.list", {path:"."});
    await invoke("fs.read", {path:"lines.txt",startLine:3,endLine:5}, "foreign-session");
    await invoke("fs.read", {path:"lines.txt",startLine:3,endLine:5}, binding.sessionId, "foreign-actor");
    const capture = captureReviewReads(ledger,binding);
    assert.equal(capture.reads.length,1);
    assert.equal(capture.reads[0]!.endLine,2,"actual bounded prefix, not requested endLine");
    assert.deepEqual(validateCitations([{path:"lines.txt",line:2}],capture), [{path:"lines.txt",line:2}]);
    for(const citation of [{path:"lines.txt",line:3},{path:"missing.txt",line:1},{path:"large.txt",line:1},{path:"empty.txt",line:1}]) assert.throws(()=>validateCitations([citation],capture),/not read/);
    ledger.close();
    const reopened = new SqliteToolLedger(join(root,"tools.sqlite"));
    try { assert.deepEqual(captureReviewReads(reopened,binding),capture); } finally { reopened.close(); }
  } finally { try { ledger.close(); } catch {} rmSync(root,{recursive:true,force:true}); }
});

test("E5 evidence citations require actual same-task evidence content; partial artifacts and foreign-task facts grant no authority", async()=> {
  const root=mkdtempSync(join(tmpdir(),"e5-evidence-")); const artifacts=new ArtifactStore(join(root,"artifacts"));
  const ledger=new SqliteToolLedger(join(root,"tools.sqlite")); const evidence=new SqliteEvidenceStore(join(root,"evidence.sqlite"));
  const broker=new ToolBroker({permissionProfile:"guarded",workspacePath:root,ledger,artifacts});
  for(const tool of [...createArtifactTools(artifacts),...createEvidenceTools({store:evidence,artifacts,taskId:"T1"})]) broker.register(tool);
  try {
    const artifact=await artifacts.put(Buffer.from("command output\n"),"text/plain");
    const empty=await artifacts.put(Buffer.alloc(0),"text/plain");
    const fact={kind:"command" as const,label:"tests",command:"node",args:["--test"],cwd:root,startedAt:initial.occurredAt,finishedAt:initial.occurredAt,exitCode:0,signal:null,timedOut:false,cancelled:false,outputTruncated:false,stdoutArtifactHash:artifact.hash,stderrArtifactHash:empty.hash};
    const own=evidence.record({runId:binding.runId,taskId:"T1",actor:{role:"worker",id:"author"},fact,createdAt:initial.occurredAt,idempotencyKey:"own"});
    const foreign=evidence.record({runId:binding.runId,taskId:"T2",actor:{role:"worker",id:"other"},fact,createdAt:initial.occurredAt,idempotencyKey:"foreign"});
    let ordinal=0;
    const invoke=(name:string,args:unknown)=>broker.invoke({type:"tool_call",callId:`evidence-${++ordinal}`,name,arguments:args},{runId:binding.runId,sessionId:binding.sessionId,actor:{role:"verifier",id:binding.reviewerRuntimeId}});
    await invoke("artifact.read",{hash:artifact.hash,maxBytes:3});
    assert.deepEqual(captureReviewReads(ledger,binding,evidence).reads,[]);
    await invoke("artifact.read",{hash:artifact.hash});
    assert.deepEqual(validateCitations([{evidenceId:own.id}],captureReviewReads(ledger,binding,evidence)),[{evidenceId:own.id}]);
    await invoke("inspect_evidence",{taskId:"T2"});
    assert.throws(()=>validateCitations([{evidenceId:foreign.id}],captureReviewReads(ledger,binding,evidence)),/not read/);
    await invoke("inspect_evidence",{taskId:"T1"});
    assert.ok(captureReviewReads(ledger,binding,evidence).reads.some((r)=>r.toolName==="inspect_evidence" && r.evidenceId===own.id));
  } finally {ledger.close();evidence.close();rmSync(root,{recursive:true,force:true});}
});

test("E5 kernel requires exact trusted capture bindings and reviewer rationale to release survivors",()=>{
  const p=fixture(true,"report_delivered");
  const capture:ReviewReadCapture={...binding,reads:[{invocationKey:`${binding.runId}\0${binding.sessionId}\0read`,completedSequence:2,toolName:"fs.read",path:"src/value.ts",startLine:2,endLine:3}]};
  for(const key of ["runId","taskId","reviewId","changeSetId","submissionAttempt","reviewerRuntimeId","reviewerModelIdentity","sessionId"] as const) assert.throws(()=>validateReadCapture({...capture,[key]:"foreign"},binding),/exact/);
  const captured=reduceSchedulerEvent(p,{...event("delivery.reads_captured",{capture}),actor:{role:"runner",id:"delivery-review-runtime"}});
  const review=captured.delivery!.reviews.T1!;
  review.findings=[{id:"mutation-survivor:0",category:"weakened_obligation",severity:"blocking",claim:"vacuous test",location:"src/value.ts:2",evidenceRefs:["probe"]}];
  const verdict={...event("delivery.review_recorded",{summary:"Confirmed",satisfied:true,claimVerdicts:[{claimId:"claim:c1",status:"verified",rationale:"Read",citations:[{path:"src/value.ts",line:2}]}]}),sequence:3};
  assert.throws(()=>reduceSchedulerEvent(captured,verdict),/unsatisfied exactly/);
  for(const dispositions of [[{findingId:"mutation-survivor:0",disposition:"not_a_real_gap",rationale:""}],[{findingId:"unknown",disposition:"not_a_real_gap",rationale:"Because"}]]) assert.throws(()=>reduceSchedulerEvent(captured,{...verdict,payload:{...verdict.payload,survivorDispositions:dispositions}}));
  const released=reduceSchedulerEvent(captured,{...verdict,payload:{...verdict.payload,survivorDispositions:[{findingId:"mutation-survivor:0",disposition:"not_a_real_gap",rationale:"The mutated branch is outside this criterion."}]}});
  assert.equal(released.delivery!.reviews.T1!.satisfied,true);
  assert.deepEqual(openBlockingFindings(released.delivery!.reviews.T1),[]);
});


test("E5 not-available and non-executed probe outcomes invent no survivor findings; impossible survivor counts fail closed",()=>{
  for(const rung of ["not_available","project_tool"]){
    const next=reduceSchedulerEvent(fixture(true,"diff_delivered"),event("delivery.findings_recorded",{findings:[],depth:{inspectionToolCalls:1,probe:{rung,mutantsGenerated:0,mutantsExecuted:0,mutantsCaught:0,survivors:[],partial:true,evidenceIds:[],notes:["No executable survivor"]}}}));
    assert.deepEqual(next.delivery!.reviews.T1!.findings,[]);
  }
  assert.throws(()=>reduceSchedulerEvent(fixture(true,"diff_delivered"),event("delivery.findings_recorded",{findings:[],depth:{inspectionToolCalls:1,probe:{rung:"builtin_mutator",mutantsGenerated:1,mutantsExecuted:0,mutantsCaught:0,survivors:["invented src/value.ts:1: > -> >="],partial:true,evidenceIds:[],notes:[]}}})),/actually executed/);
});

test("E5 carried survivors retain independent reviewer disposition authority in a fix review",()=>{
  const p=fixture(true,"report_delivered"); const current=p.delivery!.reviews.T1!;
  for (const priorId of ["mutation-survivor:0", "carried:mutation-survivor:0"]) {
  const prior={...structuredClone(current),reviewId:"prior-review",stage:"completed" as const,sessionIds:["prior-session"],findings:[{id:priorId,category:"weakened_obligation" as const,severity:"blocking" as const,claim:"vacuous test",location:"src/value.ts:2",evidenceRefs:["probe"]}]};
  p.delivery!.reviewHistory.T1=[prior];current.priorReviewId=prior.reviewId;
  current.readCapture={...binding,reads:[{invocationKey:`${binding.runId}\0${binding.sessionId}\0read`,completedSequence:2,toolName:"fs.read",path:"src/value.ts",startLine:2,endLine:3}]};
  const verdict=event("delivery.review_recorded",{summary:"Fix",satisfied:true,claimVerdicts:[{claimId:"claim:c1",status:"verified",rationale:"Read",citations:[{path:"src/value.ts",line:2}]}],priorFindingChecks:[{findingId:priorId,resolution:"outstanding",rationale:"Still surviving"}]});
  assert.throws(()=>reduceSchedulerEvent(p,verdict),/unsatisfied exactly/);
  const released=reduceSchedulerEvent(p,{...verdict,payload:{...verdict.payload,survivorDispositions:[{findingId:`carried:${priorId}`,disposition:"not_a_real_gap",rationale:"Prior mutation affects no required behavior."}]}});
  assert.equal(released.delivery!.reviews.T1!.satisfied,true);
  assert.deepEqual(openBlockingFindings(released.delivery!.reviews.T1),[]);
  const blocked=reduceSchedulerEvent(p,{...verdict,payload:{...verdict.payload,satisfied:false}});
  blocked.tasks.T1={id:"T1",status:"architect_review",attempt:1,changeSetId:current.changeSetId} as never;
  assert.throws(()=>reduceSchedulerEvent(blocked,{...event("review.decided",{decision:"approved",findingDispositions:[{findingId:`carried:${priorId}`,resolution:"rejected",rationale:"Architect releases"}]}),sequence:3,actor:{role:"architect",id:"architect"}}),/independent reviewer disposition/);
  }
});

test("E5 a completed read belongs to the latest actual SQLite retry actor, not an earlier starts-only invocation",async()=>{
  const root=mkdtempSync(join(tmpdir(),"e5-retry-"));const ledger=new SqliteToolLedger(join(root,"tools.sqlite"));
  const broker=new ToolBroker({permissionProfile:"guarded",workspacePath:root,ledger});
  for(const tool of createFilesystemTools())broker.register(tool);
  writeFileSync(join(root,"read.txt"),"read\n");
  try {
    for(const [firstActor, completingActor, accepted] of [[binding.reviewerRuntimeId,"foreign",false],[binding.reviewerRuntimeId,binding.reviewerRuntimeId,true],["foreign",binding.reviewerRuntimeId,true]] as const){
      const call={type:"tool_call" as const,callId:`${firstActor}-${completingActor}`,name:"fs.read",arguments:{path:"read.txt"}};
      const key=`${binding.runId}\0${binding.sessionId}\0${call.callId}`;
      ledger.begin({key,fingerprint:toolInvocationFingerprint(call),callId:call.callId,toolName:call.name,runId:binding.runId,sessionId:binding.sessionId,replaySafe:true,effect:"none",access:{capability:"filesystem_read"},outsideWorkspace:false,actor:{role:"verifier",id:firstActor},occurredAt:initial.occurredAt});
      const result=await broker.invoke(call,{runId:binding.runId,sessionId:binding.sessionId,actor:{role:"verifier",id:completingActor}});
      assert.equal(result.isError,false);
      assert.equal(captureReviewReads(ledger,binding).reads.some((read)=>read.invocationKey===key),accepted,"completed attempt actor governs read authority");
    }
  }finally{ledger.close();rmSync(root,{recursive:true,force:true});}
});
