# Evidence — PF2

**Authoritative acceptance record for this packet.** One fact, one location. Reference other
records rather than copying them. Keep derived summaries identifiable as summaries.

| | |
|---|---|
| Packet | PF2 · prompt-review fixes part 2 (role prompt texts) · implementation |
| Requirements | H3, M2, M4, M5, M6 from `evidence/prompt-review.md`. M1, M3, M7–M12, L1–L8 not in scope. |
| Base revision | `11ea357c653b1f520504dececf57b422bd48cc11` |
| Uncommitted diff identity | `git diff --stat` of tracked edits, taken before this evidence file existed: 9 files, +244 / −38. SHA-256 of those files is in the table below. This evidence file is a new untracked file and is not in that stat. |
| Node | `C:\Program Files\nodejs\node.exe` v24.18.0 |
| State | IN_REVIEW |

Changed files (bytes / sha256 of the working tree after prove-red restore):

| File | Bytes | SHA-256 |
|---|---|---|
| `runner-v2/src/agent-prompts.ts` | 20852 | `b03a827377ac663ffc70f5fab77d6e2588a7f34141393cb8b32ed33f88670f6b` |
| `runner-v2/src/native-architect-runtime.ts` | 47062 | `c8734fedfde10618ad973f05cd34a1ae2fd13fea323a88fd79e0cb2c961a3157` |
| `runner-v2/src/native-verifier-runtime.ts` | 45959 | `c35cd727596c68221d68de182d0468a25ffd56807e524608eae10fca8ca5cc91` |
| `runner-v2/src/native-worker-driver.ts` | 25762 | `76a0bf75410bdf35bbe1d655c181170622265ff3e21e0079292e5733227147c4` |
| `runner-v2/test/native-architect-runtime.test.ts` | 75391 | `d35725054f5f3067f1916133566ebe86b944f15be56cbc0b9a592550ca58cda2` |
| `runner-v2/test/native-plan-critic-runtime.test.ts` | 38334 | `705ed9ee9cffb247ec7d07307550db01a1bb0f61ff6832e8ff2c22df80df9a1a` |
| `runner-v2/test/native-verifier-runtime.test.ts` | 51547 | `563e5db956791543e8054303e4524973c718d335c660b0380961c11765ed7de3` |
| `runner-v2/test/native-worker-driver.test.ts` | 31354 | `8a3165888bd703c0b12c6294f3980d33a287f615d947453ee3f65dd453e4c8a3` |
| `runner-v2/test/role-capabilities.test.ts` | 43846 | `75148213b56a8906d83110964b918012634b1204b74b1399a0b282b87ef69f4f` |

`runner-v2/src/native-plan-critic-runtime.ts`, `runner-v2/src/plan-critique-contracts.ts`, `runner-v2/src/worker-runtime.ts`, and `runner-v2/src/project-docs.ts` were not modified.

---

## 1. Acceptance conditions

| Requirement | Acceptance condition | Method | Outcome | Log |
|---|---|---|---|---|
| H3 | Worker system prompt says `` `docs/project/**` is maintained only by the Architect ``, that a change there fails integration, and to put decisions in the `submit_task` summary. `project-docs.ts` unchanged. | `buildWorkerSystemPrompt` unit test plus the failover test's sent-message assertion | pass | this file §2 and validation §3 |
| M2 | Architect system and resume text use "End each action with exactly one decision tool" and the `write_project_doc` does-not-end-the-action sentence. "one native lifecycle tool" and "exactly one semantically appropriate lifecycle tool" are absent. | architect runtime tests for the sent system message and the resume reminder | pass | validation §3 |
| M4 | Shared verifier invariants keep the prohibition sentence word-for-word. Pass 1 says BASELINE, read-only, `record_verification_expectations` exactly once. Pass 2 says the exact integrated revision and that commands may run there. Expectations context has no `verifier-authority` or `expectations-stage` section. | `verifierSystemPrompt` plus `buildVerifierExpectationsContext` / two-pass sent messages | pass | validation §3 |
| M5 | Inspection-only finish line is sent only when no verdict tool is registered. Authority invariants appear once, in the system message, not in the context. | inspection fixture (no verdict tool) and two-pass verdict fixture | pass | validation §3 |
| M6 | `PLAN_CRITIC_INVARIANTS` is the system message only. Context has no `critic-authority` section. The integration question is the review's wiring wording. Category id `missing_integration_task` unchanged. | plan-critic context unit test, sent critic request, manifest section assertion | pass | validation §3 |
| Tests | New line present; old contradictory phrases absent; no duplicate invariants in context; per-pass verifier text; verdict pass without the inspection-only line when the verdict tool exists. Existing prohibition assertion kept. | tests named in §5 | pass | validation §3 |

`missing_integration_task` has no separate description string in `plan-critique-contracts.ts`. The tool schema enum in `plan-critique-tools.ts` also has no description; that file was outside the writable set, so it was not edited. The model-facing question in `PLAN_CRITIC_INVARIANTS` is the clarification.

---

## 2. Prove-red

Hashes were printed after the injection and before the test process was started. Restore compared the file bytes to the pre-injection backup.

| Injection | File | Bytes / SHA-256 before → after | Applied? | RED signature (exact) | Restored byte-exact? |
|---|---|---|---|---|---|
| Re-add `required("verifier-authority", "system", VERIFIER_AUTHORITY_INVARIANTS)` to `buildVerifierExpectationsContext` | `runner-v2/src/agent-prompts.ts` | 20852 / `b03a827377ac663ffc70f5fab77d6e2588a7f34141393cb8b32ed33f88670f6b` → 20930 / `610257709d35f1954448b186a34a4b429413e2fe1bd5b1f3002190c3b9b17e31` | yes | `assert.equal(expectations.sections.some((section) => section.id === "verifier-authority"), false);` at `native-verifier-runtime.test.ts:649` — `true !== false` | yes, sha256 `b03a8273…0f6b` |
| Remove the H3 `` `docs/project/**` `` line from `buildWorkerSystemPrompt` | `runner-v2/src/native-worker-driver.ts` | 25762 / `76a0bf75410bdf35bbe1d655c181170622265ff3e21e0079292e5733227147c4` → 25560 / `7df2ea16e9562969bf0522bea87ab87edb7fb3ca6eae6e51a1d7cbeed2bed6a9` | yes | `assert.match(prompt, /`docs\/project\/\*\*` is maintained only by the Architect/);` at `native-worker-driver.test.ts:51` — input did not match | yes, sha256 `76a0bf75…47c4` |

The sent-worker-prompt assertion in "native worker fails over with the same session, context, tools, and evidence" checks the same sentence on the model request. A separate call-site bypass injection was started and then discarded: the injected source did not parse, so that run is not a RED of the assertion. It was restored to the same sha256 before validation.

---

## 3. Validation scope and rationale

| | |
|---|---|
| Affected graph | 12 files: `native-architect-runtime.test.ts`, `build-runtime.test.ts`, `project-docs.test.ts`, `native-plan-critic-runtime.test.ts`, `native-verifier-runtime.test.ts`, `role-capabilities.test.ts`, `native-build-capabilities.test.ts`, `native-worker-driver.test.ts`, `context-assembler.test.ts`, `final-verification-review.test.ts`, `final-verification-orchestration.test.ts`, `replay-compatibility.test.ts` |
| Why this scope | Every `runner-v2/test/*.test.ts` that imports a changed module, plus `replay-compatibility.test.ts` as required. Prompt text changes the Architect, worker, verifier, and plan-critic model input. New context packs omit `verifier-authority`, `expectations-stage`, and `critic-authority`. Replay parses stored manifests and does not rebuild those packs. |
| Concurrency | `--test-concurrency=1` (host and process fixtures in this set) |
| Result | `tests 207 / pass 207 / fail 0 / skipped 0` exit 0. Duration 190665 ms. |
| Skips | none |

Command: `"C:/Program Files/nodejs/node.exe" ./node_modules/tsx/dist/cli.mjs --test --test-concurrency=1` plus the 12 files above.

---

## 4. Static gates

| Gate | Exit | Note |
|---|---|---|
| `tsc -p runner-v2/tsconfig.json --noEmit` | 0 | `./node_modules/typescript/bin/tsc` via Node 24.18.0 |
| `tsc --noEmit` | 0 | repo root, same compiler |
| eslint on the 9 changed files | 0 | `./node_modules/eslint/bin/eslint.js` on the files in the identity table. Full-repo `eslint .` was not run. |
| `npm run build` | not run | no UI or client files changed |

---

## 5. Defect-class checks

| Check | Result |
|---|---|
| Every variant tested, not just the first | Verifier modes `expectations`, `verdict`, and `inspection` each asserted. Architect system message and resume reminder both asserted. Worker prompt asserted with a criterion id and with none. |
| The wiring is tested, not only an extracted helper | Two-pass and inspection tests compare the sent system message to `verifierSystemPrompt`. Critic request test compares the sent system message to `PLAN_CRITIC_INVARIANTS` and asserts the user context does not contain it. Architect tests match the sent system and resume strings. Failover worker test matches the H3 sentence in the sent messages. |
| Every clause of every compound guard reddened individually | The two mandated injections each reddened one assertion (§2). Other clauses (old phrases absent, inspection-only conditional, pass-2 command line) are asserted and were not separately injected. |
| Invariants tested for difference, not only sameness | New sentences are required; old contradictory phrases are `doesNotMatch` / `false`. |
| Every new exported class/function/tool is constructed or called by a test | `verifierSystemPrompt` and `buildWorkerSystemPrompt` are called by tests. `VERIFIER_EXPECTATIONS_PASS_INSTRUCTIONS`, `VERIFIER_VERDICT_PASS_INSTRUCTIONS`, and `VERIFIER_INSPECTION_ONLY_FINISH` are reached through `verifierSystemPrompt`. |

---

## 6. Independent review

| | |
|---|---|
| Reviewer | outstanding — implementing worker cannot review this packet |
| Findings | none recorded |
| Unresolved mandatory findings | gate open |
| Repair cycles used | 0 of 3 |

---

## 7. Cleanup and rollback

| | |
|---|---|
| Injections removed, regression tests retained | yes; post-restore sha256 matches the identity table |
| `public/*.zip` left dirty, not staged | no zip changes |
| Rollback | revert the 9 files. No durable store schema change. New runs omit three context section ids; captured historical manifests still parse (`replay-compatibility.test.ts` passed). |
| New `node:fs` importer added to the reviewed owner list? | no |

---

## Token effect

Measured as JavaScript string length (these prompts are ASCII, so characters equal bytes). Tokens are `chars / 4`. Context removal counts the `## SYSTEM: <id>\n` header plus the 2-byte section joiner. Unchanged surrounding prompt text is not included, so the delta is the change in what that role newly sees or stops seeing.

| Role surface | Before chars (ceil/4) | After chars (ceil/4) | Delta chars | Delta / 4 |
|---|---|---|---|---|
| Worker system prompt | 751 (188) | 945 (237) | +194 | +48.50 |
| Architect system opener (every turn) | 88 (22) | 199 (50) | +111 | +27.75 |
| Architect resume line (resume only) | 157 (40) | 263 (66) | +106 | +26.50 |
| Verifier pass 1: expectations system plus the two removed context copies | 1252 (313) | 623 (156) | −629 | −157.25 |
| Verifier verdict: system plus the removed context copy | 1538 (385) | 764 (191) | −774 | −193.50 |
| Verifier inspection (no verdict tool): system plus the removed context copy | 1284 (321) | 641 (161) | −643 | −160.75 |
| Plan critic: system plus the removed context copy | 1970 (493) | 1094 (274) | −876 | −219.00 |

A resumed Architect turn pays both Architect rows. The worker row is the static system prompt with no criterion line; a criterion line is unchanged and is not in the delta.

## Independent review (controller)

| | |
|---|---|
| Reviewer | controller (Claude Opus 5.5); not the implementing worker |
| Findings | Prohibition sentences kept word-for-word (`agent-prompts.ts:54`, critic `:287`). Duplicated invariants removed from verifier and critic contexts; per-pass verifier text; verdict pass has one finish instruction; worker told `docs/project/**` is Architect-only; Architect told `write_project_doc` does not end the action. Net tokens: verifier −157 to −194, critic −219 per session; worker +49, Architect +28 per session. No finding. |
| Independent re-verification | verifier, plan-critic and worker-driver tests 63/63 pass |
| Unresolved mandatory findings | none |
| State | **ACCEPTED** |

