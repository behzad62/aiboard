# GPT-5.6 Provider Support Design

## Objective

Replace AI Board's non-official OpenAI GPT-5.6 model entries with the official GPT-5.6 Sol, Terra, and Luna identifiers, expose the same verified models through the ChatGPT account provider, and migrate saved selections so existing configurations remain usable.

## Scope

This change covers the browser model catalog, OpenAI API provider, ChatGPT account provider, model pricing, context metadata, capability and runtime policies, persisted model references, and focused registry tests. It does not change the account-provider transport protocol or add models to GitHub Copilot.

## Model Catalog

Both `openai` and `chatgpt` expose these model IDs in this order:

1. `gpt-5.6-sol` — flagship model for complex professional work.
2. `gpt-5.6-terra` — balanced capability and cost.
3. `gpt-5.6-luna` — cost-sensitive, high-volume model.

All three accept text and image input and produce text output. In AI Board's capability schema they support image and document inputs, but not audio or video. The OpenAI entries use the normal OpenAI API transport. The ChatGPT entries use the existing local account-provider runner without transport changes; live runner v16 probes confirmed all three explicit IDs and rejected `gpt-5.6`, `gpt-5.6-pro`, and `gpt-5.6-mini`.

The following non-official OpenAI catalog entries are removed:

- `gpt-5.6`
- `gpt-5.6-pro`
- `gpt-5.6-mini`

Luna becomes the OpenAI validation candidate because it is the lowest-cost GPT-5.6 family member. ChatGPT account validation remains governed by the existing account connection flow.

## Saved-Selection Migration

Persisted model references are migrated by provider and exact model ID:

| Provider | Previous ID | Replacement ID | Reason |
| --- | --- | --- | --- |
| OpenAI | `gpt-5.6` | `gpt-5.6-terra` | Preserves the prior entry's Terra-tier pricing and intent. |
| OpenAI | `gpt-5.6-pro` | `gpt-5.6-sol` | Preserves the prior highest-capability tier. |
| OpenAI | `gpt-5.6-mini` | `gpt-5.6-luna` | Preserves the prior lowest-cost tier. |

Add a pure, provider-aware model-ID migration module. It exposes one function for full IDs such as `openai:gpt-5.6-pro` and one function for provider-scoped raw IDs such as the OpenAI `ProviderKey.defaultModel`. Both functions are idempotent and leave ChatGPT, other providers, unknown OpenAI IDs, and already-current IDs unchanged.

Apply the migration at persisted selection read boundaries:

- `UserSettings.judgeModelId`.
- OpenAI `ProviderKey.defaultModel`.
- `UserSettings.modelPricingOverrides` and `modelContextOverrides` keys, preserving user overrides under the replacement full ID.
- `Discussion.modelIds`, `judgeModelId`, and `reviewerModelId`, including discussion records loaded from split discussion storage.
- Active saved game-session AI participant `modelId` values.
- The benchmark Run-tab model checklist stored in local storage.

When both a legacy and replacement override key exist, keep the explicitly current replacement entry and discard the migrated duplicate. Schedule persistence when store hydration changes any value so both IndexedDB and folder-backed stores are upgraded durably. Newly saved values always use official IDs.

Do not rewrite historical messages, final results, benchmark team compositions, benchmark attempts, benchmark traces, model statistics, completed game-match records, usage ledgers, or already-created Runner V2 run state. Those records describe what was actually selected or reported at the time. New Runner V2 configurations derive from the migrated discussion selection. Do not retain hidden catalog aliases or send legacy identifiers to a provider.

## Pricing and Context Metadata

OpenAI API pricing uses the currently documented standard token rates, verified on 2026-07-22:

| Model | Input / 1M | Cached input / 1M | Output / 1M |
| --- | ---: | ---: | ---: |
| Sol | $5.00 | $0.50 | $30.00 |
| Terra | $2.50 | $0.25 | $15.00 |
| Luna | $1.00 | $0.10 | $6.00 |

The pricing source is `https://developers.openai.com/api/docs/pricing`. ChatGPT account usage is subscription- and allowance-based, so ChatGPT entries must not be represented as API-billed usage. Where AI Board needs cost estimates for cross-provider comparison or Build projections, reuse the equivalent OpenAI token rates with an explicit note that they are reference estimates rather than ChatGPT billing.

All six provider/model pairs use:

- Context window: 1,050,000 tokens.
- Maximum output: 128,000 tokens.
- Build output reserve: 128,000 tokens.
- Effective Build input ceiling: 922,000 tokens.
- Long-context quality: `excellent`.
- Prompt caching metadata: enabled for OpenAI; account-provider dependent for ChatGPT while retaining the existing context-profile boolean expected by budgeting code.

All three models are eligible for every Build role unless an existing provider-wide restriction is stricter.

## Runtime Capabilities

The existing OpenAI and ChatGPT provider policies should recognize all three IDs consistently:

- Reasoning effort is supported.
- The app's `max` reasoning selection is sent as native `max` for GPT-5.6 Sol, Terra, and Luna. Older OpenAI and ChatGPT GPT models retain the existing `max` to `xhigh` compatibility mapping.
- Streaming and structured output remain supported through each provider's existing transport.
- Function tool calls remain supported.
- Provider-native web search is enabled.
- OpenAI uses its existing max-token behavior.
- ChatGPT continues omitting max-token caps because the account backend rejects `max_output_tokens`.
- ChatGPT does not gain provider-hosted local shell tools or native Build tools; Runner V2 continues supplying its own native tool loop.

No new special-case transport branch is required because both transports already forward the selected model string.

## Error Handling

Legacy IDs must be normalized before provider invocation. If an unknown model ID is encountered, existing provider-default context and error behavior remains unchanged. The migration must not silently map the public `gpt-5.6` alias to Sol because AI Board's removed `gpt-5.6` entry previously represented Terra-tier behavior and pricing.

ChatGPT availability remains account-dependent. A model rejected because of plan, rollout, workspace policy, or allowance should surface the runner's existing provider error without fallback to a different GPT-5.6 family member.

## Testing and Verification

Focused tests must establish:

1. OpenAI and ChatGPT catalogs contain Sol, Terra, and Luna in the intended order.
2. The removed OpenAI IDs are absent from both providers' catalogs.
3. Saved OpenAI selections migrate according to the exact mapping and migration is idempotent.
4. Other providers and unknown OpenAI model IDs are unchanged.
5. Each OpenAI model has the documented pricing and source date.
6. Each OpenAI and ChatGPT model resolves to the documented context and Build budget.
7. Reasoning and hosted web-search policy checks recognize all six provider/model pairs.
8. Both transports send native `max` reasoning for GPT-5.6 while retaining `xhigh` for older GPT models.
9. ChatGPT still rejects max-token forwarding and native Build tools at the provider-policy layer.
10. Existing registry, model-context, account-runner, Runner V2, lint, and production build checks pass.

Implementation follows test-driven development: update focused tests to fail on the current catalog first, implement the smallest registry and migration changes, and then run the complete relevant verification suite.

## Acceptance Criteria

- Users can select GPT-5.6 Sol, Terra, or Luna with either an OpenAI API key or an eligible ChatGPT account.
- AI Board sends the exact official identifier selected by the user.
- Existing OpenAI GPT-5.6 selections load as their corresponding official family member.
- Prices, context budgets, capabilities, reasoning, and web-search behavior match the design above.
- No legacy GPT-5.6 alias remains selectable or is sent to either provider.
