# Task 6 Implementer Report — Portable Execution Grants and Isolation

Date: 2026-08-29

Base: `b997aade`
Scope: canonical Task 6 / P6.4d only. Task 7 process-family routing and the later filesystem-fence work were intentionally not started.

## Packet 1 — Runner-owned one-call execution grants

Implemented `execution-grants.ts` and connected `ToolBroker` / `ToolExecutionContext`.

- Grants are empty opaque frozen objects whose authority is held in Runner-only `WeakMap` state and branded with a module-private symbol. Model-authored objects and grants issued by another authority fail as `grant_forged`.
- Claims bind run, session, actor role/id, tool, call, permission profile, canonical workspace, exact canonical access roots/modes, external/destructive/network decisions, issue/expiry timestamps, random grant id, and nonce.
- Canonicalization rejects symlink roots and unapproved external roots, including missing leaves whose existing ancestor is resolved first.
- Consumption is one-call. Wrong run/call/actor/profile, expiry, explicit revoke, and restart (`revokeAll`) fail closed. `ToolBroker` issues only after policy/approval/ledger/budget checks and revokes an unconsumed grant on completion, cancellation, or timeout.
- No model-facing request schema accepts grant material.

TDD evidence:

1. Natural RED: focused grant test failed because `execution-grants.ts` did not exist.
2. GREEN: grant focused suite 3/3.
3. Natural RED: ToolBroker authorization test observed no `executionGrant` after authorization.
4. GREEN: affected broker suite 7/7.
5. Mutation RED: disabled selector one-grant-use tracking; the second acquire stopped rejecting. Mutation reverted; GREEN restored.

## Packet 2 — Semantic isolation provider selection

Implemented `execution-isolation-provider.ts`.

- Provider registrations and registries are Runner-created opaque authorities; stable provider id plus code/config digests form the implementation identity.
- Selection parses exact attestations and chooses by truthful semantic claims, not host OS. Guarded/Project require verified, unexpired, exact-grant write confinement with `write_confinement: enforced`.
- Unavailable, malformed, partial, expired, dishonest, wrong-identity, acquire-failing, and lease-mismatching providers fail typed before any fallback launch. There is no native-as-confined fallback.
- Full is the only ordinary unconfined path and returns the exact durable/user-visible disclosure `unconfined_explicit_full`.
- Leases must match provider, invocation, grant, exact access, and provider implementation identity. Release failures remain active as `revocation_failed`; restart recovery is provider-owned and blocker-visible.
- Disclosure explicitly says the enforcement is provider-specific and is not a universal security/container boundary.

TDD evidence:

1. Natural RED: provider tests failed because the module did not exist.
2. GREEN: provider focused suite 4/4.
3. Mutation RED: accepted a false `exactGrantWriteConfinement` claim; strict selection incorrectly succeeded. Mutation reverted; GREEN restored.

## Packet 3 — Explicit OCI reference provider

Implemented `oci-execution-isolation-provider.ts`.

- Requires an explicitly configured absolute Docker-compatible CLI and image. Production performs no PATH search, auto-install, pull, or silent substitute.
- Attestation canonicalizes and hashes the executable, rechecks its bytes before every CLI effect, verifies the active capability-contract identity when supplied, and resolves the configured image to an immutable `sha256` id.
- CLI invocations receive an empty environment, bounded output, a timeout, and exact argv arrays.
- Acquisition creates a unique stopped container and durable Runner-state lease with owned/provider/run/invocation/grant labels.
- Mounts are limited to the workspace and exact approved roots with exact RO/RW behavior. Nested workspace roots are represented by exact bind overlays. Filesystem roots, broad parents, symlink/path escapes, unsafe cwd, ungranted absolute arguments, commas/unrepresentable mounts, privileged mode, host PID, and Docker socket access are rejected.
- Network is `none` unless both the consumed grant and explicit provider policy allow it.
- Release validates durable ownership and every scope label before forced removal.
- Startup lists labelled owned containers, validates durable identity/scope, removes only verified owned containers, reports unknown/mismatched/failing entries as blockers, and clears a stale durable lease only after `inspect` confirms the container is absent.

TDD and prove-red evidence:

1. Natural RED: OCI test failed because the module did not exist.
2. First real-Docker RED: Docker rejected an invalid writable mount option emitted as `,rw`. Corrected to Docker's writable default; focused and real fixtures became GREEN.
3. Mutation RED: removed broad-parent rejection; hostile parent-mount test reported a missing expected rejection. Mutation reverted; GREEN restored.
4. Mutation RED: changed the network policy from grant AND provider-policy to OR; the exact argv assertion observed `bridge` instead of `none`. Mutation reverted; GREEN restored.
5. Self-audit natural RED: externally removed container left a durable lease (`cleaned: 0` instead of `1`). Recovery now performs a confirming inspect; focused GREEN proves state removal without issuing `rm`.

### Real Docker applicability

Host applicability was proven with the explicit installed executable `C:\Program Files\Docker\Docker\resources\bin\docker.exe`, daemon server 29.7.2, and the already-present `alpine:latest` image. No install, discovery in production, pull, or configuration mutation was attempted.

Real fixture passed all five attacks/cleanup checks:

- allowed workspace write succeeded;
- write through the external read-only mount failed;
- write through a workspace symlink targeting the external read-only root failed;
- network under `--network none` failed to create its success sentinel;
- exited and live containers (including a sleeping child) were removed.

Post-run listing for `ai-board.runner-v2.owned=true` was empty.

## Packet 4 — Configuration, capability contract, CLI and native factory

- `runner-capabilities.json` accepts an optional bounded exact-key `isolationProviders` array with id, `type: oci`, absolute CLI path, image, and explicit `allowNetwork`. Unknown, duplicate, relative, or privileged-shaped configuration is rejected. Old files with no field remain readable.
- Capability contracts optionally attest provider config digest and canonical executable path/digest. Historical contracts without the field remain readable but retain the existing no-active-recovery rule. Replacing executable bytes fails active capability validation.
- Capability projection adds Runner-owned `cliIdentity`; configuration JSON cannot author it.
- Native factory adds the owned `execution_isolation` construction stage, performs startup recovery before capability construction, and repeats recovery during cleanup. Any provider blocker stops initialization/cleanup visibly.
- CLI configuration integration accepts an explicit dummy OCI executable without executing/discovering Docker during config parsing/capability readiness.

TDD evidence:

1. Natural RED: configuration parser rejected the new optional field as unknown.
2. GREEN: configuration focused tests 2/2.
3. Natural RED: replacing configured executable bytes did not initially reject the active contract. Hash binding added; GREEN restored.
4. Natural affected RED: native-factory lifecycle tests reported four stage/historical-contract expectation failures. Expectations were updated for the new owned stage and optional backwards-readable field; 51/51 broad CLI/native tests GREEN.

## Requirement audit

- Opaque, non-forgeable, one-call, bound exact grants: implemented and adversarially tested.
- Completion/cancel/timeout/restart/mismatch/expiry revocation or fail-closed behavior: implemented and tested.
- Never accept model-authored grant material: enforced by private runtime authority and lack of schema surface.
- Semantic truthful selection; strict no native fallback: implemented and tested for unavailable/broken/partial/false/expired claims.
- Full-only bypass and exact disclosure: implemented and tested.
- Explicit optional OCI config and backwards readability: implemented and tested.
- Exact executable/image identity, mounts, labels, cwd/path safety, no privilege/host PID/socket/ambient credentials, double-opt-in network: implemented, statically audited, fake-CLI asserted, and real-Docker attacked.
- Startup owned-lease listing/validation/cleanup/blockers/grant revocation: provider state and native-factory recovery implemented and tested, including unknown, mismatch, cleanup, and confirmed-absent residue.
- Portable Windows/Linux/macOS semantics: no OS-selected product behavior was added; `process.platform` is used only for path case normalization and portable test discovery/symlink mechanics. Windows Job Objects remain optional and untouched.
- Maintained Node 22/24 policy: no Node version pin was introduced; `24.18.0` does not occur in Task 6 source.
- Task 7 routing/filesystem fence: explicitly excluded and unchanged.

## Validation evidence

Fresh final/affected results:

- Task 6 focused grants/provider/config/contract/broker after the recovery self-audit repair: 30/30 pass.
- OCI subset in that gate, including real Docker: 6/6 pass.
- `npm run typecheck:runner-v2`: exit 0.
- Targeted ESLint over every changed Task 6 source/test: exit 0.
- Inherited Task 1–5 execution-safety seam: 192 total, 191 pass, 0 fail, 1 expected POSIX-only skip on Windows.
- Broad affected CLI/native gates (`cli-capabilities-config`, `native-build-capabilities`, `native-build-initialization`): 51/51 pass.
- `git diff --check`: exit 0; only Git autocrlf notices.
- Static prohibited-pattern scan: no Node 24.18 pin, auto-install, privileged mode, host PID, Docker socket, or ambient credential forwarding construction.

## Cleanup, rollback, recovery, and residue

- OCI acquisition failure after create removes the container if durable-state persistence fails.
- Release and recovery remove only containers whose durable lease and exact labels agree; ambiguous entries remain typed blockers.
- Provider recovery revokes in-memory selector leases only after blocker-free provider cleanup.
- Native factory owns the selector recovery stage and retries it on construction cleanup.
- Rollback is the focused Task 6 commit; no schema/database migration, external install, image pull, or platform service change occurred.
- Final residue audit: zero labelled Runner V2 OCI containers; zero `runner-oci`, grant, or isolation fixture temp directories; zero surviving managed-process/portable-process fixture processes (the audit query matched only its own PowerShell command).

## Residual risk / next-phase boundary

Task 6 deliberately establishes authorization, selection, attestation, lease, configuration, and lifecycle seams. Task 7 must route each generated process family through these seams and persist per-invocation selection/disclosure evidence. Until Task 7, existing process launch families are unchanged; nothing in this task claims that all Runner subprocesses are already confined. This is the expected canonical phase boundary, not a Task 6 control weakening.

## Governed Fix Round 1/5 — review 1

Reviewed `task-6-review-1.md` under the receiving-review discipline. All nine findings reproduced against the canonical Task 6 contract; no finding required technical pushback.

### Repairs and exact RED → GREEN evidence

1. **Global grant lifecycle.** RED: consumed claims could be submitted to two fresh selectors, and `revoke()` returned ineffective after authority consumption. The authority now retains consumed lifecycle state globally, reserves isolation use atomically across every selector, and registers async lease revokers. `revoke`/`revokeAll` await active cleanup; failed cleanup remains blocked/visible. ToolBroker awaits revocation on completion, cancellation, timeout, and thrown execution. GREEN: two microtask-concurrent authority consumes have exactly one winner; another authority cannot consume the grant; two concurrent fresh selectors produce one acquire; consumed authority revoke produces one release and zero active leases; broker terminal-path tests leave zero active snapshots.
2. **Issue/restart race.** RED: an issue paused before commit survived `revokeAll("restart")`. An authority epoch plus abort-aware commit barrier now invalidates in-flight issue. GREEN: deterministic delayed issue rejects `grant_revoked` after restart; pre-aborted issue also rejects.
3. **Full Docker identity.** RED evidence: Docker `create` persisted a 64-character ID while recovery's default format returned a truncated ID. Recovery now requests `ps --no-trunc`; fake argv asserts it. GREEN: a newly instantiated real provider discovers the exact full ID, removes only the owned container, clears its lease, and leaves zero provider labels.
4. **OCI concurrency and immutable acquisition identity.** RED model: provider-wide mutable image state and unlocked read/modify/write could cross-bind a changed tag and lose one of two leases. Acquire now reattests the immutable image into a local value immediately before create. A portable atomic directory lock serializes every lease RMW across provider instances; atomic replace remains used. GREEN: two overlapping providers share one state directory, use distinct reattested image IDs, preserve both exact leases/labels, release both, and leave no orphan.
5. **Durable user-visible state.** RED: selection and enforcement existed only in memory. The selector now atomically persists a bounded redacted projection of Full/strict/active/revoked/blocked/cleaned outcomes, provider/implementation identity, OCI immutable image, exact access summary, grant/lease ids, and the explicit non-universal-boundary statement. It persists neither opaque objects nor nonces/secrets. Live and historical NativeBuildFactory observability expose it at `capabilities.executionEnforcement`. GREEN: a fresh selector reopens strict active→revoked→cleaned plus exact `unconfined_explicit_full`, including OCI image identity; two OS processes concurrently persist 40 outcomes without loss; forged/unknown durable fields fail closed; native observability focused test reads the projection surface.
6. **Bounded CLI timeout.** RED: timeout called kill and awaited `close` forever. The native CLI now settles at timeout plus bounded grace, removes listeners, destroys streams, and unreferences the child even if kill fails and close never comes. GREEN: injected never-close/kill-false child rejects typed within the wall-clock bound with no listeners/stream handles.
7. **Fixture cleanup.** RED risk: real assertion failure bypassed release. Every real acquired ID is now tracked immediately and force-removed in `finally`. GREEN: a deliberate forced error after starting a labelled sleeping child still removes the exact container; inspect returns absent.
8. **Conflicting modes.** RED: canonical aliases could emit the same destination as both read and write. Grant canonicalization now rejects a destination-mode conflict before issuance/OCI. GREEN covers `workspace` and `workspace/.`; no create occurs.
9. **Native-as-confined prove-red.** A distinct hostile provider attests `local-native-execution` as enforced/exact. Before the guard and under a deliberate temporary guard-removal mutation, exact test RED was `Missing expected rejection`. Mutation reverted. GREEN rejects with typed capability-unavailable and acquisition count zero.

### Adversarial audit

- Issue/consume/revoke transitions are synchronous at their authority boundary; duplicate concurrent reservation has one winner.
- Consumed grants remain restart-revocable; registration closes revoke-during-acquire by immediately releasing when authority is already terminal.
- Multiple authorities cannot redeem each other's opaque grant; consumed claims remain runtime-branded and WeakMap-bound.
- OCI acquisition cleans a created container if durable ownership persistence fails. Release/recovery validate durable identity and every exact label before removal; unknown and mismatched containers remain blockers and are never removed.
- OCI lease and enforcement projection writes use portable lock directories plus atomic file replacement. Crash-left locks fail typed rather than assuming ownership.
- No Task 7 process-family route was added and the durable projection explicitly avoids claiming that routing exists.

### Fix-round validation

- Final focused Task 6 gate: 39/39 pass, including both real-Docker fixtures, cross-process projection locking, and forged durable-state rejection.
- Affected CLI/native factory/capability gate: 51/51 pass.
- Inherited Task 1–5 seam: one unrelated bounded-spool identity-swap fault was flaky in the 192-test run (190 pass, 1 fail, 1 expected host skip); its exact failed check immediately reran GREEN 1/1. Task 6 does not touch that surface.
- Runner V2 typecheck and targeted ESLint: exit 0.
- Native-as-confined temporary mutation: RED, reverted, GREEN.
- Real Docker: outside write, symlink escalation, network denial, full-ID restart recovery, live-child cleanup, and forced-failure cleanup all GREEN.
- Final residue audit at the validation boundary: zero Runner-owned labelled containers, Task 6 temp directories, OCI/enforcement lock directories, or fixture processes.

Residual boundary remains Task 7 routing only. Task 6 now durably exposes enforcement outcomes but does not claim existing generated process families consume them.

## Governed Fix Round 2/5 — review 2

Reviewed `task-6-review-2.md` against canonical Task 6 before editing. All three residual findings and the evidence-gate finding were valid; no technical pushback was required.

### Repair 1 — exact issuing-authority ownership

- Every grant record now retains its private issuing-authority identity. Issue, consume, revoke, and revoke-all remain authority-local for the entire issued/consumed/revoked lifecycle; state no longer weakens ownership after consumption.
- A foreign authority concurrently attempting consume and revoke receives typed `grant_forged`; its restart revoke-all cannot release the issuer's live provider lease. The issuer still revokes the consumed authority exactly once and releases the active lease once. Global one-call reservation across selectors sharing that issuer remains intact.
- Listener authority is not exposed as a model or public grant field: a foreign authority holding only the opaque object cannot produce the runtime-branded consumed claims accepted by the internal listener registration seam. Failed foreign consume therefore cannot register a lease callback, and the issuer's existing callback remains the only live cleanup authority.
- Mutation RED: temporarily removed the authority identity comparison in `trustedRecord`; `npx tsx --test --test-name-pattern="one consumed grant is global" runner-v2/test/execution-isolation-provider.test.ts` failed 0/1 at the assertion that every foreign attempt was rejected. Mutation reverted. Exact GREEN: 1/1 pass.

### Repair 2 — exact acquisition image identity

- OCI's image ID resolved immediately before `create` is now embedded in the durable lease, an exact owned-container image label, returned lease/selection claim, and enforcement projection.
- Release and recovery compare durable image identity, exact label identity, and Docker inspect's actual `.Image` identity before removal. Missing legacy image identity and any mismatch remain typed blockers; unknown or mismatched containers are never removed.
- Deterministic overlapping providers use different attest-time and acquire-time identities. Both acquire-time IDs survive shared-state interleaving, exact create argv/labels, durable lease state, actual-image inspection, and user-visible projection without cross-binding or orphaning.
- Mutation RED: temporarily projected the earlier attestation image instead of the acquired lease image; `npx tsx --test --test-name-pattern="overlapping OCI provider instances" runner-v2/test/oci-execution-isolation-provider.test.ts` failed 0/1, observing IDs `111...`/`222...` instead of acquired `333...`/`444...`. Mutation reverted. Exact GREEN: 1/1 pass.
- Real Docker mismatch fixture tampers the durable exact image, reopens recovery, observes one typed blocker and zero cleanup, confirms the exact container still exists, then force-removes it in `finally`.

### Repair 3 — exact bounded cleanup projection and ingestion

- Provider recovery now returns redacted exact cleaned/blocked transition descriptors carrying the real run, invocation, grant, lease, provider, implementation, acquired image, access, status, and blocker identity. OCI emits a transition for every durable lease outcome; it never fabricates identities for an unknown labelled container.
- Selector recovery appends each exact transition and a separate bounded provider summary. Reopening state correlates multiple prior active lease IDs to one cleaned and one blocked terminal record, including the exact acquired image and access identity.
- Projection ingestion is capped before full parse at 1 MiB, probes through the cap to close stat/read growth races, and validates at most 1,000 records, 256 access entries per record, 256 summaries, 64 blockers, exact enums/keys/digests/images, 512-character ordinary fields, and 4,096-character canonical paths. Over-bound or forged state fails closed as `isolation_recovery_blocked`, is preserved byte-for-byte, and causes no provider side effect. Valid Task 6 state without recovery summaries remains readable.
- Mutation RED: temporarily accepted `MAX_ENFORCEMENT_RECORDS + 1`; `npx tsx --test --test-name-pattern="enforces exact byte" runner-v2/test/execution-isolation-provider.test.ts` failed 0/1 with a missing expected rejection. Mutation reverted. Exact GREEN: 1/1 pass. Boundary cases at 1,000 records, 256 access entries, and 512-character fields pass; each next value and a 1 MiB + 1 file reject.

### Round 2 validation evidence

Literal final focused command required by review:

`npx tsx --test --test-reporter=dot runner-v2/test/execution-grants.test.ts runner-v2/test/execution-isolation-provider.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/tool-broker.test.ts runner-v2/test/runner-capabilities-config.test.ts runner-v2/test/runner-capability-contract.test.ts runner-v2/test/native-build-capabilities.test.ts`

Result: exit 0, 79/79 dots passed, zero failures/skips.

- Exact OCI/real-Docker command: `npx tsx --test runner-v2/test/oci-execution-isolation-provider.test.ts` — 10/10 pass, 0 fail, 0 skip. This includes outside-write denial, symlink escalation denial, network denial, live-child cleanup, forced-error cleanup, exact acquired-image concurrency, full-ID restart recovery, and exact image-mismatch non-removal.
- Broad affected CLI/native command: `npx tsx --test --test-reporter=dot runner-v2/test/cli-capabilities-config.test.ts runner-v2/test/native-build-capabilities.test.ts runner-v2/test/native-build-initialization.test.ts` — exit 0, 51/51 pass.
- Inherited Task 1–5 command: `npx tsx --test --test-reporter=dot runner-v2/test/execution-safety-contracts.test.ts runner-v2/test/child-environment.test.ts runner-v2/test/bounded-output-spool.test.ts runner-v2/test/process-backend-contract.test.ts runner-v2/test/durable-process-store.test.ts runner-v2/test/subprocess-runtime.test.ts runner-v2/test/posix-process-backend.test.ts runner-v2/test/windows-process-backend.test.ts runner-v2/test/managed-process.test.ts` — exit 0, 192/192 dots passed.
- `npm run typecheck:runner-v2` — exit 0.
- `npx eslint runner-v2/src/execution-grants.ts runner-v2/src/execution-isolation-provider.ts runner-v2/src/oci-execution-isolation-provider.ts runner-v2/test/execution-isolation-provider.test.ts runner-v2/test/oci-execution-isolation-provider.test.ts runner-v2/test/native-build-capabilities.test.ts` — exit 0, no findings.
- `npx eslint runner-v2/test/execution-grants.test.ts` — exit 0 after adding the explicit pre-consumption foreign-revoke assertion; its exact test file is 4/4 GREEN.
- `git diff --check` — exit 0; only Git autocrlf notices.
- Static scope/prohibition scan over the three changed source modules found no Node `24.18.0` pin, install command, ambient environment forwarding, Task 7 route, or filesystem fence. The only privileged/host-PID/socket strings are the explicit rejection deny-list.
- Final Docker residue query `docker ps -a --filter "label=ai-board.runner-v2.owned=true" --format "{{.ID}} {{.Labels}}"` returned empty. TEMP queries for `runner-oci-*` and `runner-enforcement-*` returned empty; all focused processes exited and no lease/projection lock directory remains.

### Self-audit, cleanup, rollback, and residual boundary

- Cross-authority races, exactly-once selector reservation, restart issuance barriers, revocation cleanup, cross-process projection locking, overlapping OCI state writers, acquisition failure cleanup, actual image mismatch, partial recovery, confirmed absence, and unknown/mismatched container safety are covered and green.
- Durable enforcement remains redacted and explicitly says `provider_specific_not_universal_security_boundary`; opaque grant objects, nonces, secrets, and ambient credentials are never persisted.
- Rollback is this focused Fix Round 2 commit. No database migration, image pull, executable install, external configuration mutation, or Windows-only primitive was introduced.
- The only residual boundary is canonical Task 7: generated process families are not yet routed through Task 6 selection and no current projection claims otherwise.
