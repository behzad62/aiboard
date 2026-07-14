# Native Build Pass Provenance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve intentional new-pass identity across browser/Runner crashes so Restart and forced follow-up provision exactly one reserved native run.

**Architecture:** Add a persisted `nativeBuildRequestedAt` marker beside the reserved run ID. Resolver calls carrying that marker ignore references from earlier passes, while ordinary attachment resolution continues selecting the newest project reference. The native engine provisions the reserved ID idempotently and clears the marker only after an authoritative run is attached.

**Tech Stack:** Next.js browser client, strict TypeScript, Runner V2 HTTP client, `tsx` contract scripts.

## Global Constraints

- Use exactly Node.js 24.18.0 for Runner verification.
- Do not run `npm run build` while the development server is active.
- Test every behavior RED before production changes.

---

### Task 1: Persist intentional pass provenance

**Files:**
- Modify: `lib/db/schema.ts`
- Modify: `lib/client/api.ts`
- Test: `scripts/test-build-note-attachments.mts`

**Interfaces:**
- Produces: `Discussion.nativeBuildRequestedAt?: string | null`.

- [ ] Add assertions that Restart and forced follow-up replace the run ID and persist the same operation timestamp as `nativeBuildRequestedAt`.
- [ ] Run `npx tsx scripts/test-build-note-attachments.mts` and observe the missing provenance failure.
- [ ] Add the schema field and write it atomically with the reserved run ID in create, Restart, and intentional follow-up paths.
- [ ] Re-run the script and observe PASS.

### Task 2: Resolve only the current intentional pass

**Files:**
- Modify: `lib/client/runner-v2.ts`
- Test: `scripts/test-runner-v2-client.mts`

**Interfaces:**
- Extends: `resolveNativeBuildRunId(..., { allowMissing: true, requestedAt?: string })`.

- [ ] Add resolver regressions for an old completed reference, a matching crash-created reserved run, a newer crash-created reference, and ordinary newest-reference refresh.
- [ ] Run the client script and observe the old reference incorrectly suppress provisioning.
- [ ] Filter new-pass references by valid `requestedAt`, prefer an existing reserved run or newest eligible reference, and return `undefined` only when neither exists.
- [ ] Re-run the client script and observe PASS.

### Task 3: Provision and attach the reserved identity

**Files:**
- Modify: `lib/client/native-build-engine.ts`
- Modify: `app/discussion/discussion-client.tsx`
- Test: `scripts/test-runner-v2-client.mts`

**Interfaces:**
- Produces: `nativeBuildProvisioningRunId(reservedRunId)`.
- Consumes: `Discussion.nativeBuildRequestedAt` and the extended resolver options.

- [ ] Add a failing assertion that provisioning chooses the exact reserved ID.
- [ ] Make the engine pass provenance to resolution, provision the reserved ID, and clear provenance only after create or authoritative attach succeeds.
- [ ] Make browser attachment pass provenance and clear it after authoritative attachment.
- [ ] Re-run focused scripts and typecheck.

### Task 4: Verify and report

**Files:**
- Modify: `.superpowers/sdd/task-5-report.md`

**Interfaces:**
- Consumes: all preceding behavior and test evidence.

- [ ] Run all covering client scripts, app and Runner typechecks, relevant Runner tests, lint, and `git diff --check`.
- [ ] Append exact RED/GREEN evidence and verification results to the report.
- [ ] Commit the focused change set.
