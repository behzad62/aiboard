import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import {
  lstatSync,
  realpathSync,
  statSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from "node:path";
import { pathToFileURL } from "node:url";

const HEADER_BOUNDARY = Buffer.from("\r\n\r\n", "ascii");
const MAX_HEADER_BYTES = 8 * 1024;
const DEFAULT_MAX_FRAME_BYTES = 4 * 1024 * 1024;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 2_000;
const DEFAULT_MAX_PENDING_REQUESTS = 128;
const MAX_STDERR_BYTES = 8 * 1024;

export type LspClientErrorCode =
  | "invalid_configuration"
  | "client_closed"
  | "spawn_failed"
  | "process_error"
  | "process_exited"
  | "write_failed"
  | "protocol_error"
  | "frame_too_large"
  | "request_timeout"
  | "request_cancelled"
  | "response_error"
  | "too_many_pending_requests"
  | "path_outside_workspace"
  | "document_already_open"
  | "document_not_open"
  | "stale_document_version";

export class LspClientError extends Error {
  constructor(
    readonly code: LspClientErrorCode,
    message: string,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "LspClientError";
  }
}

export interface LspClientOptions {
  command: string;
  args?: readonly string[];
  workspaceRoot: string;
  env?: NodeJS.ProcessEnv;
  initializationOptions?: unknown;
  requestTimeoutMs?: number;
  shutdownTimeoutMs?: number;
  restartLimit?: number;
  maxFrameBytes?: number;
  maxPendingRequests?: number;
}

export interface LspDocumentInput {
  path: string;
  languageId: string;
  version: number;
  text: string;
}

export interface LspClientStats {
  starts: number;
  restarts: number;
  state: "idle" | "starting" | "running" | "restarting" | "failed" | "closing" | "closed";
  openDocuments: number;
}

export interface PublishedDiagnostics {
  uri: string;
  version?: number;
  diagnostics: unknown[];
}

interface OpenDocument {
  uri: string;
  path: string;
  languageId: string;
  version: number;
  text: string;
}

interface ProcessSession {
  generation: number;
  child: ChildProcessWithoutNullStreams;
  buffer: Buffer;
  stderr: Buffer;
  initialized: boolean;
  expectedExit: boolean;
  failure?: LspClientError;
  exited: Promise<void>;
  resolveExited(): void;
}

interface PendingRequest {
  id: number;
  key: string;
  method: string;
  generation: number;
  timer: NodeJS.Timeout;
  onAbort?: () => void;
  signal?: AbortSignal;
  cancellationError?: LspClientError;
  settled: boolean;
  resolve(value: unknown): void;
  reject(error: unknown): void;
}

interface JsonRpcMessage {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
  result?: unknown;
  error?: unknown;
}

export class LspClient {
  readonly workspaceRoot: string;

  private readonly command: string;
  private readonly args: string[];
  private readonly env?: NodeJS.ProcessEnv;
  private readonly initializationOptions?: unknown;
  private readonly requestTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly restartLimit: number;
  private readonly maxFrameBytes: number;
  private readonly maxPendingRequests: number;
  private readonly documents = new Map<string, OpenDocument>();
  private readonly diagnostics = new Map<string, PublishedDiagnostics>();
  private readonly pending = new Map<string, PendingRequest>();
  private session?: ProcessSession;
  private startPromise?: Promise<void>;
  private restartPromise?: Promise<boolean>;
  private closePromise?: Promise<void>;
  private nextRequestId = 1;
  private nextGeneration = 1;
  private starts = 0;
  private restarts = 0;
  private state: LspClientStats["state"] = "idle";

  constructor(options: LspClientOptions) {
    if (typeof options.command !== "string" || !options.command.trim() || options.command.includes("\0")) {
      throw configurationError("LSP command must be a non-empty string without NUL bytes.");
    }
    if (options.args !== undefined && !Array.isArray(options.args)) {
      throw configurationError("LSP arguments must be an array.");
    }
    const args = [...(options.args ?? [])];
    if (
      args.length > 128 ||
      args.some((argument) =>
        typeof argument !== "string" ||
        argument.includes("\0") ||
        Buffer.byteLength(argument) > 4_096)
    ) {
      throw configurationError("LSP arguments are invalid or exceed their bounds.");
    }
    const workspace = resolve(options.workspaceRoot);
    try {
      if (!statSync(workspace).isDirectory()) {
        throw configurationError("LSP workspace root must be a directory.");
      }
      this.workspaceRoot = realpathSync(workspace);
    } catch (error) {
      if (error instanceof LspClientError) throw error;
      throw new LspClientError(
        "invalid_configuration",
        "LSP workspace root must be an existing directory.",
        false,
        { cause: error },
      );
    }
    this.command = options.command;
    this.args = args;
    this.env = options.env ? { ...options.env } : undefined;
    this.initializationOptions = options.initializationOptions;
    this.requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      "requestTimeoutMs",
    );
    this.shutdownTimeoutMs = positiveInteger(
      options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS,
      "shutdownTimeoutMs",
    );
    this.restartLimit = boundedInteger(options.restartLimit ?? 1, "restartLimit", 0, 10);
    this.maxFrameBytes = positiveInteger(
      options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES,
      "maxFrameBytes",
    );
    this.maxPendingRequests = positiveInteger(
      options.maxPendingRequests ?? DEFAULT_MAX_PENDING_REQUESTS,
      "maxPendingRequests",
    );
  }

  async start(): Promise<void> {
    this.assertNotClosed();
    if (this.state === "running" && this.session?.initialized) return;
    if (this.startPromise) return await this.startPromise;
    if (this.restartPromise) {
      if (await this.restartPromise) return;
    }
    if (this.state === "failed" && this.session) {
      const failure = this.session.failure ?? new LspClientError(
        "process_exited",
        "Language server is not running.",
        true,
      );
      if (!failure.retryable || !(await this.restartAfterFailure(this.session))) {
        throw failure;
      }
      return;
    }
    this.startPromise = this.startSession(false).finally(() => {
      this.startPromise = undefined;
    });
    return await this.startPromise;
  }

  async request<T>(
    method: string,
    params: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (typeof method !== "string" || !method.trim()) {
      throw new LspClientError("protocol_error", "LSP request method is required.");
    }
    this.assertNotClosed();
    while (true) {
      let attemptedSession: ProcessSession | undefined;
      try {
        await this.start();
        const session = this.requireRunningSession();
        attemptedSession = session;
        return await this.requestOnSession<T>(
          session,
          method,
          params,
          signal,
          this.requestTimeoutMs,
        );
      } catch (error) {
        if (
          !(error instanceof LspClientError) ||
          !error.retryable ||
          signal?.aborted ||
          this.state === "closing" ||
          this.state === "closed"
        ) {
          throw error;
        }
        const failed = attemptedSession ?? this.session;
        if (!failed || !(await this.restartAfterFailure(failed))) throw error;
      }
    }
  }

  async openDocument(input: LspDocumentInput): Promise<void> {
    validateDocumentInput(input);
    const path = this.containedPath(input.path);
    const uri = pathToFileURL(path).href;
    if (this.documents.has(uri)) {
      throw new LspClientError(
        "document_already_open",
        `LSP document is already open: ${displayPath(this.workspaceRoot, path)}.`,
      );
    }
    await this.start();
    const session = this.requireRunningSession();
    await this.notifyOnSession(session, "textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: input.languageId,
        version: input.version,
        text: input.text,
      },
    });
    this.documents.set(uri, {
      uri,
      path,
      languageId: input.languageId,
      version: input.version,
      text: input.text,
    });
  }

  async updateDocument(
    input: Omit<LspDocumentInput, "languageId">,
  ): Promise<void> {
    validateDocumentVersion(input.version);
    if (typeof input.text !== "string") {
      throw new LspClientError("protocol_error", "LSP document text must be a string.");
    }
    const path = this.containedPath(input.path);
    const uri = pathToFileURL(path).href;
    const current = this.documents.get(uri);
    if (!current) {
      throw new LspClientError(
        "document_not_open",
        `LSP document is not open: ${displayPath(this.workspaceRoot, path)}.`,
      );
    }
    if (input.version !== current.version + 1) {
      throw new LspClientError(
        "stale_document_version",
        `LSP document ${displayPath(this.workspaceRoot, path)} requires version ${
          current.version + 1
        }; received ${input.version}.`,
      );
    }
    await this.start();
    const session = this.requireRunningSession();
    await this.notifyOnSession(session, "textDocument/didChange", {
      textDocument: { uri, version: input.version },
      contentChanges: [{ text: input.text }],
    });
    this.documents.set(uri, {
      ...current,
      version: input.version,
      text: input.text,
    });
  }

  async closeDocument(pathValue: string): Promise<void> {
    const path = this.containedPath(pathValue);
    const uri = pathToFileURL(path).href;
    if (!this.documents.has(uri)) {
      throw new LspClientError(
        "document_not_open",
        `LSP document is not open: ${displayPath(this.workspaceRoot, path)}.`,
      );
    }
    await this.start();
    await this.notifyOnSession(
      this.requireRunningSession(),
      "textDocument/didClose",
      { textDocument: { uri } },
    );
    this.documents.delete(uri);
    this.diagnostics.delete(uri);
  }

  documentUri(path: string): string {
    return pathToFileURL(this.containedPath(path)).href;
  }

  publishedDiagnostics(uri: string): PublishedDiagnostics | undefined {
    const value = this.diagnostics.get(uri);
    return value
      ? {
          ...value,
          diagnostics: structuredClone(value.diagnostics),
        }
      : undefined;
  }

  stats(): LspClientStats {
    return {
      starts: this.starts,
      restarts: this.restarts,
      state: this.state,
      openDocuments: this.documents.size,
    };
  }

  async close(): Promise<void> {
    if (this.closePromise) return await this.closePromise;
    this.closePromise = this.closeInternal();
    return await this.closePromise;
  }

  private async closeInternal(): Promise<void> {
    if (this.state === "closed") return;
    this.state = "closing";
    const session = this.session;
    if (session && !session.expectedExit) {
      if (session.initialized && !session.failure) {
        try {
          await this.requestOnSession(
            session,
            "shutdown",
            null,
            undefined,
            this.shutdownTimeoutMs,
          );
          session.expectedExit = true;
          await this.notifyOnSession(session, "exit", null);
        } catch {
          session.expectedExit = true;
          killProcess(session.child);
        }
      } else {
        session.expectedExit = true;
        killProcess(session.child);
      }
      if (!(await waitForProcessExit(session, this.shutdownTimeoutMs))) {
        killProcess(session.child, "SIGKILL");
        if (!(await waitForProcessExit(session, this.shutdownTimeoutMs))) {
          const failure = new LspClientError(
            "process_error",
            "Language server did not exit after forced shutdown.",
          );
          this.rejectPending(() => true, failure);
          this.documents.clear();
          this.diagnostics.clear();
          this.state = "failed";
          throw failure;
        }
      }
    }
    const closed = new LspClientError("client_closed", "LSP client is closed.");
    this.rejectPending(() => true, closed);
    this.documents.clear();
    this.diagnostics.clear();
    this.session = undefined;
    this.state = "closed";
  }

  private async startSession(restart: boolean): Promise<void> {
    this.assertNotClosed();
    this.state = restart ? "restarting" : "starting";
    const generation = this.nextGeneration++;
    let resolveExited!: () => void;
    const exited = new Promise<void>((resolvePromise) => {
      resolveExited = resolvePromise;
    });
    const child = spawn(this.command, this.args, {
      cwd: this.workspaceRoot,
      env: this.env,
      shell: false,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const session: ProcessSession = {
      generation,
      child,
      buffer: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      initialized: false,
      expectedExit: false,
      exited,
      resolveExited,
    };
    this.session = session;
    this.starts += 1;
    child.stdout.on("data", (chunk: Buffer) => this.consumeStdout(session, chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      session.stderr = boundedAppend(session.stderr, chunk, MAX_STDERR_BYTES);
    });
    child.on("exit", (code, signal) => this.onProcessExit(session, code, signal));
    child.on("error", (error) => this.onProcessError(session, error));
    try {
      await waitForSpawn(child);
    } catch (error) {
      const failure = new LspClientError(
        "spawn_failed",
        `Language server failed to start: ${boundedMessage(error)}.`,
        false,
        { cause: error },
      );
      this.failSession(session, failure);
      this.state = "failed";
      throw failure;
    }
    try {
      const initialized = await this.requestOnSession<Record<string, unknown>>(
        session,
        "initialize",
        {
          processId: process.pid,
          clientInfo: { name: "aiboard-runner-v2", version: "2" },
          rootUri: pathToFileURL(this.workspaceRoot).href,
          workspaceFolders: [{
            uri: pathToFileURL(this.workspaceRoot).href,
            name: basename(this.workspaceRoot),
          }],
          capabilities: {
            general: { positionEncodings: ["utf-16"] },
            workspace: { symbol: {} },
            textDocument: {
              synchronization: { didSave: false, dynamicRegistration: false },
              definition: {},
              references: {},
              diagnostic: {},
              publishDiagnostics: { versionSupport: true },
            },
          },
          ...(this.initializationOptions === undefined
            ? {}
            : { initializationOptions: this.initializationOptions }),
          trace: "off",
        },
        undefined,
        this.requestTimeoutMs,
      );
      if (!isObject(initialized) || !isObject(initialized.capabilities)) {
        throw new LspClientError(
          "protocol_error",
          "Language server returned an invalid initialize result.",
          true,
        );
      }
      if (
        initialized.capabilities.positionEncoding !== undefined &&
        initialized.capabilities.positionEncoding !== "utf-16"
      ) {
        throw new LspClientError(
          "protocol_error",
          "Language server selected an unsupported position encoding; UTF-16 is required.",
        );
      }
      await this.notifyOnSession(session, "initialized", {});
      session.initialized = true;
      for (const document of this.documents.values()) {
        await this.notifyOnSession(session, "textDocument/didOpen", {
          textDocument: {
            uri: document.uri,
            languageId: document.languageId,
            version: document.version,
            text: document.text,
          },
        });
      }
      this.state = "running";
    } catch (error) {
      const failure = asLspError(error, "protocol_error", true);
      this.failSession(session, failure);
      this.state = "failed";
      throw failure;
    }
  }

  private async restartAfterFailure(failed: ProcessSession): Promise<boolean> {
    if (
      this.session &&
      this.session.generation !== failed.generation &&
      this.session.initialized &&
      this.state === "running"
    ) return true;
    if (this.restartPromise) return await this.restartPromise;
    if (this.restarts >= this.restartLimit) return false;
    this.restarts += 1;
    this.restartPromise = (async () => {
      failed.expectedExit = true;
      killProcess(failed.child);
      if (!(await waitForProcessExit(failed, this.shutdownTimeoutMs))) {
        killProcess(failed.child, "SIGKILL");
        if (!(await waitForProcessExit(failed, this.shutdownTimeoutMs))) {
          throw new LspClientError(
            "process_error",
            "Crashed language server did not exit before restart.",
          );
        }
      }
      await this.startSession(true);
      return true;
    })().finally(() => {
      this.restartPromise = undefined;
    });
    return await this.restartPromise;
  }

  private requestOnSession<T>(
    session: ProcessSession,
    method: string,
    params: unknown,
    signal: AbortSignal | undefined,
    timeoutMs: number,
  ): Promise<T> {
    if (signal?.aborted) {
      return Promise.reject(new LspClientError(
        "request_cancelled",
        `LSP request ${method} was cancelled.`,
      ));
    }
    if (this.pending.size >= this.maxPendingRequests) {
      return Promise.reject(new LspClientError(
        "too_many_pending_requests",
        `LSP pending request limit ${this.maxPendingRequests} was reached.`,
      ));
    }
    const id = this.nextRequestId++;
    const key = String(id);
    return new Promise<T>((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        this.cancelPending(
          session,
          key,
          new LspClientError(
            "request_timeout",
            `LSP request ${method} exceeded ${timeoutMs} ms.`,
          ),
        );
      }, timeoutMs);
      const entry: PendingRequest = {
        id,
        key,
        method,
        generation: session.generation,
        timer,
        signal,
        settled: false,
        resolve: resolvePromise,
        reject: rejectPromise,
      };
      if (signal) {
        entry.onAbort = () => this.cancelPending(
          session,
          key,
          new LspClientError(
            "request_cancelled",
            `LSP request ${method} was cancelled.`,
          ),
        );
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(key, entry);
      void this.writeMessage(session, { jsonrpc: "2.0", id, method, params })
        .catch((error) => {
          this.settlePending(
            key,
            false,
            asLspError(error, "write_failed", true),
          );
        });
    });
  }

  private async notifyOnSession(
    session: ProcessSession,
    method: string,
    params: unknown,
  ): Promise<void> {
    await this.writeMessage(session, { jsonrpc: "2.0", method, params });
  }

  private async writeMessage(
    session: ProcessSession,
    message: Record<string, unknown>,
  ): Promise<void> {
    if (session.failure || session.child.stdin.destroyed || !session.child.stdin.writable) {
      throw session.failure ?? new LspClientError(
        "write_failed",
        "Language server input is not writable.",
        true,
      );
    }
    let body: Buffer;
    try {
      body = Buffer.from(JSON.stringify(message));
    } catch (error) {
      throw new LspClientError(
        "protocol_error",
        "LSP message is not JSON serializable.",
        false,
        { cause: error },
      );
    }
    if (body.byteLength > this.maxFrameBytes) {
      throw new LspClientError(
        "frame_too_large",
        `Outgoing LSP frame exceeds ${this.maxFrameBytes} bytes.`,
      );
    }
    const frame = Buffer.concat([
      Buffer.from(`Content-Length: ${body.byteLength}\r\n\r\n`, "ascii"),
      body,
    ]);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      session.child.stdin.write(frame, (error) => {
        if (error) {
          rejectPromise(new LspClientError(
            "write_failed",
            `Language server write failed: ${boundedMessage(error)}.`,
            true,
            { cause: error },
          ));
        } else {
          resolvePromise();
        }
      });
    });
  }

  private consumeStdout(session: ProcessSession, chunk: Buffer): void {
    if (session.failure) return;
    session.buffer = Buffer.concat([session.buffer, chunk]);
    while (true) {
      const boundary = session.buffer.indexOf(HEADER_BOUNDARY);
      if (boundary < 0) {
        if (session.buffer.byteLength > MAX_HEADER_BYTES) {
          this.failSession(session, new LspClientError(
            "protocol_error",
            "Language server frame header exceeded its bound.",
            true,
          ));
        }
        return;
      }
      if (boundary > MAX_HEADER_BYTES) {
        this.failSession(session, new LspClientError(
          "protocol_error",
          "Language server frame header exceeded its bound.",
          true,
        ));
        return;
      }
      let contentLength: number;
      try {
        contentLength = parseContentLength(
          session.buffer.subarray(0, boundary).toString("ascii"),
        );
      } catch (error) {
        this.failSession(session, asLspError(error, "protocol_error", true));
        return;
      }
      if (contentLength > this.maxFrameBytes) {
        this.failSession(session, new LspClientError(
          "frame_too_large",
          `Language server frame exceeds ${this.maxFrameBytes} bytes.`,
          true,
        ));
        return;
      }
      const frameEnd = boundary + HEADER_BOUNDARY.byteLength + contentLength;
      if (session.buffer.byteLength < frameEnd) return;
      const body = session.buffer.subarray(
        boundary + HEADER_BOUNDARY.byteLength,
        frameEnd,
      );
      session.buffer = session.buffer.subarray(frameEnd);
      let message: unknown;
      try {
        message = JSON.parse(body.toString("utf8"));
        this.handleMessage(session, message);
      } catch (error) {
        this.failSession(session, asLspError(error, "protocol_error", true));
        return;
      }
    }
  }

  private handleMessage(session: ProcessSession, input: unknown): void {
    if (!isObject(input) || input.jsonrpc !== "2.0") {
      throw new LspClientError(
        "protocol_error",
        "Language server emitted an invalid JSON-RPC message.",
        true,
      );
    }
    const message = input as JsonRpcMessage;
    if (typeof message.method === "string") {
      if (message.id === undefined) {
        this.handleNotification(message.method, message.params);
      } else {
        void this.handleServerRequest(session, message.id, message.method, message.params);
      }
      return;
    }
    if (message.id === undefined) {
      throw new LspClientError(
        "protocol_error",
        "Language server response is missing an id.",
        true,
      );
    }
    const key = String(message.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    // A server is allowed to race a cancellation acknowledgement against our
    // local abort. Preserve the caller-visible cancellation/timeout outcome.
    if (pending.cancellationError) return;
    const hasResult = Object.hasOwn(input, "result");
    const hasError = Object.hasOwn(input, "error");
    if (hasResult === hasError) {
      throw new LspClientError(
        "protocol_error",
        "Language server response must contain exactly one result or error.",
        true,
      );
    }
    if (hasError) {
      if (!isObject(message.error) ||
          typeof message.error.code !== "number" ||
          typeof message.error.message !== "string") {
        throw new LspClientError(
          "protocol_error",
          "Language server returned an invalid error response.",
          true,
        );
      }
      this.settlePending(key, false, new LspClientError(
        "response_error",
        `LSP request failed (${message.error.code}): ${boundedText(
          message.error.message,
          512,
        )}`,
      ));
    } else {
      this.settlePending(key, true, message.result);
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (method !== "textDocument/publishDiagnostics" || !isObject(params)) return;
    if (typeof params.uri !== "string" || !Array.isArray(params.diagnostics)) return;
    this.diagnostics.set(params.uri, {
      uri: params.uri,
      ...(Number.isSafeInteger(params.version)
        ? { version: params.version as number }
        : {}),
      diagnostics: structuredClone(params.diagnostics),
    });
  }

  private async handleServerRequest(
    session: ProcessSession,
    id: unknown,
    method: string,
    params: unknown,
  ): Promise<void> {
    try {
      if (method === "workspace/configuration") {
        const count = isObject(params) && Array.isArray(params.items)
          ? params.items.length
          : 0;
        await this.writeMessage(session, {
          jsonrpc: "2.0",
          id,
          result: Array.from({ length: count }, () => null),
        });
        return;
      }
      if (
        method === "window/workDoneProgress/create" ||
        method === "client/registerCapability" ||
        method === "client/unregisterCapability"
      ) {
        await this.writeMessage(session, { jsonrpc: "2.0", id, result: null });
        return;
      }
      await this.writeMessage(session, {
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: `Unsupported server request ${method}` },
      });
    } catch (error) {
      this.failSession(session, asLspError(error, "write_failed", true));
    }
  }

  private cancelPending(
    session: ProcessSession,
    key: string,
    error: LspClientError,
  ): void {
    const pending = this.pending.get(key);
    if (!pending || pending.settled || pending.cancellationError) return;
    pending.cancellationError = error;
    void this.notifyOnSession(session, "$/cancelRequest", { id: pending.id })
      .catch(() => undefined)
      .finally(() => this.settlePending(key, false, error));
  }

  private settlePending(key: string, success: boolean, value: unknown): void {
    const pending = this.pending.get(key);
    if (!pending || pending.settled) return;
    pending.settled = true;
    clearTimeout(pending.timer);
    if (pending.signal && pending.onAbort) {
      pending.signal.removeEventListener("abort", pending.onAbort);
    }
    this.pending.delete(key);
    if (success) pending.resolve(value);
    else pending.reject(value);
  }

  private rejectPending(
    predicate: (pending: PendingRequest) => boolean,
    error: LspClientError,
  ): void {
    for (const pending of [...this.pending.values()]) {
      if (predicate(pending)) this.settlePending(pending.key, false, error);
    }
  }

  private onProcessExit(
    session: ProcessSession,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    session.resolveExited();
    if (session.expectedExit) return;
    const detail = session.stderr.byteLength > 0
      ? ` stderr: ${boundedText(session.stderr.toString("utf8"), 512)}`
      : "";
    const failure = session.failure ?? new LspClientError(
      "process_exited",
      `Language server exited unexpectedly (code ${String(code)}, signal ${String(signal)}).${detail}`,
      true,
    );
    session.failure = failure;
    this.rejectPending(
      (pending) => pending.generation === session.generation,
      failure,
    );
    if (this.session?.generation === session.generation && this.state !== "closed") {
      this.state = "failed";
    }
  }

  private onProcessError(session: ProcessSession, error: Error): void {
    if (session.failure) return;
    this.failSession(session, new LspClientError(
      "process_error",
      `Language server process error: ${boundedMessage(error)}.`,
      true,
      { cause: error },
    ));
  }

  private failSession(session: ProcessSession, error: LspClientError): void {
    if (session.failure) return;
    session.failure = error;
    this.rejectPending(
      (pending) => pending.generation === session.generation,
      error,
    );
    if (this.session?.generation === session.generation && this.state !== "closed") {
      this.state = "failed";
    }
    killProcess(session.child);
  }

  private containedPath(pathValue: string): string {
    if (typeof pathValue !== "string" || !pathValue.trim() || pathValue.includes("\0")) {
      throw new LspClientError("path_outside_workspace", "LSP document path is invalid.");
    }
    const requested = isAbsolute(pathValue)
      ? resolve(pathValue)
      : resolve(this.workspaceRoot, pathValue);
    const canonical = canonicalTarget(requested);
    if (!contained(this.workspaceRoot, canonical)) {
      throw new LspClientError(
        "path_outside_workspace",
        `LSP document path escapes the workspace: ${boundedText(pathValue, 256)}.`,
      );
    }
    return canonical;
  }

  private requireRunningSession(): ProcessSession {
    const session = this.session;
    if (!session || !session.initialized || this.state !== "running" || session.failure) {
      throw session?.failure ?? new LspClientError(
        "process_exited",
        "Language server is not running.",
        true,
      );
    }
    return session;
  }

  private assertNotClosed(): void {
    if (this.state === "closed" || this.state === "closing") {
      throw new LspClientError("client_closed", "LSP client is closed.");
    }
  }
}

function parseContentLength(header: string): number {
  const values: string[] = [];
  for (const line of header.split("\r\n")) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      throw new LspClientError(
        "protocol_error",
        "Language server emitted a malformed frame header.",
        true,
      );
    }
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (name === "content-length") values.push(value);
  }
  if (values.length !== 1 || !/^(0|[1-9]\d*)$/.test(values[0] ?? "")) {
    throw new LspClientError(
      "protocol_error",
      "Language server frame requires one valid Content-Length header.",
      true,
    );
  }
  const length = Number(values[0]);
  if (!Number.isSafeInteger(length)) {
    throw new LspClientError(
      "frame_too_large",
      "Language server frame length is not a safe integer.",
      true,
    );
  }
  return length;
}

function validateDocumentInput(input: LspDocumentInput): void {
  validateDocumentVersion(input.version);
  if (typeof input.languageId !== "string" ||
      !/^[a-z0-9][a-z0-9+_.-]{0,63}$/i.test(input.languageId)) {
    throw new LspClientError("protocol_error", "LSP language id is invalid.");
  }
  if (typeof input.text !== "string") {
    throw new LspClientError("protocol_error", "LSP document text must be a string.");
  }
}

function validateDocumentVersion(version: number): void {
  if (!Number.isSafeInteger(version) || version < 0) {
    throw new LspClientError(
      "stale_document_version",
      "LSP document version must be a non-negative safe integer.",
    );
  }
}

function positiveInteger(value: number, name: string): number {
  return boundedInteger(value, name, 1, Number.MAX_SAFE_INTEGER);
}

function boundedInteger(
  value: number,
  name: string,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw configurationError(`${name} must be an integer from ${minimum} to ${maximum}.`);
  }
  return value;
}

function configurationError(message: string): LspClientError {
  return new LspClientError("invalid_configuration", message);
}

function waitForSpawn(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolvePromise, rejectPromise) => {
    const onSpawn = () => {
      cleanup();
      resolvePromise();
    };
    const onError = (error: Error) => {
      cleanup();
      rejectPromise(error);
    };
    const cleanup = () => {
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
    };
    child.once("spawn", onSpawn);
    child.once("error", onError);
  });
}

function killProcess(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals = "SIGTERM",
): void {
  if (child.exitCode === null && child.signalCode === null) {
    try {
      child.kill(signal);
    } catch {}
  }
}

async function waitForProcessExit(
  session: ProcessSession,
  timeoutMs: number,
): Promise<boolean> {
  if (session.child.exitCode !== null || session.child.signalCode !== null) return true;
  return await Promise.race([
    session.exited.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function canonicalTarget(target: string): string {
  let current = target;
  const missing: string[] = [];
  while (true) {
    try {
      lstatSync(current);
      return resolve(realpathSync(current), ...missing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      missing.unshift(basename(current));
      current = parent;
    }
  }
}

function contained(root: string, candidate: string): boolean {
  const relation = relative(root, candidate);
  return relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation));
}

function displayPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function boundedAppend(current: Buffer, next: Buffer, maximum: number): Buffer {
  if (next.byteLength >= maximum) return next.subarray(next.byteLength - maximum);
  const combined = Buffer.concat([current, next]);
  return combined.byteLength <= maximum
    ? combined
    : combined.subarray(combined.byteLength - maximum);
}

function boundedMessage(error: unknown): string {
  return boundedText(error instanceof Error ? error.message : String(error), 512);
}

function boundedText(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}…`;
}

function asLspError(
  error: unknown,
  fallback: LspClientErrorCode,
  retryable: boolean,
): LspClientError {
  return error instanceof LspClientError
    ? error
    : new LspClientError(
        fallback,
        boundedMessage(error),
        retryable,
        { cause: error },
      );
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}
