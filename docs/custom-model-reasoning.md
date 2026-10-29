# Custom-model reasoning support (2026-10-29)

AIBoard custom OpenAI-compatible models now have a configurable **default reasoning effort**: Endpoint default, Off, Low, Medium, High. This setting is saved with the custom-model record (not only in browser component state).

## Semantics

- `default` omits reasoning controls entirely, so the model/runtime decides. Existing records without a reasoning setting retain this behavior.
- `none`, `low`, `medium`, `high` send `reasoning_effort` on Chat Completions, and `reasoning: {effort}` on Responses API when the transport is declared and selected.
- Explicit reasoning effort from ToolBench/other call sites overrides the saved model default. Selecting `default` for a benchmark uses the saved model default. ToolBench's custom model selector offers the same five options.
- Endpoint support is not automatically guaranteed. Invalid or unsupported reasoning modes should surface an error, not silently fall back to non-reasoning.
- AIBoard's settings connection test uses the chosen reasoning mode and requires visible text output, not just HTTP 200 or hidden thinking. It skips the vision probe for text-only models and allows longer local model cold starts. If the model emits no visible text, the test explains that the user can select Off or adjust reasoning.
- Per-call output token limits and timeout requirements still apply. Reasoning tokens may consume output capacity; a passed connection test does not certify reasoning quality or ToolBench correctness.

## Live local test evidence

On Ollama localhost:11434/v1 with `mule-mimo-q4` and `mule-mellum-q4`:
- MiMo with `none`: AIBoard settings live probe returned `The model test works.`; AIBoard custom streaming adapter returned `READY`.
- MiMo with `none`: AIBoard custom streaming adapter emitted a real `add_numbers({a:4,b:7})` tool call.
- MiMo with `low`: OpenAI-compatible and Ollama native endpoints returned empty visible output; native `think: true` returned 1 output token with empty content and empty thinking. This is an observed runtime/model incompatibility, **not** evidence that AIBoard should disable reasoning for every custom provider.
- Mellum with `low`: AIBoard settings live probe passed, returning `Yes, the test works.`.
- These are connectivity and tool-call smoke tests, not full certified ToolBench runs.

## Reproduce (without paid calls)

Run `npx tsx scripts/test-custom-reasoning.mts`, `npx tsx scripts/test-benchmark-model-effort.mts`, `npx tsx scripts/test-custom-provider-capability-ui.tsx` and `npx tsc --noEmit`.

In **Settings → Custom models**, select `Off` for the current MiMo quantization, click **Test connection**, then choose the model in ToolBench. For an explicit reasoning comparison, choose `Low` on Mellum or evaluate MiMo using another checkpoint/runtime after validating actual visible reasoning output. Ensure **Function calling** is declared for ToolBench and verify the actual benchmark result, not just a connection check.

The existing unrelated `package-lock.json` modification is intentionally not changed by this work.
