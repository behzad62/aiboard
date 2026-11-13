/**
 * VF8: the handoff snapshot's Not verified section and the verification table's inventory lines.
 * In memory: hand-built projections, no store, no process.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  HANDOFF_SNAPSHOT_MAX_BYTES,
  HANDOFF_SNAPSHOT_MAX_LINES,
  handoffSnapshotInputFromProjection,
  renderHandoffSnapshot,
  verifyHandoffSnapshotDigest,
  type HandoffSnapshotInput,
} from "../src/handoff-snapshot.js";
import type { SchedulerProjection } from "../src/scheduler-store.js";

const REV = "c".repeat(40);

function v2Check(checkId: string, label: string, outcome: "passed" | "failed" | "not_run", extra: Record<string, unknown> = {}) {
  return {
    checkId, label, kind: "build", origin: "detected", mandatory: false, outcome,
    green: outcome === "passed", evidenceIds: [], issues: outcome === "failed" ? [`${checkId} exited 1`] : [],
    facts: outcome === "not_run" ? [] : [{ kind: "command", command: "C:\\nodejs\\node.exe", args: ["C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "run", checkId] }],
    attempt: 1, workspacePath: "C:/verify", startedAt: "t", finishedAt: "t",
    ...extra,
  };
}

/** A completed v2 Build handing off with one of every kind of thing it did not verify. */
function handoffProjection(): SchedulerProjection {
  return {
    runId: "run-vf8",
    status: "paused",
    integrationRevision: REV,
    runtime: { architect: {} },
    tasks: {},
    userGuidance: {},
    reviews: {
      T1: {
        taskId: "T1", status: "approved", evidenceArtifactHashes: [],
        criterionVerdicts: [
          { criterionId: "AC-1", verdict: "satisfied", rationale: "Runner evidence.", evidenceIds: ["ev-1"] },
          { criterionId: "AC-2", verdict: "satisfied", rationale: "Read the code.", evidenceIds: ["ev-2"], overrideReason: "The test runner cannot drive the tray icon." },
          { criterionId: "AC-3", verdict: "unsatisfied", rationale: "Not met.", evidenceIds: [], overrideReason: "Downgrade, not an acceptance." },
        ],
      },
      T2: {
        taskId: "T2", status: "rejected", evidenceArtifactHashes: [],
        criterionVerdicts: [
          { criterionId: "AC-1", verdict: "satisfied", rationale: "x", evidenceIds: [], overrideReason: "A rejected review accepts nothing." },
        ],
      },
    },
    delivery: {
      boundaries: {
        T1: [{
          integrationRevision: REV,
          checks: [
            { checkId: "build", outcome: "passed", command: "npm", args: ["run", "build"] },
            { checkId: "tests", outcome: "not_run", notRun: { reason: "tool_missing", tool: "pytest" } },
          ],
        }],
      },
    },
    environmentInventory: {
      version: 1, trigger: "planning", platform: "win32", arch: "x64", runnerNode: "v24.0.0",
      tools: [
        { name: "npm", status: "found", path: "C:\\nodejs\\npm.cmd", version: "10.9.2", usedBy: ["build: package build"] },
        { name: "cargo", status: "missing", usedBy: ["tests: cargo test"] },
        { name: "python", status: "found", version: "Python 3.12.1", usedBy: ["tier fast: lint"] },
      ],
      toolsOmitted: 0, browsers: [], playwrightBrowser: null, notes: [], sequence: 4, recordedAt: "t",
    },
    finalVerification: {
      current: {
        taskId: "fv", generationId: "fv-gen", targetRevision: REV, planVersion: 1, state: "current",
        plan: {
          version: 2,
          checks: [
            { id: "build", label: "package build", kind: "build", origin: "detected", mandatory: false },
            { id: "lint", label: "lint", kind: "other", origin: "architect", mandatory: false },
            { id: "cargo-tests", label: "cargo tests", kind: "tests", origin: "detected", mandatory: false },
          ],
          skipped: [{ checkId: "start", reason: "A static export has no server for next start." }],
        },
        executionProfile: { verification: { suggestions: [{ id: "start", label: "package start" }] } },
        completedChecks: [
          v2Check("build", "package build", "passed", { evidenceIds: ["ev-b"] }),
          v2Check("lint", "lint", "failed"),
          v2Check("cargo-tests", "cargo tests", "not_run", { notRun: { reason: "tool_missing", tool: "cargo", detail: "cargo is not on PATH" } }),
        ],
        knownDefects: [{ checkId: "lint", label: "lint", reason: "still failing at the repair limit: issue final-verification:lint used 3/3 repair cycles" }],
      },
      history: [],
    },
    projectHandoff: {
      status: "requested", summary: "Done, with one known defect.", options: ["keep_integration_branch", "apply_to_project"],
      verificationKnownDefects: [{ checkId: "lint", label: "lint", reason: "still failing at the repair limit" }],
      leftToVerify: ["the installer on macOS", "the tray icon on Linux"],
    },
  } as unknown as SchedulerProjection;
}

function section(output: string, heading: string): string[] {
  const lines = output.split("\n");
  const start = lines.indexOf(heading);
  assert.ok(start >= 0, `${heading} is missing:\n${output}`);
  const end = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  return lines.slice(start + 1, end < 0 ? undefined : end).filter((line) => line.length > 0);
}

test("the Not verified section lists every not-run check, skip, known defect, override and leftToVerify item once", () => {
  const output = renderHandoffSnapshot(handoffSnapshotInputFromProjection(handoffProjection()));
  assert.equal(verifyHandoffSnapshotDigest(output), true);
  assert.deepEqual(section(output, "## Not verified"), [
    "not verified: 7 total (2 not run, 1 skipped, 1 known defects, 1 Architect overrides, 2 left for the owner)",
    "- not run: boundary T1 tests — tool missing: pytest",
    "- not run: final verification cargo tests — tool missing: cargo",
    "- skipped: final verification package start — A static export has no server for next start.",
    "- known defect: final verification lint — still failing at the repair limit: issue final-verification:lint used 3/3 repair cycles",
    "- accepted on an Architect override without Runner evidence: task T1 criterion AC-2 — The test runner cannot drive the tray icon.",
    "- left for the owner to verify: the installer on macOS",
    "- left for the owner to verify: the tray icon on Linux",
  ]);
  // The section sits between the verification table and the decisions.
  assert.ok(output.indexOf("## Verification") < output.indexOf("## Not verified"));
  assert.ok(output.indexOf("## Not verified") < output.indexOf("## Decisions"));
});

test("the verification table names the known defect and each check's tools from the inventory", () => {
  const output = renderHandoffSnapshot(handoffSnapshotInputFromProjection(handoffProjection()));
  const table = section(output, "## Verification");
  assert.equal(
    table.find((line) => line.startsWith("- final verification lint:")),
    `- final verification lint: failed (known defect at the repair limit); counts: not recorded; command: C:\\nodejs\\node.exe C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js run lint; tools: npm found (10.9.2); revision: ${REV}`,
  );
  assert.ok(table.some((line) => line.startsWith("- final verification package build: passed;") && line.includes("; tools: npm found (10.9.2);")));
  assert.ok(table.some((line) => line.startsWith("- final verification cargo tests: not run (tool missing: cargo);") && line.includes("; tools: cargo missing;")));
  // A check whose tools the inventory does not name renders as before.
  assert.ok(table.some((line) => line.startsWith("- boundary T1 build: passed;") && !line.includes("tools:")));
});

test("a run with nothing unverified says so, and an input without the field renders no section", () => {
  const projection = handoffProjection() as unknown as Record<string, unknown>;
  const clean = {
    ...projection,
    reviews: {},
    delivery: {},
    projectHandoff: { status: "requested", summary: "Done.", options: ["keep_integration_branch", "apply_to_project"] },
    finalVerification: {
      current: {
        ...(projection.finalVerification as { current: Record<string, unknown> }).current,
        plan: { version: 2, checks: [{ id: "build", label: "package build", kind: "build", origin: "detected", mandatory: false }], skipped: [] },
        completedChecks: [v2Check("build", "package build", "passed", { evidenceIds: ["ev-b"] })],
        knownDefects: undefined,
      },
      history: [],
    },
  } as unknown as SchedulerProjection;
  const input = handoffSnapshotInputFromProjection(clean);
  assert.deepEqual(input.notVerified, []);
  const output = renderHandoffSnapshot(input);
  assert.deepEqual(section(output, "## Not verified"), ["not verified: none"]);
  const { notVerified: _omitted, ...legacy } = input;
  assert.equal(renderHandoffSnapshot(legacy as HandoffSnapshotInput).includes("## Not verified"), false);
});

test("a repeated item renders once, and a long list keeps its count line and an exact N-more line under the cap", () => {
  const base = handoffSnapshotInputFromProjection(handoffProjection());
  const repeated: HandoffSnapshotInput = { ...base, notVerified: [...base.notVerified!, ...base.notVerified!] };
  assert.equal(renderHandoffSnapshot(repeated), renderHandoffSnapshot(base));

  const many: HandoffSnapshotInput = {
    ...base,
    notVerified: Array.from({ length: 400 }, (_, index) => ({
      kind: "left_to_verify" as const,
      subject: `owner item ${String(index).padStart(3, "0")} ${"x".repeat(60)}`,
      detail: "",
    })),
  };
  const output = renderHandoffSnapshot(many);
  assert.equal(verifyHandoffSnapshotDigest(output), true);
  assert.ok(output.split("\n").length <= HANDOFF_SNAPSHOT_MAX_LINES);
  assert.ok(Buffer.byteLength(output, "utf8") <= HANDOFF_SNAPSHOT_MAX_BYTES);
  const lines = section(output, "## Not verified");
  assert.equal(lines[0], "not verified: 400 total (0 not run, 0 skipped, 0 known defects, 0 Architect overrides, 400 left for the owner)");
  const shown = lines.filter((line) => line.startsWith("- left for the owner to verify: ")).length;
  assert.ok(shown > 0 && shown < 400);
  assert.equal(lines.at(-1), `${400 - shown} more — see AIBoard run run-vf8`);
  // The final-verification lines never give way to the list.
  assert.ok(output.includes("- final verification lint: failed (known defect at the repair limit);"));
});
