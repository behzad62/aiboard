# Task 8.0B1 exceptional repair round 6 — complete kernel cleanup authority

## Authority, entry, and one-time budget

- Entry HEAD is `c6a5c5be`. Read this brief first, then
  `task-8.0b1-rereview-5.md`, `task-8.0b1-brief.md`, and the round-5 section of
  `task-8.0b1-report.md`.
- The owner explicitly authorized one exceptional sixth repair round after the
  governed 5/5 breaker. This is not a general budget reset. It owns only the two
  Important findings below.
- Task 8.0B1 remains unapproved and Task 8.0B2 remains locked throughout this
  packet. An implementation report or green tests cannot unlock B2; a fresh
  independent scoped re-review and controller verification are mandatory.
- Preserve every previously approved B1, 8.0A, Task 7, and Task 3 behavior.
- Node policy remains maintained Node 22 or 24. Never add an exact patch pin.

## Exact exclusions

- Do not implement or activate native, POSIX, Windows, Windows Job, or OCI
  adapters. Do not modify CLI/control-server/native-factory construction or
  route Git, MCP, LSP, managed processes, or any provider family.
- Do not add another database, raw spawn/kill/shell path, ambient environment
  access, OS-name product branch, AI-selected cleanup command, or durable raw
  error diagnostics.
- Do not redesign Task 7 contracts, weaken Task 8.0A authorization/fencing/
  provenance, expand the host lifecycle, or make active schemas silently
  permissive.
- Do not repair unrelated findings. Record non-critical unrelated observations
  for their owning future packet.

## Root causes already reproduced

1. `begin_cleanup` trusts a caller-supplied nonempty resource subset. The
   reducer can therefore persist only `channel`, and
   `settle_cleanup_cleaned` can release that launch while its durable lease and
   backend binding remain. The parser also accepts a pending/failed resource
   fact authenticated by a historical takeover owner/fence instead of the
   exact current cleanup owner/fence.
2. `durableFailureMessage()` truncates provider-controlled text but does not
   classify it. Resource `failure` and cleanup `blocker` fields can therefore
   persist credentials, tokens, environment values, argv, paths, or payloads.

The repairs must remove authority at the sources: cleanup membership is a
kernel invariant, and durable failure data is a closed typed vocabulary.

## Packet R6.1 — kernel-derived complete cleanup ledger

### Required behavior

- The streaming kernel, not a runtime caller, derives the authoritative cleanup
  duty set from authenticated durable launch/checkpoint state. The duty rules
  are closed and deterministic:
  - every non-handed-off host launch owns an exact `host` duty;
  - an authenticated durable lease binding owns an exact `isolation_lease`
    duty;
  - an output checkpoint owns an exact `output_checkpoint` duty;
  - a channel duty exists only when durable state proves that channel creation
    may have occurred. Add a strict durable pre-effect marker before the first
    channel acquisition effect, or an equivalently safe kernel-owned marker;
    never infer this obligation only from an ephemeral runtime map or a caller
    boolean.
- Each identity is computed from immutable authenticated durable identities by
  kernel code. A caller cannot choose, omit, add, rename, or substitute a duty
  or identity.
- `begin_cleanup` must construct the complete authoritative ledger itself. If
  the compatibility command still accepts resource definitions, they are only
  an assertion and must equal the derived set exactly; missing, extra,
  duplicate, wrong-kind, and wrong-identity definitions fail typed without a
  write.
- Cleanup facts must contain exactly the derived duties. Parser/reopen and every
  reducer transition reject missing, extra, duplicate, wrong-identity, or
  impossible facts. No active cleanup record may be accepted with an incomplete
  ledger.
- Every unresolved `pending` or `failed` fact must have the exact current
  cleanup effect owner and fencing token. A `succeeded` fact may retain its
  authenticated historical proof and must not be re-executed. Historical
  takeover provenance alone never authenticates an unresolved fact.
- Cleanup takeover atomically changes the launch/effect owner and re-fences
  every unresolved duty to the new exact owner/fence, while preserving completed
  success facts. Any partial re-fence rolls back in memory and SQLite.
- Blocked and cleaned settlement accept exactly one result for every unresolved
  duty and no result for an already completed or unknown duty. Wrong identity,
  duplicate, missing, extra, stale-owner, and stale-fence outcomes fail closed.
- `settle_cleanup_cleaned` reaches `released`/owner `none` only when the fact set
  still equals the kernel-derived duty set and every duty is `succeeded`.
  Partial success remains owned and cannot release.
- Memory and SQLite behavior, parser strictness, HMAC/reopen behavior, CAS
  rollback, deterministic cloning/listing, and bounded record rules remain in
  parity.

### Mandatory test-first evidence

- Add the direct false-release regression: create a fully bound launch with a
  lease and channel/checkpoint obligation, attempt channel-only cleanup, and
  prove the kernel rejects it and preserves lease/backend ownership.
- Add table-driven missing, extra, duplicate, wrong-kind, wrong-identity,
  wrong-owner, stale-fence, and historical-owner unresolved-fact cases. Expected
  values must be hand-derived literals, not production helpers.
- Add partial then final settlement coverage proving no release until the exact
  complete derived ledger succeeds, and no repeat execution of prior successes.
- Add consecutive takeover coverage proving all and only unresolved duties are
  atomically re-fenced. Include an `o1/1` unresolved fact inside an `o2/2`
  record and prove parser/reopen refusal.
- Run every case in memory and SQLite where applicable, including close/reopen,
  HMAC/tamper, before/after-commit fault injection, and rollback inspection.
- For every new guard, capture genuine RED against pre-fix behavior, then GREEN.
  Any mutation used to prove the guard must be reverted and the same check must
  be GREEN before handoff.

## Packet R6.2 — closed secret-safe durable cleanup failures

### Required behavior

- Replace arbitrary durable cleanup failure text with a closed typed failure
  code. The closed set must distinguish at least channel detach, output
  checkpoint deletion, host reconciliation, host outcome unknown, isolation
  lease release, timeout/cancellation, and an unknown internal cleanup failure.
- Durable resource facts and cleanup blockers may contain only that code and a
  fixed Runner-owned safe message/template selected from the code. The parser
  validates the exact code-to-message mapping and exact keys; unknown codes,
  caller-supplied message variants, extra diagnostic fields, and raw nested
  errors are rejected.
- Provider/adapter `Error.message`, aggregate children, causes, stack text, and
  arbitrary thrown values are ephemeral only. They must never be copied into a
  host record, session record, output checkpoint, SQLite cell, serialized
  evidence, or other durable/model-visible data.
- Replace regex/message inspection used for control flow with typed codes.
  `host_outcome_unknown` must retain the prior `outcome_unknown` disposition;
  other cleanup failures remain typed blocked.
- Runtime-observable ephemeral diagnostics may retain raw detail only in
  bounded in-memory ownership and only if no existing durable/evidence path can
  serialize it. It is acceptable to discard raw detail.
- Existing cleanup retry, restart, no-double-clean, evidence, and recovery
  behavior must remain unchanged except for the new closed durable schema.

### Mandatory test-first evidence

- Inject unique credential, token, environment, argv, absolute-path, payload,
  aggregate-error, cause, and arbitrary-thrown-value sentinels into every
  cleanup resource family. Before repair, at least one direct sentinel case must
  demonstrate the current durable leak; after repair, none may occur.
- Inspect the in-memory serialized host/session/output records and every SQLite
  streaming table/cell after failure, close, and reopen. Assert that no sentinel,
  raw provider message, stack, cause, argv, environment value, payload, endpoint,
  or capability representation is present.
- Add strict parser/HMAC tests for unknown failure code, mismatched fixed
  message, legacy arbitrary failure text, extra diagnostic keys, and tampered
  durable rows. Unsupported unsafe active data must fail closed, not silently
  normalize.
- Mutation-prove at least the durable sanitizer/classifier boundary and the
  parser mapping guard; revert mutations and rerun the exact tests GREEN.

## Execution order and doctrine

1. PREPARE: inspect the two reproductions and current transition/parser/runtime
   data flow. Record a single root-cause hypothesis for R6.1 and R6.2.
2. Implement R6.1 as one coherent RED → GREEN packet. Run its exact failing
   tests first, then the affected store/runtime tests only.
3. Implement R6.2 as one coherent RED → GREEN packet. Run exact sentinel/parser
   tests first, then the affected store/runtime tests only.
4. Audit every line of this brief, automatically repair technically
   determinable failures, and rerun the exact failed checks before affected
   gates. Do not run the full suite after each edit.
5. Run one final adversarial self-audit, inspect the complete diff, prove every
   mutation reverted, and append evidence to `task-8.0b1-report.md`.
6. Commit coherent production/tests/report changes. Do not claim approval.

If this exceptional round cannot close both findings, stop with the exact
blocker. Do not silently begin a seventh repair round or weaken a control.

## Required final implementation evidence

- Exact R6.1 cleanup-matrix and takeover/reopen/fault tests: zero failures,
  skips, or cancellations.
- Exact R6.2 sentinel/classifier/parser/HMAC tests: zero failures, skips, or
  cancellations, plus a literal serialized-table scan showing zero sentinels.
- Full B1 focused tests:
  `staged-launch-kernel.test.ts`, `streaming-output-checkpoint.test.ts`,
  `streaming-output-v2.test.ts`, and
  `streaming-process-session-runtime.test.ts`.
- Task 8.0A tests:
  `streaming-session-store.test.ts`, `session-authority.test.ts`,
  `interactive-process-channel.test.ts`, and `execution-grants.test.ts`.
- Task 7 plus Task 3 spool compatibility tests:
  `process-backend-contract.test.ts`, `durable-process-store.test.ts`,
  `subprocess-runtime.test.ts`, `execution-isolation-provider.test.ts`,
  `tool-broker.test.ts`, and `bounded-output-spool.test.ts`.
- `npm run typecheck:runner-v2`; targeted ESLint for every changed source/test;
  `git diff --check c6a5c5be`.
- Static scope audit: no adapter, CLI/factory, child family, raw process/shell/
  environment seam, OS restriction, second database, or exact Node pin.
- Cleanup/residue audit: no new temp root, SQLite handle/file, spill, timer,
  listener, process, port, endpoint, container, or active test mutation.

## Independent exit gate

The controller must package `c6a5c5be..HEAD` and dispatch a fresh independent
scoped re-review. The reviewer must verdict both original findings, inspect the
fix diff for new Critical/Important breakage, and verify the report contains
covering RED/GREEN and mutation evidence. The controller then reruns the current
final gates above.

Only zero open Critical/Important findings plus current green controller
evidence may produce:

**PACKET 8.0B1 VERIFIED 100% COMPLETE — PACKET 8.0B2 MAY BEGIN**

Otherwise the only valid outcome is:

**PACKET 8.0B1 BLOCKED — GENUINE USER DECISION REQUIRED**
