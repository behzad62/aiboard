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
