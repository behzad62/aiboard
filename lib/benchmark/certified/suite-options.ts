import { listWorkBenchCasePacks } from "@/lib/benchmark/workbench";
import { getNativeBenchmarkPack, HARNESSBENCH_SUITE, NATIVE_TOOLBENCH_SUITE } from "@/lib/benchmark/native-suites";

import type { CertifiedRunnableTrack } from "./ui-gates";

export type { CertifiedRunnableTrack } from "./ui-gates";

export interface CertifiedSuiteOption {
  id: string;
  label: string;
}

export function listCertifiedSuiteOptions(
  track: CertifiedRunnableTrack
): CertifiedSuiteOption[] {
  if (track === "toolreliability" || track === "harnessbench") {
    const id = track === "toolreliability" ? NATIVE_TOOLBENCH_SUITE : HARNESSBENCH_SUITE;
    const ids = [id];
    return ids.map(id => ({ id, label: getNativeBenchmarkPack(track, id)!.label }));
  }
  if (track === "teamiq") {
    return [
      {
        id: "teamiq-toolreliability-current-quick",
        label: "Experimental TeamIQ: legacy scripted tool sample",
      },
      {
        id: "teamiq-toolreliability-current-all-modes",
        label: "Experimental TeamIQ: legacy scripted sample (all modes)",
      },
    ];
  }
  return listWorkBenchCasePacks().map((pack) => ({
    id: pack.id,
    label: pack.label,
  }));
}
