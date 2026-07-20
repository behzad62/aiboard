import type { CertifiedRunnableTrack } from "./suite-options";

export interface BenchmarkPresetLeg {
  track: CertifiedRunnableTrack;
  /** Suite id understood by listCertifiedSuiteOptions(track); "gameiq-all-packs" etc. */
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

// suiteId resolution (2026-07-17 benchmark UX overhaul, Task 4 Step 2) —
// the plan's contract shipped with placeholder ids; each is resolved here
// against the REAL listCertifiedSuiteOptions(track) values in suite-options.ts:
//
// - gameiq "gameiq-all-packs" — GAMEIQ_ALL_PACKS_SUITE_ID, already the exact
//   placeholder id (the bundle-suite synthetic id, expands to every
//   registered pack; see gameIqBundlePackIds in suite-options.ts).
// - toolreliability "toolreliability-current-pack" — ToolReliability only
//   ever exposes ONE suite (the current challenge pack, case count set by
//   lib/benchmark/toolreliability/cases.ts); the plan's "toolreliability-all"
//   placeholder does not exist, so this is simply the suite there is.
// - teamiq "teamiq-toolreliability-current-all-modes" — TeamIQ exposes 6
//   suites (a ToolReliability quick suite, its "all modes" variant, and 4
//   Fireworks suites). Chosen as the broadest default over
//   "fireworks-teamiq-full-v0.1" ("full games") because it (a) already runs
//   EVERY team strategy mode plus solo baselines in one suite — the label is
//   literally "TeamIQ ToolReliability quick all modes" — which is a broader
//   test of team composition than a single-strategy Fireworks suite, and
//   (b) needs no extra Fireworks player-count UI state, keeping the preset
//   card's "one click" promise. Team benchmark's includeSoloBaselines is
//   forced on for any non-Fireworks TeamIQ suite regardless (see
//   runCertifiedTeamIq's caller in run-execution.ts), so this suite always
//   produces the solo-vs-team comparison the card promises.
// - workbench "workbench-current-all" — the "All current WorkBench cases"
//   pack (listWorkBenchCasePacks()'s first, broadest entry), matching the
//   plan's "workbench-all" placeholder intent.
export const BENCHMARK_PRESETS: BenchmarkPreset[] = [
  {
    id: "model-iq",
    title: "Model IQ",
    description:
      "Every checked model runs the full GameIQ bundle and the Tool Reliability suite solo. No runner needed.",
    legs: [
      { track: "gameiq", suiteId: "gameiq-all-packs", mode: "solo" },
      {
        track: "toolreliability",
        suiteId: "toolreliability-current-pack",
        mode: "solo",
      },
    ],
  },
  {
    id: "team-benchmark",
    title: "Team benchmark",
    description:
      "Your team compositions vs their own members solo — team lift, quality, and cost per pass.",
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
    title: "Full certified",
    description:
      "Model IQ + Team benchmark + WorkBench (WorkBench legs run only while the bench runner is connected).",
    legs: [
      { track: "gameiq", suiteId: "gameiq-all-packs", mode: "solo" },
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
