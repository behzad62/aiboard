# Provider Capability & Tool Runtime — Design

**Status:** DRAFT FOR OWNER REVIEW (2026-09-29)

**Scope:** Replace AI Board's coarse provider-tool booleans with a durable capability/runtime architecture, migrate Meta Model API to Responses, and expose every provider-supported tool that AI Board can execute or configure correctly.

**Existing work preserved:** the uncommitted Meta provider, Gemini 3.8 Flash catalog entry, live model discovery, Copilot/NVIDIA model discovery, and OpenRouter tool work remain inputs to this design rather than being discarded.

---

## 1. Goal

A provider adding a new hosted tool must no longer require edits across the registry, web-search helper, build-tool flags, provider adapter, settings UI, and call sites.

The target system has one answer to four questions:

1. What capability exists for this provider/model?
2. Where does it execute: provider, AI Board, local runner, or external resource?
3. What transport and request shape does it require?
4. Are its prerequisites and combination constraints satisfied for this call?

The result must fail closed for unsupported combinations without hiding useful provider functionality.
## 2. Non-goals and invariants

- Do not pretend every provider exposes the same tools.
- Do not enable a tool merely because the SDK request schema accepts its field.
- Do not replace AI Board's local Build tools with a provider-hosted sandbox; those are different execution environments.
- Do not silently drop a **required** tool. Preflight must reject the call with an actionable reason.
- Optional tools may be omitted only with a recorded capability/constraint reason.
- Structured output, reasoning, attachments, caching, and token accounting remain first-class and must compose with tools where the provider permits it.
- Existing custom function tools remain supported.
- Provider/model capability discovery is evidence, not guesswork; unknown is fail-closed unless the user explicitly overrides a custom endpoint.

## 3. Core capability model

Replace `nativeWebSearch`, `nativeBuildTools`, and `hostedBuildTools` as the source of truth with typed capabilities.

```ts
type ToolCapabilityId =
  | "function_calling" | "web_search" | "web_fetch" | "file_search"
  | "url_context" | "maps" | "x_search" | "code_execution"
  | "shell" | "apply_patch" | "computer_use" | "browser_use"
  | "image_generation" | "remote_mcp" | "tool_search" | "advisor"
  | "subagent" | "fusion" | "datetime" | "memory";
```
Each capability descriptor carries more than yes/no:

```ts
interface ToolCapabilityDescriptor {
  id: ToolCapabilityId;
  support: "supported" | "conditional" | "unsupported" | "unknown";
  execution: "provider" | "client" | "runner" | "orchestrator";
  transports: ProviderTransportId[];
  prerequisites?: CapabilityPrerequisite[];
  constraints?: ToolCombinationConstraint[];
  supportSource: "provider-docs" | "provider-catalog" | "runner" | "user-override";
  verifiedAt?: string;
}
```

`conditional` means the provider can support the feature but the current deployment/model/account has not proven it yet. `unknown` means AI Board has no trustworthy support evidence. Neither state is treated as enabled until its prerequisite/probe or an explicit custom-endpoint override resolves it.

Execution location matters:

- **provider** — server tool; AI Board observes results but does not execute the operation.
- **client** — model returns a tool call; AI Board's broker executes it and returns a result.
- **runner** — the local account/provider runner executes or brokers it.
- **orchestrator** — AI Board itself composes higher-level behavior such as subagents.

This prevents a hosted code sandbox from being confused with local repository shell/edit tools.
## 4. Transport selection is explicit

Introduce a transport registry separate from capability support:

```ts
type ProviderTransportId =
  | "responses" | "chat_completions" | "messages"
  | "gemini_interactions" | "gemini_generate_content"
  | "copilot_sdk" | "runner_proxy";
```

A provider adapter declares an ordered set of transports. The call planner selects the richest transport that satisfies the requested capabilities and model constraints.

Examples:

- OpenAI: Responses first; Chat Completions only as compatibility fallback.
- Meta: Responses first and default; Chat Completions only for compatibility.
- xAI: Responses first.
- Anthropic / Anthropic-on-Foundry: Messages.
- Google: native Gemini APIs, preferring Interactions for modern multi-tool flows and falling back to Generate Content where appropriate.
- GitHub Copilot: Copilot SDK through the local runner.
- NVIDIA NIM: Responses when the deployment proves support for the needed call shape; Chat Completions fallback for ordinary function calling.

Transport selection must be observable in diagnostics and tests. No provider adapter should infer it from unrelated flags such as `structuredOutput`.
## 5. Call planning and compatibility

Replace ad-hoc booleans in `ChatParams` with normalized tool intent:

```ts
interface ToolIntent {
  id: ToolCapabilityId;
  requirement: "optional" | "required";
  parameters?: Record<string, unknown>;
}

interface ProviderCallPlan {
  transport: ProviderTransportId;
  enabledTools: ResolvedTool[];
  omittedOptionalTools: CapabilityDecision[];
}
```

`resolveProviderCallPlan()` combines provider baseline capabilities, model-specific rules, discovered metadata, runner-advertised capabilities, user configuration, resource availability, and call-level incompatibilities.

Rules:

- A required unsupported tool rejects before network I/O.
- An optional unsupported tool is omitted with a machine-readable reason.
- Provider-specific incompatibilities are data in the capability descriptor, not scattered `if` statements.
- Tool choice is normalized centrally, then translated by each transport (`auto`, required/any, named choice, parallel-call policy).
- Existing `webSearch`, `nativeTools`, `hostedTools`, and `hostedBuildTools` become a temporary compatibility bridge that produces `ToolIntent[]`; new code consumes the normalized form only.
## 6. Provider capability baselines (verified 2026-09-29)

These are provider-level baselines; model/deployment resolution can narrow them.

| Provider | Primary transport | Supported tool families AI Board should expose |
|---|---|---|
| OpenAI | Responses | function calling, web search, file search, remote MCP, tool search, shell/code execution, computer use, image generation; local/apply-patch style tools remain brokered where appropriate |
| Anthropic | Messages | functions, web search, web fetch, code execution, advisor, tool search, MCP connector; trained client schemas for bash, text editor, computer/browser when AI Board supplies execution |
| Azure Foundry (Anthropic) | Messages | Anthropic function tools; web search is conditional by deployment/hosting path and must be probed/fail closed |
| Google Gemini | native Gemini APIs | functions, Google Search, URL Context, File Search, Google Maps, code execution, computer use, remote MCP via Interactions |
| OpenRouter | Responses | functions plus server web search, web fetch, shell, apply patch, datetime, image generation, advisor, subagent, fusion, tool search and other advertised server tools |
| xAI | Responses | functions, web search, X search, code execution, collections/file search, remote MCP, image generation |
| Meta Model API | Responses | functions, web search/search grounding, tool search; Responses is the default because Chat Completions lacks the hosted tools |
| GitHub Copilot | Copilot SDK via runner | SDK custom tools plus Copilot first-party tools, MCP, tool search and SDK-managed agent capabilities subject to allow/deny policy |
| NVIDIA NIM | Responses/Chat Completions | OpenAI-format function calling where the deployed NIM/model enables tool parsing; no provider-hosted web/search tools are assumed |
| ChatGPT account | runner-advertised | only capabilities explicitly proven by the local account runner for the current account/backend |
| Custom OpenAI-compatible | user-declared | capabilities explicitly enabled by the user; default is conservative rather than assuming every compatible endpoint has tools |

## 7. Capability evidence and discovery

Capability resolution uses layered evidence in this order:

1. **Provider adapter manifest** — documented provider/tool baseline and transport requirements.
2. **Model/deployment rule** — known model restrictions such as Gemini 3-only combinations or Meta Muse Spark behavior.
3. **Provider catalog metadata** — when the provider actually reports supported parameters/tools (OpenRouter is the strongest current example).
4. **Runner handshake** — account-backed/local providers advertise the capabilities the runner version can really execute.
5. **Runtime prerequisite state** — configured stores, MCP endpoints, browser/computer driver, sandbox, runner connectivity, etc.
6. **Explicit custom-provider override** — only for user-owned/custom endpoints.

Do not infer tool support from model naming when authoritative metadata exists. Naming rules are fallback evidence and should carry a source/verification date.

Add a runner endpoint such as `/providers/:id/capabilities` returning runner version, transports, model/tool support, and required local features. ChatGPT-account and Copilot behavior then evolve with the runner without hard-coding browser-app assumptions.

Provider model discovery and tool discovery remain separate concerns: a provider can list a model without reporting its tools. The settings UI must distinguish **model discovered** from **tool support verified**.

Negative capability probes may be cached with the exact provider/model/transport and an expiry, but a transient network/auth error must never be recorded as permanent unsupported capability.
## 8. Resource-backed tools

Some tools are supported by a model but unusable until AI Board supplies a resource. Model support and runtime readiness are separate states.

Examples:

- OpenAI file search requires configured vector stores/files.
- Gemini File Search requires a File Search store.
- xAI collections search requires configured collections.
- Remote MCP requires one or more approved MCP server definitions/authentication.
- Computer use requires an AI Board-controlled browser/desktop executor and screenshot/action loop.
- Client-side bash/text-editor schemas require a constrained local executor.

Settings should show these as **Supported — setup required**, not as unavailable and not as silently enabled.

Resource references belong in a separate tool-resource configuration object, never embedded into provider capability declarations. This keeps provider manifests stable when the user's stores, MCP servers, or execution environments change.

Provider-hosted execution (`code_execution`, hosted shell) is deliberately distinct from local Build execution. A hosted sandbox may be useful for analysis, calculations, or generated artifacts, but it cannot satisfy a Build requirement that must inspect/edit/test the user's repository unless the repository has explicitly been supplied to that environment.
## 9. Normalize provider tool events, not only tool calls

`StreamChunk` currently models text, usage, errors, local `tool_call`, and done. That is insufficient for hosted search, code execution, images, citations, MCP, and computer-use events.

Add a normalized provider-tool event channel:

```ts
interface ProviderToolEvent {
  id?: string;
  tool: ToolCapabilityId;
  phase: "started" | "progress" | "completed" | "failed";
  providerManaged: boolean;
  summary?: string;
  citations?: CitationRef[];
  artifacts?: GeneratedArtifactRef[];
  rawType?: string;
}
```

Client function calls continue to emit `tool_call` because AI Board must execute them. Provider-managed calls emit `provider_tool_event`; they must never be handed to the local tool broker.

Generated binary outputs such as xAI/OpenAI image generation become artifact references rather than huge base64 blobs passed through UI state. Provider adapters persist/hand off the bytes through the existing artifact layer and stream a lightweight reference.

Search/fetch tools preserve provider citation metadata. Text rendering may remain unchanged initially, but the normalized event must not discard URLs, titles, source spans, or provider annotations needed for future citation UI.
## 10. Combination constraints are explicit

Today several adapters disable all tools whenever structured output is enabled. That is safe but unnecessarily coarse and will age badly.

Represent constraints such as:

```ts
interface ToolCombinationConstraint {
  when: "structured_output" | "reasoning" | "attachments" | "parallel_tools" | "tool_choice";
  effect: "forbid" | "requires_transport" | "requires_tool_choice";
  value?: string;
  reason: string;
}
```

Examples:

- Meta `tool_search` + JSON-schema structured output is forbidden; ordinary function tools are a separate question and must not inherit that prohibition accidentally.
- Google Gemini 3 built-in + custom tool combinations require the supported native combination mode; older models may have narrower combinations.
- Provider APIs may restrict named/required `tool_choice`; Meta Responses and Chat Completions accept only automatic `tool_choice` for function tools; model this as an unconditional `tool_choice` constraint.
- Anthropic server tools and client tools can coexist, but server-tool pause/continuation semantics must be handled correctly.

The call planner produces an explainable decision before the provider adapter serializes the request.
## 11. Tool inventory and deferred loading

Native function definitions and provider-hosted tools share one logical inventory but retain different execution types.

For large custom/MCP tool sets, add a provider-neutral deferred-loading policy:

- Tools can be marked `deferLoading: true` and optionally grouped by namespace.
- If the selected transport supports native `tool_search`, use it (OpenAI, Meta, OpenRouter, Anthropic, and Copilot SDK where available).
- If the provider lacks native tool search, AI Board may use an orchestrator-side selector before the model call rather than loading hundreds of schemas blindly.
- The existing OpenRouter threshold becomes a generic policy setting, not an OpenRouter-only algorithm.
- Core safety/lifecycle tools may explicitly opt out of deferral.

The logical tool name remains stable across providers. Provider adapters only translate schema shape, namespacing, deferred-loading syntax, and tool-choice semantics.

MCP has two valid execution modes:

1. **Provider-hosted remote MCP** when the provider supports it and the configured server/auth can be safely delegated.
2. **AI Board client MCP** where MCP tools become ordinary client function tools and execute through AI Board's broker.

The planner selects one mode; the same MCP tool must not be exposed twice in one call.
## 12. Mode policy: availability is not automatic use

A capability being supported means AI Board can offer it; it does not mean every request should enable it.

- **Discussion:** web/search/fetch may be enabled when the user allows current-information access; hosted code execution/image generation/computer use are opt-in by task need.
- **Build:** AI Board local repository tools remain the authoritative shell/edit/test path. Provider-hosted code/shell is not a substitute for repository access.
- **Benchmarks/tests:** tool policy is explicit per case so provider comparisons do not accidentally test different capabilities.
- **Structured-output calls:** only tool combinations explicitly permitted by the selected provider/model remain enabled.

A resolved call should carry a `toolPolicyTrace` in debug diagnostics containing requested tools, resolved tools, omitted tools, transport, and reasons. Do not put this verbose trace into normal chat output or persistent evidence unless requested; it is diagnostic state, not journaling.

## 13. Settings UX

Provider settings should show a capability table resolved for the selected model:

- Available now
- Supported — setup required
- Conditional / not yet verified
- Unsupported

Resource-backed tools link to their required configuration (file store, MCP, computer driver, etc.). User-added models inherit no guessed capabilities; the UI can refresh provider evidence or allow an explicit override only for custom endpoints.
## 14. Migration strategy

The architecture should land as a coherent replacement, not as permanent dual systems.

1. Add the capability types, manifests, call planner, transport registry, and normalized provider-tool events.
2. Add a compatibility adapter from existing `ChatParams` tool fields into `ToolIntent[]` so current callers keep working during the migration.
3. Move every provider adapter to consume a `ProviderCallPlan` rather than reading coarse registry booleans directly.
4. Migrate Meta to Responses and implement its hosted web search + tool search on the new path.
5. Expand OpenAI, xAI, Anthropic, Google, OpenRouter, Copilot, NVIDIA, Foundry, ChatGPT-account, and custom-provider manifests/adapters against the same contracts.
6. Add runner capability handshake and resource readiness resolution.
7. Update settings/model capability UI.
8. Remove the old coarse feature flags and compatibility bridge once every caller uses the new contract.

The end state must have exactly one source of truth for tool support. Do not leave `MODEL_TOOL_SUPPORT` and the new capability manifests both authoritative.

## 15. Testing strategy

Use contract tests rather than provider-specific happy-path-only tests:

- capability resolution snapshots per provider/model/transport;
- required-tool preflight rejection tests;
- optional-tool omission + reason tests;
- request serialization tests for every supported tool family;
- streaming/event normalization tests for hosted and client tools;
- tool-choice and parallel-call translation tests;
- structured-output/tool incompatibility tests;
- resource-readiness tests;
- runner capability handshake/version tests;
- regression tests proving Build local tools are not replaced by provider-hosted sandboxes.
Live-provider tests are opt-in and credential-gated; CI correctness must not depend on paid API access. Mocked protocol fixtures cover normal CI, and a small documented live suite verifies that provider docs and real behavior have not drifted.

## 16. Definition of done

This redesign is complete only when all of the following are true:

- Meta uses Responses by default and can use its native web search and tool search.
- Every provider has one capability manifest with execution location, transport, prerequisites, constraints, and evidence source.
- All currently documented provider-native tool families listed in section 6 are representable; resource-backed ones report setup-required rather than disappearing.
- Function tools still work across all providers/transports that support them.
- Provider-hosted tool events, citations, and generated artifacts are not lost in streaming normalization.
- Large tool inventories can use native deferred/tool-search mechanisms where available.
- Account-backed providers obtain capability truth from a versioned runner handshake.
- Custom endpoints are conservative by default and user-overridable.
- The old `nativeWebSearch` / `nativeBuildTools` / `hostedBuildTools` support matrix is no longer authoritative.
- Targeted provider contract tests, TypeScript, lint, and `git diff --check` pass.
- Existing OpenRouter richer behavior and the already-added model discovery remain intact.

## 17. Explicitly rejected approaches

- Add Meta web search as another special case in `openai-compat.ts`.
- Keep three booleans and grow provider/model regex lists indefinitely.
- Treat every server-side execution tool as equivalent to AI Board's local Build tools.
- Enable all tools from provider name alone without model/deployment/resource resolution.
- Force all providers through OpenAI Chat Completions for API uniformity.
- Silently remove tools whenever structured output is requested instead of modeling real compatibility.
## 18. Authoritative references used for the baseline

Verified 2026-09-29; implementation should re-check current provider docs when serializing exact tool versions/shapes.

- OpenAI tools / Responses: https://developers.openai.com/api/docs/guides/tools
- Anthropic tool reference: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference
- Anthropic web search: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool
- Anthropic code execution: https://platform.claude.com/docs/en/agents-and-tools/tool-use/code-execution-tool
- Meta protocol choice: https://dev.meta.ai/docs/protocols
- Meta function calling: https://dev.meta.ai/docs/cookbook/tool-function-calling
- Meta tool search: https://dev.meta.ai/docs/tool-search
- Google Gemini 3.8 Flash capabilities: https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash/
- Google tool combinations: https://ai.google.dev/gemini-api/docs/tool-combination
- Google function calling / Remote MCP: https://ai.google.dev/gemini-api/docs/function-calling
- xAI tool usage: https://docs.x.ai/developers/tools/tool-usage-details
- xAI image generation tool: https://docs.x.ai/developers/tools/image-generation
- OpenRouter server tools: https://openrouter.ai/tools
- GitHub Copilot SDK: https://github.com/github/copilot-sdk
- NVIDIA NIM tool calling: https://docs.nvidia.com/nim/large-language-models/latest/advanced-use-cases/tool-calling-and-mcp.html
- NVIDIA NIM API endpoints: https://docs.nvidia.com/nim/large-language-models/latest/thinking-budget-control.html

---

**Owner decision requested:** approve this written design as the implementation source, then produce the implementation plan against it.