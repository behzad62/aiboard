# Task 8.0A Fix Round 4 Re-review

## Round verdict

**NOT ADDRESSED.** New schema-version-3 cleanup records have an effective independent creation anchor, and the SQLite terminal-coverage warning is addressed. However, the version-2 upgrade path accepts the exact coherently forged provenance shape from the prior finding and then derives the new version-3 anchor from that untrusted provenance, laundering the forgery into the supposedly anchored schema.

**Specification compliance: Needs fixes.** The new schema is closed for newly created version-3 records, but upgrade safety and parser closure for readable version-2 records remain incomplete.

**Task code quality: Needs fixes.** No Critical issue was found. One Important upgrade/parser defect remains.

## Remaining provenance-anchor finding — NOT ADDRESSED (Important)

For native version-3 records, `begin_cleanup` writes the anchor, provenance origin, and cleanup effect together (`runner-v2/src/streaming-session-store.ts:1192-1232`). The parser independently cross-checks anchor effect ID, creation time, owner, and fence against the cleanup effect and provenance before walking the transition chain (`runner-v2/src/streaming-session-store.ts:830-875`). This correctly refuses the original two-field provenance-only forgery for newly created version-3 state, and takeover continues to preserve the anchor while atomically re-fencing the same effect (`runner-v2/src/streaming-session-store.ts:1112-1162`). SQLite HMAC validation protects the complete stored row before parsing (`runner-v2/src/streaming-session-store.ts:314-333`).

The compatibility upgrade undermines that boundary. Version-2 records deliberately skip the anchor requirement (`runner-v2/src/streaming-session-store.ts:416-459`, `runner-v2/src/streaming-session-store.ts:837-855`), so a version-2 cleanup record with a coherently forged `originOwnerId` and matching first `fromOwnerId` still parses—the exact defect proven in round 3. On any reducer mutation, `cleanupCreationAuthorityFor()` derives the new anchor's owner and fence directly from that version-2 provenance (`runner-v2/src/streaming-session-store.ts:1009-1022`); the reducer then promotes and persists it as version 3 (`runner-v2/src/streaming-session-store.ts:1087-1093`, `runner-v2/src/streaming-session-store.ts:1153-1162`). Once promoted, the forged provenance and derived anchor agree, so all new schema-3 checks pass.

HMAC integrity does not establish that old version-2 semantics were truthful; it establishes only that the bytes have not changed since they were accepted. The old version-2 parser was precisely the component that accepted coherent forged provenance. The SQLite writer can also parse and HMAC-sign a claimed version-2 record before applying the upgrade (`runner-v2/src/streaming-session-store.ts:335-352`). Therefore deriving the independent anchor from the previously unanchored field is not a safe upgrade for version-2 cleanup records with takeover history.

The upgrade test covers only a version-2 cleanup record before any takeover, with an empty truthful provenance chain (`runner-v2/test/streaming-session-store.test.ts:719-751`). It does not exercise a version-2 record containing the coherent forged origin/first-transition shape or verify that such a record is refused rather than blessed into version 3.

## SQLite terminal-coverage warning — ADDRESSED

The cleaned regression now uses SQLite, settles `cleanup-1` once, closes and reopens the database, creates a fresh `SessionAuthority`, and proves recovery is refused without another callback while the row remains `released` (`runner-v2/test/session-authority.test.ts:907-1063`). The blocked regression likewise uses SQLite, closes and reopens after settlement, and proves fresh-authority recovery returns the durable blocker without replay (`runner-v2/test/session-authority.test.ts:1071-1150`). This directly covers both requested terminal outcomes across reopen.

## New Critical/Important breakage in the fix diff

### Critical

None found.

### Important

No separate new Important issue beyond the unsafe version-2 provenance-to-anchor upgrade described above.

## Test and validation evidence

The implementer report contains the requested natural RED/GREEN for the independent anchor, a focused anchor-cross-check mutation/revert/GREEN, a version-2 upgrade RED/GREEN, and direct SQLite terminal coverage (`.superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8.0a-implementer-report.md:309-316`). It also reports 57-, 86-, and 107-test passes, Runner V2 typecheck, focused lint, and diff check (`.superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8.0a-implementer-report.md:318-327`). The version-2 RED/GREEN fixture is insufficient for the dangerous nonempty forged-chain upgrade described above. I did not rerun the reported suites because the remaining issue follows directly from the changed migration logic.

## Out-of-scope observations

None.

## Final assessment

**Fix Round 4: NOT ADDRESSED.** The SQLite terminal warning is closed, but Task 8.0A remains unapproved and Task 8.0B should remain locked until version-2 cleanup records with unanchored takeover provenance are refused/quarantined or upgraded using genuinely independent durable authority rather than deriving the new anchor from the vulnerable provenance itself.
