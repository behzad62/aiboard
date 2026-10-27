# Native tools and extension management — implementation status

Companion to [`2026-10-26-native-tools-and-extension-management.md`](./2026-10-26-native-tools-and-extension-management.md). Durable record of decisions, evidence and limitations. Update it as work advances.

- Branch: `feat/native-tools-extension-management` (from `main` @ `ae9e75192e54c0b52b805a2f23bf5f2cf97bf03e`, the spec's authoring baseline). At this implementation snapshot, nothing had been committed, pushed or deployed.
- No paid model calls, calibration, deployment, push, RJS snapshot promotion or Task 12 acceptance claims are part of this work.
- Task 12 / Gate status is unaffected: this is feature work. Execution-boundary changes are additive (see N1/N2) and covered by targeted tests only; no integrated matrix was run.

## 2026-10-27 follow-up — installation during Builds and ToolBench corrections

This section supersedes the activation, output-retention and default-pack limitations in the older implementation snapshots below. The implementation was subsequently committed as `3bd6bbdd` and the earlier v6 consolidation as `399eead1`; this follow-up is a new working-tree change.

### User-visible behavior

- A single model in **Chat**, with Runner tools enabled, can request installation and subsequently use supported integrations. The **Build Architect** can do the same. Workers and editing subagents consume admitted MCP tools; they cannot independently change installed integrations. Existing per-role restrictions remain in force; this does not add MCP tools to the separate verifier/plan-critic surfaces.
- Managed **local and remote MCP** tools refresh at the next model-turn boundary of the owning Build. Only successful operations owned by that Build advance its durable generation; unrelated Builds retain their pins. The existing Build permission profile and exact execution grants are reused. No call is replayed when capabilities change. Skills already use the same per-run generation mechanism.
- An in-process Runner extension still loads only after a Runner restart with no unfinished Build. Disabling/removing a loaded plugin immediately refuses subsequent tool execution and context/language contributions, and prevents loading it into new Builds. Already running plugin code is not unloaded; a restart is still needed to remove that code from the process. A plugin revoked before startup cannot become callable in that unstarted instance if later re-enabled.
- Windows output now uses bounded private **memory** retention when the disk backend cannot attest privacy: 64 MiB per stream, 128 MiB per spool storage and 256 MiB of retained spill chunks across the process. Quota/ingestion failures remain explicit loss. The existing identity-checked ownership markers remain on disk; payload spill files do not. Completed streams become durable artifacts. Live reads outside the retained inline window can still report a gap until finalization; a crash before finalization cannot recover the in-memory prefix.
- Real ToolBench testing also exposed an artifact-store mismatch: command capture wrote to the host store, while evidence and `artifact.read` used the session store. A trusted per-run artifact destination now keeps these together. UTF-8 command output is labeled text, avoiding Base64 logs; binary bytes remain exact binary artifacts.
- [ToolBench v7](../bench/toolbench-capability-check-v7.md) keeps seven focused cases and makes the combined browser/process case optional. Emergency ceilings are restored to **5M input tokens, 750k output tokens, 300 model calls, 900 tool calls and 4,500 seconds per case**. Tokens/cost/seconds remain efficiency measurements. New identities separate these runs from prior v6 evidence; all 27 historical v4/v5/v6 case fingerprints are unchanged.

### Verification and limits

Targeted verification on Windows / Node 24.18, using scripted models and real Runner tools; no paid model calls:

- Build-owned local MCP install → next-turn discovery → Architect use → worker use → immediate disabled-call rejection; unrelated Build generation unchanged: passed. Guarded-profile remote MCP read and denied write: passed.
- Plugin disable admission, startup race and new-Build loading controls: passed.
- Managed-generation quiescence, no replay, role filtering, conflicting names, refresh failure before model invocation and primary/cleanup error aggregation: passed.
- Output/artifact/real interactive-process group: **60 passed**, including full stdout/stderr beyond 128 KiB, binary preservation, quota/exclusivity/release, exact process input/EOF and completed early-range retrieval.
- Broader affected integration group: **157 passed, one failed, one macOS-only skip**. The failure is `native-architect-runtime.test.ts`'s committed STATE context assertion: it expects `entryPoint:` but the current context says `entryPoint at STATE commit (completion gate):`. The same failure was reproduced using both the test and Architect runtime from HEAD before these edits. A final Architect-only run retained **19 passed / that same one failure**. This is recorded as an existing test failure, not a fully green matrix.
- Application and Runner typechecks and ESLint across all changed TypeScript/TSX paths passed. Managed editing-subagent inheritance/cleanup and read-only subagent exclusion also passed.
- Runner and generic WorkBench downloads were regenerated and their bundled changed source verified; the pinned RJS download remains byte-identical.
- A Windows fixture's empty-PATH setup was corrected to remove both `Path` and `PATH`; it now deterministically tests missing Python without finding the host runtime through the other spelling.
- v7 output retrieval uses an early fact in ~287 KiB of stdout (outside the last 128 KiB), rather than requiring long repetitive scanning. Real artifact, atomic-navigation, interactive and optional browser cases plus their affected negative controls passed. Profile/verifier checks, benchmark Run UI checks and historical fingerprint parity passed.

Local evidence is retained in `D:/tmp/aiboard-*-tests.log`, `D:/tmp/aiboard-build-worker-install-test.log`, `D:/tmp/aiboard-remote-build-test-r3.log`, `D:/tmp/aiboard-toolbench-*-final.log` and `D:/tmp/aiboard-architect-state-baseline.log`. Earlier failed diagnostic attempts remain separate. Two early remote-Build fixture attempts used incomplete host setup and were stopped; the corrected real-host test passed.

No deployment, paid calibration, pinned RJS promotion or Task 12 acceptance is claimed. Compatibility limits documented below (including supported plugin formats and OAuth dynamic registration) remain.

## Phase overview

| Phase | Scope | State |
| --- | --- | --- |
| 1 | Baseline/contracts | Done (this document) |
| 2 | N1 process input, N2 incremental output, N3 resumable search | Implemented + targeted tests |
| 2 | N4 image inspection + provider visual continuation | Implemented + targeted tests |
| 3 | Extension management service, skills, Settings → Extensions, agent tools, Chat bridge | Implemented + targeted tests (see limitations) |
| 4 | MCP management (local/remote/migration/activation) | Implemented + targeted tests (see limitations) |
| 5 | Plugin bundles | Implemented + targeted tests (see limitations) |
| 6 | ToolBench coverage + final validation | Implemented + deterministic evidence; paid calibration not run (needs authorization) |

## N1 — `process.write_stdin`

Decisions:
- `process.start` gains `interactive: boolean` (default off). Non-interactive processes keep existing stdin behavior; `write_stdin` on them returns `process_input_not_enabled` before any effect.
- Delivery uses the existing streaming-session facade `write` (sequenced, acknowledged by the Windows Job host or the portable supervisor) under a fresh per-call `SessionAuthority` authorization (`write`, or `close_input` for EOF-only). Added a facade `closeInput` that is ordered after all admitted writes and bounded by a timeout. No second process host, PID authority or shell route.
- `writeId` idempotency: `ManagedProcessService` keeps a bounded durable journal (`input.writes`, last 256 per process) in the managed record. Same writeId + same payload digest returns the settled outcome (`deduplicated: true`) without sending; changed payload → `process_input_conflict`. Payload bytes are never persisted (sha256 + length only).
- Outcomes: `acknowledged`; `rejected` (refused before delivery: authorization/session unavailable); `outcome_unknown` (delivery started but not acknowledged). A journal entry is written as `pending` before the first byte leaves the Runner; on Runner restart, `pending` becomes `outcome_unknown` (`process_input_interrupted`) and is never replayed. An uncertain EOF marks input closed rather than guessing.
- Writes per process are serialized in the service (order = admission order) on top of the channel's own sequence checks.
- `appendNewline` appends exactly one `\n`; `closeInput` is EOF, never a signal. Pipes only — no PTY/TUI emulation is advertised.
- Bounds: 64 KiB per write; 15 s acknowledgement timeout per write.
- Recovered/historical sessions are read-only for input (`process_input_unavailable`).

Files: `runner-v2/src/managed-process.ts`, `managed-process-contracts.ts`, `managed-process-record.ts`, `managed-process-transport.ts`, `execution-host-managed-transport.ts`, `streaming-process-session-runtime.ts`, `managed-process-tools.ts`, `role-capabilities.ts`, `runner-extension.ts`.

## N2 — `process.read_output`

Decisions:
- New tool (poll unchanged). Modes: caller-held opaque `cursor` (new-only), no cursor (from offset 0), `tailBytes`, or explicit `range {stream, startOffset}`.
- Cursor = HMAC-signed `{processId, launchId, generation(configDigest+startedAt), stdout/stderr offsets}`; key persisted per state dir (`output-cursor.key`). Foreign process → `process_output_cursor_foreign`; earlier generation → `process_output_cursor_stale`; altered/other Runner state → `process_output_cursor_invalid`. Offsets are absolute stream byte offsets.
- Source of bytes is the existing bounded evidence spool (no new log storage): exact live tail (**128 KiB per stream**) while running; after completion the authenticated final evidence plus, when ingested, the spill artifact (stream prefix up to **64 MiB per stream**). The streaming observation now also exposes the finalized `spillArtifactId/spillBytes`.
- Default **16 KiB** per stream per call, max **64 KiB**; minimum 4 bytes so UTF-8 pages always progress. Slices end on UTF-8 boundaries; a start inside a character skips to the next boundary and is reported as a gap.
- Retention loss is explicit: `gap {fromOffset,toOffset,reason: retention_window_exceeded | evidence_lossy | utf8_boundary}`; `complete` is true only when terminal, read to end, lossless.
- Bounded wait (`waitMs` ≤ 30 s) is event-driven: the streaming runtime now notifies observation-only waiters when evidence is written, on terminal and on attachment close. Cancellation ends only the wait.
- Legacy historical records (no offsets) return `process_output_history_unsupported`; processes that never acquired a session return `process_output_unavailable`.

Known limitation (Windows host): the private output spill is unavailable on Windows, so after completion, bytes before the 128 KiB tail are reported as an `evidence_lossy` gap (verified in the real-process test). POSIX hosts with a private spill serve them exactly.

## N3 — resumable `fs.search`

Decisions:
- Extends `fs.search` (no new tools). New inputs: `include`/`exclude` globs (bounded matcher: `*`, `**`, `?`, `{a,b}`, `[...]`; basename-only when no `/`), `contextLines` (0–5), `cursor`, `cancel`.
- A search session (in-memory, owner-bound to run/session/actor, HMAC cursor bound to session id + offset + query digest) freezes the sorted candidate list. Pages continue scanning whole files; all of a file's matches are retained together. Re-fetching a cursor returns the same page.
- Stale detection: a candidate removed, or modified after the session started (mtime > session start), on a later page ends the session as `stale`; results already returned remain from the original snapshot.
- States: `running` (cursor provided), `complete`, `capped`, `cancelled`, `timed_out`, `stale`, `expired`. `exhaustive` is true only for complete, untruncated, lossless scans (zero-match is definitive only then).
- Bounds: 5,000 matches / 8 MiB retained per session; 8 s and 64 MiB scan per page; 120 s total; 16 MiB max file; 2,000 chars per line; 8 sessions (LRU); 15 min idle expiry. Expiry and evicted/altered cursors are typed errors (`search_expired`), never "no matches".
- Existing simple calls keep `matches/truncated/notes`; new fields: `state`, `exhaustive`, `cursor`, `scope` (candidates, scanned, remaining, skipped by reason), `errors`.

Known limitation: staleness uses mtime relative to the session start; a file with a future mtime read on a later page is reported stale (conservative). Sessions are in-memory and do not survive a Runner restart (cursor → `search_expired`).

## N4 — `image.inspect` and visual continuation

Decisions:
- New tool `image.inspect` (`path` inside the workspace, or `artifactHash`), required on Architect inspection/plan-only and worker surfaces. Content is sniffed (PNG/JPEG/WebP); SVG is refused as an image and documented as text (`fs.read`).
- Limits: 20 MiB source, 50 MP, 20,000 px per side; delivered derivative ≤ 3.75 MB and ≤ 8,000 px; `maxDimension` 64–2048 (default 1568). PNG crop/resize runs in-process with a bounded inflate and CRC checks; JPEG/WebP pass through (EXIF orientation reported, not re-encoded). The derivative is a new artifact; sources are never modified.
- Workspace confinement uses the canonical path and the filesystem tools' hidden-path policy; a tool argument never grants host access.
- Delivery: the tool returns an artifact block with `visual` metadata. `wrapModelWithToolVisuals` turns the latest tool round's visual artifacts (max 4) into native image input: Anthropic image blocks inside `tool_result`, Gemini inline parts after the function responses, OpenAI chat/responses a user image message after the tool outputs; the account-runner transport resolves them in-adapter. Images are attached once, never re-sent every turn.
- The ToolBroker strips `visual` metadata from every tool except the Runner's own `image.inspect`/`browser.screenshot` (and always from extension tools), so third-party output cannot pose as model-visible image input.
- Text-only models get `image_input_unsupported` with metadata and an explicit "not shown" statement; nothing is rerouted to another model. `browser.screenshot` uses the same path when the calling model accepts images.

## Phase 3 — shared extension management (skills) and the Chat/Build bridge

Runner files: `extension-management-contracts.ts`, `extension-package-store.ts`, `extension-skill-validation.ts`, `extension-sources.ts`, `extension-registry.ts`, `extension-credentials.ts`, `extension-authorization.ts`, `extension-management-service.ts`, `extension-management-tools.ts`, `extension-run-bindings.ts`, `extension-control-routes.ts`, `chat-agent-session.ts`; changes in `skill-catalog.ts`, `skill-tools.ts`, `skill-routing.ts`, `control-server.ts`, `cli.ts`, `native-build-factory.ts`, `native-architect-runtime.ts`, `role-capabilities.ts`, `encrypted-provider-config-store.ts` (shared envelope helpers), `runner-resource-cleanup.ts`. Browser: `lib/client/runner-extensions.ts`, `lib/client/runner-chat.ts`, `components/extensions/*`, Settings → Extensions tab, chat composer "Runner tools" toggle, engine chat branch.

Storage and identity:
- Registry, operation journal, immutable generation files and the content-addressed package store live in an AI Board-owned home outside every project (`--extensions-home`, default `~/.aiboard/runner-extensions`, created on first write only). Writers serialize through a cross-process directory lock (stale after 30 s) and publish by atomic rename; records are validated on load and unknown fields rejected.
- Project scope = first 32 hex of sha256(canonical project path). Extension ids are stable hashes of kind + scope + name.
- Credentials: `<state-dir>/extension-credentials.enc` using the provider-config envelope (scrypt(runner token) + AES-256-GCM). Records/operations hold references only; values reach Runner-internal code only, never the browser or models. Credentials are per Runner state directory, so a user-scope item used from another Runner shows its credential as missing until entered there.

Operations: install/update/enable/disable/remove/rollback are durable idempotent operations (caller key + request fingerprint; a reused key with different input → `operation_key_conflict`). Stages resolve → inspect → (await authorization/credentials) → stage → [install dependencies] → validate → commit → activate → ready; terminal failed / cancelled / outcome_unknown / rolled_back. One active operation per extension. Restart recovery: pre-commit stages → `failed` (safe to retry), interrupted dependency install → `outcome_unknown`, a committed change is completed. An update whose readiness check fails restores the previous version in a new generation (`rolled_back`).

Skills:
- Sources: local folder (snapshotted; never modified or deleted), uploaded `.zip` or single `SKILL.md` (UI only), pinned Git (one exact commit via `git fetch --depth 1` through the governed internal process kernel; hooks path disabled, no submodules, credential helper/prompt disabled, file protocol only for UI/tests).
- Package bounds: 512 files, 32 MiB total, 8 MiB per file, 12 levels, 240-character paths; links, special files, traversal, absolute/drive paths, Windows-reserved names, case-insensitive collisions and file/folder clashes are refused. ZIP: stored/deflate only, no encryption or ZIP64, ratio ≤ 200, inflate capped at the declared size.
- Agent Skills checks: `name` (1–64, lowercase/digits/single hyphens), `description` (≤ 1024), optional `license`, `compatibility` (≤ 500), `metadata` (string map), `allowed-tools` (advisory warning only). The frontmatter parser is a restricted subset: no tags, anchors, aliases, merge keys, flow maps or multiple documents. Missing referenced resources and bundled scripts are reported as warnings; nothing runs at install.
- A multi-skill source needs an explicit selection (UI radio list; an agent may pick only a skill the human named). Each installed skill is its own content-addressed package.
- Discovery: `list_skills` includes managed skills (`managed:<scope>:<name>`) with scope, version id, package digest and generation; `shadowedBy` marks same-named losers. Precedence: project files > managed project > managed user > user folders > built-in. `read_skill` gained `resource` for bounded (256 KiB) text reads confined to the skill folder, so installed skills outside the worktree stay usable.

Authorization (never model-supplied):
- Receipts come only from (a) a UI request on the authenticated control plane, (b) the text of a human message delivered by an authenticated route (chat message, Build objective, Build user message/guidance), or (c) the user's standing policy. Tool schemas are closed (`additionalProperties: false`) and approval/credential-looking fields are refused by name.
- Default policy: instruction-only skills the human named in this conversation install without another prompt; executable components also need a matching trusted-source pattern (none by default) or one approval card; a project-scoped request does not authorize a user-wide install; agent lifecycle changes need the human to have named the item and verb.
- Agents may name local folders only inside the project/workspace or ones the human named. Workers/verifiers cannot plan or apply. Benchmarks get neither management tools nor managed skills.
- Receipts (30 min) and human intents (2 h) are in memory; after a Runner restart an approved-but-unstarted change asks again instead of trusting stale authority.

Activation:
- Every committed change publishes a new immutable generation. A chat session switches its tool surface after its own operation succeeds, at the next model request with no call in flight (transition recorded with from/to/operation ids); other conversations adopt newer generations at their next user turn.
- Build runs pin a generation in `<state>/extension-bindings/<runId>.json` (kept across restarts); only operations owned by that run advance it; other active Builds stay unchanged. Package versions referenced by pinned generations are never collected.

Chat bridge: `/v2/chat-sessions` runs single-model chat on the Runner (skills, read-only project files, `image.inspect`, `extensions.*`) with budget-ledger accounting and restart-safe snapshots (an interrupted reply is reported, never resumed). The browser opts in per chat ("Runner tools" in the composer); earlier turns are sent once as context and never count as installation intent. Operation cards (approve/decline/credential) render above the chat and in Settings.

Settings → Extensions: per-kind inventory (Skills / MCP servers / Plugins) with readiness, scope, source, version and last error; details (components, generation, credentials by name); enable/disable, test, check for update, rollback, uninstall (confirmed; source untouched), credential entry/revoke; read-only "found elsewhere" items with provenance; pending operation cards; standing-policy editor. Sources: paste a path or link, Runner-side folder browser (no `showDirectoryPicker` dependency), or upload (.zip / SKILL.md). Without a Runner the tab links to Tools.

Phase 3 limitations:
- Project-managed skill publication into `.agents/skills` (a versioned project change) is not implemented; managed project skills live in the Runner store.
- Panel/debate/specialist chats get no management tools (only single-model chat and the Build Architect), so the single-coordinator rule holds trivially.
- Runner chat replies are not streamed token by token; the browser polls the session snapshot.
- Upload, inspection and plan caches are in memory (uploads 1 h, inspections/plans 30 min).

## Phase 4 — MCP management

**Local stdio servers** (`src/extension-mcp.ts`, `ManagedMcpRuntime`, registered as the `mcp_server` kind handler):

- Sources: an installed program (`executable`: absolute path or PATH lookup, structured `args`), a pinned npm package, a pinned PyPI package. Arguments are an argv list; `formatMcpCommand` (mcp-configuration.ts) is the exact inverse of the existing `parseMcpCommand` grammar and refuses anything it cannot round-trip, so legacy CLI parsing/attestation is unchanged.
- Inspection never runs package code: npm/PyPI metadata comes from `registry.npmjs.org` / `pypi.org` only (HTTPS, no redirects, 2 MiB, 20 s). An unpinned request resolves to the current release and is pinned; runtime never uses `@latest`.
- npm installs run `npm install <pkg>@<exact> --ignore-scripts --save-exact` into `<extensions-home>/mcp-runtimes/<ext>/<version>-<rand>` through the Runner's governed internal process kernel; the lock entry must match the pinned version and the registry integrity hash; the server runs on the Runner's own Node. Declared install scripts are disclosed on the card and are not run (a server that needs them fails its check honestly). PyPI installs create a private venv and use `pip install --only-binary=:all:` (no source builds). Missing Python/npm → `runtime_missing` with an "install it yourself" message; system runtimes are never installed.
- Integrity: executable digest (existing `hashExecutableDescriptor`) plus an install digest (script arguments for registered programs; entry + lock for npm; console script for Python) is re-verified before every launch and readiness check; a change fails closed ("changed since installation").
- Readiness = real handshake + `tools/list` through the existing internal discovery executor (`attestMcpServers` was added to the internal execution context; same attestation table). No advertised tool is executed as a check. Its scratch `builds/ext-check-*` directory is removed afterwards.
- Arguments that look like secrets (`--token=...`, `sk-...`, `ghp_...`) are refused: secrets must be declared as `env` names.

**Secrets for local servers.** The existing process backend serializes the child environment into its supervisor's command line (`execution-host-credential-graph.test.ts` decodes it), so routing secrets through the child-environment grant seam would expose them to any local process listing. That plumbing was prototyped and **reverted**; the hardened execution path is unchanged. Instead a credentialed server starts through a small digest-verified launcher (`src/extension-mcp-launcher.ts`): right before each launch the Runner writes a single-use, user-only, 60 s secret file into an AI Board-owned directory; the launcher claims it by atomic rename, deletes it, sets only those variables and starts the real server with inherited stdio. Argv names only the directory. The end-to-end test scans every file under the test root (state, supervisor records, registry, chat transcripts) and the model requests for the secret: none contain it.

**Activation.**
- Chat: `ChatAgentSessions` gets a `generationTools` provider. For each generation a dedicated ExecutionHost binding (`chat-<hash>-g<generation>`), real discovery, `McpManager` lazy sessions and `createMcpTools` are built; `mcp.*` calls are routed to a broker holding that binding's execution grants (`RoutedToolRuntime`), so the existing exact run/session/grant checks apply unchanged. A generation published mid-reply is adopted at the next model turn (also when the agent learns of it from `extensions.operation_status`).
- Build: `NativeBuildFactory` appends the run's pinned-generation managed servers to the CLI servers for discovery/attestation/runtime launches, with the transport wrapped to provision secret files. Benchmark runs get none.
- Per-server tool policy (Settings): `all` (default for local servers the user approved) or `non_destructive` (default for remote servers). Annotations are hints; unannotated tools count as destructive. Disable/remove blocks new calls immediately in chat.

**Remote servers** (`src/mcp-remote.ts`): Runner-hosted Streamable HTTP client (protocol `2025-06-18`, `2025-03-26`; legacy HTTP+SSE not supported), JSON or SSE responses, session id + protocol-version headers, bounded bodies/timeouts, redirects never followed, server-initiated sampling/elicitation/roots requests refused with `-32601`. Destinations: HTTPS, plain HTTP only for loopback, hostnames resolving to private ranges refused. A tool call is sent once; a broken connection after sending is reported `OUTCOME UNKNOWN (not retried)`.
- Auth: none; bearer (`MCP_BEARER_TOKEN`, secure field); OAuth per the MCP authorization flow — protected-resource metadata only from the server's own origin, RFC 8414 issuer validation, mandatory PKCE S256, `state`, RFC 8707 `resource`, scope from the challenge/metadata, RFC 7591 public-client registration. Tokens/refresh tokens live only in the encrypted credential store and refresh inside the Runner. `needs_auth` parks the **same** operation on a sign-in card; the unauthenticated `GET /v2/extensions/oauth/callback` (the one bearer-token exemption, exact path and method) accepts only a single-use state and resumes it.

**Migration / CLI.** `POST /v2/extensions/migrations/provider-hosted-mcp` records the browser's single `remoteMcpServer` (name, URL without query/credentials, enabled state, whether a token exists — never the token) as a read-only `migrated` item with the `provider_hosted` route; idempotent, publishes no generation, never called by the Runner. Settings syncs it on load and offers "Add as Runner-hosted…", where the user re-enters the token. CLI `--mcp` servers stay visible; "Adopt…" inspects them with their exact argv; the managed copy stays idle while the `--mcp` entry exists (reserved name), so there is never a duplicate connection.

**UI.** MCP tab form (program / npm / Python / remote URL, argv list, secret variable names only, sign-in kind), tool-policy switch, "Sign in" on items and operation cards (chat cards too), migrated-item explanation, CLI adoption.

**Limitations (Phase 4).**
- Chat MCP bindings use the Full-access process-group lifecycle: non-Full profiles require a contained workload, which this Windows host cannot provide (project-profile Builds fail closed on MCP here too). Chat has no per-call approval UI; the per-server tool policy is the control.
- Builds bind managed MCP servers at run construction (and after restart to the same pin). A server the Architect installs mid-run is usable once the run is rebuilt; skills transition mid-run. Remote servers are chat-only for now.
- OAuth: servers that need a pre-registered client (no dynamic registration) are refused with a clear message; token revocation at the issuer is not attempted; DNS is checked before connecting (no rebinding pinning).
- Old managed runtime directories are kept for rollback and not garbage-collected yet.

## Phase 5 — Plugin bundles

**Format.** `aiboard-plugin.json`, `schemaVersion: 1` (full schema in the doc-comment of `runner-v2/src/extension-plugin.ts`): `id`, `name`, `version`, optional `description`/`license`/`homepage`, `skills[{path}]`, `mcpServers[{id, definitionPath}]`, `runnerExtensions[{path}]`, `requires[{kind: skill|mcp_server, name}]`. Exact keys everywhere: any other field (`approved`, `hooks`, `trusted`, …) is refused by name, so a manifest cannot carry authorization, lifecycle hooks or verification changes. Every path goes through the package store's `normalizePackagePath` (no traversal, drive letters or non-portable names). MCP definitions: `{transport: "stdio", command, args, env (names), serverName}` with `${PLUGIN_ROOT}` substitution, or `{transport: "streamable_http", url, auth}`.

**One extension, one generation.** A plugin installs as one `plugin`-kind extension whose version holds all its components; the whole package is content-addressed in the existing package store at inspection (staging is not execution), so `${PLUGIN_ROOT}` resolves to the immutable copy, never the user's folder. All components publish in a single generation. Existing kind-agnostic readers pick them up: `managedSkills` (skill catalog) and `managedMcpServers` (chat/Build MCP activation, secrets launcher, tool policy). Readiness checks every component (skill re-read; MCP handshake + `tools/list` through the same discovery executor; Runner extension activation state) and reports per-component states. An update whose check fails is rolled back as a unit by the existing update/rollback path.

**Executable trust.** Only stdio MCP servers and Runner extensions make a plugin executable (`requiresExecutableTrust`); a skill-only or remote-only plugin needs no executable trust. Bundled native executables are refused as stdio commands (only installed programs, e.g. `node`, run bundled scripts). Package labels are explicitly marked unverified on the card.

**Dependencies.** `requires` must name installed, in-scope items at install time (`dependency_missing` otherwise). The registry's `referencedBy` is relinked on install, remove, rollback and failed-update restore, so a shared skill/MCP server cannot be removed while a plugin's current version needs it, and becomes removable once the plugin is gone.

**Runner extensions.** Validated with the existing `captureRunnerExtensionClosure` (manifest, contained relative ESM graph, size limits; nothing is imported). An active Build's capability contract must equal the Runner's configuration at recovery, so activation is a startup decision: `activateStagedRunnerExtensions` adds enabled plugins' extension directories to the capability configuration only when **no** Build is unfinished (set-aside runs included), after re-capturing each closure, checking it still matches the installed manifest digest and refusing id clashes with operator-configured extensions. The existing `LocalPluginLoader` then loads them for new Builds with its unchanged closure, execution-copy, collision and cleanup controls. Readiness is truthful: `restart_required` until loaded (with the reason when deferred), `ready` once loaded, `failed` with the reason if refused.

**Foreign formats.** A folder with no `aiboard-plugin.json` that looks like a Claude Code plugin, Gemini CLI extension, VS Code extension or browser extension is refused with `plugin_format_unsupported` and what cannot run. When such a folder also contains `SKILL.md` folders, it is left to the skill installer, so those skills still install as skills.

**UI / agent.** The Plugins tab previews bundle version, every component and the installed items it uses. Installed items show per-component readiness and "Uses"/"Used by". Agent tools are kind-agnostic; `inspect_source` mentions plugin bundles and returns `dependencies`, and a `restart_required` result tells the agent not to claim the Runner-extension part works yet.

**Limitations (Phase 5).**
- Runner-extension activation needs a Runner restart with no unfinished Build; disabling or removing an activated extension takes effect at the next restart (the current process keeps it loaded for new Builds until then).
- Plugin MCP servers follow Phase 4 activation: chat adopts them at the next generation, Builds at run construction.
- No adapters for foreign plugin formats and no marketplace or curated search; installation is add-by-source only.

## Phase 6 — ToolBench coverage and final validation

**Identity.** The six core v4 cases, the variant, browser and skills packs are byte-for-byte unchanged (all 14 v4 case hashes verified identical before/after), so stored evidence still replays. New cases use `caseVersion` `5.0.0`, scoring `solo-toolbench-v5.0`, base commit `toolbench-native-v5` and `-v5` case ids.

**New packs** (`lib/benchmark/toolreliability/native-cases.ts`):
- `toolbench-native-extended-v5` (5 cases): `code-navigation` (find the definition and both callers among a decoy, fix the definition only, list callers; any of fs.search / code.references / code.workspace_symbols / code.definition is acceptable), `continued-search` (300 matches; the only negative entry is on page 3 and must arrive in a page obtained with the cursor), `artifact-retrieval` (an ~86 KB command output whose runtime-only SHA-derived value lies outside the inline tail; must be read through `artifact.read` without re-reading a range), `interactive-process` (an interactive program with a per-run random code: `process.read_output` → `process.write_stdin` + EOF → `process.read_output` with the cursor; the program records every delivered line and the hidden verifier requires exactly one), `project-skill` (the existing skill case moved into the standard pack).
- `toolbench-native-browser-form-v5` (optional, needs a browser backend): fill two fields, submit, confirm in a new snapshot, the server persists the values, then stop the owned server.
- Proposed standard set: core v4 (6) + extended v5 (5) = 11 cases; browser, browser-form and variant stay separately identified. The Models/Full presets still run only the core six; switching the preset changes default spend and waits for calibration approval. The extended pack is selectable in Run.

**Qualification** (`native-qualification.ts`, hidden, never sent to the model): `continued-search-delivered-target`, `artifact-delivered-target`, `artifact-ranges-not-repeated`, plus the existing tool groups, ordered sequences, command evidence and scope checks. Program-written outputs (`processGeneratedOutputs`) get an empty editable scope, so forging them with `fs.write` is a scope violation. The Runner's ToolBench session now records the bounded JSON of `fs.search` results, whether a search continued a cursor, `artifact.read` offsets, and the tool names it offered (`availableTools`); the Build-path adapter fetches tool evidence for the new checks as well.

**Coverage manifest** (`native-coverage.ts`): 19 capabilities, each with acceptable production tools, the asserted evidence and the cases that measure it. `nativeCoverageReport` yields **verified** (a covering case passed and used the tool), **exercised** (used, case failed), **available** (offered, unused), **not tested**, **unsupported** (Runner did not offer the tools) and **excluded by environment** (no browser/vision backend); `fullCoverage` is always false. The certified attempt detail panel shows the per-attempt rows scoped to the case's capabilities, using the final attempt status (hidden verifier + qualification), never tool use alone.

**Not tested by ToolBench (stated in the manifest):** Git inspection (bench preparation commits a single revision; a multi-revision fixture is needed), local image inspection (fixtures are text-only and solo sessions do not offer `image.inspect`; covered by Runner tests), managed MCP/plugins (covered by local controlled Runner fixtures; arbitrary third-party servers are not certified).

**Observed bound worth knowing:** a command's stdout artifact retains the last 128 KiB; earlier output is not retrievable through `artifact.read`. The artifact case is sized inside that bound.

**Distribution.** `node scripts/publish-downloads.mjs` was run into a scratch directory and compared with `public/`: only `aiboard-runner-v2.zip` and `aiboard-workbench-runner.zip` (which embed Runner V2 source) changed and were installed into `public/`; the pinned RJS runner zip was byte-identical and left untouched (no RJS snapshot promotion). `predev`/`prebuild` regenerate the same files.

**Proposed paid calibration (not run).** Solo ToolBench, one attempt per case per model, through the managed bench runner on this host: core v4 (6) + extended v5 (5), plus browser + browser-form only for models that will be used with a browser backend. Models: the user's Run checklist; reasoning effort at each model's default; existing per-case guards (300 model calls, 900 tool calls, 4,500 s wall clock) unchanged. Report per-model pass fraction with the coverage rows (verified/exercised/…) and provider-reported cost where available. Needs explicit authorization; no live provider calls were made in this work.

## Evidence (targeted; Windows 10 host, Node 24.18.0)

| Check | Result |
| --- | --- |
| `npx tsc --noEmit -p runner-v2` | pass |
| `test/managed-interactive-io.test.ts` (journal, idempotency, crash, cursors, UTF-8, gaps) | 9/9 pass |
| `test/managed-interactive-native.test.ts` (real processes via ExecutionHost + ToolBroker: ordered acknowledged writes + EOF exactly once, conflict, foreign owner, non-interactive refusal, 300 KiB cursors, independent readers, UTF-8 pages, termination with unread data, honest gap) | 2/2 pass |
| `test/filesystem-search-continuation.test.ts` | 7/7 pass |
| `test/filesystem-tools.test.ts` (one pinned search shape updated for the additive fields) | 18/18 pass |
| `test/role-capabilities.test.ts` (pinned surfaces updated for the two new process tools) | 14/14 pass |
| Affected managed/streaming suites (`managed-shared-native`, `streaming-process-session-runtime`, `managed-observation-authority`, `managed-backend-boundary`, `managed-tool-await`, `managed-lifecycle-requirements`, `final-verification-managed-authority`) | 225/241; the 16 failures are all in `streaming-process-session-runtime.test.ts` (C3 spill-failure cases) and reproduce identically with this change removed (baseline 204/220) — pre-existing on this Windows host |

| `test/image-inspection.test.ts` (sniffing, limits, crop/resize, orientation, outside-workspace/hidden refusal, text-only refusal, provider request shapes for Anthropic/Gemini/OpenAI chat+responses, base64-text control) | 8/8 pass |
| `test/provider-transport.test.ts` (after the visual wrapper) | 37/37 pass |
| `test/extension-management.test.ts` (ZIP bomb/traversal/link/collision/encryption controls, safe YAML, link-free snapshots, Settings install → discovery, idempotency/conflict, removal leaves the source, agent install from a named source without re-approval, unnamed source → one card → UI approval, worker refusal, disable/enable/rollback generations, pinned Git subfolder without running repository code, restart recovery, source-key extraction, credential custody) | 11/11 pass |
| `test/chat-agent-extensions.test.ts` (scripted model through real tools, broker and budget: install + list + read resource in one reply with a model-turn generation transition; injected skill text and a model `userApproved` flag refused; unauthorized change → card → UI approval) | 3/3 pass |
| `test/role-capabilities.test.ts` (Architect-only `extensions.*`, hidden from plan-only) | 14/14 pass |
| control-server, CLI, skills and resource-cleanup suites | 56/56 pass |
| `test/extension-mcp.test.ts` (real ExecutionHost/discovery/sessions: credential card → secret only in the server process, never in files or prompts; agent install → card approval → tool used in the same reply at a model-turn transition; non-destructive policy; tampered script refused; crash before handshake = failed; pinned npm with scripts disabled + integrity + failed update rolled back; missing Python is actionable) | 6/6 pass |
| `test/extension-mcp-remote.test.ts` (destination rules; no-auth remote handshake + SSE + refused sampling; unannotated tool refused before reaching the server; ambiguous mutating call sent once → outcome unknown; OAuth card → PKCE/state/resource → single-use state → same operation resumes → refresh inside Runner, tokens only encrypted; redirect refused; provider-hosted migration idempotent/read-only/no token; CLI adoption exact argv) | 6/6 pass |
| Phase 4 affected suites (cli, control-server, credential graph, all `mcp-*`, native-build-capabilities, internal execution context, tool-broker, extension/chat/skill/role suites) | 299/299 pass |
| `test/extension-plugin.test.ts` (real ExecutionHost/discovery: skill + stdio MCP bundle installs in one generation with both components ready and launches from the immutable copy; an update whose MCP server crashes rolls back the whole bundle including its skill; missing dependency refused, shared skill retained while used and removable after; Claude Code/Gemini/VS Code formats refused, Claude plugin with SKILL.md still installs as skills; manifest authorization/hook/traversal fields refused; Runner extension validated without import → `restart_required`, deferred while a Build is unfinished, `ready` once activated, `failed` on an id clash, unstaged when disabled) | 6/6 pass |
| Phase 5 affected suites (extension-*, chat-agent-extensions, cli, cli-capabilities-config, control-server, native-build-capabilities, plugin-loader, role-capabilities, runner-capabilities-config, runner-capability-contract, skill-discovery-noise) | 162/164 pass, 2 skipped (macOS-only alias fixtures), 0 fail |
| `scripts/test-native-toolbench-extended.mts` (real ToolBenchSessions/ExecutionHost/tools with a scripted model: all 5 extended cases and the real-browser form case pass hidden verifier + qualification; negative controls: one oversized search page fails continuation, a repeated artifact range fails retrieval, a same-writeId retry is deduplicated and delivered once while a new writeId duplicate is rejected by the verifier, forging a program-written output is a scope violation; manifest ↔ case consistency; all six coverage statuses) | pass |
| v4 ToolBench case hashes before/after | 14/14 identical |
| `npm run test:benchmark:solo`, `test-native-benchmark-profiles`, `test-workbench-native-runner-adapter`, `test-certified-attempt-detail-panel-ui`, `test-benchmark-case-manifests`, `test-native-toolbench-browser`, `test-certified-result-ui-viewmodel`, `test-workbench-executor` | all pass |
| Final gate after Phase 6 (2026-10-27): `tsc --noEmit` (app), `typecheck:runner-v2`, `npm run test:chat`, `test-bench-runner-contract`, `test-certified-workbench-runner`, `test-runner-v2-client`, `npm run lint` | pass; lint has only the 2 pre-existing `prefer-const` errors in untouched `runner-v2/test/n4-failed-launch-custody.test.ts` and `verifier-contracts.test.ts` |

Not yet run: POSIX/OCI portable paths for N1/N2 (no POSIX host here).

## Subsequent ToolBench consolidation — 27 October 2026

The phase-6 proposed eleven-case grouping above is a **historical proposal**, superseded by the separate design record `docs/bench/toolbench-capability-check-v6.md`. Current Run UI exposes **one seven-case native ToolBench pack** and **one score**, not separate core/extended/variant/browser choices. The current v6.2 process fixture combines interactive stdin and incrementally read stdout with a real browser form on the same owned server; browser support is mandatory for completing the unified pack. The native code-navigation case additionally requires atomic multi-edit, and artifact retrieval also requires bounded file reads and exact argument arrays. Historical v4/v5 fixtures remain readable; no paid model calibration or RJS snapshot promotion has been performed. The ZIP bundles in `public/` were generated and intentionally excluded from the source commits.
