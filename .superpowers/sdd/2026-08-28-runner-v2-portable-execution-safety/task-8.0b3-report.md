# Task 8.0B3 Execution Report

Status: PHASE BLOCKED — GENUINE USER DECISION REQUIRED (2026-09-05). The five-round repair budget is exhausted and final real integration is non-green; no verified B3/P6 exit.

Entry revision: `4bf64cf398a2f8d57b464182efbc2aa492dee78d`

Canonical authority:

- `docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md`
- `task-8.0b-brief.md`
- `task-8.0b3-brief.md`

Node support remains exactly `>=22.13.0 <23 || >=24.0.0 <25`. Windows Job
Objects remain an optional stronger adapter. The portable process baseline is
still mandatory, and no universal two-second build, task, command, or model
deadline was introduced.

Owner decision recorded 2026-09-01: Runner uses explicit lifecycle ownership,
never process-name/PID adoption. A command-based stdio MCP server launched for a
Build is owned, observed, and completely cleaned by that Build. With no active
owning Build, its truthful status is `stopped`; active runs project their actual
manager status. A future externally managed endpoint is connect/disconnect-only
and Runner must never signal, restart, or terminate its host process. This is the
sole B3 public MCP lifecycle/status exception; richer external endpoint, restart,
tool, and close semantics remain assigned to Task 8.2.

## Requirement audit

This table describes implementation and the historical September 2 evidence;
the September 5 repair/review section below supersedes its closure assessment.
In particular, historical green tests do not resolve the newly exposed gaps.

| Requirement owner | Implemented contract | Historical evidence (2026-09-02) |
| --- | --- | --- |
| B3.1 strict OCI interactive attach | `interactiveAttach` is separately attested by an owned disposable container and an exact semantic duplex round trip, not by help text. MCP/LSP-class OCI acquisition requires `create --interactive` and exact `start --attach --interactive <id>`. Strict selection checks interactive support and image executable availability before the owned workload container is created. It rejects absolute host executables, never bind-mounts them as a substitute for image availability, and never falls back to native while claiming confinement. | Affected ExecutionHost/MCP/OCI/streaming group GREEN 51/51. Configured real Docker proved exact JSON duplex, cancellation, external disappearance, forced cleanup, immutable image identity, no host executable mount, and zero labelled containers. |
| B3.2 one host kernel and isolated run bindings | The CLI creates one nonspawning `ExecutionHost` after validated project/state/artifact roots. It owns the filtered ambient environment snapshot, shared low-level managed/Job host, backend construction, output factories, durable subprocess/streaming kernels, and per-run bindings. Each binding creates distinct grants, `SessionAuthority`, queues, state databases, output roots, isolation leases, and cleanup authority. The production streaming graph is owned by `ExecutionHost`; the test harness is only a thin caller. Recovery observes durable state without relaunching. Partial binding construction unwinds every acquired resource in reverse order while preserving the primary failure. | Focused construction-unwind, production-composition, real crash, persistent-output, and concurrent-run guards are GREEN. The real concurrent-run fixture launches both runs together, rejects a cross-run grant, proves output separation, closes one run without affecting the other, and leaves no active binding. B1/B2 compatibility and the full package gate are GREEN. |
| B3.3 closed internal principals and construction order | `RunnerInternalExecutionContext` gives Git preflight and MCP discovery distinct `runner_internal` principals and call identities, filtered environments, purpose-specific bounds, and closed results. Its portable host-owned process kernel retains fast-child output, owns detached descendants, bounds MCP lines while bytes arrive, launches only the re-attested executable, and derives collision-resistant run-state segments. Static MCP/LSP attestation spawns nothing. Per-run discovery permits only initialize, initialized notification, and `tools/list`; records config/executable/schema digests; exposes no tool-call, manager, or channel method; cannot be reused; and closes before the public per-run manager starts. Production order is host, bounded Git, static attestation, run binding/recovery, bounded discovery, public capabilities/facades, then provider models and actor registries. | Git/MCP/streaming affected group GREEN 94/94; complete CLI capability/startup and exact production-composition guards are GREEN. The MCP fixture records exactly the three allowed methods and proves the discovery process and every detached descendant have exited. |
| B3.4 real integration and closure | A real Runner-host crash after backend launch but before transfer acknowledgement executes through the production `ExecutionHost` graph, recovers to exactly one cleanup transition, releases the lease once, creates no adopted session, and leaves no backend endpoint. A real persistent child emits beyond the memory tail across separately authorized calls; unauthorized intervals deliver nothing; exact bytes survive spill-open failure; terminal evidence reports the loss truthfully. Real concurrent runs and strict Docker are exercised. The public MCP status surface is backed by the actual per-run manager lifecycle rather than a permanent synthetic value. | Historical September 2 full Runner/package gate: 1,485 total, 1,484 passed, zero failed, one expected POSIX-native skip on Windows. This is not a current B3 exit; newly exposed cleanup and MCP gaps require the fresh evidence recorded below. |

## Production construction and ownership

1. CLI validates the Node line, roots, configuration, state root, and artifact
   root.
2. It creates exactly one `ExecutionHost` and one closed
   `RunnerInternalExecutionContext`.
3. The internal Git principal performs bounded preflight; Git absence still
   stops before model construction.
4. MCP configuration and LSP executable identities are attested without
   spawning a public server.
5. Each active run binds to the host using only its permission profile,
   capability contract, grant authority, isolation selector, and session
   authority; durable recovery runs before new discovery.
6. The ephemeral discovery principal initializes, lists tools, persists only
   bounded digests/schema facts, and closes.
7. Public per-run MCP/LSP/managed capabilities are then constructed with their
   existing behavior.
8. Provider models, Architect, worker, verifier, and subagent routing are
   constructed last.

Construction failure cleanup remains reverse-ordered and aggregate-preserving.
The CLI closes internal execution before the host, and the host closes every
run binding before its optional low-level managed/Job host.

## RED, revert, and GREEN ledger

The following guards were first exercised against the pre-change or a narrowly
fault-injected implementation, produced the intended RED, were restored, and
then passed their exact and affected gates:

1. Strict OCI capability/plan guards were RED when interactive create/start
   support was absent and when `--interactive` was removed; restoration proved
   fail-before-owned-create and exact duplex GREEN.
2. The real Docker cancellation/disappearance fixture was RED when labelled
   cleanup was suppressed; restoration left zero owned containers.
3. The persistent-output fixture was RED when a retained protocol frame was
   dropped/short-read and when private spill creation was faulted without
   truthful loss handling; exact byte delivery and lossy evidence are GREEN.
4. Pre-adoption recovery was RED when an exact trailing retained frame was
   rejected instead of being evidence-only consumed; the narrow
   pre-adoption-only suffix attestation is GREEN while adopted recovery retains
   exact-window enforcement.
5. Adopted takeover/recovery was RED when the session/output fence relationship
   was weakened; atomic dual-fence takeover, current non-one fence propagation,
   and stale-operation rejection are GREEN.
6. Durable backend identity coverage was RED at the historical small opaque
   identity bound; a bounded path-sized 64 KiB opaque identity is GREEN and
   oversized input remains rejected.
7. The production CLI ordering test was RED when changed active extension
   syntax was parsed before the existing capability-contract mismatch gate;
   behavior-neutral static MCP/LSP relocation restored the established failure
   order and the complete CLI module is GREEN.
8. The former static two-second Windows/POSIX inspection assertions became RED
   after the purpose-specific 15-second membership safety ceiling was adopted;
   exact affected tests were updated and GREEN. Adaptive startup and control
   tests prove host slowness is handled without imposing a build/task deadline.

The first independent whole-diff review then rejected closure with zero
Critical and nine Important findings. Each was assigned one focused guard,
proved RED against the vulnerable behavior, repaired, and proved GREEN before
the affected groups and broad gate were rerun:

1. Git preflight could report cleanup verified while a detached descendant was
   alive. The closed internal process kernel now owns the exact tree and proves
   stable emptiness before releasing it.
2. MCP discovery attested one executable identity but launched a shell command.
   It now directly launches the freshly re-attested executable and arguments.
3. Raw MCP run IDs could collide in durable paths. All internal run state now
   uses the canonical collision-resistant run-state segment.
4. An oversized MCP response line could be fully buffered before rejection.
   The byte stream is now bounded incrementally at one MiB.
5. The public MCP status was permanently synthetic `stopped`. A shared live
   registry now reflects the actual per-run manager from start through close and
   deterministically aggregates concurrent run status.
6. Strict OCI accepted a bind-mounted absolute host executable. It now rejects
   host executable paths and probes every strict executable inside the immutable
   image before workload creation.
7. OCI interactive support was inferred from CLI help. A labelled disposable
   container must now complete the exact create/start duplex token round trip;
   probe cleanup and absence are verified.
8. A run-binding construction fault could leak the already-open subprocess
   SQLite store. A local reverse-order cleanup stack now closes stores, revokes
   grants, and recovers isolation while preserving the primary error.
9. The production streaming graph was stubbed while integration tests exercised
   a bespoke harness. `ExecutionHost` now owns the real graph and the harness is
   only a convenience wrapper around that production API.

The same repair pass exposed one additional fast-child race: a child could exit
before its output sink was registered, causing Git preflight to observe empty
output. Output acknowledgement now waits for sink readiness. The exact guard was
RED with a false `git_missing` result and is GREEN after the repair.

The next independent whole-diff review reported zero Critical and four Important
findings. All four are now closed with focused RED/GREEN evidence or the exact
owner decision required by the canonical conflict:

1. Internal process, discovery, context, run-binding, and host cleanup retain
   failed ownership and retry one-shot cleanup faults instead of caching a
   rejected promise or deleting live ownership membership.
2. A channel-acquisition failure whose immediate cleanup also fails now retains
   one kernel-owned cleanup-only authority and reports both failures.
3. Existing shell-form MCP commands remain behavior-compatible through an exact
   Runner-owned Node launcher which delegates to Node's established `shell:true`
   contract while the launcher executable and immutable arguments are reattested.

The focused guard group is GREEN 17/17, Runner typecheck is GREEN, targeted
ESLint is GREEN, and diff check is GREEN. The reviewer-created stopped root
`runner-internal-line-bound-BPQPqF` was removed only after its exact stopped
state, ordinary Temp-directory identity, and four absent recorded PIDs were
verified.

The fourth finding exposed a canonical requirement conflict. B3 requires MCP
servers and public facades to be owned per run, but the entry behavior used one
eager global manager that reported servers ready even when no Build was active.
The owner resolved this on 2026-09-01 in favor of explicit lifecycle ownership:
idle is truthfully `stopped`, active runs project their live manager state, and
Runner never adopts or terminates a pre-existing process. The parent and packet
briefs now record this narrow exception; broader Task 8.2 ownership is unchanged.

The first current broad rerun then exposed a file-level timeout in the internal
execution-context tests. Repeated exact runs reproduced the real line-bound
cleanup assertion: four real-process tests had overridden the production
adaptive 15-second cleanup ceiling with an artificial fixed five-second test
budget. That test-only limit contradicted the approved slow-host policy. The
guard was RED at five seconds, the overrides were restored to the production
15-second ceiling, and five consecutive complete file repetitions passed 40/40.
The second current broad gate passed.

The latest affected rerun then exposed one lifecycle race in the dead-target
guard. Once a launcher had exited, the guard discarded every queued control,
including the required `force_terminate` request for detached descendants. The
new force-only exception was RED with a live MCP descendant and GREEN after
the exact cleanup path was restored. The internal execution-context file is
now GREEN 8/8 and the complete execution/internal group is GREEN 109/109.
The Git tree assertions were also aligned with the production adaptive
15-second membership-inspection ceiling: the former five-second test-only
budget was RED on this host, and the exact Git file is now GREEN 6/6.

The post-gate residue audit found a further Windows ownership hazard in an old
semantic-probe record. Windows retained `ParentProcessId` values after PID reuse,
so a Battle.net Agent process and its console host, both born on 2026-08-31,
appeared below a Runner process born on 2026-09-01. The old supervisor had
accepted that temporally impossible edge, and recursive `taskkill /T` could have
repeated the same PID-only mistake. Two new guards were independently RED: one
showed adoption of a child born before its exact alleged parent; the other showed
recursive task-tree termination. The repaired supervisor traverses only
birth-consistent parent edges, orders exact known members leaf-first, reattests
each member immediately before control, and signals only that PID without `/T`.
Both exact guards are GREEN. The full Windows contract is GREEN 84/84, semantic
probe contracts are GREEN 27/27, and the wider process-impact group is GREEN
with 83 passes plus one expected POSIX-only skip.

## 2026-09-05 cleanup repair and review resumption

The independent whole-diff review resumed and completed; the September 2
usage-limit block is no longer an active owner decision. B3 is only packet 8.0B3 within P6,
not the P6 exit gate. Its verified exit unlocks 8.1 Git, followed by 8.2 MCP,
8.3 LSP, 8.4 managed processes and the remaining Tasks 9–12. P6.5 remains locked
until the entire P6 gate is verified.

The earlier manual cleanup of four sink/ack-failure supervisors was not proof
that those fixtures or production cleanup were correct. Both tests swallowed
recovery errors and removed their roots while a supervisor remained alive.
Strengthened real-host assertions now require same-adapter replay of `held`,
successful release, and supervisor absence before deleting evidence. If this
path fails, an exact-owner fresh adapter performs fixture cleanup without
masking the original failure; failed cleanup retains the root.

Root cause: a refused release left the adapter's release-pending latch set,
blocking the output acknowledgement needed to reach a releasable terminal.
The host now classifies its existing exact-empty/retained-output condition
before attempting release. Only that typed refusal reopens the control lane;
generic uncertain release errors remain closed and existing fence checks remain.

Evidence so far:

- Strengthened real sink/ack recovery tests: RED 2/2 against the unfixed code,
  both reporting `Windows Job control was requested while release is pending`.
- Minimal repair plus adjacent release serialization/error checks: GREEN 7/7.
- Adversarial removal of the typed latch reset: RED 2/2 for the same reason;
  mutation reverted. Full affected Windows backend gate GREEN 84/84.
- Downstream backend contracts, host semantic probes, streaming runtime,
  ExecutionHost, and real streaming integration group: GREEN 91/91.
- Fresh Runner typecheck and scoped host/backend/test ESLint: exit 0.
- Shared owned-fence lock primitive is unchanged against HEAD; its full core
  contract group is freshly GREEN 33/33 (8,144 ms), including real holder crash,
  live contention, birth reuse, aliases/sidecars, and forged schema refusal.
  This does not substitute for the new OCI/projection caller regressions.
- Post-test inventory: no current-worktree live managed/portable supervisors;
  no sink/ack-failure temporary roots remain.
- The fresh-adapter fallback drained and released the exact test processes on
  both RED runs; neither RED run suppressed recovery errors or deleted live
  supervisor evidence.

Independent review finished with zero Critical and four Important findings:
canonical host MCP executable paths cannot be used as strict
image-relative commands; settled Build cleanup omits the new run-owned MCP/host
resources; post-ready MCP terminal/protocol failure does not reliably trigger
verified cleanup or truthful status; anonymous OCI/projection state locks can
remain permanently stale after a crash. These are not green and B3 is not closed.
The third whole-diff review repair wave is assigned under
`task-8.0b3-sep5-review-fix-brief.md`; evidence belongs in its matching report.

Wave progress: F1 strict MCP and F4 state coordination are implemented with
worker-reported RED/mutation/revert/GREEN evidence (real strict MCP 1/1; caller
coordination 3/3). The controller independently ran the full isolation-provider,
OCI-provider, and coordination-caller group: GREEN 70/70, zero skipped/failed,
43,994 ms, including actual Docker and cross-process concurrent state writes.
F2 settled Build cleanup and F3 post-ready MCP failure cleanup are still active;
these partial results are not a B3 exit or independent fix-wave approval.

Current validation host: Node v24.18.0 installed, Git 2.53.0.windows.1,
Linux Docker engine 29.7.2. Installed Node is an environment fact, not a package
requirement: `.node-version` remains `24` and root/Runner/lock engine declarations
remain `>=22.13.0 <23 || >=24.0.0 <25`. Local node:24-slim and alpine:latest images
are available; no image download is required for the new strict fixture.

## Historical validation evidence (2026-09-02)

These results describe the September 2 code snapshot, not the later cleanup
repair. Reuse requires impact analysis; fresh affected gates are recorded above.

Focused and affected checks:

- ExecutionHost, real streaming integration, native capabilities, and strict
  OCI integration: 46/46 GREEN, including configured real Docker.
- Git/MCP/streaming affected group: 109/109 GREEN.
- Current Windows process-backend contract: 84/84 GREEN, including temporal
  parent-edge rejection and exact-member nonrecursive control.
- Current process-host semantic probes: 27/27 GREEN.
- Current wider execution/process impact group: 84 total, 83 passed, zero
  failed, one expected POSIX-native skip on Windows.
- Exact run-binding construction-unwind, fast-child output, live MCP production
  composition, NativeBuild lifecycle, and CLI lifecycle guards: GREEN.
- Real Docker strict interactive execution, cancellation, disappearance,
  recovery, and exact owned-container cleanup: GREEN and applicable.

Current broad gate after every implementation and review repair:

- `npm run test:runner-v2`: exit 0; 1,485 total, 1,484 passed, zero failed,
  cancelled, or todo, one expected POSIX-native skip on Windows; duration
  1,106,649.1575 ms.
- Every chained Runner client and native Build policy, policy UI, cutover,
  pause-gate, model-usage, live-state, transcript, files, run-stats, steering,
  and observability contract passed.
- Fresh post-gate Runner typecheck: GREEN.
- Fresh whole-repository ESLint: GREEN.
- Fresh `git diff --check`: GREEN; only non-failing LF/CRLF notices were
  emitted.
- Exact Node-range audit in root package, Runner package, and package lock:
  `>=22.13.0 <23 || >=24.0.0 <25`; `.node-version` selects the maintained
  Node 24 line without an exact patch pin.
- Added-line audit found no mandatory Job Object path, no Windows-only product
  requirement, and no new universal two-second deadline.

## Residue, cleanup, and preserved uncertainty

The post-gate inventory found zero live portable supervisors,
persistent-output/stream fixtures, streaming crash hosts, Git/MCP helpers, or
other matching Runner children after exact cleanup. The Docker query for
`label=ai-board.runner-v2.owned=true` returned empty. The inventory briefly
found six orphaned, positively identified test supervisors (one portable tree
with its exact launcher/child and four managed supervisors whose temporary
roots had already disappeared); each exact current-worktree PID was stopped
without recursive signalling, and the two portable descendants exited with
their supervisor. A final inventory again found zero matching helpers and zero
Runner-owned containers.

Nine positively identified disposable B3 test roots were removed after exact
Temp-parent, closed-prefix, real-directory, process-absence, and (for the one
nonempty ExecutionHost root) empty-durable-table validation. No removed path
remains.

Four additional review-repair roots were classified and removed under the same
rules. The construction-unwind subprocess database contained zero durable
process rows; the MCP result recorded `cleanupVerified: true`; the detached-tree
state recorded `stopped`; all five recorded PID/birth identities were absent;
and every target was an ordinary non-reparse Temp directory. The exact removed
roots were `runner-execution-host-78Ta02`, `runner-internal-tree-vPNHp0`,
`runner-internal-tree-ez8VAE`, and `runner-internal-tree-L77vje`.

Two roots created by failed cleanup-budget diagnosis runs,
`runner-internal-tree-VI2RJr` and `runner-internal-tree-BLeHBt`, were removed
only after each was resolved as an ordinary Temp directory, its durable state
reported stopped, and every recorded PID was absent. The diagnostic
instrumentation used to identify the test-only five-second ceiling was reverted.

Seven earlier RED/debug roots are deliberately preserved because their durable
state is `outcome_unknown` or still says `running`; current process absence does
not rewrite that historical authority:

- `C:\Users\b_a_s\AppData\Local\Temp\runner-b3-real-crash-7jdMl5`
- `C:\Users\b_a_s\AppData\Local\Temp\runner-b3-real-crash-B7zVl0`
- `C:\Users\b_a_s\AppData\Local\Temp\runner-b3-real-crash-GszJUc`
- `C:\Users\b_a_s\AppData\Local\Temp\runner-b3-real-crash-iN6BUt`
- `C:\Users\b_a_s\AppData\Local\Temp\runner-b3-real-output-f9SfGo`
- `C:\Users\b_a_s\AppData\Local\Temp\runner-b3-real-output-MWZPXr`
- `C:\Users\b_a_s\AppData\Local\Temp\runner-b3-real-output-Rc4qlt`

The twenty B2-exit historical roots also remain preserved. Two additional
B3-period semantic-probe evidence roots are preserved
(`aiboard-windows-semantic-duplex-auXthf` and
`aiboard-windows-semantic-tree-i5PbEt`). Across these two and the seven earlier
B3 RED/debug roots there are 39 recorded PID/birth identities. Thirty-seven are
absent. The two present exact identities in the duplex evidence are the
Battle.net Agent and its console host described above; both predate their alleged
Runner parent and are therefore positive non-ownership evidence, not Runner
residue. Their processes were not signalled. No live Runner helper or supervisor
exists, no uncertain or historical evidence was deleted, and current live owned
process, endpoint, spill, state, and container residue is zero.

Three additional current-day portable published-input roots are preserved as
uncertain evidence because their durable records are `outcome_unknown` or
`running`: `aiboard-portable-published-stale-input-OwEHtU`,
`aiboard-portable-published-stale-input-LWPXOE`, and
`aiboard-portable-published-stale-input-XscHBu`. Their nine recorded
PID/birth identities are absent after exact post-gate cleanup; the LWPXOE
supervisor and its launcher/child were explicitly re-attested and stopped,
but its durable record remains `running` and was not rewritten. None of these
uncertain roots was deleted.

## Scope, recovery, and rollback

- No 8.1 Git runner/hardening, richer 8.2 MCP protocol/external-endpoint/restart/
  tool/close redesign, 8.3 LSP lifecycle migration, 8.4 managed-process behavior
  migration, Task 10–12, P6 benchmark, or P7 real-world build was added.
- Existing public LSP/managed behavior and MCP protocol/tool behavior is
  relocated per run without a new protocol, retry policy, fallback, or
  completion authority. The sole public behavior change is the owner-authorized
  truthful MCP ownership/status projection described above.
- Streaming and backend durable additions are backward-safe: new attestation
  fields are optional to historical readers; active incompatible safety
  contracts still fail closed; larger opaque identity support remains bounded.
- Recovery observes/adopts exact durable identities and never relaunches. An
  unavailable or ambiguous host remains typed unavailable/unknown and retains
  evidence.
- Source rollback is the coherent B3 source/test/report diff from the entry
  revision. Runtime rollback closes the run binding, internal context, and host
  in reverse order; only positively owned fixture state is removable. Uncertain
  evidence remains preserved for later governed recovery or audit.

## Exit gate

### September 5 current security and residue audit (supersedes earlier snapshots)

- A critical shared credential-name filter gap was discovered during residue
  inspection: provider-prefixed API-key names were not recognized, allowing a
  credential into encoded supervisor launch metadata. A diagnostic command
  exposed that encoded metadata. No credential value is reproduced here; no
  external use was observed. The user was advised to rotate the affected
  credential. F5 is assigned to the current governed review-fix wave alongside
  F1–F4, with synthetic RED/GREEN and actual process-graph verification required.
- F5 actual process-graph guard is now verified on this Windows host using the
  portable backend (Job enhancement unavailable). Safe ambient OS values plus
  synthetic-only prefixed credentials traverse the real host/run/grant/command
  path. The test inspects child environment facts and privately decodes only
  the supervisor argv matching its durable nonce/directory. No raw environment
  or argv is emitted, including inspector exceptions. An isolated loader
  removed the predicate's two added recognition branches only in that test
  process: RED 1/1 showed both child-environment and supervisor-metadata leak
  booleans. Shared sources were never mutated; loaders were removed. Restored
  graph/environment/redaction/host/one-shot checks were GREEN 50/50 (17.654s).
  Final cleanup/diagnostic strengthening reran the graph GREEN 1/1 (3.546s).
  It requires exit zero, verified-empty cleanup and both PIDs absent before
  removing its own root. No credential-graph roots remain. POSIX test code is
  present but was not exercised on this Windows host. External rotation remains
  a user action, not something these code tests can accomplish or verify.
- Independent F5 review additionally found the internal Git/discovery snapshot
  still used an older filter that missed private-key components. The same real
  graph fixture was extended through actual static attestation and ephemeral
  MCP discovery on the host-owned internal kernel. It reproduced both leak
  booleans RED 1/1 before repair. `filteredInternalEnvironment` now also uses
  the shared sensitive-key predicate, preserving its older broader exclusions.
  The identical snapshot feeds bounded Git preflight. Graph, internal-context
  and Git-preflight checks passed 16/16 (52.973s). An isolated loader then
  removed only this new predicate call: intended RED 1/1 again (6.646s), with
  both leak booleans true. Loader removed; final normal+discovery graph passed
  2/2 (9.626s). No shared source mutation or live credential was used during
  either fault injection. Independent re-review of this exact internal fix
  reported no new actionable finding; full B3 verdict remains pending F2/F3.
- Four obsolete F1 strict fixtures were recovered through their authenticated
  session backend identities and current durable fences. Retained output
  (168 bytes each) was persisted before acknowledgement, terminal emptiness was
  proven, and backend ownership was released. Their durable streaming session
  records remain `cleanup_blocked`; no semantic state was fabricated.
  Supervisors 62052, 8576, 56896 and 36644 were absent in the post-recovery census.
- Two obsolete F2 fixtures were recovered using the authenticated Job host:
  `aiboard-native-capabilities-execution-host-mcp-order-IpdJOw` and
  `aiboard-native-capabilities-execution-host-mcp-order-RRupCi`. Both returned
  stopped/ownershipReleased, and all recorded children/supervisors were absent.
- Docker's Runner-owned container inventory was empty at this checkpoint.
  The ten exact temporary test roots remain on disk because the tool policy
  rejected removal. This is disclosed retained test state, not a successful
  empty-directory cleanup. Historical uncertain roots were untouched.
  The eight strict roots are state/identity pairs: `zrQZI9`/`zshGxu`,
  `SD2ND5`/`fAGuwp`, `oV2E6y`/`neoPE4`, `BItVG8`/`WPsmvI`, under the ordinary
  Temp prefixes `aiboard-mcp-strict-state-`/`aiboard-mcp-strict-identity-`.
  The one-off recovery script was removed after use.
- A later F3 race fixture is preserved as uncertain evidence:
  `aiboard-mcp-owned-state-hvzcWm` and
  `aiboard-mcp-post-ready-oversized-line-N0O3BK`. Parent inspected its authenticated
  `mcp-owned-test-2` session (`cleanup_pending`) and exact backend directory
  `owned-d894786d-7574-45ba-84bd-9e5411105ebd` (`outcome_unknown`). Supervisor
  33692 and every recorded descendant PID were absent in the current census.
  Retained stdout/ACK records 5–7 remain. Supported recovery refused to release
  an exited supervisor's uncertain state; no state was fabricated, no PID was
  signalled, and no evidence was deleted. This is not verified release. Other
  F3 failure roots remain the executor's responsibility and require its ledger.
- Five additional F3 diagnosis fixtures were explicitly handed to the parent
  for exact recovery: state/project suffix pairs `LLDVAY`/`F66Arq`,
  `2V9g0s`/`oYpRzq`, `tlSmf7`/`8BXzoZ`, `G56Gxu`/`WmqdRu`,
  `cZUG7X`/`ZV0x3e`, using the same MCP state/oversized-project prefixes.
  All five now have verified backend-empty proof and released backend ownership.
  Retained replay was persisted before acknowledgement (49,152; 16,385; 32,769;
  16,385; 16,385 bytes respectively). G56Gxu needed one exact retry after a
  fenced-effect refusal; no ownership guard was bypassed. All five supervisors
  and recorded descendants were absent in the post-recovery census. The ten
  state/project folders remain; no deletion workaround was attempted after the
  earlier tool-policy rejection. Durable session states were not fabricated as
  released. The one-off recovery helper was removed.

### September 5 completed broad sweep and wave-4 boundary

The uninterrupted Runner test process ended at 10:53:52 UTC with exit 1:
1,498 tests, 1,495 passed, two failed, one expected platform skip, zero
cancelled, duration 1,334.463 seconds. Chained client/Build scripts did not run.
The two failures are:

- CLI per-run MCP cleanup after active extension startup failure: EBUSY removing
  `aiboard-cli-capability-recovery-snapshot-start-B5XQcp/project`. The failing
  finally masked the primary error and removed cleanup records while the exact
  supervisor/descendant chain remained live. PIDs 57560, 44196, and 52328 were
  recorded with creation times/root association privately. Exceptional recovery
  approval was requested; there is no approval yet and no signal was issued.
- Real persistent output/spill failure: `real-streaming-integration.test.ts:223`
  expected `evidenceLossy === true`, observed false. Cleanup's newly finalized
  tee overwrote the original session evidence. This is not a passing spill gate.

The final scoped reviewer reports zero Critical and three Important findings:
failed intake awaiting its own channel detach; continuous output starving MCP
close before force-capable cleanup; and CLI fixture deletion without verified
release. F1/F2/F4/F5 are independently clear. Wave 4 of the five-wave budget
owns these findings plus continuous evidence preservation (R4.1–R4.4). The
broad-sweep production freeze is lifted; exact failed and affected checks are
required before the next broader gate. See `task-8.0b3-review-wave-4-brief.md`.

The controller subsequently ran the twelve skipped chained client/Build scripts
independently: client, policy, policy UI, cutover, pause gates, model usage,
live state, transcript panel, files, run statistics, steering UI, observability.
All passed (7.754 seconds). This is current browser/contract evidence only;
it does not turn the failed Runner sweep or pending cleanup repairs green.

R4.3 parent-owned safe fixture repair: three synthetic real-file regressions
launched no processes. The extracted unconditional finalizer was RED 0/3
(651.568ms): it deleted authority, hid primary diagnostics, and skipped cleanup
verification. The new finalizer verifies first, aggregates primary/cleanup
failures, preserves all evidence on any primary failure, and deletes only on
success. GREEN 3/3; removing both material guards reproduced RED 0/3
(628.923ms), reverted and GREEN 3/3 (593.103ms); scoped ESLint passed. The real
CLI fixture now also requires authenticated read-only released session/launch
evidence, both marker PIDs absent twice, and empty exact portable backend
directories. Its live regression is pending the R4.4 stable runtime boundary.
Independent scoped R4.3 review returned zero Critical/Important findings. It
clears the fixture-preservation change only; no live process tests were run by
the reviewer and no B3 approval was issued.

The real CLI regression subsequently passed 1/1 (23.637s); its authenticated
read-only release/handoff, repeated process absence and empty backend-directory
checks all passed, and its fresh root was removed. Wave-4 configured Runner
typecheck and scoped lint passed. The controller's 25-file impacted graph gate
is running on source-stable code; no broader green claim is made yet.

Additional check: root `tsc --noEmit --incremental false` is RED with Next's
required `ProcessEnv.NODE_ENV` augmentation conflicting with Runner environment
maps and dependent spawn overloads. Errors are in OCI provider, LSP tests,
portable channel tests and capability-contract tests, not wave-4 changed lines.
The OCI environment declaration also exists unchanged in HEAD, but no complete
baseline root compilation was performed. Track this non-critical cross-project
type configuration finding under Task 12 packaging/CI; do not expand active B3
teardown repairs or claim the root/app typecheck is green. The configured
Runner-only typecheck remains independently green.

### Wave 5 and final bounded verification

Wave 4's 25-file impacted graph passed 399/399, zero failed/cancelled/skipped,
in 466.914 seconds. It covered spool/output/checkpoint/session, real streaming,
ExecutionHost and credential graph, MCP, internal execution, Git preflight,
CLI and native Build/factory consumers. Wave 4 review found one remaining
Important setup-readiness defect despite that green gate. The fifth and final
governed repair round fixed only that defect; see its brief and report.

Wave 5's failed-subscription retry regression was RED before repair and under
an isolated final-source guard removal, then restored GREEN. Runtime/output
contracts passed 71/71. Independent final fix-only review reports zero Critical
and zero Important findings across the reviewed B3 changes. Parent's configured
Runner typecheck and scoped lint on final sources passed. Selected final-source
real CLI/MCP/persistent-output integration finished non-green as recorded below.
The earlier 399-test gate is reused only for unaffected branches;
changed setup/retry behavior has fresh regression and runtime coverage.

Final census additionally found two pre-wave-4 F2 roots, `KicXnJ` and `IkFb7b`,
under `aiboard-native-capabilities-execution-host-mcp-order-`. Unlike the CLI
orphan, both retained exact authenticated Job records. Parent verified record,
run/session owner, current fence and recorded start identity, then stopped and
released through the authenticated host. Records were respectively
`process_776b7ddb-1506-4939-946e-505389f28ec8` (supervisor 23884) and
`process_6a741d2b-8b15-4712-87ae-e4495fdcb950` (supervisor 42620), both owned by
`execution_host_mcp_order_other`. Both returned stopped/ownershipReleased.
All twelve known current/former children, launchers and supervisors were absent
in the post-recovery census. These two roots remain as diagnostic evidence;
no directory deletion was attempted and no durable session history was rewritten.
The one-off recovery helper was removed. This was not PID-only signalling.

The original CLI chain 57560 -> 44196 -> 52328 remains live with its original
September 5 creation times, and untouched pending exceptional recovery approval.
It is the current genuine owner-decision blocker; no supported authentication
record can be fabricated to bypass it. No B3/P6 verified exit is issued.

### Final non-green integration and governed stop

Final-source selected integration: seven tests, five passed, two failed, zero
cancelled/skipped, 137.649 seconds, exit 1. Passed: CLI startup-failure cleanup,
strict public MCP, public MCP tree cleanup, post-ready self-exit, and the new
subscription-failure retry regression. Failed:

- Post-ready oversized response: 36.874 seconds. Child absence was observed,
  but the session stayed `cleanup_pending`; finalizer could not verify cleanup
  and preserved `aiboard-mcp-owned-state-mczgg7` plus project
  `aiboard-mcp-post-ready-oversized-line-7I2ZYu`.
- Real persistent output: 37.571 seconds. Initial authorized stop returned
  `cleanup_blocked` before evidence assertions. Its authenticated finalizer
  cleaned the fixture; no real-output root remains. This is not a passing stop.

Read-only authenticated inspection of the retained MCP streaming store found
session history pending_transfer -> active -> backend_unavailable ->
cleanup_pending; output active, zero accepted and seven consumed stdout chunks;
host launch handed_off. Its exact backend directory
`owned-302ee699-5b32-4ccf-8c41-967537335246` records `outcome_unknown` and an error
containing the fixed message `Portable fence is stale at the effect boundary.`
Supervisor 51324 and all recorded PIDs 60392, 39464, 55400 were absent. Retained
output/ACK files 5–7 remain; their ACKs match current owner and fencing token 2.
No raw environment, argv, payload, token or full error graph was emitted.
No state was rewritten as released and no uncertain record was deleted. This
narrows one failure to the supervisor's stale-effect-fence path; the precise
interleaving is not yet proven, nor is the persistent-output failure assumed to
have the same cause without its evidence.

The authoritative UTC-normalized post-test Temp census found only these two
new diagnostic roots since the completed broad sweep. Earlier provisional
cutoffs mixed local and UTC DateTime values; they are superseded by this final
census. Runner-owned Docker inventory is empty. The old recordless CLI chain
57560 -> 44196 -> 52328 remains separately live and untouched. The one-off
read-only inspection helper was removed.

Wave 5's code re-review was zero Critical/Important, but mechanical integration
is mandatory and overrides any completion inference from that review. No sixth
repair round was started. Genuine decisions: extend the exhausted repair budget
for the retained stale-fence/cleanup investigation; separately approve narrowly
identity-reverified exceptional termination of the old recordless CLI chain.
The root/app typecheck issue remains recorded for Task 12, not silently green.

PHASE BLOCKED — GENUINE USER DECISION REQUIRED

The September 2 usage-limit blocker is historical, not a current request for
another reset or a review waiver. Closure requires current affected evidence,
verified owned cleanup, and zero Critical/Important independent findings.
Even a successful B3 exit unlocks only 8.1 Git, not P6.5 or P7.
