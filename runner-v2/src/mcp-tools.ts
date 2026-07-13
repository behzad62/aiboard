import { createHash } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

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

class McpStdioClient {
  private child: ChildProcessWithoutNullStreams | undefined;
  private readonly pending = new Map<number, PendingRequest>();
  private nextId = 1;
  private tools: McpToolDescription[] = [];
  private state: McpServerStatus["status"] = "stopped";
  private error: string | undefined;

  constructor(
    readonly spec: McpServerSpec,
    private readonly cwd: string,
    private readonly requestTimeoutMs: number
  ) {}

  async start(): Promise<void> {
    if (this.child) return;
    this.state = "starting";
    this.error = undefined;
    const child = spawn(this.spec.command, {
      cwd: this.cwd,
      env: process.env,
      shell: true,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => this.receive(line));
    child.stderr.on("data", () => {
      // Stderr is intentionally not forwarded into model or run context.
    });
    child.once("close", (code) => {
      this.child = undefined;
      this.tools = [];
      if (this.state !== "stopped") {
        this.state = "error";
        this.error = `MCP server exited with code ${code ?? "unknown"}.`;
      }
      this.rejectPending(new Error(this.error ?? "MCP server stopped."));
    });
    child.once("error", (error) => {
      this.state = "error";
      this.error = error.message;
      this.rejectPending(error);
    });
    try {
      await this.request("initialize", {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "aiboard-runner-v2", version: "2" },
      });
      this.notify("notifications/initialized", {});
      const listed = await this.request("tools/list", {}) as { tools?: unknown };
      this.tools = Array.isArray(listed?.tools)
        ? listed.tools.filter(isMcpTool)
        : [];
      this.state = "ready";
    } catch (error) {
      this.state = "error";
      this.error = error instanceof Error ? error.message : String(error);
      await this.close();
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
    const child = this.child;
    this.state = "stopped";
    this.tools = [];
    if (!child) return;
    this.child = undefined;
    child.kill();
    this.rejectPending(new Error("MCP server stopped."));
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, 2_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error(`MCP server ${this.spec.name} is not running.`));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP request timed out: ${method}.`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  private notify(method: string, params: unknown): void {
    this.child?.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  private receive(line: string): void {
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
}

export interface McpManagerOptions {
  cwd: string;
  servers: readonly McpServerSpec[];
  requestTimeoutMs?: number;
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
      new McpStdioClient(server, options.cwd, options.requestTimeoutMs ?? 120_000)
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
    await Promise.all(this.clients.map((client) => client.close()));
  }
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
