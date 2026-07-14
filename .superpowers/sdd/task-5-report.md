# Task 5 Report: Browser newest-run reconciliation and native panels

## Outcome

Implemented the browser attachment layer for the reviewed Runner V2 transcript/files APIs without changing Runner backend behavior.

- Every native Build attachment now queries project Build references and selects the newest reference by `createdAt`, then code-unit lexicographic `runId`.
- Existing saved runs remain usable when the reference list is empty; `allowMissing` remains the explicit provisioning path for a genuinely unprovisioned follow-up.
- Build reconciliation runs for every browser Build status, refreshes run/projection/usage/activity/tasks/handoffs/observability, polls created/running/paused/stopping runs, and performs one final terminal refresh.
- Attachment polling ignores responses after cancellation/run changes and retries transient refresh failures.
- Native transcript pages merge by cursor and stable id, replace browser-cached Build messages, retain durable order, and display Architect/worker/subagent identity with native runtime display names.
- Native transcript export uses exactly the attached native model turns and does not append browser notes or a legacy final result. Non-Build export is unchanged.
- Native Runner file snapshots replace browser-cached Build files, refresh on run/source/revision changes, remain visible after completion/automatic apply, and drive the same per-file/zip downloads shown by the panel.
- File panels identify `Proposed integration` or `Applied project`, show a 12-character revision, and explain omitted binary/oversized/budget files. Omitted-only snapshots do not offer a misleading empty zip.
- Automatic Finish/Budgeted apply does not flash a manual Apply/Keep choice while running; a paused failed/recoverable automatic handoff remains actionable.

## Files changed

- `lib/client/runner-v2.ts`
  - Added transcript/file response types, including the durable transcript ordinal, and `getNativeBuildTranscript` / `getNativeBuildFiles`.
  - Reworked authoritative run resolution to always inspect project references and use deterministic newest-reference ordering.
- `lib/client/discussion-live-state.ts`
  - Added native transcript mapping/deduplication, actor-to-runtime resolution, file attachment revision keys, polling transitions/controller, all-status restoration, and automatic-handoff presentation rules.
- `app/discussion/discussion-client.tsx`
  - Replaced stopped/failed-only and observability-only effects with one cancel-safe full attachment poller.
  - Bound native transcript/files to panels and download paths and retained legacy behavior only as a pre-attachment fallback.
- `components/ArtifactPanel.tsx`
  - Added immutable source/revision/omission presentation and omitted-only safety.
- `components/BuildTranscriptPanel.tsx`
  - Added native Build transcript Markdown formatting from the same displayed turn set.
- `scripts/test-runner-v2-client.mts`
  - Added endpoint and newest-reference regressions, including empty references and timestamp ties.
- `scripts/test-build-live-state.mts`
  - Added all-status, transcript filtering/deduplication, actor/runtime, polling, cancellation, terminal refresh, and handoff regressions.
- `scripts/test-build-transcript-panel.mts`
  - Added native export identity/order checks.
- `scripts/test-native-build-files.mts`
  - Added Runner snapshot replacement and metadata/omission render checks.
- `package.json`
  - Added transcript-panel and native-file scripts to `test:runner-v2`.
- `runner-v2/src/agent-session-store.ts` and `runner-v2/src/sqlite-agent-session-store.ts`
  - Preserve the durable event ordinal in projected transcript turns so turns from the same checkpoint remain ordered.
- `runner-v2/test/agent-session-store.test.ts`
  - Covers multiple assistant turns at one checkpoint with sequence/ordinal/id ordering.

## Test-first evidence

### Client API and authoritative run selection

RED:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs scripts/test-runner-v2-client.mts
SyntaxError: ../lib/client/runner-v2 does not provide getNativeBuildFiles
exit 1
```

After the endpoint implementation, the newer-running-over-saved-completed, empty-reference, and equal-timestamp cases passed. Self-review then added a mixed-case tie regression because `localeCompare` is not code-unit lexicographic:

```text
AssertionError: 'run_Z' !== 'run_a'
exit 1
```

GREEN after the deterministic comparator:

```text
PASS runner-v2 client
exit 0
```

### Transcript mapping, reconnects, and poll races

RED:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs scripts/test-build-live-state.mts
SyntaxError: discussion-live-state does not provide nextNativeBuildPoll
exit 1
```

The controller regression was also observed RED before implementation because `createNativeBuildAttachmentPoller` was absent. Subsequent behavior regressions produced expected assertion failures before their fixes:

```text
AssertionError: in-flight successful automatic handoff returned a project decision instead of null
AssertionError: Architect subagent lacked "· Architect Model"
```

GREEN:

```text
PASS Build live discussion state
exit 0
```

This covers overlapping cursor pages, stable-id deduplication, invalid/user/blank row exclusion, replacement rather than append, worker and Architect subagent runtime labels, paused polling, one terminal refresh, and stale-response cancellation.

### Transcript panel export

RED:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs scripts/test-build-transcript-panel.mts
SyntaxError: BuildTranscriptPanel does not provide buildBuildTranscriptMarkdown
exit 1
```

GREEN:

```text
PASS - Build transcript export contains exactly the displayed native turns
PASS - Build transcript export preserves durable native order
exit 0
```

### Native file panel

RED:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs scripts/test-native-build-files.mts
SyntaxError: ArtifactPanel does not provide abbreviateArtifactRevision
exit 1
```

The omitted-only download safety regression was separately observed RED:

```text
AssertionError: an omitted-only snapshot cannot offer an empty zip as though files were loaded
exit 1
```

GREEN:

```text
PASS native Build files
exit 0
```

### Integration typecheck

The first strict typecheck after binding the component found three expected integration errors (nullable attachment narrowing and the timeline `streaming` shape). After minimal fixes:

```text
npx tsc --noEmit
exit 0
```

## Final verification

Fresh full suite after the main integration:

```text
npm run test:runner-v2
293/293 Runner V2 tests passed
all 11 client/contract scripts passed
exit 0
```

Fresh client-only sweep after the final self-review fixes:

```text
scripts/test-runner-v2-client.mts                  PASS
scripts/test-native-build-policy.mts               PASS
scripts/test-native-build-policy-ui.tsx            PASS
scripts/test-native-build-cutover.mts              PASS
scripts/test-native-build-pause-gates.mts          PASS
scripts/test-native-model-usage.mts                PASS
scripts/test-build-live-state.mts                  PASS
scripts/test-build-transcript-panel.mts            PASS
scripts/test-native-build-files.mts                PASS
scripts/test-build-run-stats.mts                   PASS
scripts/test-runner-v2-observability.mts           PASS
exit 0
```

Fresh static verification:

```text
npx tsc --noEmit   exit 0
npm run lint       exit 0, zero warnings
git diff --check   exit 0
```

`npm run build` was intentionally not run because the repository's Next development server is active, and `AGENTS.md` warns that building while the dev server is active can corrupt `.next`. TypeScript, full ESLint, the full Runner suite, and every client contract script all passed.

## Self-review

- Confirmed the resolver no longer returns early when a saved run exists.
- Replaced locale-sensitive `localeCompare` ordering after a mixed-case regression proved it violated deterministic code-unit lexicographic order.
- Confirmed `allowMissing` is used only by the existing pending/follow-up provisioning call path.
- Confirmed the polling controller applies nothing after cancellation and uses Runner run state rather than stale browser status.
- Confirmed native transcript state is reset when the discussion/restart/resume changes and old-run attachment objects are hidden unless their run id matches the current saved run.
- Confirmed native transcript export branches before the legacy export path and non-Build export is untouched.
- Confirmed Runner file downloads consume the exact `files` array rendered with snapshot metadata; no browser store write is performed.
- Confirmed applied snapshots remain rendered even with `finalResult` or a disconnected browser engine, and stale `BuildResultCard` file output is suppressed after native attachment.
- Confirmed automatic apply presentation uses run state to distinguish in-flight success from paused failure/recovery.
- Confirmed the only Runner backend change is preserving the already-durable ordinal in the transcript response contract; scheduling and lifecycle behavior are unchanged.

## Concerns

- The browser fetch API is cancel-safe by ignoring stale responses rather than aborting underlying HTTP requests; this prevents state corruption, though an already-started request may still complete on the network.
- File snapshots are fetched with each active reconciliation so revision/source changes cannot be missed. The attachment state avoids rerender replacement when the immutable run/source/revision key is unchanged.
- Build verification was skipped only because an active Next dev server makes it unsafe under repository guidance; no other verification is outstanding.

## Review-fix cycle

### Missing saved run under `allowMissing`

RED after adding a crash-recovery reference regression:

```text
npx tsx scripts/test-runner-v2-client.mts
AssertionError: actual undefined; expected run_recovered_after_crash
exit 1
```

GREEN after resolving project references before applying `allowMissing`:

```text
PASS runner-v2 client
exit 0
```

### Same-checkpoint transcript order

RED in the Runner projection test after requiring `ordinal`:

```text
npx -y node@24.18.0 node_modules/tsx/dist/cli.mjs --test --test-name-pattern="transcript projects only stable assistant text turns" runner-v2/test/agent-session-store.test.ts
AssertionError: projected turns omitted ordinal
exit 1
```

RED in the client mapper/export regressions before ordinal-aware ordering:

```text
npx tsx scripts/test-build-live-state.mts
AssertionError: actual [a-second-durable-turn,z-first-durable-turn]; expected [z-first-durable-turn,a-second-durable-turn]
exit 1

npx tsx scripts/test-build-transcript-panel.mts
FAIL - same-checkpoint transcript export preserves Runner ordinal before id
exit 1
```

GREEN after projecting and transporting `ordinal`, then sorting by sequence, ordinal, and code-unit id:

```text
runner-v2/test/agent-session-store.test.ts   13/13 PASS
scripts/test-build-live-state.mts            PASS
scripts/test-build-transcript-panel.mts      PASS
```

### Legacy replacement, stale runs, and retrying attachment

The state-level replacement regression was observed RED before `selectNativeBuildAttachmentView` existed; the retry regression was RED before `createNativeBuildAttachmentRefresh` existed; and the connected fallback regression was RED before `shouldShowLegacyBuildFileFallback` existed. Each failed at module load with the corresponding missing export.

GREEN after implementation:

```text
npx tsx scripts/test-build-live-state.mts
PASS Build live discussion state
exit 0
```

This test seeds real legacy messages and files, proves matching native attachments replace them, proves stale old-run attachments do not leak after an authoritative run switch, and proves resolve/fetch failures retry through the poller until a full attachment succeeds. The component now keeps browser-cached state as fallback and uses one selected message array for both display and Build transcript download.

### Review-fix verification

```text
11 client/contract scripts                                      PASS
npx tsc --noEmit                                                PASS
npx -y node@24.18.0 node_modules/typescript/bin/tsc \
  -p runner-v2/tsconfig.json --noEmit                           PASS
agent-session-store.test.ts + control-server.test.ts            21/21 PASS
npm run lint                                                    PASS, zero warnings
git diff --check                                                PASS
```

The complete Runner suite passed 292 functional tests and encountered one Windows `EPERM` while removing the recovery smoke test's temporary directory. An immediate isolated rerun of `runner-v2/test/recovery-smoke.test.ts` passed 1/1, confirming the failure was transient cleanup rather than a product assertion.
