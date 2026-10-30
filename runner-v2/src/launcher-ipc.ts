import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { get } from "node:http";
import { createConnection, createServer, type Server, type Socket } from "node:net";

import type { LauncherIdentity, LauncherInstance } from "./launcher-instance.js";
import { isLocalPairPeer, type LocalPairPeer } from "./local-pairing.js";
import { LOCAL_MCP_DEPTH_LIMIT } from "./child-environment.js";
import type { CommandApprovalRequest } from "./remote-approval.js";
import type { RemoteEnableSettings, RemoteEvent, RemoteEventsPage } from "./remote-in-place.js";

/** The inherited Node IPC pipe carries secrets; neither argv nor the environment carries them. */
export interface LauncherHandshake {
  type: "aiboard-launcher-init";
  token: string;
  controlKey: string;
  instanceId: string;
  pairDigest?: string;
  peers?: LocalPairPeer[];
  identity: LauncherIdentity;
  stateDirectory: string;
  version: string;
  legacyToken?: string;
}

type RemoteAction = "remote_enable" | "remote_events" | "remote_disable";
type ControlAction = "status" | "stop" | "pair" | "local_mcp" | "approval_next" | "approval_answer" | RemoteAction;
const CONTROL_ACTIONS: readonly unknown[] = ["status", "stop", "pair", "local_mcp", "approval_next", "approval_answer", "remote_enable", "remote_events", "remote_disable"];
interface ControlRequest {
  action: ControlAction;
  nonce: string;
  sentAt: number;
  pairDigest?: string;
  peers?: LocalPairPeer[];
  depth?: number;
  jobId?: string;
  approvalNonce?: string;
  approved?: boolean;
  deviceDirectory?: string;
  relayUrl?: string;
  relayRootKeys?: string[];
  cursor?: number;
  instance: LauncherInstance;
  mac: string;
}
interface ControlResponse {
  nonce: string;
  healthy: boolean;
  instance: LauncherInstance;
  mac: string;
  sessionToken?: string;
  remoteOnly?: true;
  approval?: CommandApprovalRequest;
  accepted?: boolean;
  remoteActive?: boolean;
  events?: RemoteEvent[];
  cursor?: number;
  error?: string;
}

/** The Runner side of remote_enable / remote_events / remote_disable. */
export interface LauncherRemoteControl {
  active: () => boolean;
  enable: (settings: RemoteEnableSettings) => Promise<void>;
  events: (cursor: number) => RemoteEventsPage;
  disable: () => Promise<void>;
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
    (value.pairDigest === undefined || typeof value.pairDigest === "string" && /^[0-9a-f]{64}$/.test(value.pairDigest)) &&
    typeof value.identity.projectPath === "string" && typeof value.identity.projectKey === "string" &&
    typeof value.identity.owner === "string" && typeof value.stateDirectory === "string" &&
    typeof value.version === "string" && (value.legacyToken === undefined || typeof value.legacyToken === "string") &&
    (value.peers === undefined || (Array.isArray(value.peers) && value.peers.length <= 3 && value.peers.every(isLocalPairPeer)));
}

/** The control key is independent of the browser session token and is never sent over this socket. */
export async function startLauncherControl(options: {
  identity: LauncherIdentity;
  instanceId: string;
  version: string;
  startedAt: number;
  port: number;
  token: string;
  remoteOnly?: boolean;
  controlKey: Buffer;
  shutdown: () => void;
  registerPair?: (digest: string, peers?: LocalPairPeer[]) => void;
  registerLocalMcp?: (depth: number) => { token: string; revoke: () => void };
  nextApproval?: () => CommandApprovalRequest | undefined;
  answerApproval?: (jobId: string, nonce: string, approved: boolean) => boolean;
  remote?: LauncherRemoteControl;
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
      if (value.action === "pair") {
        if (!options.registerPair || !value.pairDigest) throw new Error("pairing unavailable");
        options.registerPair(value.pairDigest, value.peers);
      }
      if (value.action === "local_mcp") {
        if (!options.registerLocalMcp || value.depth === undefined || value.depth >= LOCAL_MCP_DEPTH_LIMIT) throw new Error("local MCP recursion limit");
        const session = options.registerLocalMcp(value.depth);
        socket.once("close", session.revoke);
        if (socket.destroyed) { session.revoke(); return; }
        const response: ControlResponse = { nonce: value.nonce, healthy: true, instance, mac: "", sessionToken: session.token };
        response.mac = sign(options.controlKey, responseBody(response));
        socket.setTimeout(0);
        socket.write(`${JSON.stringify(response)}\n`);
        return;
      }
      if (value.action === "approval_next" || value.action === "approval_answer") {
        if (!options.nextApproval || !options.answerApproval) throw new Error("approval unavailable");
        const response: ControlResponse = { nonce: value.nonce, healthy: true, instance, mac: "",
          ...(value.action === "approval_next" ? { approval: options.nextApproval() } :
            { accepted: options.answerApproval(value.jobId!, value.approvalNonce!, value.approved!) }) };
        response.mac = sign(options.controlKey, responseBody(response));
        socket.end(`${JSON.stringify(response)}\n`);
        return;
      }
      if (value.action === "remote_enable" || value.action === "remote_events" || value.action === "remote_disable") {
        const remote = options.remote;
        if (!remote) throw new Error("remote control unavailable");
        let fields: Partial<ControlResponse>;
        if (value.action === "remote_events") {
          const page = remote.events(value.cursor!);
          fields = { remoteActive: page.active, events: [...page.events], cursor: page.cursor };
        } else {
          // Disabling drains in-flight remote jobs, which can outlast the idle timeout of this authenticated request.
          socket.setTimeout(0);
          let error: string | undefined;
          try {
            if (value.action === "remote_enable") {
              await remote.enable({ deviceDirectory: value.deviceDirectory!, ...(value.relayUrl !== undefined ? { relayUrl: value.relayUrl } : {}),
                relayRootKeys: value.relayRootKeys! });
            } else await remote.disable();
          } catch (failure) { error = controlErrorText(failure); }
          fields = { remoteActive: remote.active(), ...(error !== undefined ? { error } : {}) };
        }
        if (socket.destroyed) return;
        const response: ControlResponse = { nonce: value.nonce, healthy: true, instance, mac: "", ...fields };
        response.mac = sign(options.controlKey, responseBody(response));
        socket.end(`${JSON.stringify(response)}\n`);
        return;
      }
      const healthy = value.action === "status" ? await runnerHealth(options.port, options.token, options.identity.projectPath) : true;
      const response: ControlResponse = { nonce: value.nonce, healthy, instance, mac: "",
        ...(value.action === "status" && options.remoteOnly ? { remoteOnly: true } : {}),
        ...(value.action === "status" && options.remote ? { remoteActive: options.remote.active() } : {}) };
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

export async function requestLauncherControl(instance: LauncherInstance, key: Buffer, action: "status" | "stop" | "pair", pairDigest?: string, peers?: LocalPairPeer[]): Promise<{ healthy: boolean; remoteOnly?: true; remoteActive?: boolean }> {
  if (action === "pair" ? !pairDigest || !/^[0-9a-f]{64}$/.test(pairDigest) : pairDigest !== undefined) {
    throw new Error("Invalid launcher control request.");
  }
  if (peers !== undefined && (action !== "pair" || peers.length > 3 || !peers.every(isLocalPairPeer))) {
    throw new Error("Invalid launcher control request.");
  }
  const request: ControlRequest = { action, nonce: randomBytes(32).toString("hex"), sentAt: Date.now(), instance, mac: "", ...(pairDigest ? { pairDigest } : {}), ...(peers ? { peers } : {}) };
  request.mac = sign(key, requestBody(request));
  const socket = createConnection({ host: "127.0.0.1", port: instance.controlPort });
  socket.on("error", () => socket.destroy());
  socket.setTimeout(5_000, () => socket.destroy(new Error("launcher control timed out")));
  try {
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    const value: unknown = JSON.parse(await readLine(socket));
    if (!isControlResponse(value) || value.nonce !== request.nonce || !sameInstance(value.instance, instance) ||
        !validMac(key, responseBody(value), value.mac)) throw new Error("instance_unverified: The Runner did not prove its identity.");
    return { healthy: value.healthy, ...(value.remoteOnly ? { remoteOnly: true } : {}),
      ...(value.remoteActive !== undefined ? { remoteActive: value.remoteActive } : {}) };
  } finally { socket.destroy(); }
}

export type LauncherRemoteRequest =
  | { action: "remote_enable"; settings: RemoteEnableSettings }
  | { action: "remote_events"; cursor: number }
  | { action: "remote_disable" };

/** Turn Remote on or off inside a running Runner, or poll its Remote events (which renews the in-place lease). */
export async function requestLauncherRemote(instance: LauncherInstance, key: Buffer, remote: LauncherRemoteRequest):
  Promise<{ remoteActive: boolean; events?: RemoteEvent[]; cursor?: number }> {
  const request: ControlRequest = { action: remote.action, nonce: randomBytes(32).toString("hex"), sentAt: Date.now(), instance, mac: "",
    ...(remote.action === "remote_enable" ? { deviceDirectory: remote.settings.deviceDirectory,
      ...(remote.settings.relayUrl !== undefined ? { relayUrl: remote.settings.relayUrl } : {}), relayRootKeys: [...remote.settings.relayRootKeys] } : {}),
    ...(remote.action === "remote_events" ? { cursor: remote.cursor } : {}) };
  if (!isControlRequest(request)) throw new Error("Invalid launcher control request.");
  request.mac = sign(key, requestBody(request));
  const socket = createConnection({ host: "127.0.0.1", port: instance.controlPort });
  socket.on("error", () => socket.destroy());
  // Disabling waits for in-flight remote jobs to drain.
  socket.setTimeout(remote.action === "remote_events" ? 5_000 : 60_000, () => socket.destroy(new Error("launcher control timed out")));
  try {
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    const value: unknown = JSON.parse(await readLine(socket));
    if (!isControlResponse(value) || value.nonce !== request.nonce || !sameInstance(value.instance, instance) ||
      !validMac(key, responseBody(value), value.mac) || !value.healthy || typeof value.remoteActive !== "boolean" ||
      (remote.action === "remote_events") !== (value.events !== undefined)) {
      throw new Error("instance_unverified: The Runner did not prove its identity.");
    }
    if (value.error !== undefined) throw new Error(value.error);
    return { remoteActive: value.remoteActive, ...(value.events ? { events: value.events, cursor: value.cursor! } : {}) };
  } finally { socket.destroy(); }
}

/** Poll or answer over the same per-instance HMAC-keyed launcher control channel. */
export async function requestLauncherApproval(instance: LauncherInstance, key: Buffer,
  answer?: { jobId: string; nonce: string; approved: boolean }): Promise<{ approval?: CommandApprovalRequest; accepted?: boolean }> {
  if (answer && (!/^[A-Za-z0-9._:-]{1,128}$/.test(answer.jobId) ||
    !/^[0-9a-f]{64}$/.test(answer.nonce) || typeof answer.approved !== "boolean")) throw new Error("Invalid approval answer.");
  const request: ControlRequest = { action: answer ? "approval_answer" : "approval_next",
    nonce: randomBytes(32).toString("hex"), sentAt: Date.now(), instance, mac: "",
    ...(answer ? { jobId: answer.jobId, approvalNonce: answer.nonce, approved: answer.approved } : {}) };
  request.mac = sign(key, requestBody(request));
  const socket = createConnection({ host: "127.0.0.1", port: instance.controlPort });
  socket.on("error", () => socket.destroy());
  socket.setTimeout(5_000, () => socket.destroy(new Error("launcher control timed out")));
  try {
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    const value: unknown = JSON.parse(await readLine(socket));
    if (!isControlResponse(value) || value.nonce !== request.nonce || !sameInstance(value.instance, instance) ||
      !validMac(key, responseBody(value), value.mac) || !value.healthy ||
      (answer ? typeof value.accepted !== "boolean" || value.approval !== undefined :
        value.accepted !== undefined || (value.approval !== undefined && !isCommandApprovalRequest(value.approval)))) {
      throw new Error("instance_unverified: The Runner did not prove its identity.");
    }
    return { ...(value.approval ? { approval: value.approval } : {}),
      ...(value.accepted !== undefined ? { accepted: value.accepted } : {}) };
  } finally { socket.destroy(); }
}

function isCommandApprovalRequest(value: unknown): value is CommandApprovalRequest {
  if (!isObject(value) || Object.keys(value).length !== 2 || typeof value.nonce !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.nonce) || !isObject(value.summary)) return false;
  const summary = value.summary;
  const safe = (item: unknown, max: number) => typeof item === "string" && item.length <= max &&
    !/[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]/.test(item);
  return Object.keys(summary).length === 7 && typeof summary.jobId === "string" &&
    /^[A-Za-z0-9._:-]{1,128}$/.test(summary.jobId) && typeof summary.code === "string" && /^[0-9A-F]{6}$/.test(summary.code) &&
    ["process.start", "process.run", "process.write_stdin", "process.signal"].includes(String(summary.toolName)) &&
    safe(summary.executable, 200) && safe(summary.commandLine, 200) &&
    Number.isSafeInteger(summary.argumentCount) && Number(summary.argumentCount) >= 0 &&
    ["inside launch dir", "outside", "not applicable"].includes(String(summary.cwdCategory));
}

/** The authenticated socket remains open for the lifetime of the in-memory session. */
export async function openLauncherMcpSession(instance: LauncherInstance, key: Buffer, depth: number): Promise<{ token: string; closed: Promise<void>; close: () => void }> {
  if (!Number.isSafeInteger(depth) || depth < 0 || depth >= LOCAL_MCP_DEPTH_LIMIT) throw new Error("local_mcp_recursion_limit: MCP nesting limit is 2.");
  const request: ControlRequest = { action: "local_mcp", nonce: randomBytes(32).toString("hex"), sentAt: Date.now(), instance, depth, mac: "" };
  request.mac = sign(key, requestBody(request));
  const socket = createConnection({ host: "127.0.0.1", port: instance.controlPort });
  const closed = new Promise<void>((resolve) => socket.once("close", resolve));
  socket.on("error", () => socket.destroy());
  socket.setTimeout(5_000, () => socket.destroy());
  try {
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    const value: unknown = JSON.parse(await readLine(socket));
    if (!isControlResponse(value) || value.nonce !== request.nonce || !sameInstance(value.instance, instance) ||
        !validMac(key, responseBody(value), value.mac) || !value.healthy ||
        typeof value.sessionToken !== "string" || !/^[0-9a-f]{64}$/.test(value.sessionToken)) throw new Error("instance_unverified: The Runner did not prove its identity.");
    socket.setTimeout(0);
    return { token: value.sessionToken, closed, close: () => socket.destroy() };
  } catch (error) { socket.destroy(); throw error; }
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

function requestBody(request: ControlRequest): string {
  const fields: unknown[] = ["request", request.action, request.nonce, request.sentAt, request.pairDigest ?? null, instanceFields(request.instance), request.peers ?? null];
  if (request.action === "local_mcp") fields.push(request.depth);
  if (request.action === "approval_answer") fields.push(request.jobId, request.approvalNonce, request.approved);
  if (request.action === "remote_enable") fields.push(request.deviceDirectory, request.relayUrl ?? null, request.relayRootKeys);
  if (request.action === "remote_events") fields.push(request.cursor);
  return JSON.stringify(fields);
}
function responseBody(response: ControlResponse): string {
  const fields: unknown[] = ["response", response.nonce, response.healthy, instanceFields(response.instance)];
  if (response.sessionToken !== undefined) fields.push(response.sessionToken);
  if (response.remoteOnly === true) fields.push("remote-only");
  if (response.approval !== undefined || response.accepted !== undefined) fields.push(response.approval ?? null, response.accepted ?? null);
  if (response.remoteActive !== undefined) fields.push("remote-active", response.remoteActive);
  if (response.events !== undefined || response.cursor !== undefined) fields.push("remote-events", response.events ?? null, response.cursor ?? null);
  if (response.error !== undefined) fields.push("error", response.error);
  return JSON.stringify(fields);
}
function controlErrorText(error: unknown): string {
  const text = (error instanceof Error ? error.message : String(error)).replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 1_000);
  return /^[a-z][a-z0-9_]{0,63}: /.test(text) ? text : `remote_unavailable: ${text}`.slice(0, 1_000);
}
function isRemoteEvent(value: unknown): value is RemoteEvent {
  if (!isObject(value) || typeof value.type !== "string" || !/^aiboard-remote-[a-z-]{1,40}$/.test(value.type)) return false;
  const entries = Object.entries(value);
  return entries.length <= 8 && entries.every(([name, item]) => name.length <= 64 &&
    ((typeof item === "string" && item.length <= 2_048) || typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))));
}
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
  return isObject(value) && CONTROL_ACTIONS.includes(value.action) && typeof value.nonce === "string" &&
    /^[0-9a-f]{64}$/.test(value.nonce) && Number.isSafeInteger(value.sentAt) && isObject(value.instance) && typeof value.mac === "string" &&
    (value.action === "pair" ? typeof value.pairDigest === "string" && /^[0-9a-f]{64}$/.test(value.pairDigest) : value.pairDigest === undefined) &&
    (value.peers === undefined || (value.action === "pair" && Array.isArray(value.peers) && value.peers.length <= 3 && value.peers.every(isLocalPairPeer))) &&
    (value.action === "local_mcp" ? Number.isSafeInteger(value.depth) && (value.depth as number) >= 0 : value.depth === undefined) &&
    (value.action === "approval_answer" ? typeof value.jobId === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value.jobId) &&
      typeof value.approvalNonce === "string" && /^[0-9a-f]{64}$/.test(value.approvalNonce) && typeof value.approved === "boolean" :
      value.jobId === undefined && value.approvalNonce === undefined && value.approved === undefined) &&
    (value.action === "remote_enable"
      ? typeof value.deviceDirectory === "string" && value.deviceDirectory.length > 0 && value.deviceDirectory.length <= 4_096 &&
        (value.relayUrl === undefined || (typeof value.relayUrl === "string" && value.relayUrl.length <= 2_048)) &&
        Array.isArray(value.relayRootKeys) && value.relayRootKeys.length <= 8 &&
        value.relayRootKeys.every((rootKey) => typeof rootKey === "string" && rootKey.length <= 1_024)
      : value.deviceDirectory === undefined && value.relayUrl === undefined && value.relayRootKeys === undefined) &&
    (value.action === "remote_events" ? Number.isSafeInteger(value.cursor) && (value.cursor as number) >= 0 : value.cursor === undefined);
}
function isControlResponse(value: unknown): value is ControlResponse {
  return isObject(value) && typeof value.nonce === "string" && typeof value.healthy === "boolean" && isObject(value.instance) && typeof value.mac === "string" &&
    (value.remoteOnly === undefined || value.remoteOnly === true) &&
    (value.remoteActive === undefined || typeof value.remoteActive === "boolean") &&
    (value.error === undefined || (typeof value.error === "string" && value.error.length <= 2_048)) &&
    (value.events === undefined
      ? value.cursor === undefined
      : Array.isArray(value.events) && value.events.length <= 16 && value.events.every(isRemoteEvent) &&
        Number.isSafeInteger(value.cursor) && (value.cursor as number) >= 0);
}
function isObject(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
