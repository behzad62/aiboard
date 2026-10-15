import type { CertifiedRunnableTrack } from "./suite-options";

export interface BenchmarkPresetLeg {
  track: CertifiedRunnableTrack;
  /** Suite id understood by listCertifiedSuiteOptions(track). */
  suiteId: string;
  /** "solo" runs each checked model separately; "team" uses the team builder's compositions. */
  mode: "solo" | "team";
  /** Team legs always include solo baselines (team lift needs them). */
  includeSoloBaselines?: boolean;
  /** Leg is skipped (with a visible note) when its requirement is unmet. */
  requires?: "bench-runner";
}

export interface BenchmarkPreset {
  id: "model-iq" | "team-benchmark" | "full-certified";
  title: string;
  description: string;
  legs: BenchmarkPresetLeg[];
}

// Each leg names a REAL listCertifiedSuiteOptions(track) id:
// - toolreliability "toolreliability-current-pack" — the only ToolReliability
//   suite (the stateful pack in lib/benchmark/toolreliability/cases.ts).
// - teamiq "teamiq-toolreliability-current-all-modes" — every team strategy
//   plus solo baselines over the stateful ToolReliability sample, so one click
//   yields the solo-vs-team comparison.
// - workbench "workbench-current-all" — every current WorkBench case.
export const BENCHMARK_PRESETS: BenchmarkPreset[] = [
  {
    id: "model-iq",
    title: "Models",
    description:
      "Each checked model runs the stateful Tool Reliability pack on its own. No runner needed.",
    legs: [
      {
        track: "toolreliability",
        suiteId: "toolreliability-current-pack",
        mode: "solo",
      },
    ],
  },
  {
    id: "team-benchmark",
    title: "Teams",
    description:
      "Your team compositions against their own members solo: team lift, quality, and cost per pass.",
    legs: [
      {
        track: "teamiq",
        suiteId: "teamiq-toolreliability-current-all-modes",
        mode: "team",
        includeSoloBaselines: true,
      },
    ],
  },
  {
    id: "full-certified",
    title: "Full",
    description:
      "Models + Teams + WorkBench builds. WorkBench runs only while the bench runner is connected.",
    legs: [
      {
        track: "toolreliability",
        suiteId: "toolreliability-current-pack",
        mode: "solo",
      },
      {
        track: "teamiq",
        suiteId: "teamiq-toolreliability-current-all-modes",
        mode: "team",
        includeSoloBaselines: true,
      },
      {
        track: "workbench",
        suiteId: "workbench-current-all",
        mode: "team",
        requires: "bench-runner",
      },
    ],
  },
];

export function findBenchmarkPreset(
  id: BenchmarkPreset["id"]
): BenchmarkPreset | undefined {
  return BENCHMARK_PRESETS.find((preset) => preset.id === id);
}
