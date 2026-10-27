# ADR-G: Extension tool filters and remote exposure

## Status

Proposed.

## Context

The MCP component has `toolApproval?: "non_destructive" | "all"`; it has no per-tool filter or remote-exposure field (`runner-v2/src/extension-management-contracts.ts:57`, `runner-v2/src/extension-management-contracts.ts:78`). The current separate policy is stored in `mcp-tool-policy.json` and falls back to the component setting or `all` (`runner-v2/src/extension-mcp.ts:737`, `runner-v2/src/extension-mcp.ts:753`). Discovery currently constructs tools before the call-time guard (`runner-v2/src/extension-mcp.ts:595`, `runner-v2/src/extension-mcp.ts:614`, `runner-v2/src/extension-mcp.ts:669`).

## Decision

Add a versioned, Runner-owned policy per installed extension, included by digest in new immutable capability generations:

```text
toolFilter: { default: "allow" | "deny", allow: [ToolKey], deny: [ToolKey] }
ToolKey: { componentId: string, toolName: string }
remoteExposure: boolean
riskLabel: "low" | "elevated" | "high" | "unreviewed"
```

Keys are exact, case-sensitive component/tool names under a stable extension ID; validate length, uniqueness and component ownership. Deny wins over allow, which wins over the default. Bind every policy to the reviewed discovery/schema digest and exact observed tool inventory: even `default: allow` applies only within that inventory, never to a newly discovered name. No wildcard or implicit approval for new names. Keep `toolApproval` as a separate existing approval gate: passing a filter never overrides grants, roles, destructive policy, consent or schema validation. Risk labels come from the pinned curated catalog, or `unreviewed` for uncatalogued/changed content; server annotations and model text cannot lower them.

| Source | Local defaults | Remote default |
| --- | --- | --- |
| Curated Windows-MCP, pinned version/digest | `default: deny`; explicitly allow only catalog-reviewed GUI discovery/snapshot/screenshot/input tools. Explicitly deny the catalog's exact PowerShell, Registry, Clipboard, FileSystem and Process tool keys. A GUI tool can still need approval; unlisted/new names stay denied. | `false`; show `high` risk. When enabled, require a visible local indicator, one GUI-session lock and applicable local user approval. |
| Curated Playwright MCP and other GUI plugins | `default: deny`, allow only reviewed exact keys for each pinned package/platform; disclose their actual filesystem/network/GUI risks. | `false`; catalog supplies risk label. |
| Uncatalogued extension | `default: deny` until a local user reviews discovered exact tools. | `false`, `unreviewed`. |
| Migrated existing extension | Preserve the previously observed tool set and existing `toolApproval` locally using an exact-name allowlist, not a broad allow for future names. If a trustworthy prior/current discovery is unavailable, deny until review. | `false`, `unreviewed` until catalog review. |

Catalog entries contain the pinned source/version/integrity, supported OS, exact component/tool keys, risk explanations and defaults. Resolve tool keys from the pinned server's verified discovery; never assume example capability names match an arbitrary Windows-MCP release. Changes to executable identity, version, schema digest or discovered names require renewed inspection; missing/changed/unknown entries fail closed. Installation still follows the existing user authorization and trust policy, and is never triggered just because a model requested it.

Migrate registry schema v1 to v2 with a locked, transactional, restart-safe procedure: validate the v1 document and `mcp-tool-policy.json`, preserve IDs, scope, versions, enablement, credentials and the effective `toolApproval`, create explicit v2 policies and publish a new generation. Stage files with a recovery journal and atomically switch the authoritative registry pointer only after all files are durable; recovery completes or abandons the staged migration. Keep the original registry, policy and generation files as protected rollback data until migration is verified. Do not rewrite v1 immutable generation files or their digests (`runner-v2/src/extension-registry.ts:48`, `runner-v2/src/extension-registry.ts:149`, `runner-v2/src/extension-run-bindings.ts:15`). Existing pinned runs retain their original generation; a live deny/disable/remote-off overlay is checked at discovery and immediately before dispatch, so tightening takes effect for already active sessions. Loosening applies only to a newly authorized generation/session and never widens an existing run's pinned grant. Reject malformed/unknown schema versions and failed migration without partial activation.

Filter at the shared Runner tool-materialization boundary for both stdio and Runner-hosted HTTP MCP paths, before tools enter any local model list. Use extension ID + component ID + exact tool name for collision-free matching; pass the same admitted set to the remote MCP gateway, namespaced with the stable extension ID. A remote listing is the intersection of the locally admitted set, `remoteExposure`, device state, principal scope, Runner grants and role policy; the gateway cannot add tools. Re-check the effective policy, current enabled state, instance/version and grant at `tools/call` before side effects, even when a client cached an old list; a denied or disabled name is indistinguishable from an unavailable tool to the caller. Send list-changed/invalidate cached lists when the effective set changes. Already admitted effects follow the existing cancellation/uncertainty policy rather than being reported as automatically undone.

Provider-hosted components bypass Runner execution (`runner-v2/src/extension-management-contracts.ts:21`); they cannot be remotely exposed through this contract. Do not expose their tools to a local model when a configured filter cannot be enforced at the provider-hosted listing *and* invocation boundary; surface unsupported until that boundary can enforce it. Never present filtering as a sandbox: an allowed third-party tool can itself have broad effects, so retain Runner approval and catalog review.

Extend `components/extensions/ExtensionsSettings.tsx` with per-server discovered-tool allow/deny controls, explanations and risk label, effective local/remote previews, an explicit per-extension remote switch and current/pending generation state. Extend the Runner DTO/control routes and service to persist an authenticated human's exact change, show review for broadened capabilities, and publish generation changes. The dashboard may display the status and request changes, but only the local Runner's authenticated user approval may enable or broaden remote exposure. Current Settings already retrieves and sets the coarse tool policy (`components/extensions/ExtensionsSettings.tsx:513`, `components/extensions/ExtensionsSettings.tsx:590`, `runner-v2/src/extension-control-routes.ts:86`).

Focused future acceptance: migrate v1 with both approval modes, rollback/crash during migration, conflicting allow/deny, unknown new tool/schema, generation pin plus immediate revocation, local lists and cached dispatch, disabled/not-ready extension, remote-off and per-tool deny, two devices/principals, renamed/colliding server names, provider-hosted unsupported behavior, and GUI indicator/lock/consent. Test actual tool lists and side effects, not only policy serialization.

## Consequences

Users can narrow capability without uninstalling an extension; migrating a server without trustworthy discovery may require reapproval. Immediate revocation and immutable pinned generations require an explicit live restriction overlay. Catalog updates and schema changes can interrupt availability until reviewed.

## Alternatives rejected

- Treating `toolApproval: all` as an allowlist would leave every newly advertised tool visible and eligible.
- Filtering only remote listings would leave denied tools available to local models or cached callers.
- Trusting plugin-declared destructive/read-only hints as authorization would let the plugin self-approve.

## Open questions

- Which exact Windows-MCP release and discovered tool keys will the catalog pin after independent review?

## Plan corrections

The plan correctly identifies the missing per-tool and remote-exposure fields, but the existing coarse `toolApproval` field is not the only stored policy: a separate per-extension policy file can override it (`runner-v2/src/extension-mcp.ts:737`, `runner-v2/src/extension-mcp.ts:753`). Migration must preserve the effective override as well as the component field.

## Evidence

Inspected AIBoard `d7ed04d2505869f5d52ac17bfd1dfe92259b112f`.

- `runner-v2/src/extension-management-contracts.ts:6`; `runner-v2/src/extension-management-contracts.ts:57`; `runner-v2/src/extension-management-contracts.ts:78`; `runner-v2/src/extension-management-contracts.ts:117`.
- `runner-v2/src/extension-registry.ts:48`; `runner-v2/src/extension-registry.ts:149`; `runner-v2/src/extension-registry.ts:239`; `runner-v2/src/extension-run-bindings.ts:15`.
- `runner-v2/src/extension-mcp.ts:595`; `runner-v2/src/extension-mcp.ts:614`; `runner-v2/src/extension-mcp.ts:669`; `runner-v2/src/extension-mcp.ts:737`.
- `components/extensions/ExtensionsSettings.tsx:513`; `components/extensions/ExtensionsSettings.tsx:590`; `runner-v2/src/extension-control-routes.ts:86`.
