# Remote MCP tool surface

Revised 2026-10-27 for owner decisions D15–D17.

## Status

Proposed. This is an R0 contract, not an implemented or approved remote surface. The 25 fixed names below cover P2 and the image/browser requirements in T01; remote-enabled plugin names are additional and dynamic (`docs/plans/2026-10-27-aiboard-remote.md:223`, `docs/plans/2026-10-27-aiboard-remote.md:318`).

## Context

The cloud agent is the reasoning loop, D9 sets whole-machine reach with the current directory as default, and the Runner must reauthorize every operation (`docs/plans/2026-10-27-aiboard-remote.md:23`, `docs/plans/2026-10-27-aiboard-remote.md:40`, `docs/plans/2026-10-27-aiboard-remote.md:133`). The existing broker derives access from the tool, applies its approval policy, and issues a bound grant (`runner-v2/src/tool-broker.ts:274`, `runner-v2/src/tool-broker.ts:286`, `runner-v2/src/tool-broker.ts:411`).

The companion JSON lists 107 fixed definitions registered across Runner Build, Chat and toolbench contexts. It includes optional and hidden definitions; availability in one context does not imply availability in another. It excludes configuration-dependent extension/MCP names and exported but unwired factories. Runtime extensions register their own names (`runner-v2/src/extension-runtime.ts:78`); MCP names are generated from server and tool names (`runner-v2/src/mcp-tools.ts:156`, `runner-v2/src/mcp-tools.ts:266`). `createValidationEvidenceTools` is separate from the wired two-tool evidence factory (`runner-v2/src/evidence-tools.ts:50`), and the exported final-verification submission factory has no registration caller in `runner-v2/src` (`runner-v2/src/final-verification-submission.ts:217`).

Catalog conventions: `effect` and `readOnly` reproduce Runner declarations, whose effect enum is `none`, `workspace`, or `external`; `process` and `network` are not declared effect values (`runner-v2/src/agent-contracts.ts:159`). An effect of `none` does not establish that an operation changes no state: `extensions.plan_change` can apply a change when authorized (`runner-v2/src/extension-management-tools.ts:97`). Runner has no `permissionClass` field: that catalog field records `assessAccess().capability`, or the broker's effect fallback when no assessor exists (`runner-v2/src/agent-contracts.ts:257`, `runner-v2/src/tool-broker.ts:274`). `rolesAllowed` is the union in `role-capabilities.ts`, including optional entries; `unknown` means that file does not enumerate that definition, not that anyone may invoke it. The separate Architect lifecycle allowlist exists in `runner-v2/src/build-runtime.ts:5935`; subagent and toolbench registrations have separate contexts (`runner-v2/src/subagent-tools.ts:183`, `runner-v2/src/toolbench-session.ts:179`). A role allowlist is not itself an execution grant; some memory operations also enforce Architect identity at execution (`runner-v2/src/memory-tools.ts:159`, `runner-v2/src/memory-tools.ts:181`). `ownedOnly` marks operations targeting existing Runner-managed processes or browser sessions, not a claim that arbitrary artifacts or files are owner-scoped.

## Decision

Use unprefixed, lowercase snake_case names: the server already supplies the AIBoard identity, and short names are readable in both clients. Each fixed name is an MCP identifier. All fixed tools are subject to account, client, device, entitlement, Runner role, exact grant, audit, device policy and applicable approval checks; the denylist applies to Runner file tools. A model argument never supplies an approval, role, grant, actor identity, or authorized root. D17 requires no per-action approval by default; apply approval only when the device policy enables it, including under Full. Full currently bypasses the broker's ordinary approval test (`runner-v2/src/tool-broker.ts:286`, `docs/plans/2026-10-27-aiboard-remote.md:48`, `docs/plans/2026-10-27-aiboard-remote.md:187`). D15 puts these low-level tools first and defers Build-level tools to X3; D16 adopts the same surface for L1 local stdio MCP (`docs/plans/2026-10-27-aiboard-remote.md:46`, `docs/plans/2026-10-27-aiboard-remote.md:47`, `docs/plans/2026-10-27-aiboard-remote.md:163`, `docs/plans/2026-10-27-aiboard-remote.md:268`).

D17 supersedes the unchanged non-process catalog proposals where `expose_with_approval` implies mandatory default consent; for example, file mutations still carry that older proposal in the catalog (`docs/remote/r0/runner-tool-catalog.json:576`, `docs/remote/r0/runner-tool-catalog.json:615`, `docs/remote/r0/runner-tool-catalog.json:714`).

In the table, `D` means `deviceId?`; omission is valid only with exactly one authorized online device, otherwise return a typed selection error. `K` means a required caller-stable `idempotencyKey` for the logical effect. `repoPath?` selects a requested repository; Runner must validate it and derive the actual broker workspace, rather than accepting a model-authored execution context. Relative paths and `cwd` default to the device's launch directory under D9. `?` marks optional parameters. `R/D/I/O` are `readOnlyHint / destructiveHint / idempotentHint / openWorldHint`; `T` and `F` are literal booleans. `yes` means a new durable jobId is returned promptly; `maybe` means bounded inline completion or a jobId; `no` means no new jobId. A returned processId and jobId are distinct.

| MCP name | Runner mapping / source | R/D/I/O | Parameters | New jobId |
| --- | --- | --- | --- | --- |
| `devices_list` | New P1 device registry (`docs/plans/2026-10-27-aiboard-remote.md:215`) | T/F/T/F | none | no |
| `files_read` | `fs.read` (`runner-v2/src/filesystem-tools.ts:122`) | T/F/T/F | path, startLine?, endLine?, D | maybe |
| `files_list` | `fs.list` (`runner-v2/src/filesystem-tools.ts:300`) | T/F/T/F | path, maxDepth?, D | maybe |
| `files_search` | `fs.search` (`runner-v2/src/filesystem-tools.ts:335`) | F/F/F/F | path, pattern, regex?, caseSensitive?, include?, exclude?, includeIgnored?, includeGenerated?, includeVendored?, includeBinary?, contextLines?, maxMatches?, cursor?, cancel?, D | maybe |
| `files_write` | `fs.write` (`runner-v2/src/filesystem-tools.ts:468`) | F/T/F/F | path, content, expectedSha256?, createDirectories?, D, K | yes |
| `files_patch` | `fs.patch` (`runner-v2/src/filesystem-tools.ts:489`) | F/T/F/F | path, expectedSha256, search?/replace? or edits[], D, K | yes |
| `files_move` | `fs.move` (`runner-v2/src/filesystem-tools.ts:551`) | F/T/F/F | source, destination, createDirectories?, D, K | yes |
| `files_delete` | `fs.delete` (`runner-v2/src/filesystem-tools.ts:584`) | F/T/F/F | path, recursive?, D, K | yes |
| `process_start` | `process.start` (`runner-v2/src/managed-process-tools.ts:23`) | F/T/F/T | command, args?, cwd?, env?, interactive?, D, K | yes |
| `process_run` | `process.run` (`runner-v2/src/process-tools.ts:40`) | F/T/F/T | command/args or shell/script, cwd?, env?, timeoutMs?, D, K | yes |
| `process_read_output` | `process.read_output` or `process.poll` for `view=snapshot` (`runner-v2/src/managed-process-tools.ts:50`, `runner-v2/src/managed-process-tools.ts:88`) | T/F/T/F | processId, view?, cursor?, stream?, maxBytes?, waitMs?, tailBytes?, range?, D | maybe |
| `process_write_stdin` | `process.write_stdin` (`runner-v2/src/managed-process-tools.ts:61`) | F/T/F/T | processId, writeId, data?, appendNewline?, closeInput?, D, K | yes |
| `process_signal` | `process.signal` (`runner-v2/src/managed-process-tools.ts:122`) | F/T/F/T | processId, signal, D, K | yes |
| `process_list` | `process.list` (`runner-v2/src/managed-process-tools.ts:113`) | T/F/T/F | D | maybe |
| `git_status` | `git.status` (`runner-v2/src/git-tools.ts:22`) | T/F/T/F | repoPath?, D | maybe |
| `git_diff` | `git.diff` (`runner-v2/src/git-tools.ts:44`) | T/F/T/F | repoPath?, staged?, base?, D | maybe |
| `git_log` | `git.log` (`runner-v2/src/git-tools.ts:60`) | T/F/T/F | repoPath?, limit?, D | maybe |
| `git_commit` | `git.commit` (`runner-v2/src/git-tools.ts:170`) | F/T/F/T | repoPath?, message, D, K | yes |
| `jobs_status` | New R2 job index (`docs/plans/2026-10-27-aiboard-remote.md:198`) | T/F/T/F | jobId, D | no |
| `jobs_events` | New R2 event journal (`docs/plans/2026-10-27-aiboard-remote.md:193`) | T/F/T/F | jobId, cursor?, limit?, D | no |
| `jobs_result` | New R2 result reference (`docs/plans/2026-10-27-aiboard-remote.md:198`) | T/F/T/F | jobId, cursor?, maxBytes?, D | no |
| `jobs_cancel` | New R2 cancellation (`docs/plans/2026-10-27-aiboard-remote.md:195`) | F/T/F/T | jobId, D, K | no |
| `artifact_read` | `artifact.read` (`runner-v2/src/artifact-tools.ts:35`) | T/F/T/F | hash, offset?, maxBytes?, D | maybe |
| `image_inspect` | `image.inspect` (`runner-v2/src/image-tools.ts:20`) | T/F/T/F | path or artifactHash, crop?, maxDimension?, D | maybe |
| `browser` | `browser.open/navigate/snapshot/click/fill/wheel/drag/screenshot/events/close` (`runner-v2/src/browser-tools.ts:381`) | F/T/F/T | action, action-specific url?/width?/height?/selector?/value?/deltaX?/deltaY?/button?/steps?, D, K | yes |

`files_search` is conservatively annotated non-read-only because its optional `cancel` ends a search session; ordinary queries are read-only. `process_read_output.view` is `output` by default or `snapshot` for `process.poll`. `browser` is conservatively annotated for its most consequential action, and its schema must use action-specific variants; screenshot is reachable through `action=screenshot`. Browser actions operate on Runner-managed browser sessions, not the desktop (`runner-v2/src/browser-tools.ts:381`, `runner-v2/src/browser-tools.ts:515`). The general browser operation can submit forms, so it is open-world and destructive. Read-only hints do not replace authorization, and the idempotency key does not make a destructive tool generally idempotent.

`process_start` and both modes of `process_run` are available by default under D17 after S1's local device policy is implemented. Read-only or shell OFF blocks launch and stdin to existing processes; per-command approval gates launches and stdin when enabled. Read-only also blocks mutating tool actions. The file-tool denylist and `--only-here` do not confine commands or descendants by default; they may access files, credentials and networks available to the OS user. S2 is optional post-launch safe mode, not a launch prerequisite (`docs/plans/2026-10-27-aiboard-remote.md:186`, `docs/plans/2026-10-27-aiboard-remote.md:187`, `docs/plans/2026-10-27-aiboard-remote.md:266`). Today `process.run` grants a write path for `cwd` and invokes the selected executable/shell (`runner-v2/src/process-tools.ts:60`, `runner-v2/src/process-tools.ts:141`), while Full process-group execution is expressly unconfined (`runner-v2/src/execution-isolation-provider.ts:347`). The existing browser URL validator only checks HTTP(S), so remote browser navigation also requires the planned private-network/redirect protections before exposure (`runner-v2/src/browser-tools.ts:604`, `docs/plans/2026-10-27-aiboard-remote.md:146`).

Managed process operations retain exact Runner ownership: `runId`, `sessionId`, actor role, and actor ID must match (`runner-v2/src/managed-process.ts:223`, `runner-v2/src/managed-process.ts:334`, `runner-v2/src/managed-process.ts:371`). R2 must durably bind a remote principal to that Runner-issued owner across reconnects without allowing callers to choose or widen it. The stdin channel is a pipe; `writeId` preserves the existing acknowledgement/uncertainty contract and EOF is distinct from a signal (`runner-v2/src/managed-process-tools.ts:61`, `runner-v2/src/managed-process-tools.ts:163`).

`git_commit` retains the existing task-branch check and worker role; it is not a general commit of an arbitrary current branch (`runner-v2/src/git-tools.ts:182`, `runner-v2/src/role-capabilities.ts:250`). `artifact_read` and `image_inspect` with an artifact hash require a new account/device/job-to-artifact authorization proof: the current read tool verifies and fetches by hash without such a remote principal check (`runner-v2/src/artifact-tools.ts:56`, `runner-v2/src/image-tools.ts:37`).

Jobs use record-before-dispatch admission in Runner, bind key + principal + payload digest, and reject conflicting reuse. An HTTP disconnect ends the wait only; cancellation returns `cancel_requested`, confirmed `stopped`, or `effect_outcome_unknown` distinctly. Never automatically replay ambiguous effects. When device policy enables approval, a `yes` response may initially be `awaiting_approval`; status/events/result do not create another job (`docs/plans/2026-10-27-aiboard-remote.md:142`, `docs/plans/2026-10-27-aiboard-remote.md:144`, `docs/plans/2026-10-27-aiboard-remote.md:193`). Each action and later result retrieval must recheck the appropriate current authorization.

For P2, only explicitly remote-enabled, individually allowed plugin tools may be listed. Publish each as `plugin_<normalized_server>_<normalized_tool>_<digest8>`; lowercase and replace other characters with underscores, bound the full name to 64 characters, and retain the digest suffix when truncating. Detect a collision and fail closed or expand the suffix. This denotes a naming rule, not an invented installed tool; bind the name to the exact Runner registration. Plugin calls also take `deviceId?` and, for effectful calls, `idempotencyKey`. Preserve Runner admission checks and apply conservative per-tool MCP hints. GUI plugins remain post-launch under D11, with separate opt-in and local safeguards (`docs/plans/2026-10-27-aiboard-remote.md:42`, `docs/plans/2026-10-27-aiboard-remote.md:259`). Existing MCP registration derives read-only status from both annotations, and current extension contracts provide `toolApproval` rather than a remote exposure switch (`runner-v2/src/mcp-tools.ts:164`, `runner-v2/src/extension-management-contracts.ts:78`). Never publish plugin capabilities that provide a parallel ungoverned filesystem, process or shell route.

## Consequences

The connector must route to the real broker and preserve effect, role, grant, ownership, revision, and extension checks; a remote action cannot become a Build Architect or verifier lifecycle call. A process may be visible in its original owner's process list after reconnect only if the durable binding restores that exact owner. Results may require chunking and artifact authorization before large output is usable (`runner-v2/src/managed-process.ts:223`, `runner-v2/src/artifact-tools.ts:62`, `docs/plans/2026-10-27-aiboard-remote.md:200`).

## Alternatives rejected

| Alternative | Reason |
| --- | --- |
| Generic remote shell or independent file server | Bypasses Runner authority; the plan requires the connector to dispatch through Runner (`docs/plans/2026-10-27-aiboard-remote.md:178`). |
| Mirror every internal or dynamic tool | Exposes lifecycle authority and makes configuration-dependent names appear universally available (`runner-v2/src/build-runtime.ts:5935`, `runner-v2/src/mcp-tools.ts:156`). |
| Treat a call timeout or cancel request as proof of no effect | The job contract explicitly preserves uncertainty (`docs/plans/2026-10-27-aiboard-remote.md:142`, `docs/plans/2026-10-27-aiboard-remote.md:144`). |
| Claim current Full execution already enforces S1 | It explicitly discloses unconfined execution (`runner-v2/src/execution-isolation-provider.ts:347`). |

## Open questions

| Question | Needed before |
| --- | --- |
| Which OS providers can enforce the file exclusions and cwd scope on commands and descendants? | Optional post-launch S2 safe mode; not default process exposure. |
| How will an authenticated remote session obtain an eligible Runner task context for `git_commit` while preserving its task-branch and worker restrictions? | Enabling `git_commit`; otherwise it remains unavailable. |
| How will Runner bind an artifact to the authorized remote principal and job, including after restart? | Enabling hash-based artifact retrieval or inspection. |

## Gaps

| Desktop Commander capability | Current Runner coverage and disposition |
| --- | --- |
| `read_multiple_files` | One `fs.read` per path; batch client-side now, consider a governed batch tool later (`runner-v2/src/filesystem-tools.ts:122`). |
| `create_directory` | No standalone empty-directory tool in the filesystem factory; `fs.write` can create parent directories while writing a file. Add a governed mkdir later (`runner-v2/src/filesystem-tools.ts:468`, `runner-v2/src/filesystem-tools.ts:481`). |
| Complete directory listing | Current `fs.list` skips ignored/build-output paths and has no `includeIgnored` input; S1/P2 must extend the governed Runner listing if whole-machine enumeration needs those entries, while retaining the denylist (`runner-v2/src/filesystem-tools.ts:53`, `runner-v2/src/filesystem-tools.ts:643`). |
| Filename search, `get_more_search_results`, `stop_search`, `list_searches` | `fs.search` is content search with a query-bound cursor and cancellation; filename search and listing all searches need separate design later (`runner-v2/src/filesystem-tools.ts:49`, `runner-v2/src/filesystem-tools.ts:648`). |
| `list_processes`, `kill_process`, arbitrary `list_sessions` | Current process list and signal operate on the exact Runner owner; global host listing/kill is later under X2 with explicit approval and identity proof (`runner-v2/src/managed-process.ts:223`, `runner-v2/src/managed-process.ts:334`, `docs/plans/2026-10-27-aiboard-remote.md:270`). |
| `interact_with_process` as a terminal | Existing interactive input is a pipe, not a PTY; a PTY adapter is later (`runner-v2/src/managed-process-tools.ts:163`, `docs/plans/2026-10-27-aiboard-remote.md:270`). |
| `get_config`, `set_config_value` | No equivalent general remote Runner configuration API in the catalog. Keep security/extension configuration in user-controlled local/dashboard flows; never expose generic config mutation. |
| Desktop GUI | Not a native remote tool; curated, explicitly enabled GUI plugins are post-launch (`docs/plans/2026-10-27-aiboard-remote.md:259`). |

## Plan corrections

| Plan wording | Current code / required correction |
| --- | --- |
| R0 asks which of `process.run/execute/shell` to expose. | Only `process.run` is a tool; `process.execute` and `process.shell` are its input-dependent access capabilities, as the updated inventory notes (`docs/plans/2026-10-27-aiboard-remote.md:71`, `docs/plans/2026-10-27-aiboard-remote.md:153`, `runner-v2/src/process-tools.ts:34`, `runner-v2/src/process-tools.ts:60`). |
| Section 2's reusable `fs.list` does not describe its filtering. | It skips ignored/build-output paths, and its schema lacks an option to include them; it is not yet a complete whole-machine directory listing (`runner-v2/src/filesystem-tools.ts:53`, `runner-v2/src/filesystem-tools.ts:643`). |
| P2 lists `git commit` as part of the general remote surface. | The existing implementation stages all changes and commits only on task-named branches; preserve that limit or leave the tool unavailable until a separately governed general commit exists (`runner-v2/src/git-tools.ts:182`). |
| Section 3 requires per-action consent for high risk; T08 does not qualify the denylist by tool type. | D17 supersedes mandatory default consent and limits the denylist claim to file tools; current Full execution is unconfined (`docs/plans/2026-10-27-aiboard-remote.md:48`, `docs/plans/2026-10-27-aiboard-remote.md:134`, `docs/plans/2026-10-27-aiboard-remote.md:186`, `docs/plans/2026-10-27-aiboard-remote.md:325`, `runner-v2/src/execution-isolation-provider.ts:347`). |

## Evidence

- Static tool definitions and input schemas: `runner-v2/src/filesystem-tools.ts:85`, `runner-v2/src/git-tools.ts:19`, `runner-v2/src/process-tools.ts:34`, `runner-v2/src/managed-process-tools.ts:18`, `runner-v2/src/browser-tools.ts:381`, `runner-v2/src/code-intelligence-tools.ts:20`.
- Broker and roles: `runner-v2/src/tool-broker.ts:262`, `runner-v2/src/role-capabilities.ts:89`, `runner-v2/src/worker-runtime.ts:195`, `runner-v2/src/build-runtime.ts:5935`.
- Extensions, artifacts and ownership: `runner-v2/src/extension-management-tools.ts:24`, `runner-v2/src/extension-management-contracts.ts:57`, `runner-v2/src/mcp-tools.ts:156`, `runner-v2/src/artifact-tools.ts:31`, `runner-v2/src/managed-process.ts:334`.
