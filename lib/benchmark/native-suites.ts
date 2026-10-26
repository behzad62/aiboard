import type { BenchmarkTrack } from "./types";
import { getNativeToolBenchPack, NATIVE_TOOLBENCH_SUITE } from "./toolreliability/native-cases";
import { getWorkBenchCasePack } from "./workbench/corpus";
import { createRecoverableJobServiceCasePack } from "./workbench/recoverable-job-service/case-pack";

export { NATIVE_TOOLBENCH_SUITE };
export const HARNESSBENCH_SUITE = "harnessbench-recoverable-job-service-v3";
export const WORKBENCH_SMOKE_SUITE = "workbench-native-smoke-v1";

export function isNativeBenchmarkTrack(track: BenchmarkTrack): boolean {
  return track === "toolreliability" || track === "harnessbench" || track === "workbench";
}

export function getNativeBenchmarkPack(track: BenchmarkTrack, suiteId: string) {
  if (track === "toolreliability") return getNativeToolBenchPack(suiteId);
  if (track === "harnessbench") {
    if (suiteId !== HARNESSBENCH_SUITE) return null;
    const pack = createRecoverableJobServiceCasePack();
    return { ...pack, id: HARNESSBENCH_SUITE, label: "HarnessBench: Recoverable Job Service", description: "AI Board's signature benchmark: implement the complete Recoverable Job Service contract using Runner V2. All 69 modeled families and 302 variants must pass." };
  }
  return track === "workbench" && suiteId === WORKBENCH_SMOKE_SUITE ? getWorkBenchCasePack(suiteId) : null;
}
