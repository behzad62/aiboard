# Independent review response (Task 10)

Review 1 was a single read-only CLI turn, no tools, no permission denials. Its
claim to have written a plan was not evidence: the subsequent protected audit
found zero unexpected changes. Raw response/usage/terminal are preserved.

F1: Addressed with device/inode/type plus Windows birthtime and, on POSIX,
creation-time evidence only when capture distinguishes it from ctime/zero.
Node explicitly documents the ctime/zero fallback; libuv also uses statx when
available, so the review's blanket assertion that all Linux uses ctime was too
broad. Two portable contract fixtures cover ambiguous fallback and a distinct
birthtime generation change. Ambiguous-time inode ABA remains a stated residual.
Ubuntu WSL is present but has no Node; no Linux/macOS execution claim is made.
Sources: https://nodejs.org/docs/latest-v24.x/api/fs.html#stat-time-values and
https://raw.githubusercontent.com/libuv/libuv/v1.x/src/unix/fs.c (statx/fallback).

F2: OS failures at the effect seam are typed filesystem_operation_failed,
carry completed namespace-step accounting, and complete the tool ledger.
Capture-time errno also becomes typed. Real Windows held-open-destination and
SQLite restart/replay fixtures exercise this; final results are in the gates.
F3: Original destructiveApproved is now checked for fs.delete at the seam.
The recommendation to reclassify fs.move was rejected: the accepted Broker
policy already treats logical move as a non-destructive relocation. Its data
is retained at a create-only destination, and exact source delete/destination
write grants still apply. A project-profile compatibility test checks this.
F4: Addressed: failures carry partialMutation/completedNamespaceSteps/recovery.
F5: Addressed: successful temp create followed by unprovable identity returns
filesystem_cleanup_unverified with the retained temporary. It never deletes
an unproven replacement merely to make the resource ledger clean.

F6: Preserve the existing Task 8 root policy: a configured leaf workspace
symlink/junction remains forbidden. Canonicalization handles aliases in system
ancestors before capture, not an exception that bypasses the grant root check.
An exploratory root-alias compatibility fixture exposed the policy conflict;
root-policy-red and the restored strict guard preserve the original authority.
F7: Atomic replacement preserves bytes, not ACLs/xattrs or crash durability.
Permission metadata was not promised by the prior temp/rename implementation;
no stronger claim is added. Captured mode is passed to exclusive temp creation.
F8: Exact host paths remain intentional operator diagnostics for identity and
retained-resource failures, as requested by the evidence/recovery contract.
They are not new authority or a cross-user disclosure channel.
F9: Alias/hard-link refusals are required by the approved task, not relaxed for
convenience. Split operations exceeding the bounded manifest are explicit.
F10: Depth is now bounded at 64 and entries at 10000. Final canonical checks are
not cached: caching them would weaken the required immediate revalidation.
The synchronous critical section is bounded but may block the event loop.
F11: Existing createDirectories/recursive semantics are preserved: derived
entries belong to the captured exact operation, not a reusable subtree grant.
No parallel permission/approval system is added.
F12: The module header now explicitly covers final-name syscall races for ALL
write/create/mkdir/link/rename/unlink/rmdir paths, not just content replacement.

Additional coverage: late hard links, consumed grants, run/session/actor/call/
tool/grant/path-spelling replay, Win32 devices/ADS, changed directory membership
both before and after preflight, late move destination/source races, original
post-write diagnostic consumption, and a closed reviewed native-FS import audit.

Acceptance remains pending final reverse-fault, affected-graph and audit proof.

## Review 2 resolution and resumed independent caller audit (2026-09-15)

The three requested corrections were reproduced with five new failing tests in `review2-red` (0/5, input hashes unchanged; diagnostic roots retained), then repaired in `review2-green` (5/5, no retained roots).

- M1: POSIX now keeps the final destination read handle through publication and rehashes using explicit read positions (the previous read advanced the descriptor to EOF). The bounded loop handles short reads and empty/multi-chunk files; identity, size, timestamps and digest are checked again. Windows still closes the destination handle before rename because the actual host rejects replacement otherwise. Both paths explicitly remain non-CAS. The controlled POSIX-contract writer test now refuses a same-object content change after the prior revision read.
- M2: New-file hard-link publication failures EPERM/EACCES/EMLINK, as well as cross-device/unsupported primitive errors, now return `filesystem_safety_unsupported` with the actual OS code and actionable recovery. This is deliberately scoped to the publication primitive: no overwriting or partial-content fallback is added and unrelated permission errors keep their normal typed outcome.
- M3: Exact canonical-spelling refusal now returns `canonicalPath` and asks for a newly authorized request using that spelling. It does not infer POSIX volume case sensitivity or broaden the original grant. Windows case handling is unchanged.

Additional fixtures exercise explicit parent creation, a competing mkdir winner, cross-device move refusal, retained POSIX descriptor lifetime/cleanup, and a stale Git-bootstrap prior read. `review2-focused` passed 64/64 (62 owned roots, all removed); the POSIX cases are contract simulations on Windows, not Linux/macOS execution claims.

The complete caller search also found an old missing-revision write in `lsp-real-host.test.ts`. Its first run (`lsp-migration-red`) failed before the filesystem call: the test-only shared host had an empty environment, and the native Node child aborted with `ncrypto::CSPRNG(nullptr, 0)` (exit 134). The immutable log and its four diagnostic roots remain. This is not mislabeled as an expected-revision RED.

The test helper now accepts an optional explicit environment without changing the existing default. Only the affected real-host test supplies the existing seven-key non-secret Windows bootstrap whitelist; production environment policy and process-host code are untouched. With that fixture correction, `lsp-revision-red` reached the filesystem call and failed specifically with `expected_revision_required`; its root is retained. The test now asserts that refusal, performs a real `fs.read`, and supplies the observed SHA-256 to the replacement. `lsp-migration-green` passed 1/1, including actual Windows LSP post-write diagnostics, exact fresh grants, agent isolation, release and shutdown assertions; all four owned roots were removed.

`typecheck-review2` passed on the resulting source. The protected audit `pre-final-review-audit.json` verifies 4,521 unchanged protected files and all 1,708 unrelated expanded status entries; the only two additional allowed paths are the directly affected LSP test and its optional-argument fixture helper. Final affected-graph, reverse-fault and acceptance checks are still required; these interim results alone do not mark Task 10 verified.

## Final integrity review and correction

Review 3 accepted the earlier fixes but identified staged-byte tampering through the same temporary inode: path identity alone did not prove that the bytes about to be published were still the intended bytes. Four new real-filesystem fixtures (create/replacement, each at post-flush and later publication timing) reproduced false success in `review3-staging-red`: 0/4 passed, four diagnostic roots retained. The RED fixtures were first run from an evidence-only copy while the earlier expanded test run held product inputs frozen; the identical fixture text was then appended to the product test file before the repair.

Staging now opens with exclusive `wx+`, rehashes the retained descriptor with explicit read positions after flush and again immediately before publication, and verifies source/staging identity and size/time stamps after intervening path checks. Staging mismatches produce `filesystem_identity_changed` with no published namespace step. Existing target revision checks remain SHA-bound; neither cleanup ownership nor original grant authority is relaxed. `review3-staging-green` passed 4/4 with all four roots removed. The complete focused filesystem graph in `review3-focused` passed with all 73 owned roots removed; `review3-typecheck` exited 0.

Review 4 independently accepted the correction with no new must-fix defect. Its read-only CLI invocation had no tools, no permission denials and unchanged supplied input hashes. Its acceptance is source-review evidence, not a claim to have run Windows tests or seen the RED log. The local acceptance audit verifies the actual RED/GREEN receipts separately. One reviewer sentence overstated timestamp protection: the accepted report continues to describe all platform final-check/syscall gaps as non-CAS, including metadata-resolution or metadata-manipulation limitations. The non-blocking ignore-pattern, size-budget, tighter staging-mode and extension-name suggestions remain explicit follow-ups, not silently claimed deliverables.

The final required reverse-fault proof was repeated after the integrity repair, in `final-causal/`. Both deliberate faults produced the actual forbidden bytes, not merely harness failures. Each exact source restoration returned GREEN. The accepted fence SHA-256 is `48a61aa60deb472301f41cced009ef9ed60ff9e1061298dd1b547be69d4d9d3d`; earlier reverse-fault receipts remain historical, not final-source proof.

## Expanded integration diagnostics and precise final cohort

The earlier `final-affected` run is a FAILED diagnostic run despite its name: 279/282 assertions passed; two Windows runtime-smoke cases failed and one integration-manager test process was stopped after its existing concurrent-journal latch made no progress for over six minutes. The exact stopped PID, birth time, command, zero descendants and reason are recorded in `blocked-integration-process-tree.json` and `blocked-integration-stop.json`. The root was preserved. An instrumented, bounded copy of that unchanged concurrency fixture subsequently passed; that does not establish the cause of the earlier hang and is not substituted for the original fixture in final acceptance.

The two smoke failures reproduced the test-only empty-Windows-environment problem already diagnosed in the LSP fixture (Node exit 134, not the expected child behavior). Only `final-verification-runtime-b1.test.ts` now supplies the existing minimal non-secret OS bootstrap environment to its owned host. `smoke-environment-green` passes all four original smoke cases, including success, intended exit, timeout and cancellation; all 20 owned roots are removed. No production process-host or integration-manager code is changed.

The expanded run also exercised an unchanged Task 9 read-only historical-query test whose callback deliberately throws `undefined`. Its production contract closes all owners but retains failed-query diagnostic state. This test does not invoke Task 10 mutations or baseline bootstrap. Its passing assertions and retained directory are preserved as diagnostic evidence, not relabeled clean or deleted. The final affected manifest runs all 29 other files unchanged plus all three baseline-bootstrap profile cases from `git-bootstrap.test.ts`; only the separate, unchanged historical-query diagnostic case is outside the resource-clean Task 10 cohort. The original concurrency test remains included, with no skipped or weakened assertion.

## Final closeout — 2026-09-15T08:29:52.747Z

The reviewed exact concurrency-fixture snapshot is now applied. Both rejection schedules pass in the actual test file and the complete final graph. Final 311/311 affected checks and static gates are green; 486 accepted roots are absent after verified fixture cleanup, and the exact process audit is clean. Earlier failed `acceptance-main` is not used as GREEN evidence. `finish-source-freeze.json` binds the 16 final source/test files; `finish-prestage-protected.json` checks 4519 other files and 1708 unrelated status entries without drift. Task 10 is VERIFIED; Task 11 remains PENDING.
