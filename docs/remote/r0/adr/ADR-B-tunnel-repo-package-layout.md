# ADR-B: Tunnel repository and package layout

## Status

Proposed.

## Context

The tunnel is an npm-workspaces monorepo; its shared package exports protocol and utility code, the relay serves a custom device JSON-RPC route, and its connector owns a local stdio MCP child (`D:/repos/aiboard-tunnel/package.json:10`, `D:/repos/aiboard-tunnel/packages/shared/package.json:6`, `D:/repos/aiboard-tunnel/packages/relay/src/server.ts:7`, `D:/repos/aiboard-tunnel/packages/connector/src/connector.ts:2`). The relay currently persists a JSON document and accepts a query token for device connections (`D:/repos/aiboard-tunnel/packages/relay/src/store.ts:4`, `D:/repos/aiboard-tunnel/packages/relay/src/server.ts:522`). Runner authority and the D2–D5/D12 owner decisions are fixed (`docs/plans/2026-10-27-aiboard-remote.md:33`, `docs/plans/2026-10-27-aiboard-remote.md:43`).

## Decision

| Package | Decision |
| --- | --- |
| `packages/shared` | Keep internal v1 JSON-RPC, IDs and logging utilities during migration; do not treat the whole package as the Runner dependency. |
| `packages/protocol` | Add `@aiboard/remote-protocol`: versioned wire types, JSON schemas and compatibility fixtures only. Runner V2 consumes an exact, integrity-pinned immutable package/tarball and imports types or schema data only; it never imports relay, connector, authentication, execution or SDK implementation. Unknown protocol versions fail closed. Release the package and cross-repo compatibility tests together. |
| `packages/relay` | Keep and harden as the single process composition root: WSS transport, connection epochs, limits, routing, health and dependency wiring. It delegates work; it does not execute tools. Remove query-token authentication and replace v1 assumptions deliberately. |
| `packages/connector` | Keep as v1 compatibility/reference and test harness, not as the production Runner connector. Reimplement/adapt useful framing and reconnect behavior inside Runner V2 under Runner lifecycle/authorization; do not launch the legacy stdio child for remote work. |
| `packages/client`, `packages/e2e` | Keep the v1 client for compatibility and fixtures until explicitly retired; extend e2e to test the Runner-bound bridge and standard MCP client, without making the v1 client the public MCP contract. |
| `packages/accounts`, `packages/billing`, `packages/storage` | Add account/provider login, MCP authorization and device/session domain; Paddle webhooks, entitlements and usage; and SQLite repositories/migrations, respectively. Account and billing services expose narrow ports; storage implements those ports, with relay composing them. |
| `packages/mcp-gateway`, `packages/dashboard` | Add a gateway containing the official MCP TypeScript SDK server, Streamable HTTP transport and auth helpers; it invokes account/entitlement and Runner-routing ports. Add server-rendered HTML dashboard views with small progressive-enhancement scripts, served by the relay at `https://mcp.aiboard.me/`; `/mcp` and OAuth routes share that origin. |

Dependencies flow from the composition root to domain services and adapters; domain services depend on contracts/ports, not on the composition root or one another's storage internals. The dashboard never owns authorization decisions. Same-origin cookie sessions use `HttpOnly`, `Secure`, `SameSite=Lax`, explicit CSRF and Origin checks; no secrets enter static JS. Protect all MCP operations with account, device, entitlement and local Runner authorization.

Use Node 24 `node:sqlite` with one writable database on a persistent volume. Ordered, versioned migrations run transactionally before readiness with a single-writer lock; abort startup on unknown/newer or failed schema. Back up and verify restore before incompatible migrations; rollback requires a compatible prior schema or a verified restore, never silently start old code against a newer schema. Migrate legacy JSON through an explicit validated import preserving revocations and hashed credentials, with an offline backup and no automatic fallback to JSON. Store only account/device/session/job indexes, counters and redacted audit; never persist payloads or artifacts on the relay.

| FunBoard reuse | Decision |
| --- | --- |
| Google | Copy/adapt its bounded token/JWKS parsing, PKCE, `jose` issuer/audience/signature/expiry/nonce/authorized-party validation and key-rotation handling (`D:/repos/FunBoard/lib/server/oauth-google.ts:6`, `D:/repos/FunBoard/lib/server/oauth-google.ts:13`, `D:/repos/FunBoard/lib/server/oauth-google.ts:20`). |
| HTTP/session | Copy the server redirect, callback host/path and duplicate-parameter checks, state-to-browser binding, no-store/no-referrer and secure cookie pattern (`D:/repos/FunBoard/lib/server/oauth-http.ts:12`, `D:/repos/FunBoard/lib/server/oauth-http.ts:20`, `D:/repos/FunBoard/lib/server/oauth-http.ts:38`). Adapt Next-specific APIs and FunBoard guest/account-linking to relay-owned HTTP and SQLite sessions; never copy its fragment-token redirect into AIBoard. |
| Providers | Adapt environment-driven provider selection and separate local/production clients; request Google `openid profile email` rather than FunBoard's `openid profile`, and implement GitHub OAuth identity lookup and state/PKCE checks separately (`D:/repos/FunBoard/lib/server/oauth-google.ts:13`). Bind identities by provider and stable subject; never merge accounts solely on an email match. FunBoard's registry is Google + Discord, not GitHub (`D:/repos/FunBoard/lib/server/oauth-providers.ts:5`). Do not invent an OIDC ID-token validation step for a GitHub OAuth response. |

Build one pinned Node 24, non-root Docker image with only production modules/assets; bind the container to loopback behind Nginx TLS, mount SQLite on a private volume and inject secrets from the host. A separate staging host/config precedes production. The tunnel workflow is `workflow_dispatch` only, validates pinned host/port/user, verifies an approved image digest, checks migration compatibility, deploys, probes health/readiness and automatically restores the previous compatible image on failure. Copy the host pinning and staged checksum pattern, not FunBoard-specific sudo/paths (`D:/repos/ai-discussion-board/.github/workflows/funboard-private-vps.yml:6`, `D:/repos/ai-discussion-board/.github/workflows/funboard-private-vps.yml:39`, `D:/repos/ai-discussion-board/.github/workflows/funboard-private-vps.yml:92`). Deployment still needs owner authorization.

For the plan's 1-vCPU/1.9-GiB shared VPS, budget <256 MiB process RSS under representative load and a 320 MiB container cap, including SQLite/cache; bound request buffers, sessions, sockets and concurrency. Use the plan's available-memory figure only as a dated estimate, reserve at least 512 MiB of that estimate for co-hosts/OS, and measure RSS, cgroup memory, CPU and disk under expected idle/active device counts before setting a capacity ceiling (`docs/plans/2026-10-27-aiboard-remote.md:6`, `docs/plans/2026-10-27-aiboard-remote.md:227`, `docs/plans/2026-10-27-aiboard-remote.md:277`).

## Consequences

The single process and server-rendered dashboard conserve resources but provide no HA. A new versioned package release and migration discipline become cross-repo gates. Compatibility code remains until explicitly retired; no current implementation is claimed to provide the new service.

## Alternatives rejected

- Importing the existing connector into Runner would retain a separate stdio process owner and unnecessary coupling.
- A separate dashboard SPA/backend or multi-service deployment adds processes, cookie/CORS complexity and memory overhead to this VPS.
- Retaining the JSON store for accounts, metering and webhooks lacks the selected transactional migration boundary.

## Open questions

- Where will the immutable protocol package and release artifacts be hosted, and which signing keys will the operator provision?
- What device/concurrency ceiling results from the required VPS measurement?

## Plan corrections

The older VPS snapshot says disk cleanup is still required (`docs/plans/2026-10-27-aiboard-remote.md:89`); the later owner-prerequisite section says cleanup is done (`docs/plans/2026-10-27-aiboard-remote.md:277`). Treat the latter as the newer plan statement, not live evidence; remeasure before deployment. FunBoard's provider registry contains Discord rather than the required GitHub provider, and its callback emits a fragment grant (`D:/repos/FunBoard/lib/server/oauth-providers.ts:8`, `D:/repos/FunBoard/lib/server/oauth-http.ts:35`); neither is copied as an AIBoard bearer-token URL.

## Evidence

Inspected AIBoard `d7ed04d2505869f5d52ac17bfd1dfe92259b112f`, tunnel `69dc0658e97de9fb7404f750c443adfd29691bbf`, and FunBoard `59339b83a1275eca57981a1b44e7b7435750ea5e`.

- `D:/repos/aiboard-tunnel/package.json:10`; `D:/repos/aiboard-tunnel/packages/shared/src/protocol.ts:18`; `D:/repos/aiboard-tunnel/packages/relay/src/store.ts:4`; `D:/repos/aiboard-tunnel/packages/relay/src/server.ts:7`; `D:/repos/aiboard-tunnel/packages/connector/src/connector.ts:2`.
- `D:/repos/FunBoard/lib/server/oauth-google.ts:13`; `D:/repos/FunBoard/lib/server/oauth-providers.ts:5`; `D:/repos/FunBoard/lib/server/oauth-http.ts:12`.
- `D:/repos/ai-discussion-board/.github/workflows/funboard-private-vps.yml:6`; `D:/repos/ai-discussion-board/.github/workflows/funboard-private-vps.yml:39`; `D:/repos/ai-discussion-board/.github/workflows/funboard-private-vps.yml:92`.
