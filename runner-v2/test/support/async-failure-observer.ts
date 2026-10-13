/** Test-only observer. Disabled scopes do not touch the target methods. */
export function observeAsyncFailures(
  enabled: boolean,
  targets: readonly { target: object; methods: readonly string[]; prefix: string }[],
  record: (operation: string, args: readonly unknown[], error: unknown) => void,
  settled?: (operation: string, args: readonly unknown[], outcome: "fulfilled" | "rejected") => void,
): () => void {
  if (!enabled) return () => undefined;
  const restores: Array<() => void> = [];
  const restore = () => { for (const undo of restores.splice(0).reverse()) undo(); };
  try {
    for (const { target, methods, prefix } of targets) for (const method of methods) {
      const descriptor = Object.getOwnPropertyDescriptor(target, method);
      if (!descriptor || typeof descriptor.value !== "function") throw new Error(`Missing observer method: ${prefix}.${method}`);
      const original = descriptor.value as (...args: unknown[]) => unknown;
      const wrapper = function(this: unknown, ...args: unknown[]) {
        const finished = (outcome: "fulfilled" | "rejected") => {
          try { settled?.(`${prefix}.${method}`, args, outcome); } catch { /* Passive observation only. */ }
        };
        const failed = (error: unknown) => {
          try { record(`${prefix}.${method}`, args, error); } catch { /* Diagnostics cannot replace the outcome. */ }
          finished("rejected");
        };
        let result: unknown;
        try { result = Reflect.apply(original, this, args); }
        catch (error) { failed(error); throw error; }
        // Observe rejection on a separate, handled branch. The caller receives
        // the original promise and exact rejection, without another await.
        if (result instanceof Promise) void Promise.prototype.then.call(result, () => finished("fulfilled"), failed);
        else finished("fulfilled");
        return result;
      };
      Object.defineProperty(target, method, { ...descriptor, value: wrapper });
      restores.push(() => Object.defineProperty(target, method, descriptor));
    }
  } catch (error) { restore(); throw error; }
  return restore;
}
