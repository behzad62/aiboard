import type { BenchmarkTrack } from "@/lib/benchmark/types";

export const GAMEIQ_EFFECTIVE_MAX_TOKENS = 16_384;
export const TOOL_RELIABILITY_EFFECTIVE_MAX_TOKENS = 16_384;
export const FIREWORKS_EFFECTIVE_MAX_TOKENS = 512;

export function effectiveCertifiedTrackMaxTokens(
  track: BenchmarkTrack,
  suiteId: string,
  configured?: number | null
): number | null {
  if (configured !== undefined && configured !== null) return configured;
  if (track === "gameiq") return GAMEIQ_EFFECTIVE_MAX_TOKENS;
  if (track === "toolreliability") return TOOL_RELIABILITY_EFFECTIVE_MAX_TOKENS;
  if (track === "teamiq") {
    return /fireworks/i.test(suiteId)
      ? FIREWORKS_EFFECTIVE_MAX_TOKENS
      : TOOL_RELIABILITY_EFFECTIVE_MAX_TOKENS;
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
