import { HARNESSBENCH_SUITE, NATIVE_TOOLBENCH_SUITE } from "@/lib/benchmark/native-suites";
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

// Solo presets use one selected model for all native roles; team experiments
// remain available through Advanced and never enter the default qualification.
export const BENCHMARK_PRESETS: BenchmarkPreset[] = [
  {
    id: "team-benchmark",
    title: "HarnessBench",
    description: "AI Board's signature benchmark: each checked model implements Recoverable Job Service. All 69 modeled families and 302 variants must pass. Budget: up to 60 minutes per model.",
    legs: [{ track: "harnessbench", suiteId: HARNESSBENCH_SUITE, mode: "solo", requires: "bench-runner" }],
  },
  {
    id: "model-iq",
    title: "ToolBench",
    description: "Qualify native tool use: repository investigation, safe edits, revision recovery, bounded output, and real command evidence.",
    legs: [{ track: "toolreliability", suiteId: NATIVE_TOOLBENCH_SUITE, mode: "solo", requires: "bench-runner" }],
  },
  {
    id: "full-certified",
    title: "Both benchmarks",
    description: "Run ToolBench and the signature HarnessBench for each checked model. Each suite keeps its own score and evidence.",
    legs: [
      { track: "toolreliability", suiteId: NATIVE_TOOLBENCH_SUITE, mode: "solo", requires: "bench-runner" },
      { track: "harnessbench", suiteId: HARNESSBENCH_SUITE, mode: "solo", requires: "bench-runner" },
    ],
  },
];

export function findBenchmarkPreset(
  id: BenchmarkPreset["id"]
): BenchmarkPreset | undefined {
  return BENCHMARK_PRESETS.find((preset) => preset.id === id);
}
