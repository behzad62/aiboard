import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ArtifactStore } from "../src/artifact-store.js";
import { createArtifactTools } from "../src/artifact-tools.js";
import { createEvidenceTools } from "../src/evidence-tools.js";
import type { CommandEvidenceFact, EvidenceRecord } from "../src/evidence-store.js";
import {
  architectReadProofsCoverEvidence,
  architectTurnSessionId,
  captureArchitectEvidenceReads,
  captureReviewReads,
  validateArchitectReadProof,
  validateCitations,
} from "../src/review-evidence.js";
import { SqliteEvidenceStore } from "../src/sqlite-evidence-store.js";
import { SqliteToolLedger } from "../src/sqlite-tool-ledger.js";
import { ToolBroker } from "../src/tool-broker.js";
import { toolInvocationKey } from "../src/tool-ledger.js";

// Bounded evidence inspection: a task list whose combined JSON array spills
// the default inline bound grants no read authority, while an explicit
// singular evidenceId selector returns the exact full immutable record in the
// existing JSON array shape. Real ToolBroker (default cap, unchanged),
// SqliteToolLedger, SqliteEvidenceStore and ArtifactStore throughout; no
// changed threshold, no synthetic receipts, no product-internal mocks.

const RUN = "bounded-inspection-run";
const FOREIGN_RUN = "bounded-inspection-foreign-run";
const TASK = "T1";
const AT = "2026-10-08T00:00:00.000Z";
const SESSION = architectTurnSessionId(RUN);
const ACTOR = "arch:architect";
const REVIEW_SESSION = "bounded-verdict-session";
const REVIEWER = "rev:reviewer";
const REVIEW_BINDING = {
  runId: RUN,
  taskId: TASK,
  reviewId: "review_T1",
  changeSetId: "changeset_T1",
  submissionAttempt: 1,
  reviewerRuntimeId: REVIEWER,
  reviewerModelIdentity: "reviewer",
  sessionId: REVIEW_SESSION,
};

interface Fixture {
  root: string;
  ledger: SqliteToolLedger;
  artifacts: ArtifactStore;
  evidence: SqliteEvidenceStore;
  broker: ToolBroker;
  ordinal: number;
  cleanup: () => void;
}

function setup(): Fixture {
  const root = mkdtempSync(join(tmpdir(), "bounded-evidence-"));
  const ledger = new SqliteToolLedger(join(root, "tools.sqlite"));
  const artifacts = new ArtifactStore(join(root, "artifacts"));
  const evidence = new SqliteEvidenceStore(join(root, "evidence.sqlite"));
  // Default inline bound (8 KiB); never overridden here.
  const broker = new ToolBroker({ permissionProfile: "guarded", workspacePath: root, ledger, artifacts });
  for (const tool of [...createArtifactTools(artifacts), ...createEvidenceTools({ store: evidence, artifacts, taskId: TASK })]) {
    broker.register(tool);
  }
  return {
    root,
    ledger,
    artifacts,
    evidence,
    broker,
    ordinal: 0,
    cleanup: () => {
      ledger.close();
      evidence.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function commandFact(label: string, cwd: string, stdoutHash: string, stderrHash: string): CommandEvidenceFact {
  return {
    kind: "command",
    label,
    command: process.execPath,
    args: ["--test", "test/value.test.mjs"],
    cwd,
    startedAt: AT,
    finishedAt: AT,
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    outputTruncated: false,
    stdoutArtifactHash: stdoutHash,
    stderrArtifactHash: stderrHash,
  };
}

async function seedModest(fixture: Fixture, label: string, key: string, taskId = TASK, runId = RUN): Promise<EvidenceRecord> {
  const stdout = await fixture.artifacts.put(Buffer.from(`stdout ${key}\n`), "text/plain", `${key} stdout`);
  const stderr = await fixture.artifacts.put(Buffer.alloc(0), "text/plain", `${key} stderr`);
  return fixture.evidence.record({
    runId,
    taskId,
    actor: { role: "worker", id: `worker:${taskId}:1` },
    fact: commandFact(`${label} ${"p".repeat(3000)}`, fixture.root, stdout.hash, stderr.hash),
    createdAt: AT,
    idempotencyKey: key,
  });
}

function jsonArray(result: Awaited<ReturnType<ToolBroker["invoke"]>>): unknown[] | undefined {
  const block = result.content.find((entry) => entry.type === "json");
  return block?.type === "json" && Array.isArray(block.value) ? (block.value as unknown[]) : undefined;
}

function textBlocks(result: Awaited<ReturnType<ToolBroker["invoke"]>>): string[] {
  return result.content.filter((entry) => entry.type === "text").map((entry) => (entry as { text: string }).text);
}

function artifactHashes(result: Awaited<ReturnType<ToolBroker["invoke"]>>): string[] {
  return result.content
    .filter((entry) => entry.type === "artifact")
    .map((entry) => (entry as { hash: string }).hash);
}

test("bounded inspection: spilled aggregate grants nothing; singular selector returns the exact record with bound proofs", async () => {
  const fixture = setup();
  try {
    const first = await seedModest(fixture, "check-a", "modest-a");
    const second = await seedModest(fixture, "check-b", "modest-b");
    const third = await seedModest(fixture, "check-c", "modest-c");
    // Self-calibration: each record is individually inline under the unchanged
    // default bound, while the combined array spills.
    const stored = (id: string) => fixture.evidence.getByIds({ runId: RUN, taskId: TASK, ids: [id] })[0]!;
    assert.ok(Buffer.byteLength(JSON.stringify([stored(second.id)])) < 8 * 1024, "one record stays inline");
    assert.ok(Buffer.byteLength(JSON.stringify(fixture.evidence.list({ runId: RUN, taskId: TASK }))) > 8 * 1024, "three records spill");
    const binding = { runId: RUN, sessionId: SESSION, actorId: ACTOR, taskId: TASK };
    const invokeArch = (name: string, args: unknown) =>
      fixture.broker.invoke(
        { type: "tool_call", callId: `arch-${++fixture.ordinal}`, name, arguments: args },
        { runId: RUN, sessionId: SESSION, actor: { role: "architect", id: ACTOR } },
      );
    const invokeReviewer = (name: string, args: unknown) =>
      fixture.broker.invoke(
        { type: "tool_call", callId: `rev-${++fixture.ordinal}`, name, arguments: args },
        { runId: RUN, sessionId: REVIEW_SESSION, actor: { role: "verifier", id: REVIEWER } },
      );

    const aggregate = await invokeArch("inspect_evidence", {});
    assert.equal(aggregate.isError, false, "a successful spill is still a successful call");
    assert.equal(jsonArray(aggregate), undefined, "the spilled aggregate has no inline array");
    assert.match(textBlocks(aggregate).join("\n"), /8192 inline bytes/, "the unchanged default bound is named");
    assert.equal(artifactHashes(aggregate).length, 1);
    assert.deepEqual(captureArchitectEvidenceReads(fixture.ledger, binding, fixture.evidence), [], "spill grants no Architect proof");
    const reviewerAggregate = await invokeReviewer("inspect_evidence", {});
    assert.equal(jsonArray(reviewerAggregate), undefined);
    assert.ok(
      captureReviewReads(fixture.ledger, REVIEW_BINDING, fixture.evidence).reads.every((read) => read.toolName !== "inspect_evidence"),
      "spill grants no reviewer evidence authority",
    );

    const selected = await fixture.broker.invoke(
      { type: "tool_call", callId: "arch-select-second", name: "inspect_evidence", arguments: { evidenceId: second.id } },
      { runId: RUN, sessionId: SESSION, actor: { role: "architect", id: ACTOR } },
    );
    assert.equal(selected.isError, false);
    const inline = jsonArray(selected);
    assert.ok(inline, "the selector stays inline");
    assert.equal(inline.length, 1);
    // Byte-complete: the exact full immutable record, not a projection.
    assert.equal(JSON.stringify(inline), JSON.stringify([stored(second.id)]));
    assert.deepEqual(inline[0], stored(second.id));
    const proofs = captureArchitectEvidenceReads(fixture.ledger, binding, fixture.evidence);
    const inspectProofs = proofs.filter((proof) => proof.toolName === "inspect_evidence");
    assert.equal(inspectProofs.length, 1, "only the selected id is proven");
    assert.equal(inspectProofs[0]!.evidenceId, second.id);
    assert.equal(inspectProofs[0]!.invocationKey, toolInvocationKey({ runId: RUN, sessionId: SESSION }, "arch-select-second"));
    assert.ok(Number.isSafeInteger(inspectProofs[0]!.completedSequence) && inspectProofs[0]!.completedSequence > 0);
    assert.deepEqual(validateArchitectReadProof(inspectProofs[0], RUN, SESSION), inspectProofs[0]);
    assert.deepEqual(architectReadProofsCoverEvidence(proofs, [second.id]), []);
    assert.deepEqual(architectReadProofsCoverEvidence(proofs, [first.id, third.id]), [first.id, third.id]);

    const reviewerSelected = await fixture.broker.invoke(
      { type: "tool_call", callId: "rev-select-second", name: "inspect_evidence", arguments: { taskId: TASK, evidenceId: second.id } },
      { runId: RUN, sessionId: REVIEW_SESSION, actor: { role: "verifier", id: REVIEWER } },
    );
    assert.equal(reviewerSelected.isError, false);
    assert.equal(JSON.stringify(jsonArray(reviewerSelected)), JSON.stringify([stored(second.id)]));
    const capture = captureReviewReads(fixture.ledger, REVIEW_BINDING, fixture.evidence);
    const reviewerReads = capture.reads.filter((read) => read.toolName === "inspect_evidence");
    assert.equal(reviewerReads.length, 1);
    assert.equal(reviewerReads[0]!.evidenceId, second.id);
    assert.deepEqual(validateCitations([{ evidenceId: second.id }], capture), [{ evidenceId: second.id }]);
    assert.throws(() => validateCitations([{ evidenceId: first.id }], capture), /not read/);
  } finally {
    fixture.cleanup();
  }
});

test("bounded inspection: missing, foreign and invalid selectors fail closed without disclosure", async () => {
  const fixture = setup();
  try {
    const own = await seedModest(fixture, "check-own", "own");
    const foreignTask = await seedModest(fixture, "check-foreign-task", "foreign-task", "T2", RUN);
    const foreignRun = await seedModest(fixture, "check-foreign-run", "foreign-run", TASK, FOREIGN_RUN);
    const binding = { runId: RUN, sessionId: SESSION, actorId: ACTOR, taskId: TASK };
    const invokeArch = (name: string, args: unknown, sessionId = SESSION, actor: { role: "architect"; id: string } = { role: "architect", id: ACTOR }) =>
      fixture.broker.invoke(
        { type: "tool_call", callId: `arch-${++fixture.ordinal}`, name, arguments: args },
        { runId: RUN, sessionId, actor },
      );

    for (const args of [{ evidenceId: `evidence_${"0".repeat(64)}` }, { evidenceId: foreignTask.id }, { evidenceId: foreignRun.id }]) {
      const refused = await invokeArch("inspect_evidence", args);
      assert.equal(refused.isError, true, `selector ${JSON.stringify(args)} refuses`);
      assert.equal(refused.error?.code, "evidence_not_found");
      const detail = `${refused.error?.message ?? ""} ${textBlocks(refused).join(" ")}`;
      for (const secret of [foreignTask.id, foreignRun.id, "check-foreign-task", "check-foreign-run"]) {
        assert.ok(!detail.includes(secret), "a refusal discloses no foreign record");
      }
      assert.equal(jsonArray(refused), undefined);
    }
    assert.deepEqual(captureArchitectEvidenceReads(fixture.ledger, binding, fixture.evidence), [], "refusals grant no proof");

    for (const args of [
      { evidenceId: "" },
      { evidenceId: "   " },
      { evidenceId: 123 },
      { evidenceId: ["x"] },
      { evidenceId: null },
      { evidenceId: own.id, bogus: true },
      { taskId: "" },
      { taskId: 1 },
    ]) {
      const rejected = await invokeArch("inspect_evidence", args);
      assert.equal(rejected.isError, true, `selector ${JSON.stringify(args)} rejects`);
      assert.equal(rejected.error?.code, "invalid_arguments");
    }

    // The same foreign-task id succeeds once the requested task actually scopes it.
    const scoped = await invokeArch("inspect_evidence", { taskId: "T2", evidenceId: foreignTask.id });
    assert.equal(scoped.isError, false);
    assert.equal(
      JSON.stringify(jsonArray(scoped)),
      JSON.stringify(fixture.evidence.getByIds({ runId: RUN, taskId: "T2", ids: [foreignTask.id] })),
    );
    assert.deepEqual(
      captureArchitectEvidenceReads(fixture.ledger, binding, fixture.evidence),
      [],
      "a T2 record grants nothing to the T1 binding",
    );
    assert.ok(
      captureArchitectEvidenceReads(fixture.ledger, { ...binding, taskId: "T2" }, fixture.evidence).some(
        (proof) => proof.toolName === "inspect_evidence" && proof.evidenceId === foreignTask.id,
      ),
      "the T2 binding proves its own record",
    );

    // Failed validation and foreign session/actor successes stay outside the binding.
    await invokeArch("inspect_evidence", { evidenceId: "" });
    await invokeArch("inspect_evidence", { evidenceId: own.id }, "foreign-session");
    await invokeArch("inspect_evidence", { evidenceId: own.id }, SESSION, { role: "architect", id: "arch:other" });
    await fixture.broker.invoke(
      { type: "tool_call", callId: `arch-${++fixture.ordinal}`, name: "inspect_evidence", arguments: { evidenceId: own.id } },
      { runId: RUN, sessionId: SESSION, actor: { role: "verifier", id: ACTOR } },
    );
    assert.deepEqual(captureArchitectEvidenceReads(fixture.ledger, binding, fixture.evidence), []);
    const genuine = await invokeArch("inspect_evidence", { evidenceId: own.id });
    assert.equal(JSON.stringify(jsonArray(genuine)), JSON.stringify(fixture.evidence.getByIds({ runId: RUN, taskId: TASK, ids: [own.id] })));
    assert.ok(
      captureArchitectEvidenceReads(fixture.ledger, binding, fixture.evidence).some(
        (proof) => proof.toolName === "inspect_evidence" && proof.evidenceId === own.id,
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test("bounded inspection: an individually oversized record spills without authority and without truncation", async () => {
  const fixture = setup();
  try {
    await seedModest(fixture, "check-small", "small");
    const stdout = await fixture.artifacts.put(Buffer.from("big stdout\n"), "text/plain", "big stdout");
    const stderr = await fixture.artifacts.put(Buffer.alloc(0), "text/plain", "big stderr");
    const big = fixture.evidence.record({
      runId: RUN,
      taskId: TASK,
      actor: { role: "worker", id: "worker:T1:1" },
      fact: commandFact(`check-big ${"q".repeat(9000)}`, fixture.root, stdout.hash, stderr.hash),
      createdAt: AT,
      idempotencyKey: "big",
    });
    const stored = fixture.evidence.getByIds({ runId: RUN, taskId: TASK, ids: [big.id] })[0]!;
    assert.ok(Buffer.byteLength(JSON.stringify([stored])) > 8 * 1024, "one record alone exceeds the bound");
    const binding = { runId: RUN, sessionId: SESSION, actorId: ACTOR, taskId: TASK };

    const spilled = await fixture.broker.invoke(
      { type: "tool_call", callId: "arch-select-big", name: "inspect_evidence", arguments: { evidenceId: big.id } },
      { runId: RUN, sessionId: SESSION, actor: { role: "architect", id: ACTOR } },
    );
    assert.equal(spilled.isError, false, "an oversized selector still succeeds as a call");
    assert.equal(jsonArray(spilled), undefined, "it carries no inline array");
    assert.deepEqual(captureArchitectEvidenceReads(fixture.ledger, binding, fixture.evidence), [], "it grants no proof");
    const hashes = artifactHashes(spilled);
    assert.equal(hashes.length, 1);
    assert.equal((await fixture.artifacts.get(hashes[0]!)).toString("utf8"), JSON.stringify([stored]), "the spill keeps every byte");

    // Existing partial-artifact behavior is unchanged: a bounded prefix proves
    // nothing, while the complete read binds its owning evidence.
    const partial = await fixture.broker.invoke(
      { type: "tool_call", callId: "arch-partial", name: "artifact.read", arguments: { hash: stdout.hash, maxBytes: 3 } },
      { runId: RUN, sessionId: SESSION, actor: { role: "architect", id: ACTOR } },
    );
    assert.equal(partial.isError, false);
    assert.deepEqual(captureArchitectEvidenceReads(fixture.ledger, binding, fixture.evidence), []);
    const complete = await fixture.broker.invoke(
      { type: "tool_call", callId: "arch-complete", name: "artifact.read", arguments: { hash: stdout.hash } },
      { runId: RUN, sessionId: SESSION, actor: { role: "architect", id: ACTOR } },
    );
    assert.equal(complete.isError, false);
    assert.ok(
      captureArchitectEvidenceReads(fixture.ledger, binding, fixture.evidence).some(
        (proof) => proof.toolName === "artifact.read" && proof.evidenceId === big.id && proof.artifactHash === stdout.hash,
      ),
    );
  } finally {
    fixture.cleanup();
  }
});

test("bounded inspection: the no-selector list stays exactly compatible", async () => {
  const fixture = setup();
  try {
    const stdout = await fixture.artifacts.put(Buffer.from("tiny\n"), "text/plain", "tiny stdout");
    const stderr = await fixture.artifacts.put(Buffer.alloc(0), "text/plain", "tiny stderr");
    const expected = [
      fixture.evidence.record({
        runId: RUN,
        taskId: TASK,
        actor: { role: "worker", id: "worker:T1:1" },
        fact: commandFact("tiny-a", fixture.root, stdout.hash, stderr.hash),
        createdAt: AT,
        idempotencyKey: "tiny-a",
      }),
      fixture.evidence.record({
        runId: RUN,
        taskId: TASK,
        actor: { role: "worker", id: "worker:T1:1" },
        fact: commandFact("tiny-b", fixture.root, stdout.hash, stderr.hash),
        createdAt: AT,
        idempotencyKey: "tiny-b",
      }),
    ];
    await seedModest(fixture, "check-other-task", "other-task", "T2", RUN);
    for (const args of [{}, { taskId: TASK }]) {
      const listed = await fixture.broker.invoke(
        { type: "tool_call", callId: `arch-list-${++fixture.ordinal}`, name: "inspect_evidence", arguments: args },
        { runId: RUN, sessionId: SESSION, actor: { role: "architect", id: ACTOR } },
      );
      assert.equal(listed.isError, false);
      assert.deepEqual(jsonArray(listed), expected);
      assert.deepEqual(jsonArray(listed), fixture.evidence.list({ runId: RUN, taskId: TASK }));
    }
    const binding = { runId: RUN, sessionId: SESSION, actorId: ACTOR, taskId: TASK };
    const covered = captureArchitectEvidenceReads(fixture.ledger, binding, fixture.evidence)
      .filter((proof) => proof.toolName === "inspect_evidence")
      .map((proof) => proof.evidenceId);
    assert.ok(covered.includes(expected[0]!.id) && covered.includes(expected[1]!.id));
  } finally {
    fixture.cleanup();
  }
});
