# Provider Capability & Tool Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` in this ChatGPT session (no subagent-dispatch primitive is exposed here). If this plan is later executed in an environment with subagent dispatch, `superpowers:subagent-driven-development` is preferred for the provider-specific tasks. Execute task-by-task, follow TDD, keep the spec authoritative, and do not pause between approved tasks except for destructive/security/external side effects.

**Goal:** Replace AI Board's coarse provider tool flags with one evidence-backed capability/runtime architecture that selects explicit transports, rejects impossible calls before provider network I/O, preserves provider-native tools/events/citations/artifacts, and keeps the already-completed model-discovery work intact.

**Architecture:** Introduce provider-neutral capability/transport contracts, provider manifests, layered capability evidence, a pure `resolveProviderCallPlan()` preflight planner, resource-readiness state, provider-neutral deferred tool loading, normalized provider-tool events, and a versioned runner capability handshake. Migrate every provider and every caller to that contract, then delete the old coarse matrices/compatibility bridge so there is exactly one tool-support source of truth.

**Tech stack:** Next.js/React/TypeScript; OpenAI SDK `^6.45.0`; Anthropic SDK `^0.110.0`; Google GenAI SDK `^2.10.0` (installed SDK exposes `GoogleGenAI.interactions`); GitHub Copilot SDK `1.0.6`; local account-provider runner (`.mjs`); script-style tests via `tsx`/`node:assert`; npm lint/typecheck commands.

**Spec:** `docs/superpowers/specs/2026-09-29-provider-capability-tool-runtime-design.md` (approved design, commit `b96a1e78`)

## Global constraints

- Do not redesign the approved architecture. If implementation evidence proves a concrete contradiction, record the exact contradiction and apply only the smallest necessary spec amendment.
- Preserve all current uncommitted provider/model-discovery work. Never reset/clean it away.
- Never modify, stage, delete, copy into the implementation worktree, or commit `.claude/settings.json`.
- Do not push or create a PR unless the owner explicitly asks.
- Use TDD for product changes: RED test, verify intended failure, GREEN minimal implementation, targeted regression, then commit.
- During implementation use impact-based targeted tests. Do not run the full suite after every small task. Run the broader relevant suite only at integrated acceptance.
- CI correctness must not require paid provider credentials. Normal tests use mocked protocol fixtures; live-provider verification is opt-in and credential-gated.
- Provider-hosted `code_execution`/`shell` never counts as local Build repository shell/edit/test authority unless repository context was explicitly supplied to that hosted environment.
- Model discovery and tool-capability evidence are separate. Never turn “model listed by provider” into guessed tool support.
- Runtime diagnostics may carry a `toolPolicyTrace`, but this is debug state, not persistent journaling/evidence by default.

## Target contracts (keep these names stable across tasks)

Create the canonical contracts in `lib/providers/tool-capabilities.ts` and use them everywhere by the end of the migration:

```ts
export type ToolCapabilityId =
  | "function_calling" | "web_search" | "web_fetch" | "file_search"
  | "url_context" | "maps" | "x_search" | "code_execution"
  | "shell" | "apply_patch" | "computer_use" | "browser_use"
  | "image_generation" | "remote_mcp" | "tool_search" | "advisor"
  | "subagent" | "fusion" | "datetime" | "memory";

export type ProviderTransportId =
  | "responses" | "chat_completions" | "messages"
  | "gemini_interactions" | "gemini_generate_content"
  | "copilot_sdk" | "runner_proxy";

export type ToolSupportStatus = "supported" | "conditional" | "unsupported" | "unknown";
export type ToolExecutionLocation = "provider" | "client" | "runner" | "orchestrator";

export interface ToolCapabilityDescriptor {
  id: ToolCapabilityId;
  support: ToolSupportStatus;
  execution: ToolExecutionLocation;
  transports: ProviderTransportId[];
  prerequisites?: CapabilityPrerequisite[];
  constraints?: ToolCombinationConstraint[];
  supportSource: "provider-docs" | "provider-catalog" | "runner" | "user-override";
  verifiedAt?: string;
}

export interface ToolIntent {
  id: ToolCapabilityId;
  requirement: "optional" | "required";
  parameters?: Record<string, unknown>;
}

export interface ProviderCallPlan {
  transport: ProviderTransportId;
  enabledTools: ResolvedTool[];
  omittedOptionalTools: CapabilityDecision[];
  toolPolicyTrace: ToolPolicyTrace;
}
```

Supporting contracts in the same module (or a narrowly named sibling when they become too large):

- `ProviderCapabilityManifest`: provider id, ordered transports, capability descriptors, model/deployment refinements, transport constraints.
- `CapabilityEvidence`: exact provider/model/transport/source/verified date; catalog/probe evidence must never be upgraded silently to provider-doc evidence.
- `CapabilityPrerequisite`: stable id plus display/configuration metadata; resource readiness is supplied separately.
- `ToolResourceConfig` / `ToolResourceState`: configured stores, collections, MCP servers, client computer/browser/shell/editor executors; resource ids live here, not in provider manifests.
- `ToolCombinationConstraint`: `when`, `effect`, `value`, `reason`, scoped to exact capability/transport/model rule.
- `ProviderCallFeatures`: structured output, reasoning, tool choice, parallel-tool policy, attachment/input context used by planner constraints.
- `CapabilityDecision`: machine-readable code (`unsupported`, `unknown`, `conditional_unverified`, `missing_prerequisite`, `transport_incompatible`, `combination_forbidden`, `duplicate_mcp_path`, etc.) plus capability/transport/reason/evidence.
- `ProviderCallPlanError`: contains all rejected required-capability decisions and is thrown before provider I/O.
- `ProviderRuntimeContext`: discovered evidence, runner handshake, custom overrides, resource state, and current call features supplied to `resolveProviderCallPlan()`.

Normalize streaming in `lib/providers/provider-events.ts`:

```ts
export interface CitationRef { url?: string; title?: string; sourceSpan?: unknown; providerData?: unknown }
export interface GeneratedArtifactRef { id: string; mimeType?: string; filename?: string; size?: number; storageRef: string }
export interface ProviderToolEvent {
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

`StreamChunk` gains `type: "provider_tool_event"` and `providerToolEvent`; client `tool_call` remains reserved for calls AI Board must execute.

Runner handshake contract in `lib/providers/runner-capabilities.ts`:

```ts
export const RUNNER_CAPABILITY_SCHEMA_VERSION = 1;
export interface RunnerCapabilityHandshake {
  schemaVersion: 1;
  runnerVersion: number;
  providerId: "chatgpt" | "github-copilot" | "nvidia";
  transports: ProviderTransportId[];
  capabilities: ToolCapabilityDescriptor[];
  models?: RunnerModelCapabilityRecord[];
  execution?: RunnerExecutionCapability[];
  prerequisites?: CapabilityPrerequisite[];
}
```

The browser validates this payload before using it. Unknown future schema versions fail closed/conditional rather than being treated as supported.

---

### Task 0: Preserve the existing provider work and create the isolated implementation worktree

**Files:**
- Preserve exactly the current modified/untracked provider files already present on `main`.
- Copy into implementation worktree: `docs/superpowers/plans/2026-09-29-provider-capability-tool-runtime.md`.
- Explicit exclusion: `.claude/settings.json`.

**Steps:**

- [ ] Re-run `git status --short --branch`, `git diff --name-status`, `git ls-files --others --exclude-standard`, `git rev-parse --git-dir`, and `git rev-parse --git-common-dir`; confirm `main` still contains the pre-existing provider diff and `.claude/settings.json` is unrelated/untracked.
- [ ] Save a binary-safe patch of tracked changes to a temporary path outside the repo and record the exact provider-related untracked files to copy. The untracked allow-list is `lib/providers/meta.ts`, the four provider/model-discovery tests currently present, plus this plan file; never include `.claude/settings.json`.
- [ ] Create `.worktrees/provider-capability-tool-runtime` from `b96a1e78` on branch `feat/provider-capability-tool-runtime`; `.worktrees` is already present and ignored.
- [ ] Apply the tracked patch into the new worktree and copy only the allow-listed untracked provider/plan files. `docs/superpowers/` is intentionally ignored by `.gitignore`, so do **not** change ignore rules; when creating the Task 0 safety-baseline commit, force-add only this plan path with `git add -f docs/superpowers/plans/2026-09-29-provider-capability-tool-runtime.md`.
- [ ] Compare `git diff --stat`, `git diff --name-status`, and hashes/content of copied untracked provider files between source checkout and worktree. Confirm the source checkout remains unchanged.
- [ ] Run the existing targeted provider/model-discovery tests that cover the inherited changes before adding new architecture. Expected baseline includes `scripts/test-provider-model-discovery.mts`, `scripts/test-meta-provider.mts`, `scripts/test-copilot-model-discovery.mts`, `scripts/test-xai-model-discovery.mts`, `scripts/test-account-provider-runner-nvidia.mts`, and the current OpenRouter/provider-registry tests.
- [ ] Commit only the inherited provider/model-discovery changes and the approved implementation plan as a safety baseline in the isolated branch. Do not include `.claude/settings.json` or unrelated files.

**Commit:** `chore: checkpoint provider discovery work before capability runtime`

---

### Task 1: Add the canonical capability, transport, readiness, and decision contracts

**Files:**
- Create: `lib/providers/tool-capabilities.ts`
- Create: `lib/providers/transport-registry.ts`
- Test: `scripts/test-provider-capability-contracts.mts`
- Modify: `lib/providers/base.ts` only to import/re-export normalized request/event-facing types needed by `AIProvider`; do not migrate callers yet.

**Interfaces/behavior:**
- Add every capability/transport id from the approved spec.
- Represent support, execution location, prerequisites, constraints, evidence/source/date, call features, resource state, decisions, resolved tools, plan trace, and `ProviderCallPlanError`.
- Transport registry exposes ordered transport metadata without capability assumptions.
- No coarse provider matrix is deleted yet; this task creates the new target contract only.

**TDD steps:**

- [ ] Write `test-provider-capability-contracts.mts` asserting the full capability id set, full transport id set, descriptor validation, prerequisite/readiness distinction, and deterministic transport ordering.
- [ ] Run the new test and verify failure because the modules/contracts do not exist.
- [ ] Implement the types plus small runtime validators/constants used by tests; keep this module provider-neutral.
- [ ] Run the new test; then run `npx tsc --noEmit` for compile coverage.
- [ ] Run `git diff --check` and commit.

**Commit:** `feat: define provider capability and transport contracts`

---

### Task 2: Add one manifest per provider and layered capability evidence resolution

**Files:**
- Create: `lib/providers/capability-manifests.ts`
- Create: `lib/providers/capability-resolution.ts`
- Modify: `lib/providers/provider-registry.ts` to expose identity/config metadata only; do not let it remain a second tool-support truth source.
- Test: `scripts/test-provider-capability-resolution.mts`
- Update as needed: `scripts/test-provider-registry.mts`

**Interfaces/behavior:**
- Define exactly one manifest for OpenAI, Anthropic, Google, OpenRouter, xAI, Meta, GitHub Copilot, NVIDIA, Foundry, ChatGPT account, and Custom.
- Baselines match design Section 6 and include ordered transports, execution location, prerequisites, constraints, `supportSource`, and verification date `2026-09-29` where the baseline is documentation-derived.
- Foundry narrows Anthropic semantics by deployment, not by pretending all Foundry deployments have the same tools.
- NVIDIA tool support starts conditional/model-deployment-aware; no hosted search assumptions.
- ChatGPT account and Copilot baseline tool truth is conditional until runner evidence arrives.
- Custom baseline is conservative: unknown/unsupported until explicit user override/probe evidence.
- `mergeCapabilityEvidence()` applies precedence: manifest -> model/deployment rule -> provider catalog -> runner handshake -> resource state -> custom override, without converting transient probe/auth/network failures into permanent unsupported.

**TDD steps:**

- [ ] Write snapshot-like assertions for all provider manifests and precedence cases, including a catalog narrowing a baseline, runner evidence overriding browser guesses for account providers, and custom user override only on `custom`.
- [ ] Run and verify failures.
- [ ] Implement manifests and pure evidence merge/refinement functions.
- [ ] Update provider-registry tests so provider identity/config remains tested while new tests own tool truth.
- [ ] Run both targeted tests, `npx tsc --noEmit`, and `git diff --check`.
- [ ] Commit.

**Commit:** `feat: add provider capability manifests and evidence resolution`

---

### Task 3: Implement `resolveProviderCallPlan()` with preflight rejection, readiness, constraints, and tool-policy trace

**Files:**
- Create: `lib/providers/call-planner.ts`
- Test: `scripts/test-provider-call-planner.mts`
- Modify: `lib/providers/structured-output.ts` to expose structured-output call features/constraints rather than globally suppressing tools.

**Interfaces/behavior:**
- Pure resolver combines provider manifest, model/deployment evidence, discovered metadata, runner handshake, resource state, custom overrides, requested `ToolIntent[]`, structured-output/reasoning/tool-choice/parallel/attachment features, and incompatibility constraints.
- Select richest compatible transport from manifest order.
- Required unsupported/unknown/unready/incompatible capability throws `ProviderCallPlanError` before adapter/network I/O.
- Optional unavailable capability is omitted with a stable machine-readable reason.
- Supported-but-missing-resource resolves to `setup_required` for UI/status and rejects/omits only according to required/optional intent.
- Normalize `toolChoice` centrally (`auto`, required/any, named tool) plus parallel policy; transport adapters translate it later.
- Planner records requested/resolved/omitted/transport/reasons in `toolPolicyTrace` but does not persist that trace by default.
- Explicitly test: structured output does not globally disable unrelated function tools; exact forbidden combinations still reject/omit.
- Explicitly test MCP dedupe: one logical MCP source chooses provider-hosted or client-brokered execution, never both.

**TDD steps:**

- [ ] Add RED tests for transport selection, required preflight rejection with a fake provider whose fetch function would otherwise throw if invoked, optional omission/reason, resource readiness, structured-output combinations, reasoning/tool-choice constraints, parallel tools, and MCP dedupe.
- [ ] Verify failures.
- [ ] Implement resolver and error/trace helpers; keep it pure/no network.
- [ ] Run planner tests and existing structured-output tests.
- [ ] Run `npx tsc --noEmit` and `git diff --check`.
- [ ] Commit.

**Commit:** `feat: resolve provider calls from capabilities and constraints`

---

### Task 4: Generalize tool inventory, namespaces, deferred loading, and tool search

**Files:**
- Create: `lib/providers/tool-inventory.ts`
- Modify later-consumed helper: `lib/providers/openrouter-tools.ts` (keep provider serialization here, move policy out)
- Test: `scripts/test-provider-tool-loading.mts`
- Update: `scripts/test-openrouter-capability-upgrades.mts`

**Interfaces/behavior:**
- Introduce provider-neutral logical tool entries for client function tools, provider-hosted tools, and MCP tools with execution location, namespace, `deferLoading`, safety/lifecycle opt-out, and stable logical name.
- Move the current OpenRouter threshold behavior into a generic policy (preserve current threshold as default unless spec evidence requires a different value).
- Use native `tool_search` when the selected plan/transport supports it; otherwise return an orchestrator preselection decision instead of blindly sending hundreds of schemas.
- Preserve per-provider serializers: OpenRouter/OpenAI/Meta/Anthropic/Copilot may encode deferred/tool-search differently, but selection policy is shared.
- Ensure MCP tools cannot be surfaced both as provider-hosted MCP and client function tools in one call.

**TDD steps:**

- [ ] Write RED tests for below/above-threshold inventory, explicit `deferLoading: false`, namespace grouping, lifecycle opt-out, native tool-search selection, orchestrator fallback, and MCP dedupe.
- [ ] Verify failures.
- [ ] Implement generic inventory policy and adapt OpenRouter tests to prove behavior is preserved.
- [ ] Run new test plus `test-openrouter-capability-upgrades.mts` and `test-openrouter-responses.mts`.
- [ ] Commit after typecheck/diff-check.

**Commit:** `feat: generalize deferred tool inventory policy`

---

### Task 5: Normalize provider-hosted events, citations, and binary artifacts without feeding them to the local tool broker

**Files:**
- Create: `lib/providers/provider-events.ts`
- Create: `lib/client/provider-artifacts.ts`
- Modify: `lib/providers/base.ts`
- Modify: `lib/client/storage-adapter.ts` to provide a binary artifact storage primitive for IndexedDB and filesystem backends instead of placing provider-generated base64 in the JSON/UI state.
- Modify: `lib/client/engine.ts` collection helpers to retain normalized provider events separately from client `tool_call`.
- Test: `scripts/test-provider-tool-events.mts`
- Test: `scripts/test-provider-artifacts.mts`

**Interfaces/behavior:**
- Add `provider_tool_event` to `StreamChunk`; provider-managed events never pass through `nativeToolCallsToActionText()` or the Build function broker.
- Preserve citation URL/title/source-span/provider annotations in `CitationRef`.
- Provider-generated binary outputs are handed to an injected artifact sink; stream/UI receives only `GeneratedArtifactRef` metadata/storage reference.
- Store artifact bytes outside ordinary `ClientStore` JSON; support both current storage backends.
- Keep artifact sink optional for calls that cannot generate binary artifacts.

**TDD steps:**

- [ ] RED: event normalization keeps provider/client execution distinct; citations survive; provider-managed event never becomes a local action.
- [ ] RED: persisting a synthetic binary payload stores bytes outside serialized main store and emits only a lightweight ref; verify both storage adapter implementations through fakes/targeted browser-storage abstraction tests without paid APIs.
- [ ] Implement event types/helpers, artifact sink/storage primitives, and collection plumbing.
- [ ] Run new tests plus existing engine/native-tool tests and typecheck.
- [ ] Commit.

**Commit:** `feat: normalize hosted provider events and artifact refs`

---

### Task 6: Add the temporary legacy-ChatParams-to-tool-intent bridge and move engine preflight before provider I/O

**Files:**
- Create: `lib/providers/legacy-tool-intents.ts`
- Modify: `lib/providers/base.ts`
- Modify: `lib/client/engine.ts`
- Modify: `lib/client/native-build-engine.ts`
- Modify: `lib/client/legacy-build-engine.benchmark.ts` only where it remains an active benchmark call path.
- Modify: `lib/providers/web-search.ts` to become policy/intention mapping only; remove its structured-output global suppression.
- Update: `scripts/test-provider-web-search.mts`
- Update: `scripts/test-provider-native-tools.mts`
- Test: `scripts/test-provider-call-preflight.mts`

**Interfaces/behavior:**
- Existing `webSearch`, `nativeTools`, `hostedTools`, `hostedBuildTools` are accepted only by this temporary bridge and converted immediately to `ToolIntent[]` + logical tool inventory.
- New engine path resolves a `ProviderCallPlan` before invoking `provider.streamChat()`.
- `ChatParams` gains normalized plan/tool inventory fields; adapters are migrated in later tasks.
- Build requests local function tools as client-executed `function_calling`/shell/edit semantics; provider-hosted `code_execution` or shell remains separate and cannot satisfy repository access.
- Web-search policy is mode/user intent; support is determined by planner, not `providerSupportsNativeWebSearchFeature()`.

**TDD steps:**

- [ ] Write RED tests proving required unsupported capability fails before a fake provider network call, optional capability is omitted, legacy fields map deterministically, and Build local tools are not replaced by provider-hosted execution.
- [ ] Verify failure.
- [ ] Implement compatibility bridge and engine preflight.
- [ ] Update old web-search/native-tool tests from registry-boolean expectations to intent/plan expectations.
- [ ] Run targeted engine/provider tests and typecheck.
- [ ] Commit.

**Commit:** `refactor: preflight provider calls through capability planner`

---

### Task 7: Migrate OpenAI to Responses-first capability plans and full applicable native tool surface

**Files:**
- Modify: `lib/providers/openai.ts`
- Modify: `lib/providers/catalog.ts` only to stop static `api` hints from being authoritative transport selection; retain model metadata needed for compatibility rules.
- Modify: `lib/providers/structured-output.ts`
- Test: `scripts/test-openai-tool-runtime.mts`
- Update: `scripts/test-provider-native-tools.mts`
- Update: `scripts/test-structured-output.mts`

**Interfaces/behavior:**
- Adapter dispatches on `params.callPlan.transport`, with Responses preferred for modern models and Chat Completions only when the planner selects a legitimate compatibility fallback.
- Serialize applicable OpenAI function calling, web search, file search, remote MCP, tool search, shell/code-execution capability, computer use, and image generation using current Responses SDK types.
- Resource-backed tools only serialize when planner says ready; vector-store/MCP/computer executor ids/config come from resource configuration, not manifest.
- Translate normalized tool choice/parallel policy per Responses/Chat semantics.
- Normalize hosted search/MCP/code/image/computer events, citations, and artifacts into `provider_tool_event`; function calls remain `tool_call`.
- Remove blanket “structured output means no tools”; obey planner constraints.

**TDD steps:**

- [ ] Build mocked Responses stream fixtures for each supported tool family and Chat fallback; write RED serialization/event tests.
- [ ] Verify failures without API credentials.
- [ ] Implement planner-driven transport/serialization and normalization.
- [ ] Run OpenAI test, structured-output test, provider-native-tools test, and typecheck.
- [ ] Commit.

**Commit:** `feat: route OpenAI tools through Responses call plans`

---

### Task 8: Move Meta Model API to Responses by default with native search/tool search and no `openai-compat.ts` special cases

**Files:**
- Modify: `lib/providers/meta.ts`
- Modify: `lib/providers/openai-compat.ts` to remove Meta-specific reasoning/tool/structured-output branches; leave generic compatibility behavior only.
- Modify: `lib/providers/provider-registry.ts` only if Meta identity/config text remains there.
- Modify: `components/ApiKeyForm.tsx` copy that still calls Meta “OpenAI-compatible” where misleading.
- Update: `scripts/test-meta-provider.mts`
- Create: `scripts/test-meta-tool-runtime.mts`

**Interfaces/behavior:**
- Meta default transport is `responses`; `chat_completions` exists only as explicit planner-selected fallback.
- Support/serialize documented function calling, native web search/search grounding, tool search, reasoning, permitted structured-output combinations, and multimodal input per manifest/model rules.
- Enforce Meta-specific tool-search + JSON-schema or tool-choice constraints in manifest/planner data, not scattered conditionals in `openai-compat.ts`.
- Model discovery remains Muse Spark filtered but no longer marks tools/structured/reasoning as verified merely because the model was listed.
- Normalize Meta hosted events/citations as provider-managed events.

**TDD steps:**

- [ ] Update model-discovery test first so it rejects guessed tool capability claims; verify current code fails.
- [ ] Add mocked Meta Responses fixtures proving endpoint/transport, web search, tool search, function calls, structured-output permitted/forbidden combinations, and event normalization; verify RED.
- [ ] Implement Meta Responses adapter and remove Meta special cases from `openai-compat.ts`.
- [ ] Run Meta tests, generic OpenAI-compat/custom tests, provider discovery tests, and typecheck.
- [ ] Commit.

**Commit:** `feat: move Meta Model API to Responses runtime`

---

### Task 9: Expand Anthropic Messages runtime and Foundry-Anthropic behavior on the shared contracts

**Files:**
- Modify: `lib/providers/anthropic.ts`
- Modify: `lib/providers/foundry.ts`
- Test: `scripts/test-anthropic-tool-runtime.mts`
- Update: `scripts/test-provider-native-tools.mts`
- Update: `scripts/test-structured-output.mts`

**Interfaces/behavior:**
- Messages remains native transport.
- Serialize applicable client function tools, server web search, web fetch, code execution, tool search, advisor, MCP connector, and trained client schemas for bash/editor/computer/browser only when an AI Board executor prerequisite is ready.
- Implement server-tool pause/continuation semantics and event normalization; provider-managed server tools never reach local function broker.
- Tool choice and parallel behavior translate from normalized plan.
- Structured-output compatibility is constraint-driven, not blanket tool removal.
- Foundry inherits Anthropic Messages serialization for Anthropic-compatible deployments; deployment-specific hosted features stay conditional/probed and fail closed.

**TDD steps:**

- [ ] Add RED request fixtures for every represented Anthropic family plus pause/continuation and mixed server/client tool events; add Foundry conditional-support case.
- [ ] Implement serialization/continuation/event normalization.
- [ ] Run Anthropic/Foundry targeted tests, native-tools, structured-output, and typecheck.
- [ ] Commit.

**Commit:** `feat: expand Anthropic and Foundry tool runtime`

---

### Task 10: Move Google to native Interactions-first planning and model computer use as a client execution loop

**Files:**
- Modify: `lib/providers/google.ts`
- Create: `lib/providers/google-interactions.ts` if needed to keep `google.ts` readable and isolate Interactions request/event translation.
- Create: `lib/providers/client-execution.ts` for executor capability contracts only (no desktop executor implementation in this change).
- Test: `scripts/test-google-tool-runtime.mts`
- Update: `scripts/test-provider-native-tools.mts`
- Update: `scripts/test-provider-model-discovery.mts`

**Interfaces/behavior:**
- Use `GoogleGenAI.interactions` for modern multi-tool flows selected as `gemini_interactions`; use `gemini_generate_content` only where planner/model constraints choose it.
- Serialize function calling, Google Search, URL Context, File Search, Google Maps, code execution, Remote MCP, and computer use.
- Computer use descriptor: `support=supported` for applicable Gemini 3.x model rules, `execution=client`, transport `gemini_interactions`, prerequisite `computer_executor`; without an executor UI resolves `Supported — setup required`.
- Define future-proof executor contract covering browser/desktop/mobile environment kinds, screenshot input, model UI actions, executor result/next screenshot. Do not interpret Google as remotely controlling the user's PC and do not build an executor in this task.
- Hosted Google tools emit provider events; returned computer actions emit client `tool_call`/client-execution event routed to the executor contract, not provider-managed event.
- Provider model listing remains independent from these tool rules.

**TDD steps:**

- [ ] Add RED fixtures for Interactions selection, Search/URL/File/Maps/code/MCP serialization, no-executor readiness, computer action loop handoff, and Generate Content fallback.
- [ ] Verify failures.
- [ ] Implement Interactions adapter and client-execution contracts using the installed `@google/genai` surface.
- [ ] Run Google tests, provider discovery regression, native-tool tests, and typecheck.
- [ ] Commit.

**Commit:** `feat: add Gemini Interactions tool runtime`

---

### Task 11: Expand xAI Responses runtime to its native tool families

**Files:**
- Modify: `lib/providers/xai.ts`
- Update: `scripts/test-xai-model-discovery.mts`
- Create: `scripts/test-xai-tool-runtime.mts`

**Interfaces/behavior:**
- Responses is primary transport.
- Serialize applicable function calls, web search, X search, code execution, collections/file search, remote MCP, and image generation from the call plan.
- Collection/file search and MCP require configured resources; model listing alone never marks them ready.
- Preserve provider citations/source metadata and image/generated artifact refs.
- Stop inferring broad tool support solely from model id naming when `/v1/language-models` did not report it; naming fallback evidence, if still needed, is explicitly marked fallback with date/source.

**TDD steps:**

- [ ] First tighten discovery test to separate model listing from verified tools; confirm current inference fails that test.
- [ ] Add mocked Responses serialization/event tests for all xAI tool families and readiness failures.
- [ ] Implement and run xAI tests + typecheck.
- [ ] Commit.

**Commit:** `feat: expand xAI Responses tool runtime`

---

### Task 12: Preserve OpenRouter's richer behavior while moving policy to provider-neutral contracts

**Files:**
- Modify: `lib/providers/openrouter.ts`
- Modify: `lib/providers/openrouter-tools.ts`
- Modify: `lib/client/providers.ts`
- Modify: `lib/client/settings-api.ts` where OpenRouter discovery evidence is mapped.
- Update: `scripts/test-openrouter-responses.mts`
- Update: `scripts/test-openrouter-capability-upgrades.mts`
- Update: `scripts/test-provider-web-search.mts`

**Interfaces/behavior:**
- Keep function tools, web search, web fetch, shell, apply patch, datetime, image generation, advisor, subagent, fusion, tool search, model-supported parameters/tools, Responses-first behavior, and legitimate Chat fallback.
- Convert `supported_parameters`/reported tools into provider-catalog evidence, not ad-hoc engine booleans.
- Use generic `tool-inventory.ts` for deferred selection; `openrouter-tools.ts` only translates provider-specific schema/tool names.
- Preserve attachment fallbacks and known compatibility behavior through explicit planner/model/transport constraints rather than hidden branch logic where possible.
- Normalize hosted events/citations/artifacts through shared provider-event contract.

**TDD steps:**

- [ ] Strengthen current OpenRouter tests first to capture all existing richer behavior before refactor.
- [ ] Add RED assertions that generic inventory policy—not OpenRouter-only threshold code—drives deferred loading, and catalog evidence affects planner decisions.
- [ ] Refactor adapter/serializers and discovery mapping.
- [ ] Run all OpenRouter tests plus planner/tool-loading/provider-web-search regressions and typecheck.
- [ ] Commit.

**Commit:** `refactor: move OpenRouter tools onto shared capability runtime`

---

### Task 13: Add the versioned local-runner capability handshake

**Files:**
- Create: `lib/providers/runner-capabilities.ts`
- Modify: `lib/account-provider-runner.mjs`
- Modify: `lib/account-provider-copilot-sdk.mjs`
- Modify: `lib/providers/account-runner.ts`
- Create: `scripts/test-account-provider-runner-capabilities.mts`
- Update: `scripts/test-account-provider-copilot-sdk.mts`
- Update: `scripts/test-account-runner-streaming-tools.mts`

**Interfaces/behavior:**
- Add `/providers/:id/capabilities` to runner route handling for `chatgpt`, `github-copilot`, and `nvidia`.
- Return schema version, runner version, supported transports, tool capabilities, model-specific capability records when actually known, runner execution abilities, and prerequisites.
- Browser validates `schemaVersion`; unsupported versions fail closed/conditional and never become guessed support.
- ChatGPT handshake advertises only behaviors the account runner actually implements for the current backend; never copy OpenAI API manifest wholesale.
- Copilot handshake derives model information from `listModels()` and runner/SDK functionality actually wired by the installed SDK. Advertise custom tools, built-in tools, MCP/tool-search/deferred capabilities only when the installed runner/SDK surface supports and the runner enables them; otherwise omit/conditional.
- NVIDIA handshake advertises runner proxy and deployment/model-aware OpenAI-format function support; no hosted search claims. Allow API-key/model probe data where needed without recording transient auth/network failures as permanent unsupported.

**TDD steps:**

- [ ] Write RED endpoint/schema/version tests using fake runner backends and a fake Copilot SDK `listModels()` result.
- [ ] Add RED browser validation tests for unknown schema version, stale runner, and conditional model support.
- [ ] Implement endpoint and browser fetch/validation.
- [ ] Run capability handshake tests plus existing account-runner/Copilot/NVIDIA tests.
- [ ] Commit.

**Commit:** `feat: advertise account runner capabilities by versioned handshake`

---

### Task 14: Make ChatGPT account, GitHub Copilot, and NVIDIA planning consume runner truth

**Files:**
- Modify: `lib/providers/account-runner.ts`
- Modify: `lib/providers/chatgpt.ts`
- Modify: `lib/providers/github-copilot.ts`
- Modify: `lib/providers/nvidia.ts`
- Modify: `lib/client/providers.ts`
- Update: `scripts/test-account-provider-runner-chat.mts`
- Update: `scripts/test-account-provider-runner-copilot-chat.mts`
- Update: `scripts/test-account-provider-runner-nvidia.mts`
- Update: `scripts/test-copilot-model-discovery.mts`

**Interfaces/behavior:**
- Runtime context fetches/caches the validated runner handshake for account-backed providers and passes it into planner evidence.
- Browser-side provider manifests remain conditional baselines; they do not overrule current runner truth.
- Copilot SDK tool/MCP/tool-search capabilities are serialized only if handshake says available for installed runner/SDK/model.
- ChatGPT account is not treated as OpenAI API entitlement/capability.
- NVIDIA transport is selected according to handshake/deployment support (`responses` when proven, otherwise `chat_completions`/runner proxy as appropriate).

**TDD steps:**

- [ ] Add RED tests where the same browser build sees different runner handshakes and therefore selects/omits tools/transports differently.
- [ ] Implement handshake consumption/cache invalidation by runner/schema version.
- [ ] Run all account-runner/Copilot/NVIDIA targeted tests plus planner tests.
- [ ] Commit.

**Commit:** `feat: resolve account providers from runner capability truth`

---

### Task 15: Make custom OpenAI-compatible endpoints conservative and explicitly user-overridable

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/client/settings-api.ts`
- Modify: `lib/client/providers.ts`
- Modify: `lib/providers/custom.ts`
- Modify: `components/CustomModelsManager.tsx`
- Create: `scripts/test-custom-provider-capabilities.mts`
- Update: existing custom model/settings tests if present.

**Interfaces/behavior:**
- Extend `CustomModel` with explicit tool capability overrides and optional declared compatible transports; default remains conservative (no guessed OpenAI tool surface).
- Keep existing input-media capability toggles unchanged.
- UI allows explicit per-tool override for the custom endpoint with clear wording that the user is declaring endpoint support.
- Planner accepts `user-override` evidence only for custom endpoints and records it as such.
- Connection test remains a connection/model test; it must not silently set every tool to supported.

**TDD steps:**

- [ ] RED: new custom endpoint has no function/web/etc support without override; explicit function override enables only function calling; declared Responses transport can be chosen only if compatible with requested tools.
- [ ] RED: non-custom provider cannot inject `user-override` evidence through this path.
- [ ] Implement schema/settings/UI/provider changes.
- [ ] Run custom tests, settings tests, planner tests, and typecheck.
- [ ] Commit.

**Commit:** `feat: add conservative custom provider capability overrides`

---

### Task 16: Separate model discovery, capability probes, and verified tool evidence in persistence

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/client/settings-api.ts`
- Modify: `lib/client/capability-api.ts`
- Modify: `lib/providers/capability-probes.ts`
- Modify: `lib/client/model-selection-migration.ts` or create `lib/client/provider-capability-migration.ts` if keeping concerns separate is clearer.
- Modify: `lib/client/providers.ts`
- Update: `scripts/test-provider-model-discovery.mts`
- Update: `scripts/test-meta-provider.mts`
- Update: `scripts/test-xai-model-discovery.mts`
- Update: `scripts/test-copilot-model-discovery.mts`
- Create: `scripts/test-provider-capability-discovery.mts`

**Interfaces/behavior:**
- Replace the ambiguous `discoveredModelCapabilities` tool booleans as authoritative runtime evidence with two concepts:
  1. model discovery/input/API-parameter metadata;
  2. tool capability evidence keyed by provider/model/transport/source/date.
- Preserve existing saved model ids and live browsing from OpenRouter, OpenAI, Anthropic, Google, xAI, Meta, Copilot, NVIDIA.
- Migrate persisted legacy records conservatively: input modality data is retained; OpenRouter `supported_parameters` can become provider-catalog evidence where it genuinely reports the feature; generic provider-list guesses do not become verified tool evidence.
- Extend probe representation so a successful real function-call probe can provide temporary `probed` evidence with exact provider/model/transport/expiry; auth/network/transient errors are not persisted as unsupported. Keep current Build capability lab semantics working.
- Avoid guessing Meta/xAI/Gemini tool capability from model listing alone.

**TDD steps:**

- [ ] RED migration tests using saved legacy `discoveredModelCapabilities` records from OpenRouter and generic provider discovery; assert only trustworthy evidence survives as tool truth.
- [ ] RED probe tests for positive support, genuine protocol-level unsupported, and transient auth/network failure.
- [ ] Implement storage/migration/probe/evidence adapters.
- [ ] Run all discovery/probe/model-selection regression tests and typecheck.
- [ ] Commit.

**Commit:** `refactor: separate model discovery from tool capability evidence`

---

### Task 17: Add resolved capability/readiness UI without conflating discovery and readiness

**Files:**
- Create: `components/ProviderCapabilityTable.tsx`
- Create: `lib/providers/capability-status.ts`
- Modify: `components/ApiKeyForm.tsx`
- Modify: `components/CustomModelsManager.tsx` only to reuse status/override presentation created in Task 15.
- Modify: `lib/client/settings-api.ts` to provide resolved capability view models and resource configuration/readiness hooks.
- Modify: `lib/db/schema.ts` only for resource configuration fields that do not already have a home.
- Test: `scripts/test-provider-capability-status.mts`

**Interfaces/behavior:**
- Four statuses exactly: `Available now`, `Supported — setup required`, `Conditional / not yet verified`, `Unsupported`.
- Selected model resolves capability table from planner/evidence plus resource readiness, not catalog listing badges.
- Model discovery UI remains model browsing; tool support verification is a separate section/concept.
- Resource-backed rows show the missing prerequisite and link/route to configuration where a configuration surface already exists; for future computer executor show setup-required explanatory text rather than a fake configuration toggle.
- Do not add guessed capability badges to newly discovered/user-added models.

**TDD steps:**

- [ ] RED pure status/view-model tests for all four states, resource prerequisites, unknown runner schema, custom override, and model-discovered/tool-unverified separation.
- [ ] Implement pure status mapper first, then component rendering.
- [ ] Run status tests, settings/discovery tests, `npx tsc --noEmit`, and `npm run lint` for the touched UI path.
- [ ] Commit.

**Commit:** `feat: show resolved provider capability readiness in settings`

---

### Task 18: Remove legacy coarse support truth and finish migration of every caller

**Files:**
- Modify: `lib/providers/provider-registry.ts`
- Modify/delete as appropriate: `lib/providers/web-search.ts`
- Modify: `lib/providers/base.ts`
- Modify: `lib/client/engine.ts`
- Modify: `lib/client/native-build-engine.ts`
- Modify: `lib/client/legacy-build-engine.benchmark.ts`
- Modify: `lib/client/capability-api.ts`
- Modify: `lib/client/providers.ts`
- Modify all provider adapters still reading legacy fields.
- Delete: `lib/providers/legacy-tool-intents.ts` after all call sites are normalized.
- Update: `scripts/test-provider-registry.mts`
- Update: `scripts/test-provider-web-search.mts`
- Update: `scripts/test-provider-native-tools.mts`
- Create: `scripts/test-provider-legacy-removal.mts`

**Interfaces/behavior:**
- Delete `MODEL_TOOL_SUPPORT` and authoritative `nativeWebSearch`, `nativeBuildTools`, `hostedBuildTools` feature helpers/matrices.
- Remove legacy `ChatParams.webSearch`, `hostedTools`, `hostedBuildTools`, and legacy support booleans once every caller supplies normalized intents/inventory/call plan. If `nativeTools` remains as a name for concrete function definitions, rename it to `functionTools` so it cannot be confused with capability truth.
- Catalog/static `api` hints may remain only as non-authoritative compatibility metadata if still required; transport selection must come from planner.
- Search repo for legacy symbols and assert zero production references except intentional historical docs/tests.
- Build mode regression proves local repository shell/edit/test remains the authoritative execution path even when provider manifest supports hosted code/shell.

**TDD steps:**

- [ ] Write `test-provider-legacy-removal.mts` to fail while legacy exported symbols/old request fields still exist; include a source scan limited to production TS/TSX/MJS paths.
- [ ] Migrate remaining callers one at a time, running their targeted tests after each small edit.
- [ ] Delete compatibility bridge and old support matrix/helpers.
- [ ] Run legacy-removal, planner, Build/native tools, web-search, structured-output, all provider-runtime tests, and typecheck.
- [ ] Commit.

**Commit:** `refactor: remove legacy provider tool support matrix`

---

### Task 19: Regenerate runner downloads and verify packaging after runner/runtime changes

**Files:**
- Modify generated: `public/account-provider-runner.mjs` if tracked/generated by publish script.
- Modify generated: `public/aiboard-account-provider-runner.zip`
- Modify only if needed: `scripts/publish-downloads.mjs`
- Update: `scripts/test-workbench-runner-bundle.tsx` or the existing runner-bundle/package test that validates public artifacts.
- Re-run: all runner capability/account provider tests.

**TDD/verification steps:**

- [ ] Add/strengthen package test first so the published runner contains the capability endpoint, current `VERSION`, capability schema version, Copilot capability helper, and NVIDIA/ChatGPT handlers.
- [ ] Verify it fails against stale generated downloads.
- [ ] Run the repository's publish/download script to regenerate from source; never hand-edit the ZIP.
- [ ] Run runner-bundle test and all account-provider runner tests.
- [ ] Compare source/public generated runner hashes/content expectations and `git diff --check`.
- [ ] Commit only the generated runner artifacts/script/test changes.

**Commit:** `build: publish capability-aware account provider runner`

---

### Task 20: Add a credential-free provider-runtime regression command and opt-in live drift suite

**Files:**
- Modify: `package.json`
- Create: `scripts/test-provider-runtime.mts` only if an aggregator is cleaner than a long npm command; otherwise add an npm script invoking the individual tests.
- Create: `scripts/test-provider-runtime-live.mts`
- Create: `docs/provider-capability-live-tests.md`

**Interfaces/behavior:**
- `test:provider-runtime` runs mocked/fixture contract tests for capability resolution, planner, tool loading, events/artifacts, provider serializers, runner handshake, discovery separation, custom overrides, UI status, Build isolation, and legacy removal. No paid credentials.
- `test:provider-runtime:live` is opt-in and checks only configured providers/credentials; skipped providers report skip rather than failing CI.
- Live suite records provider/model/transport and verifies a small drift-sensitive subset; it never writes discovered support from transient auth/network failures as permanent unsupported.

**TDD steps:**

- [ ] Add npm commands and verify credential-free runtime suite is runnable on a clean environment.
- [ ] Add live harness with explicit env/key gating and document exact commands/provider variables.
- [ ] Run credential-free suite. Run live suite only for credentials already intentionally available in the environment; do not require or request paid keys for completion.
- [ ] Commit.

**Commit:** `test: add provider capability runtime regression suites`

---

### Task 21: Final integrated acceptance and independent whole-deliverable review

**Files:** no product changes unless the review finds a defect; any fix must repeat RED/GREEN targeted validation before the final acceptance rerun.

**Validation sequence:**

- [ ] Re-read the authoritative spec, especially Sections 3–16, and compare the final branch against every Definition-of-Done bullet.
- [ ] Run `git status --short --branch`; verify `.claude/settings.json` is absent from the implementation worktree/commits and there are no unrelated files.
- [ ] Run `git diff --check`.
- [ ] Run `npx tsc --noEmit`.
- [ ] Run `npm run lint`.
- [ ] Run `npm run test:provider-runtime` (credential-free provider contract suite).
- [ ] Run relevant existing regression scripts not already included by the aggregator: model selection/capability lab, Build/native tool routing, OpenRouter, account runner, structured output, attachment/input serialization, and provider/model discovery.
- [ ] Run the broader appropriate existing suite once at integrated acceptance (not repeatedly during earlier tasks); record exact command and result.
- [ ] Source-scan for `nativeWebSearch`, `nativeBuildTools`, `hostedBuildTools`, `MODEL_TOOL_SUPPORT`, legacy `ChatParams.webSearch`, and old OpenRouter-only deferred policy. Every remaining match must be historical docs/test fixtures or justified non-authoritative compatibility metadata; product truth must be the manifest/planner path.
- [ ] Source-scan each capability id and every provider manifest to verify all Section 6 tool families are representable even when setup-required/conditional.
- [ ] Verify provider-hosted tool events never enter the local function broker and citations/artifact refs survive normalized streams.
- [ ] Verify ChatGPT/Copilot/NVIDIA capability decisions use the versioned runner handshake.
- [ ] Verify custom endpoints are conservative by default and explicit overrides work.
- [ ] Verify current model browsing/user-added model support still works for OpenRouter, OpenAI, Anthropic, Google, xAI, Meta, Copilot, and NVIDIA.
- [ ] Perform an independent whole-branch review against the original spec, not only the task checklist. Findings must cite exact spec section + file/line + test gap. Fix all load-bearing findings and rerun affected tests plus final acceptance commands.
- [ ] Use `superpowers:verification-before-completion` before making any completion claim.
- [ ] Do **not** push or create a PR. Stop with the local branch complete and report commits/tests/review findings to the owner.

---

## Spec coverage self-review matrix

| Approved spec section | Plan coverage |
|---|---|
| 3. Core capability model | Tasks 1–3, 18 |
| 4. Explicit transport selection | Tasks 1, 3, provider Tasks 7–14, 18 |
| 5. Call planning/compatibility | Tasks 3, 6, 18 |
| 6. Provider baselines | Task 2 + provider Tasks 7–15 |
| 7. Evidence/discovery/runner truth | Tasks 2, 13–16 |
| 8. Resource-backed tools/readiness | Tasks 1–3, 7–11, 17 |
| 9. Hosted events/citations/artifacts | Task 5 + provider Tasks 7–12 |
| 10. Explicit combination constraints | Tasks 2–3 + provider serializers |
| 11. Deferred loading/tool search/MCP dedupe | Task 4 + OpenRouter/Meta/OpenAI/Anthropic/Copilot tasks |
| 12. Mode policy / Build isolation | Tasks 3, 6, 18, 21 |
| 13. Settings UX | Tasks 15–17 |
| 14. Coherent migration / one source of truth | Tasks 6, 18, 21 |
| 15. Testing strategy | Every product task uses RED/GREEN; Tasks 20–21 integrate |
| 16. Definition of done | Task 21 explicitly re-verifies every bullet |

## Plan self-review findings

- **No architecture contradiction found.** The installed Google SDK already exposes the Interactions API and relevant modern tool types, so the approved Google design can be implemented without changing architecture.
- **Existing capability probe infrastructure is reusable but not authoritative today.** Task 16 converts successful probes into scoped/expiring evidence without treating transient failures as permanent unsupported.
- **Binary artifact handling needs an explicit client storage seam.** Existing client state stores ordinary attachment base64 in JSON, which does not satisfy the new generated-artifact requirement. Task 5 extends the existing storage adapter rather than reusing benchmark-only artifact records or inventing a second app-wide state store.
- **The existing uncommitted provider work can be isolated safely.** `.worktrees` exists and is ignored; Task 0 copies a controlled patch/allow-list into a new worktree and leaves the dirty `main` checkout untouched.
- **No permanent dual system is planned.** Tasks 6–17 use a temporary bridge only; Task 18 deletes the bridge and coarse tool matrices before final acceptance.
- **Provider breadth is complete.** OpenAI, Meta, Anthropic, Foundry, Google, xAI, OpenRouter, ChatGPT account, Copilot, NVIDIA, and custom are each assigned explicit implementation/test tasks; the plan does not stop after Meta.
- **Existing discovery work is protected.** Discovery-specific tests remain in the task graph and final acceptance explicitly rechecks all eight intended live discovery providers plus user-added models.
