import { randomUUID } from "node:crypto";
import {
  freezeExecutionLifecycleRequirements,
  resolveRequiredLifecycleScope,
} from "./execution-lifecycle-policy.js";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExecutionHostRunBinding } from "./execution-host.js";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";
import type { PermissionProfile } from "./contracts.js";
import type { ExecutionGrantBinding } from "./execution-grants.js";
import type { StreamingHandshakeControl } from "./streaming-process-session-runtime.js";
import type { LanguageInvocationContext } from "./language-intelligence.js";
import { assertLanguageServerExecutableIdentity, resolveLanguageServerExecutable } from "./language-server-executable.js";
import { LspClientError } from "./lsp-client.js";
import type { LspOwnedTransport, LspProtocolWriter, LspTransportFactory, LspTransportOpenRequest } from "./lsp-transport.js";

const CLEANUP_MS = AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS;
// Shared interactive channels bound one concrete input effect to 1 MiB. LSP
// framing is a byte stream, so a larger logical JSON-RPC frame is serialized as
// bounded writes while retaining one deadline for the whole protocol write.
const MAX_SHARED_LSP_WRITE_BYTES = 1024 * 1024;
const noAdditionalAccess = Object.freeze({ access: Object.freeze([]), credentialNames: Object.freeze([]), networkApproved: false, externalApproved: false, destructiveApproved: false });

/** Host-owned LSP adapter. It consumes the original code/filesystem ToolBroker
 * authority through SessionAuthority; it never issues a replacement grant.
 * Current configured LSP commands describe host executables only. Strict modes
 * therefore refuse them before create until an explicit image identity exists.
 * Full mode retains its existing unconfined disclosure, not invented confinement.
 */
export function createExecutionHostLspTransportFactory(options: Readonly<{
  run: ExecutionHostRunBinding;
  permissionProfile: PermissionProfile;
  environment: Readonly<Record<string, string | undefined>>;
}>): LspTransportFactory {
  const environment = Object.freeze({ ...options.environment });
  return Object.freeze({
    async open(request: LspTransportOpenRequest): Promise<LspOwnedTransport> {
      const owner = request.invocation;
      assertInvocation(owner, options.run.runId);
      if (options.permissionProfile !== "full") throw new LspClientError("invalid_configuration",
        "Configured LSP host executable has no separately attested image identity; strict isolation is unavailable before process creation.");
      const workspace = await realpath(request.workspaceRoot);
      const invocationRoot = await realpath(owner.workspacePath!);
      if (!inside(invocationRoot, workspace)) throw new LspClientError("path_outside_workspace", "LSP process root escapes its actual calling workspace.");
      const identity = request.attestedCommand ?? await resolveLanguageServerExecutable(request.command, { commandSearchDirectory: workspace, environment });
      if (resolve(request.command) !== resolve(identity.path) && request.attestedCommand)
        throw new LspClientError("invalid_configuration", "LSP command differs from its pinned byte identity.");
      await assertLanguageServerExecutableIdentity(identity);
      assertInvocation(owner, options.run.runId);
      const id = randomUUID(); const sessionId = `lsp-stream-${id}`; const launchId = `lsp-launch-${id}`;
      const binding = bindingFor(owner, options.permissionProfile);
      let initializationFailure: LspClientError | undefined;
      let facade: Awaited<ReturnType<ExecutionHostRunBinding["openStreaming"]>>;
      try {
        // Failed handshakes must start their retained output settlement with
        // the same bounded lifecycle allowance used by explicit LSP close.
        // Retrying an already-expired one-second output effect cannot extend
        // its fence/deadline or manufacture a terminal cleanup proof.
        facade = await options.run.openStreaming({ sessionId, launchId, grant: owner.executionGrant!, binding, failedLaunchCleanupTimeoutMs: CLEANUP_MS,
          envelope: noAdditionalAccess, ...(owner.signal ? { signal: owner.signal } : {}), protocolStreams: ["stdout"],
          ...(request.explicitEnvironment ? { explicitEnvironment: request.explicitEnvironment } : {}),
          intent: { invocationId: launchId, runId: owner.runId, sessionId: owner.sessionId, kind: "language_server",
            executable: identity.path, arguments: Object.freeze([...request.arguments]), workingDirectory: workspace,
            requiredLifecycleScope: resolveRequiredLifecycleScope({
              permissionProfile: options.permissionProfile,
              lifecycleRequirements: freezeExecutionLifecycleRequirements(request.lifecycleRequirements),
            }), requestedCapabilities: [] },
          verifyHandshake: (io) => pump(io, async (writer) => {
            try { return await request.initialize(writer); }
            catch (error) { if (error instanceof LspClientError) initializationFailure = error; throw error; }
          }, request.onOutput, owner.signal),
        });
      } catch (cause) {
        const primary = initializationFailure ?? cause;
        // A failed handshake may leave an owned pre-adoption cleanup record.
        // Join that exact coordinator instead of losing the capability or
        // pretending that a later whole-run close certifies this launch.
        if (options.run.streamingState.readHostLaunch(launchId)) {
          try { await options.run.streamingRuntime.cleanupOwnedLaunch({ launchId, timeoutMs: CLEANUP_MS }); }
          catch (cleanup) { throw new LspClientError(primary instanceof LspClientError ? primary.code : "spawn_failed", "LSP failed startup retains unverified owned cleanup.", false, { cause: new AggregateError([primary, cleanup]) }); }
        }
        if (primary instanceof LspClientError) throw primary;
        throw new LspClientError(owner.signal?.aborted ? "request_cancelled" : "spawn_failed", "LSP shared launch or handshake failed.", false, { cause });
      }
      let first = true; let closing = false; let closed = false;
      let current: Promise<unknown> | undefined; let currentAbort: AbortController | undefined;
      let idleAbort: AbortController | undefined; let idleWait: Promise<void> | undefined;
      let closePromise: Promise<void> | undefined;
      const usedCalls = new Set<string>();
      const observeIdle = () => {
        if (closing || closed) return;
        const abort = new AbortController(); idleAbort = abort;
        idleWait = facade.waitForOutput(abort.signal).then((available) => {
          // Observing readiness grants no family delivery. The bounded retained
          // output waits for the next authorized invocation or owned cleanup.
          if (!available && !abort.signal.aborted && !closing) request.onFailure(new LspClientError("process_exited", "Language server terminated between authorized invocations.", true));
        }).catch((cause: unknown) => { if (!abort.signal.aborted && !closing) request.onFailure(new LspClientError("process_error", "Language server output ownership is unavailable.", true, { cause })); });
      };
      return Object.freeze({
        async withInvocation<T>(invocation: LanguageInvocationContext, operation: (writer: LspProtocolWriter) => Promise<T>, timeoutMs: number): Promise<T> {
          assertInvocation(invocation, options.run.runId);
          if (closing || closed || !sameOwner(owner, invocation)) throw new LspClientError("invalid_configuration", "LSP invocation has a different owner or closed session authority.");
          if (current) throw new LspClientError("too_many_pending_requests", "LSP session already has an authorized invocation in progress.");
          const key = JSON.stringify([invocation.toolName, invocation.callId]);
          if (usedCalls.has(key) || usedCalls.size >= 16384) throw new LspClientError("invalid_configuration", "LSP invocation authority cannot be replayed or exceed its bounded call ledger.");
          usedCalls.add(key);
          const abort = new AbortController(); currentAbort = abort;
          const signal = invocation.signal ? AbortSignal.any([abort.signal, invocation.signal]) : abort.signal;
          let callbackFailed = false; let callbackFailure: unknown;
          const observedOperation = async (writer: LspProtocolWriter): Promise<T> => {
            try { return await operation(writer); }
            catch (error) { callbackFailed = true; callbackFailure = error; throw error; }
          };
          const active = (async () => {
            idleAbort?.abort(); await idleWait;
            await assertLanguageServerExecutableIdentity(identity);
            if (closing || signal.aborted) throw new LspClientError("request_cancelled", "LSP invocation was cancelled before protocol effects.");
            const actual = bindingFor(invocation, options.permissionProfile);
            const expected = { sessionId, operation: "language_request" as const, requestAccess: noAdditionalAccess.access,
              credentialNames: noAdditionalAccess.credentialNames, networkApproved: false, externalApproved: false, destructiveApproved: false };
            let authorization;
            if (first) {
              if (invocation.executionGrant !== owner.executionGrant || actual.callId !== binding.callId || actual.toolName !== binding.toolName)
                throw new LspClientError("invalid_configuration", "First LSP operation must use its original launching call authority.");
              authorization = facade.authorizeFirstOperation(expected); first = false;
            } else authorization = facade.authorizeOperation({ ...expected, binding: actual, grant: invocation.executionGrant! });
            return await facade.languageRequest(authorization, { ...expected, binding: actual },
              (io) => pump(io, observedOperation, request.onOutput, signal), timeoutMs, signal);
          })();
          current = active;
          try { return await active; }
          catch (cause) {
            // A provider's validation failure is not a process-disappearance
            // error. Preserve it only when the shared operation returned that
            // exact cause, rather than an additional authority/effect failure.
            if (callbackFailed && cause === callbackFailure) throw cause;
            if (cause instanceof LspClientError) throw cause;
            throw new LspClientError(signal.aborted ? "request_cancelled" : "process_error", "Language server request authority or transport became unavailable; its result is unknown and is not replayed.", true, { cause });
          } finally { if (current === active) current = undefined; if (currentAbort === abort) currentAbort = undefined; observeIdle(); }
        },
        async closeVerified(shutdown?: (writer: LspProtocolWriter) => Promise<void>, shutdownMs = 2000): Promise<void> {
          if (closed) return;
          if (closePromise) return await closePromise;
          closing = true; idleAbort?.abort(); currentAbort?.abort();
          const attempt = (async () => {
            await idleWait;
            if (current) await Promise.allSettled([current]);
            await options.run.streamingRuntime.cleanupOwnedSession({ sessionId, timeoutMs: CLEANUP_MS,
              ...(shutdown ? { gracefulShutdownMs: Math.min(shutdownMs, CLEANUP_MS), gracefulProtocol: (io) =>
                pump(io, (writer) => shutdown({ write: async (bytes, timeout) => { assertShutdownFrame(bytes); await writer.write(bytes, timeout); } }), request.onOutput, io.signal) } : {}),
            });
            if (options.run.streamingState.readSession(sessionId)?.state !== "released")
              throw new LspClientError("process_error", "LSP shared session has not certified its full cleanup conjunction.");
            closed = true;
          })();
          closePromise = attempt;
          try { await attempt; } finally { if (closePromise === attempt) closePromise = undefined; }
        },
      });
    },
  });
}

export async function cleanupRecoveredLspTransports(run: ExecutionHostRunBinding): Promise<void> {
  const failures: unknown[] = [];
  for (const sessionId of run.streamingState.listSessionIds()) {
    const record = run.streamingState.readSession(sessionId);
    if (!sessionId.startsWith("lsp-stream-") || !record || record.runId !== run.runId || record.state === "released") continue;
    try { await run.streamingRuntime.cleanupOwnedSession({ sessionId, timeoutMs: CLEANUP_MS }); }
    catch (error) { failures.push(error); }
    if (run.streamingState.readSession(sessionId)?.state !== "released") failures.push(new Error("Recovered exact LSP session remains unreleased; no autonomous replacement is allowed."));
  }
  if (failures.length) throw new AggregateError(failures, "LSP recovery cleanup remains unverified.");
}

async function pump<T>(io: StreamingHandshakeControl, perform: (writer: LspProtocolWriter) => Promise<T>, output: LspTransportOpenRequest["onOutput"], signal?: AbortSignal): Promise<T> {
  const finished = new AbortController();
  let writeTail: Promise<void> = Promise.resolve();
  const writer: LspProtocolWriter = { write(bytes, timeout) {
    const payload = new Uint8Array(bytes);
    const deadlineAt = Date.now() + timeout;
    // Serialize the complete logical frame, not only each concrete chunk: a
    // server-control reply must never land between a header and its suffix.
    // A rejected prefix poisons this private queue so no later frame is issued.
    const writing = writeTail.then(async () => {
      if (payload.byteLength === 0) { await io.write(payload, timeout); return; }
      for (let offset = 0; offset < payload.byteLength; offset += MAX_SHARED_LSP_WRITE_BYTES) {
        if (signal?.aborted) throw new LspClientError("request_cancelled", "LSP protocol scope was cancelled.");
        const remainingMs = deadlineAt - Date.now();
        if (remainingMs < 1) throw new LspClientError("write_failed", "LSP protocol write exceeded its bounded timeout.");
        await io.write(payload.subarray(offset, Math.min(payload.byteLength, offset + MAX_SHARED_LSP_WRITE_BYTES)), remainingMs);
      }
    });
    writeTail = writing;
    void writing.catch(() => undefined);
    return writing;
  } };
  const operation = Promise.resolve().then(() => perform(writer));
  void operation.finally(() => finished.abort()).catch(() => undefined);
  for (;;) {
    if (signal?.aborted) throw new LspClientError("request_cancelled", "LSP protocol scope was cancelled.");
    const availableSignal = signal ? AbortSignal.any([finished.signal, signal]) : finished.signal;
    const result = await Promise.race([operation.then((value) => ({ kind: "result" as const, value })),
      io.waitForOutput(availableSignal).then((available) => ({ kind: "output" as const, available }))]);
    if (result.kind === "result") return result.value;
    if (!result.available) {
      if (finished.signal.aborted) return await operation;
      throw new LspClientError("process_exited", "LSP output became unavailable before its protocol operation settled.", true);
    }
    await io.deliverOutput(async (stream, bytes) => output(stream, new Uint8Array(bytes)));
  }
}
function assertInvocation(context: LanguageInvocationContext, runId: string): void {
  if (!context || context.runId !== runId || !context.sessionId || !context.actor?.id || !context.callId || !context.toolName ||
      !context.workspacePath || !isAbsolute(context.workspacePath) || !context.executionGrant)
    throw new LspClientError("invalid_configuration", "LSP requires exact original ToolBroker authority and an absolute calling workspace.");
  if (context.signal?.aborted) throw new LspClientError("request_cancelled", "LSP invocation was cancelled before launch.");
}
function bindingFor(context: LanguageInvocationContext, permissionProfile: PermissionProfile): ExecutionGrantBinding {
  return Object.freeze({ runId: context.runId, sessionId: context.sessionId, actor: Object.freeze({ ...context.actor }), callId: context.callId!, toolName: context.toolName!, permissionProfile });
}
function sameOwner(a: LanguageInvocationContext, b: LanguageInvocationContext): boolean {
  return a.runId === b.runId && a.sessionId === b.sessionId && a.actor.role === b.actor.role && a.actor.id === b.actor.id && resolve(a.workspacePath!) === resolve(b.workspacePath!);
}
function inside(root: string, value: string): boolean { const path = relative(root, value); return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path)); }
function assertShutdownFrame(bytes: Uint8Array): void {
  const frame = Buffer.from(bytes); const boundary = frame.indexOf("\r\n\r\n");
  if (boundary < 0 || boundary > 8192 || frame.length > 4 * 1024 * 1024 + 8192) throw new LspClientError("protocol_error", "LSP cleanup frame is malformed or exceeds its bound.");
  const value = JSON.parse(frame.subarray(boundary + 4).toString("utf8")) as { method?: unknown; id?: unknown };
  if (value.method !== "shutdown" && value.method !== "exit" && value.method !== "$/cancelRequest")
    throw new LspClientError("invalid_configuration", "LSP cleanup authority permits shutdown/exit/cancellation only, never application requests.");
}
