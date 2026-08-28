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

Publication requires this ignored-by-default report to be force-tracked in the
same clean commit as the plan amendment and benchmark cleanup. The publication
gate must repeat the P5 product-surface comparison; this paragraph does not
substitute for that evidence.

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
| Operating-system process file-effect confinement | **Default.** Shell calls use fail-closed Linux bwrap/Landlock, macOS Seatbelt, or Windows restricted-token/ACL backends and report `full` versus `partial` enforcement (`packages/bundle/base/cordis.patch.yml:208-228`; `packages/sandbox/sandbox-local/README.md:10-12,51-85`; tests: `packages/sandbox/sandbox-local/tests/local.spec.ts`, `acl-grants.spec.ts`, and `packed-workspace-closure.spec.ts`). Windows and older Landlock are partial; Seatbelt depends on deprecated `sandbox-exec`; the whole project remains unaudited (`packages/sandbox/sandbox-local/README.md:121-132`). | **Material gap.** Approved Runner commands otherwise have the host user's filesystem authority. Add a kernel-owned confinement backend, fail closed when required protection is unavailable, record partial enforcement honestly, and keep explicit Full access as the only ordinary bypass. Scope the first release to Runner's current Windows product/P7 environment; do not claim unimplemented Linux/macOS support. |
| Trusted filesystem fence and path freshness | **Default.** `fs-sandbox` and read-before-edit policy are loaded (`packages/bundle/base/cordis.patch.yml:263-264,491-494`). The filesystem seam re-canonicalizes the actual mutation target immediately before use and shares process workspace policy; observation versions reject stale cooperating writes (`packages/fs/fs-sandbox/README.md:12,28,44-50,64-79`; `packages/fs/fs-observation-policy/README.md:12-46,63-82`; tests: `packages/fs/fs-sandbox/tests/fs-sandbox.spec.ts`, `packages/fs/fs-sandbox/tests/containment.spec.ts`, and `packages/fs/fs-observation-policy/tests/policy.spec.ts`). Its version check plus later rename is **not** an atomic compare-and-swap against an external writer. It accepts a residual resolve-to-syscall race. | **Two bounded gaps.** Runner authorizes a canonical path in the broker but later resolves the original lexical path at the filesystem tool, so a changed symlink ancestor can redirect the mutation (`runner-v2/src/tool-broker.ts:430-444`; `runner-v2/src/filesystem-tools.ts:739-742`). `fs.patch` requires a hash, while `fs.write` may replace an existing file without one (`runner-v2/src/filesystem-tools.ts:332-403,499-530`). Add a trusted last-mile fence for every filesystem mutation and an **optimistic freshness guard** for text replacement/create. Do not claim external atomic CAS. Move/delete freshness is explicitly outside this packet; their path containment is not. |
| Plugins, profiles, presets, and live reload | **Default plugin architecture; profile-dependent reload.** Cordis makes services replaceable (`docs/architecture.md:9-29`). Base HMR is disabled (`cordis.patch.yml:19-24`); shipped Web/custom profiles can reload patches, while headless/SDK/ACP apply once. Dynamic self-modification packages are shipped but process-memory-only and equivalent in trust to model code (`packages/extensions/README.md:10-13`; tests under `packages/extensions/*/tests`). | **Broader, not better for durable builds.** Runner deliberately uses static, allowlisted, content-addressed capability snapshots, brokered tools, bounded context, reverse-order disposal, skills, and generic LSP. Do not add active-build hot reload, marketplace loading, or self-modification; they weaken reproducibility and kernel authority. |
| Skills | **Default.** Filesystem skills are watched and re-read live (`packages/bundle/base/cordis.patch.yml:279-290`; `packages/skill/skill-filesystem/README.md:12,28-40,65-73`; tests: `packages/skill/skill-filesystem/tests/skill-filesystem.spec.ts` and `packages/skill/skill-filesystem/tests/skill-filesystem-watcher.spec.ts`). | **No gap.** Runner discovers skills on demand, hashes content, and fails closed if a skill changes between discovery and read. Live mutation during a durable build is intentionally rejected. |
| Language-server intelligence | **Optional configuration.** Packages and tests ship, but deployments must configure commands/mappings and no language server is bundled (`packages/lsp/README.md:10-31`; tests: `packages/lsp/lsp-stdio/tests/lifecycle.spec.ts`, `framing.spec.ts`, `host.spec.ts`, and `packages/lsp/tool-lsp/tests/integration.spec.ts`). | **Runner stronger at language behavior, but process ownership must be unified.** Runner ships a built-in TypeScript provider plus generic configured LSP with executable attestation, workspace/result containment, document versions, bounded restart/results, and Windows tree ownership. Retain protocol behavior and attestation, but make every local server consume the shared low-level environment/Job/quiescence owner rather than an independent process lifetime. |
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

## Recommended P6.4 design for owner approval

### Security and support decisions

1. Add a kernel-owned `SubprocessRuntime` and `FilesystemMutationFence`. Neither
   is an extension capability or replaceable by model-loaded code.
2. Target the current Windows Runner product and P7 environment first. The
   contract remains portable, but containment-required process calls on an
   unsupported platform fail with a typed unavailable result. Full access may
   explicitly bypass file-write confinement; it never bypasses tree ownership,
   output bounds, or environment scrubbing. Linux/macOS backends require a later
   separately certified phase.
3. Windows uses Job Object tree ownership plus a restricted-token/ACL
   file-write backend. The backend must report `partial`, because Everyone ACEs
   and NTFS hard links prevent an absolute boundary. Guarded and Project may use
   the probed partial backend only with a durable, user-visible residual-risk
   fact; an operator `requireFullConfinement` setting refuses it. Backend absence
   or probe failure never falls through to an ordinary host spawn.
4. The default writable set is the exact task/integration/verification
   workspace plus Runner-owned private temp/cache. Guarded approval inside those
   roots does not widen them. An approved outside path creates an opaque,
   call-bound grant for the exact canonical path and requested access, then
   revokes it. A generic approval without declared `writablePaths` does not grant
   the whole host. Full access is the only broad bypass.
5. This is file-write confinement, not read confidentiality or network
   isolation. Network/external-system effects retain current permission checks.
   The UI and audit must not describe the backend as a container or secure
   execution environment.

### Shared subprocess contract

6. Route `process.run`, evidence commands, final-verification commands, durable
   managed processes, every Runner-owned Git command, and every configured local
   LSP/provider/MCP transport through shared low-level Job/tree ownership,
   escalation, quiescence, recovery, and child-environment primitives. LSP,
   provider, and MCP adapters retain only their protocol framing and bounded
   diagnostic presentation; they do not retain an independent process lifetime.
7. Build children from a scrubbed operational parent environment, not a tiny
   toolchain-breaking allowlist. Remove credential-shaped and Runner-internal
   names centrally; permit configured name-based pass-through; require a durable
   credential grant for restoring a scrubbed name. Per-call values may add only
   non-secret entries. Persist names and policy decisions, never secret values.
8. Command/evidence/final-verification output keeps a 128 KiB in-memory tail per
   stream and spills up to 64 MiB per stream to a random Runner-state file
   protected for the current user. Reaching the tail limit does not terminate a
   verbose build. If the spill cap or a spill write/close fails, delete or stop
   advertising the incomplete spool, continue draining while retaining only the
   bounded tail, and return a typed `lossyOutput` fact. A command is never killed
   or reclassified solely for log volume. Durable evidence receives an artifact
   reference only when the full spool is intact; protocol streams such as LSP
   and MCP are never artifacted and expose only bounded diagnostics.
9. Cancellation, timeout, startup failure, and disposal use
   one escalation state machine and settle only after the owned Job is empty or
   a typed quiescence failure is durable. A runner crash relies on
   kill-on-job-close; restart reconciles the invocation as outcome-unknown and
   verifies before any retry.

### Git execution boundary

10. Remove the blanket “trusted Git” exclusion. Inventory every Git subcommand
    and classify whether it can invoke repository/user-controlled code. Run all
    Git through the scrubbed process runtime. Commands capable of checkout,
    index mutation, commit, integration, diff text conversion, remote access, or
    maintenance also run under the filesystem boundary with exact worktree and
    Git-common-directory grants.
11. Use a Runner-owned empty hooks directory; disable system/global config,
    interactive prompting, ambient credential helpers, fsmonitor hooks, external
    diff/textconv, and unapproved filter drivers. A required external filter or
    credential helper must be explicitly attested, approved, and run inside the
    same boundary. A repository that depends on an unapproved required filter
    pauses with a typed decision instead of silently changing content.

### Filesystem mutation boundary and freshness semantics

12. The broker creates an opaque invocation grant from the permission decision.
    Immediately before every write/patch/move/delete operation, the trusted
    filesystem seam re-canonicalizes all actual targets, rechecks them against
    that grant, and mutates the freshly resolved targets. A swapped symlink
    ancestor must deny or target the newly authorized identity, never the stale
    lexical path.
13. For text creation/replacement, protect **stale model knowledge**, not hostile
    external writers: replacing an existing file requires its observed SHA-256;
    creating a new file requires explicit create-only mode and an atomic
    create-if-absent primitive. `fs.patch` retains its required hash. Re-read the
    existing file immediately before publication and return a typed stale
    conflict on mismatch. The mutation queue serializes Runner aliases.
14. Do not call this external atomic compare-and-swap. A process outside the
    Runner can still race between resolution/check and the platform syscall.
    The residual resolve-to-syscall and external-writer TOCTOU is documented and
    fault-tested so the Runner never claims a stronger guarantee. Move/delete
    receive last-mile path containment in P6.4 but no new content/tree revision
    precondition; that is explicit residual scope.

### Durable facts, cleanup, rollback, and recovery

15. Version the Runner capability contract and persist sandbox mode/backend,
    enforcement level, grant roots, environment-key decisions, process/job
    identity, spill/artifact identity, escalation, denial versus runner failure,
    outcome classification, and cleanup. Audit values are bounded and redact
    secret material.
16. ACL entries, Job handles, private temp/cache, and spill files are
    Runner-owned resources. Startup reconciles or revokes leftovers before new
    work. An unrevoked grant or unjoined tree fails closed and pauses the run.
17. Rollback restores the P5 executable state and keeps P7 locked; it never
    enables an ambient-spawn fallback. Active runs with an older capability
    contract pause for explicit migration/restart rather than silently weakening
    their boundary.

## P6.4 executable packets

| Packet | Scope | Smallest first validation |
|---|---|---|
| P6.4a | Freeze threat model, Windows enforcement contract, grant types, process result/output types, capability-contract version, and migration refusal. | Contract/schema tests and prove-red missing-version recovery |
| P6.4b | Implement scrubbed child environments, private bounded tail/spill with lossy continuation, Job-owned tree lifecycle, escalation, quiescence, and orphan recovery as shared primitives. | One-shot fixture tests: env, verbose output, child/grandchild, cancel/timeout |
| P6.4c | Implement probed Windows restricted-token/ACL workspace-write backend, exact one-call path grants, Full bypass, partial-enforcement disclosure, and revocation/recovery. | Disposable NTFS workspace integration tests and ACL fault injection |
| P6.4d | Route one-shot, evidence, final-verification, managed, and configured child-process surfaces through the shared primitives. | Per-family focused regressions plus raw-spawn allowlist audit |
| P6.4e | Harden the central Git runner: command matrix, isolated configuration, hooks/helpers/filter policy, sandbox grants, credential handling, and typed pauses. | Hook/filter/helper escape fixtures |
| P6.4f | Add the trusted filesystem mutation fence, existing-file revision requirement, create-only primitive, symlink-race handling, and explicit external-TOCTOU classification. | Filesystem-tool stale/create/symlink fixtures |
| P6.4g | Wire durable audit/client disclosure, recovery cleanup, documentation, package artifacts, adversarial re-audit, and phase exit. | Affected integration gates, then one final broad gate |

## Acceptance, validation, and prove-red evidence

Acceptance requires all of the following:

- No production raw child spawn remains outside a reviewed allowlist of the
  shared owner and its Windows helper. Specialized configured transports retain
  protocol framing only and consume that owner for local process lifetime.
- Guarded/Project generated commands cannot write outside exact granted roots;
  Full bypass is explicit and durably visible.
- A successful verbose command above the memory tail or spill cap completes,
  exposes a bounded tail, and reports whether a complete protected artifact is
  available. Log volume alone never terminates or reclassifies it.
- Cancellation/timeout/output-limit and shutdown leave no observable child or
  grandchild; cleanup failure is typed and blocks continuation.
- Credential-shaped and Runner-control environment values are absent unless an
  exact durable grant restored a named value.
- Git hooks, fsmonitor, textconv/diff, helpers, and filters cannot escape via
  inherited configuration. Required approved integrations remain contained.
- Every filesystem mutation rechecks a fresh canonical target against the
  invocation grant. Existing-file replacement without the current revision and
  create-only races fail without overwriting.
- Audit/UI distinguish approval, sandbox denial, partial enforcement, runner
  failure, command failure, cancellation, resource limit, outcome unknown, and
  cleanup failure.

Each new guard must be proven red, reverted, and proven green. Mandatory fault
injections include:

- a direct child that exits while a grandchild survives, a TERM-ignoring tree,
  timeout/cancellation during output, and restart during an active job;
- output just above the memory tail, just below the spill cap, and above the
  spill cap, plus spill close/ACL/disk failures and restart cleanup; every spill
  loss continues with a bounded marked tail;
- inherited fake API tokens and Runner control secrets, explicit non-secret
  overrides, rejected credential restoration, and approved named restoration;
- unavailable/broken sandbox helpers, partial/full enforcement policy, an
  outside write, symlink swap, NTFS junction, hard-link residual case, exact
  approved-root one-call retry, revocation failure, and explicit Full bypass;
- pre-commit/post-checkout hooks, clean/smudge filters, textconv/external diff,
  fsmonitor, credential helper, and interactive prompt attempts;
- stale `fs.write`, concurrent create-only calls, alias-serialized Runner writes,
  and a controlled external-writer race that proves the documented limitation
  rather than a false atomic-CAS claim.

Targeted validation is packet-local first: exact failing tests, affected files,
Runner typecheck, targeted ESLint, and Windows process/ACL inspection. The phase
exit additionally requires the complete Runner V2 gate, both maintained Node
LTS lines, production Build surfaces affected by audit/UI changes, reproducible
Runner archives, Git version/preflight, a non-admin NTFS environment, external
state/temp roots, and an OS audit showing no residual jobs, helpers, grants, or
spills. Earlier P5 results may be reused only for product surfaces proven
byte-identical and unaffected.

## Exit disposition

- The comparative benchmark and former HVI-6.1-HVI-6.9 are intentionally
  withdrawn by owner decision.
- P6.1/P6.2 close only when this report, the plan amendment, and cleanup are
  committed with a clean reproducible state.
- No broad DeepSeek product feature warrants work before P7.
- P7 must not start until the owner approves or explicitly waives P6.4. If
  approved, every packet above must pass the phase gate. If waived, the waiver
  must name the residual host-write, credential-exposure, orphan-process,
  verbose-build, Git-indirect-execution, and stale-mutation risks.
