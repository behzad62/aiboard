import { timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";

import type {
  PermissionProfile,
  RunCommand,
  RunEvent,
} from "./contracts.js";
import { checkGit, type GitPreflightResult } from "./git-preflight.js";
import type { RunSupervisor } from "./run-supervisor.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface ControlServerOptions {
  supervisor: RunSupervisor;
  token: string;
  checkGit?: () => Promise<GitPreflightResult>;
  heartbeatMs?: number;
}

export interface ControlServerAddress {
  host: "127.0.0.1";
  port: number;
  url: string;
}

interface CreateRunBody {
  runId: string;
  projectPath: string;
  permissionProfile: PermissionProfile;
  idempotencyKey: string;
}

interface CommandBody {
  command: RunCommand;
  idempotencyKey: string;
  reason?: string;
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string
  ) {
    super(message);
  }
}

export class ControlServer {
  private readonly supervisor: RunSupervisor;
  private readonly token: string;
  private readonly gitPreflight: () => Promise<GitPreflightResult>;
  private readonly heartbeatMs: number;
  private readonly streams = new Set<ServerResponse>();
  private server: Server | undefined;

  constructor(options: ControlServerOptions) {
    if (!options.token) throw new Error("Control server token is required.");
    this.supervisor = options.supervisor;
    this.token = options.token;
    this.gitPreflight = options.checkGit ?? (() => checkGit());
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
  }

  async start(port = 0): Promise<ControlServerAddress> {
    if (this.server) throw new Error("Control server is already running.");
    if (!Number.isInteger(port) || port < 0 || port > 65_535) {
      throw new Error("Control server port must be between 0 and 65535.");
    }
    const server = createServer((request, response) => {
      void this.handle(request, response);
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Control server did not expose a TCP address.");
    }
    return {
      host: "127.0.0.1",
      port: address.port,
      url: `http://127.0.0.1:${address.port}`,
    };
  }

  async close(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    for (const stream of this.streams) stream.end();
    this.streams.clear();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
      server.closeAllConnections();
    });
  }

  private async handle(
    request: IncomingMessage,
    response: ServerResponse
  ): Promise<void> {
    setCommonHeaders(response);
    try {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (!url.pathname.startsWith("/v2")) {
        throw new HttpError(404, "not_found", "Route not found.");
      }
      if (!hasBearerToken(request.headers.authorization, this.token)) {
        response.setHeader("WWW-Authenticate", "Bearer");
        throw new HttpError(401, "unauthorized", "A valid runner token is required.");
      }
      await this.route(request, response, url);
    } catch (error) {
      if (response.headersSent) {
        if (!response.writableEnded) response.end();
        return;
      }
      const httpError = toHttpError(error);
      sendJson(response, httpError.status, {
        error: httpError.message,
        code: httpError.code,
      });
    }
  }

  private async route(
    request: IncomingMessage,
    response: ServerResponse,
    url: URL
  ): Promise<void> {
    const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
    if (segments.length === 2 && segments[1] === "runs") {
      if (request.method === "GET") {
        sendJson(response, 200, this.supervisor.listRuns());
        return;
      }
      if (request.method === "POST") {
        const body = await readJson<CreateRunBody>(request);
        assertCreateRunBody(body);
        const git = await this.gitPreflight();
        if (!git.available) {
          throw new HttpError(412, git.code, git.reason);
        }
        const projection = this.supervisor.createRun(body);
        sendJson(response, 201, projection);
        return;
      }
    }

    if (segments.length >= 3 && segments[1] === "runs") {
      const runId = segments[2];
      if (segments.length === 3 && request.method === "GET") {
        sendJson(response, 200, this.supervisor.getRun(runId));
        return;
      }
      if (
        segments.length === 4 &&
        segments[3] === "commands" &&
        request.method === "POST"
      ) {
        const body = await readJson<CommandBody>(request);
        assertCommandBody(body);
        sendJson(response, 200, this.applyCommand(runId, body));
        return;
      }
      if (
        segments.length === 4 &&
        segments[3] === "events" &&
        request.method === "GET"
      ) {
        sendJson(
          response,
          200,
          this.supervisor.events(runId, readAfterSequence(url))
        );
        return;
      }
      if (
        segments.length === 4 &&
        segments[3] === "stream" &&
        request.method === "GET"
      ) {
        this.openEventStream(response, request, runId, readAfterSequence(url));
        return;
      }
    }
    throw new HttpError(404, "not_found", "Route not found.");
  }

  private applyCommand(runId: string, body: CommandBody) {
    switch (body.command) {
      case "start":
        return this.supervisor.start(runId, body.idempotencyKey);
      case "pause":
        return this.supervisor.pause(
          runId,
          body.idempotencyKey,
          body.reason ?? "user"
        );
      case "resume":
        return this.supervisor.resume(runId, body.idempotencyKey);
      case "stop":
        return this.supervisor.requestStop(
          runId,
          body.idempotencyKey,
          body.reason ?? "user"
        );
    }
  }

  private openEventStream(
    response: ServerResponse,
    request: IncomingMessage,
    runId: string,
    afterSequence: number
  ): void {
    this.supervisor.getRun(runId);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    this.streams.add(response);

    let cursor = afterSequence;
    const writeEvent = (event: RunEvent) => {
      if (event.runId !== runId || event.sequence <= cursor) return;
      cursor = event.sequence;
      response.write(`id: ${event.sequence}\n`);
      response.write(`event: ${event.type}\n`);
      response.write(`data: ${JSON.stringify(event)}\n\n`);
    };
    for (const event of this.supervisor.events(runId, cursor)) writeEvent(event);
    const unsubscribe = this.supervisor.subscribe(writeEvent);
    const heartbeat = setInterval(() => {
      response.write(": heartbeat\n\n");
    }, this.heartbeatMs);
    heartbeat.unref();

    const cleanup = () => {
      clearInterval(heartbeat);
      unsubscribe();
      this.streams.delete(response);
    };
    request.once("close", cleanup);
    response.once("close", cleanup);
  }
}

function hasBearerToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function setCommonHeaders(response: ServerResponse): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.end(JSON.stringify(value));
}

async function readJson<T>(request: IncomingMessage): Promise<T> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
    request.resume();
    throw new HttpError(413, "body_too_large", "Request body exceeds 1 MiB.");
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > MAX_BODY_BYTES) {
      tooLarge = true;
      continue;
    }
    chunks.push(bytes);
  }
  if (tooLarge) {
    throw new HttpError(413, "body_too_large", "Request body exceeds 1 MiB.");
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
  } catch {
    throw new HttpError(400, "invalid_json", "Request body must be valid JSON.");
  }
}

function assertCreateRunBody(body: CreateRunBody): void {
  if (!body || typeof body !== "object") invalidBody();
  if (!isNonEmptyString(body.runId)) invalidBody();
  if (!isNonEmptyString(body.projectPath)) invalidBody();
  if (!isNonEmptyString(body.idempotencyKey)) invalidBody();
  if (!(["guarded", "project", "full"] as unknown[]).includes(body.permissionProfile)) {
    invalidBody();
  }
}

function assertCommandBody(body: CommandBody): void {
  if (!body || typeof body !== "object") invalidBody();
  if (!isNonEmptyString(body.idempotencyKey)) invalidBody();
  if (!(["start", "pause", "resume", "stop"] as unknown[]).includes(body.command)) {
    invalidBody();
  }
  if (body.reason !== undefined && typeof body.reason !== "string") invalidBody();
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function invalidBody(): never {
  throw new HttpError(400, "invalid_request", "Request body is invalid.");
}

function readAfterSequence(url: URL): number {
  const raw = url.searchParams.get("after") ?? "0";
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new HttpError(400, "invalid_after", "after must be a non-negative integer.");
  }
  return value;
}

function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error;
  const message = error instanceof Error ? error.message : "Unknown error.";
  if (/^Unknown run /.test(message)) return new HttpError(404, "run_not_found", message);
  if (/cannot accept|must be the first|Expected event sequence/i.test(message)) {
    return new HttpError(409, "invalid_transition", message);
  }
  return new HttpError(500, "internal_error", "The runner could not complete the request.");
}
