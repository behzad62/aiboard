export const TEAMIQ_TOOL_RELIABILITY_QUICK_WALL_CLOCK_SECONDS = 900;
export const TEAMIQ_TOOL_RELIABILITY_ALL_MODES_WALL_CLOCK_SECONDS = 3600;

export function teamIqToolReliabilityWallClockSecondsForSuite(
  suiteId: string
): number {
  return suiteId === "teamiq-toolreliability-current-all-modes"
    ? TEAMIQ_TOOL_RELIABILITY_ALL_MODES_WALL_CLOCK_SECONDS
    : TEAMIQ_TOOL_RELIABILITY_QUICK_WALL_CLOCK_SECONDS;
}
