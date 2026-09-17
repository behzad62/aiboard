# Controller independent acceptance checklist
Current implementation owner: implementation-1 (one CLI worker). Controller source work is read-only until its terminal receipt.

Required final adversarial checks, not satisfied merely by a green fake-runtime unit test:
- Routine-state exclusion must hold before generator or native effect, including direct malformed scheduler recovery events.
- Actual native source scope must contain durable full binding/birth fingerprints; a stable PID alone must never authorize reconcile/signal/cleanup.
- Lease takeover, native effect journal and original opaque execution grants remain authoritative. Local-user approval cannot substitute for actual identity or unblock uncertain pending effects.
- Every validation refusal/model failure is durably fingerprinted and categorized without copying untrusted input IDs, rationale, argv or unknown error strings that might contain arbitrary secrets.
- Concurrent invocation claims are atomic. Same-instance duplicate joins rather than repeats. A restarted in-flight action is unknown, and unknown records cannot be overwritten by late async success or automatically replayed.
- Explicit user decision binds the whole proposal and expires with it. Full mode does not autoapprove destructive recovery.
- Resume/completion cannot bypass an unresolved destructive/unknown action; closure must come from deterministic identity-bound cleanup proof, not a user boolean.
- Failure/timeout after effect dispatch is not proof of no side effect; backend cleanup facts remain separately visible even when inspection succeeded.
- Native/API/client pathways must be actually wired, not optional callbacks never supplied in production. Tests must reach the real shared kernel/current-host backend.
- Historical observation must never initialize a host/store, reattest a backend, migrate SQLite or invoke a model. Missing/old evidence is explicitly unverified/unavailable, not current enforcement.
- Live observation must include command and streaming processes, backend/provider semantics, Full bypass, output loss, precise cleanup blockers, lease/grant state and redacted recovery records.
- No new raw shell/kill launcher, arbitrary artifact deletion, general-purpose model cleanup loop or unbounded I/O body.
- Required routine-acceptance and PID-only causal faults must fail their material assertions, not only compilation or module loading; restore byte-exact.
- Final affected source manifest, accepted resource accounting and original protected baseline must be independently checked before Task 11 VERIFIED or commit.

Known pre-worker core fixture issue: the generic fake execute result always says running/pending. It is correct for product termination to classify that as outcome_unknown; a positive termination fixture needs exited/verified_empty proof, and a separate negative fixture must keep pending non-green.
