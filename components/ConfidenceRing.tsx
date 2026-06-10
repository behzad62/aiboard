"use client";

import { cn } from "@/lib/utils";

/** Radial confidence meter (0–10). Shared by the verdict and build result cards. */
export function ConfidenceRing({
  value,
  className,
}: {
  value: number;
  className?: string;
}) {
  const clamped = Math.max(0, Math.min(10, value));
  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const dash = (clamped / 10) * circumference;

  return (
    <div
      className={cn(
        "relative flex h-16 w-16 shrink-0 items-center justify-center",
        className
      )}
    >
      <svg viewBox="0 0 64 64" className="h-16 w-16 -rotate-90">
        <circle
          cx="32"
          cy="32"
          r={radius}
          className="fill-none stroke-emerald-500/15"
          strokeWidth="6"
        />
        <circle
          cx="32"
          cy="32"
          r={radius}
          className="fill-none stroke-emerald-500 transition-[stroke-dasharray] duration-700 ease-out"
          strokeWidth="6"
          strokeLinecap="round"
          strokeDasharray={`${dash} ${circumference}`}
        />
      </svg>
      <div className="absolute text-center">
        <span className="block font-display text-lg font-semibold leading-none text-emerald-700 dark:text-emerald-300">
          {value}
        </span>
        <span className="block text-[0.6rem] text-muted-foreground">/10</span>
      </div>
    </div>
  );
}
