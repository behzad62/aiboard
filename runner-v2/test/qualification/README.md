# Runner V2 hosted qualification entrypoints

Focused real-host acceptance scenarios for Gate G / M4. Broad monoliths under
`runner-v2/test/*.test.ts` remain available for broad/manual regression, with only
explicitly targeted repaired cases retained in required CI. They are **not** hosted
qualification entrypoints.

## Entrypoints (workflow jobs)

| Job | Entrypoint | Scenarios (isolated Node processes) |
| --- | --- | --- |
| `native-lifecycle` | `native-lifecycle.test.ts` | Windows: native descendant after launcher exit, Job descendant containment, real Job duplex/terminal settlement; POSIX: process-group after launcher exit; all OS: managed shared/natural-exit, MCP lazy |
| `cli-readiness` | `cli-readiness.test.ts` | Real CLI malformed/valid/in-project config; static extension-closure validation; config trust alias reject; capability-contract alias reject; plugin importer escape reject |
| `recovery` | `recovery.test.ts` | Startup reconciliation block; CLI pause/restart event continuity |
| `windows-portable-channel` | `windows-portable-channel.test.ts` | Duplex ordered bytes, unsettled-output release refuse, fence takeover, stale fence reject |
| `docker-oci-integration` | `docker-oci.test.ts` | Docker required gate, alpine containment + recovery, managed strict OCI, real MCP-over-OCI detached-descendant containment/retirement |

## Old → new coverage map

| Former qualification invocation | Replacement |
| --- | --- |
| `windows-process-backend.test.ts` (giant) | `scenarios/windows-lifecycle.ts` native descendant + Job descendant + real Job duplex/terminal-settlement scenarios |
| `windows-job-process-channel.test.ts` (synthetic) | Broad/manual regression; focused real Job duplex/terminal acceptance is in `scenarios/windows-lifecycle.ts` |
| `posix-process-backend.test.ts` (giant) | `scenarios/posix-lifecycle.ts` live launcher-exit scenario; the repaired launcher-exit observation also runs by targeted `--test-name-pattern` in required POSIX CI |
| `managed-shared-native.test.ts` / `mcp-lazy-native.test.ts` | `scenarios/managed-mcp.ts` |
| `cli-capabilities-config.test.ts` | `scenarios/cli-config.ts` focused CLI startup/trust/static-extension subset; the two inherited active-Build fixture repairs run by targeted `--test-name-pattern` in required CI |
| `runner-capabilities-config.test.ts` | Required portable CI retains the deterministic suite; qualification adds `config-trust-rejects` |
| `runner-capability-contract.test.ts` | Required portable CI retains the deterministic suite; qualification adds `capability-contract-alias` |
| `plugin-loader.test.ts` | Required portable CI retains the deterministic suite; qualification adds `plugin-importer-rejects` |
| `recovery-smoke.test.ts` | `scenarios/recovery.ts` |
| `portable-process-protocol.test.ts` (synthetic) | Required POSIX portable CI retains it; Windows real-channel behavior is covered by `scenarios/windows-portable.ts` |
| `portable-process-channel.test.ts` (giant) | `scenarios/windows-portable.ts` real channel subset |
| `oci-execution-isolation-provider.test.ts` / `managed-strict-oci.test.ts` / Docker subset of `mcp-tools.test.ts` | `scenarios/docker-oci.ts` |

## Harness rules

- Fresh Node process per scenario via `support/qualification-harness.ts`.
- Fixture roots live under the OS temp directory; scenario-scoped pointer maps and copied diagnostics live under `RUNNER_V2_QUALIFICATION_EVIDENCE_ROOT` and are uploaded `if: always()`.
- Diagnostics are append-only captures: an earlier pre-termination timeout snapshot is never overwritten by a later entrypoint catch.
- Portable channel evidence is selected by durable directory role (`output` / `ack` / `input`), not only by filename substrings.
- Skips use a synchronous scenario marker as authority. Stdout `SKIP` text alone is invalid, and hosted Docker is fail-closed when `RUNNER_V2_REQUIRE_DOCKER=1`.
- Bounded convergence: expected → pass; definitive invalid → fail immediately; persistent unknown → fail with supervisor/state evidence.
- Exact-owned cleanup only; never PID/tree ancestry as authority; cleanup uncertainty is never success.
- Any scenario failure/timeout poisons that job sequence: later real-host scenarios do not start on the same runner; evidence upload is the only remaining workflow action before the hosted VM is discarded.
- Diagnostics omit environment dumps (no secrets).
- Outer harness guards may be generous; product deadlines unchanged.
