# Session lessons — worker failure modes to check against Runner V2

Owner decision 2026-09-26 (option 1): after T6b is accepted, a fresh-context Opus reviewer audits each row below against the real Runner V2 code (read-only) and marks it handled / partly handled / not handled, with file:line evidence and a scenario. Each gap becomes a small packet added before T8 (controller decision **EX-4**).

Source: failure modes observed while building P6.5, the agent-capability program and P6.6 with worker models (Cursor/Grok, Sonnet, MiMo via Codex, Muse) and independent Opus reviewers.

| # | Observed failure | Runner feature expected to catch it |
|---|---|---|
| L1 | Worker reported "done" with half the work missing (T6a first pass: library only) | T6a deliverable review; acceptance only after boundary checks |
| L2 | Evidence claimed but never performed (fake "passed", invented evidence ids, placeholder inputs) | Kernel evidence-id validation; "real counts" rule |
| L3 | Feature built but not wired into the production flow | Review of the real change; factory-built end-to-end tests |
| L4 | Tests "passed" with zero tests run (NODE_TEST_CONTEXT leak; exit 0; empty describe; name filter matching nothing) | Owner "real counts" rule (T6a) |
| L5 | Worker blamed its sandbox for real defects (T4 workspace-manager) | Independent review; re-runs outside the sandbox |
| L6 | Encoding damage (mojibake em dashes/arrows, BOM, mixed line endings) introduced by edits | none known |
| L7 | Same failed fix repeated across rounds (T5 Gradle rules oscillation) | T6b RepairApproachDecision + issue budgets |
| L8 | Over-correction vs under-correction swings | none known (review is not required to check both directions) |
| L9 | In-memory fakes hid durable-state bugs (idempotency-key collisions, timestamps in idempotent payloads, reset counters) | none known in the runner (review practice only) |
| L10 | Tests that can never fail (vacuous assertions, seeding around the code under test) | none known in the runner (prove-red is a controller practice) |
| L11 | Worker stopped mid-task (model stream timeout, 429/402/403 provider limits, context overflow) | Session checkpoints, provider retry, pause with reason, resume |
| L12 | A new worker inherited half-done, unreviewed edits from a stopped worker | partly (new attempt / claims); not checked in depth |
| L13 | False evidence claims (template hashes, wrong counts, prove-red recorded against an older file) | partly (kernel checks some fields) |
| L14 | Task too large for one worker (T6) | none known (plan review does not check task size) |
| L15 | Leftover background jobs / helpers / temp files | T6b OA-17 cleanup (partly) |
| L16 | Stale or leaked environment/tool setup (tsx found only via caller PATH; stale shims ignored by .gitignore) | none known |
| L17 | Worker edited forbidden or out-of-scope files | T4 claims / writable surfaces (partly; writableSurfaces not enforced in worker tools) |
| L18 | Duplicate expensive test runs (owner rule: do not re-run green suites) | partly (T5 evidence reuse / applicability) |
