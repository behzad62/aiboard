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
mkdirSync(join(evidenceRoot, "windows-portable"), { recursive: true });
process.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT = evidenceRoot;

const scenarios = [
  "portable-duplex",
  "portable-release-unsettled",
  "portable-fence-takeover",
  "portable-stale-fence",
] as const;

const moduleUrl = new URL("./scenarios/windows-portable.ts", import.meta.url);
let hostPoisoned = false;

for (const name of scenarios) {
  test(`qualification: ${name}`, { timeout: 180_000 }, async (t) => {
    if (hostPoisoned) { t.skip("Prior qualification failure poisoned this host sequence; no later scenario may start."); return; }
    if (process.platform !== "win32") {
      t.skip("Windows portable channel lifecycle requires a Windows host.");
      return;
    }
    try {
      await runIsolatedScenario({
        scenarioFileUrl: moduleUrl,
        evidenceRoot,
        scenarioName: name,
        timeoutMs: 120_000,
        env: { RUNNER_V2_QUALIFICATION_SCENARIO: name },
      });
    } catch (error) {
      hostPoisoned = true;
      writeQualificationDiagnostics({ evidenceRoot, scenario: name, error });
      throw error;
    }
  });
}

test("qualification evidence root is artifact-visible", () => {
  assert.ok(evidenceRoot.length > 0);
});
