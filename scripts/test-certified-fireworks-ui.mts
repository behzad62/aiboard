/* Certified Fireworks UI gate checks (run: npx tsx scripts/test-certified-fireworks-ui.mts) */
import { getCertifiedRunGate } from "../lib/benchmark/certified/ui-gates";
import type { HarnessCertificationResult } from "../lib/benchmark/types";

let failures = 0;

function check(name: string, ok: boolean, detail?: unknown): void {
  if (!ok) failures++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${name}${ok ? "" : ` -> ${JSON.stringify(detail)}`}`
  );
}

const passingCertification: HarnessCertificationResult = {
  id: "cert-fireworks-ui",
  createdAt: "2026-06-28T10:00:00.000Z",
  aiboardVersion: "test",
  benchmarkEngineVersion: "test",
  harnessProfile: "raw-single-model",
  harnessVersion: "test",
  promptSetVersion: "test",
  passed: true,
  checks: [],
};

const twoPlayerGate = getCertifiedRunGate({
  suiteId: "fireworks-teamiq-mixed-v0.1",
  running: false,
  selectedTrack: "teamiq",
  modelId: "",
  teamModelIds: ["openai:gpt-fireworks-a", "anthropic:claude-fireworks-b"],
  workBenchRunnerReady: true,
  certification: passingCertification,
  fireworksPlayerCount: 2,
});
check("2-player Fireworks allows exactly two selected models", twoPlayerGate.canRun, twoPlayerGate);

const twoPlayerBlockedGate = getCertifiedRunGate({
  suiteId: "fireworks-teamiq-mixed-v0.1",
  running: false,
  selectedTrack: "teamiq",
  modelId: "",
  teamModelIds: [
    "openai:gpt-fireworks-a",
    "anthropic:claude-fireworks-b",
    "google:gemini-fireworks-c",
  ],
  workBenchRunnerReady: true,
  certification: passingCertification,
  fireworksPlayerCount: 2,
});
check(
  "2-player Fireworks blocks extra selected models",
  !twoPlayerBlockedGate.canRun &&
    twoPlayerBlockedGate.reason === "Select exactly two models for 2-player Fireworks.",
  twoPlayerBlockedGate
);

const threePlayerBlockedGate = getCertifiedRunGate({
  suiteId: "fireworks-teamiq-mixed-v0.1",
  running: false,
  selectedTrack: "teamiq",
  modelId: "",
  teamModelIds: ["openai:gpt-fireworks-a", "anthropic:claude-fireworks-b"],
  workBenchRunnerReady: true,
  certification: passingCertification,
  fireworksPlayerCount: 3,
});
check(
  "3-player Fireworks blocks two selected models",
  !threePlayerBlockedGate.canRun &&
    threePlayerBlockedGate.reason === "Select three models for 3-player Fireworks.",
  threePlayerBlockedGate
);

const threePlayerGate = getCertifiedRunGate({
  suiteId: "fireworks-teamiq-mixed-v0.1",
  running: false,
  selectedTrack: "teamiq",
  modelId: "",
  teamModelIds: [
    "openai:gpt-fireworks-a",
    "anthropic:claude-fireworks-b",
    "google:gemini-fireworks-c",
  ],
  workBenchRunnerReady: true,
  certification: passingCertification,
  fireworksPlayerCount: 3,
});
check("3-player Fireworks allows three selected models", threePlayerGate.canRun, threePlayerGate);

const toolReliabilityGate = getCertifiedRunGate({
  suiteId: "teamiq-toolreliability-v0.1-quick",
  running: false,
  selectedTrack: "teamiq",
  modelId: "",
  teamModelIds: ["openai:gpt-fireworks-a", "anthropic:claude-fireworks-b"],
  workBenchRunnerReady: true,
  certification: passingCertification,
  fireworksPlayerCount: 3,
});
check(
  "non-Fireworks TeamIQ still uses the generic two-model gate",
  toolReliabilityGate.canRun,
  toolReliabilityGate
);

if (failures === 0) {
  console.log("PASS");
} else {
  console.log(`FAIL ${failures} check(s) failed`);
}

process.exit(failures === 0 ? 0 : 1);
