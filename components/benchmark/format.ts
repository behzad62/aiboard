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

export function shortModel(modelId: string): string {
  const parts = modelId.split(":");
  return parts[parts.length - 1] || modelId;
}
