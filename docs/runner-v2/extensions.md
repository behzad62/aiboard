# Runner V2 extensions and language servers

Runner V2 can load trusted, local extensions and configured language servers. They add capabilities to a single Runner process; they do not replace the scheduler, worktree isolation, integration, verification, permission checks, budgets, evidence, or user handoff.

## Enable trusted capabilities

Create a JSON file outside the project directory, then start Runner V2 with its absolute path:

```powershell
npm run runner:v2 -- --project C:\work\my-project --state-dir C:\runner-state --capabilities-config C:\runner-config\capabilities.json
```

The configuration is deliberately strict. It must be a regular, non-symbolic JSON file; extension paths must be absolute; unknown fields are rejected; and the Runner never reads this configuration from environment variables. Before it opens its control listener, Runner validates extension manifests and registrations and runs each extension's startup/cleanup preflight atomically. Keep secrets out of this file. Provider credentials continue to use Runner's encrypted provider configuration.

```json
{
  "version": 1,
  "extensions": [
    "C:\\runner-extensions\\my-extension"
  ],
  "languageServers": [
    {
      "id": "python.pyright",
      "displayName": "Pyright",
      "extensions": [".py", ".pyi"],
      "rootMarkers": ["pyproject.toml", "pyrightconfig.json"],
      "priority": 100,
      "languageId": "python",
      "command": "C:\\Tools\\node\\pyright-langserver.cmd",
      "args": ["--stdio"],
      "requestTimeoutMs": 10000,
      "shutdownTimeoutMs": 2000,
      "restartLimit": 1,
      "maxFrameBytes": 4194304,
      "maxPendingRequests": 128,
      "maxDocumentBytes": 1048576
    }
  ]
}
```

`version`, `extensions`, and `languageServers` are required. Each language-server entry requires `id`, `displayName`, `extensions`, `rootMarkers`, `priority`, `languageId`, `command`, and `args`; the timeout, restart, and size limits are optional bounded tuning values. An empty pair of arrays disables optional capabilities while retaining the built-in TypeScript/JavaScript provider (`builtin.typescript`).

On Windows, Runner launches each configured language server inside a Windows Job Object, so closing the provider also terminates its descendant processes. Direct executables and ordinary `.cmd`/`.bat` shims are supported through the Job host's safe argv resolution. Use a direct executable (for example `node.exe` plus the server entry module) when an argument needs command-shell metacharacters. Runner resolves a bare command once using normal platform lookup, records the canonical launcher path and its bytes, and launches that attested path—not a later PATH lookup. It rechecks those bytes immediately before a server starts; a replaced executable or shim fails closed.

Runner stamps each new active Build with a digest of its extension manifests, complete captured module closure, configured language-server descriptors and launcher identities, and built-in language-provider identity. On restart, omitting or changing those capabilities fails an active Build before it can construct a runtime or make model calls; terminal history remains inspectable.

## Extension package contract

Each allowlisted directory contains a `runner-extension.json` manifest and a contained ESM entry module. The manifest declares API version `1`, a stable extension ID, name, version, entry path, and one or more capabilities: `tools`, `context`, or `language_intelligence`.

Extensions are a trusted-local integration boundary, not a sandbox. Runner captures the bounded complete directory before evaluation and permits only explicit contained `.mjs`/`.js` ESM imports plus `node:` built-ins. Relative escapes, package-name imports, `require`, and dynamic imports are rejected. It evaluates a unique Runner-owned execution copy made from those captured bytes, seals and rehashes that copy at lifecycle boundaries, then removes it after normal or failed cleanup. An extension must vendor any code it needs inside its allowlisted directory.

The module exports `createExtension()`, returning an instance with synchronous `capabilities()` plus asynchronous `start(context)` and `close()` methods. `start` receives only the extension ID, an extension-private state directory outside the project, and an abort signal. It never receives scheduler, workspace, integration, permission, budget, evidence, or completion stores.

Ordinary extension tools are registered through the same governed `ToolBroker` as native tools. They therefore receive permission decisions, budget limits, artifact handling, durable tool-ledger events, and an `extensionId` attribution. Extensions cannot register lifecycle/completion tools or any name already owned by Runner V2 or configured MCP tools.

Context contributors return bounded optional text. Runner V2 calls them through the existing `ContextAssembler`; contributor byte limits, timeouts, artifact references, and the prompt's global limits still apply.

## Language routing and cleanup

`code.workspace_symbols`, `code.definition`, `code.references`, and `code.diagnostics` keep their existing names and response shapes. For each query, Runner selects a provider by file extension, then a matching root marker, then configured priority. Extension language providers and configured stdio LSP servers participate in the same routing table.

The run's observability snapshot records loaded extension manifests, configured provider metadata, bounded language-route audit records, and extension tool calls with their `extensionId`. Runner owns configured LSP process trees. During run cleanup it stops owned language providers before closing extension instances, in reverse startup order; an extension/provider startup failure also closes everything that began successfully.

Use Node.js 24.x when operating Runner V2. Runner enforces that certified release line at startup without asking operators to pin a particular patch release.
