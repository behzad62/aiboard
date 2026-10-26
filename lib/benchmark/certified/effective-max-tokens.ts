import type { BenchmarkTrack } from "@/lib/benchmark/types";

export const TOOL_RELIABILITY_EFFECTIVE_MAX_TOKENS = 16_384;

export function effectiveCertifiedTrackMaxTokens(
  track: BenchmarkTrack,
  suiteId: string,
  configured?: number | null
): number | null {
  if (configured !== undefined && configured !== null) return configured;
  if (track === "toolreliability" && suiteId.startsWith("toolbench-native-")) return null;
  if (track === "toolreliability" || track === "teamiq") {
    return TOOL_RELIABILITY_EFFECTIVE_MAX_TOKENS;
  }
  return null;
}

export function effectiveCertifiedRoleMaxTokens(input: {
  track: BenchmarkTrack;
  suiteId: string;
  roleMaxTokens?: number | null;
}): number | null {
  return effectiveCertifiedTrackMaxTokens(
    input.track,
    input.suiteId,
    input.roleMaxTokens
  );
}
