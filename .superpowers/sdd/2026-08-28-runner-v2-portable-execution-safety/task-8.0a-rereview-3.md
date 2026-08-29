# Task 8.0A Fix Round 3 Re-review

## Round verdict

**NOT ALL ADDRESSED.** Finding 1 is addressed. Finding 2 remains open because the provenance chain is self-consistent but is not anchored to immutable pre-takeover ownership evidence; a coherently forged origin is accepted.

**Specification compliance: Needs fixes.** Recovered cleanup can now settle cleaned or blocked under the new fence, but the strict parser still does not refuse all forged provenance required by this round.

**Task code quality: Needs fixes.** No Critical issue was found. One Important parser-closure defect remains, plus a durability-test coverage gap noted below.

## Per-finding verdicts

### 1. Recovered blocked settlement after fence takeover — ADDRESSED

The `cleanup_pending` takeover now requires the new fence to be exactly the current fence plus one, preserves the existing effect identity, and changes the effect fence and durable owner fence in the same reducer result (`runner-v2/src/streaming-session-store.ts:1033-1082`). Pending, blocked, and released states again require the cleanup effect fence to equal the current record fence (`runner-v2/src/streaming-session-store.ts:780-784`, `runner-v2/src/streaming-session-store.ts:851-880`). Consequently, `recoverAdopted()` can replay the re-fenced effect and persist either `mark_cleanup_blocked` or `acknowledge_cleanup` without the former post-callback parser failure (`runner-v2/src/session-authority.ts:470-528`; `runner-v2/src/streaming-session-store.ts:1146-1184`). A later `cleanup_blocked` recovery returns before invoking replay, while a released record is recovery-ineligible (`runner-v2/src/session-authority.ts:470-490`).

The SQLite writer derives the transition from the integrity-checked current row and atomically CAS-updates record JSON, HMAC, and revision in one statement (`runner-v2/src/streaming-session-store.ts:300-320`, `runner-v2/src/streaming-session-store.ts:351-366`). The cleaned and blocked regressions verify one replay followed by terminal no-replay behavior (`runner-v2/test/session-authority.test.ts:1020-1045`, `runner-v2/test/session-authority.test.ts:1095-1123`).

### 2. Arbitrary older fences / forged takeover provenance — NOT ADDRESSED (Important)

The parser correctly checks effect ID, origin/transition continuity, one-step fences, chronological transition ordering, and the final current owner/fence (`runner-v2/src/streaming-session-store.ts:785-817`). Those checks are not anchored to an immutable durable statement of the effect's original `ownerId`. The parser initializes its proof from the caller-provided `originOwnerId` and then only checks the first transition against that same caller-provided value (`runner-v2/src/streaming-session-store.ts:793-805`). A record can therefore change both `cleanupProvenance.originOwnerId` and the first takeover's `fromOwnerId` to the same forged owner while retaining the real effect ID, fences, final owner, and timestamps; every current guard passes.

The added negative test changes only `originOwnerId`, leaving the first `fromOwnerId` unchanged, so it proves mismatch rejection but not forged coherent provenance rejection (`runner-v2/test/streaming-session-store.test.ts:743-775`). A focused read-only check built a valid taken-over record, changed both fields to `"forged-owner"`, and called `parseStreamingSessionRecord`; observed output was `FORGERY_ACCEPTED`. Thus missing and internally inconsistent provenance are refused, but forged internally consistent provenance is not.

This also means the claimed old-to-new chain is not closed evidence: the record's state history contains only states/timestamps and takeover does not append immutable owner/fence history (`runner-v2/src/streaming-session-store.ts:117-120`, `runner-v2/src/streaming-session-store.ts:886-912`, `runner-v2/src/streaming-session-store.ts:1074-1082`).

## New Critical/Important breakage in the fix diff

### Critical

None found.

### Important

No separate new Critical/Important breakage beyond the still-open provenance finding above.

## Test and validation evidence

The implementer report records natural RED/GREEN cycles for cleaned re-fencing, blocked settlement, and SQLite provenance, plus a provenance-guard mutation/revert/GREEN cycle (`.superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8.0a-implementer-report.md:259-267`). It also records affected runs of 85 and 107 tests, Runner V2 typecheck, focused lint, and diff check (`.superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8.0a-implementer-report.md:275-283`). I did not rerun those reported suites.

**⚠️ Durability coverage gap:** the cleaned and blocked exactly-once authority tests use the in-memory store (`runner-v2/test/session-authority.test.ts:1020-1045`, `runner-v2/test/session-authority.test.ts:1051-1123`). The SQLite test reopens only the still-`cleanup_pending` taken-over record and does not settle cleaned or blocked through `SessionAuthority` before reopening (`runner-v2/test/streaming-session-store.test.ts:708-807`). The shared reducer and one-row CAS support the behavior, but the requested permanent regression coverage for both terminal results across SQLite reopen is absent.

## Out-of-scope observations

None.

## Final assessment

**Fix Round 3: NOT ALL ADDRESSED.** Finding 1 is **ADDRESSED**; Finding 2 is **NOT ADDRESSED**. Task 8.0A remains unapproved and Task 8.0B should remain locked until cleanup provenance is anchored so a coherently forged origin/first transition cannot pass, with direct SQLite-reopen settlement regressions retained for both cleaned and blocked outcomes.
