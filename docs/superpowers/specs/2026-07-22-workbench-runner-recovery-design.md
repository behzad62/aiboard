# WorkBench Runner Recovery Design

## Goal

Make Runner V2 recover once from malformed lifecycle-tool batches without replaying the same checkpoint, keep certified failure classification truthful, preserve usage metrics on failures, and raise WorkBench token safety caps by 10x.

## Design

Runner V2 will preserve malformed assistant tool batches as durable history but will append synthetic protocol-error tool results for every rejected call. Those results make the call IDs consumed, so a resumed session cannot reinterpret or replay the invalid lifecycle operation. A recovered legacy checkpoint containing an unconsumed malformed batch will be quarantined the same way and then allowed to reach a fresh model turn.

Scheduler projections will expose the latest pause reason and clear it on resume. The WorkBench bridge will route that structured reason instead of blindly resuming every pause. Protocol and model-lifecycle pauses receive a small bounded number of benchmark continuations; budget continuations stop immediately; unknown pauses remain harness failures. Benchmark continuations use a dedicated control-plane command that resumes the durable run without opening a new user budget window.

Native WorkBench failures will carry a typed certified status/code and a partial build result derived from the Runner V2 audit. The bridge will record model traces, tool traces, and the audit artifact before throwing, so failed attempts retain their actual token and call metrics. The executor will prefer typed metadata over message regexes.

The built-in WorkBench corpus will change only `maxInputTokens` and `maxOutputTokens`, from 350,000/100,000 to 3,500,000/1,000,000. Model-call, tool-call, wall-clock, verifier, scoring, and token telemetry behavior remain unchanged.

## Error Mapping

- `budget_exhausted:*` -> `failed_budget`
- `protocol_error:*` after bounded recovery -> `failed_tool_use`
- `model_ended_without_lifecycle:*`, `max_tokens:*`, `turn_limit:*`, or read-only/evidence stalls -> `failed_model`
- provider handoff without an eligible runtime -> `provider_unavailable`
- unrecognized runner pause -> `invalid_harness`

## Testing

- Agent-loop tests reproduce both a new malformed lifecycle batch and a legacy recovered malformed checkpoint.
- Scheduler reducer tests verify pause-reason projection and clearing.
- Runtime/control tests verify benchmark continuation does not renew a budget window while normal resume still does.
- WorkBench adapter tests verify bounded structured routing, typed failure metadata, failure audit recording, and 10x corpus limits.
- Focused Runner V2 and WorkBench suites run before the repository build/lint checks.
