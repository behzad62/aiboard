# Runner V2 Task 10 / P6.4g — Trusted filesystem mutation fence

## Scope and baseline

Worktree: `D:\repos\ai-discussion-board\.worktrees\runner-v2-robust-build`.
Branch: `codex/runner-v2-robust-build`.
Accepted base: `f2916a21f270a64b8d3e4387350686680cb6bed2` (verified Task 9).
Task 11 remains PENDING and unstarted. No push is authorized or performed.

The immutable original `baseline.json` records 4,532 files, an empty index and 1,708 expanded unrelated dirty/untracked status entries. The resumed audit first verified 4,523 protected files. Two directly affected LSP fixture paths were subsequently added to the explicit Task 10 scope, leaving 4,521 protected files. `pre-final-review-audit.json` proves no unexpected content drift, missing protected files or unrelated status changes. The directly affected Windows smoke fixture and the causal concurrency-fixture correction expand final scope to 16 source/test paths, leaving 4,519 protected baseline files. `finish-source-freeze.json` proves these files and all 1,708 unrelated expanded status entries remain unchanged. No unrelated benchmark, UI, package, calibration, script or ZIP work is part of this task.

## Architecture and complete native mutation routing

`filesystem-mutation-fence.ts` is the single last-mile seam for native workspace filesystem tools and the discovered direct `.gitignore` bootstrap writer. `ToolBroker` remains the authorization authority. It captures actual workspace/parent/target identities before approval or grant issuance can yield, then binds a one-use opaque fence permit to the original exact grant, run, session, actor, tool and call. The permit does not grant new authority.

| Production caller | Trusted route | Mutation primitive |
| --- | --- | --- |
| `fs.write`, including new files and optional parents | `fencedWrite` | Exclusive staging, full-byte write and sync; revision-checked replacement rename or exclusive link publication |
| `fs.patch`, including text and multi-edit patches | `fencedPatch` | Validate expected revision, transform once, then the same staging/publication seam |
| `fs.move`, files and bounded directories | `fencedMove` | Create-only mkdir/link, revalidate both names, exact-source unlink/rmdir |
| `fs.delete`, including bounded recursive deletion | `fencedDelete` | Captured membership/identity checks followed by individual unlink/rmdir; never an unchecked recursive rm |
| Git baseline/bootstrap `.gitignore` update | `fencedWrite` through an existing run-owned grant | Captured prior-read SHA-256 and the same create/replacement rules |

`filesystem-mutation-routing.test.ts` checks native filesystem imports and all four tool routes, plus the bootstrap route. The reviewed import inventory also covers Runner-private artifacts, SQLite state, encrypted configuration, spools, process protocols, leases, browser-session persistence, and owned execution/worktree lifecycle. Those are existing private-state/command boundaries, not model-selected native workspace filesystem tools; Task 10 does not reroute them or claim a kernel sandbox for arbitrary child programs or plugins. The native-build factory's exclusive write is its private subprocess-state key, not an additional workspace-content writer.

## Mutation and revision semantics

Existing-file write and patch require a caller-observed 64-digit SHA-256. Missing, invalid or stale revisions return machine-identifiable refusals; ordinary reads remain unchanged and return their revision metadata. The fence reads through a verified handle, checks identity/metadata and the full digest, stages the entire replacement with exclusive `wx+`, syncs and position-rehashes the retained staging descriptor, then repeats the revision and path/authority checks at publication. Patch transformations never partially apply to the target. The LSP integration now demonstrates a real `fs.read` followed by a revision-bound replacement and original-grant post-write diagnostics.

New files are never silently overwritten. An exclusive sibling staging file is fully written before an exclusive hard-link publication to an absent destination. A competing creator produces `target_already_exists`; there is no rename-over-existing fallback. Filesystems or permissions that do not permit the required publication primitive fail typed, with the underlying OS code and recovery guidance. The temporary hard-link count of two is allowed only for the fence's exact captured two names; the staging name is then removed using verified ownership.

Moves revalidate source and destination, forbid existing destinations, and refuse cross-device publication rather than silently copying/deleting. Directory moves are bounded, stepwise create-only operations, not atomic directory transactions. Deletes use the authorization-time target identities and directory membership, refusing replacement objects or newly discovered entries. A multi-entry operation can have completed safe steps before a later refusal; `partialMutation`, `completedNamespaceSteps` and recovery guidance disclose this honestly. No speculative rollback follows changed paths.

## Alias, identity and hard-link policy

Every existing path component is checked with actual `lstat` identity and final canonical path, not lexical containment alone. Symlinks, NTFS junctions and observable name-surrogate reparse aliases are refused. Parent replacement, target replacement, alias retargeting, directory-membership substitution and late unexpected hard links are checked at the final seam. Ambiguous Win32 device, alternate-stream, UNC and trailing-dot/space path forms are refused. A configured workspace leaf alias remains forbidden by the original Task 8 policy; system-ancestor canonicalization does not relax that rule.

Regular-file confinement requires the expected link count. A pre-existing extra hard link is refused even when another name happens to be inside the workspace: the fence cannot prove that all aliases are authorized. Stable identity uses device/inode/type and Windows birthtime; POSIX creation-time generation evidence is used only when distinguishable from zero/ctime fallback. Unsupported stable identities and unsupported safe primitives fail typed. The implementation does not claim comprehensive handling of arbitrary filesystem/filter-driver reparse behavior beyond the identity/canonical primitives it can observe.

## Race model and platform limits — explicitly not atomic CAS

This implementation is **not atomic compare-and-swap**, not a kernel write-confinement sandbox, and not a transaction against external writers. A user/process outside Runner can race between the final checks and the OS mutation for rename, link, mkdir, unlink or rmdir. A controlled actual external child-writer test demonstrates that the syscall-gap replacement can still win; the test is evidence of the documented limitation, not a claim that the race was eliminated.

Windows requires closing the destination read handle before replacement rename on the tested host; identities and authority are checked again immediately afterward. POSIX retains that handle, rehashes with explicit positions (including short/empty reads), and checks again before rename. The additional POSIX cases are portable contract simulations on Windows; no Linux/macOS runtime success is claimed. Ambiguous-time POSIX inode-reuse ABA and unobservable alias/writer races remain residual limitations. Final metadata stamps detect observable changes, not every same-tick or metadata-manipulation race; no timestamp-based CAS guarantee is claimed. Atomic replacement preserves complete byte publication, not stronger ACL/xattr or crash-durability promises than the previous implementation.

## Grant and cleanup preservation

The original execution grant's issuer, exact paths/access, run/session/actor/call/tool binding, cancellation, revocation and issued state remain authoritative. One filesystem reservation is permitted per opaque grant; forged, reused, consumed, revoked, differently bound or broadened permits are refused. Post-write diagnostics can consume the original grant exactly as before, without a replacement grant. Delete also checks the original destructive approval. Existing move approval classification is preserved rather than silently changing the approved policy.

Cleanup authority is restricted to the owned temporary identity and still-valid parent, even after call cancellation. If cleanup ownership cannot be proven, the diagnostic object is retained with `filesystem_cleanup_unverified`; it is never deleted just to make accounting appear clean. Typed OS failures complete the durable ToolBroker ledger, so a completed side effect is not silently retried after restart.

## TDD, integrity review and causal reversals

The original inherited `initial-red` run failed 17 of 19 adversarial assertions; `red` retained 16 failures after fixture adjustment. The unfenced bootstrap reproduction failed both alias cases. These nonzero runs and their diagnostic roots are preserved, not counted as successful acceptance. Earlier `bootstrap-green-1` passed assertions but retained one diagnostic root; its name does not make it resource-clean acceptance.

Resumed review corrections were also test-first. `review2-red` failed all five cases, followed by `review2-green` passing all five with no retained roots. Those fixes retain the POSIX revision handle and rehash explicitly, classify hard-link publication capability errors, and provide canonical-spelling recovery without redirecting an existing grant. `review3-staging-red` failed all four real-filesystem staging-tamper cases; `review3-staging-green` passed all four. The corrected fence rehashes staged bytes both after flush and at publication and checks retained object stamps after intervening path checks. `review3-focused` passed 75/75. Independent `review-4` accepted the source correction; its supplied hashes still match the final code and tests.

The real LSP caller initially exposed an empty-environment Windows fixture failure, then a genuine `expected_revision_required` refusal after the non-secret OS bootstrap variables were supplied explicitly. Its repaired test now reads the real file, supplies that SHA-256, and verifies actual post-write LSP diagnostics and grant/session release. The directly affected runtime-smoke fixture needed the same explicit Windows bootstrap environment; production environment policy was not weakened.

Final representative deliberate regressions are recorded in `final-causal/causal-reverse-fault.json`. Removing final canonical/identity revalidation caused an actual write to the outside sentinel directory; allowing overwrite on create replaced a competing creator's contents. Each fault produced RED exit 1 and the exact forbidden file bytes, then byte-for-byte restoration produced GREEN with no retained roots. The restored fence SHA-256 is `48a61aa60deb472301f41cced009ef9ed60ff9e1061298dd1b547be69d4d9d3d`. These proofs remain current: no fence, dependency, or fence-test byte changed afterward. The later integration-manager test-only repair is not imported by either causal command; that narrow evidence reuse is checked explicitly, rather than rerunning unchanged faults for ceremony.

## Concurrency-fixture acceptance blocker — resolved without weakening safety

Two earlier expanded runs stopped at the unchanged concurrent-journal fixture. The loser could correctly refuse in `assertProjectUnchanged` before reaching its intercepted `update-ref`; the winning operation then waited forever for a signal that only that callback could send. The deterministic `integration-early-loser-red` reproduction logged the pre-CAS rejection and timed out. These failed runs, stopped-process receipts and retained diagnostic roots remain separate historical evidence.

The independently reviewed repair now releases the winner when the losing operation settles and explicitly exercises two schedules: real Git compare-and-swap rejection, and earlier project-state rejection. Each schedule asserts its actual CAS-attempt count, winning crash, rejected loser, exactly one surviving journal, correct recovery revision/content, and complete journal cleanup. A bounded test deadline prevents the previous indefinite hang. The exact reviewed snapshot was applied only after its source hashes and no-active-owner state were checked. `finish-fixture-regression` passed both cases with unchanged inputs and both roots removed. IntegrationManager production code is unchanged.

## Final acceptance cohort and evidence policy

`finish-affected-graph.json`, `finish-main.spec.json`, `finish-bootstrap.spec.json` and `finish-source-freeze.json` describe the final cohort: all 29 affected test files plus the three real baseline-bootstrap profile cases from `git-bootstrap.test.ts`. The unchanged historical read-only Git-query case intentionally retains failed-query diagnostic state and invokes no Task 10 mutation; its prior results and retained root are classified separately, not deleted or claimed clean. No failed mutation test is excluded, and both concurrent-journal schedules remain in the final graph.

Only the completed `finish-*` gates and the exact-source restored causal controls are eligible for accepted GREEN. Every accepted gate must exit 0, have stable before/after input hashes, and retain no owned resource roots. The acceptance audit verifies those facts and records the earlier RED/failed/intentional-diagnostic history separately. A separate process audit checks recorded process births, descendants, exact root references and live test/review wrappers, supplementing fixture-owned shutdown assertions. No audit deletes roots or kills processes.

Non-blocking follow-ups remain disclosed: revision-file size/I/O budgeting, ignoring retained temporary filenames in future baselines, tighter temporary permission metadata, and reserving native tool names against trusted extensions. They are not claimed delivered. The whole Runner/P6 suite remains reserved for Task 12; this work runs the affected graph and full Runner static checks only.

## Final results and acceptance

| Gate | Verified result |
| --- | --- |
| Complete affected Windows graph | 308/308 main + 3/3 bootstrap = **311/311**, zero failures, cancellations or skips |
| Repaired concurrency regression | 2/2, both actual refusal schedules |
| TypeScript | Exit 0, unchanged inputs |
| Full Runner ESLint | Exit 0, unchanged inputs |
| Runner diff whitespace | Exit 0 |
| Required causal reversals | Both RED with actual forbidden bytes; exact restore GREEN |
| Accepted resource cohort | 9 runs, 486 owned roots, zero retained |
| Process audit | 113 recorded birth identities and 569 distinct root references checked; zero live owned processes, matching roots or test/review wrappers |
| Protected baseline | 4519 files unchanged; no unexpected missing/drift; 1708 unrelated expanded status entries unchanged |

Evidence: `finish-acceptance-audit.json`, `finish-process-proof.json`, `finish-prestage-protected.json`, `finish-source-freeze.json`, and `requirements-review.md`. The raw input manifests and terminal receipts remain beside each run. Earlier failed and deliberately weakened runs are retained in the separate diagnostic history.

**Task 10 / P6.4g VERIFIED.** The approved requirements and reviewed fixture correction are satisfied on the exact current Windows source. Task 11 is next eligible but remains PENDING and unstarted; Task 12 and whole-P6 acceptance remain incomplete. No remote push or publication is performed.

The local closeout uses only the 16 frozen source/test paths, this Task 10 evidence directory, and the P6 completion plan. `finish-postcommit-proof.json` is the local post-commit receipt; it is deliberately created after the commit and therefore cannot be self-embedded in that commit. The tracked report remains unchanged after commit.

### Staged evidence representation

Runner source/tests and authored reports/scripts pass the staged whitespace checks. The full raw-evidence diff contains historical log/snapshot whitespace and CRLF-formatted process receipts; these are preserved rather than rewritten. `finish-staged-classification.json` records the distinction. An evidence-local `.gitattributes` disables line-ending conversion so captured bytes and hashes survive checkout; it does not affect Runner source or unrelated files.
