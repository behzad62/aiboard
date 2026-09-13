# Task 8.3 — LSP shared-session migration — VERIFIED

Accepted at 2026-09-13T19:53:22.717Z. Controller self-review is authorized by the user. This acceptance is bound to live worktree inputs, not prior assistant claims.

Worktree: D:\repos\ai-discussion-board\.worktrees\runner-v2-robust-build
Branch: codex/runner-v2-robust-build
Base HEAD: ccbbb0eeabc9f1543270d5e2abfb10b65c8d3c87
Accepted input digest (SHA-256): ce13787bb2b1af11feb9a49ef8493b5a6171b0fbce47dbffb8a621bd87248987

**Task 8.3 is VERIFIED. Task 8.4 is eligible but NOT implemented. P6, Task 8 overall, and the later platform/final-P6 gates remain incomplete. Local commit only; no push.**

## Authority and scope

The original Family 8.3 packet in .superpowers/sdd/2026-08-28-runner-v2-portable-execution-safety/task-8-brief.md and the approved portable-execution-safety plan remain authoritative. Existing Task 8.1/8.2 acceptance and historical cleanup exclusions are preserved. Windows MCP and Desktop Commander were both permitted and used. No dependency, package/ZIP, Node-policy, provider-account, or unrelated benchmark changes belong to this acceptance. No product/model provider calls were made.

## Final verification matrix

| Accepted gate | Outcome | Durable evidence under acceptance-final-20260913/ |
| --- | --- | --- |
| Windows affected-file acceptance matrix | **2,159 passed, 0 failed, 0 cancelled, 1 POSIX-only skip; 2,160 tests across 158 complete files** | affected-file-results.json; acceptance.json |
| Complete Windows LSP/language family | 82/82 passed; no skips | windows-lsp-acceptance/ |
| Complete MCP + real streaming integration files | 47/47 passed, including native and strict Docker paths | windows-mcp-shared/ |
| Complete changed spool/evidence/session files + new linked fixture regression | 314/314 passed | windows-linked-complete/ |
| Complete CLI configuration/readiness recheck | 18/18 passed | cli-complete-recheck/ |
| Actual Linux accepted LSP + shared + POSIX matrix | **751 passed, 0 failed, 0 cancelled, 1 Windows-only skip; 752 tests** | linux-lsp-shared-acceptance/ first three command receipts; linux-shared-final/ |
| Linux corrected shared contracts | 626/626 passed | linux-shared-final/ command 0 |
| Actual Linux POSIX lifecycle | 44/44 passed | linux-shared-final/ command 1 |
| Configured runner-v2 TypeScript | exit 0 | typecheck-acceptance/ |
| Full Runner src/test ESLint | exit 0; 0 errors; one existing unused ToolExecutionContext import warning in mcp-tools.test.ts | eslint-acceptance/ |
| git diff --check -- runner-v2 | exit 0 | diff-check-acceptance/ |

The matrix is assembled from complete-file runs, not merely named green tests. The broad Windows run had one CLI preflight readiness failure and one POSIX skip; its other complete files are retained as evidence. The entire 18-test CLI file subsequently passed unchanged. No causal product fix is attributed to that non-reproduced preflight observation. Only three linked-spill test adapter compositions and two new helper/test files changed after the broad run; all four affected complete files were rerun. The live import closure shows that no other test imports those changed test files. Thus unchanged product and unaffected test evidence is reused explicitly rather than rerunning the entire 27-minute graph for test-only adapter changes.

The first expanded Linux run passed its 11-test portable/descendant group, its 14 eligible LSP client cases, and its 56-test LSP/language group, then exposed 68 linked-spill fixture failures in the additional shared group. Those failed shared results are not counted as passes. The corrected complete shared group and previously unrun POSIX group passed in linux-shared-final. Their source bytes match the accepted inputs. Windows batch is exercised on Windows, and the Windows-only Linux skip is not a waiver of batch acceptance. Windows Node v24.18.0 and cached-container Node v24.20.0 are observed versions, not a product patch pin. No image pull or dependency installation occurred.

## Repairs and final boundary behavior

LspClient now delegates all process lifecycle to its injected shared transport while preserving its protocol/document logic. Actual code-tool and post-write diagnostics authority reaches configured LSP only; public built-in/extension calls retain their original arguments and never receive the opaque grant. A fixed exact run/actor/agent/root/server owner scopes each lazy session. A later fresh authorized call may restart only after retained cleanup is joined; failed application RPCs are never replayed.

Shared cleanup relinquishes pending family ACKs before joining ACK-gated intake, eliminating the takeover circular wait. Cleanup grace admission is separate from ownership of a callback that has already begun. A refused pre-effect delivery is recoverable; an uncertain actual effect remains blocked. Windows Job output frames persist their exact byte length/digest/sequence and require exact ACKs on reattachment.

Large logical LSP frames use bounded concrete writes, one whole-frame deadline, and complete-frame serialization against server-control replies. The language operation budget includes its serial protocol/write phases without changing per-phase caller timeouts. Shutdown owns response then exit; the runtime owns bounded escalation and the quiescence/output/evidence/channel/backend/isolation release conjunction. Supervisor pipe errors and portable pending input remain owned. Portable ACKs wait for actual callbacks; POSIX cleanup takeover observes the authenticated original anchor-release receipt.

The last correction was test-only: linked-entry fixtures advertised unlinkedEntries=false but borrowed the native POSIX opener that unlinks immediately. A dedicated private-root linked test adapter now matches those declared test semantics. The native descriptor-only/unlinked production storage and its positive tests are unchanged. Existing bounds, identity checks, and cleanup assertions were not relaxed. The new regression failed with the original composition, passed with the adapter, failed again when the old opener was restored, then passed after exact restoration in the full Linux/Windows groups.

The real backpressure cleanup remains verified by all six shared cleanup facts. Its earlier private-process 1.5-second fixture bound was replaced with the existing shared 30-second bound after measured fully verified cleanup, not by enlarging product cleanup until green. See the retained continuation manifest and current native receipts.

## Original requirement-to-source/test traceability

### 8.3.1: Original code/filesystem ToolBroker identity reaches only configured LSP; exact agent/run lifecycle joins

Frozen original call/actor context is forwarded by code and post-write diagnostics; the router checks membership in its configured-provider ownership map, not an extension-controlled prototype. Provider cache keys include run, actor, agent session, server and canonical root. All three agent loops join the exact language owner; run close joins the shared run binding.

Sources: `runner-v2/src/code-intelligence-tools.ts`, `runner-v2/src/filesystem-tools.ts`, `runner-v2/src/language-intelligence.ts`, `runner-v2/src/language-provider-router.ts`, `runner-v2/src/language-agent-lifecycle.ts`, `runner-v2/src/worker-runtime.ts`, `runner-v2/src/native-architect-runtime.ts`, `runner-v2/src/subagent-tools.ts`, `runner-v2/src/native-build-factory.ts`.

Complete tests: `runner-v2/test/language-invocation-propagation.test.ts`, `runner-v2/test/lsp-real-host.test.ts`, `runner-v2/test/lsp-server-control.test.ts`, `runner-v2/test/lsp-router-authority.test.ts`, `runner-v2/test/language-agent-lifecycle.test.ts`, `runner-v2/test/worker-runtime.test.ts`, `runner-v2/test/native-architect-runtime.test.ts`, `runner-v2/test/subagent-tools.test.ts`.

### 8.3.2: Injected shared ExecutionHost transport, no private OS lifecycle or ambient environment fallback

LspClient owns protocol/document state only. Its injected transport uses the original openStreaming grant and owned cleanup. AST policy rejects raw launch, signals, shells, ambient environment and invented grant/principal routes. Prepared environment is explicit, never process.env fallback in executable discovery.

Sources: `runner-v2/src/lsp-client.ts`, `runner-v2/src/lsp-transport.ts`, `runner-v2/src/execution-host-lsp-transport.ts`, `runner-v2/src/language-server-executable.ts`.

Complete tests: `runner-v2/test/lsp-caller-audit.test.ts`, `runner-v2/test/lsp-shared-client.test.ts`, `runner-v2/test/lsp-transport-authority.test.ts`, `runner-v2/test/language-environment.test.ts`.

### 8.3.3: Preserve framing, typed errors/retryability, diagnostics/freshness, document versions/reopen, stats/bounds and server replies

Compared the 16-code union, constructor retryability default and available document/diagnostic/stat interfaces against HEAD. Original parser/version/freshness behavior remains exercised through real shared transport. Large frames are split into bounded concrete writes, with one logical-frame deadline and whole-frame serialization against server replies.

Sources: `runner-v2/src/lsp-client.ts`, `runner-v2/src/lsp-language-provider.ts`, `runner-v2/src/execution-host-lsp-transport.ts`.

Complete tests: `runner-v2/test/lsp-client.test.ts`, `runner-v2/test/lsp-language-provider.test.ts`, `runner-v2/test/language-provider-compatibility.test.ts`, `runner-v2/test/language-provider-router.test.ts`, `runner-v2/test/lsp-shared-client.test.ts`, `runner-v2/test/lsp-invocation-lifetime.test.ts`, `runner-v2/test/lsp-initialize-rejection.test.ts`, `runner-v2/test/lsp-server-control.test.ts`, `runner-v2/test/lsp-transport-framing.test.ts`.

### 8.3.4: No replay of an in-flight RPC; only a later fresh authorized call can restart after cleanup within limits

request() has no retry/replay path. start/restart is entered from a later explicit context; retained cleanup is joined before a new transport is opened. Reopened documents restore protocol state, never the failed application RPC. The first operation checks the original launch call; subsequent operations use fresh exact grants and a bounded call ledger.

Sources: `runner-v2/src/lsp-client.ts`, `runner-v2/src/execution-host-lsp-transport.ts`, `runner-v2/src/session-authority.ts`.

Complete tests: `runner-v2/test/lsp-shared-client.test.ts`, `runner-v2/test/lsp-client.test.ts`, `runner-v2/test/lsp-invocation-lifetime.test.ts`, `runner-v2/test/lsp-transport-authority.test.ts`, `runner-v2/test/session-authority.test.ts`, `runner-v2/test/streaming-request-operation.test.ts`.

### 8.3.5: Bounded language_request owns notifications plus RPC; same authority rechecked before effects; MCP remains one write

Separate operation discriminator permits at most 256 LSP concrete writes and exactly one MCP request write, with shared exclusivity. Every write/output delivery invokes the same current-authorization assertion. Queued cancellation cannot borrow an active writer. Already-issued effects remain retained after caller timeout.

Sources: `runner-v2/src/streaming-request-operation.ts`, `runner-v2/src/streaming-process-session-runtime.ts`, `runner-v2/src/streaming-output-controller.ts`, `runner-v2/src/session-authority.ts`.

Complete tests: `runner-v2/test/streaming-language-operation.test.ts`, `runner-v2/test/streaming-request-operation.test.ts`, `runner-v2/test/session-authority.test.ts`, `runner-v2/test/streaming-output-v2.test.ts`, `runner-v2/test/streaming-process-session-runtime.test.ts`, `runner-v2/test/mcp-tools.test.ts`.

### 8.3.6: Family shutdown response then exit, shared bounded escalation and complete six-fact release conjunction, no cleanup grant

Shutdown is sent and its response awaited before exit. Owned cleanup permits only bounded shutdown/exit/cancel frames. The runtime checks exact owner/fence/deadline and joins admitted delivery/write effects before escalation, output/evidence finalization, detach, backend and isolation release. Preeffect authority refusal is distinguished from an uncertain actual callback. Job retained frames authenticate length/digest/sequence and exact ACK across reattachment.

Sources: `runner-v2/src/lsp-client.ts`, `runner-v2/src/execution-host-lsp-transport.ts`, `runner-v2/src/streaming-process-session-runtime.ts`, `runner-v2/src/streaming-output-controller.ts`, `runner-v2/src/windows-job-process-host.ts`, `runner-v2/src/windows-job-process-channel.ts`, `runner-v2/src/managed-process-supervisor.mjs`.

Complete tests: `runner-v2/test/lsp-shared-client.test.ts`, `runner-v2/test/lsp-client.test.ts`, `runner-v2/test/streaming-process-session-runtime.test.ts`, `runner-v2/test/streaming-output-v2.test.ts`, `runner-v2/test/windows-job-output-replay.test.ts`, `runner-v2/test/windows-job-supervisor-input.test.ts`, `runner-v2/test/evidence-continuation.test.ts`, `runner-v2/test/real-streaming-integration.test.ts`.

### 8.3.7: Static prepared-environment attestation; exact fixed non-network/non-credential envelope; strict host-only refusal before create; Windows batch semantics

Preflight resolves/re-attests bytes only and cannot launch a configured LSP. CLI/factory inject host-filtered environment after the host exists. Fixed envelope has no additional paths, credential names or network approval; Full unconfined disclosure is explicit. Strict host-only LSP fails typed before backend creation; no native fallback or host executable mounting. Native Windows tests exercise attested command-shell shims and byte replacement refusal.

Sources: `runner-v2/src/language-server-executable.ts`, `runner-v2/src/language-provider-router.ts`, `runner-v2/src/native-build-factory.ts`, `runner-v2/src/runner-internal-execution-context.ts`, `runner-v2/src/cli.ts`, `runner-v2/src/execution-host-lsp-transport.ts`.

Complete tests: `runner-v2/test/language-environment.test.ts`, `runner-v2/test/language-executable-integrity.test.ts`, `runner-v2/test/lsp-host-envelope.test.ts`, `runner-v2/test/lsp-router-authority.test.ts`, `runner-v2/test/lsp-transport-authority.test.ts`, `runner-v2/test/lsp-client.test.ts`, `runner-v2/test/execution-host-credential-graph.test.ts`, `runner-v2/test/native-build-capabilities.test.ts`, `runner-v2/test/native-build-initialization.test.ts`, `runner-v2/test/mcp-tools.test.ts`, `runner-v2/test/oci-execution-isolation-provider.test.ts`.

### 8.3.8: Cancellation/recovery cannot orphan late resources or clean an adopted launch through the unstarted path

Pre-adoption failures retain and join the exact launch coordinator; handed-off launches reject unstarted cleanup and use the adopted session owner. Late acquisition/close remains joined. Recovery observes/cleans existing exact IDs and cannot relaunch. Portable writes acknowledge actual callbacks without holding the cleanup fence while blocked. Higher-fence POSIX cleanup observes the original authenticated consumed anchor-release receipt rather than issuing a stale release.

Sources: `runner-v2/src/streaming-process-session-runtime.ts`, `runner-v2/src/execution-host-lsp-transport.ts`, `runner-v2/src/lsp-client.ts`, `runner-v2/src/portable-process-supervisor.mjs`.

Complete tests: `runner-v2/test/streaming-live-open-cancellation.test.ts`, `runner-v2/test/streaming-late-isolation-cleanup.test.ts`, `runner-v2/test/streaming-unstarted-host-cleanup.test.ts`, `runner-v2/test/streaming-process-session-runtime.test.ts`, `runner-v2/test/lsp-initialize-rejection.test.ts`, `runner-v2/test/lsp-invocation-lifetime.test.ts`, `runner-v2/test/portable-supervisor-input.test.ts`, `runner-v2/test/posix-anchor-release-takeover.test.ts`, `runner-v2/test/posix-process-backend.test.ts`.

The exact source/test SHA-256 mapping is in requirements-review-final.json; complete runtime-import and supervisor-dependency analysis is in live-import-closure.json and affected-file-results.json. All 16 public LspClientError codes, the constructor retryability default, and the checked document/diagnostic/stat interfaces match HEAD in api-compatibility.json.

## Causal-fault acceptance

**26 distinct material faults were behaviorally RED and restored GREEN.** Full RED/GREEN logs, terminal receipts, hashes and copied provenance are in causal-proof/ and causal-proof-index.json. This includes the original takeover/grace/replay guards, both phase budgets, bounded input/chunk and whole-frame rules, code/filesystem grant propagation, extension isolation, MCP's one-write invariant, strict refusal, prepared-environment discovery, agent lifecycle, no RPC replay, portable callback/anchor handling, descendant fixtures, and the linked test-storage contract. A genuine uncalled raw-launch bypass made the static family policy RED; the function was never executed and exact source restoration made it GREEN. No syntax error or unavailable environment is counted as a causal RED.

## Resource accounting

Current continuation host-root accounting: **2,202 exact recorded roots; 2,145 absent after fixture-owned teardown; 57 retained closed evidence roots; zero unresolved new native workloads/owners.** The retained roots are 55 deliberately synthetic C2 round9 database/artifact fixtures, one closed synthetic shutdown-budget reverse-fault fixture, and one unsuccessful Git-inspection evidence root. The latter has authenticated empty streaming sessions, host launches and subprocess records, plus empty managed/backend directories. Synthetic contradictory cleanup records are not falsely certified as released.

The complete Windows LSP run removed all 153 recorded roots and the complete MCP/real-streaming run removed all 70. The CLI recheck removed all 22; the final changed-file run removed all 228. Native fixtures assert exact owner cleanup before absence observations. No PID-only signals or broad temporary-directory deletions were used.

The successful final Linux container and the positive linked-regression container were removed only after exact ID/label, terminal state, copied evidence and absence verification. Three failed/intentional RED containers from this continuation remain **exited, not running**, with their evidence preserved. Their IDs and state observations are in resource-accounting.json. The preserved failed-root files are not active process resources.

Historical retained roots from earlier tasks and prior Task 8.3 attempts remain exclusions. The original PID 31560 interrupted run has no recoverable terminal result; no result was fabricated. Later interrupted/failed native logs and their uncertainty are preserved as historical evidence, not counted in this accepted matrix.

## Protection, staged boundary and next task

**10,206 protected files remained byte-for-byte unchanged** from this continuation's live baseline; the pre-existing index was empty and preserved until explicit selective staging. See protected-preservation.json. Only accepted Task 8.3 Runner changes, task documentation, source-bound test receipts, causal proofs and resource/requirement ledgers are eligible for the commit. Unrelated package/lock/ZIP/benchmark changes and the Task 8.1 resource ledger remain unstaged.

The canonical accepted source manifest is accepted-inputs.json. Post-commit verification checks the new HEAD, exact index/tree correspondence, unchanged accepted bytes, clean Task 8.3 tracked paths and preserved unrelated changes. Task 8.4 is eligible for a separate assignment, not implemented here. No remote push.
