import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  qualificationFixtureRootsFromEvidence,
  runIsolatedScenario,
  writeQualificationDiagnostics,
} from "./support/qualification-harness.js";

const probe = new URL("./support/qualification-harness-probe.ts", import.meta.url);

function evidenceRoot(): string {
  return mkdtempSync(join(tmpdir(), "runner-v2-qualification-harness-test-"));
}

function findNamedFile(root: string, name: string): string | undefined {
  if (!existsSync(root)) return undefined;
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const candidate = join(root, entry.name);
    if (entry.isFile() && entry.name === name) return candidate;
    if (entry.isDirectory()) {
      const nested = findNamedFile(candidate, name);
      if (nested) return nested;
    }
  }
  return undefined;
}
test("qualification harness captures durable fixture evidence on child failure", async () => {
  const root = evidenceRoot();
  try {
    await assert.rejects(runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-failure",
      timeoutMs: 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "fail" },
    }), /failed|synthetic harness probe failure/i);

    const fixtures = qualificationFixtureRootsFromEvidence(root, "harness-failure");
    assert.equal(fixtures.length, 1);
    assert.equal(existsSync(fixtures[0]!), true, "failed fixture must remain for exact postmortem cleanup");
    const diagnostics = join(root, "diagnostics", "harness-failure");
    const captured = findNamedFile(diagnostics, "state.json");
    assert.ok(captured, "failure diagnostics must copy state.json into the artifact tree");
    assert.match(readFileSync(captured, "utf8"), /durable-state/);
    const output = findNamedFile(diagnostics, "stdout-000000000001.json");
    assert.ok(output, "failure diagnostics must retain portable channel output records");
    assert.match(readFileSync(output, "utf8"), /retained-output/);
    const ack = findNamedFile(diagnostics, "stderr-000000000002.json");
    assert.ok(ack, "failure diagnostics must retain portable channel acknowledgement records");
    assert.match(readFileSync(ack, "utf8"), /retained-ack/);
  } finally {
    for (const fixture of qualificationFixtureRootsFromEvidence(root, "harness-failure")) {
      rmSync(fixture, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
test("qualification harness captures durable fixture evidence before timeout termination", async () => {
  const root = evidenceRoot();
  try {
    await assert.rejects(runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-timeout",
      timeoutMs: process.platform === "win32" ? 10_000 : 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "timeout" },
    }), /timed out/i);

    const fixtures = qualificationFixtureRootsFromEvidence(root, "harness-timeout");
    assert.equal(fixtures.length, 1);
    const diagnostics = join(root, "diagnostics", "harness-timeout");
    const captured = findNamedFile(diagnostics, "state.json");
    assert.ok(captured, "timeout diagnostics must copy state.json before terminating the child");
    assert.match(readFileSync(captured, "utf8"), /durable-state/);
    const preKillSummary = readFileSync(join(diagnostics, "summary.json"), "utf8");
    assert.match(preKillSummary, /before-timeout-termination/);
    writeQualificationDiagnostics({
      evidenceRoot: root,
      scenario: "harness-timeout",
      error: new Error("synthetic outer entrypoint catch"),
    });
    assert.equal(
      readFileSync(join(diagnostics, "summary.json"), "utf8"),
      preKillSummary,
      "later entrypoint diagnostics must not overwrite the pre-kill timeout summary",
    );
  } finally {
    for (const fixture of qualificationFixtureRootsFromEvidence(root, "harness-timeout")) {
      rmSync(fixture, { recursive: true, force: true });
    }
    rmSync(root, { recursive: true, force: true });
  }
});
test("qualification harness fails closed on unapproved child skip", async () => {
  const root = evidenceRoot();
  try {
    await assert.rejects(runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-skip-refused",
      timeoutMs: 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "skip" },
    }), /unapproved skip/i);
    assert.equal(existsSync(join(root, "diagnostics", "harness-skip-refused", "summary.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("qualification harness permits only an explicitly approved skip", async () => {
  const root = evidenceRoot();
  try {
    assert.equal(await runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-skip-approved",
      timeoutMs: 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "skip" },
      allowSkip: true,
    }), "skipped");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("qualification harness removes deferred fixture only after successful scenario completion", async () => {
  const root = evidenceRoot();
  try {
    assert.equal(await runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-pass",
      timeoutMs: 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "pass" },
    }), "passed");
    const fixtures = qualificationFixtureRootsFromEvidence(root, "harness-pass");
    assert.equal(fixtures.length, 1);
    assert.equal(existsSync(fixtures[0]!), false, "successful scenario must flush its deferred fixture removal");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("qualification harness never treats stdout-only SKIP text as skip authority", async () => {
  const root = evidenceRoot();
  try {
    await assert.rejects(runIsolatedScenario({
      scenarioFileUrl: probe,
      evidenceRoot: root,
      scenarioName: "harness-text-skip-only",
      timeoutMs: 5_000,
      env: { RUNNER_V2_HARNESS_PROBE_MODE: "text-skip-only" },
      allowSkip: true,
    }), /skip.*marker|unstructured skip/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
