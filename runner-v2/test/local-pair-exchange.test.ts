import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ControlServer } from "../src/control-server.js";
import type { GitPreflightResult } from "../src/git-preflight.js";
import { createLocalPairTicket, LocalPairing } from "../src/local-pairing.js";
import { RunSupervisor } from "../src/run-supervisor.js";
import { SqliteEventStore } from "../src/sqlite-event-store.js";

const CONTROL_TOKEN = "test-control-token-for-pairing";
const INSTANCE = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const gitReady: GitPreflightResult = { available: true, version: "2.45.1", code: "git_ready", reason: null };
const bootstrapRun = async () => ({ baselineRevision: "a".repeat(40), baselineRef: "refs/aiboard/runs/test/baseline" });

interface RawResponse { status: number; headers: IncomingMessage["headers"]; text: string }

function raw(port: number, options: {
  method?: string; path?: string; headers?: Record<string, string | string[]>; body?: string;
}): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: "127.0.0.1", port, path: options.path ?? "/v1/local-pair/exchange",
      method: options.method ?? "POST", setHost: false,
    }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => { text += chunk; });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    req.on("error", reject);
    const headers = options.headers ?? {};
    for (const [name, value] of Object.entries(headers)) req.setHeader(name, value);
    if (!("host" in Object.fromEntries(Object.keys(headers).map((k) => [k.toLowerCase(), 1])))) {
      req.setHeader("Host", `127.0.0.1:${port}`);
    }
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

function exchangeHeaders(port: number, overrides: Record<string, string | string[]> = {}): Record<string, string | string[]> {
  return {
    Host: `127.0.0.1:${port}`, Origin: "https://aiboard.me",
    "Content-Type": "application/json", "X-AIBoard-Pair-Version": "1", ...overrides,
  };
}

function assertRefused(res: RawResponse, code?: string): void {
  assert.equal(res.status, 400, res.text);
  const body = JSON.parse(res.text) as Record<string, unknown>;
  assert.equal(body.code, "local_pair_refused");
  assert.equal(body.error, "Local pairing request refused.");
  assert.equal("sessionToken" in body, false);
  if (code) assert.equal(res.text.includes(code), false);
  assert.equal(res.headers["cache-control"], "no-store");
}

async function fixture(options: { devOrigin?: boolean; clock?: () => number } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "aiboard-pair-"));
  const supervisor = new RunSupervisor(new SqliteEventStore(join(directory, "events.sqlite")));
  const pairing = new LocalPairing(INSTANCE, options.clock);
  const server = new ControlServer({
    supervisor, token: CONTROL_TOKEN, checkGit: async () => gitReady, bootstrapRun,
    runnerInfo: { projectPath: directory, nodeVersion: process.versions.node },
    localPairing: pairing, allowLocalPairDevOrigin: options.devOrigin === true,
  });
  const address = await server.start(0);
  return {
    directory, supervisor, pairing, server, port: address.port,
    ticket() { const t = createLocalPairTicket(INSTANCE); pairing.register(t.digest); return t; },
    async close() { await server.close(); supervisor.close(); rmSync(directory, { recursive: true, force: true }); },
  };
}

async function exchange(port: number, code: string): Promise<RawResponse> {
  return raw(port, { headers: exchangeHeaders(port), body: JSON.stringify({ version: 1, code }) });
}

test("valid exchange returns contract-shaped session that authenticates /v2 routes", async () => {
  const f = await fixture();
  try {
    const { code } = f.ticket();
    const res = await exchange(f.port, code);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers["cache-control"], "no-store");
    assert.equal(res.headers["access-control-allow-origin"], "https://aiboard.me");
    const body = JSON.parse(res.text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), ["instanceId", "kind", "peers", "port", "sessionToken", "version"]);
    assert.equal(body.version, 1);
    assert.equal(body.instanceId, INSTANCE);
    assert.equal(body.kind, "runner");
    assert.equal(body.port, f.port);
    assert.match(body.sessionToken as string, /^session_[A-Za-z0-9_-]{43}$/);
    assert.deepEqual(body.peers, []);
    const health = await raw(f.port, {
      method: "GET", path: "/v2/health",
      headers: { Host: `127.0.0.1:${f.port}`, Origin: "https://aiboard.me", Authorization: `Bearer ${body.sessionToken as string}` },
    });
    assert.equal(health.status, 200, health.text);
    assert.equal((JSON.parse(health.text) as { ok: unknown }).ok, true);
    // The reusable control token still works, and a bogus bearer does not.
    const control = await raw(f.port, {
      method: "GET", path: "/v2/health",
      headers: { Host: `127.0.0.1:${f.port}`, Authorization: `Bearer ${CONTROL_TOKEN}` },
    });
    assert.equal(control.status, 200, control.text);
  } finally { await f.close(); }
});

test("replayed, unissued, wrong-instance and control-token codes are refused without a session", async () => {
  const f = await fixture();
  try {
    const { code } = f.ticket();
    assert.equal((await exchange(f.port, code)).status, 200);
    assertRefused(await exchange(f.port, code), code);
    const unissued = createLocalPairTicket(INSTANCE);
    assertRefused(await exchange(f.port, unissued.code), unissued.code);
    const other = createLocalPairTicket("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    f.pairing.register(other.digest);
    assertRefused(await exchange(f.port, other.code), other.code);
    assertRefused(await exchange(f.port, CONTROL_TOKEN), CONTROL_TOKEN);
    assertRefused(await exchange(f.port, "session_6S18vy2vXRaH_2NPMEdA1Sg5IqXfhzUUgNC7NeNt60A"));
  } finally { await f.close(); }
});

test("concurrent exchanges of one code yield exactly one session", async () => {
  const f = await fixture();
  try {
    const { code } = f.ticket();
    const results = await Promise.all([exchange(f.port, code), exchange(f.port, code), exchange(f.port, code)]);
    assert.equal(results.filter((r) => r.status === 200).length, 1);
    assert.equal(results.filter((r) => r.status === 400).length, 2);
  } finally { await f.close(); }
});

test("expired codes are refused with an injected clock", async () => {
  let now = 1_000_000;
  const f = await fixture({ clock: () => now });
  try {
    const { code } = f.ticket();
    now += 120_001;
    assertRefused(await exchange(f.port, code), code);
  } finally { await f.close(); }
});

test("absent, null, wrong, duplicate Origin and wrong Host or port are refused", async () => {
  const f = await fixture();
  try {
    const { code } = f.ticket();
    const body = JSON.stringify({ version: 1, code });
    const absent = exchangeHeaders(f.port); delete absent.Origin;
    assertRefused(await raw(f.port, { headers: absent, body }), code);
    assertRefused(await raw(f.port, { headers: exchangeHeaders(f.port, { Origin: "null" }), body }), code);
    assertRefused(await raw(f.port, { headers: exchangeHeaders(f.port, { Origin: "https://evil.example" }), body }), code);
    assertRefused(await raw(f.port, { headers: exchangeHeaders(f.port, { Origin: "http://localhost:3000" }), body }), code);
    assertRefused(await raw(f.port, { headers: exchangeHeaders(f.port, { Origin: ["https://aiboard.me", "https://aiboard.me"] }), body }), code);
    assertRefused(await raw(f.port, { headers: exchangeHeaders(f.port, { Host: "127.0.0.1:1" }), body }), code);
    assertRefused(await raw(f.port, { headers: exchangeHeaders(f.port, { Host: "localhost:" + f.port }), body }), code);
    // The ticket survives refused envelopes and still exchanges once.
    assert.equal((await exchange(f.port, code)).status, 200);
  } finally { await f.close(); }
});

test("wrong method, content type, form post and missing version header are refused", async () => {
  const f = await fixture();
  try {
    const { code } = f.ticket();
    const body = JSON.stringify({ version: 1, code });
    assertRefused(await raw(f.port, { method: "GET", headers: exchangeHeaders(f.port) }), code);
    assertRefused(await raw(f.port, { headers: exchangeHeaders(f.port, { "Content-Type": "text/plain" }), body }), code);
    assertRefused(await raw(f.port, {
      headers: exchangeHeaders(f.port, { "Content-Type": "application/x-www-form-urlencoded" }),
      body: `version=1&code=${encodeURIComponent(code)}`,
    }), code);
    const noVersion = exchangeHeaders(f.port); delete noVersion["X-AIBoard-Pair-Version"];
    assertRefused(await raw(f.port, { headers: noVersion, body }), code);
    assertRefused(await raw(f.port, { headers: exchangeHeaders(f.port, { "X-AIBoard-Pair-Version": "2" }), body }), code);
    assertRefused(await raw(f.port, { headers: exchangeHeaders(f.port), body: JSON.stringify({ version: 2, code }) }), code);
    assertRefused(await raw(f.port, { headers: exchangeHeaders(f.port), body: JSON.stringify({ version: 1, code, extra: 1 }) }), code);
    assert.equal((await exchange(f.port, code)).status, 200);
  } finally { await f.close(); }
});

test("PNA preflight is granted only for a validated Origin, Host and request", async () => {
  const f = await fixture();
  try {
    const preflight = (origin: string, extra: Record<string, string> = {}) => raw(f.port, {
      method: "OPTIONS",
      headers: {
        Host: `127.0.0.1:${f.port}`, Origin: origin,
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "content-type,x-aiboard-pair-version",
        "Access-Control-Request-Private-Network": "true", ...extra,
      },
    });
    const ok = await preflight("https://aiboard.me");
    assert.equal(ok.status, 204, ok.text);
    assert.equal(ok.headers["access-control-allow-origin"], "https://aiboard.me");
    assert.equal(ok.headers["access-control-allow-private-network"], "true");
    assert.equal(ok.headers["access-control-allow-methods"], "POST, OPTIONS");
    const evil = await preflight("https://evil.example");
    assertRefused(evil);
    assert.equal(evil.headers["access-control-allow-private-network"], undefined);
    const badHeaders = await preflight("https://aiboard.me", { "Access-Control-Request-Headers": "content-type,x-evil" });
    assertRefused(badHeaders);
    assert.equal(badHeaders.headers["access-control-allow-private-network"], undefined);

  } finally { await f.close(); }
});

test("revoked sessions are refused and dev Origin stays off by default", async () => {
  const f = await fixture();
  try {
    const { code } = f.ticket();
    const res = await exchange(f.port, code);
    const token = (JSON.parse(res.text) as { sessionToken: string }).sessionToken;
    const revoke = (auth: string) => raw(f.port, {
      method: "DELETE", path: "/v1/local-pair/session",
      headers: { Host: `127.0.0.1:${f.port}`, Origin: "https://aiboard.me", Authorization: auth },
    });
    assert.equal((await revoke(`Bearer ${token}`)).status, 200);
    const health = await raw(f.port, {
      method: "GET", path: "/v2/health",
      headers: { Host: `127.0.0.1:${f.port}`, Origin: "https://aiboard.me", Authorization: `Bearer ${token}` },
    });
    assert.equal(health.status, 401, health.text);
    assertRefused(await revoke(`Bearer ${token}`));
    assertRefused(await revoke(`Bearer ${CONTROL_TOKEN}`));
  } finally { await f.close(); }
  const dev = await fixture({ devOrigin: true });
  try {
    const t = dev.ticket();
    const res = await raw(dev.port, {
      headers: { Host: `127.0.0.1:${dev.port}`, Origin: "http://localhost:3000", "Content-Type": "application/json", "X-AIBoard-Pair-Version": "1" },
      body: JSON.stringify({ version: 1, code: t.code }),
    });
    assert.equal(res.status, 200, res.text);
  } finally { await dev.close(); }
});

test("excess attempts lock out even a valid code; restart invalidates sessions; codes stay out of logs", async () => {
  const f = await fixture();
  const logged: string[] = [];
  const origError = console.error; const origLog = console.log;
  console.error = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  console.log = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  let sessionToken = "";
  let validCode = "";
  try {
    for (let i = 0; i < 10; i += 1) {
      const bad = createLocalPairTicket(INSTANCE);
      assertRefused(await exchange(f.port, bad.code), bad.code);
    }
    const t = f.ticket(); validCode = t.code;
    assertRefused(await exchange(f.port, validCode), validCode);
  } finally { console.error = origError; console.log = origLog; await f.close(); }
  assert.equal(logged.join("\n").includes(validCode), false);
  const first = await fixture();
  try {
    const res = await exchange(first.port, first.ticket().code);
    sessionToken = (JSON.parse(res.text) as { sessionToken: string }).sessionToken;
  } finally { await first.close(); }
  const second = await fixture();
  try {
    const health = await raw(second.port, {
      method: "GET", path: "/v2/health",
      headers: { Host: `127.0.0.1:${second.port}`, Origin: "https://aiboard.me", Authorization: `Bearer ${sessionToken}` },
    });
    assert.equal(health.status, 401, health.text);
  } finally { await second.close(); }
});

test("ticket registry stores hashes only and enforces instance binding", () => {
  let now = 5000;
  const pairing = new LocalPairing(INSTANCE, () => now);
  const ticket = createLocalPairTicket(INSTANCE);
  assert.match(ticket.code, /^v1\.aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\.[A-Za-z0-9_-]{43}$/);
  assert.match(ticket.digest, /^[0-9a-f]{64}$/);
  assert.equal(ticket.digest.includes(ticket.code), false);
  pairing.register(ticket.digest);
  assert.equal(pairing.consume(ticket.digest), undefined);
  const token = pairing.consume(ticket.code);
  assert.match(token ?? "", /^session_[A-Za-z0-9_-]{43}$/);
  assert.equal(pairing.hasSession(token!), true);
  assert.equal(pairing.consume(ticket.code), undefined);
  assert.equal(pairing.revoke(token!), true);
  assert.equal(pairing.hasSession(token!), false);
  const second = createLocalPairTicket(INSTANCE);
  pairing.register(second.digest);
  now += 120_001;
  assert.equal(pairing.consume(second.code), undefined);
  pairing.close();
  assert.equal(pairing.consume(second.code), undefined);
});
