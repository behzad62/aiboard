# Handoff Above Build Activity Design

## Goal

When Runner V2 requests the final project handoff, show that decision card above the Build activity panel so the required user action is visible before diagnostic detail.

## Design

Move the existing `projectHandoff` JSX block to render after `BuildRunStats` and immediately before `RunnerV2ObservabilityPanel`. Keep its condition, summary, options, handlers, dry-run explanation, and styling unchanged. Architect-runtime handoff, permission requests, stop fallback, task board, and repository workflow retain their current behavior and relative order.

## Verification

Extend the build activity layout contract to require the final handoff marker before `RunnerV2ObservabilityPanel`. Run the test before the move to prove it fails, then after the move to prove it passes. Run TypeScript and the focused Build UI contracts.
