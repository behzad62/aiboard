/** AI Board account-provider runner: localhost OAuth bridge for ChatGPT Plus/Pro and GitHub Copilot. */
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";

let createPairingEndpoint = null;
try { ({ createPairingEndpoint } = await import("../scripts/local-pair-runner.mjs")); }
catch { try { ({ createPairingEndpoint } = await import("./local-pair-runner.mjs")); } catch { createPairingEndpoint = null; } }

const VERSION = 29;
const RUNNER_CAPABILITY_SCHEMA_VERSION = 1;
const NVIDIA_FUNCTION_TOOL_MODELS = new Set([
  "z-ai/glm-5.2",
  "minimaxai/minimax-m3",
  "deepseek-ai/deepseek-v4-pro",
  "nvidia/nemotron-3-ultra-550b-a55b",
]);
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
const authFile = flag("auth-file") ?? path.join(os.homedir(), ".aiboard-account-provider-runner.json");
const CHATGPT_ISSUER = (flag("chatgpt-issuer") ?? process.env.AIBOARD_CHATGPT_ISSUER ?? "https://auth.openai.com").replace(/\/+$/, "");
const CHATGPT_API_BASE = (flag("chatgpt-api-base") ?? process.env.AIBOARD_CHATGPT_API_BASE ?? "https://api.openai.com/v1").replace(/\/+$/, "");
const CHATGPT_SCOPE = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const CHATGPT_PLAN_SCOPE = "chatgpt.tokens.use.direct";
const CHATGPT_SIGN_IN_REQUIRED = "Continue with ChatGPT again to authorize ChatGPT plan usage with the public OpenAI API. No API key is needed.";
const GITHUB_CLIENT_ID = flag("github-client-id") ?? process.env.AIBOARD_GITHUB_COPILOT_CLIENT_ID ?? "Ov23li8tweQw6odWQebz";
const GITHUB_API_BASE = (flag("github-api-base") ?? process.env.AIBOARD_GITHUB_COPILOT_API_BASE ?? "https://api.githubcopilot.com").replace(/\/+$/, "");
const GITHUB_API_VERSION = "2026-06-01";
const GITHUB_DEVICE_CODE_ENDPOINT = flag("github-device-code-endpoint") ?? process.env.AIBOARD_GITHUB_DEVICE_CODE_ENDPOINT ?? "https://github.com/login/device/code";
const GITHUB_ACCESS_TOKEN_ENDPOINT = flag("github-access-token-endpoint") ?? process.env.AIBOARD_GITHUB_ACCESS_TOKEN_ENDPOINT ?? "https://github.com/login/oauth/access_token";
const NVIDIA_API_BASE = (flag("nvidia-api-base") ?? process.env.AIBOARD_NVIDIA_API_BASE ?? "https://integrate.api.nvidia.com/v1").replace(/\/+$/, "");
const POLL_SAFETY_MS = 3000;
const MAX_REQUEST_BODY_BYTES = 25 * 1024 * 1024;

let chatgptPending;
let chatgptRegistrationClientId;
let chatgptDiscovery;
let chatgptJwks;
let chatgptRefresh;
let githubLoginPoll;
let authStore = loadAuthStore();
// The token persists in the auth file so a restart (or a reboot) keeps the URL and token pasted into
// Settings working; a fresh random token each start silently broke every saved connection.
const token = flag("token") ?? persistedRunnerToken();

function persistedRunnerToken() {
  if (typeof authStore.runnerToken === "string" && /^[0-9a-f]{32}$/.test(authStore.runnerToken)) return authStore.runnerToken;
  const created = randomBytes(16).toString("hex");
  authStore = { ...authStore, runnerToken: created };
  try { saveAuthStore(); } catch (error) { console.warn(`Could not save the runner token; it will change on restart: ${error.message}`); }
  return created;
}

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
  const temporary = `${authFile}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(authStore, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    fs.renameSync(temporary, authFile);
    try { fs.chmodSync(authFile, 0o600); } catch {}
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
function sameToken(a, b) {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && timingSafeEqual(left, right);
}
function boundedSessionId(value) {
  const sessionId = typeof value === "string" && value ? value : `aiboard-${Date.now()}`;
  if (sessionId.length <= 64) return sessionId;
  return `aiboard-${createHash("sha256").update(sessionId).digest("hex").slice(0, 56)}`;
}
// Mirror of DISCUSSION_TRANSCRIPT_MARKER in lib/orchestrator/prompts.ts. This
// runner ships standalone (no repo imports), so the constant is duplicated here;
// test-account-provider-runner-chat.mts asserts the two never diverge.
const DISCUSSION_TRANSCRIPT_MARKER = "\n\n--- Discussion so far ---\n\n";
/** The slice of a prompt that stays byte-identical as a discussion grows. */
function cacheableTextPrefix(text) {
  const markerIndex = text.indexOf(DISCUSSION_TRANSCRIPT_MARKER);
  if (markerIndex === -1) return text;
  return text.slice(0, markerIndex + DISCUSSION_TRANSCRIPT_MARKER.length);
}
/**
 * Stable `prompt_cache_key` for the ChatGPT account path.
 *
 * Mirrors buildOpenAIPromptCacheKey in lib/providers/openai-compat.ts: only the
 * LAST user message is reduced to its cacheable prefix, so turn N and turn N+1
 * of the same discussion hash to the same key and land on the same server-side
 * cache. Do NOT hash the full transcript — that produces a fresh key every turn
 * and silently disables caching, which is the bug this function exists to avoid.
 *
 * A Build session (body.sessionId set) is a multi-turn tool conversation whose earlier
 * messages are the cached prefix, so it keys on the session, as the runner's direct OpenAI
 * path does. Hashing its messages gave every turn a fresh key: a 234k-token Architect turn
 * cached 4% (tunnel run, 2026-10-25). The chat path never sets sessionId and keeps the
 * message-derived key below.
 */
function buildChatGptPromptCacheKey(body) {
  if (typeof body.sessionId === "string" && body.sessionId.trim()) {
    const session = createHash("sha256")
      .update(JSON.stringify({ providerId: "chatgpt", model: body.model, sessionId: body.sessionId }))
      .digest("hex")
      .slice(0, 24);
    return `aidb:chatgpt:${body.model}:s:${session}`;
  }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUserIndex = messages.reduce(
    (last, message, index) => (message?.role === "user" ? index : last),
    -1
  );
  const stableMessages = messages.map((message, index) => {
    const content = typeof message?.content === "string" ? message.content : "";
    if (message?.role !== "user") return `${message?.role}:${content}`;
    return index === lastUserIndex ? `user:${cacheableTextPrefix(content)}` : `user:${content}`;
  });
  const attachmentSignature = (Array.isArray(body.attachments) ? body.attachments : [])
    .map((attachment) => `${attachment?.id}:${attachment?.mimeType}:${attachment?.category}`)
    .join("|");
  const hash = createHash("sha256")
    .update(JSON.stringify({ providerId: "chatgpt", model: body.model, stableMessages, attachmentSignature }))
    .digest("hex")
    .slice(0, 24);
  return `aidb:chatgpt:${body.model}:${hash}`;
}
const pairing = createPairingEndpoint
  ? createPairingEndpoint({ kind: "accounts", getPort: () => port, shutdown: () => { try { server.close(() => process.exit(0)); } catch { process.exit(0); } } })
  : { launcherStarted: false, hasSession: () => false, handle: async () => false, attach: async () => null };
function authorized(req) { return sameToken(req.headers["x-runner-token"], token) || pairing.hasSession(req.headers["x-runner-token"]); }
function corsHeaders(req) {
  const origin = req.headers.origin;
  const allowed = typeof origin === "string" && (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) || origin === "https://aiboard.me");
  if (pairing.launcherStarted) {
    // Launcher-started instances accept only the hosted app (or the opt-in dev origin), never a wildcard.
    const launcherAllowed = origin === "https://aiboard.me" ||
      (process.env.AIBOARD_LOCAL_PAIR_DEV_ORIGIN === "1" && origin === "http://localhost:3000");
    return {
      "Access-Control-Allow-Origin": launcherAllowed ? origin : "https://aiboard.me",
      Vary: "Origin",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
      "Access-Control-Allow-Headers": "content-type,x-runner-token",
      "Access-Control-Max-Age": "600",
    };
  }
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "*",
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "content-type,x-runner-token",
    "Access-Control-Max-Age": "600",
  };
}
function json(req, res, status, body) { res.writeHead(status, { "content-type": "application/json", ...corsHeaders(req) }); res.end(JSON.stringify(body)); }
function html(req, res, status, body) { res.writeHead(status, { "content-type": "text/html; charset=utf-8", ...corsHeaders(req) }); res.end(body); }
function errorMessage(err) { return err instanceof Error ? err.message : "Request failed"; }
function parseRetryAfter(value, nowMs = Date.now()) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    return Number.isFinite(seconds) && seconds >= 0 ? Math.round(seconds * 1000) : undefined;
  }
  const dateMs = Date.parse(text);
  if (!Number.isFinite(dateMs)) return undefined;
  const delayMs = dateMs - nowMs;
  return delayMs >= 0 ? delayMs : undefined;
}
class SanitizedHttpError extends Error {
  constructor(message, statusCode, retryAfterMs, code) {
    super(message);
    this.name = "SanitizedHttpError";
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
    this.code = code;
  }
}
function upstreamHttpError(response, data, fallback) {
  return new SanitizedHttpError(
    extractError(data) ?? fallback,
    response.status,
    parseRetryAfter(response.headers.get("retry-after")),
    typeof data?.error?.code === "string" ? data.error.code : undefined
  );
}
function safeErrorMetadata(err, fallbackStatus) {
  const statusCode = Number.isInteger(err?.statusCode) ? err.statusCode : fallbackStatus;
  const retryAfterMs = Number.isFinite(err?.retryAfterMs) && err.retryAfterMs >= 0 ? err.retryAfterMs : undefined;
  const code = typeof err?.code === "string" && /^[A-Za-z0-9_.-]{1,128}$/.test(err.code) && !/key|token|secret|authorization/i.test(err.code)
    ? err.code
    : undefined;
  return {
    ...(statusCode ? { statusCode } : {}),
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    ...(code ? { code } : {}),
  };
}
function failRequest(req, res, err, status = 400) {
  const error = errorMessage(err);
  const errorMetadata = safeErrorMetadata(err, status);
  const statusCode = errorMetadata.statusCode ?? status;
  const retryAfterMs = errorMetadata.retryAfterMs;
  if (res.headersSent) {
    if (!res.writableEnded) {
      try { writeSse(res, { type: "error", error, errorMetadata }); } catch {}
      try { res.end(); } catch {}
    }
    return;
  }
  res.writeHead(statusCode, {
    "content-type": "application/json",
    ...(retryAfterMs !== undefined ? { "retry-after": String(retryAfterMs / 1000) } : {}),
    ...corsHeaders(req),
  });
  res.end(JSON.stringify({ error, errorMetadata }));
}
function createRequestCancellation(req, res) {
  const controller = new AbortController();
  let complete = false;
  let disconnected = false;
  const abortUpstream = () => {
    if (complete || disconnected) return;
    disconnected = true;
    controller.abort();
  };
  req.once("aborted", abortUpstream);
  res.once("close", abortUpstream);
  return {
    signal: controller.signal,
    get disconnected() { return disconnected; },
    markComplete() { complete = true; },
    cleanup() {
      req.removeListener("aborted", abortUpstream);
      res.removeListener("close", abortUpstream);
    },
  };
}
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
function isChatGptPlanAccount(account) {
  return account?.flow === "chatgpt-plan" && typeof account.clientId === "string" && account.clientId !== "dynamic_agent_client" && account.issuer === CHATGPT_ISSUER;
}
function chatGptPlanEnabled(account) {
  return isChatGptPlanAccount(account) && !!account.access && account.scopes?.includes(CHATGPT_PLAN_SCOPE) === true;
}
async function chatGptOpenIdConfiguration(signal) {
  if (chatgptDiscovery) return chatgptDiscovery;
  const response = await fetch(`${CHATGPT_ISSUER}/.well-known/openid-configuration`, { signal });
  if (!response.ok) throw new Error(`OpenAI sign-in discovery failed (${response.status}).`);
  const configuration = await response.json();
  if (configuration.issuer !== CHATGPT_ISSUER) throw new Error("OpenAI sign-in issuer mismatch.");
  for (const field of ["authorization_endpoint", "token_endpoint", "jwks_uri"]) {
    const endpoint = new URL(configuration[field]);
    const issuer = new URL(CHATGPT_ISSUER);
    if (endpoint.origin !== issuer.origin || endpoint.username || endpoint.password ||
        (endpoint.protocol !== "https:" && !(issuer.hostname === "127.0.0.1" && endpoint.protocol === "http:"))) {
      throw new Error("Untrusted OpenAI sign-in endpoint.");
    }
  }
  chatgptDiscovery = configuration;
  return configuration;
}
async function validateChatGptIdentity(idToken, clientId, nonce) {
  if (typeof idToken !== "string" || idToken.length > 64 * 1024) throw new Error("Missing or invalid OpenAI ID token.");
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("Invalid OpenAI ID token.");
  const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  const claims = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  if (header.alg !== "RS256" || typeof header.kid !== "string" || header.crit) throw new Error("Unsupported OpenAI ID token signature.");
  const configuration = await chatGptOpenIdConfiguration();
  if (!chatgptJwks || chatgptJwks.expires < Date.now() || !chatgptJwks.keys.some((key) => key.kid === header.kid)) {
    const response = await fetch(configuration.jwks_uri);
    if (!response.ok) throw new Error("OpenAI signing keys could not be loaded.");
    const jwks = await response.json();
    if (!Array.isArray(jwks.keys)) throw new Error("Invalid OpenAI signing keys.");
    chatgptJwks = { keys: jwks.keys, expires: Date.now() + 10 * 60_000 };
  }
  const key = chatgptJwks.keys.find((candidate) => candidate.kid === header.kid &&
    (!candidate.use || candidate.use === "sig") && (!candidate.alg || candidate.alg === header.alg) &&
    candidate.kty === "RSA");
  if (!key || !verify("sha256", Buffer.from(`${parts[0]}.${parts[1]}`),
    createPublicKey({ key, format: "jwk" }),
    Buffer.from(parts[2], "base64url"))) throw new Error("Invalid OpenAI ID token signature.");
  const now = Date.now() / 1000;
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== CHATGPT_ISSUER || !audience.includes(clientId) ||
      (claims.azp !== undefined && claims.azp !== clientId) ||
      (audience.length > 1 && claims.azp !== clientId) ||
      !Number.isFinite(claims.exp) || claims.exp < now - 5 ||
      !Number.isFinite(claims.iat) || claims.iat > now + 5 ||
      (claims.nbf !== undefined && (!Number.isFinite(claims.nbf) || claims.nbf > now + 5)) ||
      (nonce !== undefined && claims.nonce !== nonce) || typeof claims.sub !== "string" || !claims.sub) {
    throw new Error("OpenAI ID token identity, audience, expiry, or nonce mismatch.");
  }
  return claims;
}
function chatGptAccountFromTokens(tokens, clientId, identity, previous) {
  const scopes = typeof tokens.scope === "string" ? tokens.scope.split(/\s+/).filter(Boolean) : previous?.scopes ?? [];
  const hasAccess = typeof tokens.access_token === "string" && tokens.access_token.length > 0;
  if ((scopes.includes(CHATGPT_PLAN_SCOPE) && !hasAccess) ||
      (tokens.token_type && tokens.token_type.toLowerCase() !== "bearer") ||
      (hasAccess && (!Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0))) throw new Error("Incomplete OpenAI token response.");
  return {
    ...previous, type: "oauth", flow: "chatgpt-plan", issuer: CHATGPT_ISSUER, clientId,
    subject: identity.sub, email: typeof identity.email === "string" ? identity.email : previous?.email,
    idToken: tokens.id_token ?? previous?.idToken,
    refresh: tokens.refresh_token ?? previous?.refresh, access: tokens.access_token,
    expires: hasAccess ? Date.now() + tokens.expires_in * 1000 : identity.exp * 1000, scopes, updatedAt: new Date().toISOString(),
  };
}
function saveChatGptAccount(account, activate = true) {
  authStore = loadAuthStore();
  const previousStore = authStore;
  const accounts = { ...(authStore.chatgptAccounts ?? {}) };
  if (accounts[account.clientId] && accounts[account.clientId].subject !== account.subject) throw new Error("OpenAI account identity changed.");
  accounts[account.clientId] = account;
  authStore = { ...authStore, chatgptAccounts: accounts,
    ...(activate ? { chatgpt: account } : {}),
    ...(!isChatGptPlanAccount(previousStore.chatgpt) && previousStore.chatgpt ? { chatgptLegacy: previousStore.chatgpt } : {}),
  };
  try { saveAuthStore(); } catch (error) { authStore = previousStore; throw error; }
}
async function refreshChatGptToken(signal) {
  signal?.throwIfAborted();
  const current = authStore.chatgpt;
  if (!chatGptPlanEnabled(current)) throw new Error(CHATGPT_SIGN_IN_REQUIRED);
  if (current.expires > Date.now() + 60_000) return current;
  if (!current.refresh) throw new Error(CHATGPT_SIGN_IN_REQUIRED);
  // Share rotating-token refreshes within this process. A file lock prevents
  // another runner using this credential file from rotating the same token.
  if (chatgptRefresh) {
    await chatgptRefresh;
    signal?.throwIfAborted();
    return refreshChatGptToken(signal);
  }
  chatgptRefresh = (async () => {
    let lock;
    const lockPath = `${authFile}.chatgpt-refresh.lock`;
    try {
      lock = fs.openSync(lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      throw new Error(`Another runner holds the ChatGPT refresh lock. Retry after it finishes. If the runner crashed, stop all account runners, remove ${lockPath}, and restart.`);
    }
    try {
      const savedStore = loadAuthStore();
      const saved = savedStore.chatgptAccounts?.[current.clientId] ?? savedStore.chatgpt;
      const active = saved?.clientId === current.clientId && saved?.subject === current.subject ? saved : current;
      if (!chatGptPlanEnabled(active)) throw new Error(CHATGPT_SIGN_IN_REQUIRED);
      if (active.expires > Date.now() + 60_000) {
        authStore = savedStore;
        return active;
      }
      const configuration = await chatGptOpenIdConfiguration(signal);
      const response = await fetch(configuration.token_endpoint, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: active.refresh, client_id: active.clientId, resource: CHATGPT_API_BASE }).toString(), signal,
      });
      const tokens = await readResponseBody(response);
      if (!response.ok) throw upstreamHttpError(response, tokens, `ChatGPT session refresh failed (${response.status}). Continue with ChatGPT again if the session has expired.`);
      signal?.throwIfAborted();
      const identity = tokens.id_token ? await validateChatGptIdentity(tokens.id_token, active.clientId) : { sub: active.subject, email: active.email };
      signal?.throwIfAborted();
      if (identity.sub !== active.subject) throw new Error("OpenAI account identity changed during refresh.");
      const next = chatGptAccountFromTokens(tokens, active.clientId, identity, active);
      saveChatGptAccount(next, loadAuthStore().chatgpt?.clientId === current.clientId);
      if (!chatGptPlanEnabled(next)) throw new Error(CHATGPT_SIGN_IN_REQUIRED);
      return next;
    } finally {
      fs.closeSync(lock);
      fs.rmSync(lockPath, { force: true });
    }
  })();
  try { return await chatgptRefresh; } finally { chatgptRefresh = undefined; }
}
async function startChatGptLogin(req, res) {
  if (host !== "127.0.0.1") throw new Error("ChatGPT sign-in requires the runner to listen on 127.0.0.1.");
  const body = parseJsonBody(await readBody(req));
  const selected = body.newAccount ? undefined : body.clientId
    ? authStore.chatgptAccounts?.[body.clientId] : authStore.chatgpt;
  if (body.clientId && !selected) throw new Error("Unknown saved ChatGPT account.");
  const account = isChatGptPlanAccount(selected) ? selected : undefined;
  if (!authStore.chatgptHostId) {
    authStore.chatgptHostId = `urn:uuid:${randomUUID()}`;
    saveAuthStore();
  }
  const configuration = await chatGptOpenIdConfiguration();
  const pending = {
    redirectUri: `http://127.0.0.1:${port}/auth/callback`, pkce: generatePkce(), state: randomState(),
    nonce: randomState(), clientId: account?.clientId ?? (!body.newAccount ? chatgptRegistrationClientId : undefined), subject: account?.subject, expires: Date.now() + 10 * 60_000,
  };
  const params = new URLSearchParams({
    response_type: "code", client_id: pending.clientId ?? "dynamic_agent_client", redirect_uri: pending.redirectUri,
    scope: CHATGPT_SCOPE, resource: CHATGPT_API_BASE, ext_agent_host_id: authStore.chatgptHostId,
    state: pending.state, nonce: pending.nonce, code_challenge: pending.pkce.challenge, code_challenge_method: "S256",
    ...(!pending.clientId ? { agent_name_hint: "AI Board" } : {}),
    ...(account?.idToken ? { id_token_hint: account.idToken } : {}),
    ...(account?.email ? { login_hint: account.email } : {}),
  });
  chatgptPending = pending;
  json(req, res, 200, { ok: true, url: `${configuration.authorization_endpoint}?${params}`, instructions: "Sign in and allow AI Board to use your ChatGPT plan. No API key is needed." });
}
async function handleChatGptCallback(req, res, url) {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (!chatgptPending || state !== chatgptPending.state || chatgptPending.expires < Date.now()) return html(req, res, 400, errorPage("ChatGPT", "Invalid or expired OAuth callback."));
  const pending = chatgptPending;
  chatgptPending = undefined;
  if (error) return html(req, res, 400, errorPage("ChatGPT", error));
  if (!code) return html(req, res, 400, errorPage("ChatGPT", "Missing authorization code."));
  try {
    const issuedClientId = url.searchParams.get("client_id") ?? pending.clientId;
    if (!issuedClientId || issuedClientId === "dynamic_agent_client" || (pending.clientId && issuedClientId !== pending.clientId)) throw new Error("Missing or mismatched issued OpenAI client ID.");
    const configuration = await chatGptOpenIdConfiguration();
    const response = await fetch(configuration.token_endpoint, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: issuedClientId,
        redirect_uri: pending.redirectUri, code_verifier: pending.pkce.verifier, resource: CHATGPT_API_BASE }).toString(),
    });
    const tokens = await readResponseBody(response);
    if (!response.ok) {
      if (!pending.clientId && tokens?.error === "invalid_grant") chatgptRegistrationClientId = issuedClientId;
      throw new Error(`OpenAI code exchange failed (${response.status}). Start Continue with ChatGPT again.`);
    }
    const identity = await validateChatGptIdentity(tokens.id_token, issuedClientId, pending.nonce);
    if (pending.subject && identity.sub !== pending.subject) throw new Error("OpenAI returned a different account. Use Add another account instead.");
    const account = chatGptAccountFromTokens(tokens, issuedClientId, identity);
    saveChatGptAccount(account);
    chatgptRegistrationClientId = undefined;
    if (!chatGptPlanEnabled(account)) return html(req, res, 200, `<!doctype html><meta charset="utf-8"><h1>ChatGPT signed in</h1><p>ChatGPT plan usage was not granted. Return to AI Board and Continue with ChatGPT to enable it.</p>`);
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
      saveAuthStore(); console.log("GitHub Copilot connected.");
      // Enabling Copilot fetches its runtime now, so the first request does not wait for the download.
      githubCopilotCliPath().catch((error) => console.warn(error.message));
      return;
    }
    if (data.error === "authorization_pending") continue;
    if (data.error === "slow_down") { intervalMs += 5000; continue; }
    return;
  }
}
function providerStatus(provider) {
  if (provider === "chatgpt") return {
    ok: true, runnerVersion: VERSION, connected: chatGptPlanEnabled(authStore.chatgpt),
    requiresSignIn: !chatGptPlanEnabled(authStore.chatgpt),
    message: chatGptPlanEnabled(authStore.chatgpt) ? null : CHATGPT_SIGN_IN_REQUIRED,
    accountId: isChatGptPlanAccount(authStore.chatgpt) ? authStore.chatgpt.clientId : null,
    email: isChatGptPlanAccount(authStore.chatgpt) ? authStore.chatgpt.email ?? null : null,
    accounts: Object.values(authStore.chatgptAccounts ?? {}).filter(isChatGptPlanAccount).map((account) => ({
      clientId: account.clientId, email: account.email ?? null, subject: account.subject,
      active: authStore.chatgpt?.clientId === account.clientId,
    })),
    updatedAt: authStore.chatgpt?.updatedAt ?? null,
  };
  if (provider === "github-copilot") return { ok: true, connected: !!authStore.githubCopilot?.access, updatedAt: authStore.githubCopilot?.updatedAt ?? null, loginPending: !!githubLoginPoll, runtime: copilotRuntimeStatus };
  if (provider === "nvidia") return { ok: true, connected: true, updatedAt: null, credentialMode: "per-request-api-key" };
  return { ok: false, error: "Unknown provider" };
}
function runnerCapability(id, support, execution, transports) {
  return { id, support, execution, transports, supportSource: "runner" };
}
function runnerPrerequisite(id, label, kind, configurationPath) {
  return { id, label, kind, ...(configurationPath ? { configurationPath } : {}) };
}
function chatGptRunnerCapabilities() {
  return {
    schemaVersion: RUNNER_CAPABILITY_SCHEMA_VERSION,
    runnerVersion: VERSION,
    providerId: "chatgpt",
    transports: ["runner_proxy"],
    capabilities: [
      runnerCapability("function_calling", "supported", "runner", ["runner_proxy"]),
      runnerCapability("web_search", "supported", "provider", ["runner_proxy"]),
    ],
    execution: [
      { id: "streaming", available: true, transports: ["runner_proxy"] },
      { id: "model_discovery", available: true, transports: ["runner_proxy"] },
      { id: "structured_output", available: true, transports: ["runner_proxy"] },
      { id: "attachments", available: true, transports: ["runner_proxy"] },
    ],
    prerequisites: [
      runnerPrerequisite("chatgpt_account_login", "ChatGPT account login", "account", "providers.chatgpt.account"),
    ],
  };
}
async function githubCopilotRunnerCapabilities() {
  const sdk = await loadGithubCopilotSdk();
  let models = [];
  if (authStore.githubCopilot?.access) {
    try {
      models = await listGithubCopilotModels();
    } catch {
      // Discovery failure is transient evidence. Keep provider-level runner truth
      // and omit model refinement rather than recording models as unsupported.
    }
  }
  const wired = sdk.buildCopilotSdkRunnerCapabilities(models);
  return {
    schemaVersion: RUNNER_CAPABILITY_SCHEMA_VERSION,
    runnerVersion: VERSION,
    providerId: "github-copilot",
    ...wired,
    prerequisites: [
      runnerPrerequisite("github_copilot_login", "GitHub Copilot account login", "account", "providers.githubCopilot.account"),
    ],
  };
}
async function nvidiaRunnerCapabilities(body) {
  const modelIds = new Set(NVIDIA_FUNCTION_TOOL_MODELS);
  if (String(body?.apiKey ?? "").trim()) {
    try {
      for (const model of await listNvidiaModels(body)) {
        const id = String(model?.id ?? "").trim();
        if (id) modelIds.add(id);
      }
    } catch {
      // Auth/network/provider probe failures are not permanent negative evidence.
    }
  }
  const models = [...modelIds].sort().map((modelId) => ({
    modelId,
    transports: ["chat_completions", "runner_proxy"],
    capabilities: [
      runnerCapability(
        "function_calling",
        NVIDIA_FUNCTION_TOOL_MODELS.has(modelId) ? "supported" : "conditional",
        "client",
        ["chat_completions", "runner_proxy"],
      ),
    ],
  }));
  return {
    schemaVersion: RUNNER_CAPABILITY_SCHEMA_VERSION,
    runnerVersion: VERSION,
    providerId: "nvidia",
    transports: ["chat_completions", "runner_proxy"],
    capabilities: [
      runnerCapability("function_calling", "conditional", "client", ["chat_completions", "runner_proxy"]),
    ],
    models,
    execution: [
      { id: "streaming", available: true, transports: ["runner_proxy"] },
      { id: "model_discovery", available: true, transports: ["runner_proxy"] },
      { id: "structured_output", available: true, transports: ["chat_completions", "runner_proxy"] },
      { id: "function_tool_proxy", available: true, transports: ["chat_completions", "runner_proxy"] },
    ],
    prerequisites: [
      runnerPrerequisite("nvidia_api_key", "NVIDIA API key", "account", "providers.nvidia.apiKey"),
    ],
  };
}
async function providerCapabilities(provider, body = {}) {
  if (provider === "chatgpt") return chatGptRunnerCapabilities();
  if (provider === "github-copilot") return githubCopilotRunnerCapabilities();
  if (provider === "nvidia") return nvidiaRunnerCapabilities(body);
  throw new Error("Unknown provider");
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
function shouldUseGithubCopilotSdk(body) {
  // structuredOutput deliberately excludes the SDK path: the Copilot SDK
  // session API has no response_format surface, so structured requests must
  // take the HTTP API (chat/completions response_format or /responses
  // text.format). Do not "fix" this by routing structured calls to the SDK.
  return body?.runtimeMode === "discussion" &&
    !body?.structuredOutput &&
    !(Array.isArray(body?.attachments) && body.attachments.length) &&
    !(Array.isArray(body?.functionTools) && body.functionTools.length);
}
async function runGithubCopilotSdkChat(body, onToken, signal, onToolEvent, onUsage) {
  const current = authStore.githubCopilot;
  if (!current?.access) throw new Error("GitHub Copilot is not connected. Use Log in with GitHub first.");
  const sdk = await loadGithubCopilotSdk();
  const baseDirectory = path.join(path.dirname(authFile), ".aiboard-copilot-sdk");
  fs.mkdirSync(baseDirectory, { recursive: true });
  const cliPath = await githubCopilotCliPath();
  return sdk.runCopilotSdkChat(body, current.access, baseDirectory, onToken, { signal, onToolEvent, onUsage, cliPath });
}
async function listChatGptModels(signal) {
  const auth = await refreshChatGptToken(signal);
  const response = await fetch(`${CHATGPT_API_BASE}/models`, {
    method: "GET",
    headers: {
      authorization: `Bearer ${auth.access}`,
      "user-agent": `aiboard-account-provider-runner/${VERSION}`,
    },
    signal,
  });
  const data = await readResponseBody(response);
  if (!response.ok) {
    throw upstreamHttpError(response, data, `ChatGPT model catalog request failed: ${response.status}`);
  }
  const models = Array.isArray(data?.models) ? data.models : [];
  // Account discovery follows upstream visibility. API eligibility is a
  // separate property and must not hide models listed for this account.
  return models
    .filter((model) =>
      typeof model?.slug === "string" &&
      model.slug.trim().length > 0 &&
      model.visibility === "list"
    )
    .map((model) => {
      const inputModalities = Array.isArray(model.input_modalities)
        ? model.input_modalities.map((value) => String(value).toLowerCase())
        : undefined;
      return {
        ...model,
        id: model.slug.trim(),
        name: typeof model.display_name === "string" && model.display_name.trim()
          ? model.display_name.trim()
          : model.slug.trim(),
        ...(typeof model.description === "string" && model.description.trim()
          ? { description: model.description.trim() }
          : {}),
        capabilities: {
          supports: {
            ...(inputModalities ? { vision: inputModalities.includes("image") } : {}),
            ...(Array.isArray(model.supported_reasoning_levels) ? { reasoningEffort: model.supported_reasoning_levels.length > 0 } : {}),
          },
        },
      };
    });
}

// Release bundles pin the Copilot CLI platform package instead of shipping it (../runner-v2/copilot-runtime.json);
// it is downloaded, verified against the pin and unpacked on first use. A checkout or the standalone ZIP has no
// pin: there the SDK starts the package npm installed.
const BUNDLED_COPILOT_PIN = fileURLToPath(new URL("../runner-v2/copilot-runtime.json", import.meta.url));
let copilotRuntimeStatus = fs.existsSync(BUNDLED_COPILOT_PIN) ? { state: "not_installed" } : { state: "installed_package" };
let copilotRuntimeInstall;
function githubCopilotCliPath() {
  if (copilotRuntimeStatus.state === "installed_package") return Promise.resolve(undefined);
  copilotRuntimeInstall ??= (async () => {
    copilotRuntimeStatus = { state: "installing" };
    const runtime = await import("../runner-v2/src/copilot-runtime.js");
    const pin = await runtime.readBundledCopilotPin(BUNDLED_COPILOT_PIN);
    const cliPath = await runtime.ensureCopilotRuntime({ pin, root: runtime.copilotRuntimeRoot(), log: (message) => console.log(message) });
    copilotRuntimeStatus = { state: "ready", version: pin.version };
    return cliPath;
  })().catch((error) => {
    copilotRuntimeInstall = undefined;
    copilotRuntimeStatus = { state: "failed", error: error?.message ?? String(error) };
    throw error;
  });
  return copilotRuntimeInstall;
}
async function loadGithubCopilotSdk() {
  let sdk;
  try {
    sdk = await import("./account-provider-copilot-sdk.mjs");
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error("GitHub Copilot runner dependencies are missing. Download the Copilot runner ZIP, extract all files into its own folder, then run npm install and npm start in that folder. The standalone ChatGPT runner does not include Copilot dependencies.");
    }
    throw error;
  }
  if (["listCopilotSdkModels", "runCopilotSdkChat", "buildCopilotSdkRunnerCapabilities"].some((name) => typeof sdk[name] !== "function")) {
    throw new Error("The Copilot runner helper is out of date. Extract all files from the current Copilot runner ZIP into its own folder, run npm install, then restart with npm start.");
  }
  return sdk;
}
async function listGithubCopilotModels() {
  const current = authStore.githubCopilot;
  if (!current?.access) throw new Error("GitHub Copilot is not connected. Use Log in with GitHub first.");
  const sdk = await loadGithubCopilotSdk();
  const baseDirectory = path.join(path.dirname(authFile), ".aiboard-copilot-sdk");
  fs.mkdirSync(baseDirectory, { recursive: true });
  return sdk.listCopilotSdkModels(current.access, baseDirectory, { cliPath: await githubCopilotCliPath() });
}
async function streamGithubCopilotSdkChat(body, req, res, signal, markComplete) {
  res.writeHead(200, sseHeaders(req));
  try {
    await runGithubCopilotSdkChat(
      body,
      (content) => writeSse(res, { type: "token", content }),
      signal,
      (event) => writeSse(res, {
        type: "provider_tool_event",
        providerToolEvent: {
          tool: event.tool,
          phase: event.phase,
          providerManaged: true,
          callId: event.callId,
          rawType: `copilot.${event.phase}`,
        },
      }),
      (usage) => writeSse(res, { type: "usage", usage }),
    );
    writeSse(res, { type: "done" });
  } catch (err) {
    if (!signal.aborted && !res.destroyed && !res.writableEnded) {
      writeSse(res, { type: "error", error: errorMessage(err), errorMetadata: safeErrorMetadata(err) });
    }
  }
  if (!res.destroyed && !res.writableEnded) {
    markComplete();
    res.end();
  }
}
/** Responses-API text.format shape: type/name/schema/strict are flat siblings. */
function jsonSchemaResponseFormat(structuredOutput) {
  if (!structuredOutput?.schema) return undefined;
  return { type: "json_schema", name: structuredOutput.name, schema: structuredOutput.schema, strict: structuredOutput.strict ?? true };
}
/** Chat-completions response_format shape: name/schema/strict nest under json_schema with NO inner type. */
function chatCompletionsResponseFormat(structuredOutput) {
  if (!structuredOutput?.schema) return undefined;
  return { type: "json_schema", json_schema: { name: structuredOutput.name, schema: structuredOutput.schema, strict: structuredOutput.strict ?? true } };
}
/**
 * Copilot-served non-OpenAI models (observed live: gemini) can ignore
 * response_format server-side and wrap the JSON reply in a markdown fence,
 * which strict JSON.parse consumers (the certified benchmark scorer) score as
 * failed_tool_use. When structuredOutput was requested and the WHOLE reply is
 * a single fenced block, unwrap it; anything else passes through untouched.
 */
function stripStructuredOutputFence(text) {
  const trimmed = String(text ?? "").trim();
  const match = /^```[A-Za-z0-9_-]*[ \t]*\r?\n([\s\S]*?)\r?\n?```$/.exec(trimmed);
  return match ? match[1].trim() : text;
}
function maxOutputTokenField(body, fieldName) {
  const value = Number(body.maxTokens);
  return Number.isFinite(value) && value > 0 ? { [fieldName]: Math.trunc(value) } : {};
}
function reasoningEffortValue(effort, model) {
  if (effort === "none") return "none";
  if (effort === "low" || effort === "medium" || effort === "high") return effort;
  if (effort === "xhigh") return "xhigh";
  if (effort === "max") {
    return String(model ?? "").trim().toLowerCase().startsWith("gpt-5.6")
      ? "max"
      : "xhigh";
  }
  return undefined;
}
function responsesReasoningField(body) {
  const effort = reasoningEffortValue(body.reasoningEffort, body.model);
  return effort ? { reasoning: { effort } } : {};
}
function chatCompletionsReasoningField(body) {
  // Keep this aligned with the Copilot reasoning-support registry. GPT-5-class
  // models take the Responses route above; among raw chat-completions models,
  // only the catalogued Gemini route accepts reasoning_effort. Copilot Claude
  // and unknown models reject or ignore this OpenAI-specific field.
  if (String(body.model ?? "").trim().toLowerCase() !== "gemini-3.5-flash") {
    return {};
  }
  const effort = reasoningEffortValue(body.reasoningEffort, body.model);
  return effort ? { reasoning_effort: effort } : {};
}
function bodyToolEnabled(body, capabilityId) {
  return Array.isArray(body?.toolIntents) && body.toolIntents.some((intent) => intent?.id === capabilityId);
}

function openAiResponsesNativeTools(body) {
  const tools = [];
  if (Array.isArray(body.functionTools)) {
    for (const tool of body.functionTools) {
      if (!tool?.name || !tool?.parameters) continue;
      tools.push({
        type: "function",
        name: String(tool.name),
        // The API reads an empty description as a missing one.
        description: String(tool.description ?? "").trim() || `Call ${String(tool.name)}.`,
        parameters: tool.parameters,
        strict: tool.strict ?? false,
      });
    }
  }
  if (bodyToolEnabled(body, "web_search")) tools.push({ type: "web_search" });
  return tools;
}
function openAiChatNativeTools(body) {
  const tools = [];
  if (!Array.isArray(body.functionTools)) return tools;
  for (const tool of body.functionTools) {
    if (!tool?.name || !tool?.parameters) continue;
    tools.push({
      type: "function",
      function: {
        name: String(tool.name),
        description: String(tool.description ?? ""),
        parameters: tool.parameters,
        strict: tool.strict ?? false,
      },
    });
  }
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
function outputTextFromContentPart(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.refusal === "string") return part.refusal;
  if (typeof part.content === "string") return part.content;
  return "";
}
function outputTextFromMessageItem(item) {
  if (!item || typeof item !== "object") return "";
  if (item.type && item.type !== "message" && item.type !== "assistant_message") return "";
  if (item.role && item.role !== "assistant") return "";
  if (typeof item.text === "string") return item.text;
  if (typeof item.content === "string") return item.content;
  if (!Array.isArray(item.content)) return "";
  return item.content.map(outputTextFromContentPart).filter(Boolean).join("");
}
function createResponsesEventNormalizer(requireCompleted = false) {
  const pendingToolCalls = new Map();
  const emitted = new Set();
  const textDeltaKeys = new Set();
  let completed = false;
  let failed = false;
  const idFor = (event, item) => item?.call_id ?? item?.id ?? event?.item_id ?? String(event?.output_index ?? pendingToolCalls.size);
  const textKeyFor = (event) => event?.item_id ?? `${event?.output_index ?? "default"}:${event?.content_index ?? "default"}`;
  const textKeysForItem = (event, item) =>
    [
      event?.item_id,
      item?.id,
      `${event?.output_index ?? "default"}:${event?.content_index ?? "default"}`,
      `${event?.output_index ?? "default"}:default`,
      `${event?.output_index ?? "default"}:0`,
    ].filter((key) => typeof key === "string" && key);
  const hasTextKeyForItem = (event, item) => textKeysForItem(event, item).some((key) => textDeltaKeys.has(key));
  const markTextItem = (event, item) => {
    for (const key of textKeysForItem(event, item)) textDeltaKeys.add(key);
  };
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
        const key = textKeyFor(event);
        if (!textDeltaKeys.has(key)) emit({ type: "token", content: event.text });
        textDeltaKeys.add(key);
        return;
      }
      if (event?.type === "response.content_part.done") {
        const text = outputTextFromContentPart(event.part);
        const key = textKeyFor(event);
        if (text && !textDeltaKeys.has(key)) emit({ type: "token", content: text });
        if (text) textDeltaKeys.add(key);
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
        if (event.type === "response.output_item.done") {
          const text = outputTextFromMessageItem(item);
          if (text && !hasTextKeyForItem(event, item)) emit({ type: "token", content: text });
          if (text) markTextItem(event, item);
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
      if (event?.type === "response.completed" || event?.type === "response.done") {
        if (event.response?.status && event.response.status !== "completed") {
          failed = true;
          emit({ type: "error", error: extractError(event.response) ?? `Response ${event.response.status}` });
          return;
        }
        completed = event.type === "response.completed";
        const usage = responsesUsage(event.response);
        if (usage) emit({ type: "usage", usage });
        return;
      }
      if (["response.failed", "response.incomplete", "error"].includes(event?.type)) {
        failed = true;
        emit({ type: "error", error: extractError(event.response ?? event) ?? `ChatGPT request ${event.type}`, errorMetadata: safeErrorMetadata(event.response?.error ?? event.error ?? event) });
      }
    },
    flush(emit) {
      if (failed) return;
      if (requireCompleted && !completed) {
        emit({ type: "error", error: "OpenAI stream ended without response.completed." });
        return;
      }
      for (const id of pendingToolCalls.keys()) emitToolCall(id, emit);
      emit({ type: "done" });
    },
  };
}
async function streamResponseSse(response, emit, requireCompleted = false) {
  const normalizer = createResponsesEventNormalizer(requireCompleted);
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
function chatUsageFromEvent(event) {
  const usage = event?.usage;
  if (!usage || typeof usage !== "object") return undefined;
  const inputTokens = typeof usage.prompt_tokens === "number" ? usage.prompt_tokens : undefined;
  const outputTokens = typeof usage.completion_tokens === "number" ? usage.completion_tokens : undefined;
  const totalTokens = typeof usage.total_tokens === "number" ? usage.total_tokens : undefined;
  return normalizedUsage({ inputTokens, outputTokens, totalTokens,
    cachedInputTokens: usage.prompt_tokens_details?.cached_tokens ?? usage.prompt_cache_hit_tokens,
    cacheWriteInputTokens: usage.prompt_tokens_details?.cache_write_tokens,
    reasoningTokens: usage.completion_tokens_details?.reasoning_tokens,
    inputAudioTokens: usage.prompt_tokens_details?.audio_tokens, outputAudioTokens: usage.completion_tokens_details?.audio_tokens });
}
function normalizedUsage(values) {
  const usage = Object.fromEntries(Object.entries(values).filter(([, value]) => typeof value === "number" && Number.isFinite(value) && value >= 0));
  return Object.keys(usage).length ? usage : undefined;
}
function responsesUsage(data) {
  const usage = data?.usage;
  if (!usage) return undefined;
  return normalizedUsage({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, totalTokens: usage.total_tokens,
    cachedInputTokens: usage.input_tokens_details?.cached_tokens, cacheWriteInputTokens: usage.input_tokens_details?.cache_write_tokens,
    reasoningTokens: usage.output_tokens_details?.reasoning_tokens });
}
function createChatCompletionsEventNormalizer() {
  const pendingToolCalls = new Map();
  const emitted = new Set();
  const keyFor = (toolCall) => String(toolCall?.index ?? toolCall?.id ?? pendingToolCalls.size);
  const emitToolCall = (key, emit) => {
    if (emitted.has(key)) return;
    const call = pendingToolCalls.get(key);
    if (!call?.name) return;
    emitted.add(key);
    emit({ type: "tool_call", toolCall: call });
  };
  return {
    handle(event, emit) {
      const usage = chatUsageFromEvent(event);
      if (usage) emit({ type: "usage", usage });
      for (const choice of Array.isArray(event?.choices) ? event.choices : []) {
        const delta = choice?.delta ?? {};
        if (typeof delta.content === "string" && delta.content) {
          emit({ type: "token", content: delta.content });
        }
        for (const toolCall of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const key = keyFor(toolCall);
          const current = pendingToolCalls.get(key) ?? {
            id: toolCall.id ?? key,
            name: "",
            argumentsJson: "",
          };
          if (toolCall.id) current.id = toolCall.id;
          if (toolCall.function?.name) current.name = toolCall.function.name;
          if (typeof toolCall.function?.arguments === "string") {
            current.argumentsJson += toolCall.function.arguments;
          }
          pendingToolCalls.set(key, current);
        }
        if (choice?.finish_reason === "tool_calls") {
          for (const key of pendingToolCalls.keys()) emitToolCall(key, emit);
        }
        const message = choice?.message;
        if (typeof message?.content === "string" && message.content) {
          emit({ type: "token", content: message.content });
        }
        for (const toolCall of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
          const key = keyFor(toolCall);
          const existing = pendingToolCalls.get(key) ?? {
            id: toolCall.id ?? key,
            name: "",
            argumentsJson: "",
          };
          pendingToolCalls.set(key, {
            ...existing,
            id: toolCall.id ?? existing.id,
            name: toolCall.function?.name ?? existing.name,
            argumentsJson: toolCall.function?.arguments ?? existing.argumentsJson,
          });
          emitToolCall(key, emit);
        }
      }
    },
    flush(emit) {
      for (const key of pendingToolCalls.keys()) emitToolCall(key, emit);
      emit({ type: "done" });
    },
  };
}
async function streamChatCompletionsSse(response, emit) {
  const normalizer = createChatCompletionsEventNormalizer();
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
  const textKeys = new Set();
  const textKeyForEvent = (event) => event?.item_id ?? `${event?.output_index ?? "default"}:${event?.content_index ?? "default"}`;
  const textKeysForItem = (event, item) =>
    [
      event?.item_id,
      item?.id,
      `${event?.output_index ?? "default"}:${event?.content_index ?? "default"}`,
      `${event?.output_index ?? "default"}:default`,
      `${event?.output_index ?? "default"}:0`,
    ].filter((key) => typeof key === "string" && key);
  for (const block of String(text).split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    if (!data || data === "[DONE]") continue;
    try {
      const event = JSON.parse(data);
      if (event?.type === "response.output_text.delta" && typeof event.delta === "string") {
        output += event.delta;
        textKeys.add(textKeyForEvent(event));
      }
      if (event?.type === "response.output_text.done" && typeof event.text === "string") {
        const key = textKeyForEvent(event);
        if (!textKeys.has(key)) output += event.text;
        textKeys.add(key);
      }
      if (event?.type === "response.content_part.done") {
        const key = textKeyForEvent(event);
        const partText = outputTextFromContentPart(event.part);
        if (partText && !textKeys.has(key)) output += partText;
        if (partText) textKeys.add(key);
      }
      if (event?.type === "response.output_item.done") {
        const itemText = outputTextFromMessageItem(event.item);
        const keys = textKeysForItem(event, event.item);
        if (itemText && !keys.some((key) => textKeys.has(key))) output += itemText;
        for (const key of keys) textKeys.add(key);
      }
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
/** Headers for the ChatGPT account path. Shared so the two call sites cannot drift. */
function chatGptRequestHeaders(auth, body) {
  return {
    authorization: `Bearer ${auth.access}`,
    "content-type": "application/json",
    originator: "aiboard",
    "user-agent": `aiboard-account-provider-runner/${VERSION}`,
    "session-id": boundedSessionId(body.sessionId),
  };
}
/** Request body for the ChatGPT account path. Shared so the two call sites cannot drift. */
function buildChatGptRequestBody(body) {
  const { instructions, input } = messagesToResponsesInput(
    Array.isArray(body.messages) ? body.messages : [],
    Array.isArray(body.attachments) ? body.attachments : []
  );
  const format = jsonSchemaResponseFormat(body.structuredOutput);
  const tools = openAiResponsesNativeTools(body);
  const functionTools = tools.filter((tool) => tool.type === "function");
  const planTools = [
    ...tools.filter((tool) => tool.type !== "function"),
    // A namespace requires a description; without one every ChatGPT call that carried tools was
    // refused with "Missing required parameter: 'tools[0].description'" (tunnel run, 2026-10-25).
    ...(functionTools.length ? [{
      type: "namespace",
      name: "aiboard",
      description: "AI Board tools for the current task: read and change the project, run checks, and report results.",
      tools: functionTools,
    }] : []),
  ];
  return {
    model: body.model,
    ...(instructions ? { instructions } : {}),
    input,
    ...responsesReasoningField(body),
    ...(format ? { text: { format } } : {}),
    ...(planTools.length ? { tools: planTools, tool_choice: "auto", parallel_tool_calls: true } : {}),
    prompt_cache_key: buildChatGptPromptCacheKey(body),
    stream: true,
    store: false,
  };
}
async function runChatGptChat(body, signal, onUsage) {
  const auth = await refreshChatGptToken(signal);
  const response = await fetch(`${CHATGPT_API_BASE}/responses`, {
    method: "POST",
    headers: chatGptRequestHeaders(auth, body),
    body: JSON.stringify(buildChatGptRequestBody(body)),
    signal,
  });
  if (!response.ok) throw upstreamHttpError(response, await readResponseBody(response), `ChatGPT request failed: ${response.status}`);
  let output = "";
  let failure;
  await streamResponseSse(response, (event) => {
    if (event.type === "token") output += event.content;
    if (event.type === "usage") onUsage?.(event.usage);
    if (event.type === "error") failure = Object.assign(new Error(event.error), event.errorMetadata);
  }, true);
  if (failure) throw failure;
  return output;
}
async function streamChatGptChat(body, req, res, signal, markComplete) {
  const auth = await refreshChatGptToken(signal);
  const response = await fetch(`${CHATGPT_API_BASE}/responses`, {
    method: "POST",
    headers: chatGptRequestHeaders(auth, body),
    body: JSON.stringify(buildChatGptRequestBody(body)),
    signal,
  });
  if (!response.ok) {
    const data = await readResponseBody(response);
    throw upstreamHttpError(response, data, `ChatGPT request failed: ${response.status}`);
  }
  res.writeHead(200, sseHeaders(req));
  try {
    await streamResponseSse(response, (event) => writeSse(res, event), true);
  } catch (err) {
    if (!signal.aborted && !res.destroyed && !res.writableEnded) {
      writeSse(res, { type: "error", error: errorMessage(err), errorMetadata: safeErrorMetadata(err) });
    }
  }
  if (!res.destroyed && !res.writableEnded) {
    markComplete();
    res.end();
  }
}
async function runGithubCopilotResponsesChat(body, headers, model, signal, onUsage) {
  const { instructions, input } = messagesToResponsesInput(Array.isArray(body.messages) ? body.messages : [], Array.isArray(body.attachments) ? body.attachments : []);
  const format = jsonSchemaResponseFormat(body.structuredOutput);
  const requestBody = { model, ...(instructions ? { instructions } : {}), input, ...maxOutputTokenField(body, "max_output_tokens"), ...responsesReasoningField(body), ...(format ? { text: { format } } : {}), store: false, stream: false };
  let response = await fetch(`${GITHUB_API_BASE}/responses`, { method: "POST", headers, body: JSON.stringify(requestBody), signal });
  if (response.status === 404 || response.status === 405) response = await fetch(`${GITHUB_API_BASE}/v1/responses`, { method: "POST", headers, body: JSON.stringify(requestBody), signal });
  const data = await readResponseBody(response);
  if (!response.ok) throw upstreamHttpError(response, data, `GitHub Copilot request failed: ${response.status}`);
  const text = extractText(data);
  onUsage?.(responsesUsage(data));
  return body.structuredOutput?.schema ? stripStructuredOutputFence(text) : text;
}
async function runGithubCopilotChat(body, signal, onUsage) {
  const current = authStore.githubCopilot;
  if (!current?.access) throw new Error("GitHub Copilot is not connected. Use Log in with GitHub first.");
  if (shouldUseGithubCopilotSdk(body)) return runGithubCopilotSdkChat(body, undefined, signal, undefined, onUsage);
  const headers = { authorization: `Bearer ${current.access}`, "content-type": "application/json", "user-agent": `aiboard-account-provider-runner/${VERSION}`, "x-github-api-version": GITHUB_API_VERSION, "openai-intent": "conversation-edits", "x-initiator": "user" };
  const model = body.model === "auto" ? "gpt-5.4" : body.model;
  if (shouldUseGithubResponses(model)) return runGithubCopilotResponsesChat(body, headers, model, signal, onUsage);
  const format = chatCompletionsResponseFormat(body.structuredOutput);
  const requestBody = { model, messages: Array.isArray(body.messages) ? messagesToCopilotChatMessages(body.messages, Array.isArray(body.attachments) ? body.attachments : []) : [], ...maxOutputTokenField(body, "max_tokens"), ...chatCompletionsReasoningField(body), ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}), ...(format ? { response_format: format } : {}), stream: false };
  let response = await fetch(`${GITHUB_API_BASE}/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody), signal });
  if (response.status === 404 || response.status === 405) response = await fetch(`${GITHUB_API_BASE}/v1/chat/completions`, { method: "POST", headers, body: JSON.stringify(requestBody), signal });
  const data = await response.json().catch(async () => ({ text: await response.text().catch(() => "") }));
  if (!response.ok) throw upstreamHttpError(response, data, `GitHub Copilot request failed: ${response.status}`);
  const text = extractText(data);
  onUsage?.(chatUsageFromEvent(data));
  return body.structuredOutput?.schema ? stripStructuredOutputFence(text) : text;
}
function nvidiaApiKey(body) {
  const apiKey = String(body.apiKey ?? "").trim();
  if (!apiKey) throw new Error("NVIDIA API key is required.");
  return apiKey;
}
function nvidiaChatHeaders(body) {
  return {
    authorization: `Bearer ${nvidiaApiKey(body)}`,
    "content-type": "application/json",
    "user-agent": `aiboard-account-provider-runner/${VERSION}`,
  };
}
function nvidiaChatTemplateKwargs(body, format, tools) {
  const model = String(body.model ?? "").toLowerCase();
  if (!model.startsWith("nvidia/nemotron-3-ultra-550b-a55b")) return {};
  if (!format && !tools.length) return {};
  return {
    chat_template_kwargs: {
      enable_thinking: tools.length ? true : false,
      force_nonempty_content: true,
    },
  };
}
function nvidiaChatRequestBody(body, stream) {
  const format = chatCompletionsResponseFormat(body.structuredOutput);
  const tools = openAiChatNativeTools(body);
  return {
    model: body.model,
    messages: Array.isArray(body.messages) ? messagesToCopilotChatMessages(body.messages, Array.isArray(body.attachments) ? body.attachments : []) : [],
    ...maxOutputTokenField(body, "max_tokens"),
    ...(typeof body.temperature === "number" ? { temperature: body.temperature } : {}),
    ...(format ? { response_format: format } : {}),
    ...(tools.length ? { tools, tool_choice: "auto", parallel_tool_calls: true } : {}),
    ...nvidiaChatTemplateKwargs(body, format, tools),
    stream,
  };
}
async function listNvidiaModels(body) {
  const response = await fetch(`${NVIDIA_API_BASE}/models`, {
    method: "GET",
    headers: nvidiaChatHeaders(body),
  });
  const data = await readResponseBody(response);
  if (!response.ok) throw upstreamHttpError(response, data, `NVIDIA NIM model catalog request failed: ${response.status}`);
  return Array.isArray(data?.data) ? data.data : [];
}
async function runNvidiaChat(body, signal, onUsage) {
  const response = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
    method: "POST",
    headers: nvidiaChatHeaders(body),
    body: JSON.stringify(nvidiaChatRequestBody(body, false)),
    signal,
  });
  const data = await readResponseBody(response);
  if (!response.ok) throw upstreamHttpError(response, data, `NVIDIA NIM request failed: ${response.status}`);
  onUsage?.(chatUsageFromEvent(data));
  return extractText(data);
}
async function streamNvidiaChat(body, req, res, signal, markComplete) {
  const response = await fetch(`${NVIDIA_API_BASE}/chat/completions`, {
    method: "POST",
    headers: nvidiaChatHeaders(body),
    body: JSON.stringify(nvidiaChatRequestBody(body, true)),
    signal,
  });
  if (!response.ok) {
    const data = await readResponseBody(response);
    throw upstreamHttpError(response, data, `NVIDIA NIM request failed: ${response.status}`);
  }
  res.writeHead(200, sseHeaders(req));
  try {
    await streamChatCompletionsSse(response, (event) => writeSse(res, event));
  } catch (err) {
    if (!signal.aborted && !res.destroyed && !res.writableEnded) {
      writeSse(res, { type: "error", error: errorMessage(err), errorMetadata: safeErrorMetadata(err) });
    }
  }
  if (!res.destroyed && !res.writableEnded) {
    markComplete();
    res.end();
  }
}

const server = http.createServer(async (req, res) => {
  if (await pairing.handle(req, res)) return;
  const url = new URL(req.url ?? "/", `http://localhost:${port}`);
  if (req.method === "OPTIONS") return (res.writeHead(204, corsHeaders(req)), res.end());
  if (req.method === "GET" && (url.pathname === "/auth/callback" || url.pathname === "/auth/chatgpt/callback")) return handleChatGptCallback(req, res, url);
  if (req.method === "GET" && url.pathname === "/health") return json(req, res, 200, { ok: true, version: VERSION, providers: { chatgpt: { ok: true, connected: chatGptPlanEnabled(authStore.chatgpt), requiresSignIn: !chatGptPlanEnabled(authStore.chatgpt) }, "github-copilot": providerStatus("github-copilot"), nvidia: providerStatus("nvidia") } });
  if (!authorized(req)) return json(req, res, 401, { error: "Unauthorized runner token" });
  const match = url.pathname.match(/^\/providers\/(chatgpt|github-copilot|nvidia)\/(status|login|models|capabilities|chat)$/);
  if (!match) return json(req, res, 404, { error: "Not found" });
  const [, provider, action] = match;
  try {
    if (req.method === "GET" && action === "status") return json(req, res, 200, providerStatus(provider));
    if ((req.method === "GET" || req.method === "POST") && action === "capabilities") {
      const body = req.method === "POST" ? parseJsonBody(await readBody(req)) : {};
      return json(req, res, 200, await providerCapabilities(provider, body));
    }
    if (req.method === "POST" && action === "login") {
      if (provider === "nvidia") return json(req, res, 400, { error: "NVIDIA NIM uses an API key; no account login is required." });
      return provider === "chatgpt" ? await startChatGptLogin(req, res) : await startGithubCopilotLogin(req, res);
    }
    if (req.method === "POST" && action === "models") {
      const body = parseJsonBody(await readBody(req));
      const models = provider === "chatgpt"
        ? await listChatGptModels()
        : provider === "nvidia"
          ? await listNvidiaModels(body)
          : await listGithubCopilotModels();
      return json(req, res, 200, { ok: true, data: models });
    }
    if (req.method === "POST" && action === "chat") {
      const cancellation = createRequestCancellation(req, res);
      try {
        const body = parseJsonBody(await readBody(req));
        let usage;
        const onUsage = (next) => { if (next) usage = { ...usage, ...next }; };
        if (provider === "nvidia" && body.stream) {
          return await streamNvidiaChat(body, req, res, cancellation.signal, () => cancellation.markComplete());
        }
        if (provider === "nvidia") {
          const content = await runNvidiaChat(body, cancellation.signal, onUsage);
          cancellation.markComplete();
          return json(req, res, 200, { ok: true, content, ...(usage ? { usage } : {}) });
        }
        if (provider === "chatgpt" && body.stream) {
          return await streamChatGptChat(body, req, res, cancellation.signal, () => cancellation.markComplete());
        }
        if (provider === "github-copilot" && body.stream && shouldUseGithubCopilotSdk(body)) {
          return await streamGithubCopilotSdkChat(body, req, res, cancellation.signal, () => cancellation.markComplete());
        }
        const content = provider === "chatgpt"
          ? await runChatGptChat(body, cancellation.signal, onUsage)
          : await runGithubCopilotChat(body, cancellation.signal, onUsage);
        cancellation.markComplete();
        return json(req, res, 200, { ok: true, content, ...(usage ? { usage } : {}) });
      } catch (err) {
        if (!cancellation.disconnected) throw err;
      } finally {
        cancellation.cleanup();
      }
      return;
    }
    return json(req, res, 405, { error: "Method not allowed" });
  } catch (err) {
    return failRequest(req, res, err);
  }
});
function printStartup() {
  console.log("AI Board — account-provider runner");
  console.log("──────────────────────────────────");
  console.log(`Version   : v${VERSION}`);
  console.log(`URL       : http://${host}:${port}`);
  // A launcher-started runner never prints its reusable token; the browser pairs through aiboard instead.
  console.log(`Token     : ${process.send ? "held by aiboard (this tab pairs automatically)" : token}`);
  console.log(`Auth file : ${authFile}`);
  console.log("Paste the URL and token into Settings for ChatGPT Plus/Pro, GitHub Copilot, or NVIDIA NIM.");
}
server.on("error", (err) => {
  if (!explicitPort && err?.code === "EADDRINUSE" && port === DEFAULT_PORT) {
    console.warn(`Port ${DEFAULT_PORT} is busy; trying ${FALLBACK_PORT}.`);
    port = FALLBACK_PORT;
    server.listen(port, host, () => { printStartup(); void pairing.attach(); });
    return;
  }
  console.error(`Failed to start account-provider runner on ${host}:${port}: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
server.listen(port, host, () => { printStartup(); void pairing.attach(); });
