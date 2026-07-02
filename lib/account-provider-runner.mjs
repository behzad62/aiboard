/** AI Board account-provider runner: localhost OAuth bridge for ChatGPT Plus/Pro and GitHub Copilot. */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const VERSION = 8;
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const DEFAULT_PORT = 1455;
const FALLBACK_PORT = 1457;
const explicitPort = flag("port");
let port = Number(explicitPort ?? DEFAULT_PORT);
const host = flag("host") ?? "127.0.0.1";
const token = flag("token") ?? randomBytes(16).toString("hex");
const authFile = flag("auth-file") ?? path.join(os.homedir(), ".aiboard-account-provider-runner.json");
const CHATGPT_ISSUER = "https://auth.openai.com";
const CHATGPT_CODEX_ENDPOINT = flag("chatgpt-codex-endpoint") ?? process.env.AIBOARD_CHATGPT_CODEX_ENDPOINT ?? "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_CHATGPT_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const customChatGptClientId = flag("chatgpt-client-id") ?? process.env.AIBOARD_CHATGPT_CLIENT_ID;
const CHATGPT_CLIENT_ID = customChatGptClientId ?? DEFAULT_CHATGPT_CLIENT_ID;
const CHATGPT_ORIGINATOR = flag("chatgpt-originator") ?? process.env.AIBOARD_CHATGPT_ORIGINATOR ?? "codex_cli_rs";
const CHATGPT_SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const CHATGPT_REGISTERED_CALLBACK_PORTS = new Set([DEFAULT_PORT, FALLBACK_PORT]);
const GITHUB_CLIENT_ID = flag("github-client-id") ?? process.env.AIBOARD_GITHUB_COPILOT_CLIENT_ID ?? "Ov23li8tweQw6odWQebz";
const GITHUB_API_BASE = (flag("github-api-base") ?? process.env.AIBOARD_GITHUB_COPILOT_API_BASE ?? "https://api.githubcopilot.com").replace(/\/+$/, "");
const GITHUB_API_VERSION = "2026-06-01";
const GITHUB_DEVICE_CODE_ENDPOINT = flag("github-device-code-endpoint") ?? process.env.AIBOARD_GITHUB_DEVICE_CODE_ENDPOINT ?? "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_ENDPOINT = flag("github-access-token-endpoint") ?? process.env.AIBOARD_GITHUB_ACCESS_TOKEN_ENDPOINT ?? "https://github.com/login/oauth/access_token";
const POLL_SAFETY_MS = 3000;
const MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024;

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
    req.on("data", (chunk) => { data += chunk; if (Buffer.byteLength(data, "utf8") > MAX_REQUEST_BODY_BYTES) reject(new Error("Body too large")); });
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
    scope: CHATGPT_SCOPE, code_challenge: pkce.challenge, code_challenge_method: "S256",
    id_token_add_organizations: "true", codex_cli_simplified_flow: "true", state, originator: CHATGPT_ORIGINATOR,
  });
  return `${CHATGPT_ISSUER}/oauth/authorize?${params.toString()}`;
}
function chatGptRedirectUri() {
  return `http://localhost:${port}/auth/callback`;
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
  if (!customChatGptClientId && !CHATGPT_REGISTERED_CALLBACK_PORTS.has(port)) {
    return json(req, res, 400, { error: "ChatGPT OAuth requires account-provider-runner.mjs to listen on port 1455 or 1457. Restart it without --port, or use --port 1455 / --port 1457, then paste the printed runner URL again." });
  }
  const redirectUri = chatGptRedirectUri();
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
  const response = await fetch(GITHUB_DEVICE_CODE_ENDPOINT, {
    method: "POST", headers: { accept: "application/json", "content-type": "application/json", "user-agent": `aiboard-account-provider-runner/${VERSION}` },
    body: JSON.stringify({ client_id: GITHUB_CLIENT_ID, scope: "read:user" }),
  });
  if (!response.ok) throw new Error(`Failed to start GitHub login: ${response.status}`);
  const device = await response.json();
  githubLoginPoll = pollGithubDeviceLogin(device.device_code, Math.max(Number(device.interval) || 5, 1) * 1000).finally(() => { githubLoginPoll = undefined; });
  json(req, res, 200, { ok: true, url: device.verification_uri, verificationUrl: device.verification_uri, deviceCode: device.user_code, userCode: device.user_code, expiresIn: device.expires_in, interval: device.interval, instructions: `Enter GitHub code: ${device.user_code}` });
}
async function pollGithubDeviceLogin(deviceCode, intervalMs) {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs + POLL_SAFETY_MS));
    const response = await fetch(GITHUB_ACCESS_TOKEN_ENDPOINT, {
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
function attachmentTextSection(attachments) {
  const textAttachments = attachments.filter((a) => typeof a?.textContent === "string");
  if (!textAttachments.length) return "";
  return `\n\n--- User attachments ---\n${textAttachments.map((a) => `--- Attached file: ${a.filename ?? "attachment"} ---\n${a.textContent}`).join("\n\n")}`;
}
function attachmentImageDataUrls(attachments) {
  return attachments
    .filter((a) => a?.category === "image" || String(a?.mimeType ?? "").startsWith("image/"))
    .map((a) => {
      if (!String(a?.mimeType ?? "").startsWith("image/") || !a?.base64Data) throw new Error(`Image attachment ${a?.filename ?? ""} is missing image data.`);
      return `data:${a.mimeType};base64,${a.base64Data}`;
    });
}
function attachmentDocumentDataUrl(a) {
  return `data:${a.mimeType || "application/octet-stream"};base64,${a.base64Data}`;
}
function attachmentInputFileParts(attachments) {
  return attachments
    .filter((a) => a?.category === "document" && a?.base64Data)
    .map((a) => ({
      type: "input_file",
      filename: a.filename ?? "attachment",
      file_data: attachmentDocumentDataUrl(a),
    }));
}
function attachmentChatFileParts(attachments) {
  return attachments
    .filter((a) => a?.category === "document" && a?.base64Data)
    .map((a) => ({
      type: "file",
      file: {
        filename: a.filename ?? "attachment",
        file_data: attachmentDocumentDataUrl(a),
      },
    }));
}
function assertSupportedAttachments(attachments) {
  for (const a of attachments) {
    if (a?.category === "image" || String(a?.mimeType ?? "").startsWith("image/")) {
      if (String(a?.mimeType ?? "").startsWith("image/") && a?.base64Data) continue;
      throw new Error(`Image attachment ${a?.filename ?? ""} is missing image data.`);
    }
    if (a?.category === "text_inline" || a?.category === "document") {
      if (typeof a?.textContent === "string" || a?.base64Data) continue;
      throw new Error(`Document attachment ${a?.filename ?? ""} is missing text or file data.`);
    }
    throw new Error(`${a?.category ?? "This"} attachment is not supported by the account-provider runner yet.`);
  }
}
function lastUserMessageIndex(messages) {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]?.role !== "system" && messages[i]?.role !== "assistant") return i;
  return -1;
}
function messagesToResponsesInput(messages, attachments = []) {
  assertSupportedAttachments(attachments);
  const instructions = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const attachAt = lastUserMessageIndex(messages);
  const textSection = attachmentTextSection(attachments);
  const images = attachmentImageDataUrls(attachments);
  const files = attachmentInputFileParts(attachments);
  const input = messages
    .map((m, index) => ({ m, index }))
    .filter(({ m }) => m.role !== "system")
    .map(({ m, index }) => {
      const role = m.role === "assistant" ? "assistant" : "user";
      const text = String(m.content ?? "") + (index === attachAt ? textSection : "");
      if (role === "user" && index === attachAt && (textSection || images.length || files.length)) {
        return {
          role,
          content: [
            ...files,
            ...(text ? [{ type: "input_text", text }] : []),
            ...images.map((image_url) => ({ type: "input_image", image_url })),
          ],
        };
      }
      return { role, content: text };
    });
  return { instructions, input };
}
function messagesToCopilotChatMessages(messages, attachments = []) {
  assertSupportedAttachments(attachments);
  const attachAt = lastUserMessageIndex(messages);
  const textSection = attachmentTextSection(attachments);
  const images = attachmentImageDataUrls(attachments);
  const files = attachmentChatFileParts(attachments);
  return messages.map((m, index) => {
    const role = m.role === "system" || m.role === "assistant" ? m.role : "user";
    const text = String(m.content ?? "") + (role === "user" && index === attachAt ? textSection : "");
    if (role === "user" && index === attachAt && (textSection || images.length || files.length)) {
      return {
        role,
        content: [
          ...files,
          ...(text ? [{ type: "text", text }] : []),
          ...images.map((url) => ({ type: "image_url", image_url: { url } })),
        ],
      };
    }
    return { role, content: text };
  });
}
function shouldUseGithubResponses(model) {
  const match = /^gpt-(\d+)/.exec(String(model));
  return !!match && Number(match[1]) >= 5;
}
function jsonSchemaResponseFormat(structuredOutput) {
  if (!structuredOutput?.schema) return undefined;
  return { type: "json_schema", name: structuredOutput.name, schema: structuredOutput.schema, strict: structuredOutput.strict ?? true };
}
function maxOutputTokenField(body, fieldName) {
  const value = Number(body.maxTokens);
  return Number.isFinite(value) && value > 0 ? { [fieldName]: Math.trunc(value) } : {};
}
function reasoningEffortValue(effort) {
  if (effort === "none") return "none";
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "max") return "xhigh";
  return undefined;
}
function responsesReasoningField(body) {
  const effort = reasoningEffortValue(body.reasoningEffort);
  return effort ? { reasoning: { effort } } : {};
}
function openAiResponsesNativeTools(body) {
  const tools = [];
  if (Array.isArray(body.nativeTools)) {
    for (const tool of body.nativeTools) {
      if (!tool?.name || !tool?.parameters) continue;
      tools.push({
        type: "function",
        name: String(tool.name),
        description: String(tool.description ?? ""),
        parameters: tool.parameters,
        strict: tool.strict ?? false,
      });
    }
  }
  if (body.hostedBuildTools) tools.push({ type: "local_shell" });
  if (body.webSearch) tools.push({ type: "web_search_preview" });
  return tools;
}
function writeSse(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
function sseHeaders(req) {
  return { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive", ...corsHeaders(req) };
}
function parseSseBlocks(text, onEvent) {
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try { onEvent(JSON.parse(data)); } catch {}
  }
}
function shellCommandPartsToString(parts) {
  if (typeof parts === "string") return parts;
  if (!Array.isArray(parts)) return "";
  return parts.map((part) => String(part)).map((part) => /^[A-Za-z0-9_./:=@+-]+$/.test(part) ? part : JSON.stringify(part)).join(" ");
}
function createResponsesEventNormalizer({ allowLocalShell = false } = {}) {
  const pendingToolCalls = new Map();
  const emitted = new Set();
  const textDeltaKeys = new Set();
  const idFor = (event, item) => item?.call_id ?? item?.id ?? event?.item_id ?? String(event?.output_index ?? pendingToolCalls.size);
  const textKeyFor = (event) => event?.item_id ?? `${event?.output_index ?? "default"}:${event?.content_index ?? "default"}`;
  const emitToolCall = (id, emit) => {
    if (emitted.has(id)) return;
    const call = pendingToolCalls.get(id);
    if (!call?.name) return;
    emitted.add(id);
    emit({ type: "tool_call", toolCall: call });
  };
  const upsert = (id, patch) => {
    const current = pendingToolCalls.get(id) ?? { id, name: "", argumentsJson: "" };
    pendingToolCalls.set(id, { ...current, ...patch });
  };
  return {
    handle(event, emit) {
      if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
        textDeltaKeys.add(textKeyFor(event));
        emit({ type: "token", content: event.delta });
        return;
      }
      if (event?.type === "response.output_text.done" && typeof event.text === "string") {
        if (!textDeltaKeys.has(textKeyFor(event))) emit({ type: "token", content: event.text });
        return;
      }
      if (event?.type === "response.output_item.added" || event?.type === "response.output_item.done") {
        const item = event.item;
        if (item?.type === "function_call") {
          const id = idFor(event, item);
          upsert(id, {
            id,
            name: item.name ?? pendingToolCalls.get(id)?.name ?? "",
            argumentsJson: item.arguments ?? pendingToolCalls.get(id)?.argumentsJson ?? "",
          });
          if (event.type === "response.output_item.done") emitToolCall(id, emit);
          return;
        }
        if (allowLocalShell && item?.type === "local_shell_call" && item.action?.type === "exec") {
          const command = shellCommandPartsToString(item.action.command);
          if (command) {
            const id = idFor(event, item);
            upsert(id, {
              id,
              name: "run",
              arguments: { command, reason: "ChatGPT local_shell native tool call" },
              argumentsJson: JSON.stringify({ command, reason: "ChatGPT local_shell native tool call" }),
            });
            if (event.type === "response.output_item.done") emitToolCall(id, emit);
          }
          return;
        }
      }
      if (event?.type === "response.function_call_arguments.delta" && typeof event.delta === "string") {
        const id = event.item_id ?? String(event.output_index ?? pendingToolCalls.size);
        const current = pendingToolCalls.get(id) ?? { id, name: "", argumentsJson: "" };
        current.argumentsJson += event.delta;
        pendingToolCalls.set(id, current);
        return;
      }
      if (event?.type === "response.function_call_arguments.done" && typeof event.arguments === "string") {
        const id = event.item_id ?? String(event.output_index ?? pendingToolCalls.size);
        upsert(id, { id, argumentsJson: event.arguments });
        return;
      }
      if (event?.type === "response.failed") {
        emit({ type: "error", error: extractError(event.response ?? event) ?? "ChatGPT request failed" });
      }
    },
    flush(emit) {
      for (const id of pendingToolCalls.keys()) emitToolCall(id, emit);
      emit({ type: "done" });
    },
  };
}
async function streamResponseSse(response, emit, options = {}) {
  const normalizer = createResponsesEventNormalizer(options);
  const reader = response.body?.getReader();
  if (!reader) {
    const data = await readResponseBody(response);
    const text = typeof data === "string" ? data : JSON.stringify(data);
    parseSseBlocks(text, (event) => normalizer.handle(event, emit));
    normalizer.flush(emit);
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    for (;;) {
      const match = buffer.match(/\r?\n\r?\n/);
      if (!match) break;
      const block = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      parseSseBlocks(`${block}\n\n`, (event) => normalizer.handle(event, emit));
    }
  }
  if (buffer.trim()) parseSseBlocks(buffer, (event) => normalizer.handle(event, emit));
  normalizer.flush(emit);
}
function extractError(data) { return typeof data?.error === "string" ? data.error : data?.error?.message ?? data?.message ?? data?.detail; }
async function readResponseBody(response) {
  const text = await response.text().catch(() => "");
  if (!text) return {};
  try { return JSON.parse(text); } catch { return text; }
}
function extractSseText(text) {
  let output = "";
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      if (event?.type === "response.output_text.delta" && typeof event.delta === "string") output += event.delta;
      if (!output && event?.type === "response.output_text.done" && typeof event.text === "string") output = event.text;
    } catch {
      // Ignore non-JSON SSE payloads.
    }
  }
  return output.trim();
}
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
  const { instructions, input } = messagesToResponsesInput(Array.isArray(body.messages) ? body.messages : [], Array.isArray(body.attachments) ? body.attachments : []);
  const format = jsonSchemaResponseFormat(body.structuredOutput);
  const tools = openAiResponsesNativeTools(body);
  const response = await fetch(CHATGPT_CODEX_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.access}`, ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}), "content-type": "application/json", originator: "aiboard", "user-agent": `aiboard-account-provider-runner/${VERSION}`, "session-id": body.sessionId ?? `aiboard-${Date.now()}` },
    body: JSON.stringify({ model: body.model, ...(instructions ? { instructions } : {}), input, ...responsesReasoningField(body), ...(format ? { text: { format } } : {}), ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}), stream: true, store: false }),
  });
  const data = await readResponseBody(response);
  if (!response.ok) throw new Error(extractError(data) ?? `ChatGPT request failed: ${response.status}`);
  return typeof data === "string" ? extractSseText(data) : extractText(data);
}
async function streamChatGptChat(body, req, res) {
  const auth = await refreshChatGptToken();
  const { instructions, input } = messagesToResponsesInput(Array.isArray(body.messages) ? body.messages : [], Array.isArray(body.attachments) ? body.attachments : []);
  const format = jsonSchemaResponseFormat(body.structuredOutput);
  const tools = openAiResponsesNativeTools(body);
  const response = await fetch(CHATGPT_CODEX_ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${auth.access}`, ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}), "content-type": "application/json", originator: "aiboard", "user-agent": `aiboard-account-provider-runner/${VERSION}`, "session-id": body.sessionId ?? `aiboard-${Date.now()}` },
    body: JSON.stringify({ model: body.model, ...(instructions ? { instructions } : {}), input, ...responsesReasoningField(body), ...(format ? { text: { format } } : {}), ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}), stream: true, store: false }),
  });
  if (!response.ok) {
    const data = await readResponseBody(response);
    throw new Error(extractError(data) ?? `ChatGPT request failed: ${response.status}`);
  }
  res.writeHead(200, sseHeaders(req));
  await streamResponseSse(response, (event) => writeSse(res, event), { allowLocalShell: !!body.hostedBuildTools });
  res.end();
}
async function runGithubCopilotResponsesChat(body, headers, model) {
  const { instructions, input } = messagesToResponsesInput(Array.isArray(body.messages) ? body.messages : [], Array.isArray(body.attachments) ? body.attachments : []);
  const format = jsonSchemaResponseFormat(body.structuredOutput);
  const requestBody = { model, ...(instructions ? { instructions } : {}), input, ...maxOutputTokenField(body, "max_output_tokens"), ...responsesReasoningField(body), ...(format ? { text: { format } } : {}), store: false, stream: false };
  let response = await fetch(`${GITHUB_API_BASE}/responses`, { method: "POST", headers, body: JSON.stringify(requestBody) });
  if (response.status === 404 || response.status === 405) response = await fetch(`${GITHUB_API_BASE}/v1/responses`, { method: "POST", headers, body: JSON.stringify(requestBody) });
  const data = await readResponseBody(response);
  if (!response.ok) throw new Error(extractError(data) ?? `GitHub Copilot request failed: ${response.status}`);
  return extractText(data);
}
async function runGithubCopilotChat(body) {
  const current = authStore.githubCopilot;
  if (!current?.access) throw new Error("GitHub Copilot is not connected. Use Log in with GitHub first.");
  const headers = { authorization: `Bearer ${current.access}`, "content-type": "application/json", "user-agent": `aiboard-account-provider-runner/${VERSION}`, "x-github-api-version": GITHUB_API_VERSION, "openai-intent": "conversation-edits", "x-initiator": "user" };
  const model = body.model === "auto" ? "gpt-5.4" : body.model;
  if (shouldUseGithubResponses(model)) return runGithubCopilotResponsesChat(body, headers, model);
  const format = jsonSchemaResponseFormat(body.structuredOutput);
  const requestBody = { model, messages: Array.isArray(body.messages) ? messagesToCopilotChatMessages(body.messages, Array.isArray(body.attachments) ? body.attachments : []) : [], ...maxOutputTokenField(body, "max_tokens"), ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}), ...(format ? { response_format: { json_schema: format, type: "json_schema" } } : {}), stream: false };
  let response = await fetch(`${GITHUB_API_BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody) });
  if (response.status === 404 || response.status === 405) response = await fetch(`${GITHUB_API_BASE}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody) });
  const data = await response.json().catch(async () => ({ text: await response.text().catch(() => "") }));
  if (!response.ok) throw new Error(extractError(data) ?? `GitHub Copilot request failed: ${response.status}`);
  return extractText(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (req.method === "OPTIONS") return (res.writeHead(204, corsHeaders(req)), res.end());
  if (req.method === "GET" && (url.pathname === "/auth/callback" || url.pathname === "/auth/chatgpt/callback")) return handleChatGptCallback(req, res, url);
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
      if (provider === "chatgpt" && body.stream) return await streamChatGptChat(body, req, res);
      const content = provider === "chatgpt" ? await runChatGptChat(body) : await runGithubCopilotChat(body);
      return json(req, res, 200, { ok: true, content });
    }
    return json(req, res, 405, { error: "Method not allowed" });
  } catch (err) {
    return json(req, res, 400, { error: err instanceof Error ? err.message : "Request failed" });
  }
});
function printStartup() {
  console.log("AI Board — account-provider runner");
  console.log("──────────────────────────────────");
  console.log(`Version   : v${VERSION}`);
  console.log(`URL       : http://${host}:${port}`);
  console.log(`Token     : ${token}`);
  console.log(`Auth file : ${authFile}`);
  console.log("Paste the URL and token into Settings for ChatGPT Plus/Pro or GitHub Copilot.");
}
server.on("error", (err) => {
  if (!explicitPort && err?.code === "EADDRINUSE" && port === DEFAULT_PORT) {
    console.warn(`Port ${DEFAULT_PORT} is busy; trying ${FALLBACK_PORT}.`);
    port = FALLBACK_PORT;
    server.listen(port, host, printStartup);
    return;
  }
  console.error(`Failed to start account-provider runner on ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
server.listen(port, host, printStartup);
