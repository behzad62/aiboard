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
  workBenchModelIds?: string[];
  workBenchRoleMode?: "solo" | "architect_worker" | "architect_worker_reviewer";
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
          playerCount === 3 && input.teamModelIds.length === 2
            ? "Select one more model for 3-player Fireworks."
            : playerCount === 3
            ? "Select three models for 3-player Fireworks."
            : "Select exactly two models for 2-player Fireworks."
        );
      }
    } else if (input.teamModelIds.length < 1) {
      return blocked("Select at least one model for TeamIQ.");
    }
  } else if (input.selectedTrack === "workbench") {
    const roleMode = input.workBenchRoleMode ?? "solo";
    const selected = input.workBenchModelIds?.length
      ? input.workBenchModelIds
      : input.modelId
        ? [input.modelId]
        : [];
    const required =
      roleMode === "architect_worker_reviewer"
        ? 3
        : roleMode === "architect_worker"
          ? 2
          : 1;
    if (selected.length < required) {
      return blocked(
        required === 1
          ? "Select a WorkBench model."
          : `Select ${required} WorkBench role models.`
      );
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

export function adjustFireworksPlayerSelectionForPlayerCount(
  selectedModelIds: string[],
  playerCount: 2 | 3
): string[] {
  return playerCount === 2 ? selectedModelIds.slice(0, 2) : selectedModelIds;
}

export function isFireworksSuite(suiteId: string): boolean {
  return suiteId.startsWith("fireworks-teamiq-");
}
