/** Public API subscription sign-in integration: no real accounts or API keys. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

async function freePort(): Promise<number> {
  const server = net.createServer().listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aiboard-plan-oauth-"));
const authFile = path.join(tmp, "auth.json");
const legacy = { type: "oauth", access: "legacy-access", refresh: "legacy-refresh" };
fs.writeFileSync(authFile, JSON.stringify({ chatgpt: legacy }));
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signingKey = { ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "RS256", use: "sig" };
const issuer = `http://127.0.0.1:${await freePort()}`;
const apiBase = `${issuer}/v1`;
let nonce = "", challenge = "", redirect = "";
let tokenCalls = 0, refreshCalls = 0, modelCalls = 0;
let lastRefresh: URLSearchParams | undefined;
let nextTokens: Record<string, unknown> = {}, nextClaims: Record<string, unknown> = {};
let invalidSignature = false, nextStream = "complete";
let invalidGrant = false;
let lastChat: Record<string, unknown> = {};
const backend = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += String(chunk);
  res.setHeader("content-type", "application/json");
  if (req.url === "/.well-known/openid-configuration") return res.end(JSON.stringify({ issuer,
    authorization_endpoint: `${issuer}/api/accounts/authorize`, token_endpoint: `${issuer}/api/accounts/oauth/token`, jwks_uri: `${issuer}/jwks` }));
  if (req.url === "/jwks") return res.end(JSON.stringify({ keys: [signingKey] }));
  if (req.url === "/api/accounts/oauth/token") {
    tokenCalls++;
    const form = new URLSearchParams(raw);
    assert.equal(form.get("resource"), apiBase);
    assert.notEqual(form.get("client_id"), "dynamic_agent_client");
    if (form.get("grant_type") === "refresh_token") {
      refreshCalls++; lastRefresh = form;
      assert.equal(form.has("scope"), false);
      return res.end(JSON.stringify({ access_token: "renewed-access", refresh_token: "rotated-refresh", token_type: "Bearer", expires_in: 3600 }));
    }
    if (invalidGrant) { res.writeHead(400); return res.end(JSON.stringify({ error: "invalid_grant" })); }
    assert.equal(form.get("redirect_uri"), redirect);
    assert.equal(createHash("sha256").update(form.get("code_verifier")!).digest("base64url"), challenge);
    const head = Buffer.from(JSON.stringify({ alg: "RS256", kid: "test-key" })).toString("base64url");
    const claims = Buffer.from(JSON.stringify({ iss: issuer, aud: form.get("client_id"), sub: "subject-one", email: "one@example.test",
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 3600, nonce, ...nextClaims })).toString("base64url");
    const signature = sign("sha256", Buffer.from(`${head}.${claims}`), privateKey).toString("base64url");
    return res.end(JSON.stringify({ access_token: "plan-access", refresh_token: "plan-refresh", token_type: "Bearer", expires_in: 3600,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      id_token: `${head}.${claims}.${invalidSignature ? "invalid" : signature}`, ...nextTokens }));
  }
  if (req.url === "/v1/models") {
    modelCalls++;
    assert.match(String(req.headers.authorization), /^Bearer (plan-access|renewed-access)$/);
    return res.end(JSON.stringify({ models: [{ slug: "gpt-6.1-sol", display_name: "GPT-6.1 Sol", visibility: "list" }] }));
  }
  if (req.url === "/v1/responses") {
    lastChat = JSON.parse(raw);
    assert.match(String(req.headers.authorization), /^Bearer (plan-access|renewed-access)$/);
    res.setHeader("content-type", "text/event-stream");
    const events: unknown[] = [{ type: "response.output_text.delta", delta: "OK" }];
    if (nextStream === "complete") events.push({ type: "response.completed", response: { status: "completed" } });
    if (nextStream === "failed") events.push({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Plan usage limit reached" } } });
    if (nextStream === "incomplete") events.push({ type: "response.incomplete", response: { status: "incomplete" } });
    return res.end(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));
  }
  res.writeHead(404).end();
});
backend.listen(Number(new URL(issuer).port), "127.0.0.1");
await once(backend, "listening");
const runnerPort = await freePort(), runnerUrl = `http://127.0.0.1:${runnerPort}`;
const headers = { "content-type": "application/json", "x-runner-token": "test-runner-token" };
function startRunner() {
  return spawn(process.execPath, ["lib/account-provider-runner.mjs", "--port", String(runnerPort), "--token", "test-runner-token",
    "--auth-file", authFile, "--chatgpt-issuer", issuer, "--chatgpt-api-base", apiBase], { windowsHide: true, stdio: "pipe" });
}
let child = startRunner();
async function ready() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${runnerUrl}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Runner did not start");
}
const post = (route: string, body = {}) => fetch(`${runnerUrl}/providers/chatgpt/${route}`, { method: "POST", headers, body: JSON.stringify(body) });
async function login(body = {}) {
  const response = await post("login", body);
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).url);
  nonce = url.searchParams.get("nonce")!; challenge = url.searchParams.get("code_challenge")!; redirect = url.searchParams.get("redirect_uri")!;
  assert.equal(url.pathname, "/api/accounts/authorize");
  assert.equal(url.searchParams.get("resource"), apiBase);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(redirect, `${runnerUrl}/auth/callback`);
  assert.ok(nonce); assert.match(url.searchParams.get("scope")!, /chatgpt.tokens.use.direct/);
  return url;
}
async function callback(url: URL, clientId?: string, extra: Record<string, string> = {}) {
  const params = new URLSearchParams({ state: url.searchParams.get("state")!, code: "fake-code", ...extra });
  if (clientId) params.set("client_id", clientId);
  return fetch(`${runnerUrl}/auth/callback?${params}`);
}
const readAuth = () => JSON.parse(fs.readFileSync(authFile, "utf8"));
try {
  await ready();
  const status = await (await fetch(`${runnerUrl}/providers/chatgpt/status`, { headers })).json();
  assert.equal(status.requiresSignIn, true);
  assert.equal((await post("models")).status, 400); assert.equal(modelCalls, 0, "legacy token never reaches public API");
  const first = await login(), hostId = first.searchParams.get("ext_agent_host_id");
  assert.match(hostId!, /^urn:uuid:/);
  assert.equal(first.searchParams.get("client_id"), "dynamic_agent_client"); assert.equal(first.searchParams.get("agent_name_hint"), "AI Board");
  assert.equal((await callback(first, "oaiapp_one", { state: "wrong" })).status, 400);
  assert.equal((await callback(first, "oaiapp_one")).status, 200);
  assert.equal(readAuth().chatgpt.clientId, "oaiapp_one"); assert.deepEqual(readAuth().chatgptLegacy, legacy);
  assert.equal((await callback(first, "oaiapp_one")).status, 400, "callback is one-time");
  assert.equal((await (await post("models")).json()).data[0].id, "gpt-6.1-sol");
  const returning = await login();
  assert.notEqual(returning.searchParams.get("nonce"), first.searchParams.get("nonce"));
  assert.notEqual(returning.searchParams.get("state"), first.searchParams.get("state"));
  assert.equal(returning.searchParams.get("client_id"), "oaiapp_one"); assert.equal(returning.searchParams.get("ext_agent_host_id"), hostId);
  assert.equal(returning.searchParams.has("agent_name_hint"), false); assert.ok(returning.searchParams.get("id_token_hint"));
  const before = readAuth().chatgpt, beforeCalls = tokenCalls;
  assert.equal((await callback(returning, "oaiapp_different")).status, 500); assert.equal(tokenCalls, beforeCalls);
  assert.deepEqual(readAuth().chatgpt, before);
  for (const [label, claims] of Object.entries({ nonce: { nonce: "wrong" }, issuer: { iss: "https://other.example" }, audience: { aud: "other-client" }, multipleAudiences: { aud: ["oaiapp_one", "other-client"] },
    expired: { exp: 1 }, future: { iat: Math.floor(Date.now() / 1000) + 100 }, subject: { sub: "different-subject" } })) {
    nextClaims = claims;
    assert.equal((await callback(await login(), "oaiapp_one")).status, 500, `reject ${label}`);
    assert.deepEqual(readAuth().chatgpt, before, `retain credentials after invalid ${label}`);
  }
  nextClaims = {}; invalidSignature = true;
  assert.equal((await callback(await login(), "oaiapp_one")).status, 500); invalidSignature = false;
  assert.equal((await callback(await login(), undefined, { error: "access_denied" })).status, 400);
  assert.deepEqual(readAuth().chatgpt, before);
  assert.equal((await callback(await login({ newAccount: true }))).status, 500, "registration needs issued ID");
  invalidGrant = true;
  assert.equal((await callback(await login({ newAccount: true }), "oaiapp_unfinished")).status, 500);
  invalidGrant = false;
  const retryRegistration = await login();
  assert.equal(retryRegistration.searchParams.get("client_id"), "oaiapp_one", "the existing active account retains its client ID");
  nextTokens = { scope: "openid profile email", access_token: undefined, refresh_token: undefined, expires_in: undefined }; nextClaims = { sub: "subject-two", email: "two@example.test" };
  assert.equal((await callback(await login({ newAccount: true }), "oaiapp_two")).status, 200);
  assert.equal((await (await fetch(`${runnerUrl}/providers/chatgpt/status`, { headers })).json()).connected, false);
  assert.equal((await post("models")).status, 400, "identity-only sign-in cannot run inference"); assert.equal(Object.keys(readAuth().chatgptAccounts).length, 2);
  nextTokens = {}; nextClaims = {};
  assert.equal((await callback(await login({ clientId: "oaiapp_one" }), "oaiapp_one")).status, 200);
  assert.equal((await (await fetch(`${runnerUrl}/health`)).text()).includes("one@example.test"), false);
  const chat = { model: "gpt-6.1-sol", messages: [{ role: "system", content: "Be brief" }, { role: "user", content: "Say OK" }],
    functionTools: [{ name: "read_file", parameters: { type: "object", properties: {} } }], maxTokens: 10, temperature: 0.2 };
  assert.equal((await (await post("chat", chat)).json()).content, "OK");
  assert.equal(lastChat.store, false); assert.equal(lastChat.stream, true); assert.equal(lastChat.instructions, "Be brief");
  assert.equal("max_output_tokens" in lastChat, false); assert.equal("temperature" in lastChat, false);
  assert.equal((lastChat.tools as Array<{ type: string }>)[0].type, "namespace");
  for (const stream of [false, true]) for (const outcome of ["failed", "incomplete", "truncated"]) {
    nextStream = outcome;
    const response = await post("chat", { ...chat, stream }), text = await response.text();
    assert.match(text, /error/);
    if (stream) assert.equal(text.includes('"type":"done"'), false, `${outcome} cannot report success`);
    else assert.equal(response.ok, false);
    if (outcome === "failed") assert.match(text, /subscription_sharing_usage_limit_exceeded/);
  }
  child.kill(); await once(child, "exit");
  const persisted = readAuth(); persisted.chatgpt.expires = 1; persisted.chatgptAccounts.oaiapp_one.expires = 1;
  fs.writeFileSync(authFile, JSON.stringify(persisted));
  child = startRunner(); await ready();
  await Promise.all([post("models"), post("models")]);
  assert.equal(refreshCalls, 1, "serialize concurrent rotating-token refresh");
  assert.equal(lastRefresh!.get("client_id"), "oaiapp_one"); assert.equal(lastRefresh!.get("refresh_token"), "plan-refresh");
  assert.equal(readAuth().chatgpt.refresh, "rotated-refresh"); assert.equal(readAuth().chatgpt.scopes.includes("chatgpt.tokens.use.direct"), true);
  assert.equal(readAuth().chatgptHostId, hostId); assert.equal((await post("models")).status, 200); assert.equal(refreshCalls, 1);
  console.log("PASS ChatGPT plan registration, ID verification, accounts, permissions, refresh, public API discovery/inference, and stream errors");
} finally {
  child.kill(); if (child.exitCode === null) await once(child, "exit");
  backend.closeAllConnections(); await new Promise<void>((resolve) => backend.close(() => resolve()));
  fs.rmSync(tmp, { recursive: true, force: true });
}
