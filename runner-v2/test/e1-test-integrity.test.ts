import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runGit } from "./support/git-fixture.js";
import { ensurePlanningProvisioningPrefix } from "../src/native-planning-provisioner.js";
import { SqliteSchedulerStore } from "../src/sqlite-scheduler-store.js";
import { validateSchedulerEvidenceEvent, rebuildSchedulerProjection, type SchedulerEvent, type SchedulerProjection } from "../src/scheduler-store.js";
import type { EvidenceStore, EvidenceRecord } from "../src/evidence-store.js";
import { inspectTestIntegrityPin } from "../src/test-integrity-profile.js";
import {
  assertNoConfiguredTestSuite, testIntegrityBaselineFindings, executedTestCount, testIntegrityCountFindings, testIntegrityExceptionMatches,
  testIntegrityProfileFindings, unresolvedTestIntegrityFindings,
  type TestIntegrityBinding, type TestIntegrityException, type TestIntegrityPin,
} from "../src/test-integrity.js";

const binding: TestIntegrityBinding = { taskId: "task-1", integrationRevision: "candidate-1", planRevisionId: "plan-1", planDigest: "a".repeat(64), baselineRevision: "baseline-1", submissionAttempt: 1, changeSetId: "change-1", baselinePinDigest: "b".repeat(64), candidatePinDigest: "c".repeat(64) };
const baseline: TestIntegrityPin = { revision: binding.baselineRevision, commands: [{ executable: "npm", args: ["run", "test"] }], script: "node --test test/*.test.mjs", configDigest: "b".repeat(64) };

test("E1 mechanical command pin sees script narrowing even with identical npm wrapper", () => {
  assert.deepEqual(testIntegrityProfileFindings(baseline, { ...baseline, revision: binding.integrationRevision }), []);
  const findings = testIntegrityProfileFindings(baseline, { ...baseline, script: "node --test test/trivial.test.mjs" });
  assert.ok(findings.some((finding) => finding.code === "test_command_changed"), "actual script narrowing must be flagged despite an identical npm wrapper");
  assert.equal(testIntegrityProfileFindings(baseline, { ...baseline, configDigest: "c".repeat(64) })[0]!.code, "test_config_changed");
});

test("E1 mechanical counts flag deleted cases and exclude skipped/selected totals", () => {
  assert.equal(executedTestCount({ passed: 41, failed: 1 }), 42);
  assert.equal(executedTestCount({ passed: 0, failed: 0 }), undefined);
  assert.equal(executedTestCount({ passed: -1, failed: 2 }), undefined);
  assert.ok(testIntegrityCountFindings(42, 41).some((finding) => finding.code === "suite_shrank" && /42→41/.test(finding.message)), "executed-count shrink must be flagged");
  assert.deepEqual(testIntegrityCountFindings(42, 42), []);
  assert.deepEqual(testIntegrityCountFindings(42, 43), []);
  assert.equal(testIntegrityCountFindings(undefined, 41)[0]!.code, "baseline_counts_unknown");
});

test("E1 mechanical exceptions bind every authority identity and require consolidation proof", () => {
  const exception: TestIntegrityException = { ...binding, id: "reason-1", kind: "plan_revision_reason", reason: "Plan explicitly replaces the former suite.", authoritySequence: 9, allowedChanges: ["suite_shrank"], minimumExecuted: 41 };
  assert.equal(testIntegrityExceptionMatches(exception, binding), true);
  const retry = { ...binding, version: 1, exceptionId: exception.id, candidateExecuted: 41 };
  assert.equal(testIntegrityExceptionMatches(exception, retry), true, "identity matching excludes newly measured counts and transport metadata");
  for (const key of Object.keys(binding) as (keyof TestIntegrityBinding)[]) assert.equal(testIntegrityExceptionMatches({ ...exception, [key]: "foreign" }, binding), false, key);
  assert.equal(testIntegrityExceptionMatches({ ...exception, authoritySequence: 0 }, binding), false);
  assert.equal(testIntegrityExceptionMatches({ ...exception, kind: "reviewed_consolidation" }, binding), false);
  const disposition = { ...exception, kind: "reviewed_consolidation" as const, behaviorProof: "test/merged.test.mjs:merged behavior" };
  assert.equal(testIntegrityExceptionMatches(disposition, binding), true);
  const shrink = testIntegrityCountFindings(42, 41);
  assert.deepEqual(unresolvedTestIntegrityFindings({ findings: shrink, binding, exception: disposition, candidateExecuted: 41 }), []);
  assert.deepEqual(unresolvedTestIntegrityFindings({ findings: shrink, binding, exception: disposition, candidateExecuted: 40 }), shrink);
  assert.deepEqual(unresolvedTestIntegrityFindings({ findings: shrink, binding }), shrink);
  const unknown = testIntegrityCountFindings(undefined, 41);
  assert.deepEqual(unresolvedTestIntegrityFindings({ findings: unknown, binding, exception: disposition }), unknown);
});

test("E1 Git profile pin reads immutable script and configuration additions rather than candidate worktree bytes", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-e1-pin-"));
  const git = async (...args: string[]) => (await runGit({ cwd: root, args })).stdout.trim();
  try {
    await git("init", "-b", "main");
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test test/*.test.mjs", pretest: "node prepare.mjs" } }));
    await git("add", "--all"); await git("commit", "-m", "trusted baseline"); const initial = await git("rev-parse", "HEAD");
    const inspect = (revision: string) => inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision, commands: baseline.commands });
    const pinned = await inspect(initial);
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test trivial.mjs" } }));
    assert.deepEqual(await inspect(initial), pinned, "uncommitted narrowing cannot alter the immutable baseline pin");
    await git("add", "--all"); await git("commit", "-m", "narrowed script");
    const narrowed = await inspect(await git("rev-parse", "HEAD"));
    assert.ok(testIntegrityProfileFindings(pinned, narrowed).some((finding) => finding.code === "test_command_changed"));
    writeFileSync(join(root, "vitest.config.ts"), "export default {coverage:{thresholds:{lines:0}}};\n");
    await git("add", "--all"); await git("commit", "-m", "changed config");
    const configured = await inspect(await git("rev-parse", "HEAD"));
    assert.ok(testIntegrityProfileFindings(narrowed, configured).some((finding) => finding.code === "test_config_changed"));
    assert.deepEqual(await inspect(initial), pinned);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E1 no-suite inventory proof is nonnumeric and refuses malformed, tested or uninspected initial trees", () => {
  const pin: TestIntegrityPin = { ...baseline, commands: [], script: undefined, hasTestSignals: false };
  const inventory = "100644 blob " + "a".repeat(40) + "\tREADME.md\0";
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  assert.doesNotThrow(() => assertNoConfiguredTestSuite(pin, inventory, digest(inventory)));
  for (const path of ["test/value.mjs", "value.test.mjs", "vitest.workspace.ts", "validation/pytest.ini"]) {
    const tree = inventory + "100644 blob " + "b".repeat(40) + "\t" + path + "\0";
    assert.throws(() => assertNoConfiguredTestSuite(pin, tree, digest(tree)));
  }
  const submodule = inventory + "160000 commit " + "b".repeat(40) + "\tvendor/submodule\0";
  assert.throws(() => assertNoConfiguredTestSuite(pin, submodule, digest(submodule)));
  assert.throws(() => assertNoConfiguredTestSuite(pin, inventory, "f".repeat(64)));
  assert.throws(() => assertNoConfiguredTestSuite({ ...pin, hasTestSignals: true }, inventory, digest(inventory)));
  assert.throws(() => assertNoConfiguredTestSuite(baseline, inventory, digest(inventory)));
  assert.deepEqual(testIntegrityBaselineFindings({ kind: "no_configured_test_suite", pin }, baseline, 2), [], "first-suite bootstrap has no invented zero denominator");
  assert.equal(executedTestCount({ passed: 0, failed: 0 }), undefined, "bootstrap preserves zero/unknown rejection");
});

test("E1 custom pytest selector, Vitest workspace, lifecycle helper and config imports are pinned", async () => {
  const root = mkdtempSync(join(tmpdir(), "runner-e1-controls-"));
  const git = async (...args: string[]) => (await runGit({ cwd: root, args })).stdout.trim();
  try {
    await git("init", "-b", "main"); mkdirSync(join(root, "validation"));
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "pytest -c 'validation/settings.ini'", pretest: "node prepare.mjs" } }));
    writeFileSync(join(root, "validation/settings.ini"), "[pytest]\n");
    writeFileSync(join(root, "conftest.py"), "# complete collection\n");
    writeFileSync(join(root, "prepare.mjs"), "import './collection.mjs';\n"); writeFileSync(join(root, "collection.mjs"), "export const selection = 'all';\n");
    writeFileSync(join(root, "vitest.workspace.ts"), "import { selection } from './suite-selection.ts'; export default selection;\n"); writeFileSync(join(root, "suite-selection.ts"), "export const selection = ['all'];\n");
    await git("add", "--all"); await git("commit", "-m", "trusted test controls");
    const inspect = async () => inspectTestIntegrityPin({ git: runGit, repositoryRoot: root, revision: await git("rev-parse", "HEAD"), commands: baseline.commands });
    let pinned = await inspect();
    for (const [path, content] of [["conftest.py", "# changed collection\n"], ["validation/settings.ini", "[pytest]\naddopts = -k trivial\n"], ["vitest.workspace.ts", "export default ['trivial'];\n"], ["suite-selection.ts", "export const selection = ['trivial'];\n"], ["collection.mjs", "export const selection = 'trivial';\n"]]) {
      // Restore workspace import before its transitive dependency mutation.
      if (path === "suite-selection.ts") writeFileSync(join(root, "vitest.workspace.ts"), "import { selection } from './suite-selection.ts'; export default selection;\n");
      writeFileSync(join(root, path!), content!); await git("add", "--all"); await git("commit", "-m", `change ${path}`);
      const candidate = await inspect(); assert.ok(testIntegrityProfileFindings(pinned, candidate).some((finding) => finding.code === "test_config_changed"), path); pinned = candidate;
    }
    writeFileSync(join(root, "package.json"), JSON.stringify({ scripts: { test: "node --test --import './environment-setup.mjs'" } }));
    writeFileSync(join(root, "environment-setup.mjs"), "export const selection = 'all';\n");
    await git("add", "--all"); await git("commit", "-m", "node setup baseline"); pinned = await inspect();
    writeFileSync(join(root, "environment-setup.mjs"), "export const selection = 'trivial';\n");
    await git("add", "--all"); await git("commit", "-m", "change node setup");
    assert.ok(testIntegrityProfileFindings(pinned, await inspect()).some((finding) => finding.code === "test_config_changed"));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("E1 initial-baseline command authority rejects foreign revision, actor and interrupted observations", () => {
  const projection = { runId: "e1", testIntegrity: { initialRevision: baseline.revision } } as SchedulerProjection;
  const event: SchedulerEvent = { runId: "e1", eventId: "baseline", sequence: 5, occurredAt: "2026-10-04T00:00:00Z", type: "delivery.test_integrity_baseline_recorded", actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "initial", payload: { taskId: "task-1", kind: "executed_report", pin: baseline, evidenceIds: ["command-1"] } };
  const record: EvidenceRecord = { id: "command-1", runId: "e1", taskId: "delivery:task-1", actor: { role: "verifier", id: "delivery-check-runtime" }, status: "observed", createdAt: event.occurredAt, idempotencyKey: "e1:initial-tests:1", fact: { kind: "command", label: "baseline tests", command: "node", args: ["--test"], cwd: "/fixture", startedAt: event.occurredAt, finishedAt: event.occurredAt, exitCode: 1, signal: null, timedOut: false, cancelled: false, outputTruncated: false, stdoutArtifactHash: "a".repeat(64), stderrArtifactHash: "b".repeat(64), repositoryRevision: baseline.revision } };
  const validate = (records: EvidenceRecord[]) => validateSchedulerEvidenceEvent(projection, event, { getByIds: () => records } as unknown as EvidenceStore);
  assert.doesNotThrow(() => validate([record]), "completed failed tests can establish positive denominator");
  assert.throws(() => validate([]));
  assert.throws(() => validate([{ ...record, actor: { role: "worker", id: "foreign" } }]));
  assert.throws(() => validate([{ ...record, taskId: "delivery:foreign" }]));
  for (const delta of [{ repositoryRevision: "foreign" }, { timedOut: true }, { cancelled: true }, { exitCode: null }]) {
    assert.throws(() => validate([{ ...record, fact: { ...record.fact, ...delta } as typeof record.fact }]));
  }
});

test("E1 own provisioning retry, historical prefix and missing evidence store fail closed", () => {
  const root = mkdtempSync(join(tmpdir(), "runner-e1-prefix-"));
  const store = new SqliteSchedulerStore(join(root, "scheduler.sqlite"));
  const spec = { runId: "e1-prefix", objective: "guard tests", planningPolicy: { version: 1 as const } };
  try {
    ensurePlanningProvisioningPrefix(store, spec); const prefix = store.readRun(spec.runId);
    assert.equal(prefix[1]!.payload.testIntegrityPolicyVersion, 1);
    ensurePlanningProvisioningPrefix(store, spec); assert.deepEqual(store.readRun(spec.runId), prefix);
    const old = prefix.map((event) => event.type === "run.initialized" ? { ...event, payload: { objective: spec.objective } } : event);
    let writes = 0;
    ensurePlanningProvisioningPrefix({ readRun: () => old, append: () => { writes++; throw new Error("unexpected history rewrite"); } }, spec);
    assert.equal(writes, 0); assert.equal(rebuildSchedulerProjection(old).testIntegrity, undefined, "no invented historical activation");
    for (const payload of [{ ...prefix[1]!.payload, testIntegrityPolicyVersion: 2 }, { ...prefix[1]!.payload, foreign: true }]) {
      assert.throws(() => ensurePlanningProvisioningPrefix({ readRun: () => prefix.map((event) => event.type === "run.initialized" ? { ...event, payload } : event), append: () => { throw new Error("unexpected append"); } }, spec));
    }
    store.append({ runId: spec.runId, type: "delivery.test_integrity_initialized", occurredAt: prefix[0]!.occurredAt, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "initial-revision", payload: { revision: baseline.revision, architectActorId: "architect_1" } });
    assert.throws(() => store.append({ runId: spec.runId, type: "delivery.test_integrity_baseline_recorded", occurredAt: prefix[0]!.occurredAt, actor: { role: "runner", id: "build-runtime" }, idempotencyKey: "baseline", payload: { taskId: "task-1", kind: "executed_report", pin: baseline, report: { status: "passed", runner: "node", path: "report.xml", artifactHash: "a".repeat(64), counts: { selected: 2, passed: 2, failed: 0, skipped: 0 } }, evidenceIds: ["foreign-command"] } }), /authoritative evidence store/);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
});

test("E1 authorized command changes still obey their exact executed-count floor", () => {
  const exception: TestIntegrityException = { ...binding, id: "reason-floor", kind: "plan_revision_reason", reason: "Current plan approves the changed selector only with three executed tests.", authoritySequence: 9, allowedChanges: ["test_command_changed"], minimumExecuted: 3 };
  const findings = testIntegrityProfileFindings(baseline, { ...baseline, script: "node --test changed.mjs" });
  assert.deepEqual(unresolvedTestIntegrityFindings({ findings, binding, exception }), [], "preflight permits authorized execution before counts exist");
  assert.deepEqual(unresolvedTestIntegrityFindings({ findings, binding, exception, candidateExecuted: 2 }), findings, "post-execution floor cannot be waived");
  assert.deepEqual(unresolvedTestIntegrityFindings({ findings, binding, exception, candidateExecuted: 3 }), []);
});
