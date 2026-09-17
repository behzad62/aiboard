# Task 8.0B1 repair round 7 — active-schema boundary and unforgeable errors

## Authority and entry

- Entry HEAD is `2643cf75`.
- Read this brief first, then
  `task-8.0b1-exceptional-round-6-review.md`, the exceptional round-6 section
  of `task-8.0b1-report.md`, and `task-8.0b1-brief.md`.
- The owner explicitly authorized fixing the two independently reproduced
  residuals and continuing. This packet owns only those two residual paths.
- B1 remains unapproved and B2 remains locked until a fresh independent scoped
  re-review plus current controller verification are green.
- Preserve every earlier B1, 8.0A, Task 7, and Task 3 behavior. Node policy is
  maintained Node 22 or 24; never add an exact patch pin.

## Exact exclusions

- Do not implement B2 adapters, native/POSIX/Windows/Job/OCI behavior,
  CLI/control-server/factory/family routing, another database, raw spawn/kill/
  shell/environment access, OS-name product branching, or unrelated refactors.
- Do not weaken cleanup membership, fencing, HMAC, parser, recovery, secret,
  caller/model-visible error, or active-schema refusal controls.
- Do not preserve liveness by guessing that an ambiguous legacy channel is
  absent. Ambiguous active ownership fails closed.

## Verified root causes

1. Round 6 added optional channel/checkpoint markers without changing the
   active host schema version. A version-1 `bound` row with a lease/backend but
   no markers is therefore indistinguishable from a pre-fix crash after channel
   acquisition. The new derivation treats it as pre-channel and can release it
   with only `host` and `isolation_lease` succeeded.
2. Provider errors are sanitized only when they are not instances of the
   exported `StreamingProcessSessionError`. A provider can call that public
   constructor with arbitrary message/cause data; normal and cancellation catch
   paths trust and rethrow it unchanged.

## R7.1 — explicit marker-aware active-schema boundary

### Required behavior

- Introduce an explicit new host-launch active schema generation for records
  whose channel/checkpoint marker semantics are authoritative. Use the existing
  versioned parser/store contract; do not infer generation from optional fields.
- Every new prepared host record uses the new generation. Update constructors,
  in-memory and SQLite persistence, adoption/recovery paths, cloning/HMAC, and
  fixtures consistently.
- Active older-generation host rows are never silently upgraded from their own
  untrusted contents. In particular, an old `bound`/lease/backend row without
  markers must fail typed as unsupported/quarantined before cleanup can begin or
  release. A valid HMAC does not make its channel history knowable.
- B1 has no activated production adapter/family path, so there is no legitimate
  installed live older-generation B1 session that requires an unsafe inferred
  migration. Prefer explicit active-version refusal over heuristic laundering.
- Preserve closed terminal history only if the existing host-store policy
  already supports it safely; do not broaden terminal compatibility for this
  packet.
- In the new generation, `bound` without a channel marker is a valid exact
  pre-channel crash point. `begin_channel` then writes the one-time marker
  before the external acquisition effect. States/transitions that prove later
  progress must require the appropriate channel/checkpoint markers.
- Cleanup derivation remains exact: new-generation pre-channel `bound` owns no
  channel duty; once the marker exists, `channel` is mandatory; checkpoint
  membership remains atomically linked. No state may remove or backdate a
  marker.
- Unsupported active older rows must remain byte-preserved and unmodified in
  SQLite on read, list, transition, recovery, and reopen refusal. Memory and
  SQLite behavior must match.

### Mandatory tests and RED/GREEN evidence

- Convert the reviewer’s exact legacy `bound` reproduction into a real
  regression test. Before production changes it must reach
  `released`/owner `none`; after the repair the old active record must fail
  typed before cleanup and retain its backend-owned bytes/state.
- Cover old active rows at every marker-relevant boundary: `bound` without
  markers, `bound` with channel marker, checkpoint-linked, handshake-verified,
  cleanup-pending, and cleanup-blocked. No active old generation may be
  laundered into the new generation.
- Cover new-generation pre-channel `bound`, post-`begin_channel`, checkpoint
  link, cleanup duty derivation, crash/reopen, and adoption. Prove the new
  generation does not conservatively invent a channel before the pre-effect
  marker and cannot omit it afterward.
- Add valid-HMAC SQLite reopen/list/transition cases and before/after write fault
  checks proving refusal leaves bytes, revision, HMAC, and ownership unchanged.
- Mutation-prove the active-version gate and at least one later-state marker
  invariant; revert each mutation and rerun the same checks green.

## R7.2 — unforgeable Runner error provenance

### Required behavior

- `instanceof StreamingProcessSessionError` is not proof that an error was
  created by trusted Runner control flow. Replace that trust decision with
  unforgeable module-private provenance, such as a private `WeakSet` populated
  only by a non-exported Runner error factory.
- Keep the exported error class/API compatible if current callers require it,
  but calling its public constructor must not grant trusted provenance. A
  provider-created instance is foreign input.
- Audit every internal creation site. Only a fixed Runner-owned code/message
  created by the private factory may cross the public runtime boundary without
  remapping. Do not preserve a provider cause, stack, AggregateError children,
  message, name spoof, or arbitrary fields.
- At every injected isolation, host, channel, handshake, output, cleanup, and
  cancellation boundary, foreign failures—including exported Runner-error
  instances, subclasses, lookalikes, cross-realm objects, and aggregates—must
  map to a newly constructed fixed Runner-owned error appropriate to the phase.
- Preserve exact internal cancellation/timeout/handshake/cleanup codes only
  when their provenance is private and current. Do not make all errors generic
  if a safe typed distinction already exists.
- Durable failure classification remains the closed code/message mapping from
  round 6. Neither durable records nor caller/model-visible error graphs may
  contain provider-controlled text or causes.

### Mandatory tests and RED/GREEN evidence

- Convert the reviewer’s exact provider-created exported-error reproduction
  into a real test. Before repair it must expose the credential/payload
  sentinels; after repair the caller receives only the exact fixed Runner-owned
  code/message and no cause.
- Repeat the foreign exported-error, subclass/lookalike, AggregateError, and
  arbitrary thrown-value sentinels at isolation, host launch, channel acquire,
  handshake, output-start/delivery where applicable, cleanup, and cancellation
  boundaries. Assert recursively that caller-visible and serialized durable
  graphs contain no credential/token/env/argv/path/payload/cause sentinel.
- Prove genuine internally minted cancellation, timeout, handshake refusal,
  cleanup blocked, and lossless-output errors retain their intended safe codes
  and fixed messages.
- Mutation-prove that restoring the `instanceof` trust bypass makes the exact
  provider-created test red, then revert and rerun green. Mutation-prove at
  least one private-brand creation/validation guard the same way.

## Execution doctrine

1. PREPARE: retain the two exact reviewer reproductions as the initial root-
   cause evidence. Inspect current schema/version and error creation/catch data
   flow before editing production.
2. Implement R7.1 as one strict RED → GREEN packet. Run the exact regression
   first, then affected store/kernel tests.
3. Implement R7.2 as one strict RED → GREEN packet. Run the exact sentinel
   regression first, then affected runtime tests.
4. Automatically repair technically determinable failures with exact failed
   checks first, then affected modules/contracts. Do not repeatedly run broad
   suites.
5. Perform a final adversarial self-audit, prove mutations reverted, append
   exact evidence to `task-8.0b1-report.md`, and commit coherent changes.
6. Do not claim approval. The controller owns independent review and final
   verification.

## Required implementation gates

- Exact R7.1 active-version/migration/reopen/fault tests: zero failures, skips,
  or cancellations.
- Exact R7.2 provider-forgery/internal-provenance/sentinel tests: zero failures,
  skips, or cancellations.
- Full B1 focused tests: `staged-launch-kernel.test.ts`,
  `streaming-output-checkpoint.test.ts`, `streaming-output-v2.test.ts`, and
  `streaming-process-session-runtime.test.ts`.
- Task 8.0A tests: `streaming-session-store.test.ts`,
  `session-authority.test.ts`, `interactive-process-channel.test.ts`, and
  `execution-grants.test.ts`.
- Task 7 plus Task 3 spool compatibility tests:
  `process-backend-contract.test.ts`, `durable-process-store.test.ts`,
  `subprocess-runtime.test.ts`, `execution-isolation-provider.test.ts`,
  `tool-broker.test.ts`, and `bounded-output-spool.test.ts`.
- `npm run typecheck:runner-v2`; targeted ESLint for every changed source/test;
  `git diff --check 2643cf75`.
- Static scope audit proves no B2/adapter/factory/family/process/shell/env/OS/
  second-database/exact-Node-pin change.
- Residue audit proves no new temp root, SQLite handle/file, spill, timer,
  listener, process, port, endpoint, container, or active mutation.

## Exit gate

The controller must package `2643cf75..HEAD` and dispatch a fresh independent
scoped re-review against both residuals. The reviewer must report both
ADDRESSED and no new Critical/Important breakage. The controller then reruns
the two exact original reproductions, all three affected test slices,
typecheck, targeted lint, diff/scope, and residue checks.

Only current green evidence may produce:

**PACKET 8.0B1 VERIFIED 100% COMPLETE — PACKET 8.0B2 MAY BEGIN**

Otherwise B1 remains blocked and B2 remains locked.
