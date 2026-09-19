# P6 resumed — Git host-integration checkpoint

Date: September 11, 2026. Base commit: `7f6fbcb15c67dfe87984131c1d208636056611e9`.

Windows MCP Snapshot, PowerShell and file reads responded after reconnection. Some longer PowerShell calls returned a transport timeout after their scripts had already written successful terminal receipts. The actual receipts and source bindings determine outcomes; those timeouts are not treated as either passing tests or proof that all MCP operations are unavailable.

## Resume correction

The prior final response incorrectly said `git-host-integration-tests.patch` had not been applied. Live inspection found the test already present and `git-host-integration-red-terminal.json` recording its intended missing-`run.git` failure. The test was not reapplied or duplicated.

## Delivered in this continuation

The real `ExecutionHostRunBinding` now constructs and owns the Git context using its existing command executor, grant authority, artifact store and closed-state check. There is no separate global Git runtime or native fallback in the new runner.

The real host test then exposed a byte-preservation gap: Windows intentionally cannot attest the built-in private spill facility, so the real spool reports storage loss while retaining its exact bounded raw tail. The one-shot conversion discarded those raw bytes, and the Git adapter required a spill artifact even for a complete six-byte binary result. The correction carries optional canonical base64 plus exact byte length through the generic result and durable parser. Both fields remain absent for legacy records. Encoding, pair presence, 128 KiB bounds, total length and truncation consistency are checked before use. Git uses this raw tail only when it contains the complete response. UTF8 display text and storage-loss markers are never used to reconstruct binary bytes. Complete spill artifacts remain the large-output path; their hash/length verification is unchanged.

Diagnostic loss metadata is not changed to claim private spill succeeded. Without a complete spill, responses exceeding the retained raw tail still fail typed as `output_limit`. Whole-family compatibility and all production Git caller migration remain outstanding; this checkpoint does not declare the complete 8.1 requirement set accepted.

Controller self-review also found that caller cancellation removed the delegated scope's parent cleanup callback too early. ToolBroker could then finish parent revocation while child cleanup was pending or after it had failed. The callback is now removed only after successful cleanup. Both pending joins and retained failure identity, including an undefined rejection, reach the original parent authority.

## Verification

- Original native host-wiring RED preserved. Initial wired native result failed safely for unavailable exact output, with its authenticated subprocess record already `cleaned` and cleanup `verified_empty`; the failed diagnostic root was retained.
- Exact binary boundary: 19 targeted cases passed after causal RED, including actual spool, memory store and real SQLite reopen. The initial test-only duplicate SQLite close was corrected; its failed attempt remains recorded.
- Seven binary guards were materially reversed, each caused the intended failure, and exact source bytes were restored to green.
- Affected contracts/store/subprocess/host/grants/ToolBroker graph: **226/226 passed** before the final parent-callback correction. This is not represented as a complete rerun after that correction.
- Parent cleanup regression: **3 intended failures** before repair; **32/32** affected authority/context checks afterward. Reversing that callback repair reproduces the failures; exact restoration passes.
- Final current-source gate: **95/95 passed**, no failure/cancellation/skip/todo. Includes real Git initialization, exact non-UTF8 object write/read, grant revocation refusal and verified host cleanup, plus all current Git adapter/context/command-scope/grant/isolation/binary-boundary cases.
- All **203** final-gate input hashes still match. Current configured Runner typecheck and ESLint on the 14 changed/new source/test surfaces both exit 0.

Final gate: `git-reconnected-final-terminal.json` and `.tap.log`. Material evidence: `binary-material-proof.json` and `command-parent-material-proof.json`. Machine-readable checkpoint: `reconnected-final-verification.json`.

## Resource and repository boundary

All **67 exact acquisitions** recorded by the final current gate are absent after their successful fixture finalization. No final-gate root remains. Four owned wrappers from this resumed work have terminal receipts and their exact process identities are no longer active. The earlier failed native and synthetic fault evidence stays retained; nothing historical was force-signaled, reinitialized or deleted. Resource accounting uses exact creation records, not a temporary-directory sweep.

All **222 unrelated files** in the initial protected manifest remain byte-identical. HEAD and the Git index are unchanged. These P6 changes are uncommitted; no publication or dependency/Node-policy change occurred.

## Ordered next work

B3 close-out is recorded as verified on the C acceptance base. Task **8.1 Git is in progress**, now with a tested host integration. Next: route baseline, repository, worktree, integration, verification, intelligence and model-tool callers through explicit per-run/call runners; retire the old ambient/raw Git path; verify family semantics, output applicability, cancellation and cleanup before proceeding to 8.2 MCP.

P6 is not complete. P6.5/P6.6/P7 remain outside this continuation.
