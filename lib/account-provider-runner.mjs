/** AI Board account-provider runner: localhost OAuth bridge for ChatGPT Plus/Pro and GitHub Copilot. */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 1;
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const port = Number(flag("port") ?? 8788);
const host = flag("host") ?? "127.0.0.1";
const token = flag("token") ?? randomBytes(16).toString("hex");
const authFile = flag("auth-file") ?? path.join(os.homedir(), ".aiboard-account-provider-runner.json");
const CHATGPT_ISSUER = "https://auth.openai.com";
const CHATGPT_CODEX_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const CHATGPT_CLIENT_ID = flag("chatgpt-client-id") ?? process.env.AIBOARD_CHATGPT_CLIENT_ID ?? "app_EMoamEEZ73f0CkXaXp7hrann";
const GITHUB_CLIENT_ID = flag("github-client-id") ?? process.env.AIBOARD_GITHUB_COPILOT_CLIENT_ID ?? "Ov23li8tweQw6odWQebz";
const GITHUB_API_BASE = "https://api.githubcopilot.com";
const GITHUB_API_VERSION = "2026-06-01";
const POLL_SAFETY_MS = 3000;

let chatgptPending;
let githubLoginPoll;
let authStore = loadAuthStore();

function loadAuthStore() {
  try {
    if (!fs.existsSync(authFile)) return {};
    const parsed = JSON.parse(fs.readFileSync(authFile, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
function saveAuthStore() {
  fs.mkdirSync(path.dirname(authFile), { recursive: true });
  fs.writeFileSync(authFile, JSON.stringify(authStore, null, 2), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(authFile, 0o600); } catch {}
}
function sameToken(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}
function authorized(req) { return sameToken(req.headers["x-runner-token"], token); }
function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = typeof origin === "string" && (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) || origin === "https://aiboard.me");
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-runner-token",
    "Access-Control-Max-Age": "600",
  };
}
function json(req, res, status, body) { res.writeHead(status, { "content-type": "application/json", ...corsHeaders(req) }); res.end(JSON.stringify(body)); }
function html(req, res, status, body) { res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...corsHeaders(req) }); res.end(body); }
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => { data += chunk; if (data.length > 2 * 1024 * 1024) reject(new Error("Body too large")); });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}
function parseJsonBody(raw) { return raw.trim() ? JSON.parse(raw) : {}; }
function base64Url(value) { return Buffer.from(value).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function randomState() { return base64Url(randomBytes(32)); }
function generatePkce() { const verifier = base64Url(randomBytes(32)); return { verifier, challenge: base64Url(createHash("sha256").update(verifier).digest()) }; }
function escapeHtml(value) { return String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
function successPage(provider) { return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;margin:3rem"><h1>${provider} connected</h1><p>You can close this tab and return to AI Board.</p></body>`; }
function errorPage(provider, message) { return `<!doctype html><meta charset="utf-8"><body style="font-family:system-ui;margin:3rem"><h1>${provider} login failed</h1><p>${escapeHtml(message)}</p></body>`; }
function parseJwtClaims(tokenValue) {
  const parts = String(tokenValue).split(".");
  if (parts.length !== 3) return undefined;
  try { return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")); } catch { return undefined; }
}
function extractChatGptAccountId(tokens) {
  const claims = tokens.id_token ? parseJwtClaims(tokens.id_token) : tokens.access_token ? parseJwtClaims(tokens.access_token) : undefined;
  return claims?.chatgpt_account_id || claims?.["https://api.openai.com/auth"]?.chatgpt_account_id || claims?.organizations?.[0]?.id;
}
function buildChatGptAuthorizeUrl(redirectUri, pkce, state) {
  const params = new URLSearchParams({
    response_type: "code", client_id: CHATGPT_CLIENT_ID, redirect_uri: redirectUri,
    scope: "openid profile email offline_access", code_challenge: pkce.challenge, code_challenge_method: "S256",
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", state, originator: "aiboard",
  });
  return `${CHATGPT_ISSUER}/oauth/authorize?${params.toString()}`;
}
async function exchangeChatGptCode(code, redirectUri, pkce) {
  const response = await fetch(`${CHATGPT_ISSUER}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, client_id: CHATGPT_CLIENT_ID, code_verifier: pkce.verifier }).toString(),
  });
  if (!response.ok) throw new Error(`Token exchange failed: ${response.status}`);
  return response.json();
}
async function refreshChatGptToken() {
  const current = authStore.chatgpt;
  if (!current?.refresh) throw new Error("ChatGPT is not connected. Use Log in with OpenAI first.");
  if (current.access && current.expires && current.expires > Date.now() + 60_000) return current;
  const response = await fetch(`${CHATGPT_ISSUER}/oauth/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: current.refresh, client_id: CHATGPT_CLIENT_ID }).toString(),
  });
  if (!response.ok) throw new Error(`Token refresh failed: ${response.status}`);
  const tokens = await response.json();
  authStore.chatgpt = { type: "oauth", refresh: tokens.refresh_token ?? current.refresh, access: tokens.access_token, expires: Date.now() + (tokens.expires_in ?? 3600) * 1000, accountId: extractChatGptAccountId(tokens) ?? current.accountId, updatedAt: new Date().toISOString() };
  saveAuthStore();
  return authStore.chatgpt;
}
function startChatGptLogin(req, res) {
  const redirectUri = `http://localhost:${port}/auth/chatgpt/callback`;
  const pkce = generatePkce();
  const state = randomState();
  chatgptPending = { redirectUri, pkce, state };
  json(req, res, 200, { ok: true, url: buildChatGptAuthorizeUrl(redirectUri, pkce, state), instructions: "Complete authorization in the OpenAI browser flow." });
}
async function handleChatGptCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (error) return html(req, res, 400, errorPage("ChatGPT", error));
  if (!code || !chatgptPending || state !== chatgptPending.state) return html(req, res, 400, errorPage("ChatGPT", "Invalid or expired OAuth callback."));
  const pending = chatgptPending;
  chatgptPending = undefined;
  try {
    const tokens = await exchangeChatGptCode(code, pending.redirectUri, pending.pkce);
    authStore.chatgpt = { type: "oauth", refresh: tokens.refresh_token, access: tokens.access_token, expires: Date.now() + (tokens.expires_in ?? 3600) * 1000, accountId: extractChatGptAccountId(tokens), updatedAt: new Date().toISOString() };
    saveAuthStore();
    html(req, res, 200, successPage("ChatGPT"));
  } catch (err) {
    html(req, res, 500, errorPage("ChatGPT", err instanceof Error ? err.message : "Login failed"));
  }
}
async function startGithubCopilotLogin(req, res) {
  if (githubLoginPoll) return json(req, res, 200, { ok: true, instructions: "A GitHub device login is already pending. Complete it, then test the connection." });
  const response = await fetch("https://github.com/login/device/code", {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": `aiboard-account-provider-runner/${VERSION}` },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
  });
  if (!response.ok) throw new Error(`Failed to start GitHub login: ${response.status}`);
  const device = await response.json();
  githubLoginPoll = pollGithubDeviceLogin(device.device_code, Math.max(Number(device.interval) || 5, 1) * 1000).finally(() => { githubLoginPoll = undefined; });
  json(req, res, 200, { ok: true, url: device.verification_uri, instructions: `Enter GitHub code: ${device.user_code}` });
}
async function pollGithubDeviceLogin(deviceCode, intervalMs) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs + POLL_SAFETY_MS));
    const response = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": `aiboard-account-provider-runner/${VERSION}` },
      body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, device_code: deviceCode, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
    });
    if (!response.ok) return;
    const data = await response.json();
    if (data.access_token) {
      authStore.githubCopilot = { type: "oauth", access: data.access_token, refresh: data.access_token, expires: 0, updatedAt: new Date().toISOString() };
      saveAuthStore(); console.log("GitHub Copilot connected."); return;
    }
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { intervalMs += 5000; continue; }
    return;
  }
}
function providerStatus(provider) {
  if (provider === "chatgpt") return { ok: true, connected: !!authStore.chatgpt?.refresh, accountId: authStore.chatgpt?.accountId ?? null, updatedAt: authStore.chatgpt?.updatedAt ?? null };
  if (provider === "github-copilot") return { ok: true, connected: !!authStore.githubCopilot?.access, updatedAt: authStore.githubCopilot?.updatedAt ?? null, loginPending: !!githubLoginPoll };
  return { ok: false, error: "Unknown provider" };
}
function messagesToResponsesInput(messages) {
  const instructions = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const input = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content ?? "") }));
  return { instructions, input };
}
function jsonSchemaResponseFormat(structuredOutput) {
  if (!structuredOutput?.schema) return undefined;
  return { type: "json_schema", name: structuredOutput.name, schema: structuredOutput.schema, strict: structuredOutput.strict ?? true };
}
function extractError(data) { return typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message; }
function extractText(data) {
  if (typeof data === "string") return data;
  if (typeof data?.output_text === "string") return data.output_text;
  if (typeof data?.text === "string") return data.text;
  if (typeof data?.choices?.[0]?.message?.content === "string") return data.choices[0].message.content;
  const parts = [];
  for (const item of Array.isArray(data?.output) ? data.output : []) for (const part of Array.isArray(item?.content) ? item.content : []) if (typeof part?.text === "string") parts.push(part.text);
  return parts.join("\n").trim();
}
async function runChatGptChat(body) {
  const auth = await refreshChatGptToken();
  const { instructions, input } = messagesToResponsesInput(Array.isArray(body.messages) ? body.messages : []);
  const format = jsonSchemaResponseFormat(body.structuredOutput);
  const response = await fetch(CHATGPT_CODEX_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.access}`, ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}), "content-type": "application/json", originator: "aiboard", "user-agent": `aiboard-account-provider-runner/${VERSION}`, "session-id": body.sessionId ?? `aiboard-${Date.now()}` },
    body: JSON.stringify({ model: body.model, ...(instructions ? { instructions } : {}), input, ...(format ? { text: { format } } : {}), stream: false }),
  });
  const data = await response.json().catch(async () => ({ text: await response.text().catch(() => "") }));
  if (!response.ok) throw new Error(extractError(data) ?? `ChatGPT request failed: ${response.status}`);
  return extractText(data);
}
async function runGithubCopilotChat(body) {
  const current = authStore.githubCopilot;
  if (!current?.access) throw new Error("GitHub Copilot is not connected. Use Log in with GitHub first.");
  const format = jsonSchemaResponseFormat(body.structuredOutput);
  const requestBody = { model: body.model === "auto" ? "gpt-5.4" : body.model, messages: Array.isArray(body.messages) ? body.messages.map((m) => ({ role: m.role, content: String(m.content ?? "") })) : [], ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}), ...(format ? { response_format: { json_schema: format, type: "json_schema" } } : {}), stream: false };
  const headers = { authorization: `Bearer ${current.access}`, "content-type": "application/json", "user-agent": `aiboard-account-provider-runner/${VERSION}`, "x-github-api-version": GITHUB_API_VERSION, "openai-intent": "conversation-edits", "x-initiator": "user" };
  let response = await fetch(`${GITHUB_API_BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody) });
  if (response.status === 404 || response.status === 405) response = await fetch(`${GITHUB_API_BASE}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody) });
  const data = await response.json().catch(async () => ({ text: await response.text().catch(() => "") }));
  if (!response.ok) throw new Error(extractError(data) ?? `GitHub Copilot request failed: ${response.status}`);
  return extractText(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (req.method === "OPTIONS") return (res.writeHead(204, corsHeaders(req)), res.end());
  if (req.method === "GET" && url.pathname === "/auth/chatgpt/callback") return handleChatGptCallback(req, res, url);
  if (req.method === "GET" && url.pathname === "/health") return json(req, res, 200, { ok: true, version: VERSION, providers: { chatgpt: providerStatus("chatgpt"), "github-copilot": providerStatus("github-copilot") } });
  if (!authorized(req)) return json(req, res, 401, { error: "Unauthorized runner token" });
  const match = url.pathname.match(/^\/providers\/(chatgpt|github-copilot)\/(status|login|chat)$/);
  if (!match) return json(req, res, 404, { error: "Not found" });
  const [, provider, action] = match;
  try {
    if (req.method === "GET" && action === "status") return json(req, res, 200, providerStatus(provider));
    if (req.method === "POST" && action === "login") return provider === "chatgpt" ? startChatGptLogin(req, res) : startGithubCopilotLogin(req, res);
    if (req.method === "POST" && action === "chat") {
      const body = parseJsonBody(await readBody(req));
      const content = provider === "chatgpt" ? await runChatGptChat(body) : await runGithubCopilotChat(body);
      return json(req, res, 200, { ok: true, content });
    }
    return json(req, res, 405, { error: "Method not allowed" });
  } catch (err) {
    return json(req, res, 400, { error: err instanceof Error ? err.message : "Request failed" });
  }
});
server.listen(port, host, () => {
  console.log("AI Board — account-provider runner");
  console.log("──────────────────────────────────");
  console.log(`URL       : http://${host}:${port}`);
  console.log(`Token     : ${token}`);
  console.log(`Auth file : ${authFile}`);
  console.log("Paste the URL and token into Settings for ChatGPT Plus/Pro or GitHub Copilot.");
});
