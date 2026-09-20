# Task 8.2 MCP — acceptance close-out

Date: 2026-09-12. Base: `8ef74b463c9087bdc6a9e5947cef7cb2d858615c`. Branch: `codex/runner-v2-robust-build`.

Owner instruction: finish Task 8.2, then commit. Controller self-review is accepted; independent review was explicitly waived. No Task 8.3 or later implementation, push, package/Node-policy change, model call, or unrelated benchmark work is included.

## Disposition

Task 8.2 is accepted on the current source and the impact-based evidence below. Task 8.3 LSP is eligible to begin. P6, its final whole-suite/platform gate, and P6.5 remain incomplete/locked. This is not a claim that every historical failed fixture or optional platform has become clean.

## Verification

| Evidence | Result and scope |
| --- | --- |
| Broad Windows affected graph | 116 complete test files; 1,927 checks: 1,924 passed, two findings and one POSIX-only skip. The original nonzero receipt is retained, not rewritten. |
| Final Windows delta graph | 26 complete affected family/consumer files, **503/503 passed**, no skipped/cancelled/todo checks, exit 0; 231 execution inputs unchanged during the run. Includes all MCP files, entire shared streaming-runtime tests, CLI recovery, actual agent lifecycle, native factory, real process and crash integration. |
| Findings from broad graph | The old CLI fixture expected eager discovery plus a live process. It now verifies one closed discovery process and zero public launches/sessions. A generic deadline check added for graceful EOF had suppressed an existing no-effect startup blocker; it is now conditional on an actual graceful input operation. Both complete files pass in the final graph. |
| Linux | **132/132 passed**: 117 MCP configuration/protocol/manager/authority/broker contracts, 14 actual memory/SQLite shared request contracts, and one real native POSIX descendant lifecycle. Cached immutable image, no network/pull/install, exact container exited 0, evidence copied, container removed. |
| Material reversals | **16/16 detected** on real pure/synthetic tests. Fifteen assertion failures plus one exact `SessionAuthorityError: authorization_forged` before writing. Original automatic classification of the last typed refusal is retained with the controller's explicit disposition. All source bytes restored before final tests. |
| Static checks | Full Runner TypeScript noEmit, full Runner source/test ESLint, and Git whitespace check all exit 0 on unchanged final inputs. |
| Unrelated work | 222 pre-existing dirty/untracked package, ZIP, benchmark and prior-evidence files remain byte-identical. No push. |

The final delta changes only four production surfaces relative to the broad run: internal MCP discovery, private MCP RPC/transport, and the conditional shared graceful-input deadline guard. Complete affected consumers and the shared runtime were rechecked; unchanged Git/integration/filesystem/backend/store work was not needlessly rerun. `final-delta-impact.json` records the exact six changed source/test inputs. `evidence-index.json` binds raw receipts/logs; `accepted-inputs.json` binds the delivered source.

## Original requirement self-review

| Task 8.2 obligation | Implementation and direct evidence |
| --- | --- |
| Public status/tools/artifacts/approval | `mcp-tools.ts` preserves public manager/status/tool interfaces and artifact-backed media. Native schemas-to-tools and guarded approval tests pass. New command refusal is the required intentional removal of shell compatibility, not an accidental fallback. |
| CLI configuration only, closed discovery | CLI `--mcp` and fixed `--mcp-envelope` validation; internal per-run discovery only initializes/lists tools, records digests and closes exactly. Actual CLI startup-failure test proves zero live public session/launch. Discovery close-before-start and late acquisition races are directly tested. |
| Lazy exact ownership | `mcp-session-manager.ts` keys live sessions by real run, actor, agent session, server and immutable envelope. Actual host/broker/Git-call-context integration proves first-call acquisition, fresh-grant reuse and separate-agent isolation. |
| Original launch call and fresh later authorization | Host transport issues no grants or invented actors. First request uses retained launch claims; later requests consume exact fresh ToolBroker grants. `streaming-request-operation.ts` permits one bounded write/response operation and rejects escaped/reused authority. Memory and SQLite tests pass. |
| Conservative access | Fixed path/network/credential declaration is bound into configuration digest; explicit empty paths stay empty through ToolBroker. Envelope subset is checked before isolation/launch and on each request. Required credentials fail typed because no host MCP credential resolver is configured; secrets are not inherited as a substitute. Full remains explicitly unconfined, strict requires an available provider. |
| No shell launch fallback | Closed portable full-token quoting, literal argv, typed operator/ambiguous-quote/missing-executable refusal. Static family audit and material reversals pass; no raw spawn/kill/ambient fallback is added. |
| Bounded framing and output | Shared bounded streaming output plus strict UTF-8/newline RPC peer; malformed IDs/frames, partial/coalesced data, write/response timeout, early reply before acknowledgement, output loss/spill failure and backpressure are covered. |
| Executable/schema/config replacement | Fresh descriptor-bound pinned executable hashing before launch/reuse; no repeated ambient PATH resolution. Canonical schema keys compare identically on discovery/live paths. Detected replacement invalidates all live agents of that exact server, not only the triggering slot. |
| No external replay | Used-call identities and restart budgets remain bounded. Interrupted write/session loss is typed unknown; pre-write refusal is not sent. Pending schema notifications are handled before a new external write; incomplete prior frames refuse a new request until idleness is established. |
| Graceful and exact cleanup | EOF acknowledgement remains owned before cleanup changes fencing; shared force escalation, descendant emptiness, output settlement and evidence are retained. Actual Windows/strict OCI/POSIX tree tests and delayed-ACK regression pass. |
| Agent/run/recovery lifecycle | Worker, Architect and subagent loops all join exact `closeAgent`; actual roles persist without substituting worker identities. Run cleanup and recovery never mint a replacement grant/replay an external call. Real pre-transfer and post-adoption crash coverage passes. |
| Ready does not require an idle child | Ready/tool publication comes from verified discovery. Lazy startup and exact no-public-launch CLI assertions pass. |

Additional details and configuration examples are in `runner-v2/MCP.md`. MCP-specific attestation, bounded protocol, restart controls and graceful shutdown are newly delivered controls, not claims about prior behavior.

## Resource accounting and preserved exclusions

All **518** observer-recorded roots in the successful final Windows graph were removed by their owned test finalizers; none remain. Successful tests perform cleanup/release assertions before removal. Current absence is only a supplementary observation, never the sole cleanup proof. The final Linux container has separately verified exact identity/exit/removal.

The earlier broad run retained 55 unchanged, explicitly synthetic C2 round9 fixtures, a no-launch historical Git diagnostic, and the failing eager-CLI diagnostic. The latter two have empty process/session/launch tables and no backend witnesses. They remain retained rather than being deleted to make a count look clean.

The prior failed Task 8.2 native rounds retain 33 observer-recorded diagnostic roots. Three retain older `cleanup_blocked` native session records with durable workload state `stopped` and backend witnesses. They are **not claimed released** and are not accepted-run evidence. Their exact identities and failed receipts remain unchanged; there was no historical PID-only cleanup, broad deletion, state rewriting, or conversion of an unknown result into success. This preserves the approved historical-exclusion boundary; the repaired behavior is established by the clean final native runs.

## Durable handoff

After the local Task 8.2 commit, the next approved packet is **8.3 LSP**. Reuse the delivered streaming request/session lifecycle where appropriate; do not infer P6 completion or start P6.5. Read `task8-2-gate.json`, the final input/evidence manifests and the actual committed source rather than relying only on this narrative.
