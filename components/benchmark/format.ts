"use client";

export function pct(value: number | null): string {
  return value == null ? "n/a" : `${Math.round(value * 100)}%`;
}

export function compactPct(value: number): string {
  return `${Math.round(value)}%`;
}

export function usd(value: number | null): string {
  return value == null ? "n/a" : `$${value.toFixed(3)}`;
}

export function duration(value: number | null): string {
  if (value == null) return "n/a";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(1)}s`;
}

/**
 * Format a 0-100 points score (jobSuccessScore, efficiencyScore,
 * toolReliabilityScore). Callers own the scale: pass 0-1 quantities through
 * {@link formatNormalizedScore} instead. Deliberately NO magnitude inference
 * (`value <= 1 ? value * 100 : value`) — that heuristic corrupts legitimate
 * small points values (a team lift of 1.0, an efficiency of 0.5/100), which is
 * exactly the bug the TeamIQ percent()/points() split removed.
 */
export function formatScore(value: number | null): string {
  if (value == null) return "n/a";
  return `${Math.round(value * 10) / 10}`;
}

/** Format a 0-1 normalized quantity (verifiedQuality) as a bare 0-100 score. */
export function formatNormalizedScore(value: number | null): string {
  if (value == null) return "n/a";
  return formatScore(value * 100);
}

export function shortModel(modelId: string): string {
  const parts = modelId.split(":");
  return parts[parts.length - 1] || modelId;
}
