# Task 8.0A Fix Round 5 Re-review

## Round verdict

**ADDRESSED.** The sole remaining Important finding is closed, and no new Critical or Important issue was found in the fix diff.

**Specification compliance: Compliant.** The required fail-closed quarantine, byte preservation, reducer backstop, safe migration exception, terminal compatibility, and current-schema closure are present.

**Task code quality: Approved.** The focused tests and reported validation cover the security and durability boundaries introduced in this round.

## Remaining finding — ADDRESSED

The parser now completes integrity-independent shape parsing and then rejects every non-released schema-version-2 record carrying a cleanup effect with typed `unsupported_active_version`, before state authority is returned (`runner-v2/src/streaming-session-store.ts:410-468`). SQLite verifies the stored row HMAC before invoking that parser (`runner-v2/src/streaming-session-store.ts:314-333`), so coherent HMAC-valid v2 cleanup provenance reaches the typed quarantine but never becomes a readable current record.

Because all store mutations first read and parse the current row, the same gate runs before the reducer or any SQLite update (`runner-v2/src/streaming-session-store.ts:365-380`). Independently, the reducer now derives a missing creation anchor only from schemas below version 2; version-2 cleanup provenance produces `null` and cannot become a version-3 anchor even if the parser gate regresses (`runner-v2/src/streaming-session-store.ts:1094-1100`). Any attempted v3 transition with that null anchor fails current-schema closure before persistence.

The signed-forgery regression constructs the coherent origin/first-transition forgery, verifies typed refusal from `apply` and `readBySession`, compares raw `record_json`, HMAC, and revision before and after refusal, closes/reopens, and verifies both refusal and byte-for-byte preservation again (`runner-v2/test/streaming-session-store.test.ts:755-827`). The authority regression proves recovery refuses before callback execution, launch/write authorization refuses, and takeover refuses (`runner-v2/test/session-authority.test.ts:1160-1267`). Thus the quarantined row is not mutated, replayed, relaunched, or exposed as current family/model authority.

## Compatibility and closure checks

- Cleanup-free active version-2 state remains readable and creates a fresh version-3 anchor plus empty provenance chain only when cleanup actually begins (`runner-v2/test/streaming-session-store.test.ts:830-855`).
- Released version-2 cleanup history remains read-only with `cleanupOwner === "none"` and no current anchor (`runner-v2/test/streaming-session-store.test.ts:857-880`); the active-v2 quarantine explicitly excludes only `released` (`runner-v2/src/streaming-session-store.ts:459-465`).
- Current version-3 multi-step takeover remains anchored to immutable effect identity, owner, fence, and creation time, including coherent-forgery and HMAC-tamper refusals (`runner-v2/test/streaming-session-store.test.ts:882-1040`).
- Active downgrade and unsupported future-version refusal remain covered (`runner-v2/test/streaming-session-store.test.ts:208-221`).
- Cleaned and blocked settlement still use direct SQLite close/reopen with fresh authority and no terminal replay (`runner-v2/test/session-authority.test.ts:909-1071`, `runner-v2/test/session-authority.test.ts:1073-1158`).

## New Critical/Important breakage

### Critical

None.

### Important

None.

No residual scoped Critical or Important issue remains.

## Test and validation evidence

The implementer report contains a natural coherent-forgery/laundering RED and GREEN, parser-gate mutation/revert evidence both before and after the reducer backstop, authority fail-closed coverage, and safe-migration/terminal compatibility coverage (`.superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8.0a-implementer-report.md:353-360`). It reports 60-, 89-, and 107-test passes, successful Runner V2 typecheck after correcting a test-only binding type, focused lint, and diff check (`.superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8.0a-implementer-report.md:362-371`). I did not rerun those reported suites; the diff and permanent regressions resolve the scoped code questions.

## Out-of-scope observations

None.

## Final assessment

**Fix Round 5: ADDRESSED. Specification compliance: Compliant. Task code quality: Approved.** There are zero residual Critical or Important issues in this governed scope; Task 8.0A satisfies the reviewer exit gate.
