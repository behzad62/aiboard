import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import test from "node:test";
import { join } from "node:path";
import {
  qualificationArtifactRoot,
  runIsolatedScenario,
  writeQualificationDiagnostics,
} from "../support/qualification-harness.js";

const evidenceRoot = process.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT
  ?? qualificationArtifactRoot();
mkdirSync(join(evidenceRoot, "native-lifecycle"), { recursive: true });
process.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT = evidenceRoot;

const windowsScenarios = [
  "windows-native-descendant",
  "windows-job-descendant",
  "windows-job-duplex",
] as const;

const posixScenarios = [
  "posix-launcher-exit",
] as const;

const managedScenarios = [
  "managed-shared",
  "managed-natural-exit",
  "mcp-lazy",
] as const;

const windowsModule = new URL("./scenarios/windows-lifecycle.ts", import.meta.url);
const posixModule = new URL("./scenarios/posix-lifecycle.ts", import.meta.url);
const managedModule = new URL("./scenarios/managed-mcp.ts", import.meta.url);
let hostPoisoned = false;

async function runNamed(moduleUrl: URL, name: string, timeoutMs: number): Promise<"passed" | "skipped"> {
  try {
    return await runIsolatedScenario({
      scenarioFileUrl: moduleUrl,
      evidenceRoot,
      scenarioName: name,
      timeoutMs,
      env: { RUNNER_V2_QUALIFICATION_SCENARIO: name },
    });
  } catch (error) {
    hostPoisoned = true;
    writeQualificationDiagnostics({ evidenceRoot, scenario: name, error });
    throw error;
  }
}

for (const name of windowsScenarios) {
  test(`qualification: ${name}`, { timeout: 180_000 }, async (t) => {
    if (hostPoisoned) { t.skip("Prior qualification failure poisoned this host sequence; no later scenario may start."); return; }
    if (process.platform !== "win32") {
      t.skip("Windows Job/native lifecycle requires a Windows host.");
      return;
    }
    await runNamed(windowsModule, name, 120_000);
  });
}

for (const name of posixScenarios) {
  test(`qualification: ${name}`, { timeout: 120_000 }, async (t) => {
    if (hostPoisoned) { t.skip("Prior qualification failure poisoned this host sequence; no later scenario may start."); return; }
    if (process.platform === "win32") {
      t.skip("POSIX process-group lifecycle requires a POSIX host.");
      return;
    }
    await runNamed(posixModule, name, 90_000);
  });
}

for (const name of managedScenarios) {
  test(`qualification: ${name}`, { timeout: 180_000 }, async (t) => {
    if (hostPoisoned) { t.skip("Prior qualification failure poisoned this host sequence; no later scenario may start."); return; }
    await runNamed(managedModule, name, 150_000);
  });
}

test("qualification evidence root is artifact-visible", () => {
  assert.ok(evidenceRoot.length > 0);
  writeQualificationDiagnostics({
    evidenceRoot,
    scenario: "native-lifecycle-entry",
    extra: { platform: process.platform, scenarios: [...windowsScenarios, ...posixScenarios, ...managedScenarios] },
  });
});
