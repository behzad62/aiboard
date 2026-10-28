import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { createServer, type Server } from "node:http";
import { Duplex, type DuplexOptions } from "node:stream";
import { connect as connectTls, createServer as createTlsServer, TLSSocket } from "node:tls";

import WebSocket, { WebSocketServer, type RawData } from "ws";

import type { RemoteTransport, RemoteTransportMessage } from "../../src/remote-connector.js";
import { canonicalJson, type RemoteRequest } from "../../src/remote-admission-store.js";
import { REMOTE_CONNECT_SCOPE, REMOTE_RELAY_AUDIENCE, type RelayChallenge, type RemoteAuthorization } from "../../src/remote-auth.js";
import type { RemoteDeviceSession } from "../../src/remote-device-store.js";

/** Test-only relay signing authority: the Runner only ever sees the public key. */
export class TestRelayAuthority {
  readonly keyId = "relay-test-1";
  readonly publicKey: string;
  private readonly privateKey: import("node:crypto").KeyObject;

  constructor() {
    const pair = generateKeyPairSync("ed25519");
    this.privateKey = pair.privateKey;
    this.publicKey = pair.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  }

  session(accountId: string, clientId: string, issuedAt: string): RemoteDeviceSession {
    return {
      accountId, clientId, scope: REMOTE_CONNECT_SCOPE, issuedAt,
      relayKeys: [{ keyId: this.keyId, publicKey: this.publicKey }], authorizedScopes: ["scope-project"],
    };
  }

  challenge(challenge: RelayChallenge): Extract<RemoteTransportMessage, { type: "challenge" }> {
    return { type: "challenge", challenge, keyId: this.keyId,
      signature: sign(null, Buffer.from(canonicalJson(challenge), "utf8"), this.privateKey).toString("base64url") };
  }

  authorize(request: RemoteRequest, overrides: Partial<RemoteAuthorization["claims"]> = {}, keyId: string = this.keyId): RemoteAuthorization {
    const claims = {
      audience: REMOTE_RELAY_AUDIENCE, accountId: request.accountId, clientId: request.clientId, deviceId: request.deviceId,
      deviceEpoch: request.deviceEpoch, scopeRef: request.scopeRef, toolId: request.toolId, operationClass: request.operationClass,
      requestId: request.requestId, nonce: request.nonce, payloadDigest: request.payloadDigest,
      issuedAt: request.issuedAt, expiresAt: request.expiresAt, ...overrides,
    };
    const signature = sign(null, Buffer.from(canonicalJson(claims), "utf8"), this.privateKey).toString("base64url");
    return { version: 1, keyId, claims, signature };
  }
}


const RELAY_NAME = "fake-relay.invalid";

/** A byte stream pair, with no socket, address, listener or DNS lookup. */
export function pairedDuplex(): readonly [Duplex, Duplex] {
  class End extends Duplex {
    peer?: End;
    private endedPeer = false;

    constructor(options?: DuplexOptions) { super(options); }
    _read(): void { /* The peer pushes bytes as they are written. */ }
    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      if (!this.peer || this.peer.destroyed) return callback(new Error("Relay duplex peer is closed."));
      this.peer.push(Buffer.from(chunk));
      callback();
    }
    _final(callback: (error?: Error | null) => void): void {
      this.endPeer();
      callback();
    }
    _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
      this.endPeer();
      callback(error);
    }
    private endPeer(): void {
      if (!this.endedPeer && this.peer && !this.peer.destroyed) this.peer.push(null);
      this.endedPeer = true;
    }
  }
  const client = new End();
  const server = new End();
  client.peer = server;
  server.peer = client;
  return [client, server];
}

/** A fresh, self-signed ECDSA certificate; no subprocess or key file is needed. */
export function syntheticCertificate(): { readonly certificate: string; readonly privateKey: string } {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const algorithm = sequence(der(0x06, Buffer.from("2a8648ce3d040302", "hex")));
  const name = sequence(der(0x31, sequence(
    der(0x06, Buffer.from("550403", "hex")), der(0x0c, Buffer.from(RELAY_NAME)),
  )));
  const now = Date.now();
  const validity = sequence(utcTime(new Date(now - 86_400_000)), utcTime(new Date(now + 86_400_000)));
  const serial = randomBytes(16);
  serial[0] = (serial[0]! & 0x7f) || 1;
  const publicKey = keys.publicKey.export({ type: "spki", format: "der" });
  // Modern TLS verifiers require subjectAltName; the CN alone is ignored.
  const san = sequence(der(0x82, Buffer.from(RELAY_NAME, "ascii")));
  const sanExtension = sequence(der(0x06, Buffer.from("551d11", "hex")), der(0x04, san));
  const basic = sequence(der(0x01, Buffer.from([0xff])));
  const basicExtension = sequence(der(0x06, Buffer.from("551d13", "hex")), der(0x01, Buffer.from([0xff])), der(0x04, basic));
  const extensions = der(0xa3, sequence(sanExtension, basicExtension));
  const body = sequence(der(0xa0, integer(Buffer.from([2]))), integer(serial), algorithm,
    name, validity, name, publicKey, extensions);
  const signature = sign("sha256", body, keys.privateKey);
  const certificate = sequence(body, algorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));
  return {
    certificate: `-----BEGIN CERTIFICATE-----\n${certificate.toString("base64").match(/.{1,64}/g)!.join("\n")}\n-----END CERTIFICATE-----\n`,
    privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

function sequence(...parts: Buffer[]): Buffer { return der(0x30, Buffer.concat(parts)); }
function integer(value: Buffer): Buffer { return der(0x02, value[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), value]) : value); }
function der(tag: number, value: Buffer): Buffer {
  const length = value.length < 128 ? Buffer.from([value.length])
    : value.length < 256 ? Buffer.from([0x81, value.length])
      : Buffer.from([0x82, value.length >>> 8, value.length & 0xff]);
  return Buffer.concat([Buffer.from([tag]), length, value]);
}
function utcTime(date: Date): Buffer {
  const text = date.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z").slice(2);
  return der(0x17, Buffer.from(text, "ascii"));
}

/** Parent end of a child Runner's inherited IPC pipe, as a byte duplex. */
export function childProcessIpcDuplex(child: import("node:child_process").ChildProcess): Duplex {
  class ParentIpcDuplex extends Duplex {
    constructor() {
      super();
      child.on("message", (message: unknown) => {
        if (Buffer.isBuffer(message)) this.push(message);
        else if (message instanceof Uint8Array) this.push(Buffer.from(message));
      });
      child.once("close", () => this.push(null));
    }

    _read(): void { /* The child pushes chunks as IPC messages. */ }

    _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
      if (!child.send) return callback(new Error("Inherited relay pipe is unavailable."));
      child.send(chunk, (error) => callback(error ?? null));
    }
  }
  return new ParentIpcDuplex();
}

/** The same client can wrap an in-memory pair or a child-owned inherited pipe. */
export class FixtureWebSocketTransport implements RemoteTransport {
  private tls?: TLSSocket;
  private buffer = Buffer.alloc(0);
  private fragments: Buffer[] = [];
  private messageHandler?: (message: RemoteTransportMessage) => void | Promise<void>;
  private closeHandler?: () => void;
  private closed = false;
  private closeWaiters: Array<() => void> = [];

  constructor(private readonly stream: Duplex, private readonly certificate: string) {}

  async connect(): Promise<void> {
    if (this.tls) throw new Error("Relay transport is already connected.");
    const tlsSocket = connectTls({ socket: this.stream, servername: RELAY_NAME,
      ca: this.certificate, rejectUnauthorized: true });
    this.tls = tlsSocket;
    await new Promise<void>((resolve, reject) => {
      tlsSocket.once("secureConnect", resolve);
      tlsSocket.once("error", reject);
    });
    // Let the Finished record flush on its own before application data:
    // coalescing both into one pipe write can stall a pipe-backed peer.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const key = randomBytes(16).toString("base64");
    const head = await new Promise<Buffer>((resolve, reject) => {
      let data = Buffer.alloc(0);
      const onData = (chunk: Buffer) => {
        data = Buffer.concat([data, chunk]);
        const end = data.indexOf("\r\n\r\n");
        if (end === -1) return;
        tlsSocket.off("data", onData);
        const header = data.subarray(0, end).toString("latin1");
        if (!/^HTTP\/1\.1 101/.test(header)) { reject(new Error("Relay WebSocket upgrade was refused.")); return; }
        resolve(data.subarray(end + 4));
      };
      tlsSocket.on("data", onData);
      tlsSocket.once("error", reject);
      tlsSocket.write(
        `GET /connect HTTP/1.1\r\nHost: ${RELAY_NAME}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`);
    });
    tlsSocket.on("data", (chunk: Buffer) => this.feed(chunk));
    tlsSocket.on("close", () => this.markClosed());
    tlsSocket.on("error", () => this.markClosed());
    if (head.length) this.feed(head);
  }

  async send(message: RemoteTransportMessage): Promise<void> {
    if (!this.tls || this.closed) throw new Error("Relay transport is not open.");
    const payload = Buffer.from(JSON.stringify(message), "utf8");
    await new Promise<void>((resolve, reject) => {
      this.tls!.write(encodeClientFrame(0x1, payload), (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    if (!this.tls || this.closed && !this.tls) return;
    const tlsSocket = this.tls;
    if (!tlsSocket || tlsSocket.destroyed) { this.markClosed(); return; }
    const closed = new Promise<void>((resolve) => this.closeWaiters.push(resolve));
    try { tlsSocket.write(encodeClientFrame(0x8, Buffer.alloc(0))); } catch { /* already closing */ }
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    if (!tlsSocket.destroyed) tlsSocket.destroy();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
    this.markClosed();
  }

  onMessage(handler: (message: RemoteTransportMessage) => void | Promise<void>): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }

  private feed(chunk: Buffer): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const first = this.buffer[0]!;
      const second = this.buffer[1]!;
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2); offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        length = Number(this.buffer.readBigUInt64BE(2)); offset = 10;
      }
      if (this.buffer.length < offset + length) return;
      const payload = Buffer.from(this.buffer.subarray(offset, offset + length));
      this.buffer = this.buffer.subarray(offset + length);
      if (opcode === 0x8) { this.markClosed(); return; }
      if (opcode === 0x9) {
        try { this.tls?.write(encodeClientFrame(0xa, payload)); } catch { /* closing */ }
        continue;
      }
      if (opcode === 0x1 || opcode === 0x0) {
        this.fragments.push(payload);
        if (!fin) continue;
        const text = Buffer.concat(this.fragments).toString("utf8");
        this.fragments = [];
        try {
          const message = JSON.parse(text) as RemoteTransportMessage;
          void Promise.resolve(this.messageHandler?.(message)).catch(() => this.markClosed());
        } catch { this.markClosed(); }
      }
    }
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const resolve of this.closeWaiters.splice(0)) resolve();
    this.closeHandler?.();
  }
}

function encodeClientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1) masked[index] = masked[index]! ^ mask[index % 4]!;
  const header = payload.length < 126
    ? Buffer.from([0x80 | opcode, 0x80 | payload.length])
    : payload.length < 65_536
      ? Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 126]), (() => { const b = Buffer.alloc(2); b.writeUInt16BE(payload.length); return b; })()])
      : Buffer.concat([Buffer.from([0x80 | opcode, 0x80 | 127]), (() => { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(payload.length)); return b; })()]);
  return Buffer.concat([header, mask, masked]);
}

/** Real TLS and WebSocket server layered on an already-owned duplex stream. */
export class FakeRelay {
  readonly certificate: string;
  private readonly privateKey: string;
  private readonly http: Server;
  private readonly server = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024, perMessageDeflate: false });
  private tls?: TLSSocket;
  private socket?: WebSocket;
  private readonly messages: RemoteTransportMessage[] = [];
  private readonly waiters: Array<{ resolve: (message: RemoteTransportMessage) => void; reject: (error: Error) => void }> = [];
  private readonly connected: Promise<void>;
  private connectedResolve!: () => void;
  private connectedReject!: (error: Error) => void;
  private failure?: Error;

  constructor() {
    const identity = syntheticCertificate();
    this.certificate = identity.certificate;
    this.privateKey = identity.privateKey;
    this.connected = new Promise((resolve, reject) => { this.connectedResolve = resolve; this.connectedReject = reject; });
    void this.connected.catch(() => undefined);
    this.http = createServer();
    this.http.on("upgrade", (request, socket, head) => {
      this.server.handleUpgrade(request, socket, head, (websocket) => {
        this.socket = websocket;
        websocket.on("error", (error) => this.fail(error));
        websocket.on("close", () => this.fail(new Error("Fake relay WebSocket closed.")));
        websocket.on("message", (data, binary) => {
          if (binary) { websocket.terminate(); return; }
          try {
            const message = JSON.parse(rawText(data)) as RemoteTransportMessage;
            const waiter = this.waiters.shift();
            if (waiter) waiter.resolve(message); else this.messages.push(message);
          } catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); websocket.terminate(); }
        });
        this.connectedResolve();
      });
    });
  }

  accept(stream: Duplex): void {
    if (this.tls) throw new Error("The fake relay already owns a stream.");
    // A canonical TLS server owns the handshake and emits the decrypted
    // socket only once it is secure, as a real relay endpoint would.
    const tlsServer = createTlsServer({ cert: this.certificate, key: this.privateKey });
    tlsServer.on("secureConnection", (tlsSocket) => {
      this.tls = tlsSocket;
      tlsSocket.on("error", (error) => this.fail(error));
      tlsSocket.on("close", () => this.fail(new Error("Fake relay TLS stream closed.")));
      this.http.emit("connection", tlsSocket);
    });
    tlsServer.on("tlsClientError", (error) => this.fail(error));
    (stream as { resume?: () => void }).resume?.();
    tlsServer.emit("connection", stream);
  }

  async send(message: RemoteTransportMessage): Promise<void> {
    await this.connected;
    const socket = this.socket!;
    await new Promise<void>((resolve, reject) => socket.send(JSON.stringify(message), (error) => error ? reject(error) : resolve()));
  }

  async nextMessage(): Promise<RemoteTransportMessage> {
    const message = this.messages.shift();
    if (message) return message;
    if (this.failure) throw this.failure;
    return await new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async close(): Promise<void> {
    const socket = this.socket;
    if (socket && socket.readyState !== WebSocket.CLOSED) {
      const closed = waitForClose(socket);
      if (socket.readyState === WebSocket.OPEN) socket.close();
      await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1_000))]);
      if ((socket.readyState as number) !== 3) socket.terminate();
      await closed;
    }
    if (this.server.clients.size !== 0) throw new Error("Fake relay still owns a WebSocket client.");
    this.tls?.destroy();
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  private fail(error: Error): void {
    this.failure ??= error;
    this.connectedReject(error);
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }
}

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
}

function waitForClose(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("WebSocket cleanup is unverified.")), 5_000);
    socket.once("close", () => { clearTimeout(timer); resolve(); });
  });
}
