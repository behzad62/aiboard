import type { ModelContextProfile } from "./model-context";
import { formatContextWindowTokens } from "./model-context";

export function formatModelContextIndicator(
  profile: ModelContextProfile
): string {
  const context = `${formatContextWindowTokens(profile.contextWindowTokens)} ctx`;
  return profile.buildOutputReserveTokens
    ? `${context} / ${formatContextWindowTokens(
        profile.buildOutputReserveTokens
      )} reserve`
    : context;
}
