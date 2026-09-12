import type { OperationAuthorizationAssertion, SessionOperationAuthorization } from "./session-authority.js";

export interface StreamingRequestChannel {
  /** Exactly one application request frame per original ToolBroker call. */
  write(payload: Uint8Array, timeoutMs: number): Promise<void>;
  waitForOutput(signal?: AbortSignal): Promise<boolean>;
  deliverOutput(deliver: (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>): Promise<boolean>;
}

/** A compound request/response is one SessionAuthority operation. Its private
 * channel cannot be reused after completion, cannot write a second request and
 * rechecks the SAME authorization immediately before every concrete effect.
 * A timeout does not claim that an already-started provider write was undone;
 * the owning family must close uncertain protocol ownership through the host.
 */
export function createStreamingRequestOperation(input: Readonly<{
  sessionId: string;
  retainOwnership?(timeoutMs: number): void;
  assert(authorization: SessionOperationAuthorization, expected: OperationAuthorizationAssertion): void;
  write(payload: Uint8Array, timeoutMs: number, assertCurrent: () => void): Promise<void>;
  waitForOutput(signal: AbortSignal): Promise<boolean>;
  deliver(authorization: SessionOperationAuthorization, expected: OperationAuthorizationAssertion,
    deliver: (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>, assertCurrent: () => void): Promise<boolean>;
}>) {
  const used = new WeakSet<object>();
  let active = false;
  return async function request<T>(
    authorization: SessionOperationAuthorization,
    assertion: OperationAuthorizationAssertion,
    perform: (channel: StreamingRequestChannel) => Promise<T>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000) throw new Error("Session request timeout is invalid.");
    if (signal?.aborted) throw new Error("Session request was cancelled.");
    const expected = Object.freeze({ ...assertion, sessionId: input.sessionId, operation: "request" as const,
      binding: Object.freeze({ ...assertion.binding, actor: Object.freeze({ ...assertion.binding.actor }) }),
      requestAccess: Object.freeze(assertion.requestAccess.map((entry) => Object.freeze({ ...entry }))),
      credentialNames: Object.freeze([...assertion.credentialNames]) });
    input.assert(authorization, expected);
    if (active) throw new Error("A session request is already in progress.");
    if (used.has(authorization)) throw new Error("Session request authorization was already used.");
    // Renew only after a current authorization has been verified, before its
    // asynchronous effect starts. This is host ownership, not grant lifetime.
    input.retainOwnership?.(timeoutMs);
    used.add(authorization); active = true;
    const abort = new AbortController();
    const combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal;
    let open = true; let written = false;
    const pending = new Set<Promise<unknown>>();
    const assertCurrent = () => {
      if (!open) throw new Error("Session request channel is closed.");
      if (combined.aborted) throw new Error("Session request was cancelled or timed out.");
      input.assert(authorization, expected);
    };
    const observe = <R>(promise: Promise<R>): Promise<R> => {
      pending.add(promise);
      void promise.then(() => pending.delete(promise), () => undefined);
      // An unawaited rejection still belongs to this request's pending set.
      void promise.catch(() => undefined);
      return promise;
    };
    const io: StreamingRequestChannel = Object.freeze({
      async write(payload: Uint8Array, writeTimeoutMs: number) {
        assertCurrent();
        if (written) throw new Error("A session request permits only one request write.");
        written = true;
        await observe(input.write(new Uint8Array(payload), Math.min(timeoutMs, writeTimeoutMs), assertCurrent));
        assertCurrent();
      },
      async waitForOutput(waitSignal?: AbortSignal) {
        assertCurrent();
        const available = await input.waitForOutput(waitSignal ? AbortSignal.any([combined, waitSignal]) : combined);
        assertCurrent();
        return available;
      },
      async deliverOutput(deliver: (stream: "stdout" | "stderr", bytes: Uint8Array) => Promise<void>) {
        assertCurrent();
        return await observe(input.deliver(authorization, expected, deliver, assertCurrent));
      },
    });
    let timer: NodeJS.Timeout | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new Error("Session request was cancelled or timed out."));
      combined.addEventListener("abort", fail, { once: true });
      timer = setTimeout(() => abort.abort(), timeoutMs);
    });
    const execution = Promise.resolve().then(async () => {
      let failed = false; let primary: unknown; let result: T | undefined;
      try { assertCurrent(); result = await perform(io); }
      catch (error) { failed = true; primary = error; }
      // A caller deadline does not end an already-started write/delivery. Keep
      // exclusive ownership until every accepted effect actually settles.
      const settled = await Promise.allSettled([...pending]);
      const failures = settled.flatMap((entry) => entry.status === "rejected" ? [entry.reason as unknown] : []);
      const additional = failures.filter((failure) => !(failed && primary instanceof Error && failure === primary));
      if (additional.length) throw new AggregateError(failed ? [primary, ...additional] : additional, "Session request effects did not settle successfully.");
      if (failed) throw primary;
      assertCurrent(); return result!;
    }).finally(() => { active = false; });
    void execution.catch(() => undefined);
    try { return await Promise.race([execution, cancelled]); }
    finally { open = false; if (timer) clearTimeout(timer); abort.abort(); }
  };
}
