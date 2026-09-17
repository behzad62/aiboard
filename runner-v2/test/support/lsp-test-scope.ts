import { AsyncLocalStorage } from "node:async_hooks";
import { rm } from "node:fs/promises";
import nodeTest, { type TestContext, type TestOptions } from "node:test";

interface Scope { owners: Array<() => Promise<void>>; roots: Set<string> }
const storage = new AsyncLocalStorage<Scope>();
export function registerLspTestOwner(close: () => Promise<void>): void { storage.getStore()?.owners.push(close); }
export async function disposeLspTestRoot(root: string): Promise<void> {
  const scope = storage.getStore();
  if (!scope) throw new Error("An LSP fixture root cannot be disposed outside its success-aware test scope.");
  scope.roots.add(root);
}
/** Failure-aware test wrapper: body finalizers close resources but request root
 * removal only. The outer owner preserves primary/cleanup errors, then deletes
 * exact requested roots only if the complete test and every owner passed. */
export function ownedLspTest(name: string, options: TestOptions | ((t: TestContext) => unknown), body?: (t: TestContext) => unknown): Promise<void> {
  const callback = typeof options === "function" ? options : body!;
  return nodeTest(name, typeof options === "function" ? {} : options, async (t) => {
    const scope: Scope = { owners: [], roots: new Set() }; let failed = false; let primary: unknown;
    await storage.run(scope, async () => {
      try { await callback(t); } catch (error) { failed = true; primary = error; }
      const failures: unknown[] = [];
      for (const close of [...scope.owners].reverse()) { try { await close(); } catch (error) { failures.push(error); } }
      if (!failed && !failures.length) {
        for (const root of scope.roots) { await rm(root, { recursive: true, force: false, maxRetries: 20, retryDelay: 50 }); t.diagnostic(`certified LSP compatibility root removed: ${root}`); }
      } else { for (const root of scope.roots) t.diagnostic(`LSP failure evidence retained: ${root}`); }
      if (failed || failures.length) t.diagnostic(`LSP original test failure: ${JSON.stringify({ primary: summarizeLspTestError(primary), cleanup: failures.map((error) => summarizeLspTestError(error)) })}`);
      if (failures.length) throw new AggregateError(failed ? [primary, ...failures] : failures, "LSP test-owned cleanup remains unverified; evidence retained.");
      if (failed) throw primary;
    });
  });
}

function summarizeLspTestError(value: unknown, depth = 0): unknown {
  if (depth > 8) return "bounded cause depth";
  if (!(value instanceof Error)) return { type: typeof value, value: String(value).slice(0, 300) };
  return { name: value.name, message: value.message.slice(0, 1000), code: (value as { code?: unknown }).code,
    ...(value instanceof AggregateError ? { errors: value.errors.map((error: unknown) => summarizeLspTestError(error, depth + 1)) } : {}),
    ...(value.cause !== undefined ? { cause: summarizeLspTestError(value.cause, depth + 1) } : {}) };
}
