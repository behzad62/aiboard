# Local LFM3 ToolBench calibration — 2026-10-30

## Configuration

- Model: `mule-lfm3-64k-q8` (`custom:c11abaaa-6ade-491f-bd34-846284c65f1b`), Ollama 0.40.13 at `http://127.0.0.1:11434/v1`.
- Model digest: `8e99c6f40f676142fddd22cb60f418f0af80839b07794391810fa535f2d902d9`.
- Ollama reports LFM3, 1.73B parameters, Q8_0, tool calling and thinking capabilities.
- Alias defaults: context 65,536; generation 4,096; temperature 0.1. The alias was not modified.
- Saved AI Board context: 65,536; per-response output limit 32,768; Build reserve 32,768; Build input ceiling 32,768.
- Benchmark effort: None. The fixed native adapter sends `reasoning_effort: "none"` and `max_tokens: 32768`.
- Suite: `toolbench-native-capability-browser-v7`, seven solo native-tool cases. No Build crew, model reviewer, or hidden score feedback.
- Diagnostic batch prefix: `workbench-ui-toolreliability-c730c`, started 2026-10-30 07:12:17 UTC.
- Diagnostic Runner source digest: `9ef378a50e8d97d42710c4633eaa85dff4fb49a26eff22c2ccab561a9f741bef`.

The 32K generation allowance is a maximum, not a target. Input and output share the 64K
context. Cumulative ToolBench budgets remain emergency guards. All inference was local;
no paid provider calls were made. USD pricing remains unavailable for this unpriced local model.

## Defects found and corrected

1. **Custom-model reasoning configuration was lost before Runner delivery.** The native
   configuration's custom-provider branch returned before copying the selected or saved
   reasoning effort. Ollama therefore used its thinking-enabled default even while ToolBench
   displayed None. Explicit benchmark/role effort now takes precedence over the saved default.
2. **The native custom transport did not send the configured generation limit.** It now carries
   the context profile's limit through configuration validation and the model factory to Chat
   Completions `max_tokens` or Responses `max_output_tokens`. ToolBench reserves that output
   allowance before each call. Live streaming and non-streaming probes confirmed the actual
   Ollama request fields and returned visible output without reasoning blocks.
3. **Thrown read-only I/O errors left unfinished audit records.** `fs.read` errors such as ENOENT
   and EISDIR reached the model, but their ledger entries had no completion. This could falsely
   fail `all-tool-results-settled`. Read-only, effect-free exceptions now record the same error
   result durably. Exceptions from side-effecting tools still remain in doubt and require
   reconciliation. The fresh navigation case exercised failed reads and passed qualification.

Two earlier batches (`a2b72` and `1fbb8`) were cancelled when these defects were found.
Their original records remain in the UI for diagnosis; they are not clean calibration results.
No case, hidden verifier, required tool, or qualification threshold was weakened.

The later `c730c` diagnostic batch was cancelled after finding that the no-progress reminder
incorrectly told the solo model to ask an Architect. Solo sessions now receive appropriately
worded mechanical reminders without changing the stall thresholds. The two recorded passes
and three failures from this incomplete diagnostic batch are visible in Results. A subsequent
run uses the user's requested reasoning-enabled configuration.

## Validation

- Both application and Runner TypeScript checks passed.
- Custom reasoning/configuration and benchmark effort scripts passed.
- Provider transport tests: 38 passed, including both protocol bodies and invalid output limits.
- Tool broker tests: 9 passed, including durable failed-read replay and preserved uncertain-write reconciliation.
- Filesystem tool tests: 18 passed.
- Solo ToolBench session script: all eight scripted native-tool cases passed.
- Changed-path ESLint and `git diff --check` passed.
- Generic Runner and WorkBench ZIPs were regenerated and their five changed native sources
  checked against the working tree. Pinned RJS ZIP was byte-identical and was not replaced.

## Evidence

Live snapshots/transcripts are retained outside the repository in
`D:/tmp/aiboard-development/calibration-lfm3-64k-q8-20261030-final` (filter batch `c730c`).
These are periodic captures and can miss the final checkpoint of rapidly cleaned-up cases;
the browser's recorded final outcomes are authoritative for case totals.
The unrelated pre-existing `package-lock.json` change was left untouched.

## Reasoning-enabled runs

On 2026-10-30 the user requested reasoning for the next run. ToolBench was set to Low;
the native transcripts contained reasoning blocks. The 32,768 per-response limit and
65,536 context were retained. Batch `b4753` finished 3 passed, 4 failed, but its browser
failure included unsettled tool audit entries and should not be interpreted as a clean score.

The solo adapter was corrected to classify an unsettled tool audit as `invalid_harness`
instead of blaming the model. This retains the qualification requirement and does not
mark uncertain side effects as completed. Focused tests cover both unsettled and ordinary
qualification failures. The following batch `5fbb8` finished 7/7 cases, 2 passed,
3 failed, 2 excluded, and is not ranked. Runner source digest:
`f946decfdc5952e1078a3b85a3923c9035638be91de795a0462d58b47a541da4`.

Passed: paged search and project skill. Failed: stale patch recovery, atomic navigation
(read-only stall), and bounded artifact retrieval. The excluded behavior/check case issued
`run_evidence_command` using the absolute workspace root; grant creation rejected conflicting
read/write access modes for the same canonical root. The excluded browser case invoked
`browser.navigate` before opening a session, and that exception left the side-effecting
invocation in doubt. These are remaining audit/handling issues, not evidence of model failure.
Recorded results are historical; the earlier browser case in `b4753` was not silently rewritten.
The new classification prevents these uncertain records from becoming ranked scores but does
not fix their underlying causes.

The reasoning-enabled rerun's monitored evidence is in
`D:/tmp/aiboard-development/calibration-lfm3-thinking-rerun-20261030` (batch `5fbb8`).

## Follow-up fixes

`run_evidence_command` now requests a single write grant when its cwd resolves lexically to the
workspace root, including the absolute root path. A subdirectory still requires its own write
grant and a separate read grant for the workspace, and outside paths remain subject to the
existing confinement checks. Aliases that cannot be established as the same root remain
subject to canonical grant validation.

The Playwright backend now marks its specific pre-operation missing-session condition as a
known error. Browser tool execution records that result durably. Errors whose effects are
uncertain, such as a failure after navigation begins, remain unsettled and require reconciliation.
The earlier calibration record is retained; these fixes do not retroactively rescore it.
