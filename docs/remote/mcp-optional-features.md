# MCP 2026-07-28 optional features

## Implemented

* Managed Streamable HTTP MCP clients advertise the Tasks extension and handle
  task handles using the official ext-tasks 0.2.3 schemas. Within the original
  bounded call they poll tasks/get, deliver explicit elicitation answers through
  tasks/update and try tasks/cancel on unsuccessful settlement. A terminal task
  result is projected through the existing tool-output path.
* HTTP multi-round-trip tools use a fresh JSON-RPC request ID, the original
  arguments, the exact returned requestState, and validated inputResponses.
  Every dispatch rechecks the existing authorization callback. A trusted
  McpInputResolver can provide an elicitation response; without one the request
  is declined. Sampling and roots are not implemented. A timeout or transport
  failure never authorizes a replay of the original call.
* The relay repository exposes a device dashboard MCP App via devices_list,
  alongside the existing image viewer, and advertises the UI extension.

* Native Runner chat now publishes in-memory, session-bound elicitation forms.
  Authenticated UI answers are validated against the supported scalar schema,
  are single-use, and expire when the original request stops. Source labels
  identify the configured server. URL mode and unsupported schema shapes are
  declined; answers are not put into the model transcript.
* The relay now accepts Tasks capability opt-in on modern HTTP. An admitted
  queued/running process_run or mcp_tool_call returns an opaque task receipt
  for its existing Runner job. tasks/get and tasks/cancel retain the original
  device, job, account, grant and conversation-derived principal. Receipts
  persist across normal relay restart in SQLite (24-hour TTL); account
  deletion and backup restore invalidate the appropriate receipts.

## Deliberate boundaries

The Tasks requester currently settles within the existing tool invocation. It
does not persist external task handles across Runner restarts. The relay's own
jobs_status/jobs_result/jobs_cancel workflow remains the existing API; it is
also available as a standardized Tasks receiver for eligible long-running jobs. Other calls retain their existing result shape.

The Runner's owned stdio channel retains its original single-use grant and
exclusive operation ownership. Modern tools/call may now advance only through
response-proven protocol steps (see Owned stdio Tasks and MRTR below).
Legacy requests still permit one application write plus exact cancellation.
Modern owned stdio Apps can be displayed in native chat (see below).

Native chat supports form elicitation via the trusted resolver. Remote gateway forwarding is now supported through the Tasks extension for eligible managed HTTP calls. Build elicitation is not wired. Direct modern upstream MRTR is now supported for managed remote calls (see below). Do not treat a command approval as an
answer to an arbitrary downstream elicitation. The Apps work publishes
server-side resources and now includes a restricted native chat MCP Apps host.

## Native chat MCP Apps host

Managed HTTP tool metadata binds the exact UI resource URI into the reviewed
tool inventory. For a successful admitted chat call, the Runner reads the
associated resource from the same MCP server, validates its MIME and URI,
and keeps HTML and tool arguments/result (including UI-only metadata) in a
bounded in-memory store. Cards expire after 30 minutes or dismissal; the
model transcript does not receive UI HTML or result metadata. The browser
fetches the payload only after the user opens the card. The official
ext-apps 2.0.4 AppBridge handles initialization, tool-input and tool-result
notifications, resizing, teardown, and the frame can be expanded by the user.

Only self-contained HTML is supported. Sandbox uses allow-scripts without
allow-same-origin; an enforced CSP blocks subresource and connection loads,
and browser permissions and host actions are denied. An iframe sandbox/CSP
is not a complete network isolation boundary (self-navigation can still
make requests); open only trusted apps. No Runner credentials are provided
to the frame. External CSP domains and requested device permissions are
not supported. App-initiated resource calls, model-context changes, external links, downloads,
and app-only tools remain disabled. App-initiated calls to reviewed
read-only/non-destructive HTTP tools now have a separate human consent path. Apps are advertised for
native chat and its inventory check; a context-dependent inventory that
differs in other callers fails the existing schema review check. Build apps and persistent app views are not yet implemented.

## Validation

Run npm run typecheck:runner-v2 and the affected tests
mcp-chat-input.test.ts, mcp-chat-app.test.ts, mcp-optional-features.test.ts, mcp-modern-protocol.test.ts,
extension-mcp-remote.test.ts and local-stdio-mcp.test.ts. The relay's
mcp-gateway.test.ts covers authenticated App resource discovery and retrieval.

Browser smoke: npx tsx scripts/test-mcp-app-host.mts (requires installed Chromium).

## App-initiated tool calls (restricted first pass)

A native chat app can request a tool from its originating managed HTTP server.
The Runner captures the pinned extension entry, reviewed inventory digest and
allowed names at publication. Only admitted tools explicitly marked
readOnlyHint=true and destructiveHint=false, and not model-only, are eligible.
The app cannot select a server, URL, credential, or tool outside this set.

The authenticated host stages an immutable, random, one-use ticket with exact
arguments (16 KiB maximum). The parent UI displays the server, name and exact
arguments and asks the user to allow or deny. Focus starts on Deny and the
allow button is armed only one second after the dialog appears, so an App
cannot time a layout shift or a click onto it. Tickets expire within 60 seconds;
one request may be pending or running per app and 20 staged requests are
allowed per app, including denials. Approval consumes the ticket before any
network dispatch; retries cannot reuse it. A fresh MCP client rechecks the
original inventory and both the originating and requested tool's current
admission policy, then rechecks authorization before dispatch and continuation.
The result goes directly back to the app, not into the model transcript.
Dismissal/expiry interrupts the local call; it is not proof of downstream
cancellation. No original operation is replayed automatically.

This is a human-approved, read-only path through managed extension admission,
not a model ToolBroker invocation. Downstream server annotations are claims,
not a guarantee of absence of side effects. Arbitrary writes, app-only tools
not present in the reviewed inventory, app resource reads, external host actions,
and interactive human elicitation during app calls are not enabled. The server
still performs its own tool argument schema validation. Fresh HTTP sessions
may not support apps whose tools require the original server session state.
No app-specific raw arguments or results are persisted by the app store.

Tests: runner-v2/test/mcp-chat-app.test.ts covers ticket ownership, immutable
arguments, deny/approve/replay, expiry, prompt bounds and dismissal.
extension-mcp-remote.test.ts covers managed approval with live policy revocation.
scripts/test-mcp-app-host.mts exercises trusted host approval and denial in
Chromium as well as the existing sandbox boundaries.

## Remote MRTR via Tasks (first pass)

For a modern MCP client advertising both Tasks and form elicitation, the
relay injects a signed internal forwarding flag only when a device reports
mcpTaskInput capability. The public mcp_tool_call argument schema does not
expose this flag. The original Runner job stays active; it never replays
the initial tool call. The downstream HTTP resolver retains the original
opaque requestState and input-request keys. It exposes a single validated
scalar form at a time under an independent random prompt ID. The original
job's abort signal removes the prompt.

tasks/get returns input_required with inputRequests when the active job is
waiting for input. tasks/update extracts the SDK's lifted inputResponses
from its request context and forwards them over the signed device route as
an internal jobs_mcp_input operation, not a new public tool. The task
receipt binds the original account, OAuth grant, conversation principal,
device and job. The Runner independently checks scope, write operation
class, exact job owner, original authorization, current device policy and
prompt ID, validates the answer, and consumes it once. No answer is recorded
in the app store or job admission ledger by this bridge. User input may be
part of the actual downstream tool result; ordinary result retention applies.
The external host is responsible for presenting the form and obtaining an
explicit human decision; the Runner cannot verify how that host obtained it.

This preserves existing job and downstream call deadlines, including the
default 30s managed call timeout (explicit timeoutMs up to 120s). A human
answer must arrive within the remaining budget. Unsupported form schemas,
URL elicitation, sampling and roots are not forwarded. Incompatible hosts
or devices retain the previous workflow; direct tools/call input_required forwarding is covered by the direct MRTR pass below. Prompt recovery after restart remains unimplemented. Pending prompts are intentionally in memory only.

Deployment order: update the relay before the new Runner, because older
relay status parsers reject unknown fields. A new relay recognizes older
Runner status frames and does not send the forwarding flag to those devices.
External host capability support must be verified after deployment.

Validation: remote-jobs.test.ts covers signed job ownership, form validation
and replay; extension-mcp-remote.test.ts exercises the actual managed HTTP
provider continuation; relay mcp-gateway.test.ts checks the real SDK Tasks
handler, grant fencing and capability gating.

## Owned stdio Tasks and MRTR

The modern McpRpcPeer advertises Tasks and form elicitation. McpSessionManager
settles modern continuations with the common bounded HTTP/stdio settlement
helper. The original owning agent, process, tool grant, envelope and deadline
stay in force for the whole exchange; no second execution grant is minted.
A trusted resolver receives the configured server name. Without a resolver
the request is declined. All concrete writes recheck current session authority
and the existing external authorization callback.

The private McpStdioContinuation fence in StreamingRequestOperation consumes
the exact owned stdout frames before handing them to the RPC peer. It requires
a canonical modern initial tools/call, a correlated response ID and a verified
request-write acknowledgement. It independently permits only the exact
original tool name and arguments plus returned requestState and requested
input IDs, or a task get/update/cancel tied to the returned task ID and state.
It rejects arbitrary methods, changed metadata, concurrent writes, repeated
IDs, unrelated task IDs, incorrect response IDs, malformed frames and
unsupported input methods. Continuations are limited to eight rounds, task
polls to 240, task updates to eight. Cancellation must match the in-flight
request ID or the exact active task. Unknown outcomes are never replayed;
uncertain or invalid protocol ownership goes through existing verified cleanup.
The fence verifies the protocol envelope; human consent and form schema
validation remain the trusted resolver's responsibility.

This does not implement legacy
standalone/connector optional features, unsolicited server-initiated legacy
elicitation, or persistence of downstream task handles across restart.
The normal tool timeout remains in force. Cancellation is best-effort;
it is not proof of external effect termination.

Tests: mcp-stdio-continuation.test.ts (wire authority, IDs, args, state,
task and revocation); mcp-modern-protocol.test.ts (real SDK stdio MRTR and
Tasks); mcp-lazy-native.test.ts (actual ExecutionHost and ToolBroker,
owned process, task update, exact cleanup and fresh-grant reuse).

## Owned stdio MCP Apps (display pass)

Discovery probes server/discover for at most 10 seconds; a legacy server that
ignores pre-initialize requests is reaped and relaunched with initialize.

Modern stdio discovery retains valid ui:// resource URIs and visibility
metadata in the immutable reviewed inventory; app-only tools are not exposed
to the model. Native chat can publish self-contained apps after an admitted
tool completes. The transport derives a per-operation app resource binding
from the verified discovery inventory and the original tool owner. The wire
fence permits precisely one resources/read for that URI, only after the
matching tool or task has returned successful completed content. The read
uses the same process, grant and authorization rechecks. A result cannot
nominate a new URI, and arbitrary resource reads remain blocked.

HTML and app-specific metadata are handed to the existing per-chat app
store, not the model-facing result. The existing AppBridge sandbox and
explicit Open action render the local app. The app store does not persist
the payload; normal owned process output/evidence retention still applies.
The resource read is capped at five seconds within the original call
budget. A normal resource failure skips the app; broken protocol ownership
is retired using the existing cleanup path. No tool invocation is replayed.

This is modern stdio support only. Legacy stdio apps, app-only tools,
external resources and persistent views remain unsupported. App-initiated
read-only stdio calls now use a new owned execution binding (see below). The UI capability is advertised consistently during modern
stdio discovery and live handshake; only contexts with a native chat
publisher actually fetch or present an app. A fresh grant is required for
any future app-initiated stdio tool operation.

## Owned stdio App-initiated calls

A managed native-chat stdio App now gets an authority for the intersection
of the original server's reviewed inventory and its admitted tools explicitly
marked readOnlyHint=true and destructiveHint=false. Model-only and app-only
tools remain excluded. The App cannot choose another server, extension,
version, configuration or generation. The existing host UI stages and
confirms one immutable ticket per request; denial, expiry and replay never
dispatch a tool.

After approval the original chat may already be closed. The Runner checks
both the originating and requested tool against the pinned and live policy,
creates a unique short-lived ExecutionHost run, rediscovers only the original
managed server and checks the exact reviewed inventory digest. It registers
only the requested tool in a fresh ToolBroker. The broker issues a fresh
execution grant for that operation; no original grant or process is reused.
The current policy and App lifetime are checked again on dispatch and modern
continuations. The original MCP result is returned out of band to the App;
the broker sees only a status, not a model-facing transcript entry. Ordinary
owned-process evidence retention still applies. The new binding is closed
with verified cleanup before returning, including on cancellation or failure.
Runner shutdown revokes and awaits all active App calls.

Each approved call starts a new server process, so tools relying on in-memory
state or server session continuity may not work. Existing timeout limits
remain in force, including the App's 60-second call budget which includes
discovery and launch. Stdio processes are governed by the normal managed MCP
execution policy, not made read-only by the App itself: read-only annotations
are server claims, not an OS sandbox. Write calls, app-only tools and new
elicitation UI for App calls are not enabled. If the pinned generation or
original extension is unavailable, the call fails closed. No automatic retry
or reuse of an expired grant occurs.

Validation: extension-mcp.test.ts runs a real managed stdio server and native
chat, closes the chat turn, invokes a user-approved App call in a fresh process,
checks the returned UI metadata, rejects denial/replay/model-only and write
tools, revokes policy, and verifies no active ExecutionHost runs remain.
mcp-chat-app.test.ts covers ticket isolation, limits and shutdown cleanup.

## Direct remote MRTR without Tasks

Modern HTTP clients advertising form elicitation but not Tasks can receive
input_required directly in tools/call for an eligible managed MCP tool.
The relay uses the same capability-gated, signed Runner job input path as
the Tasks receiver. It never reissues the original tools/call during a
continuation. A short, bounded wait observes the original job and returns
a terminal result or a one-use opaque requestState plus inputRequests.

The state is generated by the relay and held only in memory. It binds the
exact canonical original tool arguments (including session and device),
account, OAuth grant, conversation-derived client ID, original job and
one prompt ID. Every continuation is reauthenticated and rate-limited.
The state is consumed before forwarding the answer; a lost update or
invalid downstream answer is not retried. The Runner validates the actual
form and independently checks its current job authority. At most eight
rounds per job are allowed. State expires at the earlier of the original
access token expiry or 120 seconds from initial admission; the shorter
original Runner deadline also remains in force. Relay restart discards
all direct states. The relay stores only job receipts and argument hashes,
not answers or downstream opaque requestState. Ordinary Runner evidence
and tool-result retention still apply.

The direct path uses the configured result-wait budget (at most 45 seconds
per request); if no prompt or result arrives in that budget, it returns a
job reference with an uncertain/pending outcome and never replays the
original operation. It cannot surface new direct prompts after that
fallback. The external host must collect explicit user input; this path
does not verify how the host collected it. Older devices and clients
without form capability, or a zero result-wait budget, retain their
existing behavior. Tasks-capable clients retain the standardized Tasks
workflow. URL elicitation, sampling and roots are not supported.

Tests in the tunnel relay mcp-gateway.test.ts exercise the real SDK
tools/call handler, multiple direct rounds, exact original arguments,
grant/account/conversation binding, token expiry, revocation, replay
rejection and capability gating. Existing Runner job-input and downstream
provider tests cover the shared signed input path.


## Durable downstream HTTP task recovery (first pass)

For a managed remote mcp_tool_call targeting a modern HTTP MCP server, the validated task handle and creation time
are recorded before polling. The Runner's admission database encrypts the
receipt with AES-256-GCM and binds its authentication data to account,
conversation client, device, job, original payload digest and expiry.
The receipt also pins the extension, version, generation, component
configuration digest, reviewed inventory digest, and tool. It contains
no tool arguments or credentials. Receipt lifetime is capped at 24 hours
and by the downstream task TTL when provided.

Startup reconciliation still marks interrupted effectful jobs unknown.
A subsequent signed jobs_status request by the original owner attempts
a bounded read-only recovery, at most once per five seconds per job,
with a global bound on concurrent/recent recoveries. The existing relay
Tasks path uses jobs_status and therefore needs no new public tool.
The Runner rechecks live device authorization, epoch, owner lock,
connection, scope, policy narrowing, extension admission and exact
configuration/inventory before asking the original server. It uses a
fresh modern HTTP client, discovery/list, and tasks/get only, never
tools/call, tasks/update or tasks/cancel in recovery. The response must
match both task ID and creation time and contain a completed tool result.
The original job then reconciles atomically with terminal evidence and
encrypted result; its idempotency tombstone remains. Failed/cancelled
status without completed content, pending tasks, missing/expired task IDs,
unavailable servers and changed permissions remain outcome_unknown.
Receipts are removed after known settlement or expiry.

The initial call retains its existing best-effort cancellation semantics.
Recovery is on demand, not an autonomous job resumer. There is no replay,
no recovery of pending elicitation, no recovery before the handle was
durably recorded, and no stdio or native-chat recovery in this pass.
Authenticated downstream servers require a matching credential lineage (see below).
A generation change also conservatively refuses recovery.

## Authenticated downstream HTTP recovery

The credential store now associates an opaque internal lineage with each
credential write, distinct from the stable public credential reference.
Even a replacement with exactly the same secret creates a new lineage.
The lineage is kept inside the encrypted credential envelope; old envelopes
derive an initial lineage using a domain-separated keyed HMAC. It is never
part of UI credential metadata. Task receipts bind to the lineage of the
actual Authorization header used on the initial tools/call; an unbound raw
authorization string cannot create a recoverable authenticated receipt.
Subsequent MRTR/task requests cannot switch lineages during the same call.

Bearer recovery requires the exact saved lineage. OAuth sign-in pins the
issuer token endpoint, client ID and resource in the encrypted credential
record. A refresh can preserve the lineage only for that exact client,
resource and unchanged scope set. A synchronous compare-and-swap of the
credential revision prevents an in-flight refresh from overwriting a newer
sign-in, replacement or revocation. Changed scopes or unpinned legacy client
configuration create a new lineage; an old task cannot recover with it.
Legacy credentials without a pinned client may recover while the current
access token is still usable but require a fresh sign-in for persistent
refresh continuity. This is local grant lineage, not an independent
assertion of a downstream OAuth subject or token introspection result.

Recovery verifies the credential before discovery, after policy checks,
immediately before the HTTP request, and before returning recovered data.
The refresh rechecks the credential revision before sending. One exchange
runs per credential revision, shared by concurrent callers, and is never
aborted by a caller's signal: an aborted sent refresh could lose a rotated
refresh token. A caller (including bounded recovery) only stops waiting; the
result is stored by compare-and-swap, so a sign-in or revoke that raced it wins. No raw access token,
refresh token or user secret is persisted in the task receipt. Existing
unauthenticated receipts remain readable; authenticated servers reject
receipts without a credential binding. Other task-recovery limitations
remain unchanged (no stdio restart, no pending elicitation resumption,
no replay, no automatic background recovery).


## Durable stdio task recovery (opt-in)

Modern stdio servers do not necessarily persist Tasks across process exits.
A managed server must explicitly declare both the Tasks extension and the
private AIBoard capability in server/discover:

    "extensions": {
      "io.modelcontextprotocol/tasks": {},
      "io.aiboard/durable-tasks": { "crossProcess": true }
    }

This is an AIBoard-specific opt-in, not a standard MCP requirement. The
server is responsible for persisting task IDs, creation times and results
independently of its process. Discovery and the original live handshake
must both advertise it. Recovery rediscovers and reattests the original
configuration, executable, generation, managed extension and reviewed
inventory, and checks the capability again in the fresh live handshake.
The encrypted receipt binds the original task to the observed stdio config
and executable digests. Managed install integrity is checked through the
existing launch path. This does not attest arbitrary script arguments or
external server storage beyond the existing executable/configuration checks.

This first pass records receipts only for remote managed stdio tools
explicitly marked read-only and non-destructive, with no declared environment
credentials. Recovery uses an isolated fresh ExecutionHost run and broker,
only the pinned server and tool, and one new grant. The dedicated manager
mode sends exactly one tasks/get for the stored ID, not tools/call,
tasks/update or tasks/cancel. Both ID and creation time must match and
the response must contain completed tool content. The process is cleaned
up before returning. It does not extend the original execution deadline
or the signed recovery request's budget. Missing opt-in, changed policy,
unverified completion, or expiry retains outcome_unknown. No process is
reused or restarted automatically merely because it exited.

The read-only annotation and durability declaration are server claims.
Managed stdio servers execute as the local user under existing MCP process
policy, not a new OS read-only sandbox. Arbitrary third-party stdio servers
are not automatically recoverable. Credentialed stdio, pending input,
native-chat recovery and general durable server identity are not covered.
A repository review of the fresh recovery path is required before release.

A real fixture persists the task to disk, exits during the first poll,
and returns it through a different PID. The test verifies one original
tools/call, two tasks/get requests, no duplicate effect, and verified
ExecutionHost cleanup. Capability parser tests reject ordinary Tasks
support as an implicit persistence declaration.


## App-initiated writes

Native chat MCP Apps may request reviewed tools from their original server.
Read-only calls retain their existing per-call confirmation. A write or
potentially destructive call additionally requires an exact explicit allow
entry in both the pinned and current tool filter, not merely default allow.
The existing per-server non-destructive setting still blocks destructive
or unspecified effects. The host derives the risk from reviewed annotations,
not App-supplied fields: explicit readOnlyHint=true and destructiveHint=false
is read-only; destructiveHint=false without readOnlyHint=true is write;
missing or true destructiveHint is potentially destructive. The host UI
shows the risk and exact arguments, and consumes the one-use ticket before
dispatch. No policy widening is performed by an App.

HTTP uses a fresh scoped modern client with a current credential-lineage
check, rediscovery of the identical inventory, and authorization checks
before credential access and actual dispatch. Stdio uses a fresh owned run,
ToolBroker grant and server process with the same policy/risk checks; no
original grant is reused. Credentialed stdio writes are deliberately
excluded until original environment credential lineage can be pinned across
launches. No App-only/model-only tools, external resources, automatic retry,
or new App elicitation UI is introduced. A lost response is not evidence
that the effect failed. Read-only/destructive annotations are server claims,
not OS restrictions, and approvals do not make untrusted servers safe.

Tests cover read-only/default-allow behavior, explicit write allowance,
denial, exact immutable arguments, one execution, policy revocation,
uncertain HTTP response without replay, and fresh stdio process cleanup.

## External static App resources (explicit per-view consent)

Both managed HTTP and modern owned stdio App resource responses may declare
_meta.ui.csp.resourceDomains. The Runner validates and retains only a
bounded list (at most eight) of exact HTTPS origins. No wildcard, IP
literal, non-default port, credentials, path, query, fragment, local
hostname, or raw CSP expression is accepted. Unsupported nonempty CSP
directives and device permission requests still refuse the App document.
Declarations remain in the ephemeral session-bound App payload, not the
model transcript. The Runner does not fetch external asset URLs or expose
an arbitrary URL-fetch proxy.

The trusted native chat host validates the list again. It presents the
exact origins before creating the iframe and offers one-time approval,
offline opening with the original CSP, or cancellation. Consent is not
stored or shared across views. Approved origins are added only to the
static script, style, image, font and media CSP directives. The sandbox
still has only allow-scripts and no same-origin access, no host tokens,
no device permissions, no direct API connections, nested frames, form
submission, workers or base URI overrides. All App tool calls still use
their separate existing approval system.

An allowed origin can serve executable script, and assets can transmit
data encoded in resource URLs. The browser may send applicable cookies
and expose the user's IP and request metadata; the UI explicitly warns
about these effects. CSP restricts origins, not DNS resolution or content
integrity, and does not guarantee complete navigation/egress isolation.
These are trusted external origins, not a security sandbox for an
untrusted App. No DNS pinning, wildcard support, connectDomains, nested
frames, external resource proxy, App-initiated MCP resources/read or
persistent permission is added. Full arbitrary MCP App compatibility
is not claimed.

Tests exercise strict origin validation, payload isolation, managed HTTP
and stdio resource metadata, and real Chromium behavior: no requests
before consent or in offline mode, loading an explicitly approved
static script, blocked undeclared scripts, API connections and nested
frames, plus existing tool approval and opaque-origin isolation.
