# Task 8.4 managed processes — VERIFIED

Accepted against base `59becb95ec49b56bbe33be5426b0f44e084dacb9` on branch `codex/runner-v2-robust-build` at `2026-09-14T09:18:02.282Z`.

Task 8.4 migrates product-facing managed background processes onto the shared ExecutionHost/session/runtime without preserving a second OS lifecycle stack in the public facade. The controller independently audited the original Family 8.4 packet, current source, regression tests, causal faults, platform runs, resource evidence, protected inputs, and staging boundary.

## Delivered architecture

- `ManagedProcessService` is now a durable metadata/public-tool facade backed only by an explicitly injected run-owned `ManagedProcessRunRuntime`.
- Active records use closed schema `runner.managed-process` v2 and contain no bearer/control token, port, native handle, writer, input payload, or live endpoint. Terminal legacy v1 records remain read-only; active legacy/future/unknown records fail typed before execution.
- `execution-host-managed-transport.ts` owns the family adapter into shared streaming sessions. Start preserves exact ToolBroker run/session/actor/call/grant identity, centralized child environment preparation, executable resolution, isolation selection, backend launch, evidence, terminal observation, recovery, and cleanup.
- Poll/list use fresh exact observation authority and bounded durable evidence. Trusted control-plane observations cannot authorize process effects and return durable metadata during transitional cleanup instead of inventing authority.
- Explicit stop durably commits shared cleanup under current exact authority. Caller cancellation after accepted stop cannot interrupt cleanup; cancelled reads do not terminate children; cancelled starts join late/adopted cleanup.
- ExecutionHost registers and detaches one run-scoped managed runtime. Final verification uses a separate explicit adapter that issues fresh run-owned grants for start/poll/stop; the managed facade itself never mints grants.
- Windows process backends/probes compose with the extracted authenticated Job host rather than the public managed facade; dependency tests prove backend/facade recursion is absent.
- Strict profiles refuse non-representable host executable identities before shared launch creation. A bare image executable is separately attested and runs only through the configured OCI provider.
- POSIX portable supervision now treats readable EOF as pipe completion and explicitly performs `read(0)` when no bytes are buffered so Node advances a pending EOF transition without consuming data or widening frame bounds.
## Requirement traceability

1. **Backend/facade separation:** `managed-backend-boundary.test.ts`, `windows-process-backend.test.ts`, and production fixture changes prove the Job/backend layer does not depend on the public managed facade or construct model actors.
2. **Versioned durable compatibility:** `managed-process-record.ts`, `managed-process-history.ts`, and `managed-record-compatibility.test.ts` prove closed active schema, typed incompatible-active refusal, bounded output, and no-write historical terminal reads without publishing legacy endpoint secrets.
3. **Authenticated startup/adoption:** `managed-process.ts`, `execution-host-managed-transport.ts`, `managed-shared-facade.test.ts`, and `managed-shared-native.test.ts` prove exact original call/grant identity, shared authenticated launch/adoption, grant revocation after response, and no private launcher route.
4. **Bounded observation:** `bounded-output-observation.test.ts`, `managed-observation-authority.test.ts`, shared spool/evidence changes, and native lifecycle tests prove bounded immutable evidence, fresh per-call poll/list authority, takeover recheck, and no observation-to-write widening.
5. **Stop/cancellation/close:** `managed-shared-facade.test.ts`, `streaming-process-session-runtime.test.ts`, final-verification smoke tests, and recovery tests prove cancelled start cleanup, durable stop continuation after caller cancellation, read-only cancellation, exact cleanup joining, and repeatable asynchronous close.
6. **Production ownership/recovery:** `execution-host.ts`, `native-build-factory.ts`, final-verification adapter tests, native build cleanup/manager/init tests, and recovery smoke prove run/agent/verifier lifetimes, distinct execution profiles, cleanup-only recovery, and no autonomous relaunch.
7. **Strict/platform behavior:** `managed-strict-oci.test.ts`, POSIX/portable/Windows backend suites, and the Linux container gates prove pre-create strict refusal, real OCI image execution, Windows Job/native behavior, POSIX shared lifecycle, descendant cleanup, and portable output/authority semantics.
8. **Compatibility:** public process tool names, input schemas, snapshot fields, terminal history semantics, and typed managed errors remain explicitly covered by focused tests; private legacy-supervisor tests were retired only where their subject no longer exists and their backend semantics are covered in shared/Job/POSIX suites.

## Final validation

- Current-source Windows managed/lifecycle closeout: **112/112 passed**, 107 recorded roots, 0 retained (`resume-20260914/current-source-closeout`).
- Final Windows portable/Job/managed impact matrix: **241 passed, 0 failed, 1 POSIX-only skip**, 169 recorded roots, 0 retained; input hashes unchanged (`resume-20260914/windows-portable-final2`).
- Strict configured OCI: **1/1 passed**; host-only absolute command refused before backend creation, bare `node` executed inside the attested image, exact root/container released (`resume-20260914/managed-strict-oci-green`).
- Final POSIX/harness regressions: **3/3 passed** on exact final tree (`resume-20260914/final-posix-regressions2`).
- TypeScript: exit 0 (`typecheck-final4`). Full Runner ESLint: exit 0, **0 errors**, one pre-existing `mcp-tools.test.ts` unused-import warning (`eslint-final4`). `git diff --check -- runner-v2`: exit 0 (`diff-check-final4`).
### Linux portable evidence

The final POSIX product repair was driven by retained real Linux evidence: the exact workload group was durably retired and output/ACK/input directories were empty, but the supervisor stayed `running` because readable-mode EOF was not advanced. The deterministic zero-length-read regression failed before the fix and passed after it; the reverse mutation failed again and restored the product source byte-for-byte.

On the repaired product bytes, `linux-managed-eof-stress2` ran three independent real `managed-shared-native` lifecycles (**3/3 each**) plus the full POSIX backend suite (**46/46**) in cached `node:24-alpine`; the container exited 0, evidence copied, exact container removed, absence verified, and inputs were unchanged.

The broader `linux-managed-final3` matrix on the same repaired product bytes passed managed facade/authority **31/31**, real managed native **3/3**, shared session/evidence core **342/342**, and portable/POSIX **139/140**. The sole failure was test-harness-only: `portable-supervisor-input.test` evaluated a supervisor source slice without the new `installPosixOutputLifecycle` VM binding. That harness was repaired, and the exact focused final regression is included in the final **3/3** receipt.

A final contiguous Linux rerun was attempted after that test-only harness repair, but Docker Desktop returned HTTP 500 while inspecting the already-cached `node:24-alpine` image, before container creation or test execution; a direct retry then hung in the Docker daemon and was terminated. This is recorded as external infrastructure unavailability, not a product/test failure. No Linux success claim is derived from that failed infrastructure attempt.

## Causal fault evidence

- Final verifier managed authority reversal removes the fresh grant and produces the expected authority RED; restored hash matches.
- Transitional trusted-observation reversal reproduces the cleanup-owner race; restored hash matches.
- Terminal cleanup-join reversal reproduces natural-exit cleanup refusal; restored hash matches.
- Strict pre-create refusal reversal reaches generic shared launch failure instead of the required managed refusal; restored hash matches.
- POSIX zero-length EOF pump reversal reproduces the real cleanup wedge regression; before/restored product hash is `b967dd5dd01e216b05877e6fd5438a36be55357af8892c94864c3bf5bad930f0`.
- Earlier Task 8.4 RED/GREEN evidence additionally covers backend/facade recursion, active-record compatibility, bounded output observation, exact observation authority, shared facade lifecycle, native wiring, concrete terminal observation, retained quiescence, final evidence recovery, and Job terminal semantics.
## Resource and repository accounting

- Successful accepted Windows runs retained **0** native roots: closeout 107/107 released, portable matrix 169/169 released, strict OCI root released. Final focused POSIX regressions created no native roots.
- Successful Linux runs `linux-managed-eof-once` and `linux-managed-eof-stress2` exited 0, copied evidence, removed their exact labelled containers, and independently verified container absence.
- **52** current temp roots referenced by Task 8.4 receipts are retained intentionally because they belong to failed/causal/diagnostic runs. They are not accepted-run leftovers and are not relabeled released.
- Failed Linux diagnostic containers remain preserved by exact IDs/labels as failed evidence. They are not counted as cleanup success. The final Docker HTTP-500 retry failed before container creation.
- Initial HEAD and branch remain the Task 8.4 baseline. Git index exactly matches the baseline before staging. The earlier 3,531-file protected baseline and resumed 3,529-file protected baseline both have **zero drift**.
- `resume-20260914/final-audit.json` records accepted Runner hashes for the Task 8.4 changed surface; `task8-4-gate.json` binds final receipts and causal evidence.
- Unrelated package, ZIP, benchmark/UI, calibration, and prior-task evidence changes remain outside Task 8.4 scope and must not be staged or committed here.

## Acceptance decision

**Task 8.4 is VERIFIED.** The original managed-process family requirements are implemented and supported by current Windows, strict OCI, real Linux/POSIX, deterministic causal-fault, compatibility, static, cleanup, and protected-input evidence. The Docker Desktop outage prevented only a redundant contiguous rerun after a test-harness-only repair; it does not erase the successful final-product Linux stress/portable evidence or the focused final harness receipt.

Task 8.5 (configured local-provider inventory and raw-launch closure) is now eligible. P6 remains in progress; Tasks 9–12 and final multi-platform/remote P6 qualification are still pending. No push/publication was performed.
