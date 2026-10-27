import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { get } from "node:http";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import type { LauncherIdentity, LauncherInstance } from "./launcher-instance.js";

/** The inherited Node IPC pipe carries secrets; neither argv nor the environment carries them. */
export interface LauncherHandshake {
  type: "aiboard-launcher-init";
  token: string;
  controlKey: string;
  instanceId: string;
  identity: LauncherIdentity;
  stateDirectory: string;
  version: string;
  legacyToken?: string;
}

type ControlAction = "status" | "stop";
interface ControlRequest {
  action: ControlAction;
  nonce: string;
  sentAt: number;
  instance: LauncherInstance;
  mac: string;
}
interface ControlResponse {
  nonce: string;
  healthy: boolean;
  instance: LauncherInstance;
  mac: string;
}

const MAX_MESSAGE_BYTES = 16_384;
const REQUEST_WINDOW_MS = 30_000;

export async function receiveLauncherHandshake(): Promise<LauncherHandshake> {
  if (!process.send || !process.connected) throw new Error("launcher_ipc_unavailable: An inherited launcher channel is required.");
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("launcher_ipc_unavailable: Launcher handshake timed out.")), 10_000);
    const onDisconnect = () => finish(new Error("launcher_ipc_unavailable: Launcher disconnected."));
    const onMessage = (value: unknown) => {
      if (!isHandshake(value)) return finish(new Error("launcher_ipc_invalid: Invalid launcher handshake."));
      finish(undefined, value);
    };
    function finish(error?: Error, value?: LauncherHandshake): void {
      clearTimeout(timer);
      process.off("message", onMessage);
      process.off("disconnect", onDisconnect);
      if (error) reject(error);
      else if (value) resolve(value);
    }
    process.once("message", onMessage);
    process.once("disconnect", onDisconnect);
    process.send?.({ type: "aiboard-launcher-awaiting-init" }, (error) => {
      if (error) finish(new Error("launcher_ipc_unavailable: Cannot notify the launcher."));
    });
  });
}

function isHandshake(value: unknown): value is LauncherHandshake {
  if (!isObject(value) || !isObject(value.identity)) return false;
  return value.type === "aiboard-launcher-init" && typeof value.token === "string" && /^[0-9a-f]{64}$/.test(value.token) &&
    typeof value.controlKey === "string" && /^[0-9a-f]{64}$/.test(value.controlKey) &&
    typeof value.instanceId === "string" && /^[0-9a-f]{32}$/.test(value.instanceId) &&
    typeof value.identity.projectPath === "string" && typeof value.identity.projectKey === "string" &&
    typeof value.identity.owner === "string" && typeof value.stateDirectory === "string" &&
    typeof value.version === "string" && (value.legacyToken === undefined || typeof value.legacyToken === "string");
}

/** The control key is independent of the browser session token and is never sent over this socket. */
export async function startLauncherControl(options: {
  identity: LauncherIdentity;
  instanceId: string;
  version: string;
  startedAt: number;
  port: number;
  token: string;
  controlKey: Buffer;
  shutdown: () => void;
}): Promise<{ instance: LauncherInstance; close: () => Promise<void> }> {
  const usedNonces = new Map<string, number>();
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setTimeout(5_000, () => socket.destroy());
    void readLine(socket).then(async (line) => {
      const value: unknown = JSON.parse(line);
      if (!isControlRequest(value) || !sameInstance(value.instance, instance) ||
          Math.abs(Date.now() - value.sentAt) > REQUEST_WINDOW_MS ||
          !validMac(options.controlKey, requestBody(value), value.mac)) throw new Error("invalid control request");
      const now = Date.now();
      for (const [nonce, expiry] of usedNonces) if (expiry < now) usedNonces.delete(nonce);
      if (usedNonces.has(value.nonce) || usedNonces.size >= 2048) throw new Error("replayed control request");
      usedNonces.set(value.nonce, now + REQUEST_WINDOW_MS * 2);
      const healthy = value.action === "status" ? await runnerHealth(options.port, options.token, options.identity.projectPath) : true;
      const response: ControlResponse = { nonce: value.nonce, healthy, instance, mac: "" };
      response.mac = sign(options.controlKey, responseBody(response));
      if (value.action === "stop") socket.once("close", options.shutdown);
      socket.end(`${JSON.stringify(response)}\n`);
    }).catch(() => socket.destroy());
  });
  server.maxConnections = 32;
  await listen(server);
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("launcher_ipc_unavailable: Invalid control address."); }
  const instance: LauncherInstance = {
    schemaVersion: 1,
    ...options.identity,
    pid: process.pid,
    startedAt: options.startedAt,
    port: options.port,
    controlPort: address.port,
    instanceId: options.instanceId,
    version: options.version,
  };
  return {
    instance,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      try { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
      finally { options.controlKey.fill(0); }
    },
  };
}

export async function requestLauncherControl(instance: LauncherInstance, key: Buffer, action: ControlAction): Promise<{ healthy: boolean }> {
  const request: ControlRequest = { action, nonce: randomBytes(32).toString("hex"), sentAt: Date.now(), instance, mac: "" };
  request.mac = sign(key, requestBody(request));
  const socket = createConnection({ host: "127.0.0.1", port: instance.controlPort });
  socket.on("error", () => socket.destroy());
  socket.setTimeout(5_000, () => socket.destroy(new Error("launcher control timed out")));
  try {
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    const value: unknown = JSON.parse(await readLine(socket));
    if (!isControlResponse(value) || value.nonce !== request.nonce || !sameInstance(value.instance, instance) ||
        !validMac(key, responseBody(value), value.mac)) throw new Error("instance_unverified: The Runner did not prove its identity.");
    return { healthy: value.healthy };
  } finally { socket.destroy(); }
}

function runnerHealth(port: number, token: string, projectPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: boolean) => { if (!settled) { settled = true; resolve(result); } };
    const request = get({ hostname: "127.0.0.1", port, path: "/v2/health", headers: { Authorization: `Bearer ${token}` }, timeout: 2_000 }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => { body += chunk; if (body.length > MAX_MESSAGE_BYTES) request.destroy(); });
      response.once("end", () => {
        try {
          const value: unknown = JSON.parse(body);
          finish(response.statusCode === 200 && isObject(value) && value.ok === true && value.projectPath === projectPath);
        } catch { finish(false); }
      });
      response.once("error", () => finish(false));
    });
    request.once("timeout", () => request.destroy());
    request.once("error", () => finish(false));
  });
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
}

function readLine(socket: Socket): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    socket.setEncoding("utf8");
    const onData = (chunk: string) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) return finish(new Error("control message too large"));
      const newline = data.indexOf("\n");
      if (newline !== -1) finish(undefined, data.slice(0, newline));
    };
    const onError = (error: Error) => finish(error);
    const onEnd = () => finish(new Error("control connection closed"));
    function finish(error?: Error, line?: string): void {
      socket.off("data", onData); socket.off("error", onError); socket.off("end", onEnd);
      if (error) reject(error); else if (line !== undefined) resolve(line);
    }
    socket.on("data", onData); socket.once("error", onError); socket.once("end", onEnd);
  });
}

function requestBody(request: ControlRequest): string { return JSON.stringify(["request", request.action, request.nonce, request.sentAt, instanceFields(request.instance)]); }
function responseBody(response: ControlResponse): string { return JSON.stringify(["response", response.nonce, response.healthy, instanceFields(response.instance)]); }
function instanceFields(value: LauncherInstance): unknown[] {
  return [value.schemaVersion, value.projectPath, value.projectKey, value.owner, value.pid, value.startedAt, value.port, value.controlPort, value.instanceId, value.version];
}
function sameInstance(left: LauncherInstance, right: LauncherInstance): boolean { return JSON.stringify(instanceFields(left)) === JSON.stringify(instanceFields(right)); }
function sign(key: Buffer, body: string): string { return createHmac("sha256", key).update(body).digest("hex"); }
function validMac(key: Buffer, body: string, mac: string): boolean {
  if (!/^[0-9a-f]{64}$/.test(mac)) return false;
  return timingSafeEqual(Buffer.from(sign(key, body), "hex"), Buffer.from(mac, "hex"));
}
function isControlRequest(value: unknown): value is ControlRequest {
  return isObject(value) && (value.action === "status" || value.action === "stop") && typeof value.nonce === "string" &&
    /^[0-9a-f]{64}$/.test(value.nonce) && Number.isSafeInteger(value.sentAt) && isObject(value.instance) && typeof value.mac === "string";
}
function isControlResponse(value: unknown): value is ControlResponse {
  return isObject(value) && typeof value.nonce === "string" && typeof value.healthy === "boolean" && isObject(value.instance) && typeof value.mac === "string";
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
