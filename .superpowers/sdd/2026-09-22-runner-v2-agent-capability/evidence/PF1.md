# Evidence — PF1

**Authoritative acceptance record for this packet.** One fact, one location. Reference other
records rather than copying them. Keep derived summaries identifiable as summaries.

| | |
|---|---|
| Packet | PF1 · prompt-review fixes part 1 (H1, H2, H4, H5) · implementation |
| Requirements | H1, H2, H4, H5 from `evidence/prompt-review.md`. Part 2 (H3, M2, M4, M5, M6) is out of scope. |
| Base revision | `3f1af626c03513e374e26eb49449577afca1dd69` (brief named `dadc4c4c`; this worktree HEAD is `3f1af626`) |
| Uncommitted diff identity | Implementation `git diff --stat`: 10 files, 914 insertions, 57 deletions. This evidence file is additional and untracked. Source sha256 values are in section 3. |
| Node | `C:\Program Files\nodejs\node.exe` v24.18.0 |
| State | IN_REVIEW |

---

## 1. Acceptance conditions

| Requirement | Acceptance condition | Method | Outcome | Log |
|---|---|---|---|---|
| H5 | `write_project_doc` summary schema is one line (`minLength` 1, `maxLength` 200, no CR/LF/NUL). Validation refuses a summary the commit would reject, so `project_doc.requested` is not recorded. Recovery abandons an already-recorded uncommittable summary with a durable runner event and continues. | `project-docs.test.ts` multiline-summary test; `build-runtime.test.ts` recovery test; both inside the affected-graph run | pass (see section 3) | affected-graph log, exit 0 |
| H2 | On `review_required` the disposable command copy is the submission `taskRevision`. Every other reason uses `integrationRevision`. A checkout failure is returned as an error and is not replaced with another revision. The system line names both revisions. | `native-architect-runtime.test.ts`: worker-change test, checkout-failure test | pass | affected-graph log, exit 0 |
| H4 | Architect context has a required `project-docs` section: committed paths with sequence, committed `docs/project/STATE.md` text from the artifact store, entry-point facts, `stateCurrent`. STATE text capped at 4096 bytes with a truncation marker. The old read-first sentence is replaced. | `project-docs.test.ts` context test; `native-architect-runtime.test.ts` context test (deleting the section reddens it) | pass | affected-graph log, exit 0 |
| H1 | Decision turns get the trimmed per-reason paragraph, `retriesRemaining`, `rationale.minLength` 1, and a tool refusal of an empty `proceed_without_manifest` rationale. That reason registers only `resolve_context_recording` and `ask_user`. A1b's required-lifecycle check is relaxed for that reason only. | `build-runtime.test.ts` decision-turn test; `architect-tools.test.ts` empty-rationale assertions | pass | affected-graph log, exit 0 |

---

## 2. Prove-red

Each injection was hashed, and the before/after hashes were printed, before the failing test was run. Each file was then restored from the pre-injection bytes. The restored sha256 matched the before hash.

| Injection | File | Bytes / SHA-256 before → after | Applied? | RED signature (exact) | Restored byte-exact? |
|---|---|---|---|---|---|
| H5: `projectDocSummaryAccepted` character class changed from `[\r\n\0]` to `[\r\0]` (newline allowed) | `runner-v2/src/architect-tools.ts` | 96347 / `cf4790c675442ad325f0d20846e8b93de5f91a00a6e0b8dd1f44575d608cb6bf` → 96345 / `1faa311409f20bad7af912caf274a3cb8ab64d8d5df0ffccc2fedee112a9c69d` | yes, hashed before the test | `AssertionError [ERR_ASSERTION]: "first line\nsecond line"` / `false !== true` at `runner-v2/test/project-docs.test.ts:290` (`assert.equal(result.isError, true, JSON.stringify(summary))`) | yes, restored hash `cf4790c675442ad325f0d20846e8b93de5f91a00a6e0b8dd1f44575d608cb6bf` |
| H2: `architectCommandCheckoutRevision` returns `projection.integrationRevision` for `review_required` | `runner-v2/src/native-architect-runtime.ts` | 46845 / `944529d453c3a50974d143f02b8582a53cb17fcc8b7659e9190082cc1769bd43` → 46558 / `a8d80f088fb55085527c97ca3be281261cb5b19611bcb7e362f195faa83dd487` | yes, hashed before the test | `deepStrictEqual` actual `['a'.repeat(40)]` expected `['b'.repeat(40)]` at `runner-v2/test/native-architect-runtime.test.ts:1552` | yes, restored hash `944529d453c3a50974d143f02b8582a53cb17fcc8b7659e9190082cc1769bd43` |
| H4: removed the required `project-docs` section from `architectContextSections` | `runner-v2/src/agent-prompts.ts` | 19728 / `6dc30ee9b10aee64d9652e1643edac0de136812bd168cb2b07590896d4f7d6aa` → 19646 / `ed764f70f68a70c1f5e94b22010b1d1e46bbb21b72a4f5e99dadbe5f2a7467e6` | yes, hashed before the test | `The input did not match the regular expression /PF1_COMMITTED_STATE_MARKER/` at `runner-v2/test/native-architect-runtime.test.ts:1751` | yes, restored hash `6dc30ee9b10aee64d9652e1643edac0de136812bd168cb2b07590896d4f7d6aa` |
| H1: decision reason no longer returns the short list; `resolve_context_recording` is appended to the full tool list | `runner-v2/src/architect-tools.ts` | 96347 / `cf4790c675442ad325f0d20846e8b93de5f91a00a6e0b8dd1f44575d608cb6bf` → 96314 / `254c2c1d004d116e943ec9b9653aff1fe18d9fd8093333a083088fab59a990e1` | yes, hashed before the test | `deepStrictEqual` expected `['ask_user','resolve_context_recording']`, actual `['answer_guidance','ask_user','complete_run','plan_tasks','reconcile_plan','request_integration','resolve_context_recording','review_task','revise_task','upgrade_acceptance_contract']` at `runner-v2/test/build-runtime.test.ts:1858` | yes, restored hash `cf4790c675442ad325f0d20846e8b93de5f91a00a6e0b8dd1f44575d608cb6bf` |

A discarded H1 injection (96106 bytes, sha256 `50ce51456431da7dae1639d1583bb105d47070cf3896b5c290eae683ceed0fc1`) deleted the decision-reason return entirely. That run threw `Architect lifecycle surface omitted resolve_context_recording` before the tool-list assertion. It is not the recorded RED. The recorded H1 row is the later injection, hashed before its own test.

---

## 3. Validation scope and rationale

| | |
|---|---|
| Affected graph | 39 files. Every `runner-v2/test/*.test.ts` whose import path is `architect-tools.js`, `build-runtime.js`, `native-architect-runtime.js`, `agent-prompts.js`, `scheduler-store.js`, or `user-steering-contracts.js`. `replay-compatibility.test.ts` is in that set because it imports `scheduler-store.js`. |
| Why this scope | H1 changes the Architect tool surface, the reason payload, and the checkpoint parser. H2 changes command checkout. H4 changes every Architect context pack. H5 adds `project_doc.abandoned` to the scheduler event union and recovery. Callers of those modules, plus replay of old logs, are the behavioural impact. |
| Concurrency | `--test-concurrency=1`. The set contains host and process fixtures. |
| Result | `tests 534 / pass 534 / fail 0 / skipped 0 / todo 0`. Exit 0. `duration_ms 316096.2115`. |
| Skips | none |

Files:

`architect-lifecycle-surface.test.ts`, `architect-tools.test.ts`, `architect-user-steering-tools.test.ts`, `build-runtime.test.ts`, `cli.test.ts`, `context-assembler.test.ts`, `control-server.test.ts`, `final-verification-completion.test.ts`, `final-verification-execution.test.ts`, `final-verification-integrity.test.ts`, `final-verification-observability.test.ts`, `final-verification-orchestration.test.ts`, `final-verification-profile.test.ts`, `final-verification-repair.test.ts`, `final-verification-review.test.ts`, `final-verification-scheduler.test.ts`, `guidance-review.test.ts`, `native-architect-runtime.test.ts`, `native-build-capabilities.test.ts`, `native-build-initialization.test.ts`, `native-build-manager.test.ts`, `native-final-verification-factory.test.ts`, `native-verifier-factory.test.ts`, `native-verifier-runtime.test.ts`, `plan-critique-authority.test.ts`, `plan-critique-runtime.test.ts`, `plan-critique.test.ts`, `process-recovery-control.test.ts`, `project-doc-commit.test.ts`, `project-docs.test.ts`, `repair-cycles.test.ts`, `replay-compatibility.test.ts`, `request-replan.test.ts`, `role-capabilities.test.ts`, `scheduler-store.test.ts`, `user-steering-runtime.test.ts`, `user-steering.test.ts`, `verifier-contracts.test.ts`, `verifier-observability.test.ts`.

Source sha256 (final restored bytes):

| File | Bytes | SHA-256 |
|---|---|---|
| `runner-v2/src/agent-prompts.ts` | 19728 | `6dc30ee9b10aee64d9652e1643edac0de136812bd168cb2b07590896d4f7d6aa` |
| `runner-v2/src/architect-tools.ts` | 96347 | `cf4790c675442ad325f0d20846e8b93de5f91a00a6e0b8dd1f44575d608cb6bf` |
| `runner-v2/src/build-runtime.ts` | 90181 | `fc893c5c677dad9b1b4994e8ec7c64473e8d9389dac053352b9cee7410d784b8` |
| `runner-v2/src/native-architect-runtime.ts` | 46845 | `944529d453c3a50974d143f02b8582a53cb17fcc8b7659e9190082cc1769bd43` |
| `runner-v2/src/scheduler-store.ts` | 246379 | `5b31c35ed6541b6ef525a9ff6dddc4d2d7d403f5e6328c23eee0197f5d963676` |
| `runner-v2/src/user-steering-contracts.ts` | 18038 | `d46c72c3171fce1538a8a0103c677e6fe62da121cab85ebb76554c7f809077cb` |

`user-steering-contracts.ts` is outside the brief's writable list. `retriesRemaining` has to be an optional field on `ArchitectActionReason` and an allowed exact key in `parseArchitectActionReason`, or the reason cannot be built or survive an `ask_user` checkpoint. `scheduler-store.ts` was named for `retriesRemaining` and also holds the `project_doc.abandoned` event, because a recovery event cannot be appended without a reducer case.

---

## 4. Static gates

| Gate | Exit | Note |
|---|---|---|
| `tsc -p runner-v2/tsconfig.json --noEmit` | 0 | `C:\Program Files\nodejs\node.exe` `./node_modules/typescript/bin/tsc`. No diagnostics. |
| `tsc --noEmit` | 0 | Same compiler, root project. No diagnostics. |
| eslint on the 10 changed files | 0 | `./node_modules/eslint/bin/eslint.js` on the six source files and four test files. No error or warning output. |
| `npm run build` | not run | No UI or client file changed. |

---

## 5. Defect-class checks

| Check | Result |
|---|---|
| Every variant tested, not just the first | H5 validation asserts newline, CR, NUL, and 201 characters in one test. Only the newline clause was injected. Recovery is tested for a newline summary plus a following valid README, including a second start that does not abandon again. Empty and NUL recovery were not separate cases. H2 tests the worker revision, the integration revision, and a checkout error with no second revision. H4 tests `stateCurrent` true and false, truncation, an abandoned line, and the runtime context. H1 tests the tool list, `retriesRemaining` 3 then 2, and empty plus whitespace waiver rationale. |
| The wiring is tested, not only an extracted helper | H4: omitting the section in `architectContextSections` reddens the NativeArchitectRuntime context test. H2: returning `integrationRevision` on review reddens the command-revision assertion. H1: registering the full list reddens the decision-turn tool list. H5: allowing a newline reddens `isError === true` before any request is recorded. |
| Every clause of every compound guard reddened individually | No. The specified injection per fix was reddened. Sibling clauses (`\r`, NUL, `maxLength`, empty recovery, the commit-error backstop) were not injected one at a time. |
| Invariants tested for difference | Review copy revision differs from the integration revision. `stateCurrent` is true when the STATE commit sequence is after the latest integration and false when it is not. `retriesRemaining` drops from the limit to limit-minus-one after one retry. |
| Every new exported function is called by a test | `CONTEXT_RECORDING_DECISION_GUIDANCE` is imported by `project-docs.test.ts`. `contextRecordingRetriesRemaining` is not imported by a test. `build-runtime.test.ts` asserts `request.reason.retriesRemaining`, which `resolveContextRecordingFailure` sets from that function at `build-runtime.ts:1724`. |

---

## 6. Independent review

| | |
|---|---|
| Reviewer | none. The implementing worker does not review this packet. |
| Findings | outstanding |
| Unresolved mandatory findings | outstanding. This packet is not accepted. |
| Repair cycles used | 0 of 3 |

Self-review is not independent review. No reviewer was available. This gate stays outstanding.

---

## 7. Cleanup and rollback

| | |
|---|---|
| Injections removed, regression tests retained | yes. Each injected file's sha256 matches the before hash in section 2. |
| `public/*.zip` left dirty, not staged | none created |
| Rollback | Revert this uncommitted packet. Durable shape added: scheduler event `project_doc.abandoned`, and optional `retriesRemaining` on `context_recording_decision_required`. Old checkpoints omit `retriesRemaining` and still parse. |
| New `node:fs` importer added to the reviewed owner list? | no |

## Independent review (controller)

| | |
|---|---|
| Reviewer | controller (Claude Opus 5.5); not the implementing worker |
| Findings | H5 closed at the tool and made recovery safe via a durable `project_doc.abandoned` event. H2 review copy at the submission `taskRevision`, no fallback. H4 `project-docs` context section built from committed artifacts, STATE text capped at 4 KiB. H1 per-reason guidance, `retriesRemaining`, decision turn limited to `resolve_context_recording` + `ask_user` (A1b required-three check relaxed for that reason only). Outside-list edits accepted: `user-steering-contracts.ts` (optional `retriesRemaining`, parser key) and `scheduler-store.ts` `project_doc.abandoned`. Token cost measured: about +64 per session plus the docs section per turn. |
| Independent re-verification | 39-file graph 534/534 (worker); controller re-ran architect-tools, project-docs, replay-compatibility, lifecycle-surface (below) |
| Unresolved mandatory findings | none |
| State | **ACCEPTED** |

