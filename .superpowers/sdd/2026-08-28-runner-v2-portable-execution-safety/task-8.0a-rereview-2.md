# Task 8.0A Fix Round 2 Re-review

## Round verdict

**NOT ADDRESSED.** The new post-expiry takeover can preserve and successfully acknowledge the existing cleanup effect, but the same recovered effect still cannot be durably marked blocked. The fix also weakens strict parser closure by accepting any numerically older cleanup fence without durable takeover provenance.

**Specification compliance: Needs fixes.** The required recovery path must be able to replay and then either acknowledge **or durably block** the sole existing cleanup effect, while refusing effect fabrication. Those conditions are not both met.

**Task code quality: Needs fixes.** There are no new Critical findings, but two Important correctness/parser issues remain in the fix diff.

## Remaining finding verdict

**NOT ADDRESSED — Important.**

The successful settlement branch is now present: takeover admits an expired adopted `cleanup_pending` record and advances only the durable owner lease/fence (`runner-v2/src/streaming-session-store.ts:878-927`), while the pending effect may retain its older fence (`runner-v2/src/streaming-session-store.ts:714-720`, `runner-v2/src/streaming-session-store.ts:750-759`). `recoverAdopted()` checks the exact new owner/fence and current lease before replay (`runner-v2/src/session-authority.ts:481-505`), and its cleaned branch can acknowledge the old effect to `released` (`runner-v2/src/session-authority.ts:518-526`, `runner-v2/src/streaming-session-store.ts:770-779`). The regression test verifies exactly that cleaned path (`runner-v2/test/session-authority.test.ts:987-1030`).

However, when replay returns `blocked`, `recoverAdopted()` submits `mark_cleanup_blocked` for the retained old-fence effect (`runner-v2/src/session-authority.ts:505-516`). That mutation changes only the effect status and timestamp; it does not re-fence the effect (`runner-v2/src/streaming-session-store.ts:996-1013`). The resulting `cleanup_blocked` record is then parsed under an exact-current-fence requirement (`runner-v2/src/streaming-session-store.ts:760-769`). After the demonstrated fence-1-to-fence-2 takeover, parsing therefore throws `invalid_state` after the external replay callback has already run. Startup recovery still cannot durably block that cleanup, so the sole effect remains pending and can be replayed again on another recovery attempt.

The new test returns only `"cleaned"` in the post-takeover replay (`runner-v2/test/session-authority.test.ts:1020-1030`); it has no post-takeover `"blocked"` case capable of exposing this failure.

## New Critical/Important breakage in the fix diff

### Critical

None found.

### Important

1. **Recovered blocked cleanup cannot be persisted.** This is the settlement failure described above (`runner-v2/src/session-authority.ts:505-516`; `runner-v2/src/streaming-session-store.ts:760-769`, `runner-v2/src/streaming-session-store.ts:996-1013`).

2. **Strict parser closure no longer proves that an older cleanup effect is the exact effect preserved by a valid takeover.** For `cleanup_pending`, validation now accepts any cleanup effect whose fence is merely less than or equal to the current record fence (`runner-v2/src/streaming-session-store.ts:714-720`, `runner-v2/src/streaming-session-store.ts:750-759`); `released` applies the same inequality (`runner-v2/src/streaming-session-store.ts:770-779`). The record carries no checked takeover provenance tying that older effect fence to the current owner fence. Consequently, an otherwise well-shaped record with an arbitrarily old/fabricated cleanup fence satisfies this parser rule. That does not meet the requested condition that effect fabrication remain refused.

## Required refusal properties

The fix and its regression do preserve the intended refusals for pre-expiry takeover, wrong/stale ownership, generic expired-owner mutation, stale recovery before callback execution, input/access/relaunch, and duplicate recovery (`runner-v2/src/streaming-session-store.ts:878-895`; `runner-v2/src/session-authority.ts:481-488`; `runner-v2/test/session-authority.test.ts:945-1018`, `runner-v2/test/session-authority.test.ts:1031-1035`). `cleanup_blocked` is not takeover-eligible (`runner-v2/src/streaming-session-store.ts:878-887`). These protections do not cure the blocked-settlement and parser-provenance defects above.

## Test and validation evidence

The implementer report contains the claimed natural RED, mutation RED, GREEN focused test, affected 83-test and 107-test runs, Runner V2 typecheck, focused lint, and diff check (`.superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8.0a-implementer-report.md:216-233`). The reported regression is incomplete because it exercises only the `cleaned` result despite the requirement explicitly covering durable blocking (`runner-v2/test/session-authority.test.ts:1020-1030`). I did not rerun the reported suites; the remaining defect follows directly from the changed transition and parser code.

## Out-of-scope observations

None.

## Final assessment

**Fix Round 2: NOT ADDRESSED.** Keep Task 8.0A unapproved and Task 8.0B locked until recovered old-fence cleanup can be durably blocked as well as acknowledged, and strict parsing can verify legitimate takeover provenance rather than accepting an arbitrary older cleanup fence.
