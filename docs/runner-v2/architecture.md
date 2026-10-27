# Runner V2 execution architecture

## Ownership graph

The CLI is the composition root. It owns the supervisor/config stores and native Build factory/manager. Each live Build factory owns its run-scoped execution host, grant authority, isolation selector/provider state, subprocess and streaming runtimes, output/spill state, and family runtimes. Platform adapters do not become independent lifecycle owners.

Startup follows ownership. `NativeBuildManager.recover()` reconstructs eligible active Builds and reports blockers from active recovery or cleanup of still-owned settled resources. Factory/runtime recovery owns the external resource classes that can outlive memory: processes, backends, isolation/OCI leases and containers, execution grants, output spills, and temporary roots. The CLI wraps that recovery in `reconcileRunnerStartup`; its coverage declaration checks composition completeness, while the actual recovery result and resource-specific ownership evidence determine whether readiness is safe. A terminal historical reader is read-only and cannot by itself block readiness when it owns no live resource.

Shutdown reverses composition. The CLI closes the control server, Build manager, factory/runtime composition, internal execution context, execution host, permission/config stores, and supervisor. Family/provider code remains responsible for proving its resources empty or released. Top-level cleanup remembers successful closes and retries only blockers, making repeated cleanup idempotent without treating a failed close as success.

## Process and platform boundary

Application/runtime code does not launch ambient processes directly. Raw process creation is confined to twelve audited low-level boundaries: the eleven Node boundaries `src/native-process-backend.ts`, `src/oci-execution-isolation-provider.ts`, `src/windows-job-process-host.ts`, `src/windows-process-semantic-probes.ts`, `src/windows-birth/session.mjs`, `src/managed-process-supervisor.mjs`, `src/owned-fence-lock.mjs`, `src/portable-process-child.mjs`, `src/portable-process-posix-control.mjs`, `src/portable-process-supervisor.mjs` and `src/extension-mcp-launcher.ts`, plus the Windows native Job host `src/managed-process-job-host.ps1`. Together these cover the native/OCI/Windows adapters and the managed/portable bootstrap-control chain that actually launches and supervises workloads. `src/extension-mcp-launcher.ts` only embeds the source of a digest-pinned stdio MCP launcher: the Runner starts it as an ordinary owned MCP transport command, and it claims a one-time user-only secrets file and spawns exactly one server child with inherited stdio inside that owned process tree, so credentials never reach a supervisor command line. The Windows inspection Session launches only the installed helper after validating its path, source/build provenance and held binary descriptor digest. Its creator registers cleanup before preparation; the Session retains the original helper handle, Worker, streams and descriptor until bounded cleanup verifies their disposition. Physical settlement after a failed native exit does not certify normal release. A static policy test scans both `src/` and `bin/`: it recognizes `node:child_process` and bare `child_process` across static imports, `require(...)`, and dynamic `import(...)`, and separately audits shipped PowerShell for native process-creation surfaces such as Win32 `CreateProcess`. Every such boundary must be deliberately allowlisted, audit-marked, and documented.

The separate `src/launcher.ts` bootstrap is outside Runner tool authority and starts only the fixed Runner V2 entrypoint using the current Node executable. It passes the session credential through the inherited IPC channel; it does not start model-requested commands or add an execution path available to Runner tools. Discovery and Runner lifetime locks fence startup and shutdown, and a verified local control request invokes the Runner's own cleanup rather than signalling a recorded PID.

Launcher control uses a separate per-instance key in the private state directory. POSIX ownership and private mode are checked before use. Windows default state relies on the per-user profile's default ACL: LOCALAPPDATA must resolve inside the profile, the path from the profile to state must not contain links or junctions, and existing state must have a matching launcher ownership record. An explicit Windows state directory is the user's choice, but still must be outside the project and contain no links or junctions. Node's Windows mode bits do not verify the ACL; OS keychain and ACL verification remain future work. The launcher refuses nonempty unowned state and token-valued arguments; safe adoption and private legacy-token input remain to be implemented. The original Runner command retains its existing flags.

The portable backend defines the cross-platform contract. POSIX and Windows adapters implement host semantics behind it. Windows Job Objects are optional enhancement capability, not required behavior. Strict OCI is a separately configured provider and does not make the native backend itself confined.

## Capability and grant flow

1. Validate the persisted active-Build capability contract during recovery.
2. Derive current semantic capability evidence from owned adapters/providers.
3. Issue the exact grant for the requested operation and canonical access roots/modes.
4. Select Full (`unconfined_explicit_full`) or a strict provider capable of satisfying that grant.
5. A strict provider returns an owned plan bound to its attested provider/lease; there is no native fallback under a strict claim.
6. Durable enforcement/recovery projection reports active, revoked, blocked, selection-blocked, cleaned, or explicit Full state without upgrading partial/unverified facts to confinement.

## Output, durable state, and packaging

Streaming output uses bounded queues/provider windows and durable evidence. Loss is explicit (`evidenceLossy`) rather than inferred away. Spill, lease, grant, process, and recovery state belongs to the runtime cleanup graph and is reconciled before readiness after restart.

The published archive contains the complete platform-neutral `src`, skills, and portable `bin` helper. Platform-specific behavior is chosen at runtime; packaging does not select a product variant. `runner-v2/package.json` is authoritative for the Node engine range and installed command contract. Package-parity tests build and extract the archive and execute the packaged entrypoint, so source-tree success alone is insufficient.

