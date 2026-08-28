# DeepSeek Harness capability audit for Runner V2

**Audit date:** 2026-08-28

## Reproducible source snapshots

- **DeepSeek Harness:** `D:/repos/deepseek-harness` at
  `cd5ef8148158c3a752a658978873241fdf8e2bbc`. Its only local state was the
  pre-existing untracked `.vs/` directory. The audit did not modify it.
- **Runner V2 product baseline:** `ec1ec8a1` (the verified P5 exit). The audit
  began on branch head `4e06a2222d696e779764c581f859b95852f7eb2b`, whose only
  post-P5 executable additions were the now-cancelled benchmark parity files.
  Removing those files leaves the executable product surfaces byte-identical to
  `ec1ec8a1`; the remaining amendment is this report and the canonical plan.
- **Cleanup diff:** remove
  `lib/benchmark/robust-build/types.ts`,
  `lib/benchmark/robust-build/parity.ts`, and
  `scripts/test-robust-build-parity.mts`. Four unfinished, untracked drafts were
  also discarded before publication:
  `lib/benchmark/robust-build/adapter-support.ts`,
  `lib/benchmark/robust-build/deepseek-harness-adapter.ts`,
  `lib/benchmark/robust-build/runner-v2-adapter.ts`, and
  `scripts/test-robust-build-adapters.mts`.

The original publication force-tracked this ignored-by-default report in the
same clean commit as the plan amendment and benchmark cleanup after repeating
the P5 product-surface comparison. This later portability amendment changes only
the approved P6.4 design and does not substitute prose for executable evidence.

## Decision, method, and maturity rule

This audit replaces the planned head-to-head benchmark. The owner explicitly
does not want parity scoring; the objective is to inspect the local DeepSeek
Harness implementation and make sure Runner V2 does not omit a feature that
materially improves robust application building.

The audit inspected implementation, tests, default bundle composition, package
documentation, and stated limitations. It did not run DeepSeek, execute a
comparator workload, or infer test success from test-file presence.

DeepSeek labels the entire repository **developer preview**, warns that breaking
changes are expected, and says it is experimental, security-unaudited, and not
production-ready (`README.md:11-15`, `SAFETY.md:5-15`). Every `default`,
`optional`, or `experimental` state below inherits that repository-wide
maturity warning. Here, `default` means loaded by the shipped base composition,
not production-certified.

## Capability disposition

| Capability | DeepSeek shipped state and evidence | Runner V2 assessment and disposition |
|---|---|---|
| Build planning, task authority, integration, verification, and handoff | **Default core plus experimental Team.** The base loads the core agent loop (`packages/bundle/base/cordis.patch.yml:485-489`; implementation: `packages/core/agent-loop/src/agent.ts:262-326`; tests: `packages/core/agent-loop/tests/agent.spec.ts`, `tool-order.spec.ts`, and `cancel.spec.ts`). Team is explicitly opt-in and experimental. It has durable mailbox/task records but process-local activation ownership and advisory write scopes (`packages/experimental/agent-team/README.md:10-32,128-144,198-200`; tests: `packages/experimental/agent-team/tests/team.spec.ts`, `persistence.spec.ts`, and `invariant.spec.ts`). | **Runner stronger.** Immutable criteria, durable scheduling, isolated task worktrees, task commits, canonical integration, revision-bound final verification, independent high-risk review, and explicit handoff form a build kernel DeepSeek does not ship. Retain Runner authority; do not replace it with sessions, Team, or workflows. |
| Durable history, recovery, fork, and model-visible facts | **Default.** JSONL persistence is loaded in the base bundle (`packages/bundle/base/cordis.patch.yml:110-113`). The append-only session log is the model-context source and supports validated repair/fork (`docs/architecture.md:103-113`; `packages/core/session/src/index.ts:485-644,1008-1132`; `packages/session/session-persistence/README.md:46-54,136`; tests: `packages/core/session/tests/repair.spec.ts`, `fork.spec.ts`, `properties.spec.ts`, `packages/core/agent-loop/tests/request-reconstruction.spec.ts`, and `packages/session/session-persistence/tests/write-behind.spec.ts`). Interrupted turns are durably closed, not resumed. | **Different and sufficient for builds.** Runner persists scheduler, evidence, tool, budget, session, integration, guidance, verification, and handoff facts. Agent checkpoints plus immutable capability contracts reconstruct the model-visible build context (`runner-v2/src/agent-loop.ts:258-285`; `runner-v2/src/sqlite-agent-session-store.ts:145-179`; `runner-v2/src/runner-capability-contract.ts:144-231`); the exact provider transport envelope is not redundantly stored. Preserve DeepSeek's “model-visible means reconstructable” rule as an audit invariant, without replacing Runner's build stores. |
| Context compaction and project memory | **Default compaction.** Base loads `compaction-basic` (`packages/bundle/base/cordis.patch.yml:326-332`); it summarizes under pressure and retries confirmed overflow but cannot shrink system/tool overhead or one indivisible oversized call (`packages/compaction/compaction-basic/README.md:10,110-123`; tests: `packages/compaction/compaction-basic/tests/compaction-basic.spec.ts` and `compaction-loop-repro.spec.ts`). | **No gap.** Runner already compacts bounded working context without deleting durable raw history and adds provenance-bound project memory plus protected required sections (`runner-v2/src/context-assembler.ts:49-75,114`; `runner-v2/src/project-memory.ts:88-135`). |
| Subagents and parallel coordination | **Default subagents; experimental Team.** Spawn/fork and continuation tools are in the base bundle (`cordis.patch.yml:334-377`); continuable activation is process-local and accepted-but-unlogged prompts can be lost (`packages/subagent/subagent/README.md:47,89-100,164`; tests under `packages/subagent/*/tests`). Team's stronger mailbox is still single-process/experimental. | **Runner stronger for application delivery.** Helpers have bounded authority while durable parallel tasks receive leases and isolated worktrees. External-product delegation is breadth, not a release prerequisite. |
| Tool pipeline and user approval | **Default.** The base composes sandbox policy, approval, and presets (`packages/bundle/base/cordis.patch.yml:208-247`). Tool execution has ordered pre/execute/post stages and fail-closed approval, with cooperative same-process cancellation limits (`packages/core/tools/src/index.ts:145,228-255,705-709,1692-1724`; `packages/interaction/user-approval/src/index.ts:210-239`; tests: `packages/core/tools/tests/tools.spec.ts`, `packages/core/tools/tests/properties.spec.ts`, and `packages/interaction/user-approval/tests/approval.spec.ts`). | **No authority gap.** Runner's broker already owns approval, budget reservation, idempotency, an invocation ledger, in-doubt reconciliation, and audit (`runner-v2/src/tool-broker.ts:203-399`). The missing protection is below the broker, at process and filesystem execution boundaries. |
| Subprocess lifecycle, child environment, and output | **Default.** The base mounts the local subprocess service (`packages/bundle/base/cordis.patch.yml:205-206`). It scrubs credential-shaped/`DSH_*` environment names, keeps a bounded tail with private spill recovery, terminates process trees, and awaits disposal (`packages/subprocess/subprocess/README.md:12,55-77,103-107`; `packages/subprocess/subprocess-local/README.md:43-53,69-90`; tests: `packages/subprocess/subprocess-local/tests/spawn.spec.ts`, `process-exit.spec.ts`, and `local.spec.ts`). Default shell consumers use 64 KB (64,000-byte) tails and up to 64 MiB (67,108,864 bytes) of spill (`packages/shell/bash-local/README.md:42-55`; `packages/shell/pwsh-local/README.md:46-53`). Limits include best-effort Windows tree observation, escapable daemons, heuristic secret names, and spill accumulation (`packages/subprocess/subprocess-local/README.md:123-130`). | **Material gap.** Runner's one-shot and evidence commands inherit ambient environment, kill only the direct child, and terminate merely for exceeding the in-memory output limit (`runner-v2/src/process-tools.ts:131-171`; `runner-v2/src/evidence-tools.ts:231-268`). Final verification attempts tree termination but inherits ambient environment, kills on output overflow, and does not prove POSIX group quiescence (`runner-v2/src/final-verification-runtime.ts:653-654,1461-1494,1542-1565`). Managed processes own Windows trees but inherit ambient environment (`runner-v2/src/managed-process.ts:196-270,589-608`). MCP also inherits ambient environment, uses a shell, and stops only the direct child (`runner-v2/src/mcp-tools.ts:59-69,129-143`). Close with shared protected ownership primitives for every local child process, not family-specific partial fixes. |
| Operating-system process file-effect confinement | **Default.** Shell calls use fail-closed Linux bwrap/Landlock, macOS Seatbelt, or Windows restricted-token/ACL backends and report `full` versus `partial` enforcement (`packages/bundle/base/cordis.patch.yml:208-228`; `packages/sandbox/sandbox-local/README.md:10-12,51-85`; tests: `packages/sandbox/sandbox-local/tests/local.spec.ts`, `acl-grants.spec.ts`, and `packed-workspace-closure.spec.ts`). Windows and older Landlock are partial; Seatbelt depends on deprecated `sandbox-exec`; the whole project remains unaudited (`packages/sandbox/sandbox-local/README.md:121-132`). | **Material gap, with a portability constraint.** Approved Runner commands otherwise have the host user's filesystem authority, but copying three operating-system sandbox families would make the critical path expensive and platform-bound. Add one kernel-owned, capability-selected execution boundary. Strict write confinement comes from an attested isolated executor or an optional native adapter; a mode that requires it fails with a typed unavailable result when no qualifying backend exists. Native local execution remains portable and is never mislabeled as sandboxed. Explicit Full access is the only ordinary unconfined bypass. |
| Trusted filesystem fence and path freshness | **Default.** `fs-sandbox` and read-before-edit policy are loaded (`packages/bundle/base/cordis.patch.yml:263-264,491-494`). The filesystem seam re-canonicalizes the actual mutation target immediately before use and shares process workspace policy; observation versions reject stale cooperating writes (`packages/fs/fs-sandbox/README.md:12,28,44-50,64-79`; `packages/fs/fs-observation-policy/README.md:12-46,63-82`; tests: `packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts`, `packages/fs/fs-sandbox/tests/containment.spec.ts`, and `packages/fs/fs-observation-policy/tests/policy.spec.ts`). Its version check plus later rename is **not** an atomic compare-and-swap against an external writer. It accepts a residual resolve-to-syscall race. | **Two bounded gaps.** Runner authorizes a canonical path in the broker but later resolves the original lexical path at the filesystem tool, so a changed symlink ancestor can redirect the mutation (`runner-v2/src/tool-broker.ts:430-444`; `runner-v2/src/filesystem-tools.ts:739-742`). `fs.patch` requires a hash, while `fs.write` may replace an existing file without one (`runner-v2/src/filesystem-tools.ts:332-403,499-530`). Add a trusted last-mile fence for every filesystem mutation and an **optimistic freshness guard** for text replacement/create. Do not claim external atomic CAS. Move/delete freshness is explicitly outside this packet; their path containment is not. |
| Plugins, profiles, presets, and live reload | **Default plugin architecture; profile-dependent reload.** Cordis makes services replaceable (`docs/architecture.md:9-29`). Base HMR is disabled (`cordis.patch.yml:19-24`); shipped Web/custom profiles can reload patches, while headless/SDK/ACP apply once. Dynamic self-modification packages are shipped but process-memory-only and equivalent in trust to model code (`packages/extensions/README.md:10-13`; tests under `packages/extensions/*/tests`). | **Broader, not better for durable builds.** Runner deliberately uses static, allowlisted, content-addressed capability snapshots, brokered tools, bounded context, reverse-order disposal, skills, and generic LSP. Do not add active-build hot reload, marketplace loading, or self-modification; they weaken reproducibility and kernel authority. |
| Skills | **Default.** Filesystem skills are watched and re-read live (`packages/bundle/base/cordis.patch.yml:279-290`; `packages/skill/skill-filesystem/README.md:12,28-40,65-73`; tests: `packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` and `packages/skill/skill-filesystem/tests/skill-filesystem-watcher.spec.ts`). | **No gap.** Runner discovers skills on demand, hashes content, and fails closed if a skill changes between discovery and read. Live mutation during a durable build is intentionally rejected. |
| Language-server intelligence | **Optional configuration.** Packages and tests ship, but deployments must configure commands/mappings and no language server is bundled (`packages/lsp/README.md:10-31`; tests: `packages/lsp/lsp-stdio/tests/lifecycle.spec.ts`, `framing.spec.ts`, `host.spec.ts`, and `packages/lsp/tool-lsp/tests/integration.spec.ts`). | **Runner stronger at language behavior, but process ownership must be unified.** Runner ships a built-in TypeScript provider plus generic configured LSP with executable attestation, workspace/result containment, document versions, and bounded restart/results. Retain protocol behavior and attestation, but make every local server consume the shared portable process owner. POSIX process groups, optional Windows Job Objects, and isolated executors are backend capabilities behind the same contract rather than separate LSP implementations. |
| Workflows, background jobs, goals, and schedules | **Mixed default/optional.** Workflow and process-local jobs are in the base (`packages/bundle/base/cordis.patch.yml:81-82,379-385`); schedules are opt-in Web. Workflow writes a durable parent-session run/member audit prefix, including interrupted tails, but does not resume execution after host loss (`docs/subsystems/workflow.md:118-128`; tests: `packages/workflow/workflow-worker-thread/tests/session.spec.ts` and `packages/workflow/workflow-worker-thread/tests/integration.spec.ts`). Jobs die with the process (`packages/jobs/jobs-local/README.md:12,28-32,126-132`; tests: `packages/jobs/jobs-local/tests/jobs.spec.ts`). Schedules persist reminders but deliver cold-session work only after resume (`packages/schedule/schedule/README.md:10-12,199-204`; tests: `packages/schedule/schedule/tests/jsonl-restart.spec.ts`). Workflow model code is not a security boundary (`packages/workflow/workflow-worker-thread/README.md:160-170`). | **No robust-build gap.** Runner's durable scheduler, goals, leases, worktrees, recovery, and criterion gates already cover the application-building need with stronger authority. Do not add a model-written workflow VM or process-local job registry to the critical path. |
| ACP, SDK, webhooks, external subagent adapters, and UI breadth | **Shipped optional profiles/packages.** Web/headless/SDK/ACP profiles are documented at `docs/architecture.md:19-29,43`; tests exist under `packages/acp/acp/tests`, `packages/sdk/*/tests`, and `packages/webhook/*/tests`. These add interoperability, not build-state authority. | **Broader general-agent product surface, not a P7 prerequisite.** Runner already has an authenticated localhost product control plane. Add one external protocol only when a real consumer requires it; multiple overlapping control planes increase recovery and authorization surface. |
| Telemetry and forensic export | **Default, feedback-gated and best-effort.** Base configuration can export raw captured session records because no redaction rule ships in that path (`packages/bundle/base/cordis.patch.yml:168-203`); telemetry has containment/redaction extension points but is not a durable outbox (`packages/session/session-telemetry/README.md:115`; tests: `packages/session/session-telemetry/tests/telemetry.spec.ts` and `packages/session/session-telemetry/tests/redact.spec.ts`). | **No current gap.** Runner's durable local audit/observability projection is the release need. If remote compliance export is later required, implement a durable redacted outbox rather than copying DeepSeek's best-effort transport. |

## Result: one cohesive high-value hardening phase

Runner V2 is stronger overall for robust application delivery. DeepSeek does
not reveal a missing scheduler, planner, verifier, recovery model, plugin
system, skill system, LSP layer, workflow engine, SDK, or UI feature that should
displace Runner's kernel before P7.

DeepSeek is stronger in one cohesive execution-safety area with four facets:

1. consistent child-process environment, output, tree, cancellation, and
   disposal ownership;
2. fail-closed operating-system file-write confinement for generated commands;
3. containment of repository-controlled programs reached indirectly through
   Git hooks, filters, helpers, or configuration; and
4. a trusted last-mile filesystem fence plus stale-model-knowledge guards.

These facets must be designed and implemented together. Sandboxing only
`process.run` would leave evidence/final-verification processes, internal Git,
and direct filesystem mutations as bypasses.

## Approved P6.4 portable execution-safety design

The owner approved this replacement for the earlier Windows-first proposal on
2026-08-28. Portability here means stable tools, state, policy, and recovery
semantics on every supported platform. Small deterministic adapters may use
operating-system primitives internally, but no Windows-only primitive is a
Runner product requirement and model-generated shell commands are never the
routine lifecycle controller.

### Security, portability, and support decisions

1. Add kernel-owned `SubprocessRuntime`, `ProcessBackend`,
   `ExecutionIsolationProvider`, and `FilesystemMutationFence` contracts. They
   are not extension capabilities and cannot be replaced by model-loaded code.
   The model-facing process tools and durable result shapes remain identical on
   every platform.
2. Detect and attest execution capabilities at Runner startup. The portable
   contract records semantic capabilities such as `treeTermination`,
   `crashCleanup`, `verifyEmpty`, `writeConfinement`, and enforcement level; it
   never treats an operating-system name as proof of a capability.
3. Ship one POSIX process-group/session adapter for Linux and macOS and one
   Windows process adapter. Windows Job Objects may remain as an optional
   enhancement behind the Windows adapter, but managed-process and LSP
   availability must not be keyed to an operating-system name or Job presence.
   A call may pause only because a requested semantic capability is unavailable.
   No platform-specific model tool or workflow is introduced.
4. Strict generated-process write confinement is supplied through the common
   `ExecutionIsolationProvider`: an attested OCI/remote isolated executor is the
   portable reference backend, and native operating-system adapters are optional
   enhancements. Guarded/Project execution that requires confinement selects a
   qualifying backend or returns a typed unavailable pause; it never silently
   launches with ambient host authority. Explicit Full access is the only
   ordinary unconfined bypass, and it never bypasses environment scrubbing,
   output bounds, deterministic ownership, or cleanup accounting.
5. The default writable set for a confined invocation is its exact
   task/integration/verification workspace plus Runner-owned private temp/cache.
   An approved outside path creates an opaque, call-bound grant for the exact
   canonical path and requested access, then revokes it. A generic approval does
   not grant the whole host.
6. Capability and enforcement reporting is honest. Process ownership is not
   described as a file sandbox; file-write confinement is not described as read
   confidentiality or network isolation; `partial`, `unverified`, and
   `unavailable` are durable states rather than prose warnings. Network and
   external-system effects retain the existing permission checks.

### Portable process state and deterministic control

7. Persist a platform-neutral process record containing a logical process ID,
   owning run/task/invocation, root PID, process-birth fingerprint, backend and
   opaque backend identity, attested capabilities, lifecycle state, escalation
   state, timestamps, exit facts, log identities, and cleanup status. Persist
   environment names and policy decisions, never secret values.
8. Route `process.run`, evidence commands, final-verification commands, durable
   managed processes, every Runner-owned Git command, and every configured local
   LSP/provider/MCP transport through the same environment, output, ownership,
   cancellation, quiescence, and recovery primitives. Protocol adapters retain
   framing only; they do not own process lifetime.
9. Build children from a scrubbed operational parent environment, not a tiny
   toolchain-breaking allowlist. Remove credential-shaped and Runner-internal
   names centrally; permit configured name-based pass-through; require a durable
   credential grant to restore a scrubbed name. Per-call values may add only
   non-secret entries.
10. Command/evidence/final-verification output keeps a 128 KiB in-memory tail per
    stream and spills up to 64 MiB per stream to a random Runner-state file
    protected for the current user. Tail or spill exhaustion never terminates or
    reclassifies a command solely for log volume. Spill failure continues with a
    bounded marked tail and a typed `lossyOutput` fact; a complete artifact is
    advertised only when the spool is intact. Protocol streams expose bounded
    diagnostics and are not artifacted.
11. Start, signal, terminate, verify, and recover are deterministic adapter
    operations selected from attested capabilities. Cancellation, timeout,
    startup failure, and disposal use one escalation state machine. A lifecycle
    that requires proven cleanup settles only after the backend verifies its
    owned group empty; otherwise it records a typed blocking quiescence failure.
12. The AI agent may request semantic actions such as stop, retry, or inspect.
    It may run bounded platform diagnostics only for an `orphaned`,
    `identity_mismatch`, `backend_unavailable`, or `outcome_unknown` recovery.
    Runner revalidates the birth fingerprint, target scope, and authority before
    executing any proposed recovery command. Ambiguous or destructive recovery
    requires a genuine user decision. Routine cleanup never requires a model
    call and remains available when the provider, browser, or agent session is
    absent.
13. On restart, the selected backend reconciles the durable generic record and
    opaque identity before retry. If the prior backend is unavailable, Runner
    records that fact and pauses rather than guessing from a PID or falling back
    to ambient spawn. An optional Job Object can provide Windows
    kill-on-controller-close; POSIX groups and isolated executors provide their
    own attested semantics.

### Git execution boundary

14. Remove the blanket “trusted Git” exclusion. Inventory every Git subcommand
    and classify whether it can invoke repository/user-controlled code. Run all
    Git through the scrubbed portable process runtime. Mutating, integration,
    diff/text-conversion, remote, and maintenance commands also receive exact
    worktree and Git-common-directory grants from the selected isolation
    provider when the active mode requires confinement.
15. Use a Runner-owned empty hooks directory; disable system/global config,
    interactive prompting, ambient credential helpers, fsmonitor hooks, external
    diff/textconv, and unapproved filter drivers. A required external filter or
    credential helper must be explicitly attested, approved, and run inside the
    same boundary. A repository that depends on an unapproved integration pauses
    with a typed decision instead of silently changing content.

### Portable filesystem mutation boundary and freshness semantics

16. The broker creates an opaque invocation grant from the permission decision.
    Immediately before every write/patch/move/delete operation, the trusted
    TypeScript filesystem seam re-canonicalizes all actual targets, rechecks them
    against that grant, and mutates the freshly resolved targets. This fence has
    no platform-specific model behavior. A swapped symlink or junction ancestor
    must deny or target the newly authorized identity, never the stale lexical
    path.
17. For text creation/replacement, protect **stale model knowledge**, not hostile
    external writers: replacing an existing file requires its observed SHA-256;
    creating a new file requires explicit create-only mode and an atomic
    create-if-absent primitive. `fs.patch` retains its required hash. Re-read the
    existing file immediately before publication and return a typed stale
    conflict on mismatch. The mutation queue serializes Runner aliases.
18. Do not call this external atomic compare-and-swap. A process outside Runner
    can still race between resolution/check and the platform syscall. The
    residual resolve-to-syscall and external-writer TOCTOU is documented and
    fault-tested. Move/delete receive last-mile path containment in P6.4 but no
    new content/tree revision precondition.

### Durable facts, cleanup, rollback, and recovery

19. Version the Runner capability contract and persist requested mode, selected
    backend/provider, attested capabilities, enforcement level, grant roots,
    environment-key decisions, generic and opaque process identity,
    spill/artifact identity, escalation, recovery proposals and approvals,
    outcome classification, and cleanup. Audit values are bounded and redact
    secret material.
20. Process-owner handles/tokens, isolation leases, private temp/cache, and spill
    files are Runner-owned resources. Startup reconciles or revokes leftovers
    before new work. An unrevoked grant, unmatched identity, or unverified group
    fails closed for workflows that require the corresponding guarantee.
21. Rollback restores the P5 executable state and keeps P7 locked; it never
    enables an ambient-spawn fallback. Active runs with an older capability
    contract pause for explicit migration/restart rather than silently weakening
    their boundary.

## P6.4 executable packets

| Packet | Scope | Smallest first validation |
|---|---|---|
| P6.4a | Freeze the portable threat model, capability and execution-grant types, generic process identity/result/output records, backend SPI, capability-contract version, and migration refusal. | Platform-neutral contract/schema tests and prove-red missing-version recovery |
| P6.4b | Implement centrally scrubbed child environments plus private bounded tail/spill with lossy continuation, independently of process backend. | One-shot fixture tests for environment policy and verbose/spill behavior |
| P6.4c | Implement deterministic ownership, escalation, quiescence, and restart reconciliation behind the backend SPI: one POSIX group/session adapter, one Windows adapter, optional Job enhancement, and isolated-executor adapter. | Backend contract suite plus child/grandchild, PID-reuse, cancel/timeout, crash/restart fixtures |
| P6.4d | Implement capability discovery and the attested `ExecutionIsolationProvider`, exact call-bound path grants, strict-mode fail-closed selection, explicit Full bypass, enforcement disclosure, and lease revocation/recovery. | Fake-provider contract tests plus disposable isolated-executor integration fixtures |
| P6.4e | Route one-shot, evidence, final-verification, managed, Git, LSP, MCP, and configured-provider child-process surfaces through the shared primitives while retaining only protocol framing. | Per-family focused regressions plus raw-spawn allowlist audit |
| P6.4f | Harden the central Git runner: command matrix, isolated configuration, hooks/helpers/filter policy, isolation grants, credential handling, and typed pauses. | Hook/filter/helper escape fixtures |
| P6.4g | Add the portable trusted filesystem mutation fence, existing-file revision requirement, create-only primitive, symlink/junction-race handling, and explicit external-TOCTOU classification. | Filesystem-tool stale/create/alias/symlink fixtures |
| P6.4h | Implement bounded AI exceptional recovery with durable proposals, birth/scope/authority validation, typed routine-recovery refusal, user escalation, and audit/client disclosure. | Recovery-contract, recycled-PID, ambiguity, authority, and client projection tests |
| P6.4i | Complete cleanup integration, documentation, package artifacts, Windows/Linux/macOS contract CI, adversarial re-audit, and the phase exit gate. | Cleanup/package/platform gates, then one final broad gate |

## Acceptance, validation, and prove-red evidence

Acceptance requires all of the following:

- No production raw child spawn remains outside a reviewed allowlist of the
  shared owner and reviewed optional backend helpers. Specialized configured
  transports retain protocol framing only and consume that owner for local
  process lifetime.
- No supported operating system changes the model-facing tools, durable process
  schema, permission semantics, or recovery protocol. Job Objects are optional;
  managed-process and LSP availability is capability-selected rather than
  Windows-only.
- Guarded/Project generated commands select a backend that attests the required
  write-confinement capability or pause before launch. Full bypass is explicit
  and durably visible; native local execution is never mislabeled as confined.
- A successful verbose command above the memory tail or spill cap completes,
  exposes a bounded tail, and reports whether a complete protected artifact is
  available. Log volume alone never terminates or reclassifies it.
- Cancellation/timeout and shutdown leave no observable owned child or
  grandchild when the backend advertises verified tree cleanup. A missing or
  failed required capability is typed and blocks continuation rather than
  falling back to an agent-generated or ambient command.
- Credential-shaped and Runner-control environment values are absent unless an
  exact durable grant restored a named value.
- Git hooks, fsmonitor, textconv/diff, helpers, and filters cannot escape via
  inherited configuration. Required approved integrations remain contained.
- Every filesystem mutation rechecks a fresh canonical target against the
  invocation grant. Existing-file replacement without the current revision and
  create-only races fail without overwriting.
- Audit/UI distinguish approval, isolation denial, partial enforcement, runner
  failure, command failure, cancellation, resource limit, outcome unknown, and
  cleanup failure.
- AI-authored operating-system commands appear only in bounded exceptional
  recovery records. Runner validates process birth, scope, and authority before
  execution; routine stop/restart/cleanup paths make no model call.

Each new guard must be proven red, reverted, and proven green. Mandatory fault
injections include:

- a direct child that exits while a grandchild survives, a TERM-ignoring tree,
  timeout/cancellation during output, restart during active ownership, PID reuse,
  missing opaque identity, backend disappearance, and a false capability claim;
- output just above the memory tail, just below the spill cap, and above the
  spill cap, plus spill close/permission/disk failures and restart cleanup; every spill
  loss continues with a bounded marked tail;
- inherited fake API tokens and Runner control secrets, explicit non-secret
  overrides, rejected credential restoration, and approved named restoration;
- unavailable/broken isolation providers, partial/full enforcement policy, an
  outside write, symlink/junction swap, hard-link residual case, exact
  approved-root one-call retry, revocation failure, and explicit Full bypass;
- pre-commit/post-checkout hooks, clean/smudge filters, textconv/external diff,
  fsmonitor, credential helper, and interactive prompt attempts;
- stale `fs.write`, concurrent create-only calls, alias-serialized Runner writes,
  and a controlled external-writer race that proves the documented limitation
  rather than a false atomic-CAS claim;
- attempted routine AI cleanup, recovery against a recycled PID, ambiguous
  orphan recovery, a validated bounded diagnostic, and an authority-required
  destructive recovery proposal.

Targeted validation is packet-local first: exact failing tests, affected files,
Runner typecheck, targeted ESLint, backend contract tests, and current-host
process/isolation inspection. The phase exit additionally requires the complete
Runner V2 gate, both maintained Node LTS lines, production Build surfaces
affected by audit/UI changes, reproducible Runner archives, Git
version/preflight, external state/temp roots, Windows/Linux/macOS CI for the
portable contract and native ownership adapters, at least one attested isolated
executor integration, and an audit showing no residual processes, helpers,
leases, grants, or spills. Earlier P5 results may be reused only for product
surfaces proven byte-identical and unaffected.

## Exit disposition

- The comparative benchmark and former HVI-6.1-HVI-6.9 are intentionally
  withdrawn by owner decision.
- P6.1/P6.2 closed in `4283bfea1675923483d83d3eed7c353fbd081d52`
  with the report, plan amendment, cleanup, and clean reproducible state.
- No broad DeepSeek product feature warrants work before P7.
- The owner approved the portable P6.4 design on 2026-08-28. P7 must not start
  until P6.4a-P6.4i pass the phase gate. The former Windows-first design is not
  approved for implementation and cannot satisfy this disposition.
