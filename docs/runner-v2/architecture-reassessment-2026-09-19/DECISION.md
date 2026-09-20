# Runner V2: finish explicit lifecycle boundaries, not ancestry reconstruction

Architecture reassessment · 19 September 2026 · Proposed decision; implementation not started

Reviewed Task 12 HEAD `6e33354e7e3bed9e16ad9cb0416ef5e9f4b75940` and its nine dirty files. Cursor CLI performed a read-only code audit; Codex checked the critical code/diff, evaluated alternatives, and authored this decision and migration plan. This is an architecture assessment, not a new claim that native tests or Gate G passed. Evidence and limitations are in [evidence/inspection.md](evidence/inspection.md).

## 1. Executive conclusion

**Keep native POSIX process groups for ordinary full-access coding work. Stop trying to turn them into arbitrary-descendant containment. Keep Windows Job Objects and the existing OCI provider for stronger lifecycle boundaries. Defer a native Linux cgroup backend until a concrete workload needs strong containment without OCI.**

Change the lifecycle contract explicitly, including its consumers, durable records, release evidence and tests. Do not simply rename an `enforced` promise in documentation while keeping its old meaning in callers. Preserve ownership, fencing, output settlement, bounded operations and recovery. Remove the uncommitted PPID/escaped-descendant signaling experiment after separately preserving legitimate fixture and qualification repairs.

Two important corrections to the proposed OS/provider split:

1. Runner already separates **process backends** from **isolation providers**. Keep that composition. An OCI invocation owns a container and also uses a host process to attach to it; those are different resources. Four interchangeable monolithic backends would duplicate working machinery.
2. Job Objects and cgroups provide lifecycle control under stated conditions; neither alone supplies the filesystem/network security required for restricted execution. Native full access is not a hostile-code sandbox.

The strong guarantee is genuinely necessary for restricted execution and for workloads explicitly requiring complete descendant cleanup. It is unnecessarily strong as the unconditional requirement for every native command, MCP server and LSP server. A process group cannot meet it by accumulating better ancestry guesses.

## 2. Root cause of the complexity

The same capability names currently cover different resources. `PosixProcessBackend` advertises `tree_termination` and `verified_emptiness` as enforced; the four public execution families and the internal kernel request them. POSIX proves facts about its owned group, whereas OCI releases a dedicated container. Continuous ancestry reconstruction was added to bridge that semantic gap.

That bridge is unsound: a child can detach and lose its observable parent before a poll; detecting some descendants cannot prove that none were missed. Node explicitly documents that POSIX `detached: true` starts a new process group and session. [Node child-process documentation](https://nodejs.org/api/child_process.html#optionsdetached).

Gate B's existing requirement to re-attest **known group members after anchor exit** remains valuable. It must not be confused with discovering arbitrary escaped descendants. The current experiment also keeps its escape map in supervisor memory rather than durable recovery state, increasing complexity without establishing the stronger contract.

Timing, stale fixtures and qualification interference are separate issues. A longer test harness guard can be correct; changing the product deadline to disguise a slow host is not. The durable status also does not say all A–F gates are unconditionally closed: Gate D retains a Darwin follow-up.

There is a concrete test-classification error to address: `mcp-tools.test.ts`'s public-manager tree-close test uses `ownedManager` in **full/native** mode and `fixtures/mcp-descendant-server.mjs` spawns a detached child. Putting that test in the Docker qualification job does not turn this invocation into OCI execution. Split the ordinary inherited-child native case from a real isolated detached-child case and the native limitation case.

## 3. Real workloads and threat models

| Scenario | Classification | Supported policy |
|---|---|---|
| `npm test`, compilers, pytest, ordinary Node workers and foreground development servers | Common, mandatory | Group lifecycle is sufficient in explicit full/native mode when children remain members; normal cancellation and restart recovery required |
| Persistent MCP/LSP with ordinary helpers | Common, mandatory | Same default lifecycle; add protocol shutdown, durable session ownership and bounded output; persistence alone does not require containment |
| Tool legitimately daemonizes, launches a detached browser/helper, or starts a build daemon | Uncommon but legitimate | Prefer its foreground/no-daemon mode; otherwise use containment or an explicitly managed external service contract |
| Runner creates a detached supervisor/anchor | Necessary implementation mechanism | Register it as its own owned control-plane resource; place the workload in its intended boundary before execution; settle both separately |
| Runner/supervisor crash, lost anchor, reused PID/PGID, stale fence | Recovery-only but mandatory | Recover with exact authority; unknown identity blocks destructive control and automatic replay |
| Unknown project code in `project`/`guarded`, deliberate `setsid`, fork/inspection races | Security-sensitive | Attested isolation plus contained workload; never fall back to native full access |
| Same-user hostile code tampers with Runner state, asks a host service to launch work, or attacks the supervisor | Outside native full-access security contract | Use restricted execution with protected control plane and restricted service access; ancestry tracking cannot fix it |
| Root/kernel escape, arbitrary daemon brokers, exhaustive race-proof host process census | Beyond the supported native contract | Reject the stronger claim; select another trust boundary or declare unsupported |

AI-generated commands and repository scripts are not intrinsically trusted. Selecting `full` is the explicit trust decision, not evidence of benign code. Native supports Model A and bounded, honest handling of Model B; it does not defend against Model C. `guarded` and `project` both currently select enforced isolation; their approval/grant policies can differ without changing this requirement.

External services are distinct from descendants. Stopping a Docker CLI, contacting a compiler daemon, or asking a service manager to start a service does not own the work created by that service. Use an exact provider resource lease or classify it as an explicitly external service. Never kill a shared user daemon by name or ancestry.

## 4. Minimum useful capability model

Use **one lifecycle descriptor with an explicit scope**, retaining the current capability-state vocabulary:

```ts
lifecycle: {
  scope: "process_group" | "contained_workload";
  termination: "enforced" | "partial" | "unavailable" | "unverified";
  emptiness: "enforced" | "partial" | "unavailable" | "unverified";
}
// Keep crash_cleanup and write_confinement as separate existing capabilities.
// Invocation policy requests requiredLifecycleScope.
```

These are proposed contract shapes, not implemented APIs. Bind the selected scope and exact boundary identity to the durable launch/lease, grant authority and control effects. Backend ID, OS name or model text must never override a failed semantic capability check.

Definitions:

- **Process termination:** the identified process has stopped. It says nothing about children.
- **Process-group termination:** control addresses the authenticated owned group; successful completion requires no live members in that group. Exited/reparented children still in the group remain covered. Children that changed group are outside it.
- **Normal descendants:** a workload assumption, not an independently enforceable capability. Do not expose a `normal_tree` boolean.
- **Contained workload:** every process created through in-boundary process creation remains in the owned lifecycle boundary despite session/group changes, under the provider's declared authority limits. No permitted escape or external process-creation broker may invalidate that assertion.
- **Verified emptiness:** provider evidence of no live executable members **in the recorded scope**, with launch/control admission closed and ownership continuity intact. It is not host-wide absence, output settlement, or proof that arbitrary external effects ended. Reaping zombies and releasing handles remain separate obligations.
- **Crash cleanup:** independently attested behavior for a specified failure event. Job last-handle closure, controller crash and supervisor crash are different triggers. Ordinary recoverability remains mandatory even when automatic crash cleanup is unavailable.

Do not add public capabilities for PPID tracking, birth inspection or each implementation mechanism. They are evidence techniques. Keep security confinement independent; one scope enum is not a security profile.

Version this contract. Deprecate the broad old names; an old strict request must not silently become a group-only request. Readers retain legacy records for safe cleanup, never infer stronger proof from missing scope, and never replay an ambiguous launch to migrate it. Unsupported contract versions or ambiguous old ownership require an explicit blocker. Change schema, registries, intent construction, durable parsing, package/client projections and tests together.

## 5. Honest backend matrix

| Mechanism | Lifecycle advertisement after amendment | Conditions and limits | Automatic crash cleanup |
|---|---|---|---|
| Windows Job Object | Contained workload; enforced termination/emptiness | Assign before workload runs; no breakaway; exact protected Job ownership; query active membership; exclude uncontrolled service brokers | Only for documented configured trigger, e.g. last Job handle closes with kill-on-close |
| Linux process group | Process group; enforced scoped operations when exact continuity can be established | No arbitrary descendant containment; unknown inspection/identity fails closed | Unavailable by group primitive alone; durable recovery remains |
| macOS process group | Same scope as Linux | `setsid` can leave it; coarse `ps lstart` is not a unique process handle; do not signal after continuity loss based only on this timestamp | Same limitation |
| Linux cgroup v2, future optional adapter | Contained workload, **conditional on verified setup** | Workload born inside boundary, no migration authority outside it, exact subtree ownership, whole-subtree kill and empty proof | Not supplied merely by having a cgroup; needs an explicitly configured supervisor/service policy |
| Configured OCI provider | Contained workload at the dedicated lease/container | Exact immutable container identity, safe namespace/runtime configuration, no privileged escape access or host runtime socket, force-retire whole container | Runtime/failure dependent; retain honest partial/recoverable claim unless stronger behavior is proven |

Windows documentation explicitly distinguishes Job membership from security controls and notes service-mediated process creation exceptions. A no-breakaway Job is the right ordinary child-tree mechanism, not a guarantee against every action of hostile code. [Microsoft Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects).

Cgroup v2 supplies subtree kill and populated-state evidence and documents the permission conditions preventing migration outside a delegated subtree. Those facilities do not automatically protect a workload from authority available to the same user. [Linux cgroup v2 documentation](https://www.kernel.org/doc/html/latest/admin-guide/cgroup-v2.html).

**Do not make cgroups a Linux prerequisite.** Desktop/CI delegation and permissions vary; user namespaces do not by themselves establish usable delegation. Rootless support needs actual host probes. If later justified, implement one optional adapter using a supported delegated/systemd boundary, without a new privileged daemon or a cgroup-v1 fallback. Systemd also requires exclusive management of delegated subtrees. [Systemd delegation](https://systemd.io/CGROUP_DELEGATION/).

For macOS, expose group semantics and use an explicitly configured OCI/VM route for stronger requirements; otherwise reject before launch. Apple documents the session/group separation performed by `setsid`. Do not promise an unimplemented macOS containment provider. [Apple setsid reference](https://developer.apple.com/library/archive/documentation/System/Conceptual/ManPages_iPhoneOS/man2/setsid.2.html).

The existing non-Job `WindowsProcessBackend` also needs an advertisement audit: sampled birth-attested tree enumeration is not contained-workload enforcement. Never relabel that fallback as a Job-equivalent provider just because its semantic probe succeeded.

This exposes a real source conflict: the original portable plan makes Windows Job support optional and requires a portable baseline; canonical HVI-6A.5 forbids making an OS primitive a product requirement. Keep selection semantic, with Job preferred and a configured qualifying provider as an alternative. If the non-Job baseline cannot meet the new minimum lifecycle contract, explicitly amend that baseline availability obligation or retain a separately documented weaker operation; do not silently remove Windows functionality. The recommended amendment is honest unavailability of those managed lifecycle operations when no qualifying provider exists, not a global Windows-only implementation.

## 6. Selection algorithm

1. Resolve trusted invocation configuration, permission profile, executable/image identity, filesystem/network grant and requested lifecycle. Unknown arbitrary code is not certified cooperative by its command name.
2. `project`/`guarded`: require current exact-grant isolation **and** contained-workload cleanup. Use configured OCI, including image mapping and interactive attach where required. Job/cgroup lifecycle alone cannot satisfy the isolation grant.
3. `full`: ordinary command/managed/MCP/LSP requests process-group-level lifecycle. Prefer an attested Job on Windows and the native group on Linux/macOS. Require both termination and scoped emptiness enforced. The unsupported Windows fallback must fail honestly if it cannot meet a registered supported lifecycle contract, subject to the explicit baseline-availability amendment above.
4. An explicit complete-cleanup requirement or known unavoidable daemonization requests contained workload. Use a qualified Job, an optional future cgroup adapter, or an already configured compatible OCI provider. Foreground mode is preferable when the tool supports it.
5. For OCI, evaluate the **workload** at the container boundary and the **attach/control process** at its own host boundary. Do not make Linux/macOS launchers prove container containment. Conversely, killing the attach process cannot discharge container cleanup.
6. If no configured provider satisfies all requirements, return capability unavailable before launch. Never silently change mounts, executable/image, network access, permissions, or native-to-container execution semantics. The existing unconditional `full` isolation bypass needs an explicit compatible-provider route for full-access requests that choose containment. Persist the actual selection and exact identities; recovery resumes that selection, not a fresh provider search.

Managed servers require the same requested scope rules as one-shots. MCP additionally needs protocol/channel settlement; LSP needs its shutdown/exit sequence before escalation. Do not impose stronger containment merely because a tool speaks MCP or LSP.

## 7. Recovery model

Keep durable ownership, exact invocation/grant/session IDs, backend implementation identity, owner/fence/revision, launch/control effect journal, boot-qualified process identity where available, group/anchor identity, output checkpoints and OCI lease/container identities. Preserve startup recovery before readiness and reverse-order shutdown.

Reattach through the registered backend and current durable authority. Revalidate before each destructive effect; a status file is not independent authority. Retain the already accepted rule that no new group witnesses may be learned after authenticated anchor loss. Never scan arbitrary PPIDs to invent ownership during recovery.

Birth fingerprints reduce reuse mistakes; a numeric PID plus a coarse timestamp is not a kernel handle. Preserve a pinned/live anchor where it supplies continuity. If a platform cannot establish safe identity at the effect boundary after losing that anchor, report blocked/unknown instead of adding inspection retries and claiming certainty. Do not introduce pidfds or a new macOS helper as an unbounded Gate G project; narrowly investigate a required missing primitive and choose fail-closed behavior when absent.

A durable “effect issued, outcome unknown” never authorizes automatic repeat of a command or other non-idempotent operation. Cleanup may retry only against the same exact owned resource and current fence. Old records remain inspectable; upgrades must not rewrite historical “released” records into stronger evidence.

## 8. Cleanup and escape semantics

**`released`** means all obligations for the recorded scope have evidence: ownership validated; no further admitted work; workload empty in that scope; control operations settled; supervisor terminal; output drained or loss represented according to the existing bounded-output contract; evidence durable; associated leases/resources released. Display the scope. “Group empty” must never be displayed as “all descendants terminated.”

**`cleanup_blocked`** means a specific cleanup obligation remains unmet: live owned resource, unverified emptiness, unresolved known escape, unavailable provider, unsettled output, supervisor or durable evidence. Preserve identities and diagnostics; do not permit automatic reuse/replacement of that affected resource.

**`outcome_unknown`** means Runner cannot establish an operation's outcome or identity/authority needed to decide safely. It is not a successful release. Preserve known facts—an uncertain stop does not erase a known exit code—and require reconciliation before replay or further destructive action.

Exact native escape policy:

1. Do not add continuous host-tree enumeration. Absence of an observed escape is never proof none occurred.
2. Use low-cost existing evidence (registered helper identity, protocol ownership, observed loss of group membership) diagnostically. PPID alone does not establish cleanup authority.
3. If an attributable owned helper is known to escape, record the incident and block automatic affected-resource release/replacement until its termination or explicit external ownership transfer is established. Do not introduce a generic per-PID escape killer. Uncertain attribution is reported as uncertainty and does not authorize signaling.
4. If no escape is known and the group and other owned resources have valid evidence, release **the group-scoped lease**. Do not block every native execution forever because an invisible detached process is theoretically possible. Native mode cannot promise zero undetected escaped helpers.
5. Known detaching configurations must use foreground mode, an external-service lease, or a contained provider before the next launch. A continuing external service needs explicit ownership/acceptance; it is not a cleanup success.

An escaped process holding stdout open is an output-settlement failure even if its former group is empty. A scoped lifecycle amendment must not manufacture EOF or discard evidence to complete release.

## 9. Test and CI model

Keep the existing PR/qualification split. Qualification is still a release requirement for advertised guarantees, even when it is not a deterministic PR gate.

| Property | Deterministic PR checks | Real-host qualification / provider checks |
|---|---|---|
| Capability meaning and selection | Profile × family × scope; group rejects strict; no native fallback; forged/expired attestation | Current adapter probe on Windows/Linux/macOS |
| Fencing and exact ownership | Takeover between each authority/effect boundary; PID/PGID mismatch; malformed/unknown inspection; no signal | Real anchor loss, supervisor crash and restart on each OS |
| Ordinary lifecycle | Fake-provider transitions and group-scoped evidence | Foreground command, live inherited child after parent exit, managed/MCP/LSP shutdown |
| Detached child | Group backend never advertises containment; known escape reports/blocker | Group limitation fixture expects scoped behavior and explicitly cleans its owned escape; it must not demand arbitrary tree killing |
| Strict containment | Admission/lease/identity negatives | Job: detached/no-breakaway; OCI: `setsid`/double fork inside exact container, controller loss, attach cancellation, whole-container retirement; future cgroup: migration rejection/subtree empty |
| Output/release | No premature release; retained replay/ack; poll uses durable fence; blocked writer | Delayed inherited output handle, spool recovery, live terminal supervisor |
| Compatibility | v1 record read, no silent scope downgrade, no replay, unsupported version rejection | Restart across supported upgrade boundary with captured records |
| Packaging/configuration | Existing parity, host aliases, provider configuration and reproducibility | Real CLI readiness and native canonical-path behavior |
| Required P6/benchmark | Existing deterministic checks retained | Final required certified/full suite, controlled environment and comparable performance evidence |

Fixtures must create current durable SQLite authority, not only hand-written sidecars. Native/Docker tests sharing host resources run serially or with proven resource isolation. Separate CI machines need not be globally serialized.

Derive a test outer guard from setup + all sequential legal product bounds + assertions/fixture cleanup + documented scheduling margin. Keep product deadline assertions separately. The current 90-second Windows fixture changes are candidates for this review, not automatically accepted because they only touch tests. In particular, an injected inspector's larger timeout must not weaken the product-bound negative proof.

## 10. Remove or simplify

- Park/remove the new `listPosixProcessParents`, `parsePosixProcessParents`, `collectPosixDescendantPids` and declarations in `portable-process-posix-control.*`.
- Remove `posixEscapedMembers`, `captureOwnedPosixDescendantClosure`, `reattestOwnedPosixEscapedDescendants`, `signalOwnedPosixEscapedDescendants` and their newly added control/terminal branches from `portable-process-supervisor.mjs`.
- Replace the new descendant-closure unit test with the explicit limitation and known-escape contract tests. Keep ordinary surviving-group-child tests.
- Remove broad lifecycle names from new requests after versioned migration; do not merely downgrade advertisement while leaving all consumers demanding the old capability.
- Keep the flagged unreachable legacy POSIX `activeOwnedPids` branch out of use; remove it only after caller proof, with no opportunistic Windows rewrite.

Do not blanket-reset the nine modified files. The CI serialization, recovery-startup cleanup/diagnostics, outer guards and late-birth fixture changes require separate disposition and evidence. Darwin-only qualification changes must not silently remove Windows/Linux configuration trust coverage.

## 11. Retain

Keep execution grants, fencing and SQLite ownership authority; process birth and group/anchor continuity; group membership enumeration needed for safe control; current bounded retries/deadlines; output spool/retained delivery/acknowledgement and terminal settlement; Job containment; exact OCI leases, removal and restart recovery; canonical configuration confinement; explicit user handoff.

PPID tracking is unnecessary for POSIX release authority. Existing platform-specific diagnostic code can remain only if it has an independent supported use and cannot authorize destructive effects or claim all-descendant emptiness.

## 12. Small-step migration

The executable packet contracts, ownership, evidence routes and launch/resume cards are in [PLAN.md](PLAN.md): **M0** adopt the scoped amendment and classify dirty hunks; **M1** version the contract and update policy/consumers/compatibility; **M2** simplify POSIX with ownership/output/escape regressions; **M3** validate strong-provider composition and cleanup; **M4** classify tests and close the exact-candidate Gate G matrix. One Cursor implementation lane; Codex reviews each coherent packet. No cgroup project is on this critical path.

## 13. Gate G closure criteria

Gate G remains open now. Close it only when the proposed amendment is adopted, affected B/E evidence is reaccepted, Gate D's Darwin follow-up is resolved, and every applicable original requirement has a valid route in the amended matrix. Claims must match provider scope; strict unavailable paths must reject; ordinary supported workloads must function on all three OSes.

Require exact-candidate package parity/reproducibility, deterministic contracts, native qualification, configured OCI lifecycle, stale-owner/reuse safety, bounded output and recovery, canonical paths, compatibility, certified benchmark and the original required full P6 checks. Preserve original deadline assertions. No uncommitted experiment needed for passing, unexplained skips, unresolved ownership/cleanup blocker, or false universal-emptiness claim. Independently reconcile source-to-delivery before the final expensive suite; retain inspectable revision/host/command/outcome evidence.

Here “full P6 checks” means the Task 12/P6.4 exit obligations and required regression suites, including the original archive/raw-spawn/capability/spill-container/legacy-contract fault proofs, lint and cleanup inspection. It does not declare the separate P6.5/P6.6/P7 work complete or authorize starting it.

## 14. Complexity budget and stopping rules

1. If correctness needs discovering every descendant after reparenting, change the provider/contract; do not add another census.
2. Each destructive control path needs an explicit ownership proof. More retries cannot turn ambiguous identity into authority.
3. Three substantive, evidence-backed repair cycles per root cause across sessions; then stop that repair and reconsider the requirement, provider or environment.
4. Add a capability only for a distinct consumer decision and measurable enforcement boundary; tracking techniques are not capabilities.
5. Preserve product bounds. Adjust only justified harness guards; concurrency/fixture failures are repaired at that layer.
6. A real unsupported native daemon is a configuration/provider issue, not permission to construct a portable container in JavaScript.
7. Never count a test green by changing the promised guarantee implicitly. Record the contract amendment and retain negative tests proving honest rejection/limitations.
8. Do not add a privileged cgroup service, macOS containment subsystem, or generic recovery framework to finish Gate G. A concrete unsupported requirement gets its own bounded decision.
9. One independent review per coherent packet; reuse accepted evidence unless its behavior/environment changed. Avoid repeated whole-project audits and full-suite runs during repairs.
10. Native's honest limitation is an acceptable architecture result. If the product instead insists that every native command leave no escaped descendants, POSIX groups must be rejected and real containment becomes mandatory; the enumeration experiment still cannot satisfy that requirement.
