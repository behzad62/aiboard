/**
 * Launcher (L1d) browser handoff: exchange a single-use pairing code from the
 * URL fragment for a tab-scoped Runner V2 session credential.
 *
 * The pairing code and the session token are secrets. The code is read once
 * from `location.hash`, the fragment is stripped with `history.replaceState`
 * before any network call, and neither value is logged or written to
 * persistent storage. The session token lives only in memory and in
 * `sessionStorage` (tab-scoped); only non-secret metadata (port, instanceId,
 * kind) may be used for UX elsewhere.
 */

export const LOCAL_RUNNER_SESSION_STORAGE_KEY = "aiboard:local-runner-session:v1";
export const LOCAL_RUNNER_SESSIONS_STORAGE_KEY = "aiboard:local-runner-sessions:v1";
export type LocalRunnerKind = "runner" | "accounts" | "legacy" | "bench";
const LOCAL_RUNNER_KINDS: readonly LocalRunnerKind[] = ["runner", "accounts", "legacy", "bench"];

const PAIR_CODE = /^v1\.([A-Za-z0-9_-]{1,256})\.([A-Za-z0-9_-]{43})$/;
const INSTANCE_ID = /^[A-Za-z0-9_-]{1,256}$/;
const DECIMAL_PORT = /^(0|[1-9][0-9]*)$/;

export type LocalRunnerHandoffErrorKind =
  | "invalid_fragment"
  | "invalid_code"
  | "invalid_ports"
  | "exchange_refused"
  | "unreachable"
  | "mismatch"
  | "invalid_response";

export class LocalRunnerHandoffError extends Error {
  constructor(
    readonly kind: LocalRunnerHandoffErrorKind,
    message: string
  ) {
    super(message);
    this.name = "LocalRunnerHandoffError";
  }
}

export interface LocalRunnerMetadata {
  port: number;
  instanceId: string;
  kind: LocalRunnerKind;
}

export interface PeerExchangeFailure { kind: LocalRunnerKind; port: number; message: string }

export interface CombinedLauncherSession extends LauncherSession {
  peerSessions: LauncherSession[];
  failures: PeerExchangeFailure[];
}

export interface LauncherSession extends LocalRunnerMetadata {
  sessionToken: string;
}

export interface LauncherConnection {
  url: string;
  token: string;
  source: "launcher";
}

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type FetchLike = (
  input: string,
  init?: Record<string, unknown>
) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}>;

let memorySession: LauncherSession | null = null;
const memorySessions = new Map<LocalRunnerKind, LauncherSession>();

function defaultStorage(): StorageLike | null {
  try {
    const storage = (globalThis as { sessionStorage?: StorageLike }).sessionStorage;
    return storage ?? null;
  } catch {
    return null;
  }
}

function defaultFetch(): FetchLike {
  const fetchImpl = (globalThis as { fetch?: unknown }).fetch;
  if (typeof fetchImpl !== "function") {
    throw new LocalRunnerHandoffError("unreachable", "This browser cannot reach the local Runner.");
  }
  return fetchImpl as FetchLike;
}

function isValidPort(port: number): boolean {
  return Number.isInteger(port) && port >= 1024 && port <= 65_535;
}

export function parsePairCode(code: unknown): { code: string; instanceId: string } {
  if (typeof code !== "string" || code.length < 1 || code.length > 512) {
    throw new LocalRunnerHandoffError("invalid_code", "The pairing code is missing or malformed. Run `aiboard` again to get a new code.");
  }
  const match = PAIR_CODE.exec(code);
  if (!match) {
    throw new LocalRunnerHandoffError("invalid_code", "The pairing code is malformed. Run `aiboard` again to get a new code.");
  }
  return { code, instanceId: match[1]! };
}

/** Ports are decimal loopback ports only; hostnames and other forms are rejected. */
export function parseRunnerPorts(raw: unknown): number[] {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 64) {
    throw new LocalRunnerHandoffError("invalid_ports", "The Runner port list is malformed. Run `aiboard` again.");
  }
  const parts = raw.split(",");
  if (parts.length < 1 || parts.length > 4) {
    throw new LocalRunnerHandoffError("invalid_ports", "The Runner port list must name between 1 and 4 ports.");
  }
  const ports: number[] = [];
  for (const part of parts) {
    if (!DECIMAL_PORT.test(part)) {
      throw new LocalRunnerHandoffError("invalid_ports", "The Runner port list contains a value that is not a decimal port.");
    }
    const port = Number(part);
    if (!isValidPort(port)) {
      throw new LocalRunnerHandoffError("invalid_ports", "Runner ports must be between 1024 and 65535.");
    }
    if (ports.includes(port)) {
      throw new LocalRunnerHandoffError("invalid_ports", "The Runner port list contains a duplicate port.");
    }
    ports.push(port);
  }
  return ports;
}

function validatePorts(ports: readonly number[]): number[] {
  if (!Array.isArray(ports) || ports.length < 1 || ports.length > 4) {
    throw new LocalRunnerHandoffError("invalid_ports", "The Runner port list must name between 1 and 4 ports.");
  }
  for (const port of ports) {
    if (!isValidPort(port)) {
      throw new LocalRunnerHandoffError("invalid_ports", "Runner ports must be between 1024 and 65535.");
    }
  }
  if (new Set(ports).size !== ports.length) {
    throw new LocalRunnerHandoffError("invalid_ports", "The Runner port list contains a duplicate port.");
  }
  return [...ports];
}

export function parseConnectFragment(hash: string): { code: string; instanceId: string; ports: number[] } {
  if (typeof hash !== "string" || !hash.startsWith("#") || hash.length < 2) {
    throw new LocalRunnerHandoffError("invalid_fragment", "This link is missing its pairing details. Run `aiboard` again.");
  }
  const params = new URLSearchParams(hash.slice(1));
  const keys = [...params.keys()];
  if (keys.length !== 2 || !params.has("pair") || !params.has("runners")) {
    throw new LocalRunnerHandoffError("invalid_fragment", "This link's pairing details are malformed. Run `aiboard` again.");
  }
  const { code, instanceId } = parsePairCode(params.get("pair"));
  const ports = parseRunnerPorts(params.get("runners"));
  return { code, instanceId, ports };
}

function validateSessionShape(value: unknown): LauncherSession | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.kind !== "string" || !(LOCAL_RUNNER_KINDS as readonly string[]).includes(record.kind)) return null;
  if (typeof record.instanceId !== "string" || !INSTANCE_ID.test(record.instanceId)) return null;
  if (typeof record.port !== "number" || !isValidPort(record.port)) return null;
  if (typeof record.sessionToken !== "string" || record.sessionToken.length < 1 || record.sessionToken.length > 512) return null;
  return { port: record.port, instanceId: record.instanceId, kind: record.kind as LocalRunnerKind, sessionToken: record.sessionToken };
}

function readStoredSessions(storage: StorageLike | null): Map<LocalRunnerKind, LauncherSession> {
  const sessions = new Map<LocalRunnerKind, LauncherSession>();
  try {
    const raw = storage?.getItem(LOCAL_RUNNER_SESSIONS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const value of Object.values(parsed as Record<string, unknown>)) {
          const session = validateSessionShape(value);
          if (session) sessions.set(session.kind, session);
        }
      }
    }
  } catch { /* tab memory still applies */ }
  for (const [kind, session] of memorySessions) sessions.set(kind, session);
  return sessions;
}

/** Every launcher session held by this tab, keyed by runner kind. */
export function readLauncherSessions(storage: StorageLike | null = defaultStorage()): Partial<Record<LocalRunnerKind, LauncherSession>> {
  const sessions = readStoredSessions(storage);
  const legacy = readLauncherSession(storage);
  if (legacy && !sessions.has(legacy.kind)) sessions.set(legacy.kind, legacy);
  return Object.fromEntries(sessions);
}

export function getLauncherSession(kind: LocalRunnerKind, storage: StorageLike | null = defaultStorage()): LauncherSession | null {
  return readStoredSessions(storage).get(kind) ?? (kind === "runner" ? readLauncherSession(storage) : null);
}

export function getPeerConnection(kind: LocalRunnerKind, storage: StorageLike | null = defaultStorage()): LauncherConnection | null {
  const session = getLauncherSession(kind, storage);
  return session ? { url: `http://127.0.0.1:${session.port}`, token: session.sessionToken, source: "launcher" } : null;
}

export function storeLauncherSession(session: LauncherSession, storage: StorageLike | null = defaultStorage()): void {
  const valid = validateSessionShape(session);
  if (!valid) throw new LocalRunnerHandoffError("invalid_response", "The Runner returned an invalid session.");
  memorySessions.set(valid.kind, valid);
  if (valid.kind === "runner") memorySession = valid;
  try {
    const sessions = readStoredSessions(storage);
    sessions.set(valid.kind, valid);
    storage?.setItem(LOCAL_RUNNER_SESSIONS_STORAGE_KEY, JSON.stringify(Object.fromEntries(sessions)));
  } catch {
    // Memory still holds the session for this tab even if storage is unavailable.
  }
}

export function storePeerSession(session: LauncherSession, storage: StorageLike | null = defaultStorage()): void {
  storeLauncherSession(session, storage);
}

/** Tab-scoped only: memory first, then sessionStorage. Never persistent storage. */
export function readLauncherSession(storage: StorageLike | null = defaultStorage()): LauncherSession | null {
  if (memorySession) return memorySession;
  const combined = readStoredSessions(storage).get("runner");
  if (combined) { memorySession = combined; return combined; }
  try {
    const raw = storage?.getItem(LOCAL_RUNNER_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = validateSessionShape(JSON.parse(raw) as unknown);
    if (parsed) memorySession = parsed;
    return parsed;
  } catch {
    return null;
  }
}

export function clearLauncherSession(storage: StorageLike | null = defaultStorage()): void {
  memorySession = null;
  memorySessions.clear();
  try {
    storage?.removeItem(LOCAL_RUNNER_SESSION_STORAGE_KEY);
    storage?.removeItem(LOCAL_RUNNER_SESSIONS_STORAGE_KEY);
  } catch {
    // Nothing else to clear; the in-memory copy is already gone.
  }
}

export function getLocalRunnerMetadata(storage: StorageLike | null = defaultStorage()): LocalRunnerMetadata | null {
  const session = readLauncherSession(storage);
  return session ? { port: session.port, instanceId: session.instanceId, kind: session.kind } : null;
}

export function getLauncherConnection(storage: StorageLike | null = defaultStorage()): LauncherConnection | null {
  const session = readLauncherSession(storage);
  return session
    ? { url: `http://127.0.0.1:${session.port}`, token: session.sessionToken, source: "launcher" }
    : null;
}

export function isLauncherSessionToken(token: string | null | undefined, storage: StorageLike | null = defaultStorage()): boolean {
  if (!token) return false;
  if (readLauncherSession(storage)?.sessionToken === token) return true;
  return [...readStoredSessions(storage).values()].some((session) => session.sessionToken === token);
}

export function normalizeRunnerUrl(url: string): string {
  return url.trim().replace(/\/+$/, "");
}

/**
 * Resolve the connection for a runner URL: a matching launcher session wins,
 * then a legacy manually pasted token for that same URL.
 */
export function resolveRunnerConnection(
  input: { runnerUrl?: string | null; runnerToken?: string | null } | null | undefined,
  storage: StorageLike | null = defaultStorage()
): { url: string; token: string; source: "launcher" | "manual" } | null {
  const launcher = getLauncherConnection(storage);
  const runnerUrl = input?.runnerUrl?.trim() ? normalizeRunnerUrl(input.runnerUrl) : null;
  if (launcher && (!runnerUrl || launcher.url === runnerUrl)) {
    return launcher;
  }
  if (runnerUrl && input?.runnerToken) {
    return { url: runnerUrl, token: input.runnerToken, source: "manual" };
  }
  if (!runnerUrl && launcher) return launcher;
  return null;
}

/** A copy of a discussion with the launcher session filled in, in memory only. */
export function withResolvedRunnerToken<T extends { runnerUrl?: string | null; runnerToken?: string | null }>(
  discussion: T | null | undefined,
  storage: StorageLike | null = defaultStorage()
): T | null | undefined {
  if (!discussion) return discussion;
  const connection = resolveRunnerConnection(discussion, storage);
  if (!connection || connection.token === discussion.runnerToken) return discussion;
  return { ...discussion, runnerToken: connection.token };
}

/** True when a persisted discussion names a Runner but no usable credential is available in this tab. */
export function discussionNeedsLauncherReconnect(
  discussion: { runnerUrl?: string | null; runnerToken?: string | null } | null | undefined,
  storage: StorageLike | null = defaultStorage()
): boolean {
  if (!discussion?.runnerUrl) return false;
  return resolveRunnerConnection(discussion, storage) === null;
}

/** Remove a launcher session token before a discussion record is persisted. */
export function sanitizeRunnerTokenForPersistence(
  runnerToken: string | null | undefined,
  storage: StorageLike | null = defaultStorage()
): string | null {
  if (!runnerToken) return null;
  return isLauncherSessionToken(runnerToken, storage) ? null : runnerToken;
}

interface PeerDescriptor { instanceId: string; kind: LocalRunnerKind; port: number; code: string }

function parsePeerDescriptors(value: unknown, anchorKind: LocalRunnerKind, anchorPort: number, ports: readonly number[]): PeerDescriptor[] {
  if (!Array.isArray(value) || value.length > 3) {
    throw new LocalRunnerHandoffError("invalid_response", "The Runner returned an invalid response. Run `aiboard` again.");
  }
  const peers: PeerDescriptor[] = [];
  for (const entry of value as Array<Record<string, unknown>>) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) ||
        typeof entry.instanceId !== "string" || !INSTANCE_ID.test(entry.instanceId) ||
        typeof entry.kind !== "string" || !(LOCAL_RUNNER_KINDS as readonly string[]).includes(entry.kind) ||
        entry.kind === anchorKind || peers.some((peer) => peer.kind === entry.kind) ||
        typeof entry.port !== "number" || !isValidPort(entry.port) || entry.port === anchorPort || !ports.includes(entry.port) ||
        typeof entry.code !== "string") {
      throw new LocalRunnerHandoffError("invalid_response", "The Runner returned an invalid response. Run `aiboard` again.");
    }
    const parsed = parsePairCode(entry.code);
    if (parsed.instanceId !== entry.instanceId) {
      throw new LocalRunnerHandoffError("invalid_response", "The Runner returned an invalid response. Run `aiboard` again.");
    }
    peers.push({ instanceId: entry.instanceId, kind: entry.kind as LocalRunnerKind, port: entry.port, code: entry.code });
  }
  return peers;
}

async function exchangeAtPort(input: {
  code: string;
  expectedInstanceId: string;
  expectedKind?: LocalRunnerKind;
  port: number;
  ports: readonly number[];
  fetchImpl: FetchLike;
}): Promise<{ session: LauncherSession; peers: PeerDescriptor[] }> {
  let response: { ok: boolean; status: number; json(): Promise<unknown> };
  try {
    response = await input.fetchImpl(`http://127.0.0.1:${input.port}/v1/local-pair/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-AIBoard-Pair-Version": "1" },
      body: JSON.stringify({ version: 1, code: input.code }),
      credentials: "omit",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    throw new LocalRunnerHandoffError(
      "unreachable",
      "Could not reach the Runner on this computer. Make sure `aiboard` is still running. If your browser blocked local network access, allow it for this site (see the site information / permissions in the address bar, or your browser's local network settings), then run `aiboard` again."
    );
  }
  if (!response.ok) {
    // Generic by design: expired and consumed codes look the same, and the code is never retried.
    throw new LocalRunnerHandoffError(
      "exchange_refused",
      "This pairing code has expired or was already used. Run `aiboard` again to get a new code."
    );
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new LocalRunnerHandoffError("invalid_response", "The Runner returned an unreadable response. Run `aiboard` again.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new LocalRunnerHandoffError("invalid_response", "The Runner returned an invalid response. Run `aiboard` again.");
  }
  const record = body as Record<string, unknown>;
  if (record.version !== 1 ||
      typeof record.kind !== "string" || !(LOCAL_RUNNER_KINDS as readonly string[]).includes(record.kind) ||
      (input.expectedKind !== undefined && record.kind !== input.expectedKind) ||
      typeof record.sessionToken !== "string" || record.sessionToken.length < 1 || record.sessionToken.length > 512 ||
      !Array.isArray(record.peers) || record.peers.length > 3) {
    throw new LocalRunnerHandoffError("invalid_response", "The Runner returned an invalid response. Run `aiboard` again.");
  }
  if (record.instanceId !== input.expectedInstanceId || record.port !== input.port) {
    throw new LocalRunnerHandoffError(
      "mismatch",
      "The Runner that answered is not the one that opened this page. Close this tab and run `aiboard` again."
    );
  }
  const kind = record.kind as LocalRunnerKind;
  const peers = parsePeerDescriptors(record.peers, kind, input.port, input.ports);
  if (input.expectedKind !== undefined && peers.length > 0) {
    // A peer must never hand out further runners.
    throw new LocalRunnerHandoffError("invalid_response", "The Runner returned an invalid response. Run `aiboard` again.");
  }
  return { session: { port: input.port, instanceId: input.expectedInstanceId, kind, sessionToken: record.sessionToken }, peers };
}

export async function exchangeLocalPairCode(input: {
  code: string;
  ports: readonly number[];
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
}): Promise<CombinedLauncherSession> {
  const { code, instanceId } = parsePairCode(input.code);
  const ports = validatePorts(input.ports);
  const fetchImpl = input.fetchImpl ?? defaultFetch();
  const storage = input.storage === undefined ? defaultStorage() : input.storage;
  const anchor = await exchangeAtPort({
    code,
    expectedInstanceId: instanceId,
    port: ports[0]!,
    ports,
    fetchImpl,
  });
  storeLauncherSession(anchor.session, storage);
  const peerSessions: LauncherSession[] = [anchor.session];
  const failures: PeerExchangeFailure[] = [];
  for (const peer of anchor.peers) {
    try {
      const exchanged = await exchangeAtPort({
        code: peer.code,
        expectedInstanceId: peer.instanceId,
        expectedKind: peer.kind,
        port: peer.port,
        ports,
        fetchImpl,
      });
      storeLauncherSession(exchanged.session, storage);
      peerSessions.push(exchanged.session);
    } catch (error) {
      // Partial failure keeps the successful connections; a consumed peer
      // ticket is never retried.
      failures.push({
        kind: peer.kind,
        port: peer.port,
        message: error instanceof LocalRunnerHandoffError ? error.message : "Could not connect to this Runner. Run `aiboard` again.",
      });
    }
  }
  return { ...anchor.session, peerSessions, failures };
}

/** Manual fallback: a pasted code plus the anchor port printed by the CLI. */
export async function connectManually(input: {
  code: string;
  port: string;
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
}): Promise<CombinedLauncherSession> {
  const ports = parseRunnerPorts(input.port.trim());
  if (ports.length !== 1) {
    throw new LocalRunnerHandoffError("invalid_ports", "Enter the single Runner port printed by `aiboard`.");
  }
  return exchangeLocalPairCode({ code: input.code.trim(), ports, fetchImpl: input.fetchImpl, storage: input.storage });
}

export interface ConnectFragmentDeps {
  location: { hash: string; pathname: string; search: string };
  history: { replaceState(data: unknown, unused: string, url?: string | URL | null): void };
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
}

export type ConnectFragmentResult =
  | { status: "manual" }
  | { status: "connected"; session: CombinedLauncherSession; sessions: LauncherSession[]; failures: PeerExchangeFailure[] }
  | { status: "error"; error: LocalRunnerHandoffError };

/**
 * Read the fragment once, strip it from history before any network call, then
 * exchange it exactly once. A consumed code is never replayed.
 */
export async function consumeConnectFragment(deps: ConnectFragmentDeps): Promise<ConnectFragmentResult> {
  const hash = deps.location.hash;
  if (!hash) return { status: "manual" };
  deps.history.replaceState(null, "", `${deps.location.pathname}${deps.location.search}`);
  try {
    const { code, ports } = parseConnectFragment(hash);
    const session = await exchangeLocalPairCode({ code, ports, fetchImpl: deps.fetchImpl, storage: deps.storage });
    return { status: "connected", session, sessions: session.peerSessions, failures: session.failures };
  } catch (error) {
    return {
      status: "error",
      error: error instanceof LocalRunnerHandoffError
        ? error
        : new LocalRunnerHandoffError("unreachable", "Could not reach the Runner on this computer. Run `aiboard` again."),
    };
  }
}

/** Revoke every launcher session this tab holds and always clear them locally. */
export async function revokeLauncherSession(input: {
  fetchImpl?: FetchLike;
  storage?: StorageLike | null;
} = {}): Promise<boolean> {
  const storage = input.storage === undefined ? defaultStorage() : input.storage;
  const sessions = new Map<string, LauncherSession>();
  for (const session of Object.values(readLauncherSessions(storage))) {
    if (session) sessions.set(`${session.port}:${session.sessionToken}`, session);
  }
  if (sessions.size === 0) return false;
  let revoked = false;
  try {
    for (const session of sessions.values()) {
      try {
        const response = await (input.fetchImpl ?? defaultFetch())(`http://127.0.0.1:${session.port}/v1/local-pair/session`, {
          method: "DELETE",
          headers: { Authorization: `Bearer ${session.sessionToken}` },
          credentials: "omit",
          cache: "no-store",
          referrerPolicy: "no-referrer",
        });
        revoked = revoked || response.ok;
      } catch { /* local state is still cleared below */ }
    }
  } finally {
    clearLauncherSession(storage);
  }
  return revoked;
}
