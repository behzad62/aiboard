import { HARNESSBENCH_SUITE, NATIVE_TOOLBENCH_SUITE } from "@/lib/benchmark/native-suites";
import type { CertifiedRunnableTrack } from "./suite-options";

export interface BenchmarkPresetLeg {
  track: CertifiedRunnableTrack;
  /** Suite id understood by listCertifiedSuiteOptions(track). */
  suiteId: string;
  /** "solo" runs each checked model separately; "team" uses the team builder's compositions. */
  mode: "solo" | "team";
  /** Explicit opt-in for legacy team experiments; HarnessBench keeps its full crew. */
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

// ToolBench measures solo sessions. HarnessBench measures one explicit Build crew.
export const BENCHMARK_PRESETS: BenchmarkPreset[] = [
  {
    id: "team-benchmark",
    title: "HarnessBench",
    description: "Recoverable Job Service through the full Build workflow: Architect, Worker, and Reviewer/Verifier. All 69 modeled families and 302 variants must pass.",
    legs: [{ track: "harnessbench", suiteId: HARNESSBENCH_SUITE, mode: "team", includeSoloBaselines: false, requires: "bench-runner" }],
  },
  {
    id: "model-iq",
    title: "ToolBench",
    description: "Each selected model works alone with AI Board's native tools. Measures correctness, token use, cost, and time without the Build pipeline.",
    legs: [{ track: "toolreliability", suiteId: NATIVE_TOOLBENCH_SUITE, mode: "solo", requires: "bench-runner" }],
  },
];

export function findBenchmarkPreset(
  id: BenchmarkPreset["id"]
): BenchmarkPreset | undefined {
  return BENCHMARK_PRESETS.find((preset) => preset.id === id);
}
