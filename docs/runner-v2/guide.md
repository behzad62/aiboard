# Runner V2 execution safety guide

Runner V2 is the native Build kernel. Execution is capability-driven: Runner validates the persisted run capability contract, prepares the centrally filtered child environment, issues the exact grant for the requested operation, and selects an implementation whose attested semantic capabilities satisfy that grant.

## Permission profiles and confinement

Strict profiles fail closed. They never fall back to a native host command when the configured provider cannot prove the required capability. A strict OCI selection is provider-specific enforcement: the configured provider must attest its CLI and immutable image and return the owned execution plan for the exact lease/grant. Native execution, the Docker CLI process itself, and partial or unverified providers are not described as universally confined.

`full` is an explicit bypass, persistently disclosed as `unconfined_explicit_full`; it is not confinement. Full may authorize otherwise guarded effects according to run policy. Final project handoff still pauses for the user.

Windows Job Objects are an optional host enhancement. Portable Windows behavior remains the baseline; Job support is used only from current semantic capability evidence and is never a Windows-only product requirement.

## Exact grants and configured OCI

Runner-issued grants are bounded claims tied to run/invocation, permission profile, and canonical read/write/create roots and modes. A model cannot author or widen a grant, choose routine cleanup, or turn an unavailable strict capability into Full.

OCI isolation is explicit configuration. Each `isolationProviders` entry supplies an absolute `cliPath`, image, and `allowNetwork`. Strict execution depends on that configured provider being available and attestable; Runner does not silently discover a replacement or switch to native while retaining a confinement claim. Durable OCI ownership binds provider, image, labels, container/lease, run/invocation/grant, and cleanup state so restart cleanup can revalidate exact ownership before removal.

## Startup, shutdown, output, and recovery

Before the control server accepts work, Runner executes owned recovery for processes, backends, isolation/OCI leases and containers, grants, spills, and temporary roots. The startup `covers` declaration is a composition-time completeness assertion, not cleanup proof by itself; concrete runtime/provider recovery must still settle without a blocker. Unresolved active-resource or settled-owned cleanup produces a typed startup blocker and readiness is not published. A terminal historical reader that owns no live resources may fail diagnostically without converting old read-only history into a startup blocker.

Shutdown closes owned resources in reverse composition order. Successful closes are remembered; a retry acts only on resources whose cleanup failed. Cleanup failure remains a typed blocker. Runner never substitutes ambient/raw process launch or model-authored routine cleanup for an owned cleanup path. Historical ambiguous records are evidence, not deletion authority.

Streaming output is bounded by the durable provider window. Lossy evidence is recorded and surfaced instead of silently presented as complete. Spill ownership and cleanup stay inside Runner-managed state.

Exceptional AI-assisted process recovery is a separate explicit path using the configured Architect runtime and durable recovery records. It does not replace deterministic lifecycle/cleanup, and a recovery record alone does not prove cleanup.

## Filesystem freshness limitation

Trusted filesystem mutation captures path identity and expected content/revision, rechecks them before publication, and fails typed on conflicts, aliasing, unsupported primitives, or identity changes. It is deliberately **not** an atomic compare-and-swap against an uncontrolled external writer and is not a kernel filesystem sandbox. An external process can still race between checks; atomic replacement preserves complete bytes but does not promise ACL/xattr preservation or crash durability.

See [architecture](./architecture.md) for ownership composition and [security](./security.md) for threat-boundary details.