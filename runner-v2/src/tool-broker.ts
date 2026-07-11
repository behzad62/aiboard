import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

import type { ArtifactStore } from "./artifact-store.js";
import type {
  NativeTool,
  ToolAccessRequest,
  ToolCallBlock,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionOutput,
  ToolResult,
} from "./agent-contracts.js";
import type { PermissionProfile } from "./contracts.js";
import {
  ToolRegistry,
  type AgentToolRuntime,
} from "./tool-registry.js";
import {
  toolInvocationFingerprint,
  toolInvocationKey,
  type ToolInvocationLedger,
} from "./tool-ledger.js";

export interface ToolApprovalRequest {
  callId: string;
  toolName: string;
  actor: ToolExecutionContext["actor"];
  permissionProfile: PermissionProfile;
  access: ToolAccessRequest;
  outsideWorkspace: boolean;
}

export interface ToolAuditRecord {
  callId: string;
  toolName: string;
  runId: string;
  sessionId: string;
  actor: ToolExecutionContext["actor"];
  startedAt: string;
  finishedAt: string;
  decision: "allowed" | "approved" | "denied" | "rejected";
  capability?: string;
  outsideWorkspace: boolean;
  isError: boolean;
  errorCode?: string;
}

export interface ToolBrokerOptions {
  permissionProfile: PermissionProfile;
  workspacePath: string;
  approve?: (request: ToolApprovalRequest) => Promise<boolean>;
  artifacts?: ArtifactStore;
  maxInlineOutputBytes?: number;
  toolTimeoutMs?: number;
  clock?: () => string;
  ledger?: ToolInvocationLedger;
}

interface InvocationCacheEntry {
  fingerprint: string;
  result: Promise<ToolResult>;
}

interface InvocationDecision {
  decision: ToolAuditRecord["decision"];
  capability?: string;
  outsideWorkspace: boolean;
}

class ToolTimeoutError extends Error {}

export class ToolBroker implements AgentToolRuntime {
  private readonly registry = new ToolRegistry();
  private readonly permissionProfile: PermissionProfile;
  private readonly workspacePath: string;
  private readonly approve?: ToolBrokerOptions["approve"];
  private readonly artifacts?: ArtifactStore;
  private readonly maxInlineOutputBytes: number;
  private readonly toolTimeoutMs: number;
  private readonly clock: () => string;
  private readonly ledger?: ToolInvocationLedger;
  private readonly toolDefinitions = new Map<string, ToolDefinition>();
  private readonly invocationCache = new Map<string, InvocationCacheEntry>();
  private readonly audit: ToolAuditRecord[] = [];
  private readonly decisions = new Map<string, InvocationDecision>();

  constructor(options: ToolBrokerOptions) {
    this.permissionProfile = options.permissionProfile;
    this.workspacePath = resolve(options.workspacePath);
    this.approve = options.approve;
    this.artifacts = options.artifacts;
    this.maxInlineOutputBytes = options.maxInlineOutputBytes ?? 64 * 1024;
    this.toolTimeoutMs = options.toolTimeoutMs ?? 120_000;
    this.clock = options.clock ?? (() => new Date().toISOString());
    this.ledger = options.ledger;
    if (!Number.isSafeInteger(this.maxInlineOutputBytes) || this.maxInlineOutputBytes < 1) {
      throw new Error("maxInlineOutputBytes must be a positive integer.");
    }
    if (!Number.isSafeInteger(this.toolTimeoutMs) || this.toolTimeoutMs < 1) {
      throw new Error("toolTimeoutMs must be a positive integer.");
    }
  }

  register<TInput>(tool: NativeTool<TInput>): void {
    this.toolDefinitions.set(tool.definition.name, tool.definition);
    this.registry.register({
      definition: tool.definition,
      validate: tool.validate,
      execute: async (input, context) =>
        await this.executeAuthorized(tool, input as TInput, context),
    });
  }

  definitions(): ToolDefinition[] {
    return this.registry.definitions();
  }

  isLifecycleTool(name: string): boolean {
    return this.registry.isLifecycleTool(name);
  }

  assertUniqueCallIds(
    calls: readonly ToolCallBlock[],
    seenCallIds: ReadonlySet<string>
  ): void {
    this.registry.assertUniqueCallIds(calls, seenCallIds);
  }

  async invoke(
    call: ToolCallBlock,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const key = toolInvocationKey(context, call.callId);
    const fingerprint = toolInvocationFingerprint(call);
    const existing = this.invocationCache.get(key);
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        return failure(call, "idempotency_conflict", "Call ID was reused with different input.");
      }
      return await existing.result;
    }
    const definition = this.toolDefinitions.get(call.name);
    const ledgerDecision = this.ledger?.begin({
      key,
      fingerprint,
      callId: call.callId,
      toolName: call.name,
      runId: context.runId,
      sessionId: context.sessionId,
      replaySafe: definition?.readOnly === true && definition.effect === "none",
      occurredAt: this.clock(),
    });
    if (ledgerDecision?.state === "completed") {
      const completed = Promise.resolve(ledgerDecision.result);
      this.invocationCache.set(key, { fingerprint, result: completed });
      return ledgerDecision.result;
    }
    if (ledgerDecision?.state === "conflict") {
      return failure(call, "idempotency_conflict", "Call ID was reused with different input.");
    }
    if (ledgerDecision?.state === "in_doubt") {
      return failure(
        call,
        "reconciliation_required",
        "A prior side-effecting tool attempt has no durable completion record."
      );
    }
    const result = this.invokeAudited(call, context).then((value) => {
      this.ledger?.complete(key, fingerprint, value, this.clock());
      return value;
    });
    this.invocationCache.set(key, { fingerprint, result });
    return await result;
  }

  auditRecords(): readonly ToolAuditRecord[] {
    return this.audit.map((record) => Object.freeze({ ...record }));
  }

  private async invokeAudited(
    call: ToolCallBlock,
    context: ToolExecutionContext
  ): Promise<ToolResult> {
    const startedAt = this.clock();
    const result = await this.registry.invoke(call, context);
    const decision = this.decisions.get(call.callId) ?? {
      decision: "rejected" as const,
      outsideWorkspace: false,
    };
    this.decisions.delete(call.callId);
    this.audit.push(
      Object.freeze({
        callId: call.callId,
        toolName: call.name,
        runId: context.runId,
        sessionId: context.sessionId,
        actor: Object.freeze({ ...context.actor }),
        startedAt,
        finishedAt: this.clock(),
        decision: decision.decision,
        ...(decision.capability ? { capability: decision.capability } : {}),
        outsideWorkspace: decision.outsideWorkspace,
        isError: result.isError,
        ...(result.error ? { errorCode: result.error.code } : {}),
      })
    );
    return result;
  }

  private async executeAuthorized<TInput>(
    tool: NativeTool<TInput>,
    input: TInput,
    context: ToolExecutionContext
  ): Promise<ToolExecutionOutput> {
    const toolContext = { ...context, workspacePath: this.workspacePath };
    const callId = context.callId ?? "unknown";
    const access = tool.assessAccess?.(input, toolContext) ?? {
      capability: tool.definition.effect,
    };
    const outsideWorkspace = await this.hasOutsidePath(access);
    const requiresApproval =
      this.permissionProfile !== "full" &&
      (outsideWorkspace ||
        tool.definition.effect === "external" ||
        access.external === true ||
        access.credentialChange === true ||
        (this.permissionProfile === "guarded" && tool.definition.effect !== "none"));

    if (requiresApproval) {
      if (!this.approve) {
        this.decisions.set(callId, {
          decision: "denied",
          capability: access.capability,
          outsideWorkspace,
        });
        return outputFailure(
          "approval_required",
          `Tool ${tool.definition.name} requires user approval.`
        );
      }
      const approved = await this.approve({
        callId,
        toolName: tool.definition.name,
        actor: context.actor,
        permissionProfile: this.permissionProfile,
        access,
        outsideWorkspace,
      });
      if (!approved) {
        this.decisions.set(callId, {
          decision: "denied",
          capability: access.capability,
          outsideWorkspace,
        });
        return outputFailure("permission_denied", "User denied the tool call.");
      }
      this.decisions.set(callId, {
        decision: "approved",
        capability: access.capability,
        outsideWorkspace,
      });
    } else {
      this.decisions.set(callId, {
        decision: "allowed",
        capability: access.capability,
        outsideWorkspace,
      });
    }

    if (context.signal?.aborted) {
      return outputFailure("tool_cancelled", "Tool call was cancelled.");
    }
    const timeoutController = new AbortController();
    const signal = context.signal
      ? AbortSignal.any([context.signal, timeoutController.signal])
      : timeoutController.signal;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const execution = tool.execute(input, { ...toolContext, signal });
      const timeoutResult = new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => {
          timeoutController.abort();
          reject(new ToolTimeoutError());
        }, this.toolTimeoutMs);
      });
      const output = await Promise.race([execution, timeoutResult]);
      return await this.boundOutput(tool.definition.name, output);
    } catch (error) {
      if (error instanceof ToolTimeoutError) {
        return outputFailure(
          "tool_timeout",
          `Tool ${tool.definition.name} exceeded ${this.toolTimeoutMs} ms.`
        );
      }
      if (signal.aborted) {
        return outputFailure("tool_cancelled", "Tool call was cancelled.");
      }
      throw error;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async hasOutsidePath(access: ToolAccessRequest): Promise<boolean> {
    if (!access.paths?.length) return false;
    const workspace = await realpath(this.workspacePath);
    for (const requested of access.paths) {
      const target = isAbsolute(requested.path)
        ? resolve(requested.path)
        : resolve(this.workspacePath, requested.path);
      const canonical = await canonicalTarget(target);
      const traversal = relative(workspace, canonical);
      if (traversal === "" || (!traversal.startsWith("..") && !isAbsolute(traversal))) {
        continue;
      }
      return true;
    }
    return false;
  }

  private async boundOutput(
    toolName: string,
    output: ToolExecutionOutput
  ): Promise<ToolExecutionOutput> {
    const text = output.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (Buffer.byteLength(text) <= this.maxInlineOutputBytes) return output;
    const artifact = this.artifacts
      ? await this.artifacts.put(
          Buffer.from(text),
          "text/plain",
          `${toolName} output`
        )
      : undefined;
    return {
      ...output,
      content: [
        {
          type: "text",
          text: artifact
            ? `Output exceeded ${this.maxInlineOutputBytes} bytes and was stored as an artifact.`
            : text.slice(0, this.maxInlineOutputBytes),
        },
        ...(artifact
          ? [
              {
                type: "artifact" as const,
                hash: artifact.hash,
                mediaType: artifact.mediaType,
                label: artifact.label,
              },
            ]
          : []),
      ],
    };
  }
}

async function canonicalTarget(target: string): Promise<string> {
  let current = target;
  const missing: string[] = [];
  while (true) {
    try {
      await lstat(current);
      return resolve(await realpath(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function outputFailure(code: string, message: string): ToolExecutionOutput {
  return {
    content: [{ type: "text", text: message }],
    isError: true,
    error: { code, message },
  };
}

function failure(call: ToolCallBlock, code: string, message: string): ToolResult {
  return {
    callId: call.callId,
    toolName: call.name,
    ...outputFailure(code, message),
  };
}
