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
    ];
  }
  return listWorkBenchCasePacks().map((pack) => ({
    id: pack.id,
    label: pack.label,
  }));
}
