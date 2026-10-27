/**
 * Shared one-time local pairing for the non-V2 local runners (accounts,
 * legacy, bench). Zero dependencies; published alongside those runners as a
 * standalone download, so it must never import repository modules.
 *
 * The launcher gives each runner its ticket digest, instance identity, peer
 * list (anchor only) and control key over the inherited Node IPC channel —
 * never argv, env or files. Without that channel the runner is standalone:
 * it behaves exactly as before and the pair endpoint refuses.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer } from "node:net";

export const LOCAL_PAIR_KINDS = ["runner", "accounts", "legacy", "bench"];
const TICKET_LIFETIME_MS = 120_000;
const ATTEMPT_WINDOW_MS = 60_000;
const MAX_ATTEMPTS = 10;
const MAX_TICKETS = 4_096;
const MAX_SESSIONS = 1_024;
const MAX_MESSAGE_BYTES = 16_384;
const REQUEST_WINDOW_MS = 30_000;
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const SECRET = /^[A-Za-z0-9_-]{43}$/;
const SESSION_TOKEN = /^session_[A-Za-z0-9_-]{43}$/;

function hash(value) { return createHash("sha256").update(value, "utf8").digest("hex"); }

/** The launcher keeps the code; only its digest is registered with a runner. */
export function createLocalPairTicket(instanceId) {
  if (!INSTANCE_ID.test(instanceId)) throw new Error("Invalid pairing instance identity.");
  const code = `v1.${instanceId}.${randomBytes(32).toString("base64url")}`;
  return { code, digest: hash(code) };
}

function validPeer(peer) {
  return Boolean(peer) && typeof peer === "object" && !Array.isArray(peer) &&
    typeof peer.instanceId === "string" && INSTANCE_ID.test(peer.instanceId) &&
    LOCAL_PAIR_KINDS.includes(peer.kind) &&
    Number.isInteger(peer.port) && peer.port >= 1 && peer.port <= 65_535 &&
    typeof peer.code === "string" && peer.code.length >= 1 && peer.code.length <= 512;
}

/** In-memory credentials belong to exactly one runner lifetime. */
export class LocalPairing {
  constructor(instanceId) {
    if (!INSTANCE_ID.test(instanceId)) throw new Error("Invalid pairing instance identity.");
    this.instanceId = instanceId;
    this.tickets = new Map();
    this.sessions = new Set();
    this.attempts = [];
    this.peers = [];
    this.closed = false;
  }
  register(digest) {
    if (this.closed || !DIGEST.test(digest) || this.tickets.has(digest) || this.tickets.size >= MAX_TICKETS) {
      throw new Error("Pairing ticket registration refused.");
    }
    this.tickets.set(digest, { expiresAt: Date.now() + TICKET_LIFETIME_MS, consumed: false });
  }
  setPeers(peers) {
    if (!Array.isArray(peers) || peers.length > 3 || !peers.every(validPeer)) throw new Error("Invalid pairing peers.");
    if (new Set(peers.map((peer) => peer.kind)).size !== peers.length) throw new Error("Invalid pairing peers.");
    this.peers = peers.map((peer) => ({ instanceId: peer.instanceId, kind: peer.kind, port: peer.port, code: peer.code }));
  }
  exchangePeers() { return this.peers.map((peer) => ({ ...peer })); }
  allowAttempt() {
    if (this.closed) return false;
    const now = Date.now();
    while (this.attempts.length && this.attempts[0] <= now - ATTEMPT_WINDOW_MS) this.attempts.shift();
    if (this.attempts.length >= MAX_ATTEMPTS) return false;
    this.attempts.push(now);
    return true;
  }
  consume(code) {
    if (this.closed || typeof code !== "string" || code.length > 512) return undefined;
    const parts = code.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || parts[1] !== this.instanceId || !SECRET.test(parts[2])) return undefined;
    const ticket = this.tickets.get(hash(code));
    if (!ticket || ticket.consumed || Date.now() >= ticket.expiresAt) return undefined;
    if (this.sessions.size >= MAX_SESSIONS) return undefined;
    ticket.consumed = true;
    const token = `session_${randomBytes(32).toString("base64url")}`;
    this.sessions.add(hash(token));
    return token;
  }
  hasSession(token) { return !this.closed && typeof token === "string" && SESSION_TOKEN.test(token) && this.sessions.has(hash(token)); }
  revoke(token) { return !this.closed && typeof token === "string" && this.sessions.delete(hash(token)); }
  close() { this.closed = true; this.tickets.clear(); this.sessions.clear(); this.attempts.length = 0; this.peers = []; }
}

function singleHeader(req, name) {
  let count = 0;
  for (let index = 0; index < req.rawHeaders.length; index += 2) {
    if (req.rawHeaders[index]?.toLowerCase() === name) count += 1;
  }
  return count === 1;
}
function validPreflight(req, methods, headers) {
  const method = req.headers["access-control-request-method"];
  const requested = req.headers["access-control-request-headers"];
  const privateNetwork = req.headers["access-control-request-private-network"];
  return singleHeader(req, "access-control-request-method") && typeof method === "string" && methods.includes(method) &&
    (requested === undefined || (typeof requested === "string" && singleHeader(req, "access-control-request-headers") &&
      requested.split(",").every((header) => headers.includes(header.trim().toLowerCase())))) &&
    (privateNetwork === undefined || (singleHeader(req, "access-control-request-private-network") && privateNetwork === "true"));
}
function sendJson(res, status, value) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(value));
}
async function readBodyBounded(req, maxBytes) {
  const chunks = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) { tooLarge = true; continue; }
    chunks.push(bytes);
  }
  if (tooLarge) throw new Error("body too large");
  return Buffer.concat(chunks).toString("utf8");
}

/**
 * Pair endpoint + launcher IPC + launcher control for one .mjs runner.
 * `getPort` must return the runner's actual bound port.
 */
export function createPairingEndpoint(options) {
  const kind = options.kind;
  if (!LOCAL_PAIR_KINDS.includes(kind)) throw new Error("Invalid pairing runner kind.");
  const getPort = options.getPort;
  const shutdown = options.shutdown ?? (() => undefined);
  const endpoint = {
    kind,
    pairing: null,
    instanceId: null,
    identity: null,
    version: "1",
    startedAt: Date.now(),
    controlPort: null,
    launcherStarted: false,
    controlServer: null,
    controlKey: null,
    instance: null,
    hasSession(token) { return endpoint.pairing?.hasSession(token) === true; },
    async handle(req, res) {
      let url;
      try { url = new URL(req.url ?? "/", "http://127.0.0.1"); } catch { return false; }
      if (url.pathname !== "/v1/local-pair/exchange" && url.pathname !== "/v1/local-pair/session") return false;
      await handleLocalPair(req, res, url);
      return true;
    },
    async attach() {
      if (!process.send || !process.connected) return null;
      const init = await receiveInit();
      if (!init) return null;
      endpoint.instanceId = init.instanceId;
      endpoint.identity = init.identity;
      endpoint.version = String(init.version ?? "1");
      endpoint.startedAt = Number.isSafeInteger(init.startedAt) ? init.startedAt : Date.now();
      endpoint.controlKey = Buffer.from(init.controlKey, "hex");
      const pairing = new LocalPairing(init.instanceId);
      pairing.register(init.pairDigest);
      if (Array.isArray(init.peers) && init.peers.length) pairing.setPeers(init.peers);
      endpoint.pairing = pairing;
      endpoint.launcherStarted = true;
      process.on("message", (message) => {
        if (message && typeof message === "object" && message.type === "aiboard-launcher-stop") shutdown();
      });
      process.once("disconnect", () => shutdown());
      endpoint.instance = await startControl(init);
      if (process.connected) process.send({ type: "aiboard-local-pair-ready", instance: endpoint.instance });
      return endpoint.instance;
    },
    async close() {
      endpoint.pairing?.close();
      if (endpoint.controlKey) endpoint.controlKey.fill(0);
      const server = endpoint.controlServer;
      endpoint.controlServer = null;
      if (server) await new Promise((resolve) => server.close(() => resolve()));
    },
  };

  function devOriginAllowed() { return process.env.AIBOARD_LOCAL_PAIR_DEV_ORIGIN === "1"; }
  function isLocalPairOrigin(req) {
    const port = getPort();
    const origin = req.headers.origin;
    return singleHeader(req, "origin") && singleHeader(req, "host") &&
      req.headers.host === `127.0.0.1:${port}` &&
      (origin === "https://aiboard.me" || (devOriginAllowed() && origin === "http://localhost:3000"));
  }
  async function handleLocalPair(req, res, url) {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    const refuse = async () => {
      try { for await (const chunk of req) { void chunk; } } catch { /* already refused */ }
      if (!res.writableEnded) sendJson(res, 400, { error: "Local pairing request refused.", code: "local_pair_refused" });
    };
    const exchange = url.pathname === "/v1/local-pair/exchange";
    const pairing = endpoint.pairing;
    if (!pairing || req.url !== url.pathname || !isLocalPairOrigin(req)) { await refuse(); return; }
    const origin = req.headers.origin;
    if (req.method === "OPTIONS") {
      const methods = exchange ? ["POST"] : ["DELETE"];
      const headers = exchange ? ["content-type", "x-aiboard-pair-version"] : ["authorization"];
      if (!validPreflight(req, methods, headers)) { await refuse(); return; }
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Vary", "Origin");
      res.setHeader("Access-Control-Allow-Methods", exchange ? "POST, OPTIONS" : "DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", exchange ? "Content-Type, X-AIBoard-Pair-Version" : "Authorization");
      if (req.headers["access-control-request-private-network"] === "true") res.setHeader("Access-Control-Allow-Private-Network", "true");
      res.statusCode = 204;
      res.end();
      return;
    }
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    if (!exchange) {
      const header = req.headers.authorization;
      const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
      if (req.method !== "DELETE" || !singleHeader(req, "authorization") || !token || !pairing.revoke(token)) { await refuse(); return; }
      sendJson(res, 200, { version: 1 });
      return;
    }
    if (!pairing.allowAttempt() || req.method !== "POST" ||
        !singleHeader(req, "content-type") ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/i.test(req.headers["content-type"] ?? "") ||
        !singleHeader(req, "x-aiboard-pair-version") || req.headers["x-aiboard-pair-version"] !== "1") { await refuse(); return; }
    let body;
    try { body = JSON.parse(await readBodyBounded(req, 2_048)); } catch { await refuse(); return; }
    if (!body || typeof body !== "object" || Array.isArray(body) ||
        Object.keys(body).length !== 2 || body.version !== 1 ||
        typeof body.code !== "string" || body.code.length < 1 || body.code.length > 512) { await refuse(); return; }
    const sessionToken = pairing.consume(body.code);
    if (!sessionToken) { await refuse(); return; }
    sendJson(res, 200, { version: 1, instanceId: pairing.instanceId, kind, port: getPort(), sessionToken, peers: pairing.exchangePeers() });
  }

  function receiveInit() {
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(null), 10_000);
      const onMessage = (value) => { finish(isInit(value) ? value : null); };
      const onDisconnect = () => finish(null);
      function finish(value) {
        clearTimeout(timer);
        process.off("message", onMessage);
        process.off("disconnect", onDisconnect);
        resolve(value);
      }
      process.once("message", onMessage);
      process.once("disconnect", onDisconnect);
      process.send({ type: "aiboard-local-pair-awaiting-init", kind }, (error) => { if (error) finish(null); });
    });
  }
  function isInit(value) {
    return Boolean(value) && typeof value === "object" && value.type === "aiboard-local-pair-init" &&
      value.kind === kind && typeof value.instanceId === "string" && INSTANCE_ID.test(value.instanceId) &&
      typeof value.pairDigest === "string" && DIGEST.test(value.pairDigest) &&
      typeof value.controlKey === "string" && /^[0-9a-f]{64}$/.test(value.controlKey) &&
      value.identity && typeof value.identity === "object" &&
      typeof value.identity.projectPath === "string" && typeof value.identity.projectKey === "string" &&
      typeof value.identity.owner === "string" &&
      (value.peers === undefined || (Array.isArray(value.peers) && value.peers.length <= 3 && value.peers.every(validPeer)));
  }

  async function startControl(init) {
    const usedNonces = new Map();
    const sockets = new Set();
    const instance = {
      schemaVersion: 1, projectPath: init.identity.projectPath, projectKey: init.identity.projectKey,
      owner: init.identity.owner, pid: process.pid, startedAt: endpoint.startedAt, port: getPort(),
      controlPort: 0, instanceId: init.instanceId, version: endpoint.version, kind,
    };
    const server = createServer((socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
      socket.on("error", () => socket.destroy());
      socket.setTimeout(5_000, () => socket.destroy());
      void readLine(socket).then((line) => {
        const value = JSON.parse(line);
        instance.port = getPort();
        if (!isControlRequest(value) || !sameInstance(value.instance, instance) ||
            Math.abs(Date.now() - value.sentAt) > REQUEST_WINDOW_MS ||
            !validMac(endpoint.controlKey, requestBody(value), value.mac)) throw new Error("invalid control request");
        const now = Date.now();
        for (const [nonce, expiry] of usedNonces) if (expiry < now) usedNonces.delete(nonce);
        if (usedNonces.has(value.nonce) || usedNonces.size >= 2048) throw new Error("replayed control request");
        usedNonces.set(value.nonce, now + REQUEST_WINDOW_MS * 2);
        if (value.action === "pair") {
          if (!value.pairDigest || !endpoint.pairing) throw new Error("pairing unavailable");
          endpoint.pairing.register(value.pairDigest);
          if (value.peers !== undefined) endpoint.pairing.setPeers(value.peers);
        }
        const response = { nonce: value.nonce, healthy: true, instance: { ...instance }, mac: "" };
        response.mac = sign(endpoint.controlKey, responseBody(response));
        if (value.action === "stop") socket.once("close", () => shutdown());
        socket.end(`${JSON.stringify(response)}\n`);
      }).catch(() => socket.destroy());
    });
    server.maxConnections = 32;
    endpoint.controlServer = server;
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("launcher control unavailable");
    instance.controlPort = address.port;
    endpoint.controlPort = address.port;
    return instance;
  }
  return endpoint;
}

function instanceFields(value) {
  return [value.schemaVersion, value.projectPath, value.projectKey, value.owner, value.pid, value.startedAt, value.port, value.controlPort, value.instanceId, value.version];
}
function sameInstance(left, right) { return JSON.stringify(instanceFields(left)) === JSON.stringify(instanceFields(right)); }
function requestBody(request) { return JSON.stringify(["request", request.action, request.nonce, request.sentAt, request.pairDigest ?? null, instanceFields(request.instance), request.peers ?? null]); }
function responseBody(response) { return JSON.stringify(["response", response.nonce, response.healthy, instanceFields(response.instance)]); }
function sign(key, body) { return createHmac("sha256", key).update(body).digest("hex"); }
function validMac(key, body, mac) {
  if (!/^[0-9a-f]{64}$/.test(mac)) return false;
  return timingSafeEqual(Buffer.from(sign(key, body), "hex"), Buffer.from(mac, "hex"));
}
function isControlRequest(value) {
  return Boolean(value) && typeof value === "object" &&
    (value.action === "status" || value.action === "stop" || value.action === "pair") &&
    typeof value.nonce === "string" && /^[0-9a-f]{64}$/.test(value.nonce) &&
    Number.isSafeInteger(value.sentAt) && value.instance && typeof value.instance === "object" && typeof value.mac === "string" &&
    (value.action === "pair" ? typeof value.pairDigest === "string" && DIGEST.test(value.pairDigest) : value.pairDigest === undefined) &&
    (value.peers === undefined || (value.action === "pair" && Array.isArray(value.peers) && value.peers.length <= 3 && value.peers.every(validPeer)));
}
function readLine(socket) {
  return new Promise((resolve, reject) => {
    let data = "";
    socket.setEncoding("utf8");
    const onData = (chunk) => {
      data += chunk;
      if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES) return finish(new Error("control message too large"));
      const newline = data.indexOf("\n");
      if (newline !== -1) finish(undefined, data.slice(0, newline));
    };
    const onError = (error) => finish(error);
    const onEnd = () => finish(new Error("control connection closed"));
    function finish(error, line) {
      socket.off("data", onData); socket.off("error", onError); socket.off("end", onEnd);
      if (error) reject(error); else resolve(line);
    }
    socket.on("data", onData); socket.once("error", onError); socket.once("end", onEnd);
  });
}
