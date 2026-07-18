# Benchmark and Build data boundaries

## Goal

Keep the Benchmark page's existing Run, Results, and Data tabs limited to
benchmark records. Surface accumulated Build-mode statistics in a separate
Build tab. Do not display game history on this page for now.

## Scope

- Add a top-level `Build` tab next to Run, Results, and Data.
- Render the existing Build leaderboard in that tab, preserving its existing
  Build-only reset controls and empty states.
- Build the benchmark dashboard exclusively from benchmark records. Do not
  include game match records, Build checkpoints, or aggregate Build model
  stats in benchmark summaries, analysis, exports, or report counts.
- Remove the Results tab's `Live builds` lens; Build is a separate destination.
- Retain game and Build records in storage. The change is presentation and
  benchmark-aggregation isolation, not destructive data migration.
- Update descriptive and clear-action text to accurately describe the new
  boundary.

## Data flow

`useBenchmarkDashboard` continues to load certified and legacy benchmark
records for Run, Results, and Data. Its legacy dashboard input will receive
empty game/build source arrays, so summary cards and analysis cannot derive
models, runs, latency, or rates from unrelated data. Build reads its own model
statistics through the existing Build leaderboard. Game records are neither
loaded into nor rendered by the Benchmark page.

## Verification

Add a regression test that seeds game and Build records alongside benchmark
records, clears the benchmark records, and verifies the benchmark dashboard
contains no runs, models, or non-null rates from the retained records. Keep the
existing clear-data test that proves the retained data itself is not deleted.

## Non-goals

- Moving, deleting, or otherwise changing stored game history.
- Changing how Build-mode statistics are accumulated.
- Altering certified benchmark scoring or persistence.
