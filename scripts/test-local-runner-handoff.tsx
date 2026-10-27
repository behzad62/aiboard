import assert from "node:assert/strict";

import {
  clearLauncherSession,
  connectManually,
  consumeConnectFragment,
  discussionNeedsLauncherReconnect,
  exchangeLocalPairCode,
  getLauncherConnection,
  getLocalRunnerMetadata,
  LocalRunnerHandoffError,
  parseConnectFragment,
  parseRunnerPorts,
  readLauncherSession,
  resolveRunnerConnection,
  revokeLauncherSession,
  sanitizeRunnerTokenForPersistence,
  storeLauncherSession,
  withResolvedRunnerToken,
  type FetchLike,
  type StorageLike,
} from "../lib/client/local-runner-handoff";

const INSTANCE = "inst_abc-123";
const SECRET = "A".repeat(43);
const CODE = `v1.${INSTANCE}.${SECRET}`;
const SESSION_TOKEN = `session_${"B".repeat(43)}`;

function memoryStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => map.get(key) ?? null,
    setItem: (key, value) => { map.set(key, value); },
    removeItem: (key) => { map.delete(key); },
  };
}

function okFetch(body: unknown, events?: string[]): FetchLike & { calls: Array<{ url: string; init?: Record<string, unknown> }> } {
  const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
  const impl = (async (url: string, init?: Record<string, unknown>) => {
    calls.push({ url, init });
    events?.push("fetch");
    return { ok: true, status: 200, json: async () => body };
  }) as FetchLike & { calls: typeof calls };
  impl.calls = calls;
  return impl;
}

async function expectHandoffError(promise: Promise<unknown>, kind: string): Promise<LocalRunnerHandoffError> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof LocalRunnerHandoffError, `expected LocalRunnerHandoffError, got ${String(error)}`);
    assert.equal(error.kind, kind);
    assert.ok(!error.message.includes(CODE), "error must not echo the pairing code");
    assert.ok(!error.message.includes(SESSION_TOKEN), "error must not echo the session token");
    return error;
  }
  assert.fail(`expected ${kind} error`);
}

async function main(): Promise<void> {
// --- Fragment parsing: decimal loopback ports only, 1..4, 1024..65535 ---
assert.deepEqual(parseRunnerPorts("8787"), [8787]);
assert.deepEqual(parseRunnerPorts("8787,8788"), [8787, 8788]);
for (const bad of [
  "example.com", "127.0.0.1:8787", "localhost:8787", "0x2233", "87 87", "",
  "80", "1023", "65536", "99999", "08787", "-8787", "8787,8787",
  "1,2,3,4,5", "8787,", ",8787", "8787,,8788",
]) {
  assert.throws(
    () => parseRunnerPorts(bad),
    (error: unknown) => error instanceof LocalRunnerHandoffError && error.kind === "invalid_ports",
    `port list ${JSON.stringify(bad)} must be rejected`
  );
}
assert.deepEqual(
  parseConnectFragment(`#pair=${CODE}&runners=8787,8788`),
  { code: CODE, instanceId: INSTANCE, ports: [8787, 8788] }
);
for (const badHash of [
  "", "#", `#pair=${CODE}`, "#runners=8787", `#pair=${CODE}&runners=8787&extra=1`,
  `#pair=${CODE}&pair=${CODE}&runners=8787`, `#pair=bad&runners=8787`,
  `#pair=${CODE}&runners=example.com`, `#pair=${CODE}&runners=99999`,
  `#pair=v1.${INSTANCE}.short&runners=8787`, `#pair=${CODE}x&runners=8787`,
]) {
  assert.throws(
    () => parseConnectFragment(badHash),
    (error: unknown) => error instanceof LocalRunnerHandoffError,
    `fragment ${JSON.stringify(badHash.slice(0, 40))} must be rejected`
  );
}

// --- Fragment stripped before any network call; no request for malformed input ---
{
  const storage = memoryStorage();
  const events: string[] = [];
  const fetchImpl = okFetch(
    { version: 1, instanceId: INSTANCE, kind: "runner", port: 8787, sessionToken: SESSION_TOKEN, peers: [] },
    events
  );
  let strippedUrl = "";
  const result = await consumeConnectFragment({
    location: { hash: `#pair=${CODE}&runners=8787`, pathname: "/connect", search: "" },
    history: { replaceState: (_data, _unused, url) => { events.push("replaceState"); strippedUrl = String(url); } },
    fetchImpl,
    storage,
  });
  assert.equal(result.status, "connected");
  assert.deepEqual(events, ["replaceState", "fetch"], "fragment must be stripped before the exchange");
  assert.ok(!strippedUrl.includes("pair") && !strippedUrl.includes(CODE), "stripped URL must not contain the code");
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0]!.url, "http://127.0.0.1:8787/v1/local-pair/exchange");
  const init = fetchImpl.calls[0]!.init as { headers: Record<string, string>; body: string; credentials?: string };
  assert.equal(init.headers["X-AIBoard-Pair-Version"], "1");
  assert.equal(init.credentials, "omit");
  assert.deepEqual(JSON.parse(init.body), { version: 1, code: CODE });

  // Session lives in sessionStorage (tab-scoped) + memory only.
  assert.equal(readLauncherSession(storage)?.sessionToken, SESSION_TOKEN);
  assert.equal(storage.map.size, 1);
  assert.ok([...storage.map.values()].join("").includes(SESSION_TOKEN));
  assert.deepEqual(getLocalRunnerMetadata(storage), { port: 8787, instanceId: INSTANCE, kind: "runner" });
  assert.deepEqual(getLauncherConnection(storage), { url: "http://127.0.0.1:8787", token: SESSION_TOKEN, source: "launcher" });
  clearLauncherSession(storage);
  assert.equal(readLauncherSession(storage), null);
  assert.equal(storage.map.size, 0);
}

{
  // Malformed fragment: still stripped, but no network call at all.
  const events: string[] = [];
  const fetchImpl = okFetch({}, events);
  const result = await consumeConnectFragment({
    location: { hash: `#pair=${CODE}&runners=example.com`, pathname: "/connect", search: "" },
    history: { replaceState: () => { events.push("replaceState"); } },
    fetchImpl,
    storage: memoryStorage(),
  });
  assert.equal(result.status, "error");
  assert.deepEqual(events, ["replaceState"]);
  assert.equal(fetchImpl.calls.length, 0);
}

{
  // No fragment: manual mode, nothing stripped, no request.
  const fetchImpl = okFetch({});
  const result = await consumeConnectFragment({
    location: { hash: "", pathname: "/connect", search: "" },
    history: { replaceState: () => assert.fail("nothing to strip") },
    fetchImpl,
    storage: memoryStorage(),
  });
  assert.equal(result.status, "manual");
  assert.equal(fetchImpl.calls.length, 0);
}

// --- Instance / port mismatch is rejected and stores nothing ---
{
  const storage = memoryStorage();
  const fetchImpl = okFetch({ version: 1, instanceId: "other_inst", kind: "runner", port: 8787, sessionToken: SESSION_TOKEN, peers: [] });
  await expectHandoffError(
    exchangeLocalPairCode({ code: CODE, ports: [8787], fetchImpl, storage }),
    "mismatch"
  );
  assert.equal(readLauncherSession(storage), null);
}
{
  const storage = memoryStorage();
  const fetchImpl = okFetch({ version: 1, instanceId: INSTANCE, kind: "runner", port: 9999, sessionToken: SESSION_TOKEN, peers: [] });
  await expectHandoffError(
    exchangeLocalPairCode({ code: CODE, ports: [8787], fetchImpl, storage }),
    "mismatch"
  );
  assert.equal(readLauncherSession(storage), null);
}
{
  // A peer port outside the original list is an invalid response.
  const storage = memoryStorage();
  const fetchImpl = okFetch({
    version: 1, instanceId: INSTANCE, kind: "runner", port: 8787, sessionToken: SESSION_TOKEN,
    peers: [{ instanceId: "peer1", kind: "runner", port: 4242, code: "peer-code" }],
  });
  await expectHandoffError(
    exchangeLocalPairCode({ code: CODE, ports: [8787], fetchImpl, storage }),
    "invalid_response"
  );
  assert.equal(readLauncherSession(storage), null);
}

// --- Consumed/expired code: one attempt, clear status, never retried ---
{
  const storage = memoryStorage();
  let attempts = 0;
  const fetchImpl = (async () => {
    attempts += 1;
    return { ok: false, status: 400, json: async () => ({ error: "Local pairing request refused.", code: "local_pair_refused" }) };
  }) as FetchLike;
  const error = await expectHandoffError(
    exchangeLocalPairCode({ code: CODE, ports: [8787], fetchImpl, storage }),
    "exchange_refused"
  );
  assert.match(error.message, /expired or was already used/);
  assert.equal(attempts, 1, "a refused code must not be retried");
  assert.equal(readLauncherSession(storage), null);
}

// --- Runner unreachable / local-network access blocked ---
{
  const fetchImpl = (async () => { throw new TypeError("Failed to fetch"); }) as FetchLike;
  const error = await expectHandoffError(
    exchangeLocalPairCode({ code: CODE, ports: [8787], fetchImpl, storage: memoryStorage() }),
    "unreachable"
  );
  assert.match(error.message, /local network access/);
  assert.match(error.message, /allow it/);
}

// --- Oversized code rejected before any request ---
{
  const fetchImpl = okFetch({});
  await expectHandoffError(
    exchangeLocalPairCode({ code: `v1.${INSTANCE}.${"A".repeat(600)}`, ports: [8787], fetchImpl, storage: memoryStorage() }),
    "invalid_code"
  );
  assert.equal(fetchImpl.calls.length, 0);
}

// --- Manual fallback: paste code + port ---
{
  const storage = memoryStorage();
  const fetchImpl = okFetch({ version: 1, instanceId: INSTANCE, kind: "runner", port: 8787, sessionToken: SESSION_TOKEN, peers: [] });
  const session = await connectManually({ code: CODE, port: "8787", fetchImpl, storage });
  assert.equal(session.sessionToken, SESSION_TOKEN);
  assert.equal(getLauncherConnection(storage)?.url, "http://127.0.0.1:8787");
  clearLauncherSession(storage);

  const badFetch = okFetch({});
  await expectHandoffError(
    connectManually({ code: CODE, port: "example.com:8787", fetchImpl: badFetch, storage: memoryStorage() }),
    "invalid_ports"
  );
  assert.equal(badFetch.calls.length, 0);
}

// --- Consumers resolve the launcher session first, legacy token second ---
{
  const storage = memoryStorage();
  storeLauncherSession({ port: 8787, instanceId: INSTANCE, kind: "runner", sessionToken: SESSION_TOKEN }, storage);
  assert.deepEqual(
    resolveRunnerConnection({ runnerUrl: "http://127.0.0.1:8787", runnerToken: "manual-token" }, storage),
    { url: "http://127.0.0.1:8787", token: SESSION_TOKEN, source: "launcher" }
  );
  // A launcher for a different port must not hijack a different Runner's URL.
  assert.deepEqual(
    resolveRunnerConnection({ runnerUrl: "http://127.0.0.1:9999", runnerToken: "manual-token" }, storage),
    { url: "http://127.0.0.1:9999", token: "manual-token", source: "manual" }
  );
  assert.equal(resolveRunnerConnection({ runnerUrl: "http://127.0.0.1:9999", runnerToken: null }, storage), null);
  assert.equal(discussionNeedsLauncherReconnect({ runnerUrl: "http://127.0.0.1:9999", runnerToken: null }, storage), true);
  assert.equal(discussionNeedsLauncherReconnect({ runnerUrl: "http://127.0.0.1:8787", runnerToken: null }, storage), false);

  // In-memory fill-in for display/polling; the persisted record stays clean.
  const resolved = withResolvedRunnerToken({ runnerUrl: "http://127.0.0.1:8787", runnerToken: null }, storage);
  assert.equal(resolved?.runnerToken, SESSION_TOKEN);

  // Persistence sanitizer: launcher token becomes null, manual token untouched.
  assert.equal(sanitizeRunnerTokenForPersistence(SESSION_TOKEN, storage), null);
  assert.equal(sanitizeRunnerTokenForPersistence("manual-token", storage), "manual-token");
  const persisted = { runnerUrl: "http://127.0.0.1:8787", runnerToken: sanitizeRunnerTokenForPersistence(SESSION_TOKEN, storage) };
  assert.ok(!JSON.stringify(persisted).includes(SESSION_TOKEN), "persisted Discussion must not contain the session token");

  clearLauncherSession(storage);
  // No session in this tab: legacy manual setup still works unchanged.
  assert.deepEqual(
    resolveRunnerConnection({ runnerUrl: "http://127.0.0.1:8787", runnerToken: "manual-token" }, storage),
    { url: "http://127.0.0.1:8787", token: "manual-token", source: "manual" }
  );
  assert.equal(resolveRunnerConnection({ runnerUrl: "http://127.0.0.1:8787", runnerToken: null }, storage), null);
  assert.equal(discussionNeedsLauncherReconnect({ runnerUrl: "http://127.0.0.1:8787", runnerToken: null }, storage), true);
}

// --- Revoke: DELETE with the session token, local state always cleared ---
{
  const storage = memoryStorage();
  storeLauncherSession({ port: 8787, instanceId: INSTANCE, kind: "runner", sessionToken: SESSION_TOKEN }, storage);
  const calls: Array<{ url: string; init?: Record<string, unknown> }> = [];
  const fetchImpl = (async (url: string, init?: Record<string, unknown>) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ version: 1 }) };
  }) as FetchLike;
  assert.equal(await revokeLauncherSession({ fetchImpl, storage }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.url, "http://127.0.0.1:8787/v1/local-pair/session");
  assert.equal((calls[0]!.init as { method: string }).method, "DELETE");
  assert.equal((calls[0]!.init as { headers: Record<string, string> }).headers.Authorization, `Bearer ${SESSION_TOKEN}`);
  assert.equal(readLauncherSession(storage), null);
  assert.equal(storage.map.size, 0);
  // Revoking with no session is a no-op and makes no request.
  assert.equal(await revokeLauncherSession({ fetchImpl, storage }), false);
  assert.equal(calls.length, 1);
}

console.log("PASS local runner handoff");
}

void main();
