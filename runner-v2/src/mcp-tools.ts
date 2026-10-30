import { McpSessionManager } from "./mcp-session-manager.js";
import type { McpDiscoveryResult, McpDiscoveryTool, McpRuntimeServerLaunch } from "./runner-internal-execution-context.js";
import type { StreamingSessionEnvelope } from "./streaming-session-store.js";
import { createHash } from "node:crypto";

import type {
  NativeTool,
  ToolExecutionContext,
  ToolContentBlock,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";

import type { McpServerSpec } from "./mcp-configuration.js";
export type { McpServerSpec } from "./mcp-configuration.js";

export interface McpCallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

export interface McpServerStatus {
  name: string;
  command: string;
  status: "stopped" | "starting" | "ready" | "degraded" | "error";
  toolCount: number;
  error?: string;
}

export interface McpTransportWriter {
  write(payload: Uint8Array, timeoutMs: number): Promise<void>;
}

export interface McpRequestOwner {
  readonly context: Readonly<ToolExecutionContext>;
  readonly envelope: StreamingSessionEnvelope;
}
export interface McpTransportOpenRequest {
  readonly owner?: McpRequestOwner;
  readonly expected?: McpDiscoveryResult["servers"][number];
  readonly server: McpServerSpec;
  readonly handshake: (writer: McpTransportWriter) => Promise<string>;
  readonly onOutput: (stream: "stdout" | "stderr", bytes: Uint8Array) => void | Promise<void>;
  readonly onFailure: (error: Error) => void;
}

export interface McpOwnedTransport extends McpTransportWriter {
  request?<T>(owner: McpRequestOwner, perform: (writer: McpTransportWriter) => Promise<T>, timeoutMs: number): Promise<T>;
  closeVerified(): Promise<void>;
}

export interface McpTransportFactory {
  open(request: McpTransportOpenRequest): Promise<McpOwnedTransport>;
}

export interface McpStatusSource {
  status(): McpServerStatus[];
}

export interface LiveMcpStatusRegistry extends McpStatusSource {
  register(runId: string, source: McpStatusSource): Readonly<{ dispose(): void }>;
}

/**
 * Projects configured MCP status from the live per-run managers. When several
 * runs share one configured server, any degraded owner keeps the aggregate degraded; the
 * tool count is the maximum reported by one manager rather than an inflated
 * sum of identical per-run definitions.
 */
export function createLiveMcpStatusRegistry(
  servers: readonly McpServerSpec[],
): LiveMcpStatusRegistry {
  const configured = servers.map((server) => Object.freeze({ ...server }));
  const sources = new Map<string, McpStatusSource>();
  return Object.freeze({
    register(runId: string, source: McpStatusSource) {
      if (!runId.trim() || sources.has(runId) || !source || typeof source.status !== "function") {
        throw new Error("Live MCP status registration is invalid or duplicated.");
      }
      sources.set(runId, source);
      let disposed = false;
      return Object.freeze({
        dispose() {
          if (disposed) return;
          disposed = true;
          if (sources.get(runId) === source) sources.delete(runId);
        },
      });
    },
    status() {
      const snapshots = [...sources.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .flatMap(([, source]) => source.status());
      return configured.map((server) => aggregateMcpStatus(server, snapshots));
    },
  });
}

function aggregateMcpStatus(
  server: McpServerSpec,
  snapshots: readonly McpServerStatus[],
): McpServerStatus {
  const matching = snapshots.filter((status) =>
    status.name === server.name && status.command === server.command);
  if (matching.length === 0) {
    return { ...server, status: "stopped", toolCount: 0 };
  }
  const rank: Record<McpServerStatus["status"], number> = {
    stopped: 0,
    error: 1,
    starting: 2,
    ready: 3,
    degraded: 4,
  };
  const state = [...matching].sort((left, right) =>
    rank[right.status] - rank[left.status])[0]!.status;
  const errors = [...new Set(matching.flatMap((status) => status.error ? [status.error] : []))]
    .sort();
  return {
    ...server,
    status: state,
    toolCount: state === "degraded" ? 0 : Math.max(...matching.map((status) => status.toolCount)),
    ...((state === "error" || state === "degraded") && errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

export interface McpManagerOptions {
  readonly runId?: string;
  readonly discovery?: McpDiscoveryResult;
  readonly reattest?: () => Promise<readonly McpRuntimeServerLaunch[]>;
  readonly maximumRestarts?: number;
  readonly maximumSessions?: number;
  cwd: string;
  servers: readonly McpServerSpec[];
  requestTimeoutMs?: number;
  /** Deterministic lower-bound test seam; production retains the 1 MiB ceiling. */
  maximumLineBytes?: number;
  transportFactory: McpTransportFactory;
}

export class McpManager extends McpSessionManager {}

/**
 * T10 (M12): label server-supplied MCP text as untrusted third-party data
 * and bound it, so a compromised server cannot flood the context or pose
 * as kernel instructions. About 500 characters of description survive.
 */
export const MCP_TOOL_DESCRIPTION_MAX_CHARS = 512;

export function formatMcpToolDescription(serverName: string, description: string | undefined, toolName: string): string {
  const body = description?.trim() || `Call ${toolName} on MCP server ${serverName}`;
  return `[MCP ${serverName}] ${body}`.slice(0, MCP_TOOL_DESCRIPTION_MAX_CHARS);
}

export interface McpMaterializationPolicy {
  /** Applied before a tool enters any model-visible list. */
  readonly admit?: (server: string, tool: McpDiscoveryTool) => boolean;
  readonly name?: (server: string, tool: McpDiscoveryTool) => string;
  readonly guard?: (tool: NativeTool<Record<string, unknown>>, server: string, discovered: McpDiscoveryTool) => NativeTool<Record<string, unknown>>;
}

export function createMcpTools(
  manager: McpManager,
  artifacts: ArtifactStore,
  policy: McpMaterializationPolicy = {},
): NativeTool<Record<string, unknown>>[] {
  const used = new Set<string>();
  return manager.toolEntries().filter(({ client, tool }) => policy.admit?.(client.spec.name, tool) ?? true).map(({ client, tool }) => {
    const name = policy.name?.(client.spec.name, tool) ?? uniqueToolName(client.spec.name, tool.name, used);
    const created: NativeTool<Record<string, unknown>> = {
      definition: {
        name,
        description: formatMcpToolDescription(client.spec.name, tool.description, tool.name),
        inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
        readOnly:
          tool.annotations?.readOnlyHint === true &&
          tool.annotations?.destructiveHint === false,
        effect: "external",
      },
      validate: objectInput,
      assessAccess: (_input, context) => client.access(context),
      execute: async (input, context) => await mcpOutput(
        await client.call(tool.name, input, context),
        artifacts,
        `${client.spec.name}.${tool.name}`
      ),
    };
    return policy.guard?.(created, client.spec.name, tool) ?? created;
  });
}

/**
 * Native tools for a Runner-hosted remote (Streamable HTTP) MCP server. Naming, input validation and
 * untrusted-output labeling match stdio tools; access is always external network use, and a tool is
 * treated as destructive unless the server marks it otherwise.
 */
export function createRemoteMcpTools(
  server: string,
  tools: readonly McpDiscoveryResult["servers"][number]["tools"][number][],
  call: (name: string, args: Record<string, unknown>, context: ToolExecutionContext) => Promise<McpCallResult>,
  artifacts: ArtifactStore,
  policy: McpMaterializationPolicy = {},
): NativeTool<Record<string, unknown>>[] {
  const used = new Set<string>();
  return tools.filter((tool) => policy.admit?.(server, tool) ?? true).map((tool) => {
    const name = policy.name?.(server, tool) ?? uniqueToolName(server, tool.name, used);
    const created: NativeTool<Record<string, unknown>> = {
      definition: {
        name,
        description: formatMcpToolDescription(server, tool.description, tool.name),
        inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
        readOnly: tool.annotations?.readOnlyHint === true && tool.annotations?.destructiveHint === false,
        effect: "external",
      },
      validate: objectInput,
      assessAccess: () => ({ capability: `mcp.${server}.${tool.name}`, external: true, destructive: tool.annotations?.destructiveHint !== false, network: true }),
      execute: async (input, context) => await mcpOutput(await call(tool.name, input, context), artifacts, `${server}.${tool.name}`),
    };
    return policy.guard?.(created, server, tool) ?? created;
  });
}

async function mcpOutput(
  result: McpCallResult,
  artifacts: ArtifactStore,
  label: string
): Promise<ToolExecutionOutput> {
  const content: ToolContentBlock[] = [];
  for (const item of result.content ?? []) {
    if (item.type === "text" && typeof item.text === "string") {
      content.push({ type: "text", text: item.text });
    } else if (
      (item.type === "image" || item.type === "audio") &&
      typeof item.data === "string"
    ) {
      const mediaType = typeof item.mimeType === "string"
        ? item.mimeType
        : item.type === "image" ? "image/png" : "audio/mpeg";
      const artifact = await artifacts.put(
        Buffer.from(item.data, "base64"),
        mediaType,
        `MCP ${label}`
      );
      content.push({ type: "artifact", hash: artifact.hash, mediaType, label });
    } else if (item.type === "resource" && record(item.resource)) {
      if (typeof item.resource.text === "string") {
        const artifact = await artifacts.put(
          Buffer.from(item.resource.text),
          typeof item.resource.mimeType === "string" ? item.resource.mimeType : "text/plain",
          `MCP resource ${label}`
        );
        content.push({ type: "artifact", hash: artifact.hash, mediaType: artifact.mediaType, label });
      } else if (typeof item.resource.blob === "string") {
        const artifact = await artifacts.put(
          Buffer.from(item.resource.blob, "base64"),
          typeof item.resource.mimeType === "string" ? item.resource.mimeType : "application/octet-stream",
          `MCP resource ${label}`
        );
        content.push({ type: "artifact", hash: artifact.hash, mediaType: artifact.mediaType, label });
      }
    }
  }
  if (result.structuredContent !== undefined) {
    content.push({ type: "json", value: result.structuredContent });
  }
  if (content.length === 0) content.push({ type: "json", value: null });
  return {
    content,
    isError: result.isError === true,
    ...(result.isError
      ? { error: { code: "mcp_tool_error", message: `MCP tool ${label} reported an error.` } }
      : {}),
  };
}

function uniqueToolName(server: string, tool: string, used: Set<string>): string {
  const base = `mcp.${server}.${tool}`
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "_")
    .replace(/^[^a-z]+/, "mcp.");
  let candidate = base.slice(0, 64);
  if (used.has(candidate)) {
    const suffix = `.${createHash("sha256").update(`${server}\0${tool}`).digest("hex").slice(0, 8)}`;
    candidate = `${base.slice(0, 64 - suffix.length)}${suffix}`;
  }
  used.add(candidate);
  return candidate;
}

function objectInput(input: unknown): ValidationResult<Record<string, unknown>> {
  return record(input)
    ? { ok: true, value: input }
    : { ok: false, issues: ["MCP arguments must be an object"] };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
