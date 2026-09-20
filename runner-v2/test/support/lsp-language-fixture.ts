import { resolve } from "node:path";
import { createOwnedLspFixture } from "./lsp-owned-fixture.js";
import { registerLspTestOwner } from "./lsp-test-scope.js";
import { LspLanguageProvider as RuntimeLspLanguageProvider, type LspLanguageProviderOptions } from "../../src/lsp-language-provider.js";
import { LanguageProviderRouter as RuntimeLanguageProviderRouter, type LanguageProviderRouterOptions } from "../../src/language-provider-router.js";
import type { DiagnosticsQuery, PositionQuery, WorkspaceSymbolsQuery, LanguageInvocationContext } from "../../src/language-intelligence.js";
import type { LspTransportFactory } from "../../src/lsp-transport.js";

/** Test-only real-host composition. Compatibility cases retain their original
 * method calls while each call receives a new actual scoped grant. Production
 * APIs have no implicit owner, ambient process path or fabricated model context.
 */
export function createTestLspLanguageProvider(options: LspLanguageProviderOptions): RuntimeLspLanguageProvider {
  const owned = createOwnedLspFixture(options.workspaceRoot, options.workspaceRoot);
  const provider = new RuntimeLspLanguageProvider({ ...options, client: { ...options.client, transportFactory: owned.transportFactory } });
  registerLspTestOwner(() => provider.close());
  const operations = new Set(["workspaceSymbols", "definition", "references", "diagnostics"]);
  return new Proxy(provider, { get(target, key) {
    const value = Reflect.get(target, key, target);
    if (typeof value !== "function") return value;
    if (!operations.has(String(key))) return value.bind(target);
    return (query: unknown, signal?: AbortSignal) => owned.invoke(async (context) => await Reflect.apply(value, target, [query, signal, context]), signal);
  } });
}

/** Configured legacy router cases use real per-root hosts. Built-in/extension
 * cases retain their original two-argument production routing path. */
export class LanguageProviderRouter extends RuntimeLanguageProviderRouter {
  private readonly testOwners: Map<string, ReturnType<typeof createOwnedLspFixture>>;
  private readonly hasConfigured: boolean;
  constructor(options: LanguageProviderRouterOptions) {
    const owners = new Map<string, ReturnType<typeof createOwnedLspFixture>>();
    const transportFactory: LspTransportFactory = { open: async (request) => {
      const owner = owners.get(resolve(request.invocation.workspacePath!));
      if (!owner || owner.runId !== request.invocation.runId) throw new Error("Exact LSP test router host was not established by its query.");
      return await owner.transportFactory.open(request);
    } };
    super({ ...options, ...(options.configuredServers.length ? { lspTransportFactory: transportFactory, environment: options.environment ?? {} } : {}) });
    this.testOwners = owners; this.hasConfigured = options.configuredServers.length > 0;
    registerLspTestOwner(() => this.close());
  }
  private async testInvocation<T>(root: string, signal: AbortSignal | undefined, invocation: LanguageInvocationContext | undefined,
    operation: (context?: LanguageInvocationContext) => Promise<T>): Promise<T> {
    if (!this.hasConfigured || invocation) return await operation(invocation);
    const key = resolve(root); let owner = this.testOwners.get(key);
    if (!owner) {
      owner = createOwnedLspFixture(key, key); this.testOwners.set(key, owner);
      // Registered after the host so reverse finalization closes providers first.
      registerLspTestOwner(() => this.close());
    }
    return await owner.invoke((context) => operation(context), signal);
  }
  override workspaceSymbols(query: WorkspaceSymbolsQuery, signal?: AbortSignal, invocation?: LanguageInvocationContext) {
    return this.testInvocation(query.root, signal, invocation, (context) => super.workspaceSymbols(query, signal, context));
  }
  override definition(query: PositionQuery, signal?: AbortSignal, invocation?: LanguageInvocationContext) {
    return this.testInvocation(query.root, signal, invocation, (context) => super.definition(query, signal, context));
  }
  override references(query: PositionQuery, signal?: AbortSignal, invocation?: LanguageInvocationContext) {
    return this.testInvocation(query.root, signal, invocation, (context) => super.references(query, signal, context));
  }
  override diagnostics(query: DiagnosticsQuery, signal?: AbortSignal, invocation?: LanguageInvocationContext) {
    return this.testInvocation(query.root, signal, invocation, (context) => super.diagnostics(query, signal, context));
  }
}
