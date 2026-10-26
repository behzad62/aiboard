# AI Board benchmark scoring

Current suites use native Runner V2 execution. Deterministic verifiers record benchmark outcomes; Runner V2 acceptance and operating-system safety qualification remain separate.

## HarnessBench — Recoverable Job Service

HarnessBench is AI Board's signature model benchmark. Each selected model runs the complete RJS implementation task through Runner V2; solo uses that model for all required native roles. Team runs are available in Advanced with matched solo baselines.

The frozen RJS contract and evaluator are unchanged: 69 mandatory modeled families and 302 mandatory variants. Quality is binary: 1 only when every mandatory assertion and measured safety condition passes; a valid candidate failure is 0. Invalid evaluator/environment/provider attempts are excluded. Budget exhaustion is a recorded model failure, not a successful or silently omitted attempt.

Budget per complete attempt: 3,600 seconds, 120 model calls, 500 tool calls, 3,000,000 input tokens, 200,000 output tokens. The trusted verifier has its separate 660-second limit. Family diagnostics are not independent complete model runs.

This measures the published modeled service contract; it does not certify native OS process/container safety.

## ToolBench — native tool qualification

The v3 core pack runs six isolated native Build tasks covering investigation, executed verification, stale-context recovery, coordinated edits, bounded output, and argument-array commands. It accepts the editing protocol actually exposed by the production provider adapter: filesystem tools or provider-native apply_patch. Recovery requires a real unmatched-context rejection and a subsequent successful patch; exact SHA concurrency protection remains independently regression-tested. Bounded output now requires a short range read delivering a checksum from a large file and a tiny JSON answer, rather than copying filler through the model. Variant B changes fixture data and has a separate profile. Optional browser/process and project-skill profiles are separate measurements. Unmeasured capabilities, including arbitrary MCP integrations and project-memory policies, are not certified by a core result.

Per-case emergency caps are five times v2: 4,500 seconds, 300 model calls, 900 tool calls, 5,000,000 input tokens and 750,000 output tokens. These caps prevent runaway credit use; token count, elapsed time and tool calls remain independent measured efficiency outcomes. Exhausting the emergency cap still stops the run and cannot count as successful completion. Public `node check.mjs`/`npm test` checks make final verification discoverable without installation or invented infrastructure. The behavioral verifier and tool-evidence requirements remain enforced. Changed fixture, prompt and budget identities use a separate v3 profile; historical v2 outcomes are not rewritten.

Each case requires both correct final behavior and recorded successful native tool use. Requested command evidence must match executable and exact argument array. Recovery credit requires an observed native rejection followed by a successful retry. Scope/permission/command-denial errors disqualify the case even if its output is correct. A finished run is passed only when every required case passes; partial outcomes remain visible.

All model and tool counts, tokens, costs, and elapsed time come from Runner V2 evidence. Expected revision conflicts and legitimate nonzero test exits remain visible but are not treated as malformed tool use.

Quality is primary. Efficiency uses observed time, valid invocation fraction, and priced cost when targets exist. For native ToolBench it also multiplies by 24 / (24 + actual tool calls), so extra requests always reduce this diagnostic score. This target is versioned with each fixture; it is not a claim of an optimal universal tool count. Compare only matching profiles. Costs, tokens, action counts, and elapsed time are also reported separately.

## WorkBench and TeamIQ

WorkBench is a three-case behavioral pipeline smoke suite for native integration regressions. The 13 static-only language cases and older standard WorkBench rankings are historical. TeamIQ is an experimental legacy scripted role/synthesis experiment; it does not measure the live discussion engine or native Build crew. Neither enters the default HarnessBench model recommendations.

Legacy GameIQ/Fireworks and scripted ToolReliability evidence stays available in Data/history exports and is excluded from current qualification rankings. Historical records are not rewritten into native results.

## Efficiency and comparisons

For native build cases, verified quality is zero unless the behavioral verifier passes. Job success is 100 times quality. Base efficiency renormalizes available components: 0.50 base, 0.25 cost factor, 0.15 time factor, 0.10 valid tool fraction. Missing prices or targets omit that component; they do not award free cost credit. Target factors are capped at 1. ToolBench's additional action factor is described above.

Model/provider identity, reasoning effort, role configuration, case and scorer versions, fixture digest, budgets, source digest, Node version, and platform are retained in result identity/evidence. Results default to a matching measured profile rather than averaging unlike suites. HarnessBench, ToolBench, smoke tests, and experiments keep separate scores.

### Recorded outcomes and usage

Results shows raw case outcomes for every recorded result set, including failed, cancelled, and unpublished batches. Each expected case retains its recorded status, reason, tokens, calculated cost, and time. Missing outcomes stay missing; duplicate or foreign records cannot fill them. This diagnostic display does not relax publication: a batch with an invalid harness/provider/environment/case outcome or incomplete evidence remains outside the leaderboard. Budget failures remain scoreable zero outcomes. When no batch can be ranked, Results explains that and shows the actual case outcomes instead of empty winner cards.

The Results cost table lists each benchmark run, including failed or cancelled runs, using deduplicated settled model-call traces. During native runs, newly settled calls are persisted approximately every three seconds and the dashboard refreshes approximately every five seconds without unmounting the running panel. Missing or unsettled usage is not a final invoice.

Provider token counts take priority. Missing input usage uses a serialized-request byte estimate; missing output usage uses a serialized-output estimate. Each trace records whether its tokens were reported, estimated, or mixed. Native costs are calculated from the call's recorded pricing basis, including cache rates; configured peak rates can conservatively overestimate time-discounted bills.

Where a supported response supplies dollar usage, it is retained separately as `providerReportedCostUsd`. OpenRouter's documented `usage.cost` is supported on native Chat Completions and Responses, including streaming. Undocumented currencies and missing values are not treated as USD or zero. Calculated API cost and optional provider USD appear side by side, with coverage counts. There is no difference column or automatic adjustment to saved rates or budget enforcement. Provider usage figures can still differ from invoices, negotiated discounts, fees, or BYOK billing.

Mature evidence requires at least three complete comparable runs, not three cases inside one run. Repeat whole attempts and report every repeat, including failures. Wilson intervals describe observed case pass fractions and do not establish broad model capability or independence of correlated cases. Deterministic harness self-checks are implementation tests, not live model qualification.
