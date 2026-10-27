# Native tool improvements and user-managed extensions

Status: implementation specification; no implementation or live calibration authorized by this document alone.

Date: 26 October 2026. Repository: AI Board (`D:/repos/ai-discussion-board`).

Authoring baseline: `ae9e75192e54c0b52b805a2f23bf5f2cf97bf03e`. Reinspect the current checkout and applicable `AGENTS.md` before implementation; other work may advance it.

## 1. Product outcome

Users can manage skills, MCP servers and plugins from a clean Settings interface, or ask an AI Board agent to install and configure them. Both routes use the same Runner-owned service, authorization rules, durable operation records and readiness checks. A successful agent installation makes the capability usable in the requesting conversation at the next supported boundary, without requiring the user to restart the whole application or edit configuration files.

Build agents also gain three practical native capabilities: interactive process input, incremental/ranged process-output reads, and resumable content searches. Local image inspection is required for vision-capable UI work. These improvements must use existing execution, permission, accounting and evidence infrastructure.

This is an AI Board feature. The reference to ChatGPT is a UX analogy, not a requirement to access ChatGPT's installed plugins, reproduce its internal APIs, or install software into another application's directories.

## 2. User decisions and boundaries

- ToolBench remains a **solo model** benchmark. It must not create a Build, Architect, reviewer, integration or documentation workflow.
- HarnessBench remains the Recoverable Job Service signature benchmark using **Architect + Worker + Reviewer/Verifier**, with separate model choices and same-model role reuse.
- Measure correctness, tokens, cost and time separately. Spending/time limits are emergency guards, not artificial benchmark difficulty. Keep the existing fivefold ToolBench guard values unless the user requests a change.
- Benchmark coverage should target useful capabilities and failure modes, not every tool name. Avoid repetitive filler and duplicate cases for equivalent editing protocols.
- Product UI must have clear purposes. Do not restore the removed Advanced WorkBench/TeamIQ launcher or introduce a second competing settings workflow.
- An explicit installation request must be actionable by the agent. Do not implement a feature that only responds with instructions to edit JSON or run commands manually.
- Do not make users approve the same unchanged action repeatedly. Preserve valid authorization across turns and operation retries. Ask only for missing choices, credentials, new trust/access, or a policy-required concrete approval.
- No paid benchmark/model calls, deployment, push or release promotion is part of implementing this spec unless separately authorized. The current live calibration is paused before the next run.

## 3. What already exists

Reuse and extend these components; verify their current contracts before coding.

| Existing area | Current implementation / limitation |
| --- | --- |
| Native execution | `runner-v2/src/execution-host.ts`, streaming-session runtime and platform backends own grants, process identity, fencing, output and cleanup. Internal duplex/input machinery exists; there is no ordinary model-facing managed-process input tool. |
| Managed process tools | `managed-process-tools.ts` exposes start, poll, list and signal. `ManagedProcessRunRuntime` exposes start/observe/stop. Poll returns bounded stdout/stderr tails without caller-selected output cursors or ranges. |
| Filesystem and artifacts | `filesystem-tools.ts` has bounded reads, search, recursive listing, revision-protected write/patch, move and delete. `artifact-tools.ts` already supports bounded artifact ranges. Content search has a match cap and truncation flag, but no continuation cursor. |
| Repository intelligence | `repository-intelligence.ts` and `code-intelligence-tools.ts` already provide repository manifest/map and language queries. Manifest pagination is not content-search pagination. |
| Skills | `skill-catalog.ts` discovers project and shared roots with provenance/digests. `skill-tools.ts` exposes `list_skills` and `read_skill`. `skill-routing.ts` ranks relevant skills. `BuildSkillsPanel.tsx` displays routed skill evidence, not installations. |
| MCP | CLI `--mcp`/`--mcp-envelope`, strict configuration parsing, verified discovery, lazy exact-agent sessions, schema identity, execution grants, and cleanup already exist. `GET /v2/mcp` is status, not an installation API. Current native server specs use executable commands; add remote transport deliberately. |
| Trusted plugins | `plugin-loader.ts`, `runner-extension.ts`, `capability-registry.ts` and `extension-runtime.ts` support trusted local ESM extensions with captured module closures and governed registration. They are not an arbitrary npm module loader or sandbox. |
| Capability identity | `runner-capability-contract.ts` binds executable/configuration/module identities. Existing active Build recovery fails closed on incompatible changes. Preserve that guarantee. |
| Settings | `app/settings/settings-client.tsx` and `ToolRuntimeSettingsPanel.tsx` expose Runner setup and one provider-hosted remote MCP setting. That single setting is not a multi-server native management system. |
| Visual input | User media and some account-runtime image-artifact forwarding exist. Generic `fs.read` produces opaque binary artifacts; `artifact.read` produces base64 text. API adapters generally serialize tool artifacts as text. Do not mistake this for consistent model-visible local image inspection. |
| Architecture | Static-export Next.js/browser app; authenticated localhost Runner V2 is the backend. No Next API routes and no revival of the legacy Build engine. |

## 4. Required native tool work

Tool names below are proposed public contracts. Keep naming consistent with existing tools; document any justified change. Extending a tool is preferable to adding overlapping aliases.

### N1. Interactive input to an owned process

Add `process.write_stdin` with an owned `processId`, bounded UTF-8 input, explicit end-of-input option, and a write idempotency identifier. Starting a process declares whether interactive stdin is enabled. Default noninteractive commands retain existing behavior.

Requirements:

- Implement through `ExecutionHost` and the shared streaming-session authority. Do not create a second subprocess host, direct shell route, or raw handle/PID authority.
- Reuse exact run/session/actor ownership, execution grants, sequence checks and fencing. A model can never address an MCP/LSP/internal control pipe as an ordinary process.
- A repeated call with the same idempotency identifier and payload must not send input twice. A changed payload with that identifier is a conflict.
- Preserve ordered writes and backpressure. Return an acknowledged write outcome, not an optimistic success immediately after enqueueing. Report interrupted/uncertain outcomes honestly; never replay uncertain input automatically after restart.
- Separate submitting input from waiting for output. Do not infer success from a guessed prompt regex. Include bounded wait support in the output-read operation instead.
- Support EOF as a distinct operation; do not conflate it with SIGINT. Explicit append-newline behavior must be documented.
- Revalidate authorization on writes, not only on process startup. Redact sensitive input in logs; retain call identity, byte count and outcome without logging secrets.
- Required initial coverage is line-oriented stdin/REPL interaction. Full PTY/TUI emulation is a separately advertised optional capability; do not pretend pipes are a terminal.
- Implement and test supported Windows and portable/OCI paths. Unsupported environments return a typed capability error before an irreversible write.

### N2. Incremental and ranged process-output reads

Extend `process.poll` or add `process.read_output`; keep poll's existing status behavior compatible. Support per-stream opaque cursors, explicit earlier ranges and bounded tail reads. New clients should normally ask for only new output.

Return process status plus `stdout`/`stderr` slices, stream offsets, next cursor, whether more data exists, and explicit retention/truncation/loss facts. Cursor state is caller-held: one reader must not consume another reader's view.

- Cursors bind to exact process/launch identity and output generation. Reject foreign or stale cursors without reading another process's data.
- Reuse existing bounded spooling/artifacts and continuation machinery. Do not duplicate unlimited logs in SQLite or memory. Earlier output is accessible only while retained under the documented quota.
- State a concrete default per-call byte limit and total retention quota in implementation documentation. Quota exhaustion must be visible; retained output must never be represented as the complete stream if bytes were dropped.
- Allow a bounded wait for new output or termination; cancellation ends the wait, not the process. No unconditional sleeps or busy loops.
- Preserve stdout/stderr stream ordering metadata, handle split UTF-8 characters, and keep terminal exit/signal facts separate from output availability.
- Completed and recovered historical sessions must have honest read-only output semantics. Loss or unsupported historical replay cannot silently return an empty success.
- Existing artifact reads for completed one-shot commands remain supported. The gap is convenient, governed live-process observation, not absence of all output storage.

### N3. Resumable repository content search

Extend `fs.search` with opaque continuation support, filename/glob include/exclude filters, bounded context lines and a clear scope summary. Use a session-backed implementation where necessary; do not require four public tools merely to page a small search.

- Preserve literal/regex options and Git-aware tracked/untracked/ignored behavior. Reuse existing hidden/protected-path restrictions and declared workspace access.
- Return first useful results promptly. Bound scan work, elapsed time, memory, result bytes and total retained results. Prefer a proven search backend; use any executable through the appropriate governed execution path, not an uncontrolled spawn.
- Pages must not repeat or skip matches within a stable result generation. Bind a cursor to owner, normalized query, scope and snapshot/generation. A changed workspace either continues the declared snapshot or returns a typed stale-search response; never silently mixes revisions.
- Return explicit states: running, complete, capped, cancelled, timed out, partial or failed. Explain inaccessible/skipped paths and whether a zero-match result is exhaustive.
- Support cancellation and expiry/cleanup. Expiry must be distinguishable from no matches. Access revocation blocks future pages.
- Keep existing simple calls working. Do not count rerunning a capped query with a larger limit as pagination.

### N4. Local image inspection

Add `image.inspect` (or an equivalent explicit artifact operation) for workspace paths and authorized image-artifact references. Return validated native image content to image-capable models through each supported provider adapter, with dimensions, media type and source digest.

- Support PNG/JPEG/WebP initially. Detect actual content, enforce byte/dimension/decompression limits, normalize orientation, and provide bounded resize/crop options where useful.
- Apply workspace/read permissions and artifact ownership. A tool argument must not grant arbitrary host-file access.
- Deliver image content as the provider's visual input representation, not base64 text or just an artifact hash. Include newly produced browser screenshots in the same visual continuation path.
- A text-only model gets a clear unsupported-modality result and metadata; never claim the model saw the image. Do not silently send it to another model/provider.
- Respect context/media quotas and record source/derivative identity. Image contents must not be repeatedly attached to every future turn. Retain original and derived artifact provenance without mutating source files.
- Document SVG as text or explicitly rendered content; do not execute arbitrary embedded content as an image read.

## 5. One extension-management product

Add **Settings → Extensions**, with three sections/tabs: **Skills**, **MCP servers**, **Plugins**. Keep Runner connection setup in Tools and link to it when unavailable. Avoid a separate marketplace requirement for the first release.

The UI must provide:

1. A unified inventory with name, kind, source, pinned version/revision, user/project scope, enabled state, readiness, update availability and last error.
2. Add/import from a supported source; inspect a resolved source and what it contains before execution. Permit local source selection and paste-a-link workflows. Do not rely exclusively on `showDirectoryPicker`: native Runner browsing/path validation and archive upload must work when browser permission handoff fails.
3. Install/connect, enable/disable, test connection, inspect available tools/skill content, update, rollback and remove. Distinguish disconnecting a server from uninstalling a managed package and revoking credentials.
4. Human-readable permissions/access and dependencies. Advanced executable/args/environment details are available in item details, not dumped into the default flow.
5. Structured progress and an actionable failure state. Distinguish downloaded, installed, configured, authenticated, enabled, ready, pending activation and restart required. A saved form or successful package download is not a working integration.
6. A conversation operation card for agent-initiated changes showing the same operation and status as Settings. Credentials/authentication interactions open the appropriate UI, not an agent prompt asking the user to paste secrets into chat.

Scopes:

- **User**: available to this AI Board user's runners on this machine, under AI Board-owned user storage.
- **Project**: available only to the selected project. Keep project settings shareable, with secret references and machine-specific resolution outside the repository. Project-managed skill publication to `.agents/skills` is an explicit versioned project change; it must respect Build worktrees/commits and existing files.
- The shared package store and operation state live outside user projects. Do not mutate other applications' skill/plugin directories or silently adopt their credentials. Existing externally discovered skills may be listed read-only with their provenance.
- Resolve duplicate names using stable IDs and explicit precedence. Show which source won. Do not silently overwrite a project skill or shadow a built-in native tool.

## 6. Shared backend and persistence

Introduce an `ExtensionManagementService` (name may vary) composed by Runner V2. Browser UI and model administration tools call the same service. Filesystem/package-manager operations never execute in the browser.

Use a versioned registry outside the project, a content-addressed/versioned package store, encrypted credential references and a durable operation journal. Browser storage holds display preferences and connection references; Runner records are authoritative for installed state. Reuse current encryption/key-storage patterns without putting credentials in public manifests.

Each installed item records at least:

```ts
type ExtensionKind = "skill" | "mcp_server" | "plugin";
type ExtensionScope = { kind: "user" } | { kind: "project"; projectIdentity: string };

interface InstalledExtension {
  id: string; // stable, not a display name or filesystem path
  kind: ExtensionKind;
  name: string;
  scope: ExtensionScope;
  source: ResolvedSource; // provenance, exact revision/version and integrity digest
  enabled: boolean;
  desiredGeneration: number;
  activeGeneration?: number;
  readiness: ExtensionReadiness;
  componentIds: string[];
  credentialRefs: string[]; // identifiers only, never secret values
  previousVersionIds: string[];
}
```

Define `ResolvedSource`, `ExtensionReadiness`, operation and manifest schemas as real validated types; the sketch above is not an acceptance of arbitrary unknown fields.

Every mutation is an idempotent operation with owner, action, target, scope, request fingerprint, resolved plan digest, authorization reference, progress, stage, terminal outcome and bounded diagnostic artifacts. Reusing an operation key with changed inputs is a conflict. Retrying after browser/Runner restart reconciles the existing operation rather than reinstalling or re-running hooks blindly.

Suggested operation stages: resolve → inspect/validate → await missing authorization or credentials if needed → stage/download → install dependencies if required → validate/discover → commit registry → activate → ready. Use explicit failed/cancelled/outcome-unknown and rollback states. Separate durable installed state from live connection state.

Installation updates must be atomic at registry publication. Preserve the last working version when an update, authentication or discovery check fails. A plugin's required components publish together; report optional component failures explicitly. Restart recovery must distinguish safe read-only retries from executable work whose outcome is unknown.

Remove/disable must stop or retire only owned resources, invalidate future tool admission and preserve resources needed by pinned history/active runs. Uninstall removes only installation-owned files; it must never recursively delete a user-supplied source folder. Retain bounded audit/tombstone metadata and explicit credential-revocation controls.

## 7. Skills

Support a local skill directory, uploaded archive and Git repository/subdirectory at a resolved commit. Multiple skills in a repository require explicit selection or a displayed bundle selection. A single `SKILL.md` upload can create a one-file skill; report missing referenced assets instead of silently inventing them.

- Validate the published Agent Skills structure/metadata for new managed installs. Preserve support for existing legacy-discovered documents rather than retroactively hiding them. Handle YAML safely; no executable tags or metadata-as-permission behavior.
- Preserve relative `scripts/`, `references/` and `assets/`; reject path traversal, link escapes, archive bombs and collisions. Define bounded file counts/sizes.
- Installing a skill does **not** execute its scripts, shell snippets or instructions. Declared dependencies are inspected, and any dependency installation uses the same authorized operation mechanism. Running scripts later remains an ordinary governed tool action.
- `allowed-tools` and prose are suggestions/requirements to validate, never authority to expand tool permissions, install other software, reveal secrets or override the user.
- Existing `list_skills`/`read_skill` must discover enabled managed skills with source, scope, version and digests. Provide supported bounded reads of referenced assets; shared skills outside the worktree must not become unusable because the filesystem tool cannot reach them. Script execution uses immutable managed content through existing execution authority, not arbitrary host paths.
- Progressive disclosure: list metadata, rank relevant skills, read selected instructions/resources. Do not inject every installed skill's full text into every prompt.
- Enabled/disabled state and source precedence must be consistent in Settings, discovery, task routing and exports. Skill edits/updates invalidate stale cached reads and create a new digest/generation.

## 8. MCP servers

### 8.1 Local stdio servers

Support registering an already installed executable and installing a managed server package. Required managed recipes are pinned npm packages and pinned Python packages in private environments when the corresponding supported runtime is available. Support local/Git sources through an explicit reproducible recipe. Missing runtimes produce an actionable requirement; never silently install system runtimes or request elevation.

- Structured executable + argument arrays are authoritative. Preserve current exact parsing/attestation semantics for legacy CLI configuration. No arbitrary model-generated shell interpolation.
- Resolve package versions before install; keep lock/integrity metadata and the actual executable/module identity. Runtime startup must not use `npx ...@latest`/`uvx ...@latest` to download or change code implicitly.
- Install dependencies in AI Board-owned isolated directories/environments. Package install scripts are executable code and participate in the displayed/authorized trust decision and operation limits. Do not run unreviewed arbitrary post-install hooks from skill/plugin prose.
- Record required environment variable **names** and secret references. Inject only approved credentials into the owned process. No blanket ambient environment or model access to secret values.
- Reuse current verified discovery and lazy per-agent MCP sessions. Test readiness via handshake and tool discovery, not by executing arbitrary advertised tools. Use a bounded read-only smoke tool only where explicitly specified and authorized.
- Preserve schema-change, executable-change, restart and cleanup behavior. Tool annotations are hints, not sufficient authority for effects or access. Add new tools to role surfaces only through the admission policy.

### 8.2 Remote servers

Support multiple Runner-hosted **Streamable HTTP** MCP connections, including no-auth, explicit bearer/API credentials and standard OAuth where required. Pin and document the supported negotiated protocol versions. Legacy HTTP+SSE support is optional and must be labelled separately if implemented.

- Centralize remote calls in the Runner so ordinary function-tool-capable models can use them; provider-hosted remote MCP remains a separate opt-in execution route, not a silent fallback.
- Use the MCP authorization standard for HTTP connections. Validate authorization/resource metadata, PKCE/state, token audience/resource, expiry and scope changes; refresh secrets inside the credential service. Authentication that needs user interaction returns `needs_auth` and resumes the same operation afterward.
- HTTPS is the default; allow explicit localhost development endpoints under existing policy. Validate outbound destinations and redirects, protect against unintended private-network access, and never forward credentials across origins automatically. No arbitrary OAuth metadata URL should become an unrestricted fetch primitive.
- Connection tests, retries, reconnection and cancellation have finite bounds. Do not duplicate a possibly mutating remote tool call after ambiguous delivery. Preserve the existing distinction between certain failure and unknown outcome.
- Track per-server/tool permissions and scope, schema identity and audit attribution. Enabling a server does not automatically expose every destructive tool to every role.
- No unsolicited sampling, elicitation or server-initiated operation may make model calls, request credentials or perform external actions without going through the corresponding existing policy. Unsupported MCP capabilities are negotiated/refused explicitly.

### 8.3 Existing settings migration

Migrate the single `remoteMcpServer` setting idempotently into the Extensions inventory, preserving its enabled state and **provider-hosted** execution route. Do not silently move tokens to a new destination or start calling it through Runner. Offer an explicit migration to Runner-hosted access, with credential custody and behavior explained.

CLI-configured MCP entries remain usable and visible with provenance. Support adopting them into managed configuration explicitly; do not overwrite launch arguments or create duplicate connections automatically.

## 9. Plugins as bundles

A user-facing **plugin** is an AI Board package that can bundle skills, MCP server definitions/managed recipes and an optional existing trusted Runner extension. It is not synonymous with a single skill, an MCP server, or arbitrary executable code in the browser.

Define a versioned `aiboard-plugin.json` schema with stable ID/name/version, source/license metadata and explicit component declarations. Components use contained paths and the contracts above. Manifest data cannot supply authorization receipts, bypass access policy, replace lifecycle tools or change completion/verification semantics.

Example shape (illustrative; implementation must publish a complete schema):

```json
{
  "schemaVersion": 1,
  "id": "example.docs-workflow",
  "name": "Documentation workflow",
  "version": "1.0.0",
  "skills": [{ "path": "skills/docs" }],
  "mcpServers": [{ "id": "docs", "definitionPath": "mcp/docs.json" }],
  "runnerExtensions": []
}
```

- Reuse the existing trusted extension manifest/loader for executable Runner components. Preserve complete module-closure validation, immutable execution copies, forbidden lifecycle registration, tool-name collision checks and cleanup. Do not add dynamic npm imports to the Runner process.
- Executable Runner plugins require explicit trust under policy. A label such as “read-only” or “official” from the package is not proof. Show source and requested access, without claiming isolation that the loader does not provide.
- Bundle ownership/reference counting prevents removing a shared dependency used by another plugin. A skill-only plugin must not require executable-plugin trust.
- External plugin formats are not assumed compatible. Detect known unsupported formats and explain their missing components; never silently ignore hooks or pretend the plugin works. Adapters can be later features.
- A first release needs add-by-source/import, not an unaudited public marketplace. Optional curated search must use an explicit catalog with provenance; search results do not authorize installation.

## 10. Agent-initiated installation

Expose provider-neutral management tools backed by the service. Suggested minimal surface:

| Tool | Purpose |
| --- | --- |
| `extensions.list` | Inspect installed items/readiness in the caller's permitted scope. |
| `extensions.inspect_source` | Resolve metadata/components/dependencies for a supplied source; no package scripts or server execution. |
| `extensions.plan_change` | Prepare a concrete install/update/enable/disable/remove/rollback plan and its digest. |
| `extensions.apply_change` | Execute an authorized immutable plan idempotently; it cannot accept model-supplied approval flags or raw credentials. |
| `extensions.operation_status` | Get structured progress, bounded diagnostics and any concrete user action required. |

A catalog search tool is optional; direct source installation is required. Planning and applying can be combined internally when authorization is already sufficient, without extra user round trips.

Required behavior for “Install the skill at <URL> for this project”:

1. Resolve the exact source and project, inspect and stage the bounded package, and make a concrete plan.
2. Associate the plan with trusted human intent/standing policy. Proceed automatically when the existing authorization covers the resolved source, action and access. Do not ask “Should I install it?” again merely because it was requested in chat.
3. If something material is missing, show one concise operation card for that concrete issue. Examples: choose one of several same-named packages; approve newly introduced executable code/access outside existing policy; sign in to the intended MCP service; provide a credential through a secret field. Continue unrelated work where possible.
4. Install, validate, activate, rediscover and make the new skill/tools available at a supported turn boundary. Report the actual source, version, scope and readiness. Only claim successful use after a real discovery/read/tool result establishes it.

Authorization is **not** a model argument such as `userApproved: true`. Derive it from authenticated UI actions, the original human message context and/or a user-controlled standing installation policy. Bind receipts to action, target/source, scope, plan digest, access and expiry. The requesting model cannot mint a receipt, broaden one, or pass retrieved README/skill/MCP text as human intent. A resolved named catalog item may reuse an explicitly trusted source policy; an ambiguous name requires a real choice.

Do not treat Full access to project files as blanket authority to grant new account scopes, reveal provider keys, change security settings or install arbitrary code machine-wide. Conversely, do not impose an unconditional approval modal on every instruction-only skill install or retry of an already authorized operation.

Availability and roles:

- Native Build: expose management to the user-facing Architect/coordinator under the appropriate role policy. Workers/verifiers can discover/read permitted installed capabilities but cannot independently install or expand global capabilities. A worker can request a capability through the coordinator.
- Single-model Chat: provide a narrow authenticated Runner administration bridge and proper tool-result continuation across supported provider transports. Installation must not require starting a full Build. If the Runner is unavailable, link to connection setup and retain the pending request.
- Panel/debate/specialist: only one designated user-facing coordinator can mutate installation state. Other participants cannot race to apply the same operation.
- Models without function-tool capability are shown as unsupported for agent-managed installation; the Settings flow still works. Do not imply every provider/model can do it.
- Existing and newly installed MCP tools remain role-gated and accounted through the ToolBroker. Management is not a tool-call bypass and cannot call arbitrary newly discovered tools as an installation check.

## 11. Activation and active-run identity

Installing into the registry and making a capability usable are separate operations. Preserve immutable run contracts and existing recovery guarantees.

- New runs bind a versioned snapshot of enabled skills/MCP/plugin components, executable/package identities, discovered schemas and access configuration. Record that identity in evidence and benchmark profiles. Credentials stay outside snapshots; bind references and permission configuration rather than raw secrets.
- For skills and MCP installed at the user's request during an active conversation, implement an explicit **capability-generation transition** at a quiescent turn boundary. Persist before/after identity, authorizing operation and admission results. Stop admission to affected sessions, settle/close owned resources as required, retain old snapshots, then construct fresh tool/skill catalogs for future turns.
- Do not rewrite an existing snapshot in place, silently alter another active Build, or treat a recovered run with changed bytes as identical. Concurrent tool calls and in-flight mutating calls must settle or cause a typed pending/blocked transition; never replay them merely to activate an extension.
- The requesting conversation can continue with the new generation without restarting paid work. Other runs retain their pinned generation until an explicit supported transition. A global disable/revoke blocks new calls immediately under policy; affected active runs visibly need attention instead of silently continuing with revoked access.
- Trusted in-process Runner extensions may require a controlled Runner restart. Initially support installing/staging them with `pending_restart`, retaining active builds and offering restart at a safe boundary. Do not hot-import arbitrary replacement code or claim the plugin is ready before restart/preflight. Document this limitation in UI and agent results.
- Defer deletion of versions used by active generations. Restart recovers operation/transition state and does not automatically resume paid calls or uncertain executable actions.
- Benchmark attempts freeze capability identity for the attempt. Installation/update/activation tools are not generally exposed to a benchmark model. Dedicated extension-management benchmark fixtures use an isolated fake registry/source and cannot change the user's real environment.

## 12. APIs, events and secret handling

Add authenticated versioned Runner endpoints for inventory/source inspection/plans/apply/status, credential submission/authentication initiation and capability activation. Suggested root: `/v2/extensions`; use the existing control-plane origin/authentication rules, bounded request bodies and typed errors. Do not place executable commands or tokens in browser URLs.

The browser client in `lib/client/runner-v2.ts` uses lightweight public DTOs. It must not import Node-only service graphs. Use existing event/SSE patterns where suitable; polling requires bounded intervals/backoff and reconnect-safe operation IDs.

Both UI and model results receive redacted metadata. Secret values are submitted from dedicated user UI directly to the Runner credential service; OAuth tokens remain there. Browser history, model prompts, tool arguments/results, process diagnostics, crash reports, exported benchmark bundles and project commits must not contain credentials. Export/import includes nonsecret definitions and unresolved credential references, not usable secrets by default.

Enforce permissions for management itself, source reads/downloads, installer execution, activation and subsequent tool calls. An install permission is not permission for the server to send email, modify accounts or access unrelated files. Remote tool effect decisions must remain conservative when annotations are missing or misleading.

## 13. ToolBench coverage after the tools work

Implement focused deterministic fixtures after native behavior is stable. Keep current six core tasks. Add or adapt:

| Case/profile | Required evidence |
| --- | --- |
| Repository/code navigation | Locate the relevant definition/callers and make a small correct change using repository/language tools; avoid forced redundant inspection. |
| Git inspection | Correctly distinguish current changes from an earlier revision using a small local repository. No external remote/push. |
| Artifact retrieval | Find one relevant fact beyond an inline-output boundary without repeatedly reading filler. |
| Project skill | Move the existing inexpensive skill-discovery/use case into the standard pack. |
| Interactive process/output | One owned line-oriented fixture requires an input response, incremental output read and correct exit/cleanup. Verify duplicate input is not delivered. |
| Continued search | A useful target occurs beyond the first bounded page; require successful continuation and correct target evidence. |
| Optional browser/visual | Strengthen the owned-server browser profile with a form interaction and observable persisted result. For a vision-capable profile, require a local screenshot/image observation with a deterministic visual answer. |

Keep roughly ten standard cases by combining naturally related actions where appropriate; do not force that count if it would conflate distinct failure attribution. Process/search additions justify a few more cases than the earlier ten-case estimate. Browser/vision remain separately identified profiles. Do not require one model to call both `fs.patch` and its provider-native equivalent.

Add a coverage manifest connecting each case to capabilities it requires, acceptable production tool alternatives and assertion evidence. Results must distinguish **available**, **actually exercised**, **verified**, **not tested**, **unsupported**, and **excluded by environment**. A pack pass cannot claim full native-tool coverage. Tool-name use alone does not establish behavioral success.

Retain external hidden deterministic scoring; never send grade feedback into the model loop. Public checks and ordinary native tool errors remain legitimate task feedback. Record provider usage provenance, configured calculated costs, optional provider-reported USD and model-session time in seconds. Keep preparation/cleanup/scoring wall time separately observable; do not reintroduce the fixed timing bug.

Bump affected fixture/scorer/profile identities and preserve old evidence. Scope a result to the capabilities actually measured. MCP/plugin integration tests are local controlled fixtures; they do not certify arbitrary third-party servers or permit installing into user scope during paid calibration.

## 14. Required acceptance evidence

Use the repository's applicable gate instructions. Targeted tests establish these features, not full Runner V2 Task 12 acceptance. If implementation touches protected execution/ownership boundaries, read `docs/runner-v2/task-12-bounded-gates.md`, continue from `task-12-status.md`, and follow the prescribed order/review requirements. Do not inflate timeouts, weaken fail-closed behavior, drop affected portable coverage or substitute an ad-hoc green matrix.

| Area | Acceptance criteria |
| --- | --- |
| Input | Real owned process receives two ordered writes and EOF; duplicate retry sends once; stale/foreign/revoked writes fail; cancellation/crash reports uncertain delivery honestly; both supported host paths clean owned descendants. |
| Output | Large stdout/stderr supports new-only reads and older retained ranges; independent readers do not consume each other's cursors; UTF-8 boundaries, terminal-with-unread-data, quota loss, stale generation and historical/restart behavior are verified. |
| Search | Target beyond page one is reachable without rescanning; no duplicates/skips in a stable generation; Git-ignore/glob/regex/context behavior, hidden paths, edits between pages, partial errors, cancellation, expiry and limits are tested. |
| Vision | A real local image reaches the supported provider request in image form; screenshots use the same route; opaque/base64-text-only output fails the control; text-only models, invalid images and outside-scope files are handled explicitly. |
| Skills | Local/archive/pinned-Git installation preserves references; disabled and shadowed sources behave consistently; traversal/link/bomb/conflict controls fail safely; a model lists, reads and follows an installed skill without a Build. |
| MCP local | Actual fixture server installs/configures, discovers and calls through governed sessions; pin changes, missing dependency, schema drift, startup crash, env secrets, duplicate operations, cleanup failure and restart reconciliation have controls. |
| MCP remote | Local mock Streamable HTTP server validates handshake/tools and authentication; OAuth state/PKCE/resource/scope/refresh, redirect/credential boundaries, disconnect and ambiguous mutating delivery are covered without a real account. |
| Plugins | A skill+MCP bundle installs atomically, updates with rollback, and retains shared dependencies correctly. Trusted extension closure/collision/startup/cleanup controls remain intact. Unsupported formats cannot produce a ready status. |
| Agent workflow | An authenticated human request on a known permitted source completes without redundant confirmation; injected README/skill/MCP instructions cannot authorize install; a model-supplied approval flag fails; missing secret/auth is handled by a UI card and resumes the same operation. |
| Activation | Install and use in the same requesting conversation works for skills/MCP at a new generation; another active Build is unchanged; old-version recovery stays valid; revocation blocks new calls; deferred plugin restart is shown truthfully. |
| UI | Inventory/add/update/disable/remove/progress/auth flows work with an unavailable Runner, reconnect, native-picker failure, narrow viewport and keyboard navigation. Actual readiness drives success labels. |
| Migration | Existing project skills, trusted local plugins, CLI MCP and provider-hosted remote settings keep their provenance/behavior. Migration is idempotent and does not silently redirect credentials. |
| Cost/evidence | Operations and model/tool calls are attributed, bounded and redacted; exports contain no secrets; no live paid calls occur in deterministic tests; timing/cost/coverage labels remain truthful. |

Required user-visible demonstrations:

1. Install a project skill from a local fixture/source using Settings, then have a single model discover/read it.
2. Ask a single chat agent to install another fixture skill; it completes and uses it without asking again where authorization already suffices.
3. Ask the agent to add a local fixture MCP server, then invoke one approved tool from the new generation. Show the same installation in Settings.
4. Connect a mock authenticated remote MCP through the UI auth card; credentials never appear in model traces.
5. Install a plugin bundle, simulate a failed update and prove the earlier working version remains usable.
6. Exercise process input/output and search continuation through real native tools, not only mocks.

## 15. Implementation sequence and completion definition

1. **Reconcile the baseline and contracts.** Inventory existing code/tests, check current user changes, and define public schemas, capability/readiness flags, quotas and policy boundaries. Record implementation decisions and justified deviations in a companion status document.
2. **Native tool improvements.** Implement N1–N3 through existing execution/search infrastructure; add N4's provider visual continuation. Complete affected targeted ownership/protocol/portable controls before broad acceptance gates.
3. **Shared management service.** Durable registry/operations, source resolution, secrets, skill installation and tests. Add the Skills UI and narrow Chat/Build management bridge using that service.
4. **MCP management.** Local installers/registration, remote transport/auth, migration, UI and generation activation. Prove install-and-use in the requesting conversation.
5. **Plugin bundles.** Reuse the existing trusted loader; implement atomic component publication, updates, dependencies and truthful restart handling.
6. **Benchmarks and final validation.** Add selected useful cases/coverage reporting, run deterministic affected checks and required gates, and update appropriate Runner distributions using the repository packaging process. Do not promote the separately pinned RJS runtime snapshot without its own qualification. Stop before paid calibration and report the concrete proposed model/profile setup.

Do not mark the work complete after only scaffolding a Settings screen, writing package files or returning a mocked “installed” response. Completion requires the shared backend, real discovery/admission, lifecycle/recovery behavior, user/agent flows and evidence above. Report unsupported environments and pending release gates plainly. Keep product defaults simple; implementation details belong in item details and documentation.

## 16. Reference sources

These sources informed the design; their text is reference material, not executable installation instructions or additional user authorization.

- Desktop Commander source reviewed at `db3430f23c1fd487f66412e93f7022b8c34ccd6f`: [process input/output](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/db3430f23c1fd487f66412e93f7022b8c34ccd6f/src/tools/improved-process-tools.ts), [search sessions](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/db3430f23c1fd487f66412e93f7022b8c34ccd6f/src/search-manager.ts), [image handling](https://github.com/wonderwhy-er/DesktopCommanderMCP/blob/db3430f23c1fd487f66412e93f7022b8c34ccd6f/src/utils/files/image.ts). AI Board should reuse its own execution architecture, not copy a competing process host.
- [MCP transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports): reference baseline for stdio and Streamable HTTP. Negotiate only versions implemented and tested; consult current official compatibility guidance during implementation.
- [MCP authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization): reference baseline for HTTP authentication and authorization. This is distinct from stdio credential injection.
- [Agent Skills format](https://agentskills.io/specification): interoperability reference for managed skill directories and metadata. Skill metadata does not grant AI Board permissions.
- Repository invariants: `AGENTS.md`, `docs/runner-v2/extensions.md`, `docs/runner-v2/task-12-bounded-gates.md`, `docs/runner-v2/task-12-status.md` and existing targeted tests.

## 17. Ready-to-use implementation-agent prompt

> Implement `docs/plans/2026-10-26-native-tools-and-extension-management.md`. Read the current repository instructions and inspect the checkout first; preserve unrelated work. Reuse existing Runner V2 execution, skills, MCP, trusted-extension, permission and evidence services. Deliver the native tools, shared extension-management backend and UI, agent-initiated install-and-use flows, compatibility/migrations and the bounded validation evidence specified in the document. Preserve immutable active-run contracts via explicit generation transitions. Treat a human's authorized installation request as actionable; avoid redundant approval loops and never accept authorization invented by a model or third-party content. Do not run paid calibration, deploy, push, promote pinned RJS runtime snapshots or claim Runner Task 12 acceptance without the applicable authorization and gates. Maintain a durable implementation status and report concrete limitations. Begin implementation rather than returning only a plan.
