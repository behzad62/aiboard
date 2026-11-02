import assert from "node:assert/strict";
import { createHmac, createPublicKey, generateKeyPairSync, randomBytes, sign, verify } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ArtifactStore } from "../src/artifact-store.js";
import { createExecutionHost } from "../src/execution-host.js";
import { parseLauncherArguments } from "../src/launcher.js";
import { snapshotNativeBuildAmbientEnvironment } from "../src/native-build-factory.js";
import { canonicalJson } from "../src/remote-admission-store.js";
import { REMOTE_CONNECT_SCOPE } from "../src/remote-auth.js";
import type { RemoteTransport } from "../src/remote-connector.js";
import { RemoteDeviceStore } from "../src/remote-device-store.js";
import { machineHint, plausibleMachineId, readMachineId } from "../src/machine-hint.js";
import { RelayPairingIssuer, RemotePairingError, type PairingPresentation } from "../src/remote-pairing.js";
import { REMOTE_RELAY_ROOTS } from "../src/remote-relay-roots.js";
import { RemoteService } from "../src/remote-service.js";
import { emptyRunnerCapabilitiesConfig } from "../src/runner-capabilities-config.js";
import { parseArguments } from "../src/runner-start.js";

type Status = "pending" | "slow_down" | "denied" | "expired" | "approved";
interface FakeOptions {
  statuses?: Status[];
  wrongKey?: boolean;
  mismatchOrigin?: boolean;
  unknownSessionMember?: boolean;
  expiryMs?: number;
  rawStart?: string;
  verificationUri?: string;
  /** Answer starts carrying machineHint like a relay that predates it. */
  rejectMachineHint?: boolean;
  startStatus?: number;
}

async function fixture(t: test.TestContext, options: FakeOptions = {}) {
  const root = await mkdtemp(join(tmpdir(), "aiboard-pairing-"));
  const device = join(root, "device"), state = join(root, "state"), project = join(root, "project");
  await mkdir(device); await mkdir(state); await mkdir(project);
  const store = new RemoteDeviceStore(device);
  const identity = store.ensure();
  const relayRoot = generateKeyPairSync("ed25519");
  const wrongRoot = generateKeyPairSync("ed25519");
  const signingKey = generateKeyPairSync("ed25519");
  const rootKey = relayRoot.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const relayKey = signingKey.publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  const pairingId = randomBytes(16).toString("base64url");
  const pollSecret = randomBytes(32).toString("base64url");
  const statuses = [...(options.statuses ?? ["approved"])];
  const starts: Record<string, unknown>[] = [], polls: Record<string, unknown>[] = [];
  const serverErrors: unknown[] = [];
  const presented: PairingPresentation[] = [];
  const opened: string[] = [], sleeps: number[] = [];
  let time = Date.parse("2026-10-27T12:00:00.000Z");
  let origin = "";
  const server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      serverErrors.push(error);
      res.writeHead(500, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ error: "invalid_request" }));
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk as Uint8Array));
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.ok(input && typeof input === "object" && !Array.isArray(input));
    const body = input as Record<string, unknown>;
    assert.equal(req.method, "POST");
    assert.equal(req.headers["content-type"], "application/json");
    res.setHeader("content-type", "application/json");
    res.setHeader("cache-control", "no-store");
    if (req.url === "/pair/v2/start") {
      starts.push(body);
      const fields = ["deviceId", "issuedAt", "name", "nonce", "platform", "protocolVersion", "publicKey", "runnerVersion", "signature"];
      assert.deepEqual(Object.keys(body).sort(), ("machineHint" in body ? [...fields, "machineHint"] : fields).sort());
      if ("machineHint" in body) assert.match(String(body.machineHint), /^[A-Za-z0-9_-]{43}$/);
      assert.equal(body.protocolVersion, "1.0.0");
      assert.match(String(body.deviceId), /^device-[0-9a-f-]{36}$/);
      const { signature, ...unsigned } = body;
      const key = createPublicKey({ key: Buffer.from(String(body.publicKey), "base64url"), format: "der", type: "spki" });
      assert.equal(verify(null, Buffer.from(canonicalJson(unsigned)), key, Buffer.from(String(signature), "base64url")), true);
      if (options.rejectMachineHint && "machineHint" in body) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: "invalid_request" }));
        return;
      }
      res.statusCode = options.startStatus ?? 201;
      res.end(options.rawStart ?? JSON.stringify({ pairingId, pollSecret, userCode: "BCDF-GHJK", verificationUri: options.verificationUri ?? `${origin}/pair`,
        expiresAt: new Date(time + (options.expiryMs ?? 600_000)).toISOString(), intervalSeconds: 5 }));
      return;
    }
    assert.equal(req.url, "/pair/v2/poll");
    assert.deepEqual(body, { pairingId, pollSecret });
    polls.push(body);
    const status = statuses.shift() ?? "pending";
    if (status !== "approved") {
      res.statusCode = status === "slow_down" ? 429 : 200;
      res.end(JSON.stringify({ status }));
      return;
    }
    const envelope = {
      accountId: "account-test", clientId: "runner", scope: REMOTE_CONNECT_SCOPE, issuedAt: new Date(time).toISOString(),
      relayKeys: [{ keyId: "request-key", publicKey: relayKey }], authorizedScopes: ["scope-default"],
      relayOrigin: options.mismatchOrigin ? "https://other.example" : origin, envelopeKeyId: "test-root",
      ...(options.unknownSessionMember ? { extra: true } : {}),
    };
    const envelopeSignature = sign(null, Buffer.from(canonicalJson(envelope)), options.wrongKey ? wrongRoot.privateKey : relayRoot.privateKey).toString("base64url");
    res.end(JSON.stringify({ status, session: { ...envelope, envelopeSignature } }));
  }
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fake relay did not bind.");
  origin = `http://127.0.0.1:${address.port}`;
  const relayUrl = `ws://127.0.0.1:${address.port}/connect`;
  const makeIssuer = (target: RemoteDeviceStore = store, machineId?: string) => new RelayPairingIssuer({
    relayUrl, rootKeys: [rootKey], deviceStore: target, deviceName: "Test desktop", platform: "linux", runnerVersion: "0.1.0",
    readMachineId: async () => machineId,
    present: (value) => presented.push(value), openUrl: (uri) => opened.push(uri),
    now: () => new Date(time), sleep: async (ms) => { sleeps.push(ms); time += ms; },
  });
  t.after(async () => {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return { root, project, state, device, store, identity, rootKey, relayUrl, origin, pairingId, pollSecret, starts, polls, presented, opened, sleeps, serverErrors, makeIssuer };
}

test("signed pairing polls, verifies and saves a session which restores without another start", async (t) => {
  const h = await fixture(t, { statuses: ["pending", "pending", "approved"] });
  const logs: string[] = [];
  const original = { log: console.log, warn: console.warn, error: console.error };
  console.log = console.warn = console.error = (...args: unknown[]) => { logs.push(args.map(String).join(" ")); };
  try {
    const issuer = h.makeIssuer();
    const session = await issuer.requestSession(h.identity);
    assert.equal(h.serverErrors.length, 0);
    assert.equal(h.starts.length, 1);
    assert.equal(h.polls.length, 3);
    assert.deepEqual(h.sleeps, [5_000, 5_000, 5_000]);
    assert.deepEqual(h.presented, [{ userCode: "BCDF-GHJK", verificationUri: `${h.origin}/pair`, expiresAt: "2026-10-27T12:10:00.000Z", deviceName: "Test desktop" }]);
    assert.deepEqual(h.opened, [`${h.origin}/pair`]);
    assert.equal(session.accountId, "account-test");
    assert.equal(session.relayOrigin, h.origin);
    assert.equal("envelopeSignature" in session, false);
    assert.deepEqual(h.store.loadSession(), session);
    const restored = await h.makeIssuer().restoreSession() ?? await h.makeIssuer().requestSession(h.identity);
    assert.deepEqual(restored, session);
    assert.equal(h.starts.length, 1);
    const differentOrigin = new RelayPairingIssuer({ relayUrl: "ws://127.0.0.1:9/connect", rootKeys: [h.rootKey], deviceStore: h.store,
      present: () => assert.fail("Unexpected pairing."), openUrl: () => assert.fail("Unexpected browser open.") });
    assert.equal(await differentOrigin.restoreSession(), undefined);
    const output = JSON.stringify({ logs, presented: h.presented, opened: h.opened });
    assert.equal(output.includes(h.pollSecret), false);
    assert.equal(output.includes(String(h.starts[0]!.signature)), false);
    assert.equal(output.includes("envelopeSignature"), false);
  } finally { Object.assign(console, original); }
});

test("slow_down increases the poll interval by five seconds", async (t) => {
  const h = await fixture(t, { statuses: ["slow_down", "pending", "approved"] });
  await h.makeIssuer().requestSession(h.identity);
  assert.deepEqual(h.sleeps, [5_000, 10_000, 10_000]);
  assert.equal(h.polls.length, 3);
});

test("denial and expiry return typed errors and never save a session", async (t) => {
  const denied = await fixture(t, { statuses: ["denied"] });
  await assert.rejects(denied.makeIssuer().requestSession(denied.identity), (error: unknown) => error instanceof RemotePairingError && error.code === "pairing_denied");
  assert.equal(denied.store.loadSession(), undefined);
  const expired = await fixture(t, { expiryMs: 10_000, statuses: ["pending"] });
  await assert.rejects(expired.makeIssuer().requestSession(expired.identity), (error: unknown) => error instanceof RemotePairingError && error.code === "pairing_expired");
  assert.equal(expired.polls.length, 1);
  assert.equal(expired.store.loadSession(), undefined);
});

for (const [name, options] of [
  ["wrong root key", { wrongKey: true }], ["wrong relay origin", { mismatchOrigin: true }],
  ["unknown envelope member", { unknownSessionMember: true }],
] as const) {
  test(`refuses ${name} and saves nothing`, async (t) => {
    const h = await fixture(t, options);
    await assert.rejects(h.makeIssuer().requestSession(h.identity), (error: unknown) => error instanceof RemotePairingError && error.code === "pairing_invalid_response");
    assert.equal(h.store.loadSession(), undefined);
    assert.equal(h.store.load()!.accountId, null);
  });
}

test("duplicate JSON and a verification URL containing a code are refused", async (t) => {
  const duplicate = await fixture(t, { rawStart: '{"pairingId":"x","pairingId":"y"}' });
  await assert.rejects(duplicate.makeIssuer().requestSession(duplicate.identity), /invalid pairing JSON/);
  const url = await fixture(t, { verificationUri: "https://evil.example/pair?code=BCDF-GHJK" });
  await assert.rejects(url.makeIssuer().requestSession(url.identity), /invalid pairing response/);
  assert.deepEqual(url.opened, []);
  assert.deepEqual(url.presented, []);
});

test("custom relay pins are required and hosted pins cannot be overridden", async (t) => {
  const h = await fixture(t);
  const common = ["--project", h.project, "--state-dir", h.state, "--remote", "--remote-device-dir", h.device];
  assert.throws(() => parseArguments([...common, "--relay-url", h.relayUrl]), /requires at least one --relay-root-key/);
  assert.throws(() => parseLauncherArguments(["remote", "--relay-url", h.relayUrl]), /requires at least one --relay-root-key/);
  assert.throws(() => parseArguments([...common, "--relay-url", "wss://mcp.aiboard.me/connect", "--relay-root-key", h.rootKey]), /cannot override/);
  assert.throws(() => parseLauncherArguments(["remote", "--relay-url", "wss://mcp.aiboard.me/connect", "--relay-root-key", h.rootKey]), /cannot override/);
  assert.deepEqual(parseArguments([...common, "--relay-url", h.relayUrl, "--relay-root-key", h.rootKey, "--relay-root-key", h.rootKey]).remoteRelayRootKeys, [h.rootKey, h.rootKey]);
  assert.deepEqual(parseLauncherArguments(["remote", "--relay-url", h.relayUrl, "--relay-root-key", h.rootKey]).runnerFlags, ["--relay-url", h.relayUrl, "--relay-root-key", h.rootKey]);
});

test("hosted relay pins are distinct Ed25519 SPKI keys with ids, and production is the deployed root", () => {
  assert.deepEqual(Object.keys(REMOTE_RELAY_ROOTS).sort(), ["https://mcp-staging.aiboard.me", "https://mcp.aiboard.me"]);
  const keys = new Set<string>();
  for (const [origin, roots] of Object.entries(REMOTE_RELAY_ROOTS)) {
    assert.equal(new URL(origin).origin, origin);
    assert.equal(new URL(origin).protocol, "https:");
    assert.ok(roots.length >= 1);
    for (const root of roots) {
      assert.match(root.keyId, /^[A-Za-z0-9._:-]{1,128}$/);
      assert.doesNotMatch(`${root.keyId} ${root.publicKey}`, /placeholder/i);
      const key = createPublicKey({ key: Buffer.from(root.publicKey, "base64url"), format: "der", type: "spki" });
      assert.equal(key.asymmetricKeyType, "ed25519");
      assert.equal(key.export({ type: "spki", format: "der" }).toString("base64url"), root.publicKey);
      assert.ok(!keys.has(root.publicKey), "hosted relays never share a root key");
      keys.add(root.publicKey);
    }
  }
  // The public half of /etc/aiboard/keys/production/root-key.pem, as RELAY_ROOT_KEY_ID production-root-1 serves it.
  assert.deepEqual(REMOTE_RELAY_ROOTS["https://mcp.aiboard.me"], [
    { keyId: "production-root-1", publicKey: "MCowBQYDK2VwAyEAb11m2u0oLpR9fiLcr09V02b027fbZKS_tB1BrBGg9Kc" }]);
});

// A root-signed key set the production relay sent in a /connect challenge on 2026-11-02 (public data only).
const PRODUCTION_KEY_SET = {
  statement: {
    relayOrigin: "https://mcp.aiboard.me",
    keys: [{ keyId: "production-signing-1", publicKey: "MCowBQYDK2VwAyEA2RBKWFrMEpjHRQDQVrJrxVQC7vEQQRjpaARF32RHctI" }],
    issuedAt: "2026-11-02T06:55:19.059Z",
    expiresAt: "2026-11-03T06:55:19.059Z",
  },
  rootKeyId: "production-root-1",
  signature: "DutBRK1cuRkryrMCnIb0aT6yTNwmBR9KFt_cCt52NWRa1_LXV8o9NNPcPCU96abeFAGAaGNnvTJTWFEU8y9LBA",
};

test("a key set signed by the live production relay verifies only under the production pin, and not once altered", () => {
  const verifies = (statement: object, rootKeyId: string, roots: readonly { keyId: string; publicKey: string }[]) =>
    roots.some((root) => root.keyId === rootKeyId && verify(null, Buffer.from(canonicalJson(statement), "utf8"),
      createPublicKey({ key: Buffer.from(root.publicKey, "base64url"), format: "der", type: "spki" }),
      Buffer.from(PRODUCTION_KEY_SET.signature, "base64url")));
  const production = REMOTE_RELAY_ROOTS["https://mcp.aiboard.me"]!;
  const staging = REMOTE_RELAY_ROOTS["https://mcp-staging.aiboard.me"]!;
  assert.equal(verifies(PRODUCTION_KEY_SET.statement, PRODUCTION_KEY_SET.rootKeyId, production), true);
  assert.equal(verifies(PRODUCTION_KEY_SET.statement, "staging-root-1", staging), false);
  assert.equal(verifies(PRODUCTION_KEY_SET.statement, "other-root", production), false);
  assert.equal(verifies({ ...PRODUCTION_KEY_SET.statement, relayOrigin: "https://mcp-staging.aiboard.me" }, PRODUCTION_KEY_SET.rootKeyId, production), false);
  assert.equal(verifies({ ...PRODUCTION_KEY_SET.statement, expiresAt: "2026-11-09T06:55:19.059Z" }, PRODUCTION_KEY_SET.rootKeyId, production), false);
  const attacker = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  assert.equal(verifies({ ...PRODUCTION_KEY_SET.statement, keys: [{ keyId: "production-signing-1", publicKey: attacker }] },
    PRODUCTION_KEY_SET.rootKeyId, production), false);
});

test("a hosted relay's pins cannot be extended with --relay-root-key, even on the default relay", () => {
  const key = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64url");
  assert.throws(() => parseLauncherArguments(["remote", "--relay-root-key", key]), /require aiboard remote --relay-url/);
  assert.throws(() => parseLauncherArguments(["remote", "--relay-url", "wss://mcp-staging.aiboard.me/connect", "--relay-root-key", key]), /cannot override/);
});

for (const [origin, roots] of Object.entries(REMOTE_RELAY_ROOTS)) {
  for (const envelopeKeyId of [roots[0]!.keyId, "other-root"]) {
    test(`${origin} refuses a session signed by an unpinned key under id ${envelopeKeyId}`, async (t) => {
      const h = await fixture(t);
      const root = generateKeyPairSync("ed25519");
      const requestKey = generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "der" }).toString("base64url");
      const response = (status: number, body: unknown) => new Response(JSON.stringify(body), {
        status, headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
      const fakeFetch: typeof fetch = async (input) => {
        const target = String(input);
        if (target.endsWith("/start")) return response(201, { pairingId: h.pairingId, pollSecret: h.pollSecret,
          userCode: "BCDF-GHJK", verificationUri: `${origin}/pair`, expiresAt: "2026-10-27T12:10:00.000Z", intervalSeconds: 5 });
        const envelope = { accountId: "account-test", clientId: "runner", scope: REMOTE_CONNECT_SCOPE, issuedAt: "2026-10-27T12:00:00.000Z",
          relayKeys: [{ keyId: "request-key", publicKey: requestKey }], authorizedScopes: ["scope-default"], relayOrigin: origin, envelopeKeyId };
        return response(200, { status: "approved", session: { ...envelope,
          envelopeSignature: sign(null, Buffer.from(canonicalJson(envelope)), root.privateKey).toString("base64url") } });
      };
      const issuer = new RelayPairingIssuer({ relayUrl: `${origin.replace("https:", "wss:")}/connect`, deviceStore: h.store, fetch: fakeFetch,
        present: () => undefined, openUrl: () => undefined, now: () => new Date("2026-10-27T12:00:00Z"), sleep: async () => undefined });
      await assert.rejects(issuer.requestSession(h.identity), /signature did not verify/);
      assert.equal(h.store.loadSession(), undefined);
    });
  }
}

test("concurrent requests for one device share a single flow", async (t) => {
  const h = await fixture(t, { statuses: ["pending", "approved"] });
  const [one, two] = await Promise.all([h.makeIssuer().requestSession(h.identity), h.makeIssuer(new RemoteDeviceStore(h.device)).requestSession(h.identity)]);
  assert.deepEqual(one, two);
  assert.equal(h.starts.length, 1);
  assert.equal(h.presented.length, 1);
});

test("the pairing fence waits for another store owner and restores its completed session", async (t) => {
  const h = await fixture(t);
  const session = await h.makeIssuer().requestSession(h.identity);
  const release = h.store.acquirePairingLock();
  assert.ok(release);
  const issuer = new RelayPairingIssuer({ relayUrl: h.relayUrl, rootKeys: [h.rootKey], deviceStore: new RemoteDeviceStore(h.device),
    present: () => assert.fail("A waiting request must restore the completed session."), openUrl: () => assert.fail("Unexpected browser open."),
    sleep: async () => await new Promise<void>((resolve) => setTimeout(resolve, 5)) });
  const pending = issuer.requestSession(h.identity);
  try {
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
    assert.equal(h.starts.length, 1);
  } finally { release(); }
  assert.deepEqual(await pending, session);
  assert.equal(h.starts.length, 1);
});

test("stopping during polling releases the in-process pairing flow", async (t) => {
  const h = await fixture(t);
  const abort = new AbortController();
  let presented!: () => void;
  const ready = new Promise<void>((resolve) => { presented = resolve; });
  const issuer = new RelayPairingIssuer({ relayUrl: h.relayUrl, rootKeys: [h.rootKey], deviceStore: h.store,
    present: () => presented(), openUrl: () => undefined, signal: abort.signal,
    now: () => new Date("2026-10-27T12:00:00Z"), sleep: async () => await new Promise<void>(() => undefined) });
  const pending = issuer.requestSession(h.identity);
  await ready;
  abort.abort();
  await assert.rejects(pending, (error: unknown) => error instanceof RemotePairingError && error.code === "pairing_unavailable");
  assert.equal(h.store.loadSession(), undefined);
  await h.makeIssuer().requestSession(h.identity);
  assert.equal(h.starts.length, 2);
});

test("revoked identity rotates under its owner fence and the next service start pairs the new key", async (t) => {
  const h = await fixture(t);
  const oldKey = await readFile(join(h.device, "remote-device-key"), "utf8");
  h.store.revoke();
  const release = h.store.acquireOwnerLock(h.project);
  assert.ok(release);
  assert.throws(() => new RemoteDeviceStore(h.device).rotateIdentity(), /remote_active/);
  release();
  const artifacts = new ArtifactStore(join(h.state, "artifacts"));
  const host = createExecutionHost({ projectRoot: h.project, stateDirectory: h.state, artifacts, ambientEnvironment: snapshotNativeBuildAmbientEnvironment() });
  const transport: RemoteTransport = {
    connect: async () => { throw new Error("offline"); }, close: async () => undefined, send: () => undefined,
    onMessage: () => undefined, onClose: () => undefined,
  };
  const seen: string[] = [];
  const service = new RemoteService({ stateDirectory: h.state, deviceDirectory: h.device, workspacePath: h.project, host,
    permissionProfile: "full", capabilitiesConfig: emptyRunnerCapabilitiesConfig(), createTransport: () => transport, issuer: h.makeIssuer(),
    onStateChange: (state) => { seen.push(`${state.state}/${state.reasonCode}`); throw new Error("a notice failure is contained"); } });
  try {
    await service.start();
    // The terminal notices see the same transitions as the status file; a throwing listener cannot break the connector.
    assert.deepEqual(seen, ["authenticating/connecting", "disconnected/authentication_failed"]);
    const rotated = h.store.load()!;
    assert.notEqual(rotated.deviceId, h.identity.deviceId);
    assert.notEqual(rotated.publicKey, h.identity.publicKey);
    assert.equal(rotated.revoked, false);
    assert.equal(h.starts[0]!.deviceId, rotated.deviceId);
    assert.equal(h.starts[0]!.publicKey, rotated.publicKey);
    assert.equal(h.store.loadSession()!.accountId, "account-test");
    assert.notEqual(await readFile(join(h.device, rotated.keyFile!), "utf8"), oldKey);
  } finally { await service.close(); await host.close(); }
});

const MACHINE_ID = "4C4C4544-0042-3510-8048-B4C04F4E4B32";

test("pairing sends a signed machine hint keyed by the relay origin and never the raw machine id", async (t) => {
  const h = await fixture(t);
  await h.makeIssuer(h.store, MACHINE_ID).requestSession(h.identity);
  assert.equal(h.serverErrors.length, 0);
  assert.equal(h.starts.length, 1);
  const expected = createHmac("sha256", h.origin).update(MACHINE_ID.toLowerCase()).digest("base64url");
  assert.equal(h.starts[0]!.machineHint, expected);
  assert.equal(machineHint(h.origin, MACHINE_ID), expected);
  assert.equal(JSON.stringify(h.starts).toLowerCase().includes(MACHINE_ID.toLowerCase()), false);
  assert.notEqual(machineHint("https://mcp.aiboard.me", MACHINE_ID), machineHint("https://mcp-staging.aiboard.me", MACHINE_ID));
  assert.equal(machineHint(h.origin, ` ${MACHINE_ID.toLowerCase()}\n`), expected);
});

test("pairing without a readable machine id omits the hint and still succeeds", async (t) => {
  const h = await fixture(t);
  const session = await h.makeIssuer(h.store, undefined).requestSession(h.identity);
  assert.equal(session.accountId, "account-test");
  assert.equal("machineHint" in h.starts[0]!, false);
  const failing = await fixture(t);
  const issuer = new RelayPairingIssuer({ relayUrl: failing.relayUrl, rootKeys: [failing.rootKey], deviceStore: failing.store,
    platform: "linux", runnerVersion: "0.1.0", present: () => undefined, openUrl: () => undefined,
    now: () => new Date("2026-10-27T12:00:00Z"), sleep: async () => undefined, readMachineId: async () => { throw new Error("unreadable"); } });
  await issuer.requestSession(failing.identity);
  assert.equal("machineHint" in failing.starts[0]!, false);
});

test("re-pairing after the Runner data is wiped sends the same machine hint with a new device identity", async (t) => {
  const h = await fixture(t, { statuses: ["approved", "approved"] });
  await h.makeIssuer(h.store, MACHINE_ID).requestSession(h.identity);
  await rm(h.device, { recursive: true, force: true });
  await mkdir(h.device);
  const wiped = new RemoteDeviceStore(h.device);
  const fresh = wiped.ensure();
  assert.notEqual(fresh.deviceId, h.identity.deviceId);
  await h.makeIssuer(wiped, MACHINE_ID).requestSession(fresh);
  assert.equal(h.starts.length, 2);
  assert.equal(h.starts[1]!.deviceId, fresh.deviceId);
  assert.notEqual(h.starts[1]!.publicKey, h.starts[0]!.publicKey);
  assert.equal(h.starts[1]!.machineHint, h.starts[0]!.machineHint);
});

test("a relay that predates machine hints gets one retry without the hint", async (t) => {
  const h = await fixture(t, { rejectMachineHint: true });
  const session = await h.makeIssuer(h.store, MACHINE_ID).requestSession(h.identity);
  assert.equal(session.accountId, "account-test");
  assert.equal(h.starts.length, 2);
  assert.equal(typeof h.starts[0]!.machineHint, "string");
  assert.equal("machineHint" in h.starts[1]!, false);
  assert.notEqual(h.starts[1]!.nonce, h.starts[0]!.nonce);
  // Without a hint there is nothing to drop: a 400 is not retried.
  const plain = await fixture(t, { startStatus: 400, rawStart: JSON.stringify({ error: "invalid_request" }) });
  await assert.rejects(plain.makeIssuer(plain.store, undefined).requestSession(plain.identity), /invalid pairing response/);
  assert.equal(plain.starts.length, 1);
});

test("machine ids are validated and the host reader never throws", async () => {
  assert.equal(plausibleMachineId("0123456789abcdef0123456789ABCDEF\n"), "0123456789abcdef0123456789abcdef");
  assert.equal(plausibleMachineId(MACHINE_ID), MACHINE_ID.toLowerCase());
  for (const value of [undefined, "", "   ", "00000000-0000-0000-0000-000000000000", "not-a-machine-id", "0123456789abcdef"]) {
    assert.equal(plausibleMachineId(value), undefined);
  }
  const id = await readMachineId();
  assert.ok(id === undefined || plausibleMachineId(id) === id);
  assert.equal(await readMachineId("aix"), undefined);
});
