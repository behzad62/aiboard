/** Own a directly spawned, childless test process from creation to native close.
 * Not a process-tree owner: use a real containment/backend owner for descendants.
 * Only the retained ChildProcess handle is signalled; no PID lookup or taskkill.
 */
export function ownFiniteFixtureChild(child: {
  readonly pid?: number;
  readonly exitCode: number | null;
  readonly signalCode: NodeJS.Signals | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  once(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  kill(signal: NodeJS.Signals): boolean;
}, timeoutMs = 5_000) {
  const failures: unknown[] = [];
  let didClose = false;
  let requestedStop = false;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => { resolveClosed = resolve; });
  child.on("error", (error) => { failures.push(error); });
  child.once("close", () => { didClose = true; resolveClosed(); });
  return Object.freeze({
    pid: child.pid,
    async close(): Promise<void> {
      if (closing) return await closing;
      const attempt = (async () => {
        if (!didClose && !requestedStop && child.exitCode === null && child.signalCode === null) {
          requestedStop = true;
          // The product under test may already have stopped this exact child
          // while Node has not yet delivered close. A false kill return does
          // not certify anything; the retained native close event below does.
          try { child.kill("SIGTERM"); }
          catch (error) { failures.push(error); }
        }
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([closed, new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Owned finite fixture native close is unconfirmed; retain evidence.")), timeoutMs);
          })]);
        } finally { clearTimeout(timer); }
        if (failures.length) throw new AggregateError(failures, "Owned finite fixture cleanup remains unverified.");
      })();
      closing = attempt;
      try { await attempt; }
      finally { if (closing === attempt) closing = undefined; }
    },
  });
}
