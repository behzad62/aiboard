# First live ToolBench calibration — DeepSeek Flash

26 October 2026, 16:23:35–17:17:16 Asia/Dubai (12:23:35–13:17:16 UTC). All six cases finished recording. This batch cannot publish a model ranking: four cases exhausted their fixed input-token budgets, and two have invalid harness outcomes. No case passed.

## Configuration

- Model: DeepSeek-V4.1-Flash; configured runtime `deepseek:deepseek-flash`; Default reasoning; solo, with the same model supplying all native roles.
- Suite `toolbench-native-core-v2`, case version `2.0.0`, scorer `native-toolbench-v2`.
- Runner source SHA-256 `919ab31215a8ffc8c0a908a2aeba5741985538bf95f2f8d57a9eaf9bd7c2dd31`; Node `24.18.0`; Windows.
- Per-case limits: 900 seconds, 60 model calls, 180 tool calls, 1,000,000 input tokens, 150,000 output tokens. Limits, prompts, and Runner source were left unchanged during the v2 pass.
- Run ID `ui-toolreliability-a66e214d-8355-4d41-b05c-99145c7650ff`.

## Recorded outcomes

| Case | Outcome | Input / output tokens | Model calls | Calculated USD |
| --- | --- | ---: | ---: | ---: |
| Repository investigation | Budget exhausted | 941,918 / 51,529 | 52 | 0.131562 |
| Executed verification | Budget exhausted | 955,126 / 45,448 | 49 | 0.121496 |
| Stale-context recovery | Invalid harness: paused without a structured reason | 996,153 / 40,160 | 44 | 0.100775 |
| Coordinated atomic edit | Invalid harness: autonomous pump stayed paused after bounded recovery | 402,877 / 16,995 | 24 | 0.042287 |
| Bounded file copy | Budget exhausted | 943,822 / 54,729 | 31 | 0.076363 |
| Argument-array command | Budget exhausted | 966,021 / 42,351 | 52 | 0.104976 |

Total: **252 settled model calls, 5,205,917 input tokens (4,373,376 cached), 251,212 output tokens, USD0.577459 calculated cost**. All 252 token-usage records are provider-reported. No response supplied a provider-reported USD amount.

The four budget failures occurred before the next input reservation would exceed one million tokens. Input counts are cumulative across calls and native roles, including repeated conversation context and retries. The lower settled count at the stop does not mean the cap was ignored. These are scoreable failures. The two harness-invalid cases are excluded, and make the whole six-case profile ineligible for a leaderboard ranking. Do not present the batch as either a certified 0/6 model score or a measured pass rate for all six cases.

The verification case also recorded denied Git shell commands through `run_evidence_command`; the allowed `node check.mjs` calls ran. Repository inspection has separate native Git tools. Raw tool and lifecycle evidence remains available for diagnosing this behavior. Successful native patch calls were observed; this does not override failed completion or missing qualification evidence.

## Costs and evidence

The recorded rates are the configured peak rates: USD0.30/M uncached input, USD0.006/M cached input, USD1.20/M output. DeepSeek's published off-peak rates are half these rates. The run occurred outside the published peak windows; the tariff-equivalent estimate is approximately USD0.288730, not a provider-confirmed invoice. The displayed USD0.577459 retains the pricing basis actually recorded with the run. See [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing/) and [Responses usage](https://api-docs.deepseek.com/guides/responses_api/).

Canonical UI export on this machine: `D:/tmp/aiboard-development/calibration-deepseek-toolbench/final-benchmark-bundle.json`. It includes six attempts, six verifier results, settled traces, failure records, and native audit artifacts. The export's redaction scan reported zero secrets removed. The earlier v1 run was cancelled after discovering an incompatible editing-tool qualification assumption; it is separate historical diagnostic evidence with no model score. Its browser cost is unavailable, not zero.

## Product findings and remaining work

The missing-results complaint exposed a presentation bug: Results only displayed publishable leaderboard snapshots and empty winner cards for this failed batch. Results now displays all recorded case outcomes and reasons, retains the failed budget outcomes, and clearly labels harness errors as excluded. The cost difference column was removed as requested; calculated cost and optional provider USD remain side by side.

This first pass exposes heavy lifecycle/review overhead relative to the tiny fixtures and two unresolved harness pause paths. Native audit artifacts should be used to reproduce and diagnose those paths before a further qualification pass. Increasing limits, relabeling infrastructure errors as model failures, or silently rerunning this model would not validate the existing result. No further paid runs or deployment were initiated as part of the visibility fix.

Visibility-fix checks passed: cost transport/ledger tests, raw-outcome/publication controls (including partial, duplicate, and foreign evidence), dashboard selectors and rendered UI contracts, result-set audit UI, application TypeScript, and ESLint for the affected files. The actual saved six-case bundle was verified in the running browser. These targeted checks do not assert that the broader benchmark or Runner acceptance gates are green.
