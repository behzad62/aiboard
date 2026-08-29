# SDD ledger — plan: docs/superpowers/plans/2026-08-28-runner-v2-portable-execution-safety.md

## Preflight evidence

- Starting revision: `c867ac08e079a242a6bd4f59e96918ccfe6d78a0`
- Worktree: `D:/repos/ai-discussion-board/.worktrees/runner-v2-robust-build`
- Branch: `codex/runner-v2-robust-build`
- Baseline product diff: clean after the plan-only commit.
- Node: `v24.18.0` (current evidence only; package policy remains maintained LTS 22/24).
- Git: `2.53.0.windows.1`.
- Docker client/daemon: `29.7.2`; Podman unavailable. Docker is optional production configuration but available for the required local OCI integration fixture.
- Baseline validation: `npm run typecheck:runner-v2` passed; `npm run test:runner-v2` passed 795/795 Runner tests plus every chained client/Build policy check in 206645 ms.
- State/temp rule: every task uses a task-owned temporary external Runner-state root and records cleanup before review.
- Execution rule: tasks are strictly serial; no overlapping implementers.

## Task ledger

| Task | Packet | Status | Base | Implementer report | Review | Fix rounds | Commit | Current evidence |
|---|---|---|---|---|---|---:|---|---|
| 1 | P6.4a contracts | verified complete | `c867ac08` | `task-1-implementer-report.md` | round 1 fixed; re-review approved | 1 | `93dcd216`, `27253f6d` | fresh reviewer: 65/65 + typecheck + diff check green; all required faults red/reverted/green |
| 2 | P6.4b environment | verified complete | `27253f6d` | `task-2-implementer-report.md` | approved after 3 fix rounds | 3 | `9ced73d4`, `cc5c1c71`, `c431d0f5`, `e4096ca0` | fresh reviewer: 8/8 + typecheck + targeted ESLint + adversarial replay green; faults red/reverted/green |
| 3 | P6.4b output | verified complete | `e4096ca0` | `task-3-implementer-report.md` | approved after 3 fix rounds | 3 | `da4dbc01`, `4e83ced7`, `8843f56c`, `802f6491` | fresh reviewer: 49/49 + typecheck + lint + adversarial attestation green; 9 total mutations red/reverted/green; zero residue |
| 4 | P6.4c runtime/store | verified complete | `802f6491` | tracked `task-4-implementer-report.md` | approved after final governed fix round | 5 | `b20d6b78`, `b7a7dd37`, `c5cb2e3a`, `ba5eeead`, `8ef96221`, `9b42e743`, evidence commits `d871df97`, `4d53078a` | fresh reviewer: 49/49 + typecheck + diff check green; expired unbound launch is durably orphaned without takeover/relaunch; stale authority rejected |
| 5 | P6.4c adapters | verified complete after carried prerequisite | `4d53078a` | `task-5-implementer-report.md`, `task-6a-prerequisite-report.md` | approved after breaker residuals closed at Task 6 entry | 5 + 3 carried fixes | `e57c2a1f`, `e29d5b8f`, `4f940cb3`, `16fca6d2`, `dfcb6a33`, `f8c1ad06`, carried `5307d1b7`, `18b97fc9`, `9c59feec`, `b997aade` | fresh re-review approved: all seven blocking effect families durably journaled, exact consumers enforced, malformed/ambiguous effects retained, authority loss fail-closed |
| 6 | P6.4d isolation/grants | verified complete after carried Task 7 entry prerequisite | `b997aade` | `task-6-implementer-report.md`, `task-7a-prerequisite-report.md` | breaker residual independently approved at Task 7 entry | 5 + 3 carried prerequisite fixes | initial `88266699`, fixes through `6be10f70`, carried `b1ea2f92`, `74e7aec3`, `04f00723`, `8eb593f0` | exact grants, truthful provider/Full selection, configured OCI, two-phase cleanup evidence, bounded durable projection, concurrency/capacity safety, real Docker and zero residue approved |
| 7 | P6.4e one-shot/evidence/verification | review round 2 fixes in progress; entry prerequisite verified | `8eb593f0` | `task-7-brief.md`, `task-7-implementer-report.md`, `task-7-review-round-1.md`, `task-7-review-round-2.md` | round 2 rejected with two Important findings | 2 feature review rounds | initial `560a061f`, round-1 fix `9671af07` | close OCI deletion-fault ownership, enter the real family boundaries in the production matrix, and eliminate native aggregate interference |
| 8 | P6.4e remaining child families | blocked by 7 | — | — | — | 0 | — | — |
| 9 | P6.4f Git hardening | blocked by 8 | — | — | — | 0 | — | — |
| 10 | P6.4g filesystem fence | blocked by 9 (serial doctrine) | — | — | — | 0 | — | — |
| 11 | P6.4h recovery/disclosure | blocked by 10 | — | — | — | 0 | — | — |
| 12 | P6.4i final gate | blocked by 11 | — | — | — | 0 | — | — |

## Dependency and conflict preflight

All conflicts resolve by strict numeric serialization. “Interface” means a task
consumes or changes a contract owned by the earlier task even when no direct file
overlap is expected.

| Task or pair | Shared file/interface | Resolution |
|---|---|---|
| 1 | Capability contract, generic execution contracts | First; freeze before runtime work |
| 2 | Child-environment contract | After 1 |
| 3 | Output disposition/artifact contract | After 2 |
| 4 | Execution contracts, environment, output, durable state | After 1–3 |
| 5 | ProcessBackend/SubprocessRuntime, managed Job helper | After 4 |
| 6 | Execution contracts, backend selection, ToolBroker/context/factory/config | After 5 |
| 7 | SubprocessRuntime, grants, factory, process/evidence/final verification | After 6 |
| 8 | SubprocessRuntime, grants, factory, managed/LSP/MCP/Git | After 7 |
| 9 | Shared Git runner and environment/isolation policy | After 8 |
| 10 | ToolBroker grant and filesystem tool mutation boundary | After 9 by serial doctrine |
| 11 | Execution/recovery contracts, durable events, observability/client | After 10 |
| 12 | Every runtime composition/cleanup/package/CI surface | Last |
| 1 ↔ 4 | Generic invocation/process/result/store types | Task 4 consumes frozen Task 1 types |
| 1 ↔ 5 | Capability attestation and birth/backend identity | Task 5 implements Task 1 SPI semantics |
| 1 ↔ 6 | Capability and opaque grant contracts | Task 6 consumes/extends only compatibly |
| 1 ↔ 11 | Exceptional recovery proposal/outcome types | Task 11 wires frozen types durably |
| 1 ↔ 12 | Capability version/package compatibility | Task 12 validates; no contract redesign |
| 2 ↔ 4 | Child environment constructor | Task 4 composes it |
| 2 ↔ 7 | Environment behavior in one-shot families | Task 7 routes; Task 2 remains sole policy owner |
| 2 ↔ 8 | Environment behavior in remaining families | Task 8 routes; no duplicate scrub logic |
| 2 ↔ 9 | Git safe environment | Task 9 adds Git-specific deny settings atop central scrub |
| 3 ↔ 4 | Output spool/result lifecycle | Task 4 composes it |
| 3 ↔ 7 | Evidence/final artifact mapping | Task 7 maps shared output only |
| 3 ↔ 8 | Protocol-family output handling | Task 8 retains framing, delegates bytes |
| 3 ↔ 12 | Spill cleanup/package surfaces | Task 12 validates final ownership |
| 4 ↔ 5 | Backend SPI, store transitions, reconciliation | Task 5 supplies adapters without changing orchestration authority |
| 4 ↔ 6 | Runtime backend/provider selection | Task 6 adds isolation selection at the frozen seam |
| 4 ↔ 7 | Shared runtime/factory | Task 7 is first consumer migration |
| 4 ↔ 8 | Shared runtime/factory/store | Task 8 completes consumer migration |
| 4 ↔ 11 | Recovery states and durable records | Task 11 proposes only against Task 4 states |
| 4 ↔ 12 | Startup/shutdown reconciliation | Task 12 composes existing APIs |
| 5 ↔ 6 | Semantic ownership capabilities | Isolation provider may wrap/use backend; claims remain separate |
| 5 ↔ 8 | Managed/LSP current ownership code | Task 8 removes duplicates only after Task 5 adapters are green |
| 5 ↔ 11 | Birth/identity/scope validation | Task 11 reads Task 5 proofs, never signals directly |
| 5 ↔ 12 | Adapter cleanup and CI matrices | Task 12 validates both native adapters |
| 6 ↔ 7 | Grant/provider context and native factory | Task 7 consumes Task 6 wiring |
| 6 ↔ 8 | Grant/provider context and remaining families | Task 8 consumes Task 6 wiring |
| 6 ↔ 10 | Exact path grant at trusted mutation seam | Task 10 consumes grant; Task 6 owns issuance |
| 6 ↔ 11 | Lease/grant enforcement projection | Task 11 exposes existing state |
| 6 ↔ 12 | OCI cleanup/config/package/CI | Task 12 composes and validates |
| 7 ↔ 8 | Shared factory/runtime migration | Complete Task 7 and rebase evidence before Task 8 |
| 7 ↔ 11 | Process result/enforcement projection | Task 11 exposes, does not remap semantics |
| 7 ↔ 12 | Factory cleanup and broad regressions | Task 12 finalizes after both routing tasks |
| 8 ↔ 9 | `git-command.ts` and Git tests | Task 8 routes; Task 9 hardens after green routing |
| 8 ↔ 11 | Managed/recovery observation | Task 11 uses generic records after migration |
| 8 ↔ 12 | Raw-spawn allowlist and family cleanup | Task 12 validates, no new launch seam |
| 9 ↔ 12 | Git preflight/package/static gates | Task 12 runs final Git gate |
| 10 ↔ 11 | Grant/mutation audit projection | Task 11 discloses Task 10 typed outcomes |
| 10 ↔ 12 | Filesystem docs/platform validation | Task 12 validates and documents |
| 11 ↔ 12 | Startup recovery, observability, client/package | Task 12 composes and runs final gate |

## Findings queue

| Finding | Severity | Owner task | Status |
|---|---|---|---|
| Three uniquely named `runner-v2-launch-orphan-*` system-temp roots from Task 4 prove-red runs could not be removed because host policy rejected both safe cleanup attempts; each was inspected and contains only its owned `state.sqlite`. | Low | 12 | Deferred cleanup/residue audit; do not broaden Task 5 |
| One inert Task 5 evidence directory for stopped supervisor PID 41160 remains under the task-owned temp namespace because both recursive and exact file deletion were denied by host policy; all three associated exact fixture processes were revalidated and stopped. | Low | 12 | Deferred cleanup/residue audit; no live process remains |

## Breaker rulings

- Ruling: Task 5's unjournaled recovery output-reopen, backend-observe/output-write,
  and verify-empty effects are real and load-bearing. Carry their durable
  exclusion into the first prerequisite packet of Task 6, before isolation or
  grant work. This preserves dependency safety at the cost of coupling one
  inherited runtime repair to Task 6's dispatch.
- Ruling: completed effect markers must name and enforce their exact semantic
  consumer; unrelated mutations may not clear them. Carry the closed
  family-to-consumer mapping and tamper/replay tests into the same Task 6
  prerequisite. If this ruling is wrong, the cost is a narrower state machine
  and extra migration/tests, not weakened cleanup safety.
- Ruling: Task 6's over-capacity recovery-evidence eviction is real and
  load-bearing. Carry one closed prerequisite into Task 7 before any process
  routing: the newly appended exact recovery group is protected from eviction;
  older complete groups may be removed, but if the protected group still cannot
  fit, persistence fails typed, the provider tombstone is not acknowledged, and
  selector ownership/listeners remain. This preserves the five-round breaker
  while refusing to waive durable cleanup evidence.
