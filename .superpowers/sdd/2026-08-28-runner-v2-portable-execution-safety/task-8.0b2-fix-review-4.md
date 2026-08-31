# Task 8.0B2 Fresh Re-review — Fix Round 3

Range reviewed: `9f2d52d1..e5f0c59c`

## Verdict

**CHANGES REQUIRED — B2 cannot close.**

Zero Critical findings. Four Important gaps remain. The optional Job watchdog,
the preceding six B2 fixes, declared Node policy, and normal active fence paths
remain verified, but portable crash recovery, final retirement, focused cleanup,
and safe historical residue ownership are not yet complete.

## Addressed findings

1. **Addressed — bounded optional active Job probe.** The real create/close
   probe has an explicit child-process deadline, terminates a hung injected
   child, settles only the Job fact unavailable, and preserves independently
   verified portable, batch, and tree facts.
2. **Addressed — active and queued crash-safe fence behavior on Windows/Linux.**
   The shared SQLite authority binds immutable acquisition UUID, exact PID, and
   birth; holds a transaction through the lowest effect; protects an exact live
   holder; recovers dead/birth-mismatched holders; serializes reclaimers; and
   fails closed on corrupt/unknown evidence and effect-finalization failure.
3. **Addressed — test-only evidence wrapper bound.** The 60-second wrapper is
   test-only and captures/asserts the unchanged 25,000 ms production command
   deadline.
4. **Addressed — all six earlier Important findings.** Actor-free Job extraction,
   genuine bounded duplex/backpressure, independent semantic consumers,
   monotonic lowest-boundary fencing, immediate re-attestation, fail-closed
   output evidence, and bounded CIM/destructive control remain intact.
5. **Addressed — policy and scope.** Node remains `>=22.13.0 <23 || >=24.0.0
   <25`, Job remains optional, no exact 24.18.0 pin or Windows-only product
   requirement was added, and B3/OCI/family routing remains inactive.

## Remaining Important findings

1. **Important — macOS dead holders are not recoverable.**
   The generic POSIX branch of `inspectProcessBirth()` invokes
   `ps -o lstart= -p <pid>` and converts every nonzero exit to `unknown`. macOS
   returns nonzero when the PID is absent, so a crashed holder is never proven
   absent and permanently blocks recovery. The Windows-host Node 22.13 test does
   not execute this branch. Absent, permission-denied/live, malformed, timeout,
   and exit-during-inspection outcomes must be distinguished without treating an
   arbitrary `ps` failure as absence.
2. **Important — retirement can be resurrected and leaves coordination
   residue.** A successful retiring effect unlinks the SQLite database. A later
   stale caller sees an absent path as permission to initialize a new active
   protocol before its durable fence/record check fails. Deterministic review
   reproduction observed `after-retire false` then `after-stale-call true`.
   Retirement must remain durably non-resurrectable throughout authority/evidence
   removal. A stale or concurrent post-release call must perform no effect and
   leave no database, journal, WAL, SHM, tombstone, or task root residue.
3. **Important — a fresh focused cleanup guard leaked a live supervisor/root.**
   Fresh review ran 48 focused tests: 47 passed and the timed-out live duplex
   cleanup guard failed. It retained
   `aiboard-windows-semantic-duplex-QPXulx`, portable supervisor PID 30336, and
   durable `outcome_unknown`. The original PID 61496 birth was recycled; cleanup
   caught and suppressed both bounded release failures, preserving the root and
   helper. Fail-closed evidence is correct, but exact temporal/birth proof must
   allow the test-owned cleanup path to stop the authenticated supervisor,
   ignore rather than signal the proven replacement PID, and remove its root.
4. **Important — historical cleanup can delete an unrelated same-prefix Temp
   directory.** The inventory accepts broad categories such as
   `aiboard-windows-`; an immediate non-link directory containing no recognized
   JSON ownership document is considered valid with zero owners and recursively
   deleted. Review created `aiboard-windows-unrelated-review-*` containing only
   `keep.txt`; it was inventoried and deleted. Prefix membership is not ownership
   proof. Inventory detection and deletion authority must be separate, and
   deletion must require a closed exact test-root identity plus recognized,
   internally valid ownership evidence (or a current invocation-owned sentinel).

## Fresh verification observed by review

- Focused lock/probe/residue/evidence command: 47 pass / one fail.
- Exact Node 22.13 lock suite: 9/9 pass; the SQLite ExperimentalWarning is not
  itself a contract failure.
- The implementation report records a final serial package result of 1,377
  total / 1,376 pass / zero fail / one explicit skip, but the later fresh
  focused failure supersedes its residue evidence.
- Worktree and diff hygiene were clean during review.

**B2 CANNOT CLOSE. B3 REMAINS LOCKED.**
