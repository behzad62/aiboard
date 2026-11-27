# MCP v2 release qualification — 2026-11-27

Successor to [mcp-release-readiness-2026-11-27.md](mcp-release-readiness-2026-11-27.md) (the
implementation handoff). Feature scope and deliberate limits: [mcp-optional-features.md](mcp-optional-features.md).

## Decision: CONDITIONAL GO for staging, HOLD for production

The MCP 2026-07-28 migration is complete within its agreed scope. The local review found no
critical or high defects. It fixed one compatibility defect (it breaks legacy servers), two medium
defects and two low ones. Nothing confirmed and release-blocking is left open in the code.

What still blocks production:

1. **CI qualification has not run.** That means the PR portable-execution workflow, the
   `runner-v2-qualification` label run (all 11 jobs, including Docker OCI on Linux) and the
   macOS/Linux installer legs. The hours-long full Runner suite is left to CI or the owner
   (AGENTS.md).
2. **Staging acceptance has not run.** The staging relay is stopped and not yet deployed, and no
   real ChatGPT or Claude client has been tested against this build.
3. **Owner approvals are still needed**: push and PR, staging deploy, the production relay deploy,
   and the Runner release (which goes straight to stable; see the deployment plan).

## Candidate commits (local, not pushed)

| Repository | Branch | Base | Commits |
| --- | --- | --- | --- |
| ai-discussion-board | `claude/mcp-v2-release` | `68de57d1` (main, Runner 0.3.26) | `61fa3e4d` implementation as found; `4df9073b` review fixes; docs commit on top |
| aiboard-tunnel | `claude/mcp-v2-relay` | `e63c389` (origin/main) | `16b7e67` relay MCP v2 |

`codex/gemini-oauth-return` (`28f845b`) has no commits that `origin/main` lacks; its tree is
identical, so the relay work is based on `origin/main` instead. The relay branch has no upstream,
so a bare `git push` cannot reach `main`. Every previously untracked module is committed, and
packaging reads `git ls-files`.

Release version: **0.3.27** (previous stable 0.3.26, epoch 0, sequence 28; the workflow's `auto`
sequence gives 29). The local bundles are `0.3.27-rc.1`, unsigned and for smoke tests only. Never
publish them. The `0.0.1` smoke bundle from the earlier handoff is superseded.

## Security findings

| # | Severity | Repo | Where | Failure scenario | Fix | Regression evidence |
| --- | --- | --- | --- | --- | --- | --- |
| F1 | High (compatibility) | Runner | `runner-v2/src/runner-internal-execution-context.ts` discovery probe | A legacy stdio server that ignores pre-initialize requests (the repo's own fixture does, and so do some real servers) held the `server/discover` probe for the full 120 s request bound. Discovery's 150 s budget then ran out before the legacy fallback, so the server was never usable and every chat turn stalled. | The probe is bounded at min(request bound, 10 s), the same bound the Tunnel connector uses; the verified reap-and-relaunch is unchanged. | `mcp-lazy-native.test.ts` legacy case: cancelled at 120 s before, now 2/2 pass in ~43 s. |
| F2 | Medium | Runner | `runner-v2/src/extension-mcp.ts` `oauthAuthorization` | A user stop, model abort or the 5 s recovery deadline aborted a token refresh that had already been sent. The issuer had rotated the refresh token, the response was lost, and the next call failed `needs_auth` (or tripped reuse detection and revoked the grant). Concurrent calls also raced two exchanges with the same refresh token. | One exchange per credential revision, shared, not tied to a caller's signal, and stored by the existing compare-and-swap. Callers only stop waiting. | New test in `extension-credential-recovery.test.ts`: fails on the old code (2 exchanges, rotated token lost) and passes on the new code. |
| F3 | Medium | Web | `components/extensions/McpAppCard.tsx` | App code controls when its approval dialog appears. It can time the dialog for the moment the user clicks inside the App, so the layout shift puts the click on "Authorize change once" (clickjacking on write and destructive calls). | Allow stays disabled for 1 s after the dialog appears, the handler also refuses an early approve, and focus starts on Deny. | `scripts/test-mcp-app-host.mts` (real Chromium): an immediate forced click does not approve. With the delay set to 0 the check fails. |
| F4 | Low | Runner | `runner-v2/src/mcp-stdio-continuation.ts` | Once the wire gate was invalid (a server `ping` before its answer, or one stdout delivery over 1 MiB in total), even the exact `notifications/cancelled` was refused. That was a regression from the legacy rule; cleanup still happened by retiring the process. Large multi-line outputs also lost App display. | An invalid gate still refuses every request but allows the one exact cancellation of the pending request. The 1 MiB bound now applies to each frame and to any partial line. | Two new tests in `mcp-stdio-continuation.test.ts`: both fail on the old gate, 12/12 pass now. |
| F5 | Low | Web | `McpAppCard.tsx` | A lint error (`react/no-unescaped-entities`) would fail the mandatory `npm run lint`, and mis-encoded "?" characters showed in the UI. | Fixed. | `npm run lint`: 0 errors. |

Reviewed and found sound (confirmed in code, not taken from comments):

- **Stdio fence.** Exactly one unproven write. Every later write needs a correlated stdout
  response and goes through a canonical-frame `permit`. The continuation must carry the exact
  original name, arguments and `_meta`, plus the server's own `requestState`. Task operations are
  bound to the returned task ID and its creation time. Limits: 8 rounds, 240 polls, 8 updates.
  App `resources/read` is allowed once, and only after a successful completed result. Authority
  is rechecked before every write. App calls and recovery get a fresh run, grant and process, with
  cleanup in `finally`.
- **Remote.** `jobs_mcp_input` is a signed write. It needs the in-flight job owner, `canDispatch`
  (original authorization, epoch, owner lock, current policy) and a single-use prompt. Task
  receipts are AES-GCM encrypted with AAD bound to account, client, device, job, payload digest
  and expiry. Recovery uses `tasks/get` only, never replays, and reconciles atomically.
- **Credentials.** Lineage is replaced on every put. Refresh keeps the lineage only for the same
  pinned client, resource and scope set. Recovery and App calls check the lineage before
  credential access, before dispatch and before returning data.
- **Relay.** Task handles are bound to account, grant and scope; device ownership and revocation
  are rechecked on each call. Direct MRTR state is single-use and in memory, and bound to a
  fingerprint of the exact arguments, the grant, the conversation and the job. `forwardMcpInput`
  cannot be injected: the public schema is strict. Migration 18 is additive. Handles are
  deleted on account deletion and cleared on restore.
- **App host.** Sandbox `allow-scripts` without same-origin, and an enforced CSP prefix that the
  App's HTML cannot weaken. External origins must be exact HTTPS origins, so CSP injection is not
  possible, and they need consent for each view. The bridge checks the postMessage source. No
  Runner token enters the frame. App-only `_meta` is kept out of `mcpOutput`.

Remaining risk, accepted and documented:

- **R1.** Relay `tasks/get|update|cancel` carry no conversation code. Any conversation under the
  same OAuth grant that holds the random UUID can use the handle. The ID is unguessable and never
  shown to other conversations.
- **R2.** On a user stop or deadline, `tasks/cancel` usually isn't sent: authorization is already
  revoked, and the process is retired instead. A server that opted into `io.aiboard/durable-tasks`
  may keep the task running. Cancellation is documented as best effort.
- **R3.** A modern stdio server slower than 10 s to answer `server/discover` is treated as legacy
  for that discovery. The outcome is still consistent: the live handshake also uses `initialize`.
- **R4.** App self-navigation can still make requests. Tool annotations are server claims, and an
  approved external origin is trusted code. All of this is documented in the App sections.

Independent review: a separate reviewer agent was given the code only, without these conclusions,
and reviewed the fencing modules and their integration. It reported no critical, high or medium
findings and three lows (F4, R2, and recovery from a read request, which keeps the full
policy rechecks). It then re-reviewed the three fixes to process lifetime and fencing (F1, F2, F4)
and found them sound. The earlier AGY review of four modules was narrower and is superseded. The
Codex and Claude Code review attempts recorded in the first handoff hit usage limits.

## Validation evidence (Windows 10, Node 24, this machine)

| Check | Result |
| --- | --- |
| `npm run typecheck:runner-v2` | exit 0 (before fixes, after fixes, after the gate fix) |
| `npx tsc --noEmit` (root) | exit 0 |
| `npm run lint` | exit 0, 0 errors, 184 warnings that were already there |
| Runner baseline, 19 affected files, pre-fix | 284 tests: 281 pass, 0 fail, **1 cancelled** (F1), 2 skipped (Docker not running) |
| Runner after fixes (files rerun at `4df9073b` or with the same sources) | mcp-stdio-continuation 12/12, mcp-modern-protocol 4/4, mcp-lazy-native 2/2, mcp-transport-authority 9/9, mcp-rpc-peer 31/31, extension-mcp 10/10, extension-mcp-remote 17/17, extension-credential-recovery 2/2, mcp-discovery-protocol 10/10, mcp-tools 50/50 (0 skipped), chat-agent-extensions 3/3, filesystem-mutation-routing 2/2, remote-jobs 22/22, remote-connector 70/70, remote-admission 13/13, mcp-chat-app 11/11, mcp-chat-input 2/2, mcp-optional-features 10/10, local-stdio-mcp 7/7. **Total on final sources: 287 tests, 287 pass, 0 fail, 0 skipped**, every file exit 0 |
| Strict OCI, `RUNNER_V2_REQUIRE_DOCKER=1`, Docker 29.9.3, cached `node:24-slim` (no pull) | `mcp-tools` strict public MCP identity: pass. `managed-strict-oci`: failed once on a cold Docker Desktop start (its 5 s output poll, unchanged), then passed 1/1 on a warm engine. Linux CI qualification still needed. |
| Real Chromium App host (`scripts/test-mcp-app-host.mts`) | PASS: consent, offline mode, CSP, opaque origin, denials, approval arming, approve/deny |
| Release import closure (`scripts/release/test-bundle-closure.mts`) | PASS on the committed tree |
| Installer unit tests (manifest, archive, self-update, launcher lock, adapter policy) | 55: 53 pass, 2 skipped (POSIX symlink cases on Windows) |
| `test-installers`, `test-signing-sequence`, `test-sequence-reservation` | all PASS |
| `build-bundle --version 0.3.27-rc.1 --target all` from `4df9073b` | 6 bundles built in 66 s. win-x64 sha256 of the zip is in the build log. The packaged `aiboard version` prints 0.3.27-rc.1 and `aiboard doctor` exits 0. The bundle ships the new modules and `@modelcontextprotocol/ext-tasks`, which loads. |
| Tunnel `npm test` (build plus every package) | 584 tests: 580 pass, 4 fail, none caused by this change. 2 are stale `billing/dist` outputs whose sources were removed. 1 is `deploy-config`, which reads `.github/` relative to the package cwd. 1 is `device-route-ops` "malformed device codes", which fails the same way on a clean `origin/main` build. mcp-gateway, storage, account-deletion and connector suites all pass. |
| Not run locally | `npm run build` (a server already listens on :3000, and the build rewrites tracked `public/` zips; Deploy AI Board builds and runs `test-deploy-runner-artifacts`). Relay Docker image build (needs a base image pull; Publish relay image builds and smoke-tests it). Full `test:runner-v2` (CI or the owner). |

Protocol conformance relies on the official SDKs: `@modelcontextprotocol/server`/`client`/`core`
2.4.0, `ext-tasks` 0.2.3 (its v2 schemas validate every task, MRTR and elicitation message on
both sides) and `ext-apps` 2.0.4 (AppBridge). It is exercised against real SDK servers in
`mcp-modern-protocol`, `extension-mcp-remote` and relay `mcp-gateway`. MCP 2026-07-28 is the
released spec version. Everything above is mock-server or local-process testing; no deployed
interoperability has been tested yet.

## Git integration plan

1. Owner reviews the three AIBoard commits and the relay commit.
2. Push `claude/mcp-v2-relay` and open a PR to `main` in behzad62/aiboard-tunnel. Push
   `claude/mcp-v2-release` and open a **draft** PR to `main` in behzad62/aiboard, then add the
   `runner-v2-qualification` label to run all 11 qualification jobs, Docker OCI included.
3. Merge the relay PR first. **Do not merge the AIBoard PR until the production relay runs the
   new image**: a push to AIBoard `main` deploys aiboard.me, including the
   `aiboard-runner-v2.zip` download built from `main`.

## Deployment plan

Order, from the compatibility facts:

- A new relay works with old Runners. It does not send `forwardMcpInput` or `mcpInput` to a device
  that doesn't report `mcpTaskInput`. Its task handles only use `jobs_status`, `jobs_result` and
  `jobs_cancel`, which old Runners already support.
- An old relay **refuses the new Runner's status frame** (an unknown `mcpTaskInput` key logs
  `malformed_status`), so devices lose their state, policy and shells in `devices_list`.
- Therefore: relay before Runner, everywhere.

1. **CI.** Merge the relay PR after its review. The AIBoard draft PR must pass portable execution,
   runner-bundle-closure, the installer workflow and the labelled qualification run.
2. **Relay image.** Dispatch *Publish relay image* (aiboard-tunnel) on `main`. Record the
   printed digest; the workflow already smoke-tests `/healthz`.
3. **Staging backup.** Start staging (*Stop or start staging relay*, `action=start`), stop the
   container, then on the host run the README "Backup and restore drill": `VACUUM INTO`,
   `PRAGMA integrity_check` must print `ok`, and `MAX(version)` must be 17. Keep the file
   off-host.
4. **Staging relay.** *Deploy relay*, `target=staging`, `image_digest=<digest>`. It checks
   `/readyz` and rolls back automatically on failure. Confirm that the schema is now 18.
5. **Staging Runner.** There is no staging release channel: *Runner release* signs and publishes
   to stable from `main`. On a test machine, run the CI-built (or local `0.3.27-rc.1`) bundle
   from the PR head with `aiboard remote --relay-url <staging relay> --relay-root-key <staging
   root>`. Also keep a 0.3.26 Runner paired to staging.
6. **Staging frontend.** Not separately deployable; aiboard.me deploys from `main`. For staging,
   serve the PR build locally (`npm run dev` on a free port) against the rc Runner.
7. **Staging acceptance (real deployed services).** Record each result.
   - 0.3.26 Runner on the new relay: pair, `devices_list` (status, shells), tools, `jobs_*`,
     plus a Tasks-capable client creating a task for a long `process_run`.
   - rc Runner on the new relay: status accepted, `devices_list` dashboard App renders.
   - ChatGPT and Claude connectors: OAuth sign-in, token refresh after expiry, tool discovery and
     execution, `show_image` and dashboard App rendering.
   - Long-running Task: `tasks/get` until done; `tasks/cancel` mid-run.
   - MRTR: a managed HTTP server that elicits input, run once through Tasks (`tasks/update`) and
     once directly (`requestState`). Replaying a state is refused, and token expiry ends it.
   - Native chat Apps: read-only App call; write call (explicit allow needed); approval delay;
     external-origin consent and the offline option; dismiss during a call.
   - Revocation: revoke the device or grant during a pending task or prompt; the next call fails.
   - Interrupted recovery: restart the Runner during a durable task, then `jobs_status`
     reconciles. Restart the relay; task handles survive and direct states are discarded.
   - Upgrade and rollback: update the rc Runner from the 0.3.26 installer path, and back.
   - Stop staging afterwards (owner rule).
8. **Production relay** (needs its own owner approval). Back up production as in step 3, then
   *Deploy relay* `target=production` with the same digest. Watch `/readyz`, device reconnects
   and the `malformed_status` count (expected 0).
9. **Runner release** (owner approval; each release needs a fresh go in words). Merge the AIBoard
   PR, which deploys aiboard.me. Then dispatch *Runner release* with `version=0.3.27` and
   `sequence=auto`, from `main`'s tip. The owner approves the `release` environment. It builds
   on Linux and Windows (byte-identical), smokes, signs, publishes and redeploys the site.

Rollback:

- **Runner.** Publish a higher-sequence manifest pointing at the previous bundles, since
  sequences only move forward (`check-publication-order`). The new relay serves 0.3.26 Runners
  unchanged.
- **Relay.** Deploy rollback is automatic until `/readyz`. After schema 18 has started, the old
  image refuses the unknown schema version. A deliberate rollback means stopping the relay,
  restoring the verified pre-deploy backup (losing changes since then: pairings, grants, usage,
  task handles), then deploying the previous digest. Prefer a forward fix.
- **Order of rollback.** Roll the Runner back before the relay. Otherwise new Runners hit an old
  relay that refuses their status.

No configuration changes, new secrets or signing-key changes are needed.

## Remaining limitations

- **Release blockers:** the CI qualification and staging acceptance above, plus owner approvals.
- **Acceptable, documented:** R1–R4. Also: no recovery of pending prompts after a restart. App
  calls from a credentialed stdio server are read-only only. Durable stdio recovery requires the
  server to opt in. URL elicitation, sampling and roots are unsupported. An `input_required`
  response with only `requestState` is treated as an unknown outcome (conservative). A slow
  legacy server can still exceed the discovery budget, which fails closed.
- **Future, optional:** conversation binding for relay task handles; sending `tasks/cancel`
  under a stop-time authority; reproducible signed bundles for staging; removing the stale tunnel
  billing `dist` tests and fixing `deploy-config`'s cwd and the existing `device-route-ops`
  failure.
