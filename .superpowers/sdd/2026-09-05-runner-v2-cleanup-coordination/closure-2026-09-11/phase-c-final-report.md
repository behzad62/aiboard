# C phase — verified cleanup-coordination acceptance

**PHASE VERIFIED 100% COMPLETE — NEXT PHASE MAY BEGIN**

Accepted on 2026-09-11 after the final complete configured Runner gate, exact source/resource reconciliation and owner-authorized controller self-review. Independent review was explicitly removed as a requirement by the owner; no provider/reviewer approval is fabricated.

**Actual next queue unlocked:** remaining Task 8.0B3 / P6.4e handback work. This is not a declaration that B3, P6, P6.5, P6.6 or P7 is complete, and it does not execute those phases.

## Final mechanical evidence

| Gate | Verified result |
| --- | --- |
| Complete current Runner test-file graph | 152 test files; 2,265 tests: 2,264 passed, 0 failed, 0 cancelled, 0 todo, 1 platform skip |
| Configured client/UI/policy checks after that graph | All 12 commands passed in the original configured order |
| Entire configured command sequence | 13/13 commands completed; exit 0 |
| Source binding across the accepted run | All 361 inputs unchanged; live source matches the accepted hashes |
| Actual Linux validation | 21/21 passed, zero skips, including the exact POSIX fixture skipped on Windows |
| Configured Runner TypeScript check | Exit 0 |
| ESLint across runner-v2/src and runner-v2/test | Exit 0 |
| Final self-review | Accepted for C's approved requirements; historical diagnostic exclusions remain explicit |

The accepted run finished at 14:21:49 UAE time on September 11, 2026. Evidence: full-runner-accepted-terminal.json, all 13 per-command result files, command-manifest.json, source-before.json, source-after.json and logs. closure-acceptance-proof.json verifies the complete command sequence, all current hashes, final totals, required named integration results, static checks, resource classes and unchanged original Git/index state.

The sole Windows skip is `POSIX native session fixture owns descendants after launcher exit`. The exact test passed on actual Linux in linux-native-final.tap.log. This is explicit complementary platform coverage, not a skipped-pass or a Windows model substituted for Linux execution. macOS was not executed.

The earlier full run with 19 failures remains failed. Its narrow synthetic fixture-path, already-settled-result and delegated-lock expectation corrections have retained causal RED/material RED/restored GREEN proof. A later 2,258-pass full run remains a separate successful predecessor. The final acceptance run additionally includes the six Job-bootstrap regressions; separate counts are not combined into an invented run.

## Required native integration — all passed in the accepted full run

- Post-ready oversized MCP failure rejects its call and releases the exact process session.
- Persistent output remains private between calls; injected diagnostic spill failure preserves protocol bytes and truthful evidence loss.
- CLI active-extension startup failure closes discovery/public ownership before readiness.
- Strict OCI public MCP uses the separately attested image command and refuses unsafe host identities.
- Public MCP close and crash recovery certify their exact descendant trees without relaunch.
- Two concurrent real run bindings cannot cross grants, output or cleanup effects.
- A real Runner pre-transfer crash recovers exactly once without fabricated adoption.

These are actual test outcomes in the final full log, not earlier selected greens used as substitutes.

## Accepted implementation and self-review

C1 — Coherent protocol: exact-fence effect/reader boundaries, stale versus unavailable/unknown outcomes, interrupted ACK-retirement intent and coherent output snapshots remain intact. No missing evidence is reinterpreted as successful consumption. The accepted shared terminal dispatcher remains covered.

C2 — Durable cleanup: all valid nonterminal pre-adoption records can enter consecutive-fence recovery after owner expiry. Live/foreign ownership and revision guards remain. A missing backend binding proves safe no-launch cleanup only when the durable effects show that no launch/channel was issued; ambiguous issued effects stay blocked. Late isolation acquisition stays owned until durably bound. Adopted cleanup still requires every individual resource fact before SessionAuthority's final release; late effects cannot overlap merely because callers time out.

C3 — Durable evidence: SHA-linked bounded continuation, exact stream positions, no duplicate family delivery, immutable manifest verification and explicit capacity/storage/legacy-gap loss remain. Old excluded overwritten fault traces remain excluded; this report does not invent proof of those historical trials.

C4 — Workload/witness separation: actual Linux execution verifies the portable workload group and surviving output/terminal witness. Windows portable and optional Job behavior are separately tested. Suspended-start Job containment used by deliberately faulted Windows test fixtures is test-only and does not turn optional Job support into a new product requirement.

C5 — Safe integration and cleanup: the four capability/manager finalizers and remaining Windows/LSP/managed/internal finalizers preserve actual cleanup ownership, join owned close, retain falsey primary/error reasons and do not use numeric-PID fallback control. The CLI observation/deadline fixtures reach their intended boundary without changing product timeouts. OCI image execution no longer inherits host PATH variants; private approved variables and control-plane environment restrictions remain. Optional Job reattachment reports genuine authenticated consumption positions without inventing zero consumption or launching a read/ACK pump.

The Job-bootstrap correction is explicitly after the predecessor full green. Six new behavioral cases and missing-metadata/forged-zero material reversals were verified, then the entire current graph was rerun. No production bytes changed during or after that accepted run.

## Resource accounting and retained evidence

The final accepted run logged 1,855 exact Windows acquisitions: 1,800 paths are absent; 55 are intentionally retained non-native recovery-test diagnostics. All 55 are attributable to streaming-precheckpoint-recovery.test.ts: memory/real-SQLite/artifact fixtures with synthetic process/isolation/channel effects. The reviewed finalizers close their database/spool/channel handles and join late effects. There are **zero retained native fixture roots from the accepted run**. Successful native release is supported by each test's actual owner/finalizer assertions, not filesystem absence alone.

Across all attempts in this closure packet, the ledger preserves 5,628 Windows acquisition records: 5,442 absent and 186 retained. Of the retained roots, 165 are the synthetic recovery diagnostics from three complete runs; 21 are earlier failed-attempt diagnostic roots. Those earlier failures are not retroactively passed or universally claimed released. Twenty-one Linux acquisition records are handled in their isolated namespace; the exact native container exited 0, copied /tmp was empty, and label-verified removal succeeded. No Windows existence inference is made for Linux paths.

All 15 recorded wrapper identities are no longer present. Fourteen have terminal receipts. The earliest failed historical-CLI recovery launcher has a retained error log but no terminal receipt; its exit code is not invented. This does not affect the complete accepted gate's explicit terminal receipts.

### Historical exception: earlier CLI fixture ggPTew

This pre-closure failed fixture is not represented as recovered. Authenticated recovery now advances its expired ownership but still refuses an existing zero-byte, noncanonical Job coordination file. Its host/channel release remains unverified, and its child/supervisor were last observed live in the retained observations. No PID-only termination, coordination-file deletion/reinitialization or fabricated terminal transition was used. Preserve this historical ownership exception and the earlier recordless CLI chain for separately governed exceptional recovery; C acceptance does not authorize destroying their evidence.

This boundary follows the approved requirement to preserve and report historical uncertainty. The successful current acceptance run has no unaccounted newly retained native workload. Historical failed artifacts are not counted as clean current fixtures.

## Delivery and audit record

Original HEAD remains 4bf64cf398a2f8d57b464182efbc2aa492dee78d on codex/runner-v2-robust-build. The original staged entries are unchanged. Work remains in the existing dirty isolated worktree. No commit, staging, publication, dependency/Node-policy change, model-provider execution or later-phase implementation was performed.

Finalization encountered transient upstream/connection errors and rejected combined read-only audit requests. No denied operation was treated as executed or as a test result. Separate permitted verification operations supplied the final receipts. No historical MCP failure cause is asserted merely because later runs passed.

Primary evidence: closure-acceptance-proof.json; closure-verification-static.json; closure-command-wrapper-ledger.json; closure-material-evidence-index.json; final-resource-ledger.json; full-runner-accepted-*; linux-native-final-*; prior-cli-authenticated-recovery3.json; prior-cli-incomplete-coordination-observation.json; closure-git-preservation.json.

**Self-review verdict: C requirements verified on the accepted source. Clear the C-specific lock and hand back to remaining B3/P6.4e work only.**