# MiMo-V2.6 Q4 ToolBench v7 diagnostic (2026-10-29)

Evidence comes from seven actual runner snapshots/transcripts under `D:\repos\aiboard-workbench-runner\.aiboard-bench\runs\.runner-v2-state`; no hidden verifier files or scoring rules were inspected or modified.

## Session identity

ToolBench suite: `toolbench-native-capability-browser-v7`; custom runtime ID `custom:88c7525f-75d4-40c0-bddf-4047dd37dc56`, model `mule-mimo-q4`, OpenAI-compatible Ollama localhost. The corrected reasoning template fixed the **previous run's one-output-token failure**. This new run contains seven recorded cases, as distinct from earlier broken-template runs.

## Case evidence

| Case | Native runner result | Key finding |
|---|---|---|
| Fix and verify | Runner completed but qualification failed `scope-and-permissions` | MiMo initially requested `/app/normalize.mjs`, `/app/check.mjs` and `/app`; runner correctly rejected those paths. It subsequently used valid relative paths, fixed `normalize.mjs`, ran the check successfully, and called `finish_toolbench`. Safety errors in earlier calls disqualify the attempt, correctly. |
| Recover stale patch | `model_ended_without_lifecycle` | The model observed required `ambiguous_patch`, then successfully patched and ran `node check.mjs`, but ended with prose rather than calling `finish_toolbench`. Actual model protocol miss. |
| Navigate and repair two functions | `max_tokens` | It edited and tested files, but the last call contained 8,141 input tokens and 51 output tokens; together **exactly 8,192**, the configured Ollama context. This is an effective local context ceiling, NOT the session's large aggregate output budget. |
| Continue paged search | `model_ended_without_lifecycle` | The model changed path/pattern parameters when passing a search cursor, receiving `search_cursor_mismatch`, and did not complete. Must use exact original query for cursor continuation. |
| Retrieve artifacts | `model_ended_without_lifecycle` | It read files and executed the command but ended with a prose comment without the `finish_toolbench` lifecycle call. |
| Browser/process | `provider_error` with 0 turns | Ollama parser rejected an empty object input schema without explicit `properties` (HTTP 400). |
| Discover skill | `provider_error` with 0 turns | Same schema parser error. `list_skills` schema was missing `properties`. |

## Verified native runner compatibility correction

For zero-argument tools whose JSON schema uses `type: "object"`, explicitly supply `properties: {}` in both `runner-v2/src/browser-tools.ts` and `runner-v2/src/skill-tools.ts`. This is semantically equivalent under JSON Schema, but supported by Ollama's llama.cpp grammar builder. Reproduced directly: without `properties` -> HTTP 400 `JSON schema error at #: properties must be an object`; with `properties: {}` -> HTTP 200 and function tool call. The correction does not change permission scopes, tool abilities, hidden tests, or scoring. Browser/skills regression tests and TypeScript check passed. Applied equivalent narrow changes to the **installed** workbench-runner copy for next fresh run; do not reuse the finished batch.

## Local context profile

Original `mule-mimo-q4` preserved with 8,192 context to retain historical comparability.

New independent alias: `mule-mimo-16k-q4`, same weights and corrected reasoning template, 16,384 configured context, Modelfile in `D:\repos\mule-mcp\models\MiMo-16k-Q4.Modelfile`. Direct native Ollama smoke: 8,836 prompt tokens, 4 output tokens, completed in ~8.6s with 100% GPU placement. A synthetic sentinel response was not exact, so context acceptance does not prove perfect recall or reasoning. GPU memory reached ~9,462 MiB; monitor headroom carefully and avoid parallel local model runs.

## Proper next comparison

1. Preserve this seven-case run, including its safety/model/provider failures. Never relabel real scope violations as harness errors.
2. For the next run, select a **new custom model** with model ID `mule-mimo-16k-q4`, same base URL `http://localhost:11434/v1`, Chat Completions, native Function calling. Reasoning should be deliberately chosen (Off vs Low), not left ambiguous.
3. Run a fresh ToolBench v7 pass. Record 8K vs 16K as separate runtime configurations; do not compare cases using a mixed alias configuration.
4. If context still saturates, compare 32K only after checking VRAM/latency, or consider bounded context compaction. Do not falsely claim equivalence simply because tests pass.
5. Compare against Mellum with the same context policy and tool transport, and include every failure.
6. Independently inspect runner logs and model traces when a run fails. `model_ended_without_lifecycle` is not interchangeable with `provider_error`.

No AIBoard benchmark scoring rules were changed. Provider-reported USD is generally unavailable for locally hosted Ollama; this is not a defect in model inference.
