import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { captureGitBaseline, runGit } from "./support/git-fixture.js";
import {
  findOscillatingRepairAttempt,
  repairDiffFingerprint,
  repairDiffReverseFingerprint,
} from "../src/review-key.js";
import type { AgentModel, AgentModelRequest, ModelTurn } from "../src/agent-contracts.js";
import { ArtifactStore } from "../src/artifact-store.js";
import { ControlServer } from "../src/control-server.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";
import { SqliteBuildSpecStore } from "../src/sqlite-build-spec-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { NativeBuildManager } from "../src/native-build-manager.js";
import type { RunnerProviderConfig } from "../src/provider-config-store.js";
import { buildExecutionPlanRevision, type ExecutionPlanPhase, type SourceRequirement } from "../src/planning-contracts.js";
import { NativeBuildFactory } from "../src/native-build-factory.js";
import { buildApprovedSourceManifest, validateApprovedSourceInput, type ApprovedSourceInputV1 } from "../src/native-planning-provisioner.js";
import { currentExplicitStartIdentity, type SchedulerProjection } from "../src/scheduler-store.js";
import { computeArtifactDigest } from "../src/source-manifest.js";
import { deliverySessionId } from "../src/native-deliverable-review.js";
import type { DeliveryReviewDriver } from "../src/build-runtime.js";

/**
 * W1 product review (CD7): an authentic unseeded authenticated
 * NativeBuildFactory -> BuildRuntime.step journey over real
 * SQLite/Git task submission/review/acceptance. Attempt 1 ships the
 * behavior without a pinning test and fails on a real blocking
 * coverage finding (rejection charges one cycle per issue lineage).
 * A model interruption after a real verdict-session read pauses the
 * review; closing and reopening the native manager/factory resumes the
 * first missing stage in a fresh session without repeating findings.
 * Attempt 2 ships the module plus a genuine pinning test, resolves
 * the carried coverage blocker with inspected rationale, and the task
 * accepts. A real-Git A->B/B->A reversal proof covers oscillation at
 * the helper level. Only the model transport is scripted; Git,
 * SQLite, the scheduler, sessions, artifacts and evidence are all real.
 */

async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runGit({ cwd, args });
  assert.equal(result.exitCode, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

test("W1 product: real Git A->B and B->A diffs oscillate; shifted headers match; unrelated misses", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-w1-git-"));
  try {
    await git(root, ["init"]);
    mkdirSync(join(root, "src"), { recursive: true });
    // Multi-line change with unequal hunk sizes: three lines grow to
    // eight in one hunk, one line shrinks in another.
    writeFileSync(join(root, "src", "feature.ts"), "export const a = 1;\nexport const b = 1;\nexport const c = 1;\n");
    writeFileSync(join(root, "src", "other.ts"), "export const z = 0;\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "A"]);
    const revA = (await git(root, ["rev-parse", "HEAD"])).trim();
    writeFileSync(
      join(root, "src", "feature.ts"),
      "export const a = 1;\nexport const b = 2;\nexport const c = 3;\nexport const d = 4;\nexport const e = 5;\nexport const f = 6;\nexport const g = 7;\nexport const h = 8;\n",
    );
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "B"]);
    const revB = (await git(root, ["rev-parse", "HEAD"])).trim();
    // Actual Git in both directions: never a synthesized inverse.
    const forwardText = await git(root, ["diff", revA, revB, "--"]);
    const reverseText = await git(root, ["diff", revB, revA, "--"]);
    assert.ok(forwardText.length > 0 && reverseText.length > 0, "real diffs in both directions");
    assert.match(forwardText, /^diff --git /m);
    const failed = [{
      attempt: 1,
      forward: repairDiffFingerprint(forwardText),
      reverse: repairDiffReverseFingerprint(forwardText),
    }];
    assert.equal(
      findOscillatingRepairAttempt(
        repairDiffFingerprint(reverseText),
        repairDiffReverseFingerprint(reverseText),
        failed,
      ),
      1,
      "the real B->A diff repeats the failed A->B repair",
    );
    const shifted = forwardText
      .replace(/index [0-9a-f]+\.\.[0-9a-f]+ \d+/g, "index 0000000..1111111 100644")
      .replace(/@@ -\d+(,\d+)? \+\d+(,\d+)? @@/g, "@@ -99,9 +77,7 @@");
    assert.equal(
      findOscillatingRepairAttempt(repairDiffFingerprint(shifted), repairDiffReverseFingerprint(shifted), failed),
      1,
      "the same meaningful repair under shifted Git headers still matches",
    );
    const crlf = forwardText.replaceAll("\n", "\r\n");
    assert.equal(
      findOscillatingRepairAttempt(repairDiffFingerprint(crlf), repairDiffReverseFingerprint(crlf), failed),
      1,
      "the same meaningful repair under CRLF still matches",
    );
    const unrelatedText = [
      "diff --git a/src/other.ts b/src/other.ts",
      "--- a/src/other.ts",
      "+++ b/src/other.ts",
      "@@ -1 +1 @@",
      "-export const z = 0;",
      "+export const z = 99;",
      "",
    ].join("\n");
    assert.equal(
      findOscillatingRepairAttempt(
        repairDiffFingerprint(unrelatedText),
        repairDiffReverseFingerprint(unrelatedText),
        failed,
      ),
      undefined,
      "an unrelated substantive repair is never flagged",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("W1 product: real Git mode-only, order, rename, add/delete and binary identity", async () => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-w1-gitid-"));
  try {
    await git(root, ["init"]);
    await git(root, ["config", "user.email", "w1-review@example.invalid"]);
    await git(root, ["config", "user.name", "W1 Reviewer"]);
    await git(root, ["config", "core.autocrlf", "false"]);
    writeFileSync(join(root, "a.sh"), "echo a\n");
    writeFileSync(join(root, "b.sh"), "echo b\n");
    writeFileSync(join(root, "steps.ts"), "// steps\n");
    writeFileSync(join(root, "old.ts"), "export const old = 1;\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "base"]);
    const base = (await git(root, ["rev-parse", "HEAD"])).trim();
    // Mode-only repairs on unrelated paths never share identity.
    await git(root, ["update-index", "--chmod=+x", "a.sh"]);
    await git(root, ["commit", "-m", "mode A"]);
    const modeA = await git(root, ["diff", base, "HEAD", "--"]);
    await git(root, ["update-index", "--chmod=-x", "a.sh"]);
    await git(root, ["update-index", "--chmod=+x", "b.sh"]);
    await git(root, ["commit", "-m", "mode B"]);
    const modeB = await git(root, ["diff", base, "HEAD", "--"]);
    assert.notEqual(repairDiffFingerprint(modeA), repairDiffFingerprint(modeB), "mode repairs on different files are unrelated");
    // Ordered substantive additions remain distinct.
    writeFileSync(join(root, "steps.ts"), "// steps\nopen();\nclose();\n");
    await git(root, ["add", "steps.ts"]);
    await git(root, ["commit", "-m", "open close"]);
    const orderedBase = (await git(root, ["rev-parse", "HEAD~1"])).trim();
    const orderedHead = (await git(root, ["rev-parse", "HEAD"])).trim();
    const openClose = await git(root, ["diff", orderedBase, orderedHead, "--"]);
    writeFileSync(join(root, "steps.ts"), "// steps\nclose();\nopen();\n");
    await git(root, ["add", "steps.ts"]);
    await git(root, ["commit", "-m", "close open"]);
    const swappedHead = (await git(root, ["rev-parse", "HEAD"])).trim();
    const closeOpen = await git(root, ["diff", orderedBase, swappedHead, "--"]);
    assert.notEqual(repairDiffFingerprint(openClose), repairDiffFingerprint(closeOpen), "reordered statements are a different repair");
    // Pure rename without ---/+++: the real B->A diff matches the synthetic reverse.
    await git(root, ["mv", "old.ts", "new.ts"]);
    await git(root, ["commit", "-m", "rename"]);
    const renameBase = (await git(root, ["rev-parse", "HEAD~1"])).trim();
    const renameHead = (await git(root, ["rev-parse", "HEAD"])).trim();
    const renameForward = await git(root, ["diff", renameBase, renameHead, "--"]);
    const renameReverse = await git(root, ["diff", renameHead, renameBase, "--"]);
    assert.ok(!renameForward.includes("--- "), "a pure rename carries no file headers");
    const renameFailed = [{
      attempt: 1,
      forward: repairDiffFingerprint(renameForward),
      reverse: repairDiffReverseFingerprint(renameForward),
    }];
    assert.equal(
      findOscillatingRepairAttempt(repairDiffFingerprint(renameReverse), repairDiffReverseFingerprint(renameReverse), renameFailed),
      1,
      "the real B->A rename matches the failed A->B rename",
    );
    // Add/delete reversal: a real add reversed is a real delete.
    writeFileSync(join(root, "fresh.ts"), "export const fresh = 1;\n");
    await git(root, ["add", "fresh.ts"]);
    await git(root, ["commit", "-m", "add fresh"]);
    const addBase = (await git(root, ["rev-parse", "HEAD~1"])).trim();
    const addHead = (await git(root, ["rev-parse", "HEAD"])).trim();
    const addDiff = await git(root, ["diff", addBase, addHead, "--"]);
    const delDiff = await git(root, ["diff", addHead, addBase, "--"]);
    const addFailed = [{
      attempt: 2,
      forward: repairDiffFingerprint(addDiff),
      reverse: repairDiffReverseFingerprint(addDiff),
    }];
    assert.equal(
      findOscillatingRepairAttempt(repairDiffFingerprint(delDiff), repairDiffReverseFingerprint(delDiff), addFailed),
      2,
      "the real delete matches the reverse of the failed add",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

const W1_RUN = "run_w1_product_journey";
const W1_CLOCK = "2026-10-03T00:00:00.000Z";
const W1_SOURCE = "SECTION s1: MANDATORY. The value module must export the value 2.\r\nSECTION s2: OPERATIONAL. Maintain the value behavior and its tests.\r\n";
const W1_VALUE_TEST = "import test from 'node:test'; import assert from 'node:assert/strict'; import { value } from '../src/value.mjs'; test('value criterion', () => assert.equal(value, 2));\n";

function w1SourceBytes(text: string): Uint8Array { return new Uint8Array(Buffer.from(text, "utf8")); }

function w1SourceInput(text: string): ApprovedSourceInputV1 {
  const firstEnd = Buffer.byteLength(`${text.split("\n")[0]!}\n`, "utf8");
  return {
    version: 1, approval: "approved_spec", bytesBase64: Buffer.from(text).toString("base64"),
    mediaType: "text/plain", encoding: "utf-8",
    sections: [
      { id: "s1", startByte: 0, endByte: firstEnd },
      { id: "s2", startByte: firstEnd, endByte: Buffer.byteLength(text, "utf8") },
    ],
  };
}

function w1JourneyScenario(runId: string) {
  const bytes = w1SourceBytes(W1_SOURCE);
  const validated = validateApprovedSourceInput(w1SourceInput(W1_SOURCE));
  const manifest = buildApprovedSourceManifest({
    runId, validated, artifactDigest: computeArtifactDigest(bytes), approvedBy: "local-user", createdAt: W1_CLOCK,
  });
  const requirements: SourceRequirement[] = [{
    id: "REQ-1",
    reference: { sourceId: manifest.sourceId, sectionIds: ["s1", "s2"] },
    purpose: "Export the value 2.",
    observableOutcome: "The value module exports 2.",
    obligationKind: "mandatory",
    applicability: { status: "applicable" },
    accountablePhaseId: "P1",
    contributingTaskIds: ["T1"],
    acceptanceConditions: [{ id: "REQ-1-ac1", description: "value is 2.", responsibleGateId: "P1-exit", requiredEvidenceKinds: ["command"] }],
  }];
  const phases: ExecutionPlanPhase[] = [{
    id: "P1",
    purpose: "Deliver the value module.",
    requirementIds: ["REQ-1"],
    scope: { includes: ["src/value.mjs", "test/value.test.mjs", "package.json"], excludes: [] },
    entryConditions: ["Plan ready."],
    contributingTaskIds: ["T1"],
    exitCriteria: ["The value module is accepted."],
    requiredCombinedValidation: ["tests"],
    exitUnlocks: ["final verification"],
  }];
  const revision = buildExecutionPlanRevision({
    revisionId: "revision_w1",
    runId,
    sourceManifestId: manifest.manifestId,
    sourceManifestDigest: manifest.artifactDigest,
    requirements,
    tasks: [{
      id: "T1",
      lineage: [],
      accountablePhaseId: "P1",
      requirementIds: ["REQ-1"],
      outcome: { user: "Create src/value.mjs exporting value = 2.", system: "The value module exports 2." },
      scope: { includes: ["src/value.mjs", "test/value.test.mjs", "package.json"], excludes: [] },
      writableSurfaces: ["src/value.mjs", "test/value.test.mjs", "package.json"],
      forbiddenSurfaces: ["infra/**", "docs/plans/**"],
      dependencies: [],
      requiredBase: "accepted plan revision revision_w1",
      inputs: ["accepted plan revision"],
      outputs: ["src/value.mjs"],
      steps: ["Write the module.", "Run the tests."],
      acceptance: { criteria: [{ id: "c1", text: "src/value.mjs exports value = 2 and the tests pass." }], definitionOfDone: "Tests pass." },
      validation: { targetedRationale: "The value test.", affectedScopeRationale: "The module only." },
      negativeProofApplicability: { applicable: false, rationale: "A new module has no prior-incorrect case." },
      reviewCriteria: ["Independent review confirms the value."],
      integrationChecks: ["Post-integration tests."],
      cleanup: { cleanup: "None.", recovery: "Retry.", rollback: "Revert." },
      requirementCriteriaMap: [{ taskLocalCriterionId: "c1", requirementId: "REQ-1" }],
    }],
    phases,
    workflowPolicyVersion: 1,
    planningDecisions: [],
    validationObligations: ["tests"],
    createdAt: W1_CLOCK,
  });
  return { manifest, requirements, phases, revision };
}

const w1Call = (name: string, args: unknown, id: string): ModelTurn => ({
  blocks: [{ type: "tool_call", callId: id, name, arguments: args }],
  stopReason: "tool_calls",
  usage: { inputTokens: 8, outputTokens: 4 },
});

function w1JourneyEnvironment() {
  const ambient = { ...snapshotNativeBuildAmbientEnvironment() };
  delete ambient.NODE_TEST_CONTEXT;
  return Object.freeze(ambient);
}

function w1LastToolValue(request: AgentModelRequest): Record<string, unknown> | undefined {
  const message = [...request.messages].reverse().find((candidate) => candidate.role === "tool");
  const content = (message?.content as { content?: Array<{ type: string; value?: unknown }> } | undefined)?.content;
  return content?.find((item) => item.type === "json")?.value as Record<string, unknown> | undefined;
}

interface W1ToolResultView {
  toolName?: string;
  isError?: boolean;
}

function w1ToolResults(request: AgentModelRequest): W1ToolResultView[] {
  return request.messages
    .filter((message) => message.role === "tool")
    .map((message) => (message.content ?? {}) as W1ToolResultView);
}

function w1ReadText(request: AgentModelRequest, path: string): string | undefined {
  for (const message of request.messages) {
    if (message.role !== "tool") continue;
    const content = message.content as { toolName?: string; content?: Array<{ type: string; value?: unknown; text?: string }> };
    if (content.toolName !== "fs.read") continue;
    const meta = content.content?.find((item) => item.type === "json")?.value as { path?: string } | undefined;
    if (meta?.path !== path) continue;
    const text = content.content?.find((item) => item.type === "text")?.text;
    if (typeof text === "string") return text;
  }
  return undefined;
}

const W1_COVERAGE_FINDING = {
  id: "finding:coverage-gap",
  category: "missing_coverage",
  severity: "blocking",
  claim: "The change revises src/value.mjs without adding a test that pins the new value-2 behavior.",
  location: "src/value.mjs",
  evidenceRefs: ["test/value.test.mjs:1"],
  defectClass: "missing coverage",
};

const W1_COVERAGE_PIN = "w1-coverage-pin";

class W1JourneyReviewer implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private interrupted = false;
  constructor(private readonly projection: () => SchedulerProjection) {}

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const tools = new Set(request.tools.map((tool) => tool.name));
    const seen = request.messages.filter((message) => message.role === "tool").length;
    // Independent coverage, served for the worker runtime as in the accepted journey.
    if (tools.has("record_coverage_obligations")) {
      return w1Call("record_coverage_obligations", {
        obligations: [{ id: "obl-REQ-1", description: "Export the value 2.", requirementId: "REQ-1" }],
        sectionCoverage: [
          { sectionId: "s1", obligationIds: ["obl-REQ-1"] },
          { sectionId: "s2", obligationIds: ["obl-REQ-1"] },
        ],
      }, `obl-${seen}`);
    }
    if (tools.has("submit_coverage_verdict")) {
      return w1Call("submit_coverage_verdict", {
        obligationVerdicts: [{ obligationId: "obl-REQ-1", verdict: "covered", severity: "advisory", rationale: "T1 covers it.", evidenceRefs: ["ledger:REQ-1"] }],
        findings: [],
      }, `verdict-${seen}`);
    }
    const system = request.messages.find((message) => message.role === "system");
    const pass = system?.id ?? "";
    if (pass === "delivery-obligations-system") {
      return w1Call("record_deliverable_obligations", { obligations: [{ id: "o1", description: "value must be 2." }] }, `obl-${seen}`);
    }
    if (pass === "delivery-findings-system") {
      // Success binding: a successful record_deliverable_findings ends
      // this pass. State never advances on emission — a rejected record
      // is retried, never treated as recorded.
      const recorded = w1ToolResults(request).some(
        (result) => result.toolName === "record_deliverable_findings" && result.isError !== true,
      );
      if (recorded) throw new Error("Findings are already durably recorded; the pass is over.");
      const testContent = w1ReadText(request, "test/value.test.mjs");
      if (testContent === undefined) return w1Call("fs.read", { path: "test/value.test.mjs" }, `findings-read-${seen}`);
      // The gap is read from the actual checkout: without a pinning test
      // the coverage finding is real; with it the repair is clean.
      const pinned = testContent.includes(W1_COVERAGE_PIN);
      return w1Call("record_deliverable_findings", {
        findings: pinned ? [] : [{ ...W1_COVERAGE_FINDING }],
      }, `findings-${seen}`);
    }
    if (pass === "delivery-verdict-system") {
      if (w1ReadText(request, "src/value.mjs") === undefined) {
        return w1Call("fs.read", { path: "src/value.mjs", startLine: 1, endLine: 1 }, "verdict-read");
      }
      if (!this.interrupted) {
        this.interrupted = true;
        return { blocks: [{ type: "text", text: "Stopped before recording the verdict." }], stopReason: "end_turn", usage: { inputTokens: 8, outputTokens: 4 } };
      }
      if (w1ReadText(request, "test/value.test.mjs") === undefined) {
        return w1Call("fs.read", { path: "test/value.test.mjs" }, "verdict-test-read");
      }
      const text = request.messages.filter((message) => typeof message.content === "string").map((message) => message.content as string).join("\n");
      const claimIds = [...new Set([...text.matchAll(/"id"\s*:\s*"(claim:[^"]+)"/g)].map((match) => match[1]!))];
      const ownSection = text.split("Your durably recorded findings:")[1]?.split("The worker's report")[0] ?? "";
      const ownBlocking = /"severity"\s*:\s*"blocking"/.test(ownSection);
      const priorSection = text.split("Prior review")[1] ?? "";
      const hasPrior = priorSection.length > 0;
      const priorIds = [...new Set([...priorSection.matchAll(/"id"\s*:\s*"((?!claim:)[^"]+)"/g)].map((match) => match[1]!))];
      // Resolution is read from the actual verdict-session checkout, not
      // from a global flag: the coverage gap resolves only when the
      // pinning test is present, and a carried oscillation resolves only
      // when this review's own findings carry no oscillation flag.
      const pinned = (w1ReadText(request, "test/value.test.mjs") ?? "").includes(W1_COVERAGE_PIN);
      const oscillated = /repair-oscillation:/.test(ownSection);
      const checks = priorIds.map((findingId) => {
        if (findingId.startsWith("repair-oscillation:")) {
          return oscillated
            ? { findingId, resolution: "outstanding", rationale: "The current repair still resubmits a failed diff." }
            : { findingId, resolution: "resolved", rationale: "This review's own findings carry no oscillation flag: the current repair differs from the failed lineage." };
        }
        return pinned
          ? { findingId, resolution: "resolved", rationale: "The pinning test now covers the value-2 behavior; inspected in this session." }
          : { findingId, resolution: "outstanding", rationale: "Unchanged repair; the coverage gap is still open." };
      });
      const satisfied = !ownBlocking && checks.every((check) => check.resolution === "resolved");
      return w1Call("submit_deliverable_verdict", {
        summary: "Reviewed against the criteria.",
        satisfied,
        claimVerdicts: claimIds.map((claimId) => ({ claimId, status: "verified", rationale: "Checked in the checkout.", citations: [{ path: "src/value.mjs", line: 1 }] })),
        ...(hasPrior ? { priorFindingChecks: checks } : {}),
      }, `verdict-${seen}`);
    }
    throw new Error(`Unexpected reviewer system ${pass}.`);
  }
}

const W1_PINNED_TEST = `${W1_VALUE_TEST}// w1-coverage-pin: value-2 boundary pinned\ntest('value boundary pin', () => { assert.equal(value, 2); assert.equal(typeof value, "number"); });\n`;

class W1JourneyWorker implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private readonly attemptOffset = new Map<number, number>();
  constructor(private readonly projection: () => SchedulerProjection) {}

  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const attempt = this.projection().tasks.T1?.attempt ?? 1;
    const total = request.messages.filter((message) => message.role === "tool").length;
    if (!this.attemptOffset.has(attempt)) this.attemptOffset.set(attempt, total);
    const tools = total - this.attemptOffset.get(attempt)!;
    // Every attempt recreates its intended bytes in its ACTUAL fresh
    // workspace (a new checkout per attempt): attempt 1 ships the
    // unpinned module; attempt 2 ships the module
    // plus a genuine pinning test that resolves the coverage gap. Each
    // attempt runs real evidence and submits its actual change.
    if (attempt === 1) {
      if (tools === 0) return w1Call("fs.read", { path: "src/value.mjs" }, `read-module-${attempt}`);
      if (tools === 1) return w1Call("fs.write", { path: "src/value.mjs", content: "export const value = 2;\n", expectedSha256: (w1LastToolValue(request) as { sha256: string }).sha256 }, `write-module-${attempt}`);
      if (tools === 2) return w1Call("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test", "test/value.test.mjs"] }, `evidence-${attempt}`);
    } else {
      if (tools === 0) return w1Call("fs.read", { path: "src/value.mjs" }, "read-module-3");
      if (tools === 1) return w1Call("fs.write", { path: "src/value.mjs", content: "export const value = 2;\n", expectedSha256: (w1LastToolValue(request) as { sha256: string }).sha256 }, "write-module-3");
      if (tools === 2) return w1Call("fs.read", { path: "test/value.test.mjs" }, "read-test-3");
      if (tools === 3) return w1Call("fs.write", { path: "test/value.test.mjs", content: W1_PINNED_TEST, expectedSha256: (w1LastToolValue(request) as { sha256: string }).sha256 }, "write-test-3");
      if (tools === 4) return w1Call("run_evidence_command", { label: "tests", command: process.execPath, args: ["--test", "test/value.test.mjs"] }, "evidence-3");
    }
    const record = w1LastToolValue(request) as unknown as { id: string; fact: { stdoutArtifactHash: string } };
    const scope = attempt === 1 ? {
      changed: ["src/value.mjs"],
      verified: ["value exports 2"],
      testsRun: [{ command: "node --test test/value.test.mjs", counts: { selected: 1, passed: 1, failed: 0, skipped: 0 } }],
      notRun: [{ what: "full suite", why: "narrow change with no shared contract touched" }],
    } : {
      changed: ["src/value.mjs", "test/value.test.mjs"],
      verified: ["value exports 2", "value boundary pinned"],
      testsRun: [{ command: "node --test test/value.test.mjs", counts: { selected: 2, passed: 2, failed: 0, skipped: 0 } }],
      notRun: [{ what: "full suite", why: "narrow change with no shared contract touched" }],
    };
    return w1Call("submit_task", {
      summary: "Product value and real tests pass.",
      readiness: "ready_for_architect_review",
      unresolvedConcerns: [],
      criterionEvidenceLinks: [{ criterionId: "c1", evidenceId: record.id, artifactHashes: [record.fact.stdoutArtifactHash] }],
      validationScope: scope,
    }, `submit-${attempt}`);
  }
}

class W1JourneyArchitect implements AgentModel {
  readonly requests: AgentModelRequest[] = [];
  private calls = 0;
  constructor(
    private readonly projection: () => SchedulerProjection,
    private readonly scenario: ReturnType<typeof w1JourneyScenario>,
  ) {}
  private next(name: string, args: unknown): ModelTurn {
    this.calls += 1;
    return w1Call(name, args, `w1-arch-${this.calls}`);
  }
  async complete(request: AgentModelRequest): Promise<ModelTurn> {
    this.requests.push(request);
    const projection = this.projection();
    const planning = projection.planning;
    if (projection.planningTriageDecision === undefined) {
      return this.next("record_triage", { decision: "build", rationale: "W1 product: change request with an approved source." });
    }
    const manifestId = planning?.source.currentManifestId;
    assert.ok(manifestId, "the approved source is registered before planning reads");
    const reads = planning?.sourceReadIndex[manifestId] ?? {};
    const sections = this.scenario.manifest.sections;
    if (sections.some((section) => reads[section.id] !== section.digest)) {
      const pending = sections.find((section) => reads[section.id] !== section.digest)!;
      return this.next("read_planning_source_section", this.requests.length <= 2 ? {} : { sectionId: pending.id });
    }
    if (!planning?.ledger) {
      return this.next("persist_planning_ledger", {
        id: "ledger-1",
        requirements: this.scenario.requirements,
        phases: this.scenario.phases,
        nonNormativeSections: [],
      });
    }
    if (!planning?.plan) {
      const { digest: _digest, runId: _run, createdAt: _created, ...rest } =
        this.scenario.revision as unknown as Record<string, unknown>;
      void _digest;
      void _run;
      void _created;
      return this.next("draft_planning_plan", { revision: rest });
    }
    if (Object.keys(planning?.coverageRequests ?? {}).length === 0) {
      return this.next("request_coverage_review", { reviewId: "coverage_w1" });
    }
    const task = projection.tasks.T1!;
    if (task.status === "submitted" || task.status === "architect_review") {
      const links = task.criterionEvidenceLinks ?? [];
      const attempt = task.attempt;
      return this.next("review_task", {
        taskId: "T1",
        decision: attempt === 1 ? "rejected" : "approved",
        summary: attempt === 1 ? "The edge case is still unverified." : "The repair is complete.",
        evidenceArtifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))],
        criterionVerdicts: [{ criterionId: "c1", verdict: attempt === 1 ? "unsatisfied" : "satisfied", rationale: "Judged.", evidenceIds: links.map((link) => link.evidenceId), artifactHashes: [...new Set(links.flatMap((link) => link.artifactHashes))], ...(attempt === 1 ? { overrideReason: "The delivery review left its blocking coverage finding open; the verified value claim alone does not satisfy the criterion." } : {}) }],
      });
    }
    if (task.status === "approved") return this.next("request_integration", { taskId: "T1" });
    throw new Error(`W1 journey script exhausted at T1 ${task.status}.`);
  }
}

function w1Provider(runtimeId: string, priority: number): RunnerProviderConfig {
  const [providerId, modelId] = runtimeId.split(":");
  return { runtimeId, providerId: providerId!, modelId: modelId!, transport: "openai-compatible", baseUrl: "http://127.0.0.1:9", secret: "unused", capabilities: ["code"], priority };
}

test("W1 product: interrupted review reopens at its missing stage, substantive repair accepts", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "aiboard-w1-product-"));
  const project = join(root, "project");
  const state = join(root, "state");
  mkdirSync(join(project, "test"), { recursive: true });
  mkdirSync(join(project, "src"), { recursive: true });
  mkdirSync(state, { recursive: true });
  writeFileSync(join(project, "package.json"), JSON.stringify({ name: "w1-journey", version: "1.0.0", type: "module", scripts: { test: "node --test" } }, null, 2));
  writeFileSync(join(project, "test", "value.test.mjs"), W1_VALUE_TEST);
  writeFileSync(join(project, "src", "value.mjs"), "export const value = 1;\n");
  await runGit({ cwd: project, args: ["init"] });
  await runGit({ cwd: project, args: ["config", "core.autocrlf", "false"] });
  const baseline = await captureGitBaseline({ projectPath: project, stateDirectory: state, runId: W1_RUN });
  let executionHost = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: w1JourneyEnvironment() });
  const supervisor = new RunSupervisor(new SqliteEventStore(join(state, "events.sqlite")), { clock: () => W1_CLOCK });
  let server: ControlServer | undefined;
  let factory: NativeBuildFactory | undefined;
  let manager: NativeBuildManager | undefined;
  let runtime: { step: () => Promise<{ status: string; action?: string }>; projection: () => SchedulerProjection } | undefined;
  try {
    const workerA = new W1JourneyWorker(() => runtime!.projection());
    const reviewer = new W1JourneyReviewer(() => runtime!.projection());
    const architect = new W1JourneyArchitect(() => runtime!.projection(), w1JourneyScenario(W1_RUN));
    const installNative = () => {
      factory = new NativeBuildFactory({
      projectRoot: project, stateDirectory: state,
      providerConfigs: { load: () => [w1Provider("arch:architect", 1), w1Provider("workA:workerA", 2), w1Provider("rev:reviewer", 3)], save: () => undefined, close: () => undefined },
      executionHost, baselineFor: () => baseline.revision,
      providerModelFactory: (config) => config.runtimeId === "arch:architect" ? architect : config.runtimeId === "workA:workerA"
        ? { complete: (request) => request.tools.some((tool) => tool.name === "record_coverage_obligations" || tool.name === "submit_coverage_verdict") ? reviewer.complete(request) : workerA.complete(request) }
        : reviewer,
    });
    manager = new NativeBuildManager({ specs: new SqliteBuildSpecStore(join(root, "builds.sqlite")), createRuntime: (spec) => factory!.create(spec).then((handle) => { runtime = handle.runtime as typeof runtime; return handle; }), prepareSpec: (spec, options) => factory!.prepareSpec(spec, options) });
    server = new ControlServer({ supervisor, token: "v2-token", builds: manager, buildProvisioner: manager, checkGit: async () => ({ available: true, version: "fixture-git", code: "git_ready", reason: null }), bootstrapRun: async () => ({ baselineRevision: baseline.revision, baselineRef: baseline.ref }) });
    };
    installNative();
    let address = await server!.start(0);
    const body = { runId: W1_RUN, projectPath: project, permissionProfile: "full", idempotencyKey: "w1-journey", build: { projectId: "w1-fixture", objective: "Deliver the value module.", architectRuntimeId: "arch:architect", workerRuntimeIds: ["workA:workerA"], verifierRuntimeIds: ["rev:reviewer"], alwaysRequireIndependentVerifier: false, maxConcurrency: 1, runPolicy: "finish", budgetLimits: {}, planningPolicy: { version: 1 }, specCopy: false, handoffFiles: "export_only" } };
    const created = await fetch(`${address.url}/v2/runs`, { method: "POST", headers: { Authorization: "Bearer v2-token", "Content-Type": "application/json" }, body: JSON.stringify(body) });
    assert.equal(created.status, 201, await created.text());
    const control = (path: string, input: unknown) => fetch(`${address.url}/v2/runs/${W1_RUN}/build/${path}`, { method: "POST", headers: { Authorization: "Bearer v2-token", "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const approve = await control("source", { approvedSource: { version: 1, approval: "approved_spec", bytesBase64: Buffer.from(W1_SOURCE).toString("base64"), mediaType: "text/plain", encoding: "utf-8", sections: [{ id: "s1", startByte: 0, endByte: Buffer.byteLength(`${W1_SOURCE.split("\n")[0]!}\n`, "utf8") }, { id: "s2", startByte: Buffer.byteLength(`${W1_SOURCE.split("\n")[0]!}\n`, "utf8"), endByte: Buffer.byteLength(W1_SOURCE, "utf8") }] }, idempotencyKey: "approve-source" });
    assert.equal(approve.status, 200, await approve.text());
    const stepUntil = async (done: (p: SchedulerProjection) => boolean) => {
      for (let step = 0; step < 300; step++) {
        const p = runtime!.projection();
        if (done(p)) return p;
        if (p.status === "paused" || p.status === "failed") {
          throw new Error(`Unexpected ${p.status} ${JSON.stringify({ pause: p.pauseReason, task: p.tasks.T1, recentEvents: manager!.events(W1_RUN).slice(-12) })}`);
        }
        await runtime!.step();
      }
      throw new Error("W1 product review not reached");
    };
    await stepUntil((p) => p.planning?.readiness === "ready");
    const start = await control("plan-start", { ...currentExplicitStartIdentity(runtime!.projection()), version: 1, ownerChoice: "execute", idempotencyKey: "explicit-start" });
    assert.equal(start.status, 200, await start.text());
    const interrupted = await stepUntil((p) => p.status === "paused");
    assert.match(interrupted.pauseReason?.reason ?? "", /delivery_review_suspended:model_ended_without_lifecycle/, JSON.stringify({ pause: interrupted.pauseReason, review: interrupted.delivery?.reviews.T1, recentEvents: manager!.events(W1_RUN).slice(-8), requests: reviewer.requests.slice(-2) }));
    const partial = structuredClone(interrupted.delivery!.reviews.T1!);
    assert.equal(partial.stage, "report_delivered");
    assert.ok(partial.reviewKey, "the interruption retains an exact known key");
    const partialSession = deliverySessionId(W1_RUN, partial.reviewId, "verdict", partial.reviewerRuntimeId!, partial.independence!);
    const beforeReopen = await manager!.observability(W1_RUN);
    assert.ok(beforeReopen.agents.some((agent) => agent.sessionId === partialSession), "the interrupted verdict session is real and durable");
    const priorStageEvents = manager!.events(W1_RUN).filter((event) => event.type === "delivery.findings_recorded" || event.type === "delivery.obligations_recorded");
    t.diagnostic(`W1 native interruption: ${partial.reviewId}, key ${partial.reviewKey}, real partial session ${partialSession}`);
    await server!.close();
    await manager!.close();
    await factory!.close();
    await executionHost.close();
    executionHost = createExecutionHost({ projectRoot: project, stateDirectory: state, artifacts: new ArtifactStore(join(state, "artifacts")), ambientEnvironment: w1JourneyEnvironment() });
    installNative();
    const recovery = await manager!.recover();
    assert.deepEqual(recovery.failures, [], "real SQLite/native recovery succeeds");
    assert.deepEqual(runtime!.projection().delivery!.reviews.T1, partial, "the partial review survives storage close/reopen exactly");
    address = await server!.start(0);
    // Resume through the genuine manager API, then drive actual steps
    // deterministically. HTTP commands would start an autonomous pump
    // racing these intermediate assertions. Creation/source/start above
    // are authenticated; no task, review or scheduler state is seeded.
    await manager!.resume(W1_RUN, "w1-reopen-resume");
    t.diagnostic(`W1 native SQLite/factory reopen retained review ${partial.reviewId}`);
    // Attempt 1: a failed review with a real blocking coverage finding.
    const gen1done = await stepUntil((p) => p.delivery?.reviews.T1?.stage === "completed");
    const gen1 = gen1done.delivery!.reviews.T1!;
    assert.equal(gen1.reviewId, partial.reviewId, "the same review continues");
    assert.equal(gen1.generation, partial.generation, "no new generation on an exact known-key resume");
    assert.equal(gen1.reviewKey, partial.reviewKey, "the exact key is retained");
    assert.deepEqual(gen1.depth, partial.depth, "completed findings depth is retained");
    assert.deepEqual(gen1.sessionIds.slice(0, partial.sessionIds.length), partial.sessionIds, "completed stage session identities are retained");
    assert.equal(gen1.readCapture!.sessionId, deliverySessionId(W1_RUN, gen1.reviewId, "verdict", gen1.reviewerRuntimeId!, gen1.independence!, 1), "the missing verdict runs in a fresh retry session");
    assert.notEqual(gen1.readCapture!.sessionId, partialSession, "partial reads confer no verdict citation authority");
    assert.deepEqual(manager!.events(W1_RUN).filter((event) => event.type === "delivery.findings_recorded" || event.type === "delivery.obligations_recorded"), priorStageEvents, "completed review stages never rerun");
    t.diagnostic(`W1 native missing verdict resumed in ${gen1.readCapture!.sessionId}`);
    assert.equal(gen1.satisfied, false, "attempt 1 fails on its blocking finding");
    assert.deepEqual(
      (gen1.findings ?? []).map((finding) => ({ id: finding.id, category: finding.category, severity: finding.severity })),
      [{ id: "finding:coverage-gap", category: "missing_coverage", severity: "blocking" }],
      "attempt 1 carries exactly the real coverage gap",
    );
    assert.ok(gen1.reviewKey, "the completed review carries a recomputed ReviewKey");
    assert.match(gen1.reviewKeyInputs?.baseTree ?? "", /^[a-f0-9]{40}$|^[a-f0-9]{64}$/, "the base tree is actual, never a label");
    assert.match(gen1.reviewKeyInputs?.headTree ?? "", /^[a-f0-9]{40}$|^[a-f0-9]{64}$/, "the head tree is actual, never a label");
    // Supporting cache boundary on the genuine already-wired native
    // driver. No replacement driver, test-only factory API or seeded
    // review. The CD7 entrypoint above remains authenticated creation
    // and Runtime.step through interruption/reopen. Normal step skips
    // a completed review, so invoke its actual port to prove key reuse.
    const original = structuredClone(gen1);
    const beforeCache = await manager!.observability(W1_RUN);
    const callsBeforeCache = [architect.requests.length, workerA.requests.length, reviewer.requests.length];
    const treesBeforeCache = (await runGit({ cwd: project, args: ["worktree", "list", "--porcelain"] })).stdout;
    const wiredReview = (runtime as unknown as { deliveryReview: DeliveryReviewDriver }).deliveryReview;
    const cached = await wiredReview.review({ runId: W1_RUN, taskId: "T1" });
    assert.equal(cached.status, "reviewed");
    assert.deepEqual(runtime!.projection().delivery!.reviews.T1, original, "exact native replay preserves the entire original verdict/session/read/depth proof");
    const afterCache = await manager!.observability(W1_RUN);
    assert.deepEqual(afterCache.agents, beforeCache.agents, "no new native review session");
    assert.deepEqual(afterCache.evidence, beforeCache.evidence, "no new depth or command evidence");
    assert.equal(afterCache.toolCallCount, beforeCache.toolCallCount, "no tool or depth call on cache hit");
    assert.deepEqual([architect.requests.length, workerA.requests.length, reviewer.requests.length], callsBeforeCache, "no model call on native cache hit");
    assert.equal((await runGit({ cwd: project, args: ["worktree", "list", "--porcelain"] })).stdout, treesBeforeCache, "no native workspace creation on cache hit");
    assert.equal(manager!.events(W1_RUN).filter((event) => event.type === "delivery.review_started").length, 1, "cache hit opens no new review");
    assert.equal(manager!.events(W1_RUN).filter((event) => event.type === "repair.cycle_recorded").length, 0, "cache replay precedes rejection and charges no cycle");
    t.diagnostic(`W1 native exact-key replay retained complete original proof without model/tool/evidence/worktree work`);
    await stepUntil((p) => p.tasks.T1?.status === "rejected");
    const cyclesAfterGen1 = await stepUntil(() => manager!.events(W1_RUN).filter((event) => event.type === "repair.cycle_recorded").length > 0)
      .then(() => manager!.events(W1_RUN).filter((event) => event.type === "repair.cycle_recorded").length);
    // One cycle per member issue lineage: the Architect's unsatisfied
    // criterion verdict and the open blocking delivery finding.
    assert.equal(cyclesAfterGen1, 2, "the failed review charges one cycle per issue lineage");
    // Attempt 2 is a substantive repair within the default two-attempt
    // budget: the genuine pinning test resolves the reviewed coverage gap.
    const repairedDone = await stepUntil((p) => {
      const review = p.delivery?.reviews.T1;
      return review?.stage === "completed" && (review.submissionAttempt ?? 0) >= 2;
    });
    const repaired = repairedDone.delivery!.reviews.T1!;
    assert.equal(repaired.reusedFrom, undefined, "the substantive repair never reuses");
    assert.deepEqual(repaired.findings ?? [], [], "the substantive repair has no own findings");
    assert.ok(!(repaired.findings ?? []).some((finding) => finding.id.startsWith("repair-oscillation:")), "no oscillation on a distinct repair");
    const checks = repaired.priorFindingChecks ?? [];
    assert.ok(checks.some((check) => check.findingId === "finding:coverage-gap" && check.resolution === "resolved"), "the coverage gap resolves with inspected rationale");
    assert.equal(repaired.satisfied, true, "the substantive repair satisfies");
    t.diagnostic(`W1 native substantive repair reviewed: ${repaired.reviewId}`);
    assert.ok((repaired.claimVerdicts ?? []).length > 0 && (repaired.claimVerdicts ?? []).every((verdict) => verdict.status === "verified"), "every claim verifies");
    assert.equal(JSON.stringify((repaired.claimVerdicts ?? []).map((verdict) => verdict.citations)), JSON.stringify((repaired.claimVerdicts ?? []).map(() => [{ path: "src/value.mjs", line: 1 }])));
    assert.ok((repaired.readCapture?.reads ?? []).some((read) => read.path === "src/value.mjs" && read.startLine === 1 && read.endLine === 1), "citations rest on actual verdict-session reads");
    assert.ok((repaired.sessionIds ?? []).includes(repaired.readCapture!.sessionId), "the capture binds a session of this review, never a borrowed one");
    assert.equal(manager!.events(W1_RUN).filter((event) => event.type === "delivery.review_reused").length, 1, "only the same-submission cache boundary reuses; the repaired attempt has a distinct key");
    assert.equal(manager!.events(W1_RUN).filter((event) => event.type === "delivery.review_started").length, 2, "one review per attempt");
    // The approved repair integrates and the task accepts.
    const accepted = await stepUntil((p) => p.delivery?.taskAcceptances?.T1 !== undefined);
    assert.equal(accepted.tasks.T1!.attempt, 2, "normal two-attempt budget suffices");
    assert.ok(accepted.tasks.T1!.integrationRevision, "the actual repaired commit integrates");
    const files = await manager!.files(W1_RUN);
    assert.ok(files.files.some((file) => file.path === "src/value.mjs"), "the integrated file is available through the product file view");
    assert.ok(accepted.delivery!.taskAcceptances.T1, "the substantive repair is accepted");
    t.diagnostic(`W1 native task acceptance: ${JSON.stringify(accepted.delivery!.taskAcceptances.T1)}`);
    assert.equal(
      manager!.events(W1_RUN).filter((event) => event.type === "repair.cycle_recorded").length,
      cyclesAfterGen1,
      "acceptance charges no further cycle",
    );
    const head = (await runGit({ cwd: project, args: ["rev-parse", "HEAD"] })).stdout.trim();
    assert.equal(head, baseline.revision, "the approved-source baseline is intact");
  } finally {
    await server?.close();
    supervisor.close();
    await manager?.close();
    await factory?.close();
    await executionHost.close();
    rmSync(root, { recursive: true, force: true });
  }
});
