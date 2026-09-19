import { createHash } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { ToolExecutionContext } from "./agent-contracts.js";
import type { PermissionProfile } from "./contracts.js";
import { assertCurrentConsumedExecutionGrantClaims, type ExecutionGrantBinding } from "./execution-grants.js";
import type { ExecutionHostRunBinding } from "./execution-host.js";
import { createChildEnvironmentFactory } from "./child-environment.js";
import { resolveLanguageServerExecutable } from "./language-server-executable.js";
import { ManagedProcessError, type ManagedProcessSnapshot } from "./managed-process-contracts.js";
import type { ManagedProcessIdentity, ManagedProcessRunRuntime, ManagedProcessTarget } from "./managed-process-transport.js";
import type { OperationAuthorizationAssertion, SessionOperationAuthorization } from "./session-authority.js";
import { AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS } from "./cleanup-timeouts.js";
import type { StreamingSessionRecord } from "./streaming-session-store.js";

type Facade = Awaited<ReturnType<ExecutionHostRunBinding["openStreaming"]>>;
type Entry = { abort: AbortController; opening?: Promise<Facade>; openingSettled?: boolean; facade?: Facade;
  terminal?: Readonly<{ exitCode: number | null; signal: NodeJS.Signals | null }>; cleanup?: Promise<void> };
const noExtraAccess = Object.freeze({ requestAccess: Object.freeze([]), credentialNames: Object.freeze([]),
  networkApproved: false, externalApproved: false, destructiveApproved: false });
const sessionId = (id: string) => `managed-stream-${id}`;
const launchId = (id: string) => `managed-launch-${id}`;

/** Family adapter only. ExecutionHost owns launch, attestation, bounded evidence,
 * durable authority, recovery and all physical cleanup. No process handles live here. */
export function createExecutionHostManagedRuntime(options: Readonly<{
  run: ExecutionHostRunBinding; permissionProfile: PermissionProfile;
  environment: Readonly<Record<string, string | undefined>>;
}>): ManagedProcessRunRuntime {
  const { run } = options; const entries = new Map<string, Entry>();
  const environments = createChildEnvironmentFactory({ credentialResolver: { consume() { throw new Error("Managed credential grants are not configured."); } } });
  const recordOf = (target: ManagedProcessIdentity): Readonly<StreamingSessionRecord> | undefined => {
    if (target.runId !== run.runId || !/^[A-Za-z0-9._-]{1,96}$/.test(target.processId)) throw refused("Managed owner identity is invalid.");
    const record = run.streamingState.readSession(sessionId(target.processId));
    if (record && (record.runId !== target.runId || record.agentSessionId !== target.sessionId ||
        record.actor.role !== target.actor.role || record.actor.id !== target.actor.id)) throw refused("Managed session belongs to another exact owner.");
    return record;
  };
  const expected = (target: ManagedProcessIdentity, context: Readonly<ToolExecutionContext>, operation: "observe" | "stop"): OperationAuthorizationAssertion => {
    assertCall(context, target, run.runId, operation === "stop" ? ["process.signal"] : ["process.poll", "process.list"]);
    return { ...noExtraAccess, sessionId: sessionId(target.processId), operation, binding: bindingFor(context, options.permissionProfile) };
  };
  const snapshot = async (target: ManagedProcessTarget, authorization?: SessionOperationAuthorization, assertion?: OperationAuthorizationAssertion, maximum = 65536): Promise<ManagedProcessSnapshot> => {
    const observation = authorization && assertion
      ? await run.streamingRuntime.observeOutput({ authorization, assertion })
      : await run.streamingRuntime.observeOwnedOutput({ sessionId: sessionId(target.processId), owner: target });
    recordOf(target);
    const terminal = entries.get(target.processId)?.terminal;
    return Object.freeze({ processId: target.processId, pid: observation.record.backendBinding.rootPid ?? 0,
      status: observation.record.state === "released" ? "stopped" : observation.record.state === "active" ? "running" : "exited_unknown",
      exitCode: terminal?.exitCode ?? target.exitCode, signal: terminal?.signal ?? target.signal,
      startedAt: target.startedAt, updatedAt: new Date().toISOString(),
      stdout: tail(observation.output.streams.find(s => s.stream === "stdout")?.tail ?? "", maximum),
      stderr: tail(observation.output.streams.find(s => s.stream === "stderr")?.tail ?? "", maximum) });
  };
  const cleanup = async (target: ManagedProcessIdentity, timeoutMs: number): Promise<void> => {
    const entry = entries.get(target.processId);
    if (entry?.opening && !entry.facade && !entry.openingSettled) { entry.abort.abort(); await entry.opening.catch(() => undefined); }
    const record = recordOf(target);
    if (record) await run.streamingRuntime.cleanupOwnedSession({ sessionId: record.sessionId, timeoutMs });
    else if (run.streamingState.readHostLaunch(launchId(target.processId))) await run.streamingRuntime.cleanupOwnedLaunch({ launchId: launchId(target.processId), timeoutMs });
    const final = recordOf(target), launch = run.streamingState.readHostLaunch(launchId(target.processId));
    if (final && final.state !== "released" || !final && launch && launch.state !== "released")
      throw new ManagedProcessError("process_cleanup_unverified", "Exact managed release conjunction is not verified.");
  };
  const runtime: ManagedProcessRunRuntime = {
    runId: run.runId,
    async start(request) {
      assertCall(request.context, request.identity, run.runId, ["process.start"]);
      if (entries.has(request.identity.processId) || recordOf(request.identity)) throw refused("Managed launch identity cannot be replayed.");
      const abort = new AbortController(), entry: Entry = { abort }; entries.set(request.identity.processId, entry);
      const signal = request.context.signal ? AbortSignal.any([abort.signal, request.context.signal]) : abort.signal;
      let expired = false;
      const timer = setTimeout(() => { expired = true; abort.abort(); }, request.startTimeoutMs);
      const startedAt = new Date().toISOString();
      try {
        entry.opening = (async () => {
          const cwd = await realpath(request.cwd);
          const imageExecutable = !isAbsolute(request.command) && /^[A-Za-z0-9._-]+$/.test(request.command) ? request.command : undefined;
          if (options.permissionProfile !== "full" && !imageExecutable) {
            throw new ManagedProcessError("process_launch_failed", "Managed strict isolation cannot represent the host executable inside the configured image; launch is unavailable before process creation.");
          }
          const prepared = environments.prepare({ ambient: options.environment, explicitOverrides: request.environment });
          const executable = options.permissionProfile === "full"
            ? await environments.withChildEnvironment(prepared.capability, environment =>
                resolveLanguageServerExecutable(request.command, { commandSearchDirectory: cwd, environment }))
            : undefined;
          const launchExecutable = executable?.path ?? imageExecutable!;
          const launchIdentity = executable ?? Object.freeze({ imageExecutable });
          if (signal.aborted) throw cancelled();
          const id = request.identity.processId;
          return await run.openStreaming({ sessionId: sessionId(id), launchId: launchId(id),
            grant: request.context.executionGrant!, binding: bindingFor(request.context, options.permissionProfile), signal,
            failedLaunchCleanupTimeoutMs: Math.min(request.cleanupTimeoutMs, AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS), protocolStreams: [],
            explicitEnvironment: request.environment,
            envelope: { access: [{ canonicalPath: cwd, mode: "write" }], credentialNames: [], networkApproved: false, externalApproved: false, destructiveApproved: false },
            ...(imageExecutable ? { imageExecutable } : {}),
            intent: { invocationId: launchId(id), runId: run.runId, sessionId: request.identity.sessionId, kind: "command",
              executable: launchExecutable, arguments: request.args, workingDirectory: cwd, requestedCapabilities: ["tree_termination", "verified_emptiness"] },
            // Arbitrary commands have no application handshake. The shared host
            // has already authenticated launch and channel ownership at this seam.
            verifyHandshake: async () => createHash("sha256").update(JSON.stringify({ id, executable: launchIdentity, args: request.args, cwd })).digest("hex"),
            onTerminal: observation => { entry.terminal = observation; request.onTerminal(observation); },
          });
        })().finally(() => { entry.openingSettled = true; });
        entry.facade = await entry.opening;
        if (signal.aborted) throw expired ? new ManagedProcessError("process_start_timeout", "Managed startup exceeded its bound.") : cancelled();
        const record = recordOf(request.identity)!;
        if (entry.terminal) await cleanup(request.identity, request.cleanupTimeoutMs);
        const initial: ManagedProcessTarget = { ...request.identity, pid: record.backendBinding.rootPid ?? 0,
          status: record.state === "released" ? "stopped" : "running", exitCode: entry.terminal?.exitCode ?? null,
          signal: entry.terminal?.signal ?? null, startedAt, updatedAt: startedAt, stdout: "", stderr: "" };
        return await snapshot(initial, undefined, undefined, request.maxOutputBytes);
      } catch (primary) {
        try { await cleanup(request.identity, request.cleanupTimeoutMs); }
        catch (cleanupError) { throw new AggregateError([primary, cleanupError], "Managed startup retains unverified shared cleanup."); }
        if (expired) throw new ManagedProcessError("process_start_timeout", "Managed startup exceeded its bound.");
        if (signal.aborted) throw cancelled();
        throw primary;
      } finally { clearTimeout(timer); }
    },
    async observe(target, context, maximum = 65536) {
      const durable = recordOf(target);
      if (!context && (!durable || durable.state !== "active" && durable.state !== "released")) {
        return Object.freeze({ ...target, stdout: tail(target.stdout, maximum), stderr: tail(target.stderr, maximum) });
      }
      if (!durable && target.status === "stopped" && target.pid === 0) {
        // A rejected static discovery never acquired a session. This is bounded
        // terminal metadata, not a PID-based native observation or release proof.
        if (context) {
          assertCall(context, target, run.runId, ["process.poll", "process.list"]);
          const claims = run.executionGrants.consume(context.executionGrant!, bindingFor(context, options.permissionProfile));
          assertCurrentConsumedExecutionGrantClaims(claims);
        }
        return Object.freeze({ processId: target.processId, pid: 0, status: "stopped" as const, exitCode: target.exitCode, signal: target.signal,
          startedAt: target.startedAt, updatedAt: target.updatedAt, stdout: tail(target.stdout, maximum), stderr: tail(target.stderr, maximum) });
      }
      if (!context) { recordOf(target); return await snapshot(target, undefined, undefined, maximum); }
      const assertion = expected(target, context, "observe");
      const authorization = run.sessionAuthority.authorizeOperation({ ...assertion, grant: context.executionGrant! });
      const result = await snapshot(target, authorization, assertion, maximum);
      if (context.signal?.aborted) throw cancelled();
      run.sessionAuthority.assertOperationAuthorization(authorization, assertion);
      return result;
    },
    async observeMany(targets, context, maximum) {
      if (targets.length < 1 || targets.length > 128) throw refused("Managed observation batch exceeds its bound.");
      const assertions = targets.map(target => { recordOf(target); return expected(target, context, "observe"); });
      const authorizations = run.sessionAuthority.authorizeObservationBatch({ ...noExtraAccess,
        sessionIds: assertions.map(item => item.sessionId), binding: bindingFor(context, options.permissionProfile), grant: context.executionGrant! });
      const results = await Promise.all(targets.map((target, index) => snapshot(target, authorizations[index], assertions[index], maximum)));
      if (context.signal?.aborted) throw cancelled();
      authorizations.forEach((authorization, index) => run.sessionAuthority.assertOperationAuthorization(authorization, assertions[index]!));
      return Object.freeze(results);
    },
    async stop(target, context, signal = "SIGTERM", timeoutMs = AUTHORIZED_STOP_CLEANUP_TIMEOUT_MS) {
      if (!["SIGTERM", "SIGINT", "SIGKILL"].includes(signal)) throw refused("Unsupported managed stop signal.");
      const record = recordOf(target);
      if (context) {
        const assertion = expected(target, context, "stop");
        if (record?.state === "active") {
          const facade = entries.get(target.processId)?.facade;
          if (!facade) throw new ManagedProcessError("process_cleanup_unverified", "Managed stop lost its exact streaming session facade.");
          const authorization = facade.authorizeOperation({ ...assertion, grant: context.executionGrant! });
          // The shared seam commits intent synchronously. Cancellation afterwards
          // cannot interrupt that already accepted exact-owner cleanup.
          await run.streamingRuntime.stopAuthorizedSession(authorization, assertion);
        } else if (record?.state === "released") {
          const observed = { ...assertion, operation: "observe" as const };
          const authorization = run.sessionAuthority.authorizeOperation({ ...observed, grant: context.executionGrant! });
          return await snapshot(target, authorization, observed);
        } else if (record) {
          const claims = run.executionGrants.consume(context.executionGrant!, bindingFor(context, options.permissionProfile));
          assertCurrentConsumedExecutionGrantClaims(claims);
          await cleanup(target, timeoutMs);
        } else throw new ManagedProcessError("process_cleanup_unverified", "Managed stop requires active exact authority or verified terminal history.");
      } else await cleanup(target, timeoutMs);
      if (!recordOf(target)) return Object.freeze({ ...target, status: "stopped" as const, updatedAt: new Date().toISOString() });
      return await snapshot(target);
    },
  };
  return Object.freeze(runtime);
}
function bindingFor(context: Readonly<ToolExecutionContext>, permissionProfile: PermissionProfile): ExecutionGrantBinding {
  return Object.freeze({ runId: context.runId, sessionId: context.sessionId, actor: Object.freeze({ ...context.actor }),
    callId: context.callId!, toolName: context.toolName!, permissionProfile });
}
function assertCall(context: Readonly<ToolExecutionContext>, target: ManagedProcessIdentity, runId: string, tools: readonly string[]): void {
  if (!context || context.runId !== runId || target.runId !== runId || context.sessionId !== target.sessionId ||
      context.actor.role !== target.actor.role || context.actor.id !== target.actor.id || !context.executionGrant ||
      !context.callId || !context.toolName || !tools.includes(context.toolName) || !context.workspacePath || !isAbsolute(context.workspacePath))
    throw refused("Managed operation requires its original exact ToolBroker owner and grant.");
  if (context.signal?.aborted) throw cancelled();
}
function refused(message: string): ManagedProcessError { return new ManagedProcessError("process_not_owned", message); }
function cancelled(): ManagedProcessError { return new ManagedProcessError("process_cancelled", "Managed operation was cancelled."); }
function tail(value: string, maximum: number): string {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256 * 1024) throw refused("Managed observation byte bound is invalid.");
  const bytes = Buffer.from(value); let offset = Math.max(0, bytes.length - maximum);
  while (offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset++;
  return bytes.subarray(offset).toString("utf8");
}
