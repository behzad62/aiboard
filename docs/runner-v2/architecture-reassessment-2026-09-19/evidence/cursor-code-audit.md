Auditing the Task 12 worktree against the bounded-gates docs and uncommitted diff. Gathering authoritative docs, status, and capability/lifecycle sources first.Continuing with capability schemas, OCI lifecycle, and the uncommitted POSIX/CI hunks.Shell is blocked in Ask mode; reading the modified files and capability/OCI sources directly.## Task 12 audit (worktree + dirty tree)

**Status frame (observed):** `docs/runner-v2/task-12-status.md` — Gates A–F PASS (D Darwin matrix follow-up); Gate G IN_PROGRESS. Dirty files from session snapshot: POSIX control/supervisor, channel/posix/windows/recovery tests, `late-birth-fixture.ts`, `runner-v2-qualification.yml`. Shell/git diff unavailable in Ask mode; uncommitted vs HEAD is inferred from those paths + symbols below.

---

### (1) Capability schema & who claims `tree_termination` / `verified_emptiness`

**Observed schema** (`runner-v2/src/execution-safety-contracts.ts` L4–24):

| Names | States |
|---|---|
| `tree_termination`, `crash_cleanup`, `verified_emptiness`, `write_confinement` | `enforced` \| `partial` \| `unavailable` \| `unverified` |

Selection requires **every** requested name `=== "enforced"` (`process-backend.ts` `selectProcessBackend` L342–368).

| Provider | Claims `tree_termination` / `verified_emptiness` | Other |
|---|---|---|
| `PosixProcessBackend` L18–22 | both **`enforced`** | `crash_cleanup`/`write_confinement` **unavailable** |
| `WindowsProcessBackend` L53–57 | `enforced` only if `exactTreeBirth === "verified"`; else `partial`/`unavailable` | same |
| `WindowsJobObjectProcessBackend.probe` L97–101 | both **`enforced`** | `crash_cleanup` **enforced** |
| OCI `attest()` L317–322 | both **`enforced`** | `crash_cleanup` **partial**; `write_confinement` **enforced** |
| Recovery probes | both **`unverified`** | — |

---

### (2) Requested caps & isolation by profile

**Observed requestedCapabilities** (always `tree_termination` + `verified_emptiness`, never `write_confinement` on process intent):

- One-shot: `one-shot-command-executor.ts` L163–166
- Managed: `execution-host-managed-transport.ts` L98–99
- MCP: `execution-host-mcp-transport.ts` L54–56
- LSP: `execution-host-lsp-transport.ts` L59–61
- Internal kernel: `runner-internal-process-kernel.ts` L115–117

**Isolation selection** (`execution-isolation-provider.ts` `acquire` L344–439):

| Profile | Behavior |
|---|---|
| **`full`** | `enforcement: "unconfined_explicit_full"` — **no container** |
| **`guarded` / `project`** | Same path: first qualifying OCI provider → `write_confinement_exact_grant`; else `isolation_capability_unavailable`. **No guarded-vs-project branch** in selector (`assertGrantMatches` only checks grant profile match L940–949). |

**Strict-mode constraints (observed):**

- Network: OCI `--network bridge` only if `grant.networkApproved && options.allowNetwork`; else `none` (`oci-execution-isolation-provider.ts` L394–395). Managed/LSP envelopes default `networkApproved: false`.
- FS: exact-grant bind mounts; no root mounts; workspace-contained cwd (`representGrant` L731+).
- Env: child env via handoff for non-`full`; `full` uses ambient (`one-shot-command-executor.ts` L180–225).
- LSP: refuses non-`full` without image identity (L37–38). Managed: non-`full` requires image executable (L80–82).
- Isolation `qualifies` requires `write_confinement === "enforced"` + `exactGrantWriteConfinement` (L904–919); native mechanisms rejected.

---

### (3) OCI lifecycle boundary

**Observed facts:**

- **Per-invocation lease/container**, not a shared pool: `leaseId = oci-lease-${uuid}`, unique name hash of `providerId\0runId\0invocationId\0leaseId` (L380–383); `create` then later `start --attach` (L392–410, L568–574).
- **Release = `docker rm --force`** after identity re-check (L516–530) — retires the **container namespace**, not merely the attach CLI process.
- Selector holds one active entry per `leaseId`; `release`/`cleanupLease` deletes it (L297–324, L442–444). **No reference-count.** Session transfer (`transferExecutionIsolationLeaseToSession`) moves exclusive cleanup ownership once — still one lease.
- Recovery lists labelled containers and force-removes owned ones; `cleaned_pending_ack` needs acknowledge (L577+).

**Inference:** Escaped descendants *inside* the container die with `rm --force`. Host-side native stop of the `docker` attach process alone is not the OCI retirement path; product retirement is lease `release`/`recoverOwned`. Stopping a **native** POSIX group does **not** imply OCI descendants (different backend).

---

### (4) Uncommitted POSIX escape-tracking vs hygiene

| Preserve if contract = **PGID membership** (Gate B) | Remove / park if not amending contract |
|---|---|
| `reattestOwnedPosixAnchor` / `reattestOwnedPosixDescendants` / `signalOwnedPosixGroup` / fail-closed `parsePosixGroupMembers` | **`listPosixProcessParents`**, **`parsePosixProcessParents`**, **`collectPosixDescendantPids`** (`portable-process-posix-control.mjs` L66–129; `.d.mts` L22–25) |
| Gate B force-after-anchor PGID path | **`captureOwnedPosixDescendantClosure`**, **`reattestOwnedPosixEscapedDescendants`**, **`signalOwnedPosixEscapedDescendants`**, `posixEscapedMembers` (`portable-process-supervisor.mjs` ~L304–358, L408–416, L1096–1170) |
| Live PGID descendant fixture L312+ | Test **“descendant closure retains detached descendants outside the workload group”** L941–962 |
| Legal outer guard `WINDOWS_HOST_FIXTURE_TIMEOUT_MS = 90_000` (windows test L21–23) | — |
| `late-birth-fixture.ts` StartTime probe aligning with supervisor (L44–57) | Treat as fixture hygiene, not escape contract |
| CI job split in `runner-v2-qualification.yml` (native / CLI / recovery / portable / docker) | Do not use CI edits to redefine termination semantics |

**Inference:** Escape path is an **all-descendant / out-of-PGID** expansion beyond Gate B’s “signal only owned+ready **group**” invariant (`task-12-bounded-gates.md` Gate B L75–80).

---

### (5) Contracts to preserve

| Concern | Where | Must keep |
|---|---|---|
| Fencing | Gate A status; `NativeOwnedProcessBackend.assertFence` / `fencedEffect` | Exact owner+token; never adopt fence from reread |
| Birth / ownership | Gate B; `recordOwnedPosixMembers` only while `!posixAnchorExited` (supervisor ~L292–301) | No new witnesses after real anchor exit |
| Durable ownership | opaque identity v2 + workload group; `release` L538–579 | Supervisor birth + empty + settled output + terminal stopped + final fenced re-attest |
| Output settlement | Gate E; reconcile may be `exited` on retirement while release blocked if supervisor live (L549–550) | Distinct quiescence vs release |
| Recovery/release | OCI durable lease journal; streaming isolation map; MCP recovered cleanup | No false release; blockers block replacement |

---

### (6) Tests / CI split

| Lane | Path / note |
|---|---|
| POSIX native | `posix-process-backend.test.ts` (host skip on Windows); live launcher-exit fixture L312 |
| Detached/escape **unit** | same file L941 (PPID closure); **not** the live fixture (live spawn stays in group L326) |
| Windows | `windows-process-backend.test.ts` + Job channel; outer 90s guard; late-birth support under `test/support/late-birth-fixture.ts` |
| Portable channel | separate job, concurrency=1 |
| Managed/MCP host | serial with native lifecycle |
| Docker OCI | `RUNNER_V2_REQUIRE_DOCKER=1` + oci/managed-strict/mcp-tools |
| Recovery | `recovery-smoke.test.ts` |

---

### (7) Strongest anti-simplification evidence & conflicts

**Observed conflicts:**

1. POSIX claims `tree_termination`/`verified_emptiness` **enforced**, but `emptiness()` for v2 retired→empty / else group enumeration (`native-process-backend.ts` L655–670) — **does not consult escaped PPID maps**. Escape signaling can run while release still keys off **group emptiness** → false empty / orphan survivors.
2. Gate B plan text = **group** proof before `-PGID` signal; dirty escape code adds **per-PID kill** of out-of-group ancestry — different security surface (same-UID, PPID spoofing after reparent to init).
3. Double-fork daemons with PPID=1 are **outside** both PGID and leader-descendant BFS — native “enforced” cannot mean universal tree kill.
4. OCI `tree_termination:enforced` is container-scoped via `rm --force`; native and OCI meanings diverge if treated as one universal promise.
5. Legacy `activeOwnedPids` POSIX branch (supervisor L1360–1371) still permissive `ps` parsing — status L140 already flags reuse risk.
6. Durable opaque identity / retirement records have **no escaped-member fields** — escape state is supervisor memory only → recovery/restart compatibility gap if escape becomes authoritative.

**Do not claim tests passed** (not run here).

---

### Evidence table

| ID | Path:lines / symbol | Fact class |
|---|---|---|
| E1 | `execution-safety-contracts.ts` L4–24 | Schema OBSERVED |
| E2 | `posix-process-backend.ts` L18–22 | POSIX claims OBSERVED |
| E3 | `windows-process-backend.ts` L53–57, L97–101 | Windows claims OBSERVED |
| E4 | `oci-…provider.ts` L317–322, L380–530, L394–395 | OCI claims + per-lease create/`rm --force` OBSERVED |
| E5 | `execution-isolation-provider.ts` L344–439, L904–919 | full vs guarded/project OBSERVED |
| E6 | `*-transport.ts` / `one-shot-…` requestedCapabilities | Caps OBSERVED |
| E7 | `native-process-backend.ts` L456–579, L655–670 | verifyEmpty/release/group empty OBSERVED |
| E8 | `portable-process-supervisor.mjs` L304–358, L1096–1170 | Escape control OBSERVED (dirty) |
| E9 | `portable-process-posix-control.mjs` L100–129 | Descendant BFS OBSERVED (dirty) |
| E10 | `task-12-bounded-gates.md` Gate B/E; `task-12-status.md` | Accepted PGID + settlement separation OBSERVED |
| E11 | Escape ⇒ all-descendant / empty coupling | INFERENCE |

---

### Minimum contract amendment (recommendation only)

Amend the durable safety text to: **`tree_termination` / `verified_emptiness` for native POSIX mean authenticated workload PGID membership (+ birth), not all descendants, not same-UID host daemons, not processes reparented off the owned tree.** OCI keeps **container-namespace** meaning via owned lease `rm --force`. Escaped-PGID PPID tracking is **out of scope** unless emptiness/release/durable records are upgraded together; otherwise drop the dirty escape hunks and keep Gate B group fencing. Document same-user limits and that external service daemons are never in-contract for native emptiness. Preserve opaque-identity v2 / retirement / fence / output-settlement shapes unchanged for legacy recovery.
