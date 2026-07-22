# Gemini 3.6 Flash Provider Support Design

## Goal

Add production-ready Google Gemini API support for the stable model ID
`gemini-3.6-flash` without replacing Gemini 3.5 Flash or rewriting historical
saved selections.

## Verified model contract

Google's model and pricing documentation, last updated July 21, 2026, defines:

- Model ID: `gemini-3.6-flash` (stable and generally available).
- Inputs: text, image, PDF, audio, and video; output: text.
- Context: 1,048,576 input tokens and 65,536 output tokens.
- Standard paid pricing per million tokens: $1.50 input, $0.15 cached input,
  and $7.50 output including thinking tokens.
- Supported features: caching, thinking, structured output, function calling,
  Google Search grounding, code execution, and computer use (preview).
- GenerateContent compatibility: omit deprecated sampling parameters and use
  string thinking levels `MEDIUM` or `HIGH`.

Primary sources:

- https://ai.google.dev/gemini-api/docs/models/gemini-3.6-flash
- https://ai.google.dev/gemini-api/docs/latest-model
- https://ai.google.dev/gemini-api/docs/pricing

## Architecture

Follow the existing Google model path. Add Gemini 3.6 Flash to the catalog,
pricing registry, context registry, and capability policies. Keep Gemini 3.5
Flash available and make 3.6 the validation candidate by catalog ordering.

The existing `@google/genai` GenerateContent streaming transport remains in
place. A small exported request-compatibility helper omits `temperature` for
Gemini 3.6 Flash and future models covered by Google's new parameter policy.
Reasoning routing special-cases 3.6 Flash so low/none/medium resolve to
`MEDIUM`, while high/max resolve to `HIGH`; default omits the field and uses
the model's documented medium default.

## Persistence and history

No saved-selection migration is performed. Gemini 3.5 Flash remains a valid,
distinct model, and historical selections and benchmark evidence retain their
original IDs.

## Testing

Add a focused script that proves catalog identity, pricing, context,
capabilities, provider policies, thinking-level mapping, web-search support,
and sampling omission. Extend existing registry, reasoning, context, and web
search suites. Run lint, the full Runner V2 regression suite, and a production
build before completion.

