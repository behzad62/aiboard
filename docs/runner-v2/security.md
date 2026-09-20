# Runner V2 execution security model

Runner V2 uses explicit authority and fail-closed capability selection; it does not claim that every native child is sandboxed.

## Lifecycle scope (versioned)

Lifecycle proof is versioned and explicitly scoped. Current attestation distinguishes:

- `process_group` — authenticated owned process-group termination and emptiness only.
- `contained_workload` — emptiness and termination inside a recorded Job, configured OCI lease/container, or a future optional cgroup boundary.

Ordinary `full` / native process-group operation is **not** containment and is **not** security isolation. It is scoped lifecycle control for cooperative full-access work. Strict / non-full execution requires `contained_workload` **and** write/network confinement from an attested isolation provider; lifecycle containment alone does not satisfy a strict isolation grant.

Configured OCI workload containment and the host attach/control process lifecycle are separate boundaries. Stopping or releasing the host attach process does not discharge the container lease, and container retirement does not by itself settle the attach process.

Legacy or missing lifecycle scope never upgrades authority: readers may retain old records for exact owned cleanup, but must not infer `contained_workload`, replay an ambiguous launch, or treat group emptiness as all-descendant emptiness.

## Enforced boundaries

- Runner-issued grants bind the requested operation to canonical access roots/modes and the run permission profile. Model text is not grant authority.
- Strict execution is admitted only when current semantic capability evidence satisfies the enforcement contract. Missing, partial, expired, broken, or unverifiable evidence blocks before launch.
- Configured OCI uses an explicit absolute CLI path, configured image, network policy, immutable image/ownership evidence, and exact durable lease/container identity. Cleanup revalidates ownership before removal.
- `full` is explicitly `unconfined_explicit_full`; it is never presented as confinement.
- Windows Job containment is optional. It can strengthen current-host lifecycle containment for `contained_workload` requests, but its absence does not weaken the portable `process_group` contract or justify a false confinement claim.
- Output is bounded. Durable observations expose loss when evidence cannot be complete; consumers must not infer unseen bytes.

## Recovery and cleanup trust

Normal lifecycle and cleanup are deterministic Runner-owned operations. Startup invokes the owned recovery graph for processes, backends, OCI resources, grants, spills, and temporary roots before readiness; a declared coverage list is only a composition contract and does not substitute for provider/runtime cleanup evidence. Shutdown closes in reverse ownership order and returns typed blockers for unresolved resources. Historical read-only projection failures remain diagnostics when no live ownership is involved, while historical or ambiguous ownership records are retained as evidence and are not deletion authority merely because a PID disappeared. PPID/ancestry discovery is not ownership authority and must not authorize destructive control.

Exceptional AI-assisted process recovery is deliberately separate. It uses the configured Architect runtime to propose bounded recovery actions mediated by Runner recovery authority and durable records. It is not a routine cleanup fallback and cannot manufacture a clean state.

## Filesystem freshness and external writers

The filesystem mutation fence verifies canonical paths, native identity, expected revisions/content, and exact original grant authority at multiple points around mutation. Those checks reduce stale-read and path-substitution risk, but they are not an atomic filesystem compare-and-swap against uncontrolled external writers and are not a kernel namespace boundary. External software with independent authority can race between checks. Runner therefore reports revision/identity conflicts and unsupported safety primitives instead of claiming universal isolation.

## Operational limitations

Security claims are scoped to the attested provider and exact resource identities Runner can prove. A configured OCI provider being unavailable blocks strict OCI work; it is not permission to run the command natively. Cleanup that cannot prove emptiness **within the recorded lifecycle scope** remains blocked and user-visible. Repeated cleanup is safe to retry but never relabels uncertainty as success. Native process-group emptiness must never be presented as proof that every descendant anywhere on the host has terminated.
