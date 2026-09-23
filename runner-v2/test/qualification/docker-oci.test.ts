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
mkdirSync(join(evidenceRoot, "docker-oci"), { recursive: true });
process.env.RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT = evidenceRoot;

const scenarios = [
  "docker-required-gate",
  "oci-alpine-containment",
  "managed-strict-oci",
  "docker-mcp-contained",
] as const;

const moduleUrl = new URL("./scenarios/docker-oci.ts", import.meta.url);
let hostPoisoned = false;

for (const name of scenarios) {
  test(`qualification: ${name}`, { timeout: 240_000 }, async (t) => {
    if (hostPoisoned) { t.skip("Prior qualification failure poisoned this host sequence; no later scenario may start."); return; }
    try {
      const outcome = await runIsolatedScenario({
        scenarioFileUrl: moduleUrl,
        evidenceRoot,
        scenarioName: name,
        timeoutMs: 180_000,
        env: {
          RUNNER_V2_QUALIFICATION_SCENARIO: name,
          RUNNER_V2_REQUIRE_DOCKER: process.env.RUNNER_V2_REQUIRE_DOCKER,
        },
        allowSkip: process.env.RUNNER_V2_REQUIRE_DOCKER !== "1",
      });
      if (outcome === "skipped") {
        t.skip("Docker/OCI unavailable on this host; hosted Linux qualification required.");
      }
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
