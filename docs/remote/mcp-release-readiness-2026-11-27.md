# MCP v2 migration release-readiness handoff — 2026-11-27

> Superseded by [mcp-v2-release-qualification-2026-11-27.md](mcp-v2-release-qualification-2026-11-27.md):
> the final review, fixes, qualification evidence and deployment plan. This file is the
> implementation handoff as it stood before that review; its HOLD and evidence are historical.

Status: **HOLD**. Feature implementation is complete within the scope and
limitations in mcp-optional-features.md; no release approval, commit, push,
staging deployment or production deployment has occurred.

## Repositories and candidate

- ai-discussion-board: main, HEAD 68de57d1, dirty working tree.
- aiboard-tunnel: codex/gemini-oauth-return, HEAD 28f845b, dirty working tree.
  Do not deploy this branch directly without reviewing its relationship to main.
- New source files remain untracked; include them in the eventual reviewed
  commit. Packaging uses git ls-files; the local checks used a temporary
  index seeded from HEAD with intent-to-add for runner-v2/src, not the real
  Git index.

## Local review repairs

1. Live task settlement and the stdio wire gate now bind both opaque ID and
   creation time, matching the existing restart-recovery checks. A reused ID
   with a different timestamp does not permit result acceptance, continuation,
   update, resource retrieval or task cancellation. Added positive and
   negative tests in mcp-optional-features.test.ts and
   mcp-stdio-continuation.test.ts.
2. HTTP tool dispatch observes the actual credential lineage used for the
   original request and rejects lineage switches across continuation rounds.
   App publication rechecks that lineage before resource retrieval and
   publication, and App call output is rechecked against current authority.
   The new real HTTP fixture replaces the bearer credential during the
   original tool response and verifies the result is not paired with an App
   fetched under the replacement. The original model-facing tool result is
   preserved. No raw credential enters the App payload.

## Verified local evidence

- Tunnel build plus targeted relay/device-route/storage/account-deletion/
  connector stdio suites: 122 passed, 0 failed.
- Runner typechecks and broader selected Runner suite: 173 passed,
  0 failed, 2 skipped (Docker node:24-slim unavailable; no containment
  weakening or image pull).
- Post-repair focused Runner suite covering MCP optional features, wire
  continuation, modern protocol, HTTP integration and App store:
  52 passed, 0 failed.
- Actual Chromium App host smoke: passed.
- Final native managed extension run: ten observed tests passed, including
  real stdio App read/write and restart recovery; final suite exit was
  not yet confirmed at handoff.
- Runner and frontend TypeScript checks passed (Runner rerun after fixes).
- Release import closure passed with all new Runner source included.
- Local unsigned Windows x64 bundle rebuilt and extracted; packaged
  launcher "version" printed "AIBoard Runner V2 0.0.1".
  SHA256 454b0660ad35134b96b5be0073fa5bf094c9e0d6410b5f448b99c7fc2c0e0002.
  Test-only version, not a proposed release version. Archive is in
  %TEMP%/aiboard-mcp-review-bundle-64e000f2-bc79-4c3e-a1ba-ecbe891b952c/.
  Windows Expand-Archive failed with an overload error in this shell;
  Python zipfile extraction and actual packaged launcher worked.
- Full Runner qualification suite (hours) deliberately not run under
  AGENTS.md. Only win-x64 packaging was attempted.

## Release gates

Codex and Claude Code independent review attempts failed due to usage
limits. AGY broad review reached its three-minute timeout without a final
verdict. The separate focused AGY read-only review exited 0 and reported no blocker
in streaming-request-operation.ts, mcp-stdio-continuation.ts,
execution-host-mcp-transport.ts and mcp-session-manager.ts. It explicitly
checked first-write bounds, grant consumption/rechecks, stdout correlation,
bounded continuation, cancellation and the read-only recovery branch.
This is narrow independent evidence, not a comprehensive Runner/relay
security verdict; other process-launch and authority paths still need review.
App sandbox limitations, credentialed stdio restrictions, durable server
opt-in, and nonpersistent prompt state are documented in the feature notes.

Before any deploy:
- Complete independent review of Runner and relay changes; fix findings;
  obtain review of final changes to process authority.
- Run CI/owner portable qualification, including the missing strict OCI
  cases, and signed reproducible release builds for supported targets.
- Review branches and exact commits; obtain authorization for deployment.
- Deploy compatible relay to staging first, then new Runner; verify older
  Runner/client compatibility, paired real devices, task/input forwarding,
  revocation, App rendering, update/rollback, and actual ChatGPT/Claude
  interoperability. Record staging acceptance.
- Only then authorize production rollout with verified image/signature
  and rollback plan. Never publish the local unsigned smoke bundle.
