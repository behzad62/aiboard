import type { HarnessCertificationResult } from "@/lib/benchmark/types";

export type CertifiedRunnableTrack =
  | "gameiq"
  | "toolreliability"
  | "teamiq"
  | "workbench";

export interface CertifiedRunGateInput {
  suiteId: string;
  running: boolean;
  selectedTrack: CertifiedRunnableTrack;
  modelId: string;
  teamModelIds: string[];
  fireworksPlayerCount?: 2 | 3;
  workBenchRunnerReady: boolean;
  certification: HarnessCertificationResult;
}

export interface CertifiedRunGate {
  canRun: boolean;
  reason: string | null;
  certification: HarnessCertificationResult;
}

export function getCertifiedRunGate(
  input: CertifiedRunGateInput
): CertifiedRunGate {
  const blocked = (reason: string): CertifiedRunGate => ({
    canRun: false,
    reason,
    certification: input.certification,
  });

  if (input.running) return blocked("A certified run is already in progress.");
  if (!input.suiteId) return blocked("Select a benchmark suite or case.");
  if (input.selectedTrack === "teamiq") {
    if (isFireworksSuite(input.suiteId)) {
      const playerCount = input.fireworksPlayerCount ?? 2;
      if (input.teamModelIds.length !== playerCount) {
        return blocked(
          playerCount === 3
            ? "Select three models for 3-player Fireworks."
            : "Select exactly two models for 2-player Fireworks."
        );
      }
    } else if (input.teamModelIds.length < 2) {
      return blocked("Select at least two models for TeamIQ.");
    }
  } else if (!input.modelId) {
    return blocked("Select a model.");
  }
  if (input.selectedTrack === "workbench" && !input.workBenchRunnerReady) {
    return blocked("Connect the WorkBench bench runner before running.");
  }
  if (!input.certification.passed) {
    const failed = input.certification.checks.find((check) => !check.passed);
    const detail = failed
      ? `${failed.label}${failed.message ? `: ${failed.message}` : ""}`
      : "Harness certification failed.";
    return blocked(`Certified run blocked. ${detail}`);
  }

  return {
    canRun: true,
    reason: null,
    certification: input.certification,
  };
}

function isFireworksSuite(suiteId: string): boolean {
  return suiteId.startsWith("fireworks-teamiq-");
}
