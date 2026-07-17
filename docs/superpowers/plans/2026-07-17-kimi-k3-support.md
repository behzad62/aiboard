# Kimi K3 OpenRouter Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `moonshotai/kimi-k3` as a fully integrated OpenRouter model across catalog selection, Discussion, games, native Build, tools, reasoning, context budgeting, and pricing.

**Architecture:** Extend the existing static `MODEL_CATALOG` and model metadata registries. Keep the shared OpenRouter-compatible browser transport, adding only model-aware reasoning and temperature guards. Reuse the verified OpenRouter function-tool allowlist so native web search and Build tools flow through the existing adapters.

**Tech Stack:** Strict TypeScript, Next.js static export, OpenAI-compatible browser transport, `tsx` provider regression scripts, ESLint, and Next production build.

## Global Constraints

- Use model id `moonshotai/kimi-k3` and provider id `openrouter`.
- Kimi K3 accepts only `reasoning_effort: "max"`; map `low`, `medium`, `high`, and `max` to `max`, omit `default`, and omit `none` because K3 is always-on.
- Omit the generic temperature field for Kimi K3; Kimi fixes temperature at `1.0`.
- Advertise text and image input only; document, audio, and video input remain false.
- Use a 1,048,576-token context profile, 32,768-token output/reserve budget, excellent long-context quality, prompt caching, and all Build role recommendations.
- Use OpenRouter pricing of $3 input, $15 output, and $0.30 cached input per 1M tokens.
- Preserve fail-closed tool support for unknown OpenRouter models and preserve all existing mappings for other models.
- Do not modify legacy Build engines or add a new provider adapter.

---

### Task 1: Add failing Kimi K3 provider regression coverage

**Files:**
- Create: `scripts/test-kimi-k3-support.mts`
- Modify: `package.json` (add the focused script to `test:benchmark:unit`)

**Interfaces:**
- Consumes the existing `MODEL_CATALOG`, `resolveModelContextProfile`, `getModelPricing`, provider capability helpers, `openRouterReasoningEffort`, and `streamOpenAICompatibleChat`.
- Produces executable regression checks for every Kimi K3 contract that later implementation tasks must satisfy.

- [ ] **Step 1: Write the failing test**

Create a script with a `check(name, ok, detail)` helper and assertions for the catalog entry, capabilities, context profile, pricing, native web search, native Build tools, and an unknown-model fail-closed case. The core metadata assertions should be:

```typescript
const kimi = MODEL_CATALOG.find(
  (model) => model.providerId === "openrouter" && model.id === "moonshotai/kimi-k3"
);
check("Kimi K3 is in the catalog", kimi !== undefined, kimi);
check(
  "Kimi K3 advertises text and image input only",
  kimi?.capabilities.image === true &&
    kimi?.capabilities.document === false &&
    kimi?.capabilities.audio === false &&
    kimi?.capabilities.video === false,
  kimi?.capabilities
);

const context = resolveModelContextProfile("moonshotai/kimi-k3", "openrouter");
check(
  "Kimi K3 uses a 1M context profile",
  context.contextWindowTokens === 1_048_576 &&
    context.maxOutputTokens === 32_768 &&
    context.buildOutputReserveTokens === 32_768 &&
    context.longContextQuality === "excellent" &&
    context.promptCaching === true,
  context
);

const pricing = getModelPricing("openrouter:moonshotai/kimi-k3");
check(
  "Kimi K3 pricing is registered",
  pricing?.inputUsdPer1M === 3 &&
    pricing.outputUsdPer1M === 15 &&
    pricing.cachedInputUsdPer1M === 0.3,
  pricing
);
```

Cast the imported mapper to the future optional-model signature so the red phase fails on current behavior rather than on a TypeScript arity error:

```typescript
const mapOpenRouterReasoning = openRouterReasoningEffort as unknown as (
  effort: ReasoningEffort,
  model?: string
) => string | null;
for (const effort of ["low", "medium", "high", "max"] as const) {
  check(
    `Kimi K3 maps ${effort} to max`,
    mapOpenRouterReasoning(effort, "moonshotai/kimi-k3") === "max",
    mapOpenRouterReasoning(effort, "moonshotai/kimi-k3")
  );
}
check(
  "Kimi K3 omits unsupported off and default reasoning controls",
  mapOpenRouterReasoning("none", "moonshotai/kimi-k3") === null &&
    mapOpenRouterReasoning("default", "moonshotai/kimi-k3") === null,
  {
    none: mapOpenRouterReasoning("none", "moonshotai/kimi-k3"),
    default: mapOpenRouterReasoning("default", "moonshotai/kimi-k3"),
  }
);
```

For transport coverage, pass a fake OpenAI client whose `chat.completions.create` captures the request and returns an empty async generator. Call `streamOpenAICompatibleChat` with Kimi K3, `reasoningEffort: "high"`, and `temperature: 0.2`, exhaust the generator, and assert `captured.reasoning_effort === "max"` and that `temperature` is absent. Finish with `process.exit(failures === 0 ? 0 : 1)` and add `tsx scripts/test-kimi-k3-support.mts` to `test:benchmark:unit`.

- [ ] **Step 2: Run the focused test to verify it fails**

Run `npx tsx scripts/test-kimi-k3-support.mts`.

Expected: exit 1 with failures for the missing catalog, context, pricing, tool allowlist, model-specific reasoning mapping, and request shaping.

- [ ] **Step 3: Commit the red test**

```powershell
git add scripts/test-kimi-k3-support.mts package.json
git commit -m "test: define Kimi K3 OpenRouter support"
```

### Task 2: Register Kimi K3 catalog, context, and pricing metadata

**Files:**
- Modify: `lib/providers/catalog.ts` in the OpenRouter catalog section
- Modify: `lib/providers/model-context.ts` in `MODEL_CONTEXT_PROFILES`
- Modify: `lib/providers/pricing.ts` in `MODEL_PRICING`

**Interfaces:** Produces the catalog model consumed by selectors and providers, the context profile consumed by Build budgeting, and pricing consumed by usage/cost views.

- [ ] **Step 1: Add the catalog entry**

Insert alongside the existing OpenRouter models:

```typescript
{
  id: "moonshotai/kimi-k3",
  name: "Kimi K3",
  providerId: "openrouter",
  description:
    "MoonshotAI multimodal reasoning model for coding, knowledge work, and long-horizon agentic workflows (1M context)",
  capabilities: { image: true, document: false, audio: false, video: false },
},
```

- [ ] **Step 2: Add the context profile**

```typescript
"openrouter:moonshotai/kimi-k3": {
  contextWindowTokens: 1_048_576,
  maxOutputTokens: 32_768,
  buildOutputReserveTokens: 32_768,
  longContextQuality: "excellent",
  promptCaching: true,
  recommendedBuildRoles: [...ALL_BUILD_ROLES],
},
```

- [ ] **Step 3: Add pricing**

```typescript
[formatModelId("openrouter", "moonshotai/kimi-k3")]: {
  inputUsdPer1M: 3,
  cachedInputUsdPer1M: 0.3,
  outputUsdPer1M: 15,
  sourceLabel: "OpenRouter model pricing",
  sourceUrl: "https://openrouter.ai/moonshotai/kimi-k3",
  verifiedAt: "2026-07-17",
},
```

- [ ] **Step 4: Run the focused test**

Run `npx tsx scripts/test-kimi-k3-support.mts`. Expected: catalog, context, and pricing checks pass while routing checks remain red.

- [ ] **Step 5: Commit metadata**

```powershell
git add lib/providers/catalog.ts lib/providers/model-context.ts lib/providers/pricing.ts
git commit -m "feat: register Kimi K3 metadata"
```

### Task 3: Add Kimi K3 reasoning, temperature, and tool routing

**Files:**
- Modify: `lib/providers/reasoning.ts`
- Modify: `lib/providers/openai-compat.ts`
- Modify: `lib/providers/provider-registry.ts`

**Interfaces:** Extend `openRouterReasoningEffort(effort, model?)` while preserving the one-argument API. Pass `params.model` from the browser transport, omit Kimi K3 temperature, and add Kimi K3 to the verified OpenRouter function-tool allowlist.

- [ ] **Step 1: Extend the reasoning mapper minimally**

Add a normalized Kimi K3 check and map `none`/`default` to `null`, all other efforts to `"max"`; leave the existing non-Kimi switch unchanged:

```typescript
function isKimiK3Model(model = ""): boolean {
  const normalized = model.trim().toLowerCase();
  return normalized === "moonshotai/kimi-k3" || normalized === "kimi-k3";
}

export function openRouterReasoningEffort(
  effort: ReasoningEffort,
  model = ""
): string | null {
  if (isKimiK3Model(model)) {
    if (effort === "none" || effort === "default") return null;
    return "max";
  }

  switch (effort) {
    case "none": return "none";
    case "low": return "low";
    case "medium": return "medium";
    case "high": return "high";
    case "max": return "max";
    default: return null;
  }
}
```

- [ ] **Step 2: Pass the model into transport routing and omit Kimi temperature**

Call `openRouterReasoningEffort(params.reasoningEffort ?? "default", params.model)` in `openai-compat.ts`. Add a normalized Kimi K3 check and use:

```typescript
const temperatureField =
  providerId !== "openai" && !isKimiK3 && params.temperature != null
    ? { temperature: params.temperature }
    : {};
```

Keep existing temperature behavior for all other providers and models.

- [ ] **Step 3: Add Kimi K3 to the verified tool allowlist**

Append `"moonshotai/kimi-k3"` to `OPENROUTER_MODELS_WITH_FUNCTION_TOOLS`; the current `listedModel` rule enables both native web search and native Build tools and remains fail-closed for unknown models.

- [ ] **Step 4: Run focused and existing provider tests**

Run:

```powershell
npx tsx scripts/test-kimi-k3-support.mts
npx tsx scripts/test-reasoning-routing.mts
npx tsx scripts/test-provider-registry.mts
npx tsx scripts/test-provider-web-search.mts
npx tsx scripts/test-provider-native-tools.mts
```

Expected: all commands exit 0; existing OpenRouter mappings remain unchanged.

- [ ] **Step 5: Commit routing changes**

```powershell
git add lib/providers/reasoning.ts lib/providers/openai-compat.ts lib/providers/provider-registry.ts
git commit -m "feat: route Kimi K3 OpenRouter requests"
```

### Task 4: Run full verification and inspect the final diff

**Files:** Inspect all changed files and `git diff`.

- [ ] **Step 1: Run provider regression bundle**

Run `npm run test:benchmark:unit`. Expected: exit 0 with no failing provider or benchmark checks.

- [ ] **Step 2: Run lint**

Run `npm run lint`. Expected: exit 0 with no ESLint errors.

- [ ] **Step 3: Run production build**

Run `npm run build`. Expected: exit 0 and a completed static Next.js build. If a dev server is active, stop/restart it after the build per `AGENTS.md`.

- [ ] **Step 4: Inspect status and diff**

```powershell
git status --short
git diff HEAD~3..HEAD --stat
git log -4 --oneline
```

Confirm only the Kimi K3 spec, tests, package script, and provider metadata/routing files changed; do not stage the pre-existing `.claude/worktrees/` directory.
