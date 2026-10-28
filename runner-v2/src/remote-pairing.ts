import { createPublicKey, randomBytes, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import { resolve } from "node:path";

import { canonicalJson, rejectDuplicateKeys } from "./remote-admission-store.js";
import { REMOTE_CONNECT_SCOPE, type RemoteSessionIssuer } from "./remote-auth.js";
import { checkedSessionShape, type RemoteDeviceSession, type RemoteDeviceStore } from "./remote-device-store.js";
import { REMOTE_RELAY_ROOTS } from "./remote-relay-roots.js";
import { validateRelayUrl } from "./remote-websocket-transport.js";

const MAX_BODY_BYTES = 8 * 1024;
const FLOWS = new Map<string, { origin: string; deviceId: string; publicKey: string; promise: Promise<RemoteDeviceSession> }>();

export type PairingErrorCode = "pairing_expired" | "pairing_denied" | "pairing_invalid_response" | "pairing_unavailable";
export class RemotePairingError extends Error {
  constructor(readonly code: PairingErrorCode, message: string) {
    super(message);
    this.name = "RemotePairingError";
  }
}

export interface PairingPresentation {
  readonly userCode: string;
  readonly verificationUri: string;
  readonly expiresAt: string;
  readonly deviceName: string;
}

export interface RelayPairingOptions {
  readonly relayUrl: string;
  readonly rootKeys?: readonly string[];
  readonly deviceStore: RemoteDeviceStore;
  readonly present: (presentation: PairingPresentation) => void;
  readonly openUrl: (uri: string) => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly signal?: AbortSignal;
  readonly deviceName?: string;
  readonly platform?: NodeJS.Platform;
  readonly runnerVersion?: string;
}

interface RelayRoot { readonly keyId?: string; readonly publicKey: string }

/** Validate pins at argument parsing time, before Runner startup or any network access. */
export function pairingRelayConfiguration(relayUrl: string, customKeys: readonly string[] = []): { origin: string; roots: readonly RelayRoot[] } {
  const url = validateRelayUrl(relayUrl);
  if (url.protocol === "ws:" && url.hostname !== "127.0.0.1") throw new Error("Loopback pairing requires ws://127.0.0.1.");
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  const origin = url.origin;
  if (Object.hasOwn(REMOTE_RELAY_ROOTS, origin)) {
    if (customKeys.length) throw new Error("--relay-root-key cannot override the built-in relay pins.");
    return { origin, roots: REMOTE_RELAY_ROOTS[origin]! };
  }
  if (!customKeys.length) throw new Error("A custom --relay-url requires at least one --relay-root-key.");
  for (const key of customKeys) {
    try { publicKey(key); } catch { throw new Error("--relay-root-key must be a base64url Ed25519 SPKI public key."); }
  }
  return { origin, roots: customKeys.map((key) => ({ publicKey: key })) };
}

export class RelayPairingIssuer implements RemoteSessionIssuer {
  readonly pairingUrl: string;
  readonly requiresSessionRestore = true;
  private readonly origin: string;
  private readonly roots: readonly RelayRoot[];
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly fetch: typeof fetch;
  readonly deviceName: string;
  private readonly platform: string;
  private readonly runnerVersion: string;

  constructor(private readonly options: RelayPairingOptions) {
    const config = pairingRelayConfiguration(options.relayUrl, options.rootKeys);
    this.origin = config.origin;
    this.roots = config.roots;
    this.pairingUrl = `${this.origin}/pair`;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolveDelay) => setTimeout(resolveDelay, ms)));
    this.fetch = options.fetch ?? fetch;
    this.deviceName = (options.deviceName ?? hostname()).replace(/[^\x20-\x7e]/g, " ").trim().slice(0, 64) || "AIBoard device";
    this.platform = options.platform ?? process.platform;
    if (!["win32", "darwin", "linux"].includes(this.platform)) throw new Error("Pairing is unavailable on this platform.");
    const metadata: unknown = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    this.runnerVersion = options.runnerVersion ?? (isRecord(metadata) && typeof metadata.version === "string" ? metadata.version : "");
    if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(this.runnerVersion)) throw new Error("Runner version is invalid.");
  }

  async restoreSession(): Promise<RemoteDeviceSession | undefined> {
    const identity = this.options.deviceStore.load();
    const session = this.options.deviceStore.loadSession();
    if (!identity || identity.revoked || !session || session.relayOrigin !== this.origin ||
      identity.accountId !== session.accountId) return undefined;
    return session;
  }

  async requestSession(identity: { deviceId: string; publicKey: string }): Promise<RemoteDeviceSession> {
    const key = process.platform === "win32" ? resolve(this.options.deviceStore.stateDirectory).toLowerCase() : resolve(this.options.deviceStore.stateDirectory);
    const existing = FLOWS.get(key);
    if (existing) {
      if (existing.origin !== this.origin || existing.deviceId !== identity.deviceId || existing.publicKey !== identity.publicKey) throw new Error("A different pairing is already active for this device.");
      return await existing.promise;
    }
    const promise = this.pair(identity);
    FLOWS.set(key, { origin: this.origin, deviceId: identity.deviceId, publicKey: identity.publicKey, promise });
    try { return await promise; }
    finally { if (FLOWS.get(key)?.promise === promise) FLOWS.delete(key); }
  }

  private async pair(identity: { deviceId: string; publicKey: string }): Promise<RemoteDeviceSession> {
    let release = this.options.deviceStore.acquirePairingLock();
    let waited = false;
    while (!release) {
      waited = true;
      await this.wait(100);
      release = this.options.deviceStore.acquirePairingLock();
    }
    try {
      if (waited) {
        const current = this.options.deviceStore.load();
        if (!current || current.revoked || current.deviceId !== identity.deviceId || current.publicKey !== identity.publicKey) {
          throw new RemotePairingError("pairing_unavailable", "Device identity changed while waiting to pair.");
        }
        const restored = await this.restoreSession();
        if (restored) return restored;
      }
      return await this.performPair(identity);
    } finally { release(); }
  }

  private async performPair(identity: { deviceId: string; publicKey: string }): Promise<RemoteDeviceSession> {
    const current = this.options.deviceStore.load();
    if (!current || current.revoked || current.deviceId !== identity.deviceId || current.publicKey !== identity.publicKey ||
      !/^device-[0-9a-f-]{36}$/.test(identity.deviceId)) throw new RemotePairingError("pairing_unavailable", "Device identity is unavailable for pairing.");
    const request = {
      protocolVersion: "1.0.0", deviceId: identity.deviceId, publicKey: identity.publicKey,
      name: this.deviceName, platform: this.platform, runnerVersion: this.runnerVersion,
      issuedAt: this.now().toISOString(), nonce: randomBytes(24).toString("base64url"),
    };
    const signature = this.options.deviceStore.sign(Buffer.from(canonicalJson(request), "utf8")).toString("base64url");
    const start = await this.post("/pair/v2/start", { ...request, signature });
    if (start.status !== 201 || !isRecord(start.body) || !only(start.body, ["pairingId", "pollSecret", "userCode", "verificationUri", "expiresAt", "intervalSeconds"]) ||
      !encoded(start.body.pairingId, 16) || !encoded(start.body.pollSecret, 32) ||
      typeof start.body.userCode !== "string" || !/^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/.test(start.body.userCode) ||
      start.body.verificationUri !== this.pairingUrl || typeof start.body.expiresAt !== "string" || !isoTime(start.body.expiresAt) ||
      !Number.isSafeInteger(start.body.intervalSeconds) || (start.body.intervalSeconds as number) < 1 || (start.body.intervalSeconds as number) > 600) {
      throw new RemotePairingError("pairing_invalid_response", "The relay returned an invalid pairing response.");
    }
    const expiry = Date.parse(start.body.expiresAt);
    if (expiry <= this.now().getTime()) throw new RemotePairingError("pairing_expired", "Pairing expired.");
    if (expiry > this.now().getTime() + 11 * 60_000) throw new RemotePairingError("pairing_invalid_response", "The relay returned an invalid pairing expiry.");
    const { pairingId, pollSecret, userCode, verificationUri, expiresAt } = start.body as Record<string, string>;
    this.options.present({ userCode: userCode!, verificationUri: verificationUri!, expiresAt: expiresAt!, deviceName: this.deviceName });
    try { this.options.openUrl(verificationUri!); } catch { /* The terminal instructions remain usable. */ }
    let interval = start.body.intervalSeconds as number;
    for (;;) {
      const remaining = expiry - this.now().getTime();
      if (remaining <= 0) throw new RemotePairingError("pairing_expired", "Pairing expired.");
      await this.wait(Math.min(interval * 1000, remaining));
      if (this.now().getTime() >= expiry) throw new RemotePairingError("pairing_expired", "Pairing expired.");
      let poll: { status: number; body: unknown };
      try { poll = await this.post("/pair/v2/poll", { pairingId, pollSecret }, expiry - this.now().getTime()); }
      catch (error) {
        if (this.now().getTime() >= expiry) throw new RemotePairingError("pairing_expired", "Pairing expired.");
        throw error;
      }
      if (!isRecord(poll.body) || typeof poll.body.status !== "string") throw new RemotePairingError("pairing_invalid_response", "The relay returned an invalid pairing status.");
      if (poll.status === 429 && poll.body.status === "slow_down" && only(poll.body, ["status"])) { interval += 5; continue; }
      if (poll.status !== 200) throw new RemotePairingError("pairing_invalid_response", "The relay returned an invalid pairing status.");
      if (poll.body.status === "pending" && only(poll.body, ["status"])) continue;
      if (poll.body.status === "expired" && only(poll.body, ["status"])) throw new RemotePairingError("pairing_expired", "Pairing expired.");
      if (poll.body.status === "denied" && only(poll.body, ["status"])) throw new RemotePairingError("pairing_denied", "Pairing was denied.");
      if (poll.body.status !== "approved" || !only(poll.body, ["status", "session"])) throw new RemotePairingError("pairing_invalid_response", "The relay returned an invalid pairing status.");
      if (this.now().getTime() >= expiry) throw new RemotePairingError("pairing_expired", "Pairing expired.");
      const session = this.verifySession(poll.body.session);
      const latest = this.options.deviceStore.load();
      if (!latest || latest.revoked || latest.deviceId !== identity.deviceId || latest.publicKey !== identity.publicKey ||
        (latest.accountId !== null && latest.accountId !== session.accountId)) {
        throw new RemotePairingError("pairing_unavailable", "The device identity changed during pairing.");
      }
      this.options.deviceStore.setAccountId(session.accountId);
      this.options.deviceStore.saveSession(session);
      return session;
    }
  }

  private async wait(ms: number): Promise<void> {
    const signal = this.options.signal;
    if (!signal) return await this.sleep(ms);
    if (signal.aborted) throw new RemotePairingError("pairing_unavailable", "Pairing was stopped.");
    if (!this.options.sleep) {
      await new Promise<void>((resolveDelay, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolveDelay(); }, ms);
        const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(new RemotePairingError("pairing_unavailable", "Pairing was stopped.")); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
      return;
    }
    let abort: (() => void) | undefined;
    try {
      await Promise.race([this.sleep(ms), new Promise<never>((_resolve, reject) => {
        abort = () => reject(new RemotePairingError("pairing_unavailable", "Pairing was stopped."));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      })]);
    } finally { if (abort) signal.removeEventListener("abort", abort); }
  }

  private verifySession(value: unknown): RemoteDeviceSession {
    if (!isRecord(value) || !only(value, ["accountId", "clientId", "scope", "issuedAt", "relayKeys", "authorizedScopes", "relayOrigin", "envelopeKeyId", "envelopeSignature"]) ||
      typeof value.accountId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(value.accountId) ||
      value.relayOrigin !== this.origin || value.clientId !== "runner" || value.scope !== REMOTE_CONNECT_SCOPE ||
      typeof value.issuedAt !== "string" || !isoTime(value.issuedAt) || !printableId(value.envelopeKeyId) ||
      !encoded(value.envelopeSignature, 64) || !Array.isArray(value.relayKeys) || value.relayKeys.length === 0 || value.relayKeys.length > 32 ||
      !value.relayKeys.every((key: unknown) => isRecord(key) && only(key, ["keyId", "publicKey"]) && printableId(key.keyId) && typeof key.publicKey === "string" && validPublicKey(key.publicKey)) ||
      !Array.isArray(value.authorizedScopes) || value.authorizedScopes.length === 0 || value.authorizedScopes.length > 32 ||
      !value.authorizedScopes.every(printableId)) {
      throw new RemotePairingError("pairing_invalid_response", "The relay session envelope is invalid.");
    }
    const { envelopeSignature, ...signed } = value;
    const valid = this.roots.some((root) => {
      if (root.keyId !== undefined && root.keyId !== value.envelopeKeyId) return false;
      try { return verify(null, Buffer.from(canonicalJson(signed), "utf8"), publicKey(root.publicKey), Buffer.from(envelopeSignature as string, "base64url")); }
      catch { return false; }
    });
    if (!valid) throw new RemotePairingError("pairing_invalid_response", "The relay session signature did not verify.");
    const { envelopeKeyId: _keyId, ...payload } = signed;
    void _keyId;
    const session = checkedSessionShape(payload);
    if (!session) throw new RemotePairingError("pairing_invalid_response", "The relay session envelope is invalid.");
    return session;
  }

  private async post(pathname: string, body: object, timeoutMs = 30_000): Promise<{ status: number; body: unknown }> {
    const json = JSON.stringify(body);
    if (Buffer.byteLength(json) > MAX_BODY_BYTES) throw new RemotePairingError("pairing_unavailable", "Pairing request is too large.");
    let response: Response;
    try {
      const timeout = AbortSignal.timeout(Math.max(1, Math.min(30_000, timeoutMs)));
      response = await this.fetch(`${this.origin}${pathname}`, {
        method: "POST", headers: { "content-type": "application/json" }, body: json,
        redirect: "error", signal: this.options.signal ? AbortSignal.any([timeout, this.options.signal]) : timeout,
      });
    } catch { throw new RemotePairingError("pairing_unavailable", "The relay pairing service is unavailable."); }
    if (!/^application\/json(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
      !/(?:^|,)\s*no-store\s*(?:,|$)/i.test(response.headers.get("cache-control") ?? "")) {
      throw new RemotePairingError("pairing_invalid_response", "The relay returned invalid pairing headers.");
    }
    try {
      if (!response.body) throw new Error("Missing body.");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const result = await reader.read();
        if (result.done) break;
        size += result.value.byteLength;
        if (size > MAX_BODY_BYTES) { await reader.cancel(); throw new Error("Body too large."); }
        chunks.push(result.value);
      }
      const raw = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
      rejectDuplicateKeys(raw);
      return { status: response.status, body: JSON.parse(raw) as unknown };
    } catch { throw new RemotePairingError("pairing_invalid_response", "The relay returned invalid pairing JSON."); }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function only(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function encoded(value: unknown, bytes: number): value is string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  const buffer = Buffer.from(value, "base64url");
  return buffer.length === bytes && buffer.toString("base64url") === value;
}
function publicKey(value: string) {
  if (!/^[A-Za-z0-9_-]+$/.test(value) || Buffer.from(value, "base64url").toString("base64url") !== value) throw new Error("Invalid key.");
  const key = createPublicKey({ key: Buffer.from(value, "base64url"), type: "spki", format: "der" });
  if (key.asymmetricKeyType !== "ed25519" || key.export({ type: "spki", format: "der" }).toString("base64url") !== value) throw new Error("Invalid key.");
  return key;
}
function validPublicKey(value: string): boolean { try { publicKey(value); return true; } catch { return false; } }
function printableId(value: unknown): value is string { return typeof value === "string" && /^[\x21-\x7e]{1,256}$/.test(value); }
function isoTime(value: string): boolean {
  return /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
}
