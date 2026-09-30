# Recoverable Job Service benchmark

Recoverable Job Service is a standalone coding benchmark in AI Board's WorkBench track. A model receives a fresh, app-independent service contract and implements the missing core in `service.js`. The trusted evaluator then tests recovery, concurrency, durable evidence, source attachment, capacity, cleanup, and safe refusal under uncertainty.

## Run it in AI Board

1. Open **Benchmark**, expand **Advanced: run a single suite or pack**, choose **WorkBench**, and select **Recoverable Job Service**.
2. Download **Recoverable Job Service runner**. Use Node.js 24.18.0 in the extracted directory, then run `npm ci`, `npm run setup:browser`, and `npm start`.
3. Copy the printed local URL and token into AI Board and select **Check**. This verifies the Bench service, launchable Runner V2 source, and exact trusted RJS runtime. After an attempt is prepared, AI Board separately starts and authenticates the managed child against that attempt's project, protocol, and Node identity.
4. Choose the model or team and run the selected benchmark. `service.js` is the only accepted submission change. AI Board supplies the other ten model-visible files as contract context, then rejects any final workspace that changes or removes them or adds another entry.

The 11 model-visible files are `problem.md`, `acceptance-contract.md`, `runtime-contract.md`, `contract.d.ts`, `source-bootstrap.md`, `service.js`, `families.json`, `examples.mjs`, `source-examples.mjs`, `source-variants.json`, and `public-test.mjs`. Private evaluator code, hidden inputs, controls, and reference implementations are never model input.

## What the score means

The frozen `rjs-contract-2.0.1` / `rjs-suite-2.0.1` profile contains 69 mandatory families and 302 mandatory variants. Scoring is binary: every family, variant, assertion, and measured safety condition must pass for a score of 1; any valid candidate failure scores 0. Evaluator or environment failures are excluded instead of being charged to the model.

Results retain the exact contract and suite hashes, candidate hash, hidden-input commitment, group totals, family and variant diagnostics, safety failures, operation counts, and public contract snapshot. Open **Results**, then **View profile**, to inspect this evidence. The Data tab exports the same durable result bundle. Reloading the browser preserves completed snapshots and their history.

The standard production evaluation is deterministic for its frozen hidden-input identity. For a formal comparison, run each model in a fresh attempt with the same benchmark version, Runner version, Node version, provider settings, reasoning effort, token limits, and model-call/tool-call budgets. Repeat the complete attempt rather than rerunning selected failed variants. Report every repeat; do not keep only the best result.

The configured attempt budget is 3,600 seconds, 120 model calls, 500 tool calls, 3,000,000 input tokens, and 200,000 output tokens. The trusted verifier has a separate 660-second ceiling.

## Qualification and limits

All 69 families are scoring-admitted under `rjs-simplification-audit-1`. Qualification used three distinct complete controls, 61 material predicate groups, restored-control checks, replay identity checks, and capacity evidence, including a 1,100-record close case. H01–H09 are evaluator qualification checks and award no candidate points.

This release qualifies the deterministic modeled QuickJS profile. It does not claim equivalence to native operating-system process, filesystem, or container behavior. The downloaded evaluator is isolated from benchmark agents but remains inspectable by the machine owner. See [scoring-admission.json](scoring-admission.json), [instruction-audit.md](instruction-audit.md), and [design-validation.json](design-validation.json) for the admission record.
