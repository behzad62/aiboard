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
import type { BuildControlPlane } from "./build-runtime-registry.js";
import type { ProjectHandoffChoice } from "./scheduler-store.js";
import type { NativeBuildSpec } from "./build-spec.js";
import { assertBudgetLimits } from "./budget-policy.js";
import { checkGit, type GitPreflightResult } from "./git-preflight.js";
import type {
  ProviderConfigStore,
  RunnerProviderConfig,
} from "./provider-config-store.js";
import type { RunSupervisor } from "./run-supervisor.js";
import type { McpManager } from "./mcp-tools.js";
import type { SqlitePermissionStore } from "./permission-store.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface ControlServerOptions {
  supervisor: RunSupervisor;
  token: string;
  checkGit?: () => Promise<GitPreflightResult>;
  bootstrapRun: (input: RunBootstrapInput) => Promise<RunBootstrapResult>;
  heartbeatMs?: number;
  builds?: BuildControlPlane;
  buildProvisioner?: { create(spec: NativeBuildSpec): Promise<unknown> };
  providerConfigs?: ProviderConfigStore;
  runnerInfo?: { projectPath: string; nodeVersion: string };
  mcp?: Pick<McpManager, "status">;
  permissions?: SqlitePermissionStore;
}

export interface RunBootstrapInput {
  runId: string;
  projectPath: string;
  permissionProfile: PermissionProfile;
  idempotencyKey: string;
}

export interface RunBootstrapResult {
  baselineRevision: string;
  baselineRef: string;
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
  build?: {
    projectId: string;
    objective: string;
    architectRuntimeId: string;
    workerRuntimeIds: string[];
    maxConcurrency: number;
    budgetLimits: NativeBuildSpec["budgetLimits"];
  };
}

interface ProviderConfigsBody {
  configs: RunnerProviderConfig[];
}

interface CommandBody {
  command: RunCommand;
  idempotencyKey: string;
  reason?: string;
}

interface RunBuildBody {
  maxSteps?: number;
}

interface ArchitectHandoffBody {
  runtimeId: string;
  idempotencyKey: string;
}

interface ProjectHandoffBody {
  choice: ProjectHandoffChoice;
  idempotencyKey: string;
}

interface PermissionDecisionBody {
  decision: "approved" | "denied";
  idempotencyKey: string;
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
  private readonly bootstrapRun: ControlServerOptions["bootstrapRun"];
  private readonly heartbeatMs: number;
  private readonly builds?: BuildControlPlane;
  private readonly buildProvisioner?: ControlServerOptions["buildProvisioner"];
  private readonly providerConfigs?: ProviderConfigStore;
  private readonly runnerInfo?: ControlServerOptions["runnerInfo"];
  private readonly mcp?: ControlServerOptions["mcp"];
  private readonly permissions?: SqlitePermissionStore;
  private readonly streams = new Set<ServerResponse>();
  private server: Server | undefined;

  constructor(options: ControlServerOptions) {
    if (!options.token) throw new Error("Control server token is required.");
    this.supervisor = options.supervisor;
    this.token = options.token;
    this.gitPreflight = options.checkGit ?? (() => checkGit());
    this.bootstrapRun = options.bootstrapRun;
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.builds = options.builds;
    this.buildProvisioner = options.buildProvisioner;
    this.providerConfigs = options.providerConfigs;
    this.runnerInfo = options.runnerInfo;
    this.mcp = options.mcp;
    this.permissions = options.permissions;
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
    try {
      setCommonHeaders(request, response);
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.end();
        return;
      }
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
    if (segments.length === 2 && segments[1] === "health" && request.method === "GET") {
      if (!this.runnerInfo) {
        throw new HttpError(503, "runner_info_unavailable", "Runner information is unavailable.");
      }
      sendJson(response, 200, {
        ok: true,
        protocolVersion: 2,
        projectPath: this.runnerInfo.projectPath,
        nodeVersion: this.runnerInfo.nodeVersion,
        mcpServers: this.mcp?.status().length ?? 0,
      });
      return;
    }
    if (segments.length === 2 && segments[1] === "mcp" && request.method === "GET") {
      sendJson(response, 200, { servers: this.mcp?.status() ?? [] });
      return;
    }
    if (segments.length === 2 && segments[1] === "permissions" && request.method === "GET") {
      sendJson(response, 200, {
        permissions: this.permissions?.list(url.searchParams.get("runId") ?? undefined) ?? [],
      });
      return;
    }
    if (
      segments.length === 3 &&
      segments[1] === "permissions" &&
      request.method === "POST"
    ) {
      if (!this.permissions) {
        throw new HttpError(503, "permission_store_unavailable", "Permission store is unavailable.");
      }
      const body = await readJson<PermissionDecisionBody>(request);
      if (
        (body.decision !== "approved" && body.decision !== "denied") ||
        !isNonEmptyString(body.idempotencyKey)
      ) invalidBody();
      sendJson(response, 200, this.permissions.decide({
        requestId: segments[2],
        decision: body.decision,
        idempotencyKey: body.idempotencyKey,
        occurredAt: new Date().toISOString(),
      }));
      return;
    }
    if (segments.length === 2 && segments[1] === "provider-configs") {
      const store = this.requireProviderConfigs();
      if (request.method === "GET") {
        sendJson(response, 200, store.load().map(redactProviderConfig));
        return;
      }
      if (request.method === "PUT") {
        const body = await readJson<ProviderConfigsBody>(request);
        if (!Array.isArray(body.configs)) invalidBody();
        const merged = mergeProviderConfigs(store.load(), body.configs);
        store.save(merged);
        sendJson(response, 200, merged.map(redactProviderConfig));
        return;
      }
    }
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
        let projection = this.supervisor.createRun(body);
        if (!projection.baselineRevision) {
          try {
            const baseline = await this.bootstrapRun(body);
            projection = this.supervisor.captureBaseline(
              body.runId,
              `baseline:${body.idempotencyKey}`,
              baseline.baselineRevision,
              baseline.baselineRef
            );
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : "Git bootstrap failed.";
            this.supervisor.fail(
              body.runId,
              `bootstrap-failed:${body.idempotencyKey}`,
              reason
            );
            throw error;
          }
        }
        if (body.build) {
          if (!this.buildProvisioner) {
            throw new HttpError(503, "native_build_unavailable", "Native Build provisioning is unavailable.");
          }
          assertBuildBody(body.build);
          await this.buildProvisioner.create({
            version: 1,
            runId: body.runId,
            projectId: body.build.projectId,
            objective: body.build.objective,
            architectRuntimeId: body.build.architectRuntimeId,
            workerRuntimeIds: [...body.build.workerRuntimeIds],
            maxConcurrency: body.build.maxConcurrency,
            permissionProfile: body.permissionProfile,
            budgetLimits: { ...body.build.budgetLimits },
            createdAt: projection.createdAt,
            idempotencyKey: `build:${body.idempotencyKey}`,
          });
        }
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
        segments[3] === "build" &&
        request.method === "GET"
      ) {
        sendJson(response, 200, this.requireBuilds().projection(runId));
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "usage" &&
        request.method === "GET"
      ) {
        sendJson(response, 200, this.requireBuilds().usage(runId));
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "observability" &&
        request.method === "GET"
      ) {
        sendJson(
          response,
          200,
          await this.requireBuilds().observability(runId)
        );
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "audit" &&
        request.method === "GET"
      ) {
        const builds = this.requireBuilds();
        const observability = await builds.observability(runId);
        sendJson(response, 200, {
          protocolVersion: 2,
          run: this.supervisor.getRun(runId),
          build: builds.projection(runId),
          usage: builds.usage(runId),
          observability,
          runEvents: this.supervisor.events(runId),
          buildEvents: builds.events(runId),
        });
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "architect-handoff" &&
        request.method === "POST"
      ) {
        const body = await readJson<ArchitectHandoffBody>(request);
        if (
          !isNonEmptyString(body.runtimeId) ||
          !isNonEmptyString(body.idempotencyKey)
        ) invalidBody();
        sendJson(
          response,
          200,
          this.requireBuilds().selectArchitectHandoff(
            runId,
            body.runtimeId,
            body.idempotencyKey
          )
        );
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "project-handoff" &&
        request.method === "POST"
      ) {
        const body = await readJson<ProjectHandoffBody>(request);
        if (
          (body.choice !== "keep_integration_branch" &&
            body.choice !== "apply_to_project") ||
          !isNonEmptyString(body.idempotencyKey)
        ) invalidBody();
        const projection = await this.requireBuilds().selectProjectHandoff(
          runId,
          body.choice,
          body.idempotencyKey
        );
        if (projection.status !== "completed") {
          throw new Error("Final project handoff did not complete the Build.");
        }
        this.syncBuildLifecycle(runId, "completed");
        sendJson(response, 200, projection);
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "tasks" &&
        request.method === "GET"
      ) {
        const projection = this.requireBuilds().projection(runId);
        sendJson(response, 200, Object.values(projection.tasks));
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "guidance" &&
        request.method === "GET"
      ) {
        const projection = this.requireBuilds().projection(runId);
        sendJson(response, 200, Object.values(projection.guidance));
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "events" &&
        request.method === "GET"
      ) {
        sendJson(
          response,
          200,
          this.requireBuilds().events(runId, readAfterSequence(url))
        );
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "stream" &&
        request.method === "GET"
      ) {
        this.openBuildEventStream(response, request, runId, readAfterSequence(url));
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "step" &&
        request.method === "POST"
      ) {
        await readJson<Record<string, never>>(request);
        const result = await this.requireBuilds().step(runId);
        this.syncBuildLifecycle(runId, result.status);
        sendJson(response, 200, result);
        return;
      }
      if (
        segments.length === 5 &&
        segments[3] === "build" &&
        segments[4] === "run" &&
        request.method === "POST"
      ) {
        const body = await readJson<RunBuildBody>(request);
        if (
          body.maxSteps !== undefined &&
          (!Number.isSafeInteger(body.maxSteps) || body.maxSteps < 1)
        ) invalidBody();
        const result = await this.requireBuilds().runUntilBlocked(runId, body.maxSteps);
        this.syncBuildLifecycle(runId, result.status);
        sendJson(response, 200, result);
        return;
      }
      if (
        segments.length === 4 &&
        segments[3] === "commands" &&
        request.method === "POST"
      ) {
        const body = await readJson<CommandBody>(request);
        assertCommandBody(body);
        sendJson(response, 200, await this.applyCommand(runId, body));
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

  private requireProviderConfigs(): ProviderConfigStore {
    if (!this.providerConfigs) {
      throw new HttpError(503, "provider_config_unavailable", "Provider configuration is unavailable.");
    }
    return this.providerConfigs;
  }

  private requireBuilds(): BuildControlPlane {
    if (!this.builds) {
      throw new HttpError(
        404,
        "build_runtime_not_found",
        "No native Build runtime is registered."
      );
    }
    return this.builds;
  }

  private syncBuildLifecycle(
    runId: string,
    status: "progressed" | "paused" | "completed" | "idle"
  ): void {
    let run;
    try {
      run = this.supervisor.getRun(runId);
    } catch (error) {
      if (error instanceof Error && /^Unknown run /.test(error.message)) return;
      throw error;
    }
    if (status === "completed" && !["completed", "failed", "stopped"].includes(run.state)) {
      this.supervisor.complete(runId, `native-build-completed:${run.lastSequence}`);
    } else if (status === "paused" && run.state === "running") {
      this.supervisor.pause(runId, `native-build-paused:${run.lastSequence}`, "native-build");
    }
  }

  private async applyCommand(runId: string, body: CommandBody) {
    const projection = (() => {
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
    })();
    if (this.builds) {
      try {
        this.builds.projection(runId);
        if (body.command === "start" || body.command === "resume") {
          this.builds.resume(runId, `build:${body.idempotencyKey}`);
          this.builds.activate(runId);
        } else {
          this.builds.pause(
            runId,
            body.reason ?? "user",
            `build:${body.idempotencyKey}`
          );
        }
      } catch (error) {
        if (!(error instanceof Error) || !/^Unknown build runtime /.test(error.message)) {
          throw error;
        }
      }
    }
    return projection;
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

  private openBuildEventStream(
    response: ServerResponse,
    request: IncomingMessage,
    runId: string,
    afterSequence: number
  ): void {
    const builds = this.requireBuilds();
    builds.projection(runId);
    response.statusCode = 200;
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Connection", "keep-alive");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();
    this.streams.add(response);

    let cursor = afterSequence;
    const replay = () => {
      for (const event of builds.events(runId, cursor)) {
        if (event.sequence <= cursor) continue;
        cursor = event.sequence;
        response.write(`id: ${event.sequence}\n`);
        response.write(`event: ${event.type}\n`);
        response.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    };
    replay();
    const poll = setInterval(replay, 250);
    poll.unref();
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), this.heartbeatMs);
    heartbeat.unref();
    const cleanup = () => {
      clearInterval(poll);
      clearInterval(heartbeat);
      this.streams.delete(response);
    };
    request.once("close", cleanup);
    response.once("close", cleanup);
  }
}

function mergeProviderConfigs(
  current: readonly RunnerProviderConfig[],
  incoming: readonly RunnerProviderConfig[]
): RunnerProviderConfig[] {
  const merged = new Map(
    current.map((config) => [config.runtimeId, {
      ...config,
      capabilities: [...config.capabilities],
      ...(config.inputCapabilities
        ? { inputCapabilities: { ...config.inputCapabilities } }
        : {}),
    }])
  );
  for (const config of incoming) {
    merged.set(config.runtimeId, {
      ...config,
      capabilities: [...config.capabilities],
      ...(config.inputCapabilities
        ? { inputCapabilities: { ...config.inputCapabilities } }
        : {}),
    });
  }
  return [...merged.values()].sort((left, right) =>
    left.runtimeId.localeCompare(right.runtimeId)
  );
}

function hasBearerToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const actual = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return actual.length === wanted.length && timingSafeEqual(actual, wanted);
}

function setCommonHeaders(
  request: IncomingMessage,
  response: ServerResponse
): void {
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  const origin = request.headers.origin;
  if (origin) {
    if (!isLoopbackOrigin(origin)) {
      throw new HttpError(403, "origin_not_allowed", "Runner V2 accepts browser requests only from loopback origins.");
    }
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Vary", "Origin");
  }
  response.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return (
      (url.protocol === "http:" || url.protocol === "https:") &&
      ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) &&
      url.pathname === "/" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
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

function assertBuildBody(body: NonNullable<CreateRunBody["build"]>): void {
  if (!body || typeof body !== "object") invalidBody();
  if (!isNonEmptyString(body.projectId)) invalidBody();
  if (!isNonEmptyString(body.objective)) invalidBody();
  if (!isNonEmptyString(body.architectRuntimeId)) invalidBody();
  if (
    !Array.isArray(body.workerRuntimeIds) ||
    body.workerRuntimeIds.length < 1 ||
    body.workerRuntimeIds.some((runtimeId) => !isNonEmptyString(runtimeId))
  ) invalidBody();
  if (!Number.isSafeInteger(body.maxConcurrency) || body.maxConcurrency < 1) {
    invalidBody();
  }
  try {
    assertBudgetLimits(body.budgetLimits);
  } catch {
    invalidBody();
  }
}

function redactProviderConfig(config: RunnerProviderConfig) {
  return {
    runtimeId: config.runtimeId,
    providerId: config.providerId,
    modelId: config.modelId,
    transport: config.transport,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    capabilities: [...config.capabilities],
    ...(config.inputCapabilities
      ? { inputCapabilities: { ...config.inputCapabilities } }
      : {}),
    priority: config.priority,
    ...(config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {}),
    ...(config.protocol ? { protocol: config.protocol } : {}),
    configured: true,
  };
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
  if (/^Unknown build runtime /.test(message)) {
    return new HttpError(404, "build_runtime_not_found", message);
  }
  if (/cannot accept|must be the first|Expected event sequence/i.test(message)) {
    return new HttpError(409, "invalid_transition", message);
  }
  return new HttpError(500, "internal_error", "The runner could not complete the request.");
}
