# Gemini 3.6 Flash Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add complete Google Gemini 3.6 Flash support with verified metadata and compatible GenerateContent request routing.

**Architecture:** Extend the existing Google catalog, pricing, context, and policy registries. Keep the current Google transport while isolating Gemini 3.6's sampling and thinking compatibility rules in testable helpers.

**Tech Stack:** TypeScript, Next.js, `@google/genai`, TSX script tests.

## Global Constraints

- Work directly on `main` as requested.
- Use exact stable ID `gemini-3.6-flash`; do not remove or migrate Gemini 3.5 Flash.
- Standard pricing is $1.50/M input, $0.15/M cached input, and $7.50/M output.
- Context is 1,048,576 input and 65,536 output tokens.
- Omit deprecated sampling parameters for Gemini 3.6 Flash.
- Use only `MEDIUM` and `HIGH` thinking levels for Gemini 3.6 Flash.

---

### Task 1: Metadata and capability contract

**Files:**
- Create: `scripts/test-gemini-3-6-flash-support.mts`
- Modify: `lib/providers/catalog.ts`
- Modify: `lib/providers/pricing.ts`
- Modify: `lib/providers/model-context.ts`
- Modify: `scripts/test-provider-registry.mts`
- Modify: `scripts/test-model-context.mts`

**Interfaces:**
- Consumes: existing `MODEL_CATALOG`, pricing, context, and provider capability resolvers.
- Produces: the model `google:gemini-3.6-flash` as a selectable, priced, context-aware Google runtime.

- [ ] **Step 1: Write the failing metadata test**

Assert that the Google catalog exposes the exact ID and multimodal input
capabilities, pricing resolves to `1.5 / 0.15 / 7.5`, context resolves to
`1_048_576 / 65_536`, and provider policies expose reasoning, search, native
function tools, and hosted tools.

- [ ] **Step 2: Run the test to verify red**

Run: `npx tsx scripts/test-gemini-3-6-flash-support.mts`

Expected: FAIL because the catalog has no `gemini-3.6-flash` entry.

- [ ] **Step 3: Implement the verified metadata**

Insert the catalog entry before Gemini 3.5 Flash, move the validation candidate
flag to 3.6, and add exact pricing and context registry records using the
official Google source URLs.

- [ ] **Step 4: Run metadata and registry tests**

Run:
`npx tsx scripts/test-gemini-3-6-flash-support.mts; npx tsx scripts/test-provider-registry.mts; npx tsx scripts/test-model-context.mts`

Expected: all PASS.

### Task 2: GenerateContent compatibility

**Files:**
- Modify: `lib/providers/google.ts`
- Modify: `lib/providers/reasoning.ts`
- Modify: `lib/providers/provider-registry.ts`
- Modify: `scripts/test-gemini-3-6-flash-support.mts`
- Modify: `scripts/test-reasoning-routing.mts`
- Modify: `scripts/test-provider-web-search.mts`

**Interfaces:**
- Consumes: `ChatParams.model`, `ChatParams.temperature`, and `ReasoningEffort`.
- Produces: `googleSamplingConfig(model, temperature): Pick<GenerateContentConfig, "temperature">` and compatible `geminiThinkingConfig` output.

- [ ] **Step 1: Add failing request-shape assertions**

Assert that 3.6 omits temperature, 3.5 retains it, 3.6 maps none/low/medium to
`{ thinkingLevel: "MEDIUM" }`, maps high/max to `HIGH`, and continues to use
current Google Search grounding.

- [ ] **Step 2: Run the test to verify red**

Run: `npx tsx scripts/test-gemini-3-6-flash-support.mts`

Expected: FAIL because the sampling helper does not exist and 3.6 none maps to
`MINIMAL`.

- [ ] **Step 3: Implement minimal compatibility routing**

Add the sampling helper, use it in `generationConfig`, special-case 3.6 thinking
levels, and update Google runtime behavior copy to describe model-dependent
temperature handling.

- [ ] **Step 4: Run focused compatibility suites**

Run:
`npx tsx scripts/test-gemini-3-6-flash-support.mts; npx tsx scripts/test-reasoning-routing.mts; npx tsx scripts/test-provider-web-search.mts`

Expected: all PASS.

### Task 3: Full verification and delivery

**Files:**
- Verify all modified files.

**Interfaces:**
- Consumes: completed Tasks 1 and 2.
- Produces: a clean, committed `main` checkout.

- [ ] **Step 1: Run focused tests and type checking**

Run all Gemini/provider scripts plus `npx tsc --noEmit --pretty false`.

- [ ] **Step 2: Run repository gates**

Run: `npm run test:runner-v2`, `npm run lint`, and `npm run build` after checking
that no dev server uses this checkout's `.next` directory.

- [ ] **Step 3: Verify Git state and commit**

Run: `git diff --check`, inspect `git diff`, then commit the implementation and
any build-published runner artifact changes. Confirm `git status --short` is empty.

