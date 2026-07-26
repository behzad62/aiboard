# Benchmark Model Effort Variants Design

## Goal

Allow each selected benchmark model to use its own reasoning-effort level and
treat every model-and-effort combination as a distinct benchmark result.

## Reference behavior

Artificial Analysis presents reasoning-effort configurations as distinct model
variants. A model evaluated at low, medium, high, extra-high, or maximum effort
has a separate identity, label, model page, and benchmark result. AI Board will
follow the same comparison principle while retaining its local benchmark data
model and workflow.

## Scope

This change covers certified benchmark presets, the advanced single-suite flow,
team compositions, provider calls, persisted evidence, dashboard aggregation,
filters, charts, verdicts, profiles, reports, and imports of existing evidence.

It does not add an automatic effort sweep or permit selecting the same model
multiple times in the solo model checklist. Users can create multiple variants
of one model by running it again with a different effort.

## User experience

### Model selection

Every selected model has its own effort selector. The choices use the existing
AI Board reasoning-effort vocabulary:

- Default
- None
- Low
- Medium
- High
- Extra high
- Max

The selector only offers effort levels supported by that provider/model path.
Models without configurable reasoning stay on Default and do not present an
active effort selector.

The model checklist persists both selection and effort by model ID. Existing
persisted checklists that contain only model IDs migrate to Default without
requiring user action.

### Preset and advanced runs

Preset runs use the configured effort for each selected solo model and for each
model assigned to a team role. Advanced runs use the same per-model settings.
If one model fills more than one role, those roles use that model's configured
effort.

Run progress and completion messages continue to use the base model name because
the enclosing run controls already show the selected effort. Result surfaces,
where variants can be compared or confused, always show the effort.

### Results

Result labels append an effort suffix, for example:

- `Claude Opus 5 · High`
- `GPT-5.6 · Extra high`
- `Gemini 3.6 Flash · Default`

Teams show effort on each roster member or role rather than adding one ambiguous
team-wide suffix.

The Reasoning filter continues to support all efforts, including Default. A
model evaluated at two effort levels produces two independent leaderboard rows,
chart series, verdict candidates, evidence profiles, and report entries.

## Data model and identity

`BenchmarkTeamCompositionRole.reasoningEffort` is the canonical persisted effort
for a benchmark participant. New benchmark compositions always persist a
normalized effort value, including `default`.

Team composition hashing already includes each role's reasoning effort. The run
flow must populate the field consistently so compositions with different
efforts receive different IDs and cannot aggregate together.

Solo result identity is the tuple `(modelId, normalizedReasoningEffort)`, not
`modelId` alone. Any model intelligence or role leaderboard that currently
groups only by model ID must adopt the same tuple. Team lift compares a team
member with the matching solo model-and-effort baseline; it must not silently use
the best baseline from a different effort.

Model-call traces retain `reasoningEffort` as additional evidence. Aggregation
uses the composition role as the authoritative configuration because it exists
even when a provider does not return reasoning-token usage.

## Provider propagation

The selected effort is passed through the existing certified model-call input
and provider reasoning mappings. WorkBench passes each role's configured effort
into Runner V2 provider configuration. No new provider-specific effort mapping
is introduced.

Unsupported effort choices are prevented in the UI. Defensive normalization at
the run boundary falls back to Default when imported or stale persisted
configuration is invalid for the selected provider/model.

## Legacy and imported evidence

Missing, empty, or unrecognized reasoning effort in historical benchmark
evidence normalizes to `default` for comparison and display. Existing IDs and
stored files are not rewritten during load.

Legacy rows remain visible as Default variants. New explicit Default runs may
aggregate with compatible legacy Default evidence for the same model and team
composition semantics.

Imports remain backward compatible. Exported reports include normalized effort
labels so model variants remain distinct outside the app.

## Failure handling

- A model removed or disabled after its effort was persisted is dropped from the
  current selectable model list using the existing selection cleanup behavior.
- A stale or unsupported effort resets to Default for that model.
- Provider failures remain attributed to the exact model-and-effort variant.
- Imported evidence with malformed effort text does not fail the entire bundle;
  it is displayed and grouped as Default.

## Testing

Automated tests will establish these behaviors before implementation:

1. Model checklist persistence migrates model-ID-only data and round-trips
   per-model efforts.
2. Effort options respect provider/model support.
3. Solo, team, GameIQ, Tool Reliability, TeamIQ, and WorkBench execution place
   the configured effort on every generated role and provider call.
4. Model-and-effort variants produce distinct composition identities and
   leaderboard rows.
5. Model intelligence and role aggregations do not merge different efforts.
6. Team lift uses matching-effort solo baselines.
7. Legacy missing effort normalizes to Default.
8. Result labels, filters, evidence profiles, charts, and exported reports expose
   the variant effort.

Verification will run focused benchmark tests first, followed by the repository
lint and production build.
