import { listGameIqScenarioPacks } from "@/lib/benchmark/gameiq";
import { listWorkBenchCasePacks } from "@/lib/benchmark/workbench";
import type { CertifiedRunnableTrack } from "./ui-gates";

export type { CertifiedRunnableTrack } from "./ui-gates";

export interface CertifiedSuiteOption {
  id: string;
  label: string;
}

export function listCertifiedSuiteOptions(
  track: CertifiedRunnableTrack
): CertifiedSuiteOption[] {
  if (track === "toolreliability") {
    return [
      {
        id: "toolreliability-current-pack",
        label: "ToolReliability: Current challenge pack",
      },
    ];
  }
  if (track === "teamiq") {
    return [
      {
        id: "teamiq-toolreliability-current-quick",
        label: "TeamIQ: ToolReliability quick",
      },
      {
        id: "teamiq-toolreliability-current-all-modes",
        label: "TeamIQ: ToolReliability quick (all modes)",
      },
      {
        id: "fireworks-teamiq-tactics-v0.1",
        label: "Fireworks: Tactics",
      },
      {
        id: "fireworks-teamiq-memory-v0.1",
        label: "Fireworks: Memory",
      },
      {
        id: "fireworks-teamiq-full-v0.1",
        label: "Fireworks: Full games",
      },
      {
        id: "fireworks-teamiq-mixed-v0.1",
        label: "Fireworks: Mixed suite",
      },
    ];
  }
  if (track === "workbench") {
    return listWorkBenchCasePacks().map((pack) => ({
      id: pack.id,
      label: pack.label,
    }));
  }
  return listGameIqScenarioPacks().map((pack) => ({
    id: pack.id,
    label: pack.label,
  }));
}
