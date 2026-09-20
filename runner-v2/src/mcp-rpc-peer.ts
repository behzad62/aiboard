import type { McpDiscoveryTool } from "./runner-internal-execution-context.js";

export type McpRequestOutcome = "not_sent" | "outcome_unknown" | "response_received";
export type McpProtocolErrorCode = "mcp_protocol_invalid" | "mcp_output_limit" | "mcp_request_timeout" |
  "mcp_request_cancelled" | "mcp_write_outcome_unknown" | "mcp_transport_unavailable" | "mcp_remote_error" |
  "mcp_schema_changed" | "mcp_request_busy";
export class McpProtocolError extends Error {
  constructor(readonly code: McpProtocolErrorCode, message: string, readonly outcome: McpRequestOutcome, options?: ErrorOptions) {
    super(message, options); this.name = "McpProtocolError";
  }
}
export interface McpRpcWriter { write(payload: Uint8Array, timeoutMs: number): Promise<void> }
interface Pending {
  readonly id: number;
  started: boolean;
  responded: boolean;
  resolve(value: Readonly<{ result?: unknown; error?: Readonly<{ code: number; message: string }> }>): void;
  reject(error: Error): void;
}

/** One bounded request at a time, no autonomous retry/replay. Framing and request
 * IDs are protocol concerns; the writer remains owned by the shared runtime.
 * A response alone is not proof that the corresponding write acknowledged.
 */
export class McpRpcPeer {
  private buffer = Buffer.alloc(0);
  private nextId = 1;
  private pending?: Pending;
  private failure?: McpProtocolError;
  private readonly maximumLineBytes: number;
  constructor(options: Readonly<{ maximumLineBytes?: number; onFailure?: (error: McpProtocolError) => void }> = {}) {
    this.maximumLineBytes = options.maximumLineBytes ?? 1024 * 1024;
    if (!Number.isSafeInteger(this.maximumLineBytes) || this.maximumLineBytes < 1 || this.maximumLineBytes > 1024 * 1024)
      throw new Error("MCP protocol line bound is invalid.");
    this.onFailure = options.onFailure;
  }
  private readonly onFailure?: (error: McpProtocolError) => void;
  get idle(): boolean { return !this.pending && !this.failure && this.buffer.length === 0; }
  get bufferedBytes(): number { return this.buffer.byteLength; }
  get error(): McpProtocolError | undefined { return this.failure; }

  feed(stream: "stdout" | "stderr", bytes: Uint8Array): void {
    // stderr is independently bounded/evidenced by the streaming output owner;
    // it is never interpreted as JSON-RPC, credentials or protocol authority.
    if (stream !== "stdout" || this.failure) return;
    let offset = 0;
    for (let i = 0; i < bytes.byteLength; i++) {
      if (bytes[i] !== 10) continue;
      if (!this.append(bytes.subarray(offset, i))) return;
      const line = this.buffer.at(-1) === 13 ? this.buffer.subarray(0, -1) : this.buffer;
      this.buffer = Buffer.alloc(0);
      if (line.length) this.line(line);
      if (this.failure) return;
      offset = i + 1;
    }
    this.append(bytes.subarray(offset));
  }

  async request(writer: McpRpcWriter, method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    if (this.failure) throw this.failure;
    if (signal?.aborted) throw new McpProtocolError("mcp_request_cancelled", "MCP request was cancelled before write.", "not_sent");
    if (this.pending) throw new McpProtocolError("mcp_request_busy", "An MCP request is already in progress.", "not_sent");
    if (this.buffer.length > 0) throw new McpProtocolError("mcp_protocol_invalid", "An incomplete MCP frame prevents a new request until protocol idleness is established.", "not_sent");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3_600_000 || !Number.isSafeInteger(this.nextId))
      throw new McpProtocolError("mcp_protocol_invalid", "MCP request bounds are invalid.", "not_sent");
    let payload: Buffer;
    const id = this.nextId;
    try { payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); }
    catch (cause) { throw new McpProtocolError("mcp_protocol_invalid", "MCP request cannot be encoded.", "not_sent", { cause }); }
    if (payload.length > this.maximumLineBytes) throw new McpProtocolError("mcp_output_limit", "MCP request exceeds its frame bound.", "not_sent");
    this.nextId++;
    let current!: Pending;
    const response = new Promise<Readonly<{ result?: unknown; error?: Readonly<{ code: number; message: string }> }>>((resolve, reject) => {
      current = { id, started: false, responded: false, resolve, reject };
    });
    void response.catch(() => undefined);
    this.pending = current;
    const timeout = setTimeout(() => this.fail("mcp_request_timeout", "MCP request exceeded its write/response deadline."), timeoutMs);
    const cancel = () => this.fail("mcp_request_cancelled", "MCP request was cancelled; protocol idleness is not established.");
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      current.started = true;
      // Promise.resolve().then also owns a writer that throws synchronously.
      const written = Promise.resolve().then(() => {
        if (this.failure) throw this.failure;
        return writer.write(payload, Math.min(timeoutMs, 30_000));
      }).catch((cause: unknown) => {
        if (!this.failure) this.fail("mcp_write_outcome_unknown", "MCP request write acknowledgement is unavailable.", cause);
        throw this.failure!;
      });
      void written.catch(() => undefined);
      // The failure branch races BOTH pending writes and pending replies, even
      // when a reply arrived before an unresponsive write acknowledged.
      let unobserve!: () => void;
      const unavailable = new Promise<never>((_resolve, reject) => { unobserve = this.observeFailure(reject); });
      try {
        const [, reply] = await Promise.race([Promise.all([written, response]), unavailable]);
        if (this.failure) throw this.failure;
        if (reply.error) throw new McpProtocolError("mcp_remote_error", reply.error.message, "response_received");
        return reply.result;
      } finally { unobserve(); }
    } finally {
      clearTimeout(timeout); signal?.removeEventListener("abort", cancel);
      if (this.pending === current) this.pending = undefined;
    }
  }

  async notify(writer: McpRpcWriter, method: string, params: unknown, timeoutMs: number): Promise<void> {
    if (this.failure) throw this.failure;
    const payload = Buffer.from(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
    if (payload.length > this.maximumLineBytes) throw new McpProtocolError("mcp_output_limit", "MCP notification exceeds its frame bound.", "not_sent");
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([Promise.resolve().then(() => writer.write(payload, timeoutMs)), new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new McpProtocolError("mcp_request_timeout", "MCP notification write timed out.", "outcome_unknown")), timeoutMs);
      })]);
    } catch (cause) {
      this.fail("mcp_write_outcome_unknown", "MCP notification write acknowledgement is unavailable.", cause); throw this.failure!;
    } finally { if (timer) clearTimeout(timer); }
  }

  close(cause?: unknown): void { this.fail("mcp_transport_unavailable", "MCP transport is closed or unavailable.", cause); }

  private readonly failureListeners = new Set<(error: McpProtocolError) => void>();
  private observeFailure(listener: (error: McpProtocolError) => void): () => void {
    if (this.failure) listener(this.failure);
    else this.failureListeners.add(listener);
    return () => { this.failureListeners.delete(listener); };
  }
  private fail(code: McpProtocolErrorCode, message: string, cause?: unknown): void {
    if (this.failure) return;
    this.failure = new McpProtocolError(code, message, this.pending?.started ? "outcome_unknown" : "not_sent", { cause });
    this.buffer = Buffer.alloc(0);
    this.pending?.reject(this.failure);
    for (const listener of this.failureListeners) listener(this.failure);
    this.failureListeners.clear();
    this.onFailure?.(this.failure);
  }
  private append(bytes: Uint8Array): boolean {
    if (this.buffer.byteLength + bytes.byteLength > this.maximumLineBytes) {
      this.fail("mcp_output_limit", "MCP response exceeded its line bound."); return false;
    }
    if (bytes.length) this.buffer = Buffer.concat([this.buffer, Buffer.from(bytes)]);
    return true;
  }
  private line(bytes: Uint8Array): void {
    let message: unknown;
    try { message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch (cause) { this.fail("mcp_protocol_invalid", "MCP UTF8/JSON protocol frame is invalid.", cause); return; }
    if (!object(message) || message.jsonrpc !== "2.0") { this.fail("mcp_protocol_invalid", "MCP JSON-RPC version/object is invalid."); return; }
    if (typeof message.method === "string") {
      if (Object.hasOwn(message, "id")) { this.fail("mcp_protocol_invalid", "MCP server-originated requests have no execution authority."); return; }
      if (message.method === "notifications/tools/list_changed") this.fail("mcp_schema_changed", "MCP tool schema changed after discovery.");
      return;
    }
    const current = this.pending;
    if (!current || current.responded || !Number.isSafeInteger(message.id) || message.id !== current.id) {
      this.fail("mcp_protocol_invalid", "MCP response does not match the exact pending request ID."); return;
    }
    const result = Object.hasOwn(message, "result"); const error = Object.hasOwn(message, "error");
    if (result === error || error && (!object(message.error) || !Number.isInteger(message.error.code) || typeof message.error.message !== "string")) {
      this.fail("mcp_protocol_invalid", "MCP response must have exactly one valid result or error."); return;
    }
    current.responded = true;
    if (error) current.resolve({ error: message.error as { code: number; message: string } });
    else current.resolve({ result: message.result });
  }
}

export function parseMcpToolList(value: unknown): readonly McpDiscoveryTool[] {
  if (!object(value) || !Array.isArray(value.tools) || value.tools.length > 1024)
    throw new Error("MCP tools/list result is invalid or exceeds its tool bound.");
  const names = new Set<string>();
  const result = value.tools.map((value) => {
    if (!object(value) || typeof value.name !== "string" || !value.name.trim() || value.name.length > 256 || names.has(value.name) ||
        value.inputSchema !== undefined && !object(value.inputSchema) || value.annotations !== undefined && !object(value.annotations))
      throw new Error("MCP tool name or schema is invalid or duplicated.");
    names.add(value.name);
    const annotations = object(value.annotations) ? value.annotations : undefined;
    const tool = {
      name: value.name,
      ...(typeof value.description === "string" ? { description: value.description } : {}),
      ...(object(value.inputSchema) ? { inputSchema: structuredClone(value.inputSchema) } : {}),
      ...(annotations ? { annotations: {
        ...(typeof annotations.readOnlyHint === "boolean" ? { readOnlyHint: annotations.readOnlyHint } : {}),
        ...(typeof annotations.destructiveHint === "boolean" ? { destructiveHint: annotations.destructiveHint } : {}),
      } } : {}),
    };
    if (Buffer.byteLength(JSON.stringify(tool)) > 1024 * 1024) throw new Error("MCP tool schema exceeds its byte bound.");
    return freeze(tool);
  });
  return Object.freeze(result);
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function freeze<T>(value: T): Readonly<T> { if (value && typeof value === "object") { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
