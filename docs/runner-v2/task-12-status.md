# Runner V2 Task 12 — Durable Gate Status

> **Authoritative continuation state.** Update this file whenever a gate changes status. Do not infer completion from chat summaries.

Plan: `docs/runner-v2/task-12-bounded-gates.md`

- Gate 0 baseline: IN_PROGRESS
- Gate A fencing: NOT_STARTED
- Gate B POSIX: NOT_STARTED
- Gate C Windows: NOT_STARTED
- Gate D macOS/config: NOT_STARTED
- Gate E lifecycle/Docker: NOT_STARTED
- Gate F benchmark: NOT_STARTED
- Gate G final acceptance: NOT_STARTED

## Current gate

T12-0 — Controlled repair baseline.

## Current commit

Populate/refresh from live repository before implementation; the documentation insertion began from short HEAD `bf57a2de`.

## Failing invariant

Baseline cleanliness/history and extraction of legitimate Task-12-only fixes must be verified before Gate A begins.

## Targeted tests/evidence

No implementation test is accepted merely by this status file. Record exact commands/results as each gate proceeds.
## Reviewer status

T12-0 not yet independently accepted under this new bounded-gate plan.

## Known later-gate issues

Seed from the independent audit and revalidate against live code before acting:
- Gate A: managed-stop lease-renewal fencing TOCTOU risk.
- Gate B: stale-PGID destructive-control and parser fail-closed requirements.
- Gate C: Windows coordination/cleanup ownership failures.
- Gate D: macOS host-native canonical alias versus arbitrary symlink handling.
- Gate E: supervisor/output/release settlement and real Docker lifecycle.
- Gate F: certified preset timeout requires causal classification, not timeout inflation.

When evidence proves any item already fixed, record the validating commit/tests here and mark only the corresponding gate state; do not skip its independent review.