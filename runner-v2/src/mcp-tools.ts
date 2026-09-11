import { createHash } from "node:crypto";

import type {
  NativeTool,
  ToolContentBlock,
  ToolExecutionOutput,
  ValidationResult,
} from "./agent-contracts.js";
import type { ArtifactStore } from "./artifact-store.js";

export interface McpServerSpec {
  name: string;
  command: string;
}

interface McpToolDescription {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
}

interface McpCallResult {
  content?: Array<Record<string, unknown>>;
  structuredContent?: unknown;
  isError?: boolean;
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

export interface McpServerStatus {
  name: string;
  command: string;
  status: "stopped" | "starting" | "ready" | "error";
  toolCount: number;
  error?: string;
}

const MAX_MCP_LINE_BYTES = 1024 * 1024;

export interface McpTransportWriter {
  write(payload: Uint8Array, timeoutMs: number): Promise<void>;
}

export interface McpTransportOpenRequest {
  readonly server: McpServerSpec;
  readonly handshake: (writer: McpTransportWriter) => Promise<string>;
  readonly onOutput: (stream: "stdout" | "stderr", bytes: Uint8Array) => void | Promise<void>;
  readonly onFailure: (error: Error) => void;
}

export interface McpOwnedTransport extends McpTransportWriter {
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
 * runs share one configured server, ready wins, then starting, then error; the
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
  };
  const state = [...matching].sort((left, right) =>
    rank[right.status] - rank[left.status])[0]!.status;
  const errors = [...new Set(matching.flatMap((status) => status.error ? [status.error] : []))]
    .sort();
  return {
    ...server,
    status: state,
    toolCount: Math.max(...matching.map((status) => status.toolCount)),
    ...(state === "error" && errors.length > 0 ? { error: errors.join("; ") } : {}),
  };
}

class McpStdioClient {
  private transport: McpOwnedTransport | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private tools: McpToolDescription[] = [];
  private state: McpServerStatus["status"] = "stopped";
  private error: string | undefined;
  private outputBuffer = Buffer.alloc(0);
  private closePromise: Promise<void> | undefined;
  private failureCleanupPromise: Promise<void> | undefined;
  private closeComplete = false;

  constructor(
    readonly spec: McpServerSpec,
    private readonly requestTimeoutMs: number,
    private readonly transportFactory: McpTransportFactory,
    private readonly maximumLineBytes: number,
  ) {}

  async start(): Promise<void> {
    if (this.transport) return;
    if (this.closeComplete) throw new Error(`MCP server ${this.spec.name} is closed.`);
    this.state = "starting";
    this.error = undefined;
    let openingFailure: Error | undefined;
    try {
      const transport = await this.transportFactory.open({
        server: this.spec,
        onOutput: (stream, bytes) => {
          if (stream === "stdout") this.receiveBytes(bytes);
        },
        onFailure: (error) => {
          openingFailure ??= error;
          this.transportFailed(error);
        },
        handshake: async (writer) => {
          const initialized = await this.requestWith(writer, "initialize", {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "aiboard-runner-v2", version: "2" },
          });
          await this.notifyWith(writer, "notifications/initialized", {});
          const listed = await this.requestWith(writer, "tools/list", {}) as { tools?: unknown };
          this.tools = Array.isArray(listed?.tools)
            ? listed.tools.filter(isMcpTool)
            : [];
          return createHash("sha256").update(JSON.stringify({ initialized, listed })).digest("hex");
        },
      });
      this.transport = transport;
      if (openingFailure) {
        this.transportFailed(openingFailure);
        throw openingFailure;
      }
      this.state = "ready";
    } catch (error) {
      this.state = "error";
      const failure = error instanceof Error ? error : new Error(String(error));
      this.recordFailure(failure);
      this.rejectPending(failure);
      throw error;
    }
  }

  definitions(): McpToolDescription[] {
    return this.tools.map((tool) => ({ ...tool, inputSchema: tool.inputSchema ? { ...tool.inputSchema } : undefined }));
  }

  async call(name: string, arguments_: Record<string, unknown>): Promise<McpCallResult> {
    if (this.state !== "ready") throw new Error(`MCP server ${this.spec.name} is not ready.`);
    return await this.request("tools/call", { name, arguments: arguments_ }) as McpCallResult;
  }

  status(): McpServerStatus {
    return {
      name: this.spec.name,
      command: this.spec.command,
      status: this.state,
      toolCount: this.tools.length,
      ...(this.error ? { error: this.error } : {}),
    };
  }

  async close(): Promise<void> {
    if (this.closeComplete) return;
    if (this.closePromise) return await this.closePromise;
    const transport = this.transport;
    this.rejectPending(new Error("MCP server stopped."));
    const attempt = (async () => {
      if (transport) await transport.closeVerified();
      if (this.transport === transport) this.transport = undefined;
      this.state = "stopped";
      this.tools = [];
      this.error = undefined;
      this.closeComplete = true;
    })();
    this.closePromise = attempt;
    try {
      await attempt;
    } catch (error) {
      this.state = "error";
      this.recordCleanupFailure(error);
      throw error;
    } finally {
      if (this.closePromise === attempt) this.closePromise = undefined;
    }
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const transport = this.transport;
    if (!transport) return Promise.reject(new Error(`MCP server ${this.spec.name} is not running.`));
    return this.requestWith(transport, method, params);
  }

  private requestWith(
    writer: McpTransportWriter,
    method: string,
    params: unknown,
  ): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      const payload = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      void writer.write(payload, Math.min(this.requestTimeoutMs, 30_000)).catch((error) => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id);
        clearTimeout(pending.timeout);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async notifyWith(
    writer: McpTransportWriter,
    method: string,
    params: unknown,
  ): Promise<void> {
    const payload = Buffer.from(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    await writer.write(payload, Math.min(this.requestTimeoutMs, 30_000));
  }

  private receiveBytes(bytes: Uint8Array): void {
    let offset = 0;
    for (let index = 0; index < bytes.byteLength; index += 1) {
      if (bytes[index] !== 0x0a) continue;
      if (!this.appendOutput(bytes.subarray(offset, index))) return;
      const line = this.outputBuffer.at(-1) === 0x0d
        ? this.outputBuffer.subarray(0, -1)
        : this.outputBuffer;
      this.outputBuffer = Buffer.alloc(0);
      this.receiveLine(line.toString("utf8"));
      offset = index + 1;
    }
    this.appendOutput(bytes.subarray(offset));
  }

  private appendOutput(bytes: Uint8Array): boolean {
    if (this.outputBuffer.byteLength + bytes.byteLength > this.maximumLineBytes) {
      this.transportFailed(new Error("MCP response exceeded its line bound."));
      return false;
    }
    if (bytes.byteLength > 0) {
      this.outputBuffer = Buffer.concat([this.outputBuffer, Buffer.from(bytes)]);
    }
    return true;
  }

  private receiveLine(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    if (typeof message.id !== "number") return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timeout);
    if (record(message.error)) {
      pending.reject(new Error(
        typeof message.error.message === "string"
          ? message.error.message
          : "MCP request failed."
      ));
    } else {
      pending.resolve(message.result);
    }
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private transportFailed(error: Error): void {
    if (this.state === "stopped") return;
    this.state = "error";
    this.recordFailure(error);
    this.tools = [];
    this.outputBuffer = Buffer.alloc(0);
    this.rejectPending(error);
    const transport = this.transport;
    if (transport) this.scheduleFailureCleanup(transport);
  }

  private scheduleFailureCleanup(transport: McpOwnedTransport): void {
    if (this.closeComplete || this.failureCleanupPromise) return;
    const attempt = (async () => {
      try {
        await transport.closeVerified();
        if (this.transport === transport) this.transport = undefined;
      } catch (error) {
        this.recordCleanupFailure(error);
      }
    })();
    this.failureCleanupPromise = attempt;
    void attempt.finally(() => {
      if (this.failureCleanupPromise === attempt) this.failureCleanupPromise = undefined;
    });
  }

  private recordFailure(error: Error): void {
    if (!this.error) this.error = error.message;
  }

  private recordCleanupFailure(error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    const diagnostic = `MCP cleanup verification failed: ${message}`;
    if (!this.error) this.error = diagnostic;
    else if (!this.error.includes(diagnostic)) this.error = `${this.error}; ${diagnostic}`;
  }
}

export interface McpManagerOptions {
  cwd: string;
  servers: readonly McpServerSpec[];
  requestTimeoutMs?: number;
  /** Deterministic lower-bound test seam; production retains the 1 MiB ceiling. */
  maximumLineBytes?: number;
  transportFactory: McpTransportFactory;
}

export class McpManager {
  private readonly clients: McpStdioClient[];

  constructor(options: McpManagerOptions) {
    const names = new Set<string>();
    for (const server of options.servers) {
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(server.name)) {
        throw new Error(`MCP server name ${server.name} is invalid.`);
      }
      if (!server.command.trim()) throw new Error(`MCP server ${server.name} has no command.`);
      if (names.has(server.name)) throw new Error(`Duplicate MCP server ${server.name}.`);
      names.add(server.name);
    }
    this.clients = options.servers.map((server) =>
      new McpStdioClient(
        server,
        options.requestTimeoutMs ?? 120_000,
        options.transportFactory,
        maximumMcpLineBytes(options.maximumLineBytes),
      )
    );
  }

  async start(): Promise<void> {
    await Promise.all(this.clients.map(async (client) => {
      try {
        await client.start();
      } catch {
        // One optional MCP server must not prevent the native kernel from starting.
      }
    }));
  }

  toolEntries(): Array<{ client: McpStdioClient; tool: McpToolDescription }> {
    return this.clients.flatMap((client) =>
      client.definitions().map((tool) => ({ client, tool }))
    );
  }

  status(): McpServerStatus[] {
    return this.clients.map((client) => client.status());
  }

  async close(): Promise<void> {
    const settled = await Promise.allSettled(this.clients.map((client) => client.close()));
    const failures = settled
      .filter((entry): entry is PromiseRejectedResult => entry.status === "rejected")
      .map((entry) => entry.reason);
    if (failures.length > 0) {
      throw new AggregateError(failures, "MCP manager cleanup could not be verified.");
    }
  }
}

function maximumMcpLineBytes(value: number | undefined): number {
  if (value === undefined) return MAX_MCP_LINE_BYTES;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_MCP_LINE_BYTES) {
    throw new Error("MCP response line bound is invalid.");
  }
  return value;
}

export function createMcpTools(
  manager: McpManager,
  artifacts: ArtifactStore
): NativeTool<Record<string, unknown>>[] {
  const used = new Set<string>();
  return manager.toolEntries().map(({ client, tool }) => {
    const name = uniqueToolName(client.spec.name, tool.name, used);
    return {
      definition: {
        name,
        description: tool.description?.trim() || `Call ${tool.name} on MCP server ${client.spec.name}`,
        inputSchema: tool.inputSchema ?? { type: "object", additionalProperties: true },
        readOnly:
          tool.annotations?.readOnlyHint === true &&
          tool.annotations?.destructiveHint === false,
        effect: "external",
      },
      validate: objectInput,
      assessAccess: () => ({
        capability: `mcp.${client.spec.name}.${tool.name}`,
        external: true,
        destructive: tool.annotations?.destructiveHint !== false,
      }),
      execute: async (input) => await mcpOutput(
        await client.call(tool.name, input),
        artifacts,
        `${client.spec.name}.${tool.name}`
      ),
    };
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

function isMcpTool(value: unknown): value is McpToolDescription {
  return record(value) && typeof value.name === "string" && value.name.trim().length > 0;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
