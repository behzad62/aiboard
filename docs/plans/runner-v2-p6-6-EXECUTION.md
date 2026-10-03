# runner-v2-p6-6 — EXECUTION

The only plan and the only progress record for Runner V2 P6.6 from 2026-09-30 on. It follows the
planning standard installed 2026-09-30 (`C:\Users\b_a_s\.claude\plan-standard.md`, prompt version
2026-09-29b); its verbatim copy is at the end of this file and a resumed session follows that copy.

**Migration (owner, 2026-09-30, "2").** P6.6 started under the superseded planning standard. From
2026-09-30 this file replaces `progress.md`, lane state and `evidence/*.md` as the progress record.
Nothing new is written to those old files. The one exception: the two Muse runs briefed before the
migration (C2e repair 2, PX-2e) may append once to their own evidence file. The old files stay in git
until the closing PR (D-11). Stage 1 status: **DECISIONS ANSWERED 2026-10-01** (owner: "all recommended"); Stage 2 running. Coverage review r1 (fresh read-only reviewer, 2026-09-30): GAPS — 17, all
fixed in this revision.

## Owner continuation amendment — 2026-10-02

Codex takes over development from Claude session `c3a6c726-b6f1-47ec-bea6-214ebdabe566`.
The owner's current instruction overrides the prior testing and reviewer schedules, including
section 1's layers 1–3, CD-22 and broad-validation clauses in SOURCE and the verbatim prompt:

- Per new task/packet, run only that packet's tests. Do not run the rest of the tests, affected
  importer groups, broad handoff/native-delivery groups or phase-end broad suites. Keep fast
  typechecking, lint for changed files and diff checks. Do not weaken safety assertions or hide
  failures in the selected tests.
- Run the full suite and repair integration problems at the end of P6.6 (T8). Keep phase-specific
  acceptance scenarios, selected as that phase-exit item's own tests; broad regression coverage
  moves to T8. Record what was deferred in packet PR descriptions. Existing CI reports remain
  historical evidence; do not intentionally launch broad gates for intermediate packets.
- Implementation: Muse Code `muse-spark-1.3-contributor`, medium effort (the existing setup).
  Independent review: a fresh GPT-6.1 Sol agent at high effort. CD-4's review rules still apply.
- Preserve accepted commits and use isolated worktrees. Protected merges remain owner actions
  under D-3 until separately delegated. All P6.6 work stays off production main until T8/REL-1.

Takeover checkpoint: C3a `863814ee` received independent GPT-6.1 Sol ACCEPT (read-only, no
blocking findings). Its dedicated `docs-policy-v2-stop-snapshot.test.ts` passed 19/19, zero skips
(881.6 seconds), on 2026-10-02; typecheck and changed-file ESLint passed. The old 11-file affected
run is deferred under the owner's rule. C3a is locally accepted, with protected merge pending. C3a is published as stacked draft PR #106 on INT-1. C3b initial candidate `f4bd6ebc` is
is repaired at `8c597d04` in `.worktrees/p66-c3b`, branch `exec/runner-v2-p6-6/C3b`, based on
accepted C3a. GPT-6.1 Sol high ACCEPT; notes-denial proof passed with exact restoration. Initial
fixture/source failures and the repair-delta gate failure were resolved in two Muse repair
cycles. Only C3b packet tests ran; prior unchanged evidence was reused. No tests were interrupted. INT-1 PR #105
remains open, with 10 passing portable checks and the two recorded F-10 benchmark failures.
Local prerequisite implementation may continue in stacked branches while protected PRs wait;
items are not declared merged or P6.6 complete until the integration/release obligations close.

## 0. Source, base, branches and entry check

| Id | SOURCE | sha256 |
|---|---|---|
| SRC-P | `docs/superpowers/plans/2026-09-06-runner-v2-evidence-gated-planning.md` (parent plan: tasks T1-T10, ledger EP01-EP52, owner decisions OA-1..OA-18). An older 471-line version is on origin/main; the current file is on lane A. | `4619c1cfb5261bd94f7aee1f31c5a800556f85ba0fe88d36ef5bec99caeb57dc` |
| SRC-A | `docs/superpowers/plans/2026-09-27-runner-v2-p6-6-architecture-correction.md` (amendment: owner decisions AR-1..AR-4, controller decisions CD-1..CD-23, ledger AR-R01..AR-R32, packet contracts, P7 list). Lane A only. | `3fc9ac5d3091f9d35e3d66196fcc5d7897081b96083262038714b9837312a853` |
| S1 | `.superpowers/sdd/2026-09-06-runner-v2-evidence-gated-planning/evidence/external-architecture-audit-2026-09-27.md` (input SRC-A evaluated) | `1b161a91f8816318eb2d68d886b22b84a11c00b64b1dc5e997441b236b5c9ef9` |
| S2 | `.../evidence/architecture-investigation-2026-09-27.md` (findings SRC-A routes) | `467160032f944f6bba077752980ba85ef00b2fbb402e880c4305a572b7994879` |
| S3 | `.../evidence/EX4-lessons-audit.md` ("Recommended packets 1-4" = E1-E4; backlog rows) | `33ff37a83563aef754d1db0b5ca66dd1c61dda98266c051bbcb32981509e16c3` |

- Base commit (origin/main at Stage 1, 2026-09-30): `9d697978`.
- Lane A: worktree `D:\repos\ai-discussion-board\.worktrees\runner-v2-p6-6`, branch
  `codex/runner-v2-p6-6` @ `afeb8a9b`: 32 commits not on origin/main; origin/main is 54 commits past
  the merge base `3cae2b70`. Never pushed.
- Lane C: worktree `D:\repos\ai-discussion-board\.worktrees\runner-v2-px1`, branch
  `codex/runner-v2-px1` @ `16648709`. It branched from lane A at `83f89cf5`, so of its 39 commits not
  on origin/main, 24 are lane A's (T1-C2c) and 15 are PX work. Never pushed.
- Entry check (2026-09-30): no open PRs. Since the merge base, origin/main changed 14 `runner-v2`
  files; 3 of them were also changed on lane A (`agent-contracts.ts`, `agent-loop.ts`,
  `native-build-factory.ts`, a serialized surface); `git merge-tree` shows no text conflict;
  `worker-runtime.ts` (an IV-1 surface) also changed on main. Other worktrees (`cap-lane-a`,
  `runner-v2-p6-5`, `runner-v2-robust-build`) hold no unmerged work for this plan. Stale:
  `runner-v2-p6-6-t5` (T5, already merged into lane A as `6286a9ee`).
- Tool check (2026-09-30): `gh` logged in with admin on `behzad62/aiboard`; merge commits allowed;
  `main` unprotected. Four GitHub workflows exist (section 1). Baseline (INT-1, 2026-10-01, merged
  tree `98d37bad`): `typecheck:runner-v2` exit 0 (10 s); eslint `runner-v2` 0 errors, 6 warnings
  (18 s). Layer-2 group times on that tree: handoff group 44 min, large-tree 46 min, native-delivery
  7 min, Windows Job suites 3 min, replay-compatibility and audits 2 min.

## 1. Repo bindings for this repository (proposed; decision D-1)

The prompt's PROJECT BINDINGS name the DealFactory repo (ACS, host PHP, MariaDB, `C:\df-exec`,
`ship-pr.ps1`, "CI is off"). None of that holds here. Proposed equivalents:

- **Checkouts:** one git worktree per writer under `D:\repos\ai-discussion-board\.worktrees\`. The
  prompt prefers clones because the DealFactory ACS selftest rewrites shared git config; that tool does
  not exist here. `node_modules` is a directory junction to lane A's; a worktree holding the junction
  is removed only after the link itself is removed (`cmd /c rmdir <wt>\node_modules`).
- **Writers:** at most two writing agents (Muse Code, model `muse-spark-1.3-contributor`, effort
  medium), each in its own worktree, run as background tasks of the controller's shell (owner,
  2026-10-01); Claude is the controller and never writes in a worktree while a writer runs there.
- **Verification:** local runs are the evidence: `env -u NODE_TEST_CONTEXT
  "/c/Program Files/nodejs/node.exe" ./node_modules/tsx/dist/cli.mjs --test <files>`,
  `npm run typecheck:runner-v2`, eslint on changed files, `git diff --check`. Runner tests use real git
  and real SQLite; there is no ACS, PHP or MariaDB. **CI exists:** `runner-v2-portable-execution.yml`
  (every PR and push to main; Windows, Linux, macOS on Node 24.x; six runner-v2 test files),
  `benchmark-tests.yml` (every PR and push to main), `runner-v2-qualification.yml` (manual, or a PR
  labelled `runner-v2-qualification`), and `deploy-aiboard.yml` (**every push to main deploys to
  production**: publishes the runner downloads, builds the static site, rsyncs to aiboard.me). PR CI is
  extra evidence (D-1).
- **GATE-SCHEDULE mapping:**
  1. Every PR: the exact failing tests; the new or changed tests; the files that own them; the directly
     affected files (CD-22, about 10-15 minutes); typecheck; eslint on the changed files; PR CI green or
     each red shown to exist on the target branch without this change.
  2. Protected PRs (section 7): layer 1 plus the broad group the change affects (the handoff group,
     the native-delivery files, the Windows Job suites) on the head, plus the independent review.
  3. End of each phase (section 4 exits): in a worktree at the latest integration target, the broad
     groups for everything the phase touched — the 7 handoff files together, the large-tree file
     alone, the 6 native-delivery files, the Windows Job suites, replay-compatibility and the audit
     suites — plus every test that references a name the phase deleted, plus the phase's SOURCE exit
     check.
  4. Once at T8 on the final candidate: `npm run test:runner-v2`, `npm run typecheck:runner-v2`,
     `npm run lint`, `npm run build` (never while a dev server runs: it corrupts `.next`), the
     feature-specific Playwright gate (`npm run test:e2e` journeys named in T7d), package/source
     parity and the supported-platform contract checks.
- **Shipping (depends on D-2):** branch `exec/runner-v2-p6-6/<item ids>` from the latest integration
  target; PR with `gh pr create`; merge commits only (`gh api -X PUT
  repos/behzad62/aiboard/pulls/<N>/merge -f merge_method=merge -f sha=<head>`); take in the target by
  merging, never by rebasing. The PR description holds: the item's definition of done; the validation
  scope (what ran with counts, what did not and why); the independent review verdict and findings;
  prove-red records (sha256 before/after, byte-exact restore); the attempts; any per-packet table SOURCE
  asks for (for example C3's stop table, C4's token counts).
- **Independent review per code item** (owner standing rule, 2026-09-29; CD-4): a fresh
  `code-reviewer-sonnet` agent (Sonnet, effort xhigh) reviews each code item before merge; findings go
  into the PR description (certify-once).
- **Attempt log:** `C:\Users\b_a_s\AppData\Local\Temp\p6-6\runner-v2-p6-6-attempts.log` (outside the
  repo). **Repair budget:** 3 cycles per failure signature across sessions and agents (the prompt's ACS
  constants do not exist here). Owner rule: after a failed second cycle of a complicated item, the
  controller does cycle 3 itself; if that fails too, the item is BLOCKED with a GitHub issue (the
  standard) unless the owner says otherwise.

### 1.1 Packet rules for every open code item (from SRC-A; binding)

- **CD-4:** a fix re-review checks each prior finding and the fix delta in both directions. After a
  first review, a new blocking finding on unchanged reviewed code counts only if it is critical or
  backed by a failing test; other late findings go to the follow-up list. A component that fails closed
  on unknown input is accepted.
- **CD-7:** every item that changes runtime behaviour has at least one test built through
  `NativeBuildFactory` and driven by `BuildRuntime.step` on real SQLite. "Library only" is never an
  accepted end state.
- **CD-10:** no P6.6 code reaches a user before T8 is accepted (see D-2 for how merges respect this);
  a new-policy shape change after a user could run it bumps the planning-policy version and adds replay
  fixtures.
- **CD-12:** the EP06 contract fields stay required.
- **SRC-A section 6 preamble:** never delete an event type or reducer branch; every stored log replays
  unchanged; processes only through the audited execution paths (no `child_process` in new product
  code); preserve file encodings exactly (no BOM added or removed, no line-ending flips); nothing is
  recorded as performed unless it was performed; prove-red records sha256 before and after with a
  byte-exact restore.
- **CD-22 (validation):** per item, only the new or changed tests, their owning files and the directly
  affected files; expand only on a failure, a shared or public contract change or a reviewer's named
  risk; broad groups at phase exits; the full suite once at T8.

## 2. Coverage map

Every SOURCE obligation maps to an item in section 3. "✓" means accepted under the superseded
standard (independent review ACCEPT plus controller validation) and committed on a branch; it reaches
the integration target through INT-1 (D-2).

### 2.1 SRC-P ledger EP01-EP52 (owner task from SRC-P section 6)

| EP | Obligation (short) | SRC-P owner | Items |
|---|---|---|---|
| EP01 | Entire source and approved amendments retained and inspected; repository facts cannot weaken scope | BP1; T1,T2 | T1 ✓, T2 ✓ |
| EP02 | Stable ledger preserves mandatory, conditional, compatibility, operational, security and non-functional oblig… | BP1; T1,T2 | T1 ✓, T2 ✓ |
| EP03 | Exactly one accountable phase per requirement with contributing task mapping | BP1; T1,T2 | T1 ✓, T2 ✓ |
| EP04 | Bidirectional traceability excludes omissions/unrelated work, preserves conditional denominator and authorize… | BP1; T1,T2,T3 | T1 ✓, T2 ✓, T3a ✓, T3b ✓ |
| EP05 | One independent original-source coverage review; corrections scoped; unavailable review outstanding, never re… | BP2; T3 | T3a ✓, T3b ✓ |
| EP06 | Every phase/packet defines outcome, scope/exclusions, writable/forbidden surfaces, required base, contracts/s… | BP1; T1,T3 | T1 ✓, T3a ✓, T3b ✓ |
| EP07 | Meaningful packet sizing includes tests/config/docs; bounded investigations specify question, deliverable, de… | BP2; T3 | T3a ✓, T3b ✓ |
| EP08 | Phases are acceptance boundaries; unrelated phases do not block eligible tasks | BP3; T4 | T4 ✓ |
| EP09 | One authority per fact; skeleton/ledger first; resumable incremental planning coverage and execution checkpoi… | BP1; T2,T3,T7 | T2 ✓, T3a ✓, T3b ✓, T7a (open), T7b (open), T7c (open), T7d (open), C4 (open; AR-R13 amends the checkpoint mechanism per AR-2) |
| EP10 | Resume reads indexed contracts/source, inspects applicable branches/worktrees/revisions/processes/PRs, reconc… | BP1; T2,T5,T6 | T2 ✓, T5 ✓, T6a ✓, T6b ✓ |
| EP11 | Acyclic DAG with isolated branches/worktrees/runtime resources; exclusive claims via atomic mechanism or seri… | BP3; T4 | T4 ✓ |
| EP12 | Shared surfaces serialize; one integration owner/order; affected cross-boundary validation | BP5; T4,T6 | T4 ✓, T6a ✓, T6b ✓ |
| EP13 | Actual dependency/resource/capability eligibility; maximum four new-policy implementation workers, lower conf… | BP3; T4 | T4 ✓ |
| EP14 | Non-executing native chips only with observed support; otherwise complete reference-based lane/controller/res… | BP5; T1,T7 | T1 ✓, T7a (open), T7b (open), T7c (open), T7d (open) |
| EP15 | Source-derived prepare/negative/change/targeted+affected/review/repair/integrate loop; behavioral impact rati… | BP4; T5,T6 | T5 ✓, T6a ✓, T6b ✓ |
| EP16 | Full suite reserved for final candidate except explicit mandates; conflicts surfaced, not ignored | BP4; T5,T8 | T5 ✓, T8 (open), IV-2 (open; CD-23 wires the rule into task acceptance) |
| EP17 | Meaningful intended-boundary RED/GREEN or justified alternative; no redundant same-defect mutation; distinct… | BP4; T5 | T5 ✓ |
| EP18 | Evidence identifies requirement/check/snapshot/dirty delta/method/environment/outcome/counts/artifacts; no ze… | BP4; T5 | T5 ✓ |
| EP19 | Reuse accepted evidence only with relevant code/dependency/config/environment unaffected and rationale | BP4; T5 | T5 ✓, V2 (open; AR-4 amends to exact-identity reuse; semantic reuse → P7) |
| EP20 | Invalidate affected requirements/tasks only; concise inspectable evidence without transcript duplication | BP4; T5,T6,T7 | T5 ✓, T6a ✓, T6b ✓, T7a (open), T7b (open), T7c (open), T7d (open) |
| EP21 | Worker cannot self-accept; one combined independent deliverable review; extra specialist review justified | BP5; T6 | T6a ✓, T6b ✓ |
| EP22 | Rerun/re-review only concrete concerns, corrections and affected behavior; phase reconciliation reuses valid… | BP5; T6 | T6a ✓, T6b ✓ |
| EP23 | All mandatory packet criteria, valid evidence, independent review, integration checks and durable acceptance;… | BP5; T1,T6 | T1 ✓, T6a ✓, T6b ✓ |
| EP24 | Phase accepts only all owned requirements/exit checks; intermediate states never completion verdicts | BP5; T6,T7 | T6a ✓, T6b ✓, T7a (open), T7b (open), T7c (open), T7d (open) |
| EP25 | Default three substantive correction-plus-validation cycles per stable blocking issue unless explicit project… | BP5; T6 | T6a ✓, T6b ✓ |
| EP26 | Unrelated non-critical findings assigned separately; only critical issues or genuine acceptance dependencies… | BP5; T6 | T6a ✓, T6b ✓ |
| EP27 | Independent original-source/amendment-to-integrated-delivery reconciliation before expensive final suite; eac… | BP6; T8 | T8 (open) |
| EP28 | Required full suite on final candidate; batch corrections and revalidate affected scope before fresh final ga… | BP6; T8 | T8 (open) |
| EP29 | Final acceptance has no omitted obligation/open mandatory failure, accepted integration, current final valida… | BP6; T8 | T8 (open) |
| EP30 | Every revised section-10 output is available: traceability, phases/contracts/DAG/ownership, durable state/evi… | BP5; T7 | T7a (open), T7b (open), T7c (open), T7d (open) |
| EP31 | Exact plan-ready/blocked, phase verified/incomplete and all-applicable-program-complete verdicts; worker cont… | BP5; T3,T6,T7 | T3a ✓, T3b ✓, T6a ✓, T6b ✓, T7a (open), T7b (open), T7c (open), T7d (open) |
| EP32 | Planning performs inspection/documents only; execution instructions apply later, with no tests/migrations/imp… | BP2; T3,T7 | T3a ✓, T3b ✓, T7a (open), T7b (open), T7c (open), T7d (open) |
| EP33 | The coverage reviewer derives and durably records obligations from the source and amendments (and, for a Buil… | BP2; T3 | T3a ✓, T3b ✓ |
| EP34 | One verdict per derived obligation — `covered`/`weakened`/`missing`; four additive categories `missing_covera… | BP2; T3,T6 | T3a ✓, T3b ✓, T6a ✓, T6b ✓ |
| EP35 | `unverified_claim` is decided mechanically where possible — the cited record exists and its command, exit, re… | BP4; T5 | T5 ✓ |
| EP36 | The deliverable review forms findings from the source criteria and the exact diff **before** it sees the work… | BP5; T6 | T6a ✓, T6b ✓ |
| EP37 | Reviewer selection (deliverable, coverage, opt-in answer) prefers a model distinct from the Architect's and e… | BP5; T6 (T3, T9 contribute) | T6a ✓, T6b ✓, T3a ✓, T3b ✓, T9 ✓ |
| EP38 | Deterministic change risk over the six named signals (lower author tier raises risk) sets review depth low/me… | BP5; T5,T6 | T5 ✓, T6a ✓, T6b ✓ |
| EP39 | Build-mode requests are triaged as the Architect's first action into answer, build or clarify; an answer comp… | BP2; T9, T7 | T9 ✓, T7a (open), T7b (open), T7c (open), T7d (open) |
| EP40 | Every model pass beyond the working pass records its purpose and token cost through the P6.5.4 context manife… | BP5; T7 (T3,T6,T8 contribute) | T7a (open), T7b (open), T7c (open), T7d (open), T3a ✓, T3b ✓, T6a ✓, T6b ✓, T8 (open) |
| EP41 | Architect command execution is not admitted while a new-policy run is in planning state, defined by T3's kern… | BP2; T3, T9 | T3a ✓, T3b ✓, T9 ✓ |
| EP42 | Every reviewer records its own findings before it may see another reviewer's findings on the same artifact; a… | BP5; T6 (T3, T9 contribute) | T6a ✓, T6b ✓, T3a ✓, T3b ✓, T9 ✓ |
| EP43 | At high tier the deliverable reviewer records obligations derived from the source criteria before it receives… | BP5; T6 | T6a ✓, T6b ✓ |
| EP44 | A blocking `missing` or `weakened` coverage verdict holds plan readiness until resolved | BP2; T3 | T3a ✓, T3b ✓ |
| EP45 | High-tier break-it probe run by the runner via the ladder (project tool → built-in C-family/Python-family tok… | BP4; T5 (T6 consumes) | T5 ✓, T6a ✓, T6b ✓ |
| EP46 | Affected tests by ladder — impact tool → LSP/compiler references → build-system module graph → full suite — w… | BP4; T5 | T5 ✓ |
| EP47 | JUnit XML and TRX reports read into selected/passed/failed/skipped counts; missing, empty or unreadable repor… | BP4; T5 | T5 ✓ |
| EP48 | A failing check re-runs only its failing tests once before a repair cycle is charged; pass on re-run = `flaky… | BP5; T6 (T5 contributes) | T6a ✓, T6b ✓, T5 ✓ |
| EP49 | A defect class is recorded per review finding, per project; the top classes enter worker and reviewer briefs… | BP5; T6 | T6a ✓, T6b ✓ |
| EP50 | Per-model review-outcome record; change risk reads a snapshot, stays deterministic, and records the default t… | BP5; T6 (T5 consumes) | T6a ✓, T6b ✓, T5 ✓ |
| EP51 | After each attempt and verification, owned leftover processes and runner temp files outside the workspace are… | BP5; T6 | T6a ✓, T6b ✓ |
| EP52 | Deferred prompt-review findings (M1, M3, M7–M12, L1–L8) are re-checked against the post-P6.6 prompts; each st… | BP5; T10 (T8 reports tokens) | T10 (open), T8 (open) |

### 2.2 SRC-A ledger AR-R01-AR-R32 (owner packet from SRC-A section 3)

| AR | Obligation (short) | SRC-A owner | Items |
|---|---|---|---|
| AR-R01 | One pure, deterministic renderer produces the snapshot: header (run, revision, stop kind and reason, body dig… | C1 | C1 ✓ |
| AR-R02 | The snapshot is bounded (at most 200 lines / 16 KiB), never truncates header or verification, and neutralizes… | C1 | C1 ✓ |
| AR-R03 | The reducer accepts docs policy v2 additively; a run seeded with planning v1 and docs v2 follows the v2 path;… | C2 | C2a ✓ |
| AR-R04 | At handoff and plan-only completion the runner commits STATE.md, the static v2 AGENTS.md section, the `@AGENT… | C2 | C2b ✓, C2d ✓, C2e (open) |
| AR-R05 | v2 form of AC-25: a docs-v2 run that is not answered cannot record `project.handoff_selected` or `run.complet… | C2 | C2a ✓, C2b ✓, C2c ✓, C2d ✓, C2e (open) |
| AR-R06 | An answered v2 run writes no project file and needs none to complete | C2 | C2a ✓ |
| AR-R07 | A hand-edited previous snapshot is detected by its header digest, recorded, and named in the new snapshot; `e… | C2 | C2b ✓, C2d ✓, C2e (open) |
| AR-R08 | At every stop other than handoff (any pause reason, cancel, terminal failure) of a run after the triage decis… | C3 | C3 (open) |
| AR-R09 | At a stop whose reason allows model calls, the runner asks the Architect once for short notes (bounded size a… | C3 | C3 (open) |
| AR-R10 | Runner-authored integration commits of new-policy runs carry `AIBoard-Run`, `AIBoard-Task` and `AIBoard-Requi… | C3 | C3 (open) |
| AR-R11 | The v2 Architect prompt has no docs templates, layout or per-turn STATE.md body; the existing snapshot is giv… | C4 | C4 (open) |
| AR-R12 | Under v2, `write_project_doc` stays available but refuses kernel-owned paths and `docs/project/evidence/**`;… | C4 | C4 (open) |
| AR-R13 | **Amends** the parent `PlanningCheckpoint` mechanism (EP09, parent `:356`; authorized by the owner's "go" on… | C4 | C4 (open) |
| AR-R14 | Unproduced T2 planning event types and projections are marked reserved; a static test fails if a `src/` modul… | C4 | C4 (open) |
| AR-R15 | The kernel stamps plan envelope fields (run, manifest id and digest, policy version, times, review and lineag… | C5 | C5 (open) |
| AR-R16 | The worker's context holds the compact semantic contract (outcome, scope and exclusions, inputs, outputs, ste… | C5 | C5 (open) |
| AR-R17 | Production run creation stamps planning policy v1 (log sequence ≤ 3) and docs v2 together and registers the a… | T7a | T7a (open) |
| AR-R18 | **Amends** parent T7 "Documentation folder boundary" (parent `:286`, authorized by AR-1): for docs-v2 runs, T… | T7d | T7d (open) |
| AR-R19 | Test integrity: pinned test command and suite-shrink detection at the boundary unless tied to a plan revision… | E1 | E1 (open) |
| AR-R20 | Submission scope findings (blocking, not refusal) and secret/key-file refusal; diary-looking new files flagged | E2 | E2 (open) |
| AR-R21 | Every runtime of an attempt is an author; unreferenced new source files and test-only diffs raise the tier; o… | E3 | E3 (open) |
| AR-R22 | Encoding safety: BOM kept by `fs.patch`/`fs.write`; submission encoding findings | E4 | E4 (open) |
| AR-R23 | Mutation survivors on changed lines become findings that need a reviewer disposition before approval; a dispo… | E5 | E5 (open) |
| AR-R24 | Command evidence records a working-tree fingerprint and a child-environment fingerprint; links taken before l… | V1 | V1 (open) |
| AR-R25 | Exact-identity reuse within a run (boundary, high-tier depth, final verification), recorded as `reused_from`;… | V2 | V2 (open) |
| AR-R26 | Language-neutral execution profile: build/test commands and machine-readable reports for non-`package.json` p… | V3 | V3 (open) |
| AR-R27 | ReviewKey dedupe (same key: no new review, prior verdict returned, no cycle charged); interrupted review resu… | W1 | W1 (open) |
| AR-R28 | Delta re-review input (fix delta, delta files no finding names, invalidated evidence, then prior findings); t… | W2 | W2 (open) |
| AR-R29 | Architect disposition: `review_task` verdicts prefilled from the reviewer and runner evidence; overrides need… | W3 | W3 (open) |
| AR-R30 | T10 adds: v2 prompt wording, the anti-journaling tool description, the both-directions fix re-review line, th… | T10 | T10 (open) |
| AR-R31 | T8 adds: v2 build with restart ends with only product files, the snapshot, the entry lines and the optional s… | T8 | T8 (open) |
| AR-R32 | Capability design D6 carries a revision-5 note pointing to this amendment | Controller (this plan) | AR-R32 ✓ |

### 2.3 SRC-A decisions that created work

| Decision | Obligation | Items |
|---|---|---|
| CD-13 | Split C2: C2a kernel path, STATE.md and answered runs (steps 1-5, 7; AR-R03, AR-R06); C2b entry lines, spec copy, options, hand-edit detection and the full AR-R05 tree check (AR-R04, AR-R05, AR-R07) | C2a ✓, C2b ✓ |
| CD-15, CD-16, CD-17 | Docs hardening; no layout leaves a run permanently unable to hand off; build-risk re-assessment livelock | C2c ✓, FX-1 ✓, FX-2 ✓, C2d ✓, C2e |
| CD-18 | Faster delivery and handoff suites | TX-1 ✓, TX-2 ✓ |
| CD-19 | Remaining docs layouts before T7a | C2d ✓, C2e |
| CD-20, CD-21 | Contained-launch cost investigation (does not gate P6.6); safe speed steps; accepted PX-2 packets merge into lane A | PX-1 ✓, PX-2t ✓, PX-2a ✓, PX-2b ✓, PX-2c ✓ (opt-in), PX-2e, INT-1 |
| CD-22 | Impact-based verification for this plan's own work | Section 1 GATE-SCHEDULE and 1.1 |
| CD-23 | The runner itself follows impact-based verification | IV-1, IV-2, IV-3, E1 (carve-out) |
| SRC-A section 4 | Every S2 finding routed to a packet or to P7 | The packets SRC-A section 4 names; P7 rows in 2.4 |

### 2.4 Not in this plan (SRC-A section 8, P7 and later; kept visible)

Semantic reuse (`decideApplicability`) with data, including parent EP19's unrelated-change reusable
case (AR-4); the T5-library wiring decision for `createValidationEvidenceTools`, RED→GREEN pairing and
`validation-observation.ts` (`assessObservationForAcceptance`, `recordFaultInjection`,
`recordFlakyIsolation`) — the `validation-policy.ts` part moved into IV-2 by CD-23; a prior-run digest
at triage (snapshot plus `git log <revision>..HEAD`); delta plan revisions; a diff-on-demand verdict
pass; reviewer outcome tracking; a real continuation test by a fresh Claude Code or Codex session with
no AIBoard access; token tuning per gate. After T8: the S3 backlog rows L4(b), L4(c), L9, L11, L14,
L15 (SRC-A section 4). Affected-test selection "as more than information" (F8) moved into IV-2 by
CD-23. P7 itself still needs owner decision OD-1 (SRC-P).

## 3. Items

Legend: `[x]` accepted and committed on a branch (not yet on the integration target); `[ ]` open.
Each open item: type; SOURCE; definition of done (DoD); depends; touch set; P = protected
(section 7) yes/no; G = gate infrastructure yes/no.

### 3.1 Done under the superseded standard

Lane A `codex/runner-v2-p6-6`: T1 `21c44efb`; T2 `5f901354`; T3a `630dba59`; T3b `57e80f45`; T9
`385fb66c`; T4 `d5bdea5b`; T5 `cb080f8e` (merged `6286a9ee`); T6a `7d21be0b`; T6b `764fdffb`; C1
`278fd627`; C2a `d35371a1`; C2b `6e8c7ef4`; FX-1 `2658c8b5`; FX-2 `62362265`; TX-1 `7eb31177`; C2c
`83f89cf5`; TX-2 `da771649`; C2d `88266a9a` + `37433efd` (accepted `5b1d58ae`); PX-1 findings
`010d65e6`; AR-R32 capability-design revision-5 note `ad6028d2`
(`docs/superpowers/specs/2026-09-22-runner-v2-agent-capability-model-design.md` lines 46-61, names
CD-9 and marks `export_only` owner-pending per SRC-A N-5).
Lane C `codex/runner-v2-px1`: PX-2t `cb567e62` + `abeb6d7e`; PX-2a `7a1703e2`, `5d6e6540`,
`1daf1b89`, `241d5f64` (accepted `860d893b`); PX-2b `e8eb8720` + `6a581f66` (accepted `c9ebdb3b`);
PX-2c `cd475d57`, `54f15b17`, `31bf1957` (accepted `16648709`; opt-in only).

- [x] T1, T2, T3a, T3b, T9, T4, T5, T6a, T6b — SRC-P tasks (code).
- [x] C1, C2a, C2b, FX-1, FX-2, TX-1, C2c, TX-2, C2d — SRC-A packets (code).
- [x] AR-R32 — docs.
- [x] PX-1 (investigation), PX-2t, PX-2a (P, G), PX-2b (P, G), PX-2c (P, G; opt-in).

### 3.2 Open — phase C (correction)

- [x] **INT-1** code (integration) — branch `exec/runner-v2-p6-6/INT-1`, PR to `integration/runner-v2-p6-6`; — Make lane A the integration line and publish it. SOURCE: CD-21
  ("accepted PX-2 packets merge into lane A"), CD-10, D-2. DoD: lane C's accepted PX commits
  (through `16648709`) merged into lane A; origin/main merged into lane A (the 3 overlapping files
  checked); the baseline recorded (typecheck, lint, layer-1 time); layer 2 green for the merged result
  (handoff group, native-delivery files, Windows Job suites, replay-compatibility, audits); this file
  and SOURCE shipped; the integration target created per D-2. Depends: D-2, C2e accepted. Touch: merge
  only. P: yes. G: no.
- [x] **C2e** code — accepted 2026-10-01 (review r3 ACCEPT), commits `0ec56592`, `ca0df135`, `7c19ca24`, shipped in INT-1; SOURCE: SRC-A "C2e" (CD-19), C2e reviews r1-r2. DoD: a tracked file at `docs` or
  `docs/project`, and a directory or gitlink at `docs/project/STATE.md`, each hand off with a
  tree-derived skip reason the AR-R05 gate accepts, and v1 refuses clearly; `applyToProject` is bounded
  for any number of ignored files and any path length (byte-bounded pathspec chunks) and keeps every
  apply guarantee; a snapshot append the reducer refuses pauses with the reducer's reason and resume
  retries (m-7); the empty-commit refusal names the unclean index (m-11); reuse wording equals fresh
  wording (m-4); a second-stop regression test for W-A4 exists (m-8); every recorded skip reason is
  accurate and old logs replay unchanged. Depends: C2d. Touch: `integration-manager.ts`,
  `build-runtime.ts`, `project-docs.ts`, `scheduler-store.ts` (gate only), handoff and project-doc
  tests. P: yes (git writes, scheduler log). G: no. INT-1 layer 2 found one regression from repair 2
  (F-9); fixed in `e9440349`, `fe5286d6` (review ACCEPT), shipped in INT-1.
- [x] **C3a** code — LOCAL_ACCEPTED 2026-10-02 at `863814ee`; Muse implementation and two repairs, prior Sonnet r3 ACCEPT plus GPT-6.1 Sol high takeover ACCEPT; packet tests 19/19, tsc/lint green; protected merge pending. Snapshot at every stop (split of SRC-A "C3" steps 1, 2 and 4; AR-R08; memory
  rule: split large packets). DoD: the stop table (every transition into `paused`, every cancel and
  terminal failure, each classified notes-allowed or notes-denied) goes into the PR description; at
  every stop other than handoff after the triage decision `build`, the runner renders C1 with stop kind
  `paused`, `cancelled` or `failed` and commits STATE.md (plus missing entry lines) through C2's kernel
  commit method and event; skip rule (CD-9, CD-5) recorded durably: no snapshot before `build`, while a
  `clarify` is pending, on an answered run, with `export_only`, or for C2's own `handoff_snapshot_failed`
  pause; the commit never blocks or changes the stop (a failure records a finding); replay or a double
  resume creates no duplicate commit; until C3b every snapshot carries the "no notes" line. Tests from
  SRC-A C3: cancel writes a snapshot without notes; replay/resume twice no duplicate; pause during
  triage → answer → `apply_to_project` leaves the project tree hash unchanged; `export_only` pause
  writes nothing; legacy runs unchanged; CD-7 factory tests. Red proof: remove the CD-9 skip → the
  answered-run tree-hash test goes red. Depends: INT-1. Touch: `build-runtime.ts`,
  `scheduler-store.ts`, `integration-manager.ts`, `native-build-factory.ts`, tests. P: yes. G: no.
- [x] **C3b** code — LOCAL_ACCEPTED 2026-10-02 at `8c597d04` in `.worktrees/p66-c3b` (`exec/runner-v2-p6-6/C3b`); Muse two repairs, GPT-6.1 Sol high ACCEPT. R1 dedicated file 11 tests: 10 pass, one crash-fixture boundary mismatch; R2 corrected crash plus three new tests green (4 selected); ten unchanged greens reused with reviewer confirmation; tsc/lint/diff green. Isolated single runtime-denial mutation red at required no-notes reason while independent admission prevented calls, exact bytes restored (SHA256 `1a956bada7c84c29ed57a8d9b54e1607e230a30d0f92b5925a0462c0dc1bf810`); selected green 1/1 (60.6 seconds), exit 0. EP17 alternative accepted by reviewer: removal of runtime denial alone cannot issue a call because the independent stop-eligibility guard still refuses admission. Broad coverage deferred to T8; protected merge pending. Architect stop notes (SRC-A "C3" step 3; AR-R09; EP40). DoD: a bounded
  investigation names the existing one-shot model-call path outside the Architect loop and uses it with
  the fixed short prompt, no tools, at most 2,000 characters and a time bound; cost recorded as purpose
  `handoff_notes`; text stored as the additive event `handoff.notes_recorded` (Architect actor,
  idempotency key from the stop event's sequence); notes asked only for notes-allowed stops. Tests:
  repair-limit pause writes a snapshot with open work and scripted-Architect notes; budget-exhaustion
  pause writes the "no notes" line and makes no model call; a notes failure still writes the snapshot.
  Red proof: remove the notes-denied check → the budget-exhaustion test sees a model call. Depends:
  C3a. Touch: C3a's list plus the chosen one-shot call module (call site only). P: yes. G: no.
- [x] **C3c** code — LOCAL_ACCEPTED 2026-10-03, source fix `59b0965b` with reviewed final tree at `c40c6442`, branch `exec/runner-v2-p6-6/C3c`; Muse implementation and two repairs, controller cycle 3, same GPT-6.1 Sol high PACKET ACCEPT. Current ready-contract requirement IDs are stamped from kernel authority; each new-policy integration commit is published fully stamped, dirty worktrees and ambiguous unstamped recovery refuse without mutation, stamped-prefix recovery resumes, and final verification uses exact canonical/generation authority plus durable kernel snapshot SHA/parent/path/digest validation at first creation and reopen. Legacy exact verification fences retained. Dedicated C3c file 11/11 pass, zero skips, exit 0, 435.7 seconds (actual NativeBuildFactory/BuildRuntime/SQLite journey 401.6 seconds). Runner/app typechecks, changed-file ESLint and diff checks pass. Final-code trailer mutation selected RED 1 fail at trusted run-level requirement assertion, then byte-exact restore and selected GREEN 1 pass; original/restored SHA256 `35599a7046bfbbe8bebe2c50f76a764e8642916af8cc47d0f9a4cab285109677`, fault `1ab98741a82351de99bd8da6d45e1f4aff78efade5092dc41af0f50648e8fdd6`; independently verified by reviewer. All F1-F4 and requirement-ID findings closed. Broad coverage deferred to T8; protected merge pending. Revision targeting after a mid-run kernel commit and commit trailers (SRC-A "C3"
  steps 5 and 6; AR-R10; CD-11). DoD: integration, final verification and handoff still target the
  right revisions after a mid-run kernel commit; `AIBoard-Run`, `AIBoard-Task` and
  `AIBoard-Requirements` trailers where the runner authors integration commits for new-policy runs (or
  where it creates the task commit when integration fast-forwards; record which). Tests: pause →
  snapshot → resume → task integrates → final verification passes on the right revision → handoff
  snapshot; trailers in `git log`. Depends: C3b. Touch: C3a's list. P: yes. G: no.
- [x] **C4** code — LOCAL_ACCEPTED 2026-10-03, source candidate `e0a8f25d` with documentation merge `599197d9`, branch `exec/runner-v2-p6-6/C4`. Same GPT-6.1 Sol high PACKET ACCEPT after Muse two consolidated repairs: kernel-owned path case variants refuse before effects; eligible planning/guidance receives relevant exact immutable base STATE labelled untrusted, including inherited/baseline content; full snapshot section fits4KiB; resume facts derive current manifest/review lifecycle and authoritative open findings, retain facts under terminal owner gates and withhold blocked readiness. Historical checkpoint-after-fold -> later review -> ready replay retained. Dedicated C4 file25/25 pass0fail/cancel/skip,exit0,103.146seconds (actual factory99.999seconds); runner/app typechecks, all changed-file lint and diff checks pass. Three v1 byte-parity cases pass; Architect estimate1610->1081. SOURCE-required checkpoint list mutation selected RED1fail/exit1, exact byte restore, selected GREEN1pass0skip/exit0; original/restored SHA256 `c50d06acf778830b96e3beb4f545fd963aedacd852af79bb44465fb475b7f067`, fault `fdf29b145f7a794d539688c3bc3f111106808b181b324207613f397d926a9570`. Reviewer independently verified nine file hashes, restoration bytes, fault reconstruction and true exits. All four initial findings and two gate follow-ups closed. No tests interrupted; broad coverage deferredT8, protected merge pending. SOURCE: SRC-A "C4", AR-R11..AR-R14 (AR-R13 amends parent EP09 per AR-2). DoD per
  the SRC-A C4 contract (v2 Architect prompt without docs templates; `write_project_doc` refusals;
  `record_planning_checkpoint` removed from the new-policy path with the derived index; reserved T2
  event types with a static guard; token counts in the PR). Depends: C3c. Touch: `agent-prompts.ts`,
  `architect-tools.ts`, planning tools, `scheduler-store.ts`, `planning-projection.ts`, a static guard.
  P: yes (scheduler log). G: no.
- [ ] **C5** code — IN_PROGRESS 2026-10-03, assigned Muse in `.worktrees/p66-c5`, branch `exec/runner-v2-p6-6/C5`, based on latest locally accepted C4 tree (source `e0a8f25d`). Kernel envelope/links/current task contract reference and actual worker/reviewer context delivery; EP06 strict, old digests/replay preserved, only C5 tests and fast static checks. Dedicated factory/SQLite journey and selected byte-exact restoration proof required before Sol high independent acceptance. No production/main changes. SOURCE: SRC-A "C5", AR-R15, AR-R16, CD-12. DoD per the SRC-A C5 contract (kernel
  stamps the plan envelope fields; the worker context holds the compact semantic contract; the reviewer
  context gets the validation rationale). Depends: C4. Touch: planning contracts, `agent-prompts.ts`,
  `scheduler-store.ts`, `native-worker-driver.ts`, `native-deliverable-review.ts`. P: yes. G: no.
- [ ] **PHASE-C-EXIT** verify — SOURCE: SRC-A section 5 row C. DoD: a seeded new-policy factory run
  pauses, resumes and reaches handoff and writes only product files plus the kernel handoff files; an
  answered run writes nothing; v1 replay green; layer 3 for phase C green or each red fixed or recorded.
  Depends: C5.
- [x] **PX-2e** code (tests) — accepted 2026-10-01 (review r2 ACCEPT), commits `2dc7ad8c`, `9a6295a5`, shipped in INT-1; SOURCE: SRC-A "PX-2e" (CD-21 follow-up; does not gate phase C, CD-20).
  DoD: each named Windows Job test file leaves no supervisor or Job host; a shared end check fails a file
  that does, proven red; leak causes fixed. Depends: PX-2c. Touch: the Windows Job test files, a test
  helper, product code only where a leak lives. P: yes if product code changes. G: yes. State: running.

### 3.3 Open — phase T7

- [ ] **T7a-INV** investigation — SOURCE: SRC-A "T7a", SRC-P T7. DoD: names which production entries
  create new-policy runs and whether T7a changes the default for every new run; answer in Findings.
  Depends: PHASE-C-EXIT. Unlocks: T7a, T7a-OK.
- [ ] **T7a-OK** owner-action — SOURCE: SRC-A "T7a" ("owner confirmation if it changes the default for
  every new run"), D-8. DoD: the owner confirms or declines in writing. Depends: T7a-INV.
- [ ] **T7a** code — SOURCE: SRC-A "T7a", AR-R17, CD-1. DoD: production run creation stamps planning
  policy v1 (log sequence ≤ 3) and docs v2 together and registers the approved source through the real
  provisioning path; one unseeded factory test runs from production run creation to
  `delivery.review_started`, the boundary and `task.acceptance_recorded`. Depends: T7a-INV (and T7a-OK
  if the default changes). Touch: run creation, provisioning, `native-build-factory.ts`. P: yes
  (production defaults). G: no.
- [ ] **T7b** code — SOURCE: SRC-A "T7b", SRC-P T7, FX-2 review r2 F1. DoD: authenticated, idempotent
  source, plan-readiness and explicit-start controls; a stale reconnect cannot start an old plan; an
  unauthorized user or worker cannot mutate acceptance; on-demand export API through C1; verifier and
  Architect selection answers name the requirement they answer and a stale answer is refused. Depends:
  T7a. P: yes (authentication). G: no.
- [ ] **T7c** code — SOURCE: SRC-A "T7c", SRC-P T7, CD-2, CD-5. DoD per SRC-A T7c (planning-ready vs
  delivery-complete; requirements and blockers; answered-run view; per-pass purpose and token cost;
  review independence and ladder rungs; docs-v2 run options and defaults shown to the owner; the
  hand-edited-snapshot notice; old builds stay readable). Depends: T7b. P: no. G: no.
- [ ] **T7d** code — SOURCE: SRC-A "T7d", AR-R18, SRC-P T7. DoD: section-10 exports and copy-ready
  cards through C1; native launch chips only with a real non-executing host API;
  `docs/runner-v2/evidence-gated-planning.md` user docs; the Playwright source→plan→review→export→
  explicit-start journeys and the production build at the final integrated UI gate; export redaction.
  Depends: T7c. P: yes (redaction). G: no.
- [ ] **PHASE-T7-EXIT** verify — SOURCE: SRC-A section 5 row T7. DoD: parent T7 acceptance plus AR-R17
  and AR-R18; layer 3 for phase T7. Depends: T7d.

### 3.4 Open — phases R1, R2, R3 (lane B; SRC-A section 6 "R1-R3", S3 packets)

Lane B write set (SRC-A section 5): `delivery-execution.ts`, `delivery-acceptance.ts`, `change-set.ts`,
`filesystem-tools.ts`, `evidence-tools.ts`, `execution-host.ts`, `native-deliverable-review.ts`,
`final-verification-*.ts`, `scheduler-store.ts` (review, author and evidence records),
`build-runtime.ts`, `architect-tools.ts` (`review_task`), `agent-prompts.ts` (review blocks),
`repair-approach-contracts.ts` (V2), the isolation providers (V1 environment scrub), new guard modules
and their tests. Every R item is P: yes (scheduler log or process paths) and G: no, unless noted.

- [ ] **E1** code — SOURCE: SRC-A R1 E1 = S3 "Recommended packet 1", AR-R19, CD-23 carve-out. DoD: a
  pinned test command; suite-shrink detection at the boundary unless tied to a plan revision reason or
  to an explicit reviewer-accepted "obsolete or merged; behaviour proven in <id>" disposition; S3 packet
  1 tests plus the carve-out test (a merged test with a disposition passes; the same shrink without one
  is flagged). Depends: C5 (and D-4).
- [ ] **E2** code — SOURCE: SRC-A R1 E2 = S3 packet 2, AR-R20, CD-2. DoD: every submission scope item is a
  blocking finding, never a refusal; secrets and key files are refused with the reason redacted; new
  diary-looking files (progress, evidence, review, test-output records) are flagged as blocking
  findings; one fixture per class plus a clean control. Depends: E1.
- [ ] **E3** code — SOURCE: SRC-A R1 E3 = S3 packet 3, AR-R21. DoD: every runtime of an attempt is an
  author; unreferenced new source files and test-only diffs raise the tier; one inspection call at every
  tier; S3 packet 3 tests. Depends: E2.
- [ ] **E4** code — SOURCE: SRC-A R1 E4 = S3 packet 4, AR-R22. DoD: `fs.patch`/`fs.write` keep a BOM;
  submission encoding findings; S3 packet 4 tests. Depends: E3.
- [ ] **E5** code — SOURCE: SRC-A R1 E5, AR-R23, OA-11/EP45. DoD: mutation survivors on changed lines
  are findings that need a reviewer disposition before approval; "not a real gap" with a rationale
  releases them; a `verified` claim must cite a location or evidence id the reviewing session actually
  read (checked against the tool ledger); vacuous-test fixture, release-by-disposition and
  uncited-verified refusal tests. Depends: E4.
- [ ] **PHASE-R1-EXIT** verify — SOURCE: SRC-A section 5 row R1. DoD: each guard E1-E5 proven red then
  green; layer 3 for R1. Depends: E5.
- [ ] **V1** code — SOURCE: SRC-A R2 V1, AR-R24. DoD: working-tree fingerprint via a temporary-index
  `write-tree`; stale-link marking at submission; PATH/npm scrub recorded in the child-environment audit;
  a child-environment fingerprint (runtime version, lockfile digest, relevant variables) in every command
  evidence record. Depends: PHASE-R1-EXIT.
- [ ] **V2** code — SOURCE: SRC-A R2 V2, AR-R25, AR-4 (amends EP19). DoD: exact-identity reuse keyed by
  (tree id, exact command, environment fingerprint) within one run, recorded as `reused_from`;
  content-based evidence digests used by the approach-decision "new evidence" rule; tests both ways;
  never reuse across runs; run when any fingerprint part is missing. Depends: V1.
- [ ] **V3** code — SOURCE: SRC-A R2 V3, AR-R26. DoD: non-`package.json` detection and report readers,
  `unknown` only when nothing applies; fixtures: C# TRX, CMake `ctest` JUnit, Python `pytest
  --junitxml`, one Maven or Gradle JUnit XML, an unknown-language floor. Depends: V2.
- [ ] **PHASE-R2-EXIT** verify — SOURCE: SRC-A section 5 row R2. DoD: reuse and non-JS fixtures green;
  layer 3 for R2. Depends: V3.
- [ ] **W1** code — SOURCE: SRC-A R3 W1, AR-R27. DoD: ReviewKey dedupe (same key: no new review, prior
  verdict returned, no cycle charged); stage-level resume when the same reviewer runtime continues; S3 L7
  repair-diff fingerprint. Depends: PHASE-R2-EXIT.
- [ ] **W2** code — SOURCE: SRC-A R3 W2, AR-R28. DoD: delta re-review input (fix delta, delta files no
  finding names, invalidated evidence, then prior findings); the late-finding rule in the reviewer
  contract and the kernel's finding intake. Depends: W1.
- [ ] **W3** code — SOURCE: SRC-A R3 W3, AR-R29, AR-3. DoD: `review_task` verdicts prefilled from the
  reviewer and runner evidence; overrides need a reason; `unverified`→`verified` needs evidence the
  Architect's session read; the new-policy "read the submitted diff" instruction removed;
  `decideUnverifiedClaim` wired; runner evidence pre-linked to criteria; final-verification plans
  prefilled for detected categories. Depends: W2.
- [ ] **IV-1** code — SOURCE: SRC-A "IV-1", CD-23. DoD: the worker prompt and verification skill give
  the widening test order, the budget and the extend/merge/delete-obsolete rule; `submit_task` requires a
  `validationScope` {changed, verified, testsRun [command, counts], notRun [what, why]}, stored
  (additive) and shown to the reviewer and the Architect; the deliverable reviewer judges the scope and
  the task's `validation.targetedRationale`/`affectedScopeRationale` against the diff and raises a
  finding when impacted areas were not run or the reason is thin. Depends: W3. Touch: SRC-A IV-1 list.
- [ ] **IV-2** code — SOURCE: SRC-A "IV-2", CD-23, EP16. DoD: with a selection rung other than
  `full_suite` and no widening trigger, the boundary and the high-tier review run the selected tests
  (additive `executedScope: "selected"`, selection recorded); the whole scripts run at milestone or
  merge-group points and at final verification; `validation-policy.ts` wired into task acceptance; when
  no safe selection exists the full script still runs (fail safe); replay of old `full_test_script`
  records unchanged; V2 reuse still applies. Depends: IV-1. Touch: SRC-A IV-2 list.
- [ ] **IV-3** code — SOURCE: SRC-A "IV-3", CD-23. DoD: a per-task validation wall-clock budget (default
  about 10 minutes) counting `run_evidence_command` and boundary durations; above it the worker records a
  justification the reviewer sees, never a hard failure of correct work; an optional project-configured
  tier map (fast / component / integration / slow / release) picked by risk tier and milestone vs final;
  no tier map keeps today's behaviour. Depends: IV-2. Touch: SRC-A IV-3 list.
- [ ] **PHASE-R3-EXIT** verify — SOURCE: SRC-A section 5 row R3 and its lane-B merge rule. DoD: dedupe,
  delta, disposition and the IV behaviour proven; lane B merged into the integration line with the
  importer suites of every file both lanes changed plus replay-compatibility; T7a's unseeded factory test
  re-run with the lane B guards active; layer 3 for R3. Depends: IV-3, PHASE-T7-EXIT.

### 3.5 Open — phases T10 and T8

- [ ] **T10** code — SOURCE: SRC-P T10, EP52, AR-R30. DoD per SRC-P T10 plus AR-R30 (v2 prompt wording,
  anti-journaling tool description, the both-directions fix re-review line, the durable-state reviewer
  line, untrusted labelling, the worker's compact contract, before/after per-role prompt token counts),
  including a check of Claude Code's AGENTS.md behaviour on the owner's installed version (D-9).
  Depends: PHASE-R3-EXIT. P: no. G: no.
- [ ] **T8** code (final acceptance; fixes found here are code) — SOURCE: SRC-P T8, EP16, EP27-EP29,
  AR-R31. DoD per SRC-P T8 bullets (independent source-to-delivery reconciliation; the synthetic
  qualification including the answer-path journeys and tokens per gate; non-JS fixture families and the
  unknown-language floor; verdict and chain checks; layer 4 on the frozen candidate with every failure
  diagnosed, fixed and re-run; the Windows/Linux/macOS and Node-line coverage stated honestly; the
  evidence index per D-10) plus AR-R31 (v2 build with restart ends with only product files, the
  snapshot, the entry lines and the optional spec copy; an answered run adds no file; a plan-only
  snapshot holds the plan; a pause snapshot holds its stop). Depends: T10.
- [ ] **REL-1** owner-action — The single deploying merge of the integration line into main (D-2).
  DoD: runbook with the exact commit, the layer-4 result on that commit, and rollback (redeploy the
  previous main commit); the owner merges. Depends: T8.

## 4. Order and phases

Phases keep SOURCE's own phases and exits (SRC-A section 5): **C** (INT-1, C2e, C3a, C3b, C3c, C4, C5,
PHASE-C-EXIT; PX-2e runs beside it and does not gate it, CD-20), **T7** (T7a-INV, T7a-OK, T7a, T7b,
T7c, T7d, PHASE-T7-EXIT), **R1** (E1-E5), **R2** (V1-V3), **R3** (W1-W3, IV-1..IV-3; CD-23 puts IV in
lane B after W3), **T10**, **T8**, then REL-1. Reason: SOURCE defines them and each ends at a checkable
outcome. The dependency graph is SRC-A's (`C5→T7a…T7d`; `C5→E1…E5→V1…V3→W1…W3→IV-1…IV-3`;
`{T7d, IV-3}→T10→T8`) plus INT-1 before C3a, the C3 split (C3a→C3b→C3c→C4) and the phase-exit items. Lane B starting at C5 before
PHASE-C-EXIT, and running beside T7 on serialized surfaces, needs D-4.

## 5. Size and batches

Every open item fits one Muse run and one PR, except INT-1 (an integration merge of accepted work,
reviewed as such). No protected item is batched with an unprotected one; since almost every open item is
protected, batches are rare (T7c alone is unprotected).

## 6. Serialized surfaces

`runner-v2/src/scheduler-store.ts`, `build-runtime.ts`, `agent-prompts.ts`, `architect-tools.ts`,
`native-build-factory.ts`, `integration-manager.ts`, `delivery-execution.ts`, `delivery-acceptance.ts`;
package files and lockfiles; `.gitignore`; `.github/workflows/*`; this file's shared sections.

## 7. Protected surfaces (proposed; decision D-3) — the owner merges these PRs

- Process containment and launching: `windows-job-*`, `managed-process-*`, `subprocess-runtime.ts`,
  `durable-process-store.ts`, `owned-fence-lock.mjs`, `execution-host.ts`, `process-backend.ts`,
  `native-process-backend.ts`, and the raw-launch allowlist in `task8-raw-launch-closure.test.ts`.
- The scheduler event log, reducer and replay compatibility (`scheduler-store.ts` event types and
  reducer branches; new record fields).
- Git writes that can reach outside a worktree (`integration-manager.ts` project writes and apply).
- Authentication, authorization, secrets and redaction (T7b, E2, T7d exports).
- Production defaults for every new run (T7a) and anything that deploys (`.github/workflows/*`, the
  merge into main).
- Every loosening: an allowlist entry, a raised limit, a deleted or weakened test or guard (except the
  consolidation D-5 allows).

## 8. Decisions (Stage 1 — answer once)

**Owner answer 2026-10-01: "all recommended"** — every decision below takes its recommendation. Also (owner, 2026-10-01): Muse runs in the controller's own shell as a background task, not as a detached separate process.

**Standing decisions (copied from the prompt; not asked):** GATE-SCHEDULE (four layers, mapped in
section 1) and CERTIFY-ONCE (no per-PR registers, status or evidence records; progress lives only in this
file, PR descriptions and GitHub issues). **Already settled by the owner, so not asked:** one Sonnet
xhigh review per code item (standing rule 2026-09-29); stop writing the old records (migration choice);
PX-2c stays opt-in (a default-on change is beyond SOURCE; see F-4).

1. **D-1 Repo bindings.** Adopt section 1, including: PR CI is extra evidence and must be green, or each
   red shown to exist on the target without the change. Recommendation: yes. Depends: all items.
2. **D-2 How work reaches main (BLOCKING).** Every push to main deploys to production
   (`deploy-aiboard.yml`), and CD-10 says no P6.6 code reaches a user before T8. Options: (a) an
   integration branch `integration/runner-v2-p6-6` on origin: INT-1 creates it from lane A; every item's
   PR targets it (PR CI still runs); an item is done when merged there; one deploying merge into main at
   the end (REL-1, owner) — this changes the standard's "ticked on origin/main" to "ticked on the
   integration branch" for this plan; (b) straight to main: each merge deploys, so T7a's production
   stamping must stay switched off (feature flag) until T8, and CD-10 is amended. Recommendation: (a).
   Depends: INT-1 and every later item.
3. **D-3 Protected surfaces.** Accept section 7 (almost every open item becomes owner-merged).
   Recommendation: yes; if too slow, name the items the controller may merge. Depends: every PR.
4. **D-4 Lane B parallelism.** SRC-A (CD-3) runs lane B from C5 beside T7, resolving conflicts on
   serialized surfaces at the lane B merge; the standard allows a second writer only without overlapping
   touch sets or serialized surfaces, and fixes a phase's reds before the next phase starts. Options: (a)
   follow SRC-A (parallel lanes, one integration merge, PHASE-R3-EXIT checks); (b) follow the standard
   (one lane at a time on serialized surfaces: C → T7 → R1 → R2 → R3). Recommendation: (b); it is
   slower in calendar time but avoids large merges, and Muse runs one heavy job at a time well.
5. **D-5 Test consolidation (CD-22 vs the standard's "never delete tests").** A merged, parameterized or
   deleted obsolete test with a written "behaviour proven in <test>" in the PR is not a loosening; any
   other deletion or weakening is protected. Recommendation: yes. Depends: all items, E1.
6. **D-6 CD-2 and CD-5 defaults.** Scope findings blocking (not refusals) and secret refusal (CD-2); spec
   copy on by default with a per-run `export_only` (CD-5) — controller decisions you have not confirmed.
   Options: confirm now, or at T7c where the UI shows them (SOURCE's plan). Recommendation: at T7c.
7. **D-7 C2d exception to CD-15.** A repository that tracks two spellings of `docs/project/STATE.md`
   (only possible in a case-colliding repo) pauses the run on every attempt, fail-closed. Options: accept
   it as a recorded exception to CD-15, or add a fix item. Recommendation: accept.
8. **D-8 T7a owner confirmation.** If T7a-INV shows that production changes the default for every new
   run, you confirm or decline in the T7a PR before merge. Recommendation: yes (T7a-OK).
9. **D-9 AR-R30 AGENTS.md check.** It needs your installed Claude Code. Options: I run `claude --version`
   and a scripted probe in a scratch repo at T10; or you run it. Recommendation: I run it.
10. **D-10 Campaign gate and the T8 evidence index vs certify-once.** SRC-P wants a master-ledger line
    "PHASE VERIFIED 100% COMPLETE" and a durable evidence index; certify-once forbids ledger files.
    Recommendation: the evidence index and that verdict go into the T8 PR description and the final
    report; P7 stays blocked on OD-1.
11. **D-11 Destructive operations.** Remove the stale worktree `runner-v2-p6-6-t5` and its branch now;
    in the closing PR delete the old `progress.md`, `evidence/*.md` and review files (git keeps them).
    No user data is touched. Recommendation: yes.
12. **D-12 Test lane speed.** The handoff group takes about 75 minutes (above the prompt's 60); INT-1
    lands the measured git speed-up (about 934 → 680 ms per call; 540 ms with the opt-in spare) and
    PX-2e removes leaked processes. Recommendation: no extra item; re-measure at PHASE-C-EXIT.

## 9. Findings (recorded, not fixed unless an item covers them)

- F-1 C2d N-1: a README fold on the kernel path costs +4 git calls per snapshot (48/44 vs 43/39).
- F-2 PX-2a: a TEMP path with wildcard or non-Latin characters falls back to in-process Add-Type (no
  speed gain there); compile-failure cause not logged; 120 s compile timeout; the speed file's
  direct-host test is flaky (1/15).
- F-3 PX-2b: the B4 product branch has no test that fails without it; the channel does not pass the
  caller's cursor to `/wait-status`; `waitForFileActivity` is dead in production; no committed
  old-record replay test; the interactive streaming path is unmeasured.
- F-4 PX-2c (opt-in): N7 (claim processed but ack lost → a fresh launch; ran twice in a probe), N8 slow
  unfenced reap (10.5 s), N9 audit records never pruned, N11 working-tree hash in evidence, N13 a
  sibling runner's in-flight claim can be reaped. Default-on needs N7, a bootstrap and re-provision
  policy, a mixed-session measurement and a memory budget (about 140 MB per idle pair).
- F-5 2026-09-30: 50 supervisor processes from lane C work stayed alive for hours and slowed other test
  runs (→ PX-2e).
- F-6 The test "C2b repair B2/G3" failed once under heavy load (stop-1 commit did not land) and passes
  alone (→ C2e repair 2 minor).
- F-7 The prompt's DealFactory bindings do not exist in this repo (→ D-1).
- F-8 C2d review r2 N-3: two tracked spellings of STATE.md pause the run permanently (→ D-7).
- F-9 INT-1 layer 2: C2e repair 2 checked the case-collision kind before the link kind in
  `commitStateBlockers`, so probe F-collide recorded "two spellings of docs" instead of the link
  reason. The worker and the r3 reviewer did not run F-collide; layer 2 caught it. Fixed in INT-1
  (`e9440349`, `fe5286d6`). Follow-up (minor): the stage-time `commitStateNonLinkBlocker` still checks
  collision before link; only its skip decision is used, so no recorded output differs.
- F-10 Pre-existing red on origin/main (`9d697978`, push run of 2026-09-30 14:21): the benchmark-tests
  workflow fails `scripts/test-account-provider-runner-chat.mts:392` ("capability-handshake
  account-provider runner reports version 21"; the runner reports 22) on Ubuntu and Windows. P6.6
  changes no `scripts/` or `lib/` file, so every P6.6 PR shows the same red; not fixed here (outside
  SOURCE).

---

## Verbatim prompt copy (plan-standard, prompt version 2026-09-29b)

```text
EXECUTE A PLAN TO 100%  (prompt version 2026-09-29b)



SOURCE: <path to the plan file, a list of GitHub issues, or the plan text pasted below this line; include every approved amendment>

PLAN DECISIONS (optional): <answers for this plan you already know. They override the standing decisions and any step of this prompt, for this plan only, and Stage 1 must not ask them again>



Turn SOURCE into one checklist, collect every owner decision up front, then execute the checklist back to back until every item is done. No routine stops. This prompt works for any plan in the DealFactory repo. If an EXECUTION file for this SOURCE already exists on origin/main (a docs/plans/*-EXECUTION.md whose header names SOURCE), this is a resume: skip Stage 1, go to RESUME, and follow the prompt copy stored in that file.



STANDING OWNER DECISIONS (apply to every plan run with this prompt, except ACS items; copy them into the EXECUTION file's Decisions section)

- GATE-SCHEDULE DECISION: checks run in four layers. This moves when checks run (AUDIT-METHOD §13.6); it removes none of them. For plans run with this prompt, it replaces what directives D-001 and D-003 say about broad runs, and rule 560's per-PR changed gate for PRs that are not protected; the rest of every recorded directive still applies.

  1. Every PR, before merge, green on its head SHA: the exact failing tests and the directly affected behaviour (database-sensitive ones on MariaDB); the tests of the roots and related consumers (rule 003); fast static checks: Pint on the changed files; PHPStan (main and modules configs) over the whole configured scope, with its result cache kept per clone (never the machine's shared temp folder), reporting no errors beyond those the same command reports on the merge base in the same environment, so errors in callers of a changed signature are caught; composer test:architecture-ratchets when app/ changed (rule 351); every other gate a routed rule requires for the change (e.g. gate:fortress-sentinel for money and compliance surfaces under rule 400); and, for a gate-infrastructure change, proof that every affected gate can still go red (rule 560).

  2. Protected PRs (Stage 1 step 4f) also run, on the head SHA before merge: the ACS changed gate, the module gate when the selector marks high impact, and the evidence check. If the changed gate starts gate:acs-selftest, let it run; never deselect it (no --files= that leaves a changed file out, no acs.json edits).

  3. End of each phase, after its last PR merges (a single-phase plan skips this; layer 4 covers it): in your clone, at the latest origin/main, run the ACS changed gate with --files=<every file this phase's PRs added, changed or deleted>, so the phase's changes are checked together against current main without other sessions' merges. Listing every changed file is not deselection; if the list is too long for one command, split it by module. --files= cannot mark a path as deleted: a deleted path that a module owns still selects that module's tests, but ACS refuses an unowned one as unbounded, so drop only such a refused path. Either way, also run every test that references a name the phase deleted (a class by its full or short name, a route name, a view or Blade component, a config key), found by a text search. Run gate:acs-selftest once if the phase touched gate infrastructure and the gate did not start it; never in C:\DealFactory. A red is fixed before the next phase starts: find the commit that caused it (bisect with the failing test). If it is this plan's, fix it in a PR that names the item it repairs, with that PR's own checks, then re-run the failed members; re-run the whole phase check only if the fix touched shared code. If it is another session's, record it for me and do not fix their code.

  4. The full suite and the full gate:acs, once, on main: at the end of the plan, after every protected PR is merged or I defer it; and before any go-live, deployment or release item, on the exact commit it deploys. Never per PR, never per phase.

- CERTIFY-ONCE DECISION (2026-09-28): no certification bookkeeping during a plan. In no PR do you write, re-emit, repin or re-freeze a register, manifest, status or evidence record, or a document per finding or decision, and you never add a test that compares committed records or docs with the live tree. For plans run with this prompt, this replaces every per-PR bookkeeping duty that rules, gates or directives still demand (e.g. same-PR roadmap or status doc updates, register checkpoints, plan-manifest pins). The evidence is the tests and gates; progress lives only in the EXECUTION checklist, PR descriptions and GitHub issues. Two things are not bookkeeping and still change with the code: documentation that people or the product use (runbooks, API and operator docs, license notices such as THIRD_PARTY_NOTICES.md), and ACS's findings registry (ACS reads it; rule 560). The plan certifies once, at its end, then cleans up (see CLOSING).



PROJECT BINDINGS (the only project-specific part)

- Rules: CLAUDE.md / AGENTS.md route to .cursor/rules through rule 00. Follow every routed rule; rule 008 owns precedence. Recorded owner decisions and directives (e.g. tools/acs/contracts/*/directives/) apply unless a decision above replaces them.

- Verification is local. CI is off by owner decision: never rely on it, add it, or wait for it. ACS is the verification tool (rule 560, tools/acs/docs/AUDIT-METHOD.md §12-13). Its findings registry (tools/acs/registry/**) is part of the work: when an item closes, changes or discovers a finding, update the registry in the same PR (rule 560), with the finding ids in [Scope] and the pinning tests in [Execution]. Changes to the ACS engine are ACS items (see ITEM TYPES).

- Environment traps, all proven in this repo: the shared app container mounts the main checkout, not yours, so `docker compose exec` tests main's code; a fresh checkout has no .env and no vendor; the ACS impact gate refuses unless the app container mounts your checkout, and it runs only from Windows host PHP (C:\php\php.exe), never container PHP; guards that run git inside the container in a worktree need scripts/docker/worktree-git-args.sh (use its non-eval form; the documented eval form expands $GIT_DIR on the host). A result from a container you have not proven mounts your checkout is not evidence.

- Checkouts and Recipe: every writer works in its own clone under C:\df-exec\ (its own .git, origin pointed at GitHub), never in C:\DealFactory. Prefer clones to worktrees: a worktree shares C:\DealFactory's .git, and registering the selftest's scratch worktrees there rewrites the shared git config under other sessions' running gates. C:\df-exec\RECIPE.md holds the proven commands, the date they were last proven, the measured changed-gate runtime and the host's memory figures; it is shared by all plans and lives outside the repo on purpose (machine-specific, no PRs). Reuse an idle clone: no live process attached (check command lines, rule 540) and no unmerged work on its branch. Otherwise create a new one there. Never share a clone with another running plan. Each plan's scratch attempt log is C:\df-exec\<plan-slug>\attempts.log.

- ACS impact gates: scripts/setup/run-acs-impact-gate.ps1 -Scope changed (or module), passing --base=<merge-base of your branch and origin/main>, or at a phase end --files=<list>, through -RunnerArgumentsBase64. Never repin tools/acs from a plan branch.

- Evidence check (protected PRs): C:\php\php.exe tools/acs/gates/resolve-certification-policy.php --phase=6 --json --no-record, run in your checkout on the final head. It returns deferred_by_directive only if the last changed or module gate was green on exactly this tree. It is a check, never a certification.

- Git: take in main by merging origin/main into your branch (rule 542), never by rebasing. This repo allows merge commits only. Branch protection is not available on this GitHub account, so "protected" below is a rule you keep, not a lock.

- Shipping: scripts/setup/ship-pr.ps1 as rule 541 shows (stage only your allowlist), called with PowerShell's -Command form (the -File form cannot pass more than one path), plus -NoOpen, with DEAL_FACTORY_GATE_OVERRIDE set to "full gate:acs deferred to the final phase by owner decision" for a protected PR, or "ACS changed gate deferred to the end of the phase by owner decision" for any other PR. It commits, takes in origin/main and pushes. While ACS is at Phase 7, its certification step then refuses to open the PR; that is expected, and Stage 2 step 7 opens it.



ITEM TYPES (every item of every plan is one of these)

- Code item: the default. It goes through Stage 2's steps.

- Verify item: existing code already does it. Prove it with a real test and a prove-red (break the behaviour, watch the test fail, restore by hash; add a pinning test if none exists); never rebuild it. If nothing needs to change, it is ticked in the next PR, with its evidence in that PR's description.

- Investigation item: a question that must be answered before other items can be defined or built. Its definition of done names the evidence that answers it and the items waiting on it. The answer goes in the Findings section in the next PR; if it adds or changes items, say so in the phase message.

- Docs item: changes only files outside ACS's supervised paths (acs.json "supervised_prefixes"; e.g. docs/plans, or docs/*.md at the top level). It skips the ACS gates and the evidence check, and is verified with git diff --name-only origin/main...HEAD.

- Owner-action item: anything outside this repo: production or shared-environment data (migrations, backfills, restores), deployments, go-lives and releases, live secrets, third parties. Ship a runbook for it as a docs item: exact commands; the host, database and environment; a dry run against your isolated test database; verification queries; rollback. A deployment, go-live or release waits for layer 4 of the GATE-SCHEDULE DECISION on the exact commit it deploys, and its runbook deploys that commit, not a later main. Stage 1 asks who runs each owner-action item. If I run it, it is ticked when I confirm. If you run it, first quote the host, database and environment and wait for my yes (rule 400), even if Stage 1 covered it.

- ACS item: changes the ACS engine (tools/acs/src, bin, gates, selftest, config, contracts). ACS is a separate program: rule 560 and ACS's own directives apply to it as written, the standing decisions do not, and it never goes through DMS module or entitlement contracts. ACS items get their own PRs, never batched with other items.



STAGE 1 — PREPARE (the only planned stop)

1. Read all of SOURCE (if it is a list of GitHub issues, every issue and its comments). Pick a short plan-slug (kebab-case, from SOURCE's title) that no docs/plans/ file, exec/ branch or plan/ tag already uses. Route SOURCE's subjects and files through the rules. Inspect the repo for current reality. Implement nothing. Record origin/main's SHA as the plan's base commit.

2. Entry check: open PRs, worktrees, branches and running peer sessions that touch the plan's surfaces. Overlaps go on the decisions list.

3. Tool check: if C:\df-exec\RECIPE.md and an idle clone exist, re-prove them in minutes (the probe, one targeted test on MariaDB, the layer-1 static checks, the changed gate with --base, the evidence check, ship-pr.ps1 -DryRun with two paths) and fix whatever broke. Otherwise build them: one clone per writer (a second only if the plan has work that can run in parallel), each with its own compose stack and its own private MariaDB server, started with test-only speed settings (data directory on tmpfs; innodb_flush_log_at_trx_commit=0, sync_binlog=0, innodb_doublewrite=0). Prove, recording the exact commands in RECIPE.md: the test container mounts THAT clone (check with a probe file); a targeted test runs on MariaDB against it; migrations run only against that isolated test database; any other lane the items need runs there too (e.g. JS or browser tests); the layer-1 static checks (Pint, PHPStan with both configs, composer test:architecture-ratchets); the ACS changed gate with --base and with --files=; the evidence check; ship-pr.ps1 -DryRun with the override set and two paths; gh can merge here (merge commits allowed, and your account has push rights). Also record, without running them, the commands for the full suite and full gate:acs in this stack (rules 550, 551). Record the measured runtime of one changed-gate run and the host's total and free memory. If one changed-gate run still takes over 60 minutes with these settings, put "speed up the test lane" on the decisions list with the numbers; it changes the shared test harness (rule 551 §3), so never add it as an item on your own. Anything that refuses for a reason outside the plan goes on the decisions list.

4. In your clone, write ONE file: docs/plans/<plan-slug>-EXECUTION.md. Always docs/plans/, never next to SOURCE: folders such as docs/audit/bhph-lifecycle-certification are measured by register gates, so every tick there would trigger a rebuild. If SOURCE is not already a file in the repo (a path elsewhere, issues, or pasted text), commit it as docs/plans/<plan-slug>-SOURCE.md (for issues: their numbers, titles and bodies). At the top: SOURCE's path (or issue numbers) and sha256, the base commit, and a verbatim copy of this prompt (a resumed session follows this copy; it changes only when I tell the plan to adopt a new version). This file is the only plan and the only progress record. Never create another tracked ledger, register, manifest, state file, evidence file, ID system, or document per finding or decision (certify-once decision). The only exceptions are ACS findings registry entries (rule 560) and scratch logs outside the repo. The file contains:

   a) Coverage map: every SOURCE obligation (section, bullet or issue) -> item IDs. Nothing unmapped, merged away or weakened.

   b) Items, each with: checkbox, ID, type (see ITEM TYPES), quoted SOURCE line(s) or issue number, definition of done (2-4 lines, observable, in SOURCE's words, not what is easy to build), depends-on, touch set, roots and related consumers (rule 003), protected yes/no, gate-infrastructure yes/no.

   c) Order and phases. Order items by dependencies first, then priority: P1 security, tenancy and data safety; P2 money and customer-data correctness; P3 foundations other items need; P4 customer-facing features; P5 structure and cleanup. P1-P5 are an ordering, not phases. Reds that already exist on origin/main and would block every code PR's gates are fixed first.

      Phases are acceptance boundaries. Choose their number from the plan's size and structure, and state the reason in one line:

      - If SOURCE defines its own phases, keep them (merge any that would be empty or trivially small into a neighbour, and note it).

      - Small plan (up to about 8 items, or a single module): one execution phase plus the closing.

      - Medium plan: 2 to 4 phases, each ending at a point where a coherent outcome can be verified.

      - Large plan: phases of about 10 to 20 items, each with one coherent outcome.

      Never create an empty phase or a phase just to match a priority level. Every phase has a fixed cost (the layer-3 check, the phase-end table, one protected-PR review), so fewer, meaningful phases are better. Mark the batches (see SPEED).

   d) Size: every item or batch fits one session and one PR. A split must map every part of the original.

   e) Serialized surfaces, which only one item may change at a time: shared models, config/modules.php and module config, migrations, composer.json, ratchets and baselines, rule files, ACS config, this file's shared sections.

   f) Protected surfaces, which I merge: money logic; everything on rule 400's written-approval list (regulated copy, statutory caps or rates, allocation or waterfall behaviour, retention, consent or export destinations, new outbound integrations, a dependency whose license is not on rule 400's approved list); tenancy; security; migrations on financial tables; any intentional break of a public API, route or JSON contract (rule 008: a contracted API is kept or deprecated with a date, never just deleted); and every loosening: raising a MAX_ or lowering a MIN_, adding allowlist, baseline or known-failure entries, changing expected numbers or golden fixtures, removing a gate member, a guard or an #[AuditFinding] test. Not protected: lowering frozen numbers, deleting baseline entries that no longer match, and deleting tests whose only subject the same PR deletes (proved by the §12.3 searches). If a Stage 1 answer names an exact protected change, that is my written OK and you may merge that change yourself.

   g) Decisions and Findings sections at the bottom.

5. Decisions: answer everything the repo can answer yourself. Put the rest in ONE numbered list: question, options, your recommendation, and the items that depend on it. Always cover: ambiguous or conflicting requirements; business or legal choices; destructive operations; secrets; conflicts between SOURCE and the rules; every removal of a test, guard, ratchet or register that SOURCE implies; the protected list itself; who runs each owner-action item; which items are ACS items, and how their gates run under ACS's own directives; failures that already exist on origin/main (my default: record them in Findings with proof, and do not fix them unless SOURCE covers them or they block every code PR's gates; a blocking red in a protected area is listed first, so one answer can clear it); any existing per-PR check that only compares committed records with the live tree and that this plan's changes would trip (my default: retire it from the per-PR lanes as a protected change, unless another plan is already doing that); speeding up the test lane, if the tool check measured over 60 minutes; any other long gate the plan triggers and how often it runs; tool-check failures. Never ask about the standing decisions or the PLAN DECISIONS.

6. Coverage review: a fresh read-only subagent (or fresh session) that did not write the items reads SOURCE and the EXECUTION file, and reports anything missing, merged away, weakened, or with a definition of done that does not match SOURCE. Fix it before presenting.

7. STOP ONCE. Present the items with their types and definitions of done, the order, the phases with the one-line reason for their number, the batches, what may run in parallel, the decisions and the tool check. After my answers: record them under the affected items, ship the EXECUTION file (and the SOURCE copy, if any) as its own PR, merge it, and never ask about them again. If you have no decisions to ask, do not stop: present the checklist and start Stage 2 right away. If I answer only some decisions, start every item that does not depend on the open ones.



STAGE 2 — EXECUTE (back to back)

Loop until every item is ticked, blocked, or waiting for me. Verify, investigation, docs, owner-action and ACS items follow ITEM TYPES; every item that changes code goes through these steps:

1. Take the first unticked, unblocked item (or batch) whose dependencies are merged.

2. In your own clone, create branch exec/<plan-slug>/<item IDs> from the latest origin/main. Reuse that clone and its stack for every item.

3. Route the work through the rules. Emit rule 007's Audit Summary without waiting for a reply: one line each for [Scope], [Cleaned], [Impact] and [Execution], naming files and callers rather than describing them. It goes in the PR description.

4. Build it: for a behaviour change, failing test first, then the code, then green on the exact tests and the directly affected behaviour. Update every root and related consumer in the same change (rule 003). Delete what your change supersedes in the same change (see CODE). Tick each item's own checkbox, with the branch name, in the same commits. Record failed repair attempts as SPEED describes.

5. Ship with ship-pr.ps1 (see BINDINGS). In a batch, commit each earlier item yourself with the same allowlist checks and leave the last one staged for ship-pr.ps1; never use -SkipCommit.

6. Checks on the pushed head, with the RECIPE.md commands, per the GATE-SCHEDULE DECISION: layer 1 for every PR; for a protected PR also layer 2, with the evidence check last and nothing written to the checkout in between. Anything that must write files belongs in step 4, not here. A red goes back to step 4 (commit, ship-pr.ps1 again, re-check). A docs item skips this step; it is verified by git diff --name-only origin/main...HEAD.

7. Open the PR if ship-pr.ps1 did not: gh pr create, title starting with the item ID(s). The description holds the Audit Summary; for each item its definition of done, evidence, attempts and findings; "Closes #<n>" for each item that came from a GitHub issue; and one line: for a protected PR, "Shipped without a passing gate:acs. Override reason: full gate:acs deferred to the final phase by owner decision. Evidence check: deferred_by_directive on <SHA>, not a certification."; for any other PR, "ACS changed gate deferred to the end of phase <N> by owner decision." Never open a PR only to update bookkeeping.

8. Before merging, check what main changed since your branch last took it in (git diff --name-only $(git merge-base HEAD origin/main) origin/main). Merge origin/main into the branch only if GitHub reports a conflict, main changed a file in this PR's touch set, main used a number or ID you allocated (e.g. a migration timestamp), or a published type is involved on either side: main changed a published file that the files in this PR reference, or this PR changes a published file that a file main added or changed references. Published files are the paths listed in config/module_public_apis.php, and a change to that list counts. Find references with a text search for the full and the short class name, not by reading use lines: fully-qualified and same-namespace references have no use line. If any of these applies, merge origin/main in, push and repeat step 6. Otherwise leave the branch alone; the layer-3 and layer-4 checks cover other cross-PR effects.

9. Merge:

   - Not protected, and step 6 green on the current head: merge it yourself with

     gh api -X PUT repos/{owner}/{repo}/pulls/<N>/merge -f merge_method=merge -f sha=<that head SHA>

     It refuses if the head moved after your checks; that is intended. Continue right away.

   - Protected: never merge it. Continue with independent items. Send me one message listing every waiting protected PR, most-blocking first, when 3 or more are waiting, when one of them blocks the next item, or at the end of each phase. Before you list a PR, repeat step 8 for it, so the SHA you name is verified against a recent main.

10. An item is done only when its box is ticked on origin/main.



A red stops new-scope coding, not the work. Failing tests, formatting, types, boundaries, dead code, routes, config, migrations, tenancy and money violations are repair work, never questions. A failure that also fails on origin/main without your change is not yours: handle it by the Stage 1 decision, never by weakening anything. A check that fails only because a committed record no longer matches the tree is certification upkeep: never re-emit, repin or re-freeze anything to satisfy it; retiring it is a required weakening, so ask (certify-once decision). Ask only for ACS's seven escalation reasons: ambiguous requirement, business or legal judgment, destructive operation, missing external authority (including secrets or .env, or a fix that needs an ACS engine change outside an ACS item), a required weakening of any gate, test, ratchet or baseline, exhausted repair budget, unrecoverable environment. Collect these per phase and keep working on everything they don't block.



Repair budget: ACS's own (MAX_AUTOREPAIR_ATTEMPTS and MAX_NO_PROGRESS_CYCLES in AcsAutonomousRemediationContractGuardTest), counted per failure signature from C:\df-exec\<plan-slug>\attempts.log, across sessions and agents. Keep the clone and the branch until the PR merges. Never rerun an unchanged failing test just to see whether it passes. When the budget is spent, do not ship the item; in a batch, revert that item's commits and ship the rest. Mark the item BLOCKED with its branch name in the next PR, put its attempt history in a GitHub issue linked from that row, and move on to independent items.



If SOURCE changes during execution: finish the item in hand, start nothing new that the change touches, map the change onto the checklist, and present the new or changed items and decisions in one message. Keep working on items the change does not touch.



TESTING

- Test real behaviour through the real entry point (route, page, console command, job, listener) on the real database. Database-sensitive tests run on MariaDB and carry #[Group('engine-semantics')] (rule 551); without it they fall out of the MariaDB lane. Fake only what leaves the process (third-party HTTP, mail, SMS, payments, external storage). Mock the application's own classes only to force a failure path you cannot reach otherwise, and say why.

- Pure calculations (money math, schedules, allocation, payoff) are also proven by fast unit tests with exact expected values that need no database; MariaDB tests prove persistence, locking, transactions and tenancy.

- Migrations run only against your isolated test database, never the shared container's database (rules 525, 551). Production and shared databases are owner-action items.

- Cover the root and every related consumer the item changed (rule 003).

- Source-scanning architecture guards enforce structure (boundaries, ratchets); they never count as proof that behaviour works. No tests that assert on docs, registers or ledgers, or compare committed records with the live tree.

- Evidence in the PR description, per item: head SHA, the checkout the container mounted, exact command, exit code, pass/fail/skip counts, and one line on why these tests cover the change. Zero selected tests, skips, piped exit codes and wedged runs are not passes.

- When SOURCE intentionally changes behaviour, update the tests that pin the old behaviour in the same PR and quote the SOURCE line; if they pin money or golden numbers, the PR is protected. Otherwise never modify, delete, skip or loosen tests, fixtures, expected numbers, ratchets or baselines to get green, and never add entries to tools/acs/registry/known-test-failures.json (it may only shrink). A protected removal re-proves that the affected gates can still fail (rule 560).



CODE

- Modular monolith (rule 351): new code lives in its owning module. Cross-module access only through published contracts, DTOs or domain events. No new reaches. Frozen numbers only go down, and you lower them in the same PR that lowers the count. Keep files within the size limit by extracting, never by raising a ceiling.

- Replace, don't layer (AUDIT-METHOD §12): delete the code your change supersedes, with its callers, config, routes, views and obsolete tests, in the same PR. Every removal needs rule 007's four checks: reference search (code, config, routes, views, string literals), reading each call site, contract review, and focused tests before and after. "Unused" is not "dead": check names built at runtime, Blade resolution, route-name strings, class names stored in the database (morph types, queued and failed jobs, notifications) and public APIs. Never delete migrations. Run the detectors over the touched surface.

- Money only through the rule 020 engine; money changes show before/after numbers and are protected. A dealer-facing capability goes through rule 352 first.

- No scope expansion. Unrelated findings go in the Findings section, in your next PR.



SPEED

- The main cost is the ACS changed gate, which can run close to the full suite. The GATE-SCHEDULE DECISION keeps it off PRs that are not protected; never cut what it runs.

- Batches: up to 6 items may share one branch and one PR when they are in the same phase, have the same protected status, and all their dependencies are merged. Prefer batching items whose touch sets overlap or share callers. Each item keeps its own checkbox, definition of done, separate commit and evidence. Never batch a money, tenancy or security item with anything else.

- During building, run only the exact tests and the directly affected behaviour. A protected PR runs the changed gate once, on the final pushed head, never during iteration.

- Protected gate-infrastructure items go into as few PRs as possible: each one's changed gate starts the selftest.

- Attempt history: record failed attempts in C:\df-exec\<plan-slug>\attempts.log while iterating, and summarise them in the PR description. Never commit them.

- Long gates (the changed gate, module gate, gate:acs-selftest, full suite, full gate:acs): each writer has its own clone, stack and private MariaDB, so each writer may run one long gate at a time, in parallel with the other writer. Never more than one long gate per writer, and never any long gate in C:\DealFactory or against the shared container's database. Do not start a long gate while host memory use is above 75%; wait until it drops. Never kill a running gate to make room.

- Run a second writing agent whenever the PARALLELISM rules allow it; do not stay at one when an independent item is available.

- While a long gate runs, do read-only preparation for the next item. Never edit the checkout under test.



PARALLELISM

- Use read-only subagents freely: roots and related consumers, callers, dead code, relevant tests.

- At most two writing agents, each in its own clone with its own stack and private MariaDB, from the Recipe. The second runs only when the touch sets don't overlap and neither touches a serialized surface. On any unexpected collision, stop the second one and serialize.

- Each writer edits only its own items' rows in the EXECUTION file; the main agent edits the rest.



RESUME (after any interruption)

Trust the repo over notes and memory. Read the prompt copy and SOURCE in the EXECUTION file on origin/main (with its Decisions), C:\df-exec\RECIPE.md, the exec/<plan-slug>/* branches, C:\df-exec\<plan-slug>\attempts.log, open PRs and the plan's GitHub issues. Re-prove the Recipe if it is older than the last session. Finish in-flight branches and PRs first, tick any item whose PR merged without a tick, then continue from the first unticked item. Never redo ticked work.



CLOSING

- End of each phase: run layer 3 of the GATE-SCHEDULE DECISION (a single-phase plan skips it) and fix its reds first. Then re-read SOURCE (not your notes) and report a table: item, type, PR, merged, how verified. Put new questions, blocked items, the waiting protected PRs and the owner-action runbooks in the same message, and keep working on whatever they don't block.

- Pending bookkeeping with no PR coming (end of plan, or everything left is blocked or waiting for me) goes in one closing PR. That is the only PR without an item.

- End of plan:

  1. A fresh read-only subagent checks SOURCE against the merged code on main. Every obligation must map to a ticked item with a merged PR and evidence; each gap becomes a new item and gets executed.

  2. If protected PRs or owner-action items are still waiting for me, send me the list (with the runbooks) and wait; this is the only planned stop at the end.

  3. Certify once: run layer 4 (the full suite and the full gate:acs, once, on the final main, in your clone, with the RECIPE.md commands), plus any end-of-plan certification that SOURCE or the routed rules define (skip the full suite and full gate:acs only if PLAN DECISIONS say so). For each failure: if it also fails on the base commit, it is pre-existing and goes in Findings. Otherwise find the commit that caused it: if it is this plan's, fix it with targeted checks in a PR naming the item it repairs; if it is a peer's, record it for me; if the fix needs an ACS engine change, escalate. After fixes, rerun the full gate. Repeat until only pre-existing, peer and escalated failures remain.

  4. Give me the commands to re-run the final gate myself. Report PLAN COMPLETE only when every item is ticked, including owner-action items I confirmed, with the final table and the lists of pre-existing, peer and escalated failures. Otherwise report PLAN INCOMPLETE with exactly what is left and why.

  5. Then clean (certify-once decision), only after PLAN COMPLETE: tag the certified commit as plan/<plan-slug>/certified and push the tag; move everything that outlives the plan (open findings, pre-existing and peer failures) into GitHub issues; then, in one closing PR, delete docs/plans/<plan-slug>-EXECUTION.md, the SOURCE copy, and anything else the plan created only to track or certify itself. Git keeps every byte. Keep owner-decisions.json and everything ACS reads.

  6. Stop your own compose stacks (only the project names in RECIPE.md). Keep the clones and RECIPE.md for the next plan.



Start with STAGE 1.
```
