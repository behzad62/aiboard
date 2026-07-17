# Kimi K3 OpenRouter Support Design

## Goal

Add `moonshotai/kimi-k3` as a first-class OpenRouter model throughout AI Board. It must be selectable anywhere catalog models are used, participate in Discussion and native Build flows, advertise its actual input/tool capabilities, receive model-specific context and pricing metadata, and route reasoning parameters safely.

## Confirmed upstream contract

- OpenRouter model id: `moonshotai/kimi-k3`.
- Context window: 1,048,576 tokens.
- Input modality: text and image; output modality: text.
- OpenRouter supports tools, `tool_choice`, structured output, and reasoning parameters for this model.
- Kimi's official API documentation says K3 always reasons and currently accepts only top-level `reasoning_effort: "max"`; `none`, `low`, `medium`, and `high` are not valid K3 values.
- Kimi fixes temperature at `1.0`, so the OpenRouter transport must omit its normal temperature field for K3 requests.

Sources:

- [OpenRouter Kimi K3 model page](https://openrouter.ai/moonshotai/kimi-k3)
- [OpenRouter Models API](https://openrouter.ai/api/v1/models)
- [Kimi model parameter reference](https://platform.kimi.ai/docs/api/models-overview)
- [Kimi model list](https://platform.kimi.ai/docs/models)

## Design

### Catalog and metadata

Add one OpenRouter `CatalogModel` entry with the `moonshotai/kimi-k3` slug, display name `Kimi K3`, a concise 1M-context multimodal reasoning description, and capabilities `{ image: true, document: false, audio: false, video: false }`.

Add a model-specific context profile with a 1,048,576-token context window, a conservative 32,768-token output/reserve budget, excellent long-context quality, prompt caching enabled, and all four Build role recommendations. This follows the repository's existing static metadata convention; OpenRouter does not publish a finite `max_completion_tokens` value for this model in its Models API.

Add OpenRouter pricing metadata at $3 per 1M input tokens, $15 per 1M output tokens, and $0.30 per 1M cached-input tokens, sourced from the OpenRouter Models API.

### Reasoning transport

Extend the OpenRouter reasoning mapper to accept the model id. For Kimi K3:

- `default` remains omitted so the provider's default is used.
- `low`, `medium`, `high`, and `max` all become `reasoning_effort: "max"`.
- `none` is omitted rather than sending the invalid upstream value `none`; K3 is always-on, so the UI's Off choice cannot disable reasoning until Kimi adds a supported off mode.

All other OpenRouter models retain their current mappings. The provider transport passes the model id into this mapper, ensuring Discussion, game calls, and other browser OpenRouter calls share the same behavior.

The same model check prevents the generic OpenRouter temperature field from being sent to K3; Kimi documents non-default temperature values as invalid.

### Tools and Build

Add Kimi K3 to the verified OpenRouter function-tool allowlist. This enables the existing OpenRouter native web-search and Build tool shaping paths without a new adapter. The native Build runner continues using the existing OpenAI-compatible OpenRouter transport and model catalog/runtime metadata; Kimi's upstream default reasoning remains `max` there.

### Error handling

Do not send unsupported Kimi-specific K2 `thinking` parameters. Do not add a provider-specific retry or fallback. If OpenRouter rejects a request, preserve the existing provider error handling and surface the upstream message.

## Testing

Add or extend focused provider tests to prove:

1. The catalog contains Kimi K3 with the expected id, capabilities, and display metadata.
2. Its context and pricing lookups return the Kimi-specific values.
3. Its tool capability is enabled while unknown OpenRouter models remain fail-closed.
4. Its reasoning mapping sends `max` for every enabled effort, omits `none` and `default`, and leaves existing OpenRouter mappings unchanged.
5. The OpenAI-compatible request body for Kimi K3 contains the model-specific reasoning field when an enabled effort is selected.

Run the focused provider tests, lint, and production build before handoff.
