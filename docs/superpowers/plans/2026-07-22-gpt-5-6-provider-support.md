# GPT-5.6 Provider Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace AI Board's legacy GPT-5.6 aliases with official Sol, Terra, and Luna support for OpenAI and ChatGPT while migrating saved OpenAI selections safely.

**Architecture:** Keep model definitions in the existing catalog, pricing, context, and provider-policy registries. Add a small provider-aware ID migration primitive plus a browser-store migration adapter; transports continue forwarding model IDs, with only reasoning mapping becoming GPT-5.6-aware.

**Tech Stack:** Next.js 15, React 19, strict TypeScript, Node.js 24.18.0, `tsx` script tests, Runner V2 account-provider bridge.

## Global Constraints

- Official IDs are exactly `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`.
- Remove `gpt-5.6`, `gpt-5.6-pro`, and `gpt-5.6-mini` from both selectable catalogs.
- Legacy OpenAI selections map respectively to Terra, Sol, and Luna; no ChatGPT or other-provider IDs are rewritten.
- Sol/Terra/Luna use 1,050,000 context tokens and 128,000 maximum output tokens.
- OpenAI prices per million tokens are Sol `$5/$0.50/$30`, Terra `$2.50/$0.25/$15`, and Luna `$1/$0.10/$6` for input/cached input/output.
- ChatGPT pricing entries are reference-equivalent estimates only; account usage remains `account_not_metered` in Runner V2.
- GPT-5.6 sends native `max` reasoning; older GPT models keep `max` mapped to `xhigh`.
- Do not add provider-hosted shell tools or native Build tools to ChatGPT.
- Product Build mode must not import `lib/client/legacy-build-engine.benchmark.ts`.

---

### Task 1: Provider-aware legacy model-ID migration

**Files:**
- Create: `lib/providers/model-id-migration.ts`
- Create: `scripts/test-model-id-migration.mts`

**Interfaces:**
- Produces: `migrateProviderModelId(providerId: string, modelId: string): string`
- Produces: `migrateFullModelId(fullModelId: string): string`
- Produces: `migrateModelIdKeyedRecord<T>(record: Record<string, T> | undefined): Record<string, T> | undefined`

- [ ] **Step 1: Write the failing pure migration test**

Create `scripts/test-model-id-migration.mts` with assertions covering all three mappings, already-current IDs, ChatGPT IDs, unknown OpenAI IDs, malformed IDs, idempotence, and collision precedence:

```ts
import assert from "node:assert/strict";
import {
  migrateFullModelId,
  migrateModelIdKeyedRecord,
  migrateProviderModelId,
} from "../lib/providers/model-id-migration";

assert.equal(migrateProviderModelId("openai", "gpt-5.6"), "gpt-5.6-terra");
assert.equal(migrateProviderModelId("openai", "gpt-5.6-pro"), "gpt-5.6-sol");
assert.equal(migrateProviderModelId("openai", "gpt-5.6-mini"), "gpt-5.6-luna");
assert.equal(migrateFullModelId("openai:gpt-5.6-pro"), "openai:gpt-5.6-sol");
assert.equal(migrateFullModelId("chatgpt:gpt-5.6"), "chatgpt:gpt-5.6");
assert.equal(migrateFullModelId("openai:gpt-5.6-sol"), "openai:gpt-5.6-sol");
assert.equal(migrateFullModelId("openai:unknown"), "openai:unknown");
assert.equal(migrateFullModelId("malformed"), "malformed");
assert.equal(migrateFullModelId(migrateFullModelId("openai:gpt-5.6")), "openai:gpt-5.6-terra");

const migrated = migrateModelIdKeyedRecord({
  "openai:gpt-5.6": "legacy",
  "openai:gpt-5.6-terra": "current",
  "anthropic:gpt-5.6": "other",
});
assert.deepEqual(migrated, {
  "openai:gpt-5.6-terra": "current",
  "anthropic:gpt-5.6": "other",
});
console.log("PASS");
```

- [ ] **Step 2: Run the migration test and verify RED**

Run: `npx tsx scripts/test-model-id-migration.mts`

Expected: FAIL because `lib/providers/model-id-migration.ts` does not exist.

- [ ] **Step 3: Implement the minimal migration primitive**

Create `lib/providers/model-id-migration.ts` with an immutable mapping and current-key-wins record migration:

```ts
const OPENAI_LEGACY_MODEL_IDS: Readonly<Record<string, string>> = {
  "gpt-5.6": "gpt-5.6-terra",
  "gpt-5.6-pro": "gpt-5.6-sol",
  "gpt-5.6-mini": "gpt-5.6-luna",
};

export function migrateProviderModelId(providerId: string, modelId: string): string {
  return providerId === "openai" ? OPENAI_LEGACY_MODEL_IDS[modelId] ?? modelId : modelId;
}

export function migrateFullModelId(fullModelId: string): string {
  const separator = fullModelId.indexOf(":");
  if (separator < 1) return fullModelId;
  const providerId = fullModelId.slice(0, separator);
  const modelId = fullModelId.slice(separator + 1);
  const migrated = migrateProviderModelId(providerId, modelId);
  return migrated === modelId ? fullModelId : `${providerId}:${migrated}`;
}

export function migrateModelIdKeyedRecord<T>(
  record: Record<string, T> | undefined
): Record<string, T> | undefined {
  if (!record) return undefined;
  const output: Record<string, T> = {};
  for (const [key, value] of Object.entries(record)) {
    if (migrateFullModelId(key) === key) output[key] = value;
  }
  for (const [key, value] of Object.entries(record)) {
    const migrated = migrateFullModelId(key);
    if (!(migrated in output)) output[migrated] = value;
  }
  return output;
}
```

- [ ] **Step 4: Run the migration test and verify GREEN**

Run: `npx tsx scripts/test-model-id-migration.mts`

Expected: PASS.

- [ ] **Step 5: Commit the migration primitive**

```powershell
git add lib/providers/model-id-migration.ts scripts/test-model-id-migration.mts
git commit -m "feat: add GPT-5.6 model id migration"
```

### Task 2: Official catalogs, pricing, context, policies, and reasoning

**Files:**
- Modify: `lib/providers/catalog.ts`
- Modify: `lib/providers/pricing.ts`
- Modify: `lib/providers/model-context.ts`
- Modify: `lib/providers/reasoning.ts`
- Modify: `lib/account-provider-runner.mjs`
- Modify: `scripts/test-provider-registry.mts`
- Modify: `scripts/test-model-context.mts`
- Modify: `scripts/test-account-provider-runner-chat.mts`
- Create: `scripts/test-gpt-5-6-support.mts`

**Interfaces:**
- Consumes: official model IDs and existing catalog lookup functions.
- Produces: six catalog entries, six context profiles, six pricing records, and model-aware native `max` reasoning.

- [ ] **Step 1: Write the failing GPT-5.6 registry test**

Create `scripts/test-gpt-5-6-support.mts`. Iterate over `openai` and `chatgpt`, assert exact IDs/order, capabilities, context, prices, reasoning, web search, max-token behavior, and native Build-tool behavior. Include these central expectations:

```ts
const ids = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const prices = {
  "gpt-5.6-sol": [5, 0.5, 30],
  "gpt-5.6-terra": [2.5, 0.25, 15],
  "gpt-5.6-luna": [1, 0.1, 6],
} as const;

for (const providerId of ["openai", "chatgpt"] as const) {
  const actualIds = MODEL_CATALOG.filter((m) => m.providerId === providerId)
    .map((m) => m.id).filter((id) => id.startsWith("gpt-5.6"));
  assert.deepEqual(actualIds, ids);
  for (const id of ids) {
    const model = MODEL_CATALOG.find((m) => m.providerId === providerId && m.id === id);
    assert.deepEqual(model?.capabilities, {
      image: true, document: true, audio: false, video: false,
    });
    const context = resolveModelContextProfile(id, providerId);
    assert.equal(context.contextWindowTokens, 1_050_000);
    assert.equal(context.maxOutputTokens, 128_000);
    assert.equal(context.buildOutputReserveTokens, 128_000);
    assert.equal(providerSupportsReasoning(`${providerId}:${id}`), true);
    assert.equal(providerSupportsNativeWebSearchFeature(providerId, id), true);
  }
}
```

Assert removed IDs are absent. For OpenAI pricing, assert exact rates and `verifiedAt === "2026-07-22"`. For ChatGPT pricing, assert the same numerical reference rates and a note containing `reference` and `not ChatGPT billing`. Assert Luna is OpenAI's validation candidate. Assert ChatGPT max-token and native Build-tool policies remain false.

- [ ] **Step 2: Update existing expectations and verify RED**

Replace the stale exclusions in `scripts/test-provider-registry.mts` with positive Sol/Terra/Luna expectations. Extend `scripts/test-model-context.mts` for all six context profiles. Change `scripts/test-account-provider-runner-chat.mts` to expect GPT-5.6 `max` to be forwarded as `max` and add an older-model case that still expects `xhigh`.

Run:

```powershell
npx tsx scripts/test-gpt-5-6-support.mts
npx tsx scripts/test-provider-registry.mts
npx tsx scripts/test-model-context.mts
npx tsx scripts/test-account-provider-runner-chat.mts
```

Expected: each new or changed GPT-5.6 assertion fails against the current legacy entries/mapping.

- [ ] **Step 3: Replace catalog and metadata entries**

In `lib/providers/catalog.ts`, replace the three OpenAI aliases and prepend the same three explicit entries to ChatGPT. Use `validationCandidate: true` only on OpenAI Luna. All six capabilities are `{ image: true, document: true, audio: false, video: false }`.

In `lib/providers/pricing.ts`, remove the three legacy keys and add official OpenAI and ChatGPT keys with the exact Global Constraints rates, `verifiedAt: "2026-07-22"`, and the official OpenAI pricing URL. ChatGPT notes must explicitly say these are equivalent API reference rates and not ChatGPT subscription billing.

In `lib/providers/model-context.ts`, replace the three legacy profiles and add the three ChatGPT profiles. Every profile uses:

```ts
{
  contextWindowTokens: 1_050_000,
  maxOutputTokens: 128_000,
  buildOutputReserveTokens: 128_000,
  longContextQuality: "excellent",
  promptCaching: true,
  recommendedBuildRoles: [...ALL_BUILD_ROLES],
}
```

- [ ] **Step 4: Make reasoning mapping model-aware**

Change `openAIReasoningEffort` to accept `model = ""` and return `"max"` when `effort === "max"` and the normalized model starts with `gpt-5.6`; otherwise retain `"xhigh"`. Update every OpenAI caller to pass the selected model.

Change the runner helper to `reasoningEffortValue(effort, model)` with the same rule and call it from `responsesReasoningField(body)` using `body.model`. Do not change older model behavior.

- [ ] **Step 5: Run focused metadata tests and verify GREEN**

Run the four commands from Step 2.

Expected: all print PASS and exit 0.

- [ ] **Step 6: Commit official model metadata and transport behavior**

```powershell
git add lib/providers/catalog.ts lib/providers/pricing.ts lib/providers/model-context.ts lib/providers/reasoning.ts lib/account-provider-runner.mjs scripts/test-gpt-5-6-support.mts scripts/test-provider-registry.mts scripts/test-model-context.mts scripts/test-account-provider-runner-chat.mts
git commit -m "feat: support GPT-5.6 family providers"
```

### Task 3: Persisted browser-selection migration

**Files:**
- Create: `lib/client/model-selection-migration.ts`
- Modify: `lib/client/store.ts`
- Modify: `components/benchmark/run/ModelChecklist.tsx`
- Create: `scripts/test-model-selection-migration.mts`

**Interfaces:**
- Consumes: `migrateFullModelId`, `migrateModelIdKeyedRecord`, and `migrateProviderModelId` from Task 1.
- Produces: `migrateClientStoreModelSelections(store: ClientStore): { store: ClientStore; changed: boolean }`.

- [ ] **Step 1: Write the failing store-selection migration test**

Create `scripts/test-model-selection-migration.mts` with a minimal `ClientStore` fixture containing:

- user judge, pricing override, and context override using legacy OpenAI IDs;
- an OpenAI provider default and an unchanged ChatGPT provider default;
- discussion model/judge/reviewer IDs;
- an active game-session AI participant;
- a historical completed game-match participant;
- historical messages, model stats, benchmark team compositions, benchmark attempts, and traces using legacy IDs.

Assert active/configurable fields migrate, current override keys win collisions, `changed` is true, a second call is unchanged with `changed` false, and historical records remain byte-for-byte equal.

- [ ] **Step 2: Run the store migration test and verify RED**

Run: `npx tsx scripts/test-model-selection-migration.mts`

Expected: FAIL because `lib/client/model-selection-migration.ts` does not exist.

- [ ] **Step 3: Implement the store selection migration**

Create `lib/client/model-selection-migration.ts`. Clone the input once, migrate only the fields named in the design, parse/stringify `Discussion.modelIds` defensively, and compute `changed` by comparing each transformed value. Preserve historical arrays, including benchmark team compositions, attempts, and traces.

- [ ] **Step 4: Integrate migration into every store hydration path**

In `lib/client/store.ts`, apply `migrateClientStoreModelSelections` after main, split-discussion, and benchmark data have been merged and before assigning `memory`. Use one small commit helper so `loadStore`, storage switching, import, `replaceStore`, and test replacement cannot drift. When `changed` is true during adapter load, call the existing `schedulePersist()` after assigning `memory`; replacement/import paths already schedule persistence.

- [ ] **Step 5: Migrate the benchmark Run-tab local-storage checklist**

In `readPersistedModelChecklistSelection`, map every string through `migrateFullModelId`. If any value changes, immediately write the migrated array back using `persistModelChecklistSelection`. Keep malformed/non-array handling unchanged.

Extend `scripts/test-model-selection-migration.mts` with a fake `window.localStorage` and assert read-time migration plus durable write-back.

- [ ] **Step 6: Run migration and existing store tests**

Run:

```powershell
npx tsx scripts/test-model-id-migration.mts
npx tsx scripts/test-model-selection-migration.mts
npx tsx scripts/test-game-session-store.mts
```

Expected: all print PASS and exit 0.

- [ ] **Step 7: Commit persisted-selection migration**

```powershell
git add lib/client/model-selection-migration.ts lib/client/store.ts components/benchmark/run/ModelChecklist.tsx scripts/test-model-selection-migration.mts
git commit -m "feat: migrate saved GPT-5.6 selections"
```

### Task 4: Full verification and live account-provider smoke test

**Files:**
- Modify only if verification exposes a scoped defect in files already listed above.

**Interfaces:**
- Consumes: all implementation from Tasks 1-3.
- Produces: verified browser, Runner V2, OpenAI, and ChatGPT support.

- [ ] **Step 1: Run the focused regression suite**

```powershell
npx tsx scripts/test-model-id-migration.mts
npx tsx scripts/test-model-selection-migration.mts
npx tsx scripts/test-gpt-5-6-support.mts
npx tsx scripts/test-provider-registry.mts
npx tsx scripts/test-model-context.mts
npx tsx scripts/test-account-provider-runner-chat.mts
npx tsx scripts/test-account-runner-streaming-tools.mts
npx tsx scripts/test-provider-web-search.mts
npm run test:runner-v2
```

Expected: every command exits 0.

- [ ] **Step 2: Run static and production checks**

Run `npm run lint`, then `npm run build` while no development server is active.

Expected: both exit 0. If a dev server was active, restart it after the build as required by `AGENTS.md`.

- [ ] **Step 3: Run live ChatGPT smoke probes when the supplied runner is still available**

Send the same minimal prompt through `/providers/chatgpt/chat` using `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, then send a Sol request with `reasoningEffort: "max"`. Do not print the runner token. Require HTTP 200 and non-empty content for all four probes. If the runner is no longer available, report the skipped live check separately rather than treating automated transport tests as a live-account result.

- [ ] **Step 4: Review the final diff and repository state**

Run:

```powershell
git diff --check
git status --short
git log -5 --oneline
```

Expected: no whitespace errors; only intentional implementation/plan state remains.

- [ ] **Step 5: Commit any verification-only correction**

If Step 1 or 2 required a scoped correction, stage only those corrected files and commit with `fix: complete GPT-5.6 verification`. If no correction was needed, do not create an empty commit.
