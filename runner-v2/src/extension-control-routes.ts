import { readdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute } from "node:path";

import type { ChatAgentSessions } from "./chat-agent-session.js";
import { EXTENSION_LIMITS, ExtensionManagementError, type InstallPolicy } from "./extension-management-contracts.js";
import type { ExtensionManagementService, PlanRequest } from "./extension-management-service.js";
import { parseSourceRequest } from "./extension-sources.js";

const UI = { kind: "ui" } as const;
export const OAUTH_CALLBACK_PATH = "/v2/extensions/oauth/callback";
const MAX_JSON_BYTES = 256 * 1024;
const MAX_BROWSE_ENTRIES = 300;

export interface ExtensionRouteDependencies {
  readonly extensions?: ExtensionManagementService;
  readonly chatSessions?: ChatAgentSessions;
}

/**
 * /v2/extensions/* and /v2/chat-sessions/* on the authenticated control plane. Requests reaching here
 * already passed the runner-token and origin checks, so they act as the user ("ui" caller). Secret
 * values arrive only in request bodies, are passed straight to the credential store and never echoed.
 */
export async function routeExtensions(request: IncomingMessage, response: ServerResponse, url: URL, segments: readonly string[], deps: ExtensionRouteDependencies): Promise<boolean> {
  if (segments[1] === "chat-sessions") {
    const sessions = deps.chatSessions;
    if (!sessions) throw new ExtensionManagementError("chat_sessions_unavailable", "Runner chat sessions are unavailable; update the Runner.", 404);
    if (segments.length === 2 && request.method === "POST") return send(response, 200, await sessions.create(await body(request)));
    if (segments.length === 3 && request.method === "GET") return send(response, 200, await sessions.get(segments[2]));
    if (segments.length === 4 && segments[3] === "messages" && request.method === "POST") {
      const input = await body<{ messageId: string; text: string; history?: { role: "user" | "assistant"; text: string }[] }>(request);
      return send(response, 202, await sessions.send(segments[2], { messageId: input.messageId, text: input.text, ...(input.history ? { history: input.history } : {}) }));
    }
    if (segments.length === 4 && segments[3] === "stop" && request.method === "POST") return send(response, 200, await sessions.stop(segments[2]));
    throw new ExtensionManagementError("not_found", "Unknown chat session endpoint.", 404);
  }
  if (segments[1] !== "extensions") return false;
  const service = deps.extensions;
  if (!service) throw new ExtensionManagementError("extensions_unavailable", "Extension management is unavailable on this Runner; update it.", 404);
  const [, , first, second, third] = segments;
  if (segments.length === 2 && request.method === "GET") return send(response, 200, await service.inventory());
  if (first === "generation" && segments.length === 3 && request.method === "GET") {
    const raw = url.searchParams.get("generation");
    return send(response, 200, await service.generation(raw === null ? undefined : Number.parseInt(raw, 10)));
  }
  if (first === "policy" && segments.length === 3 && request.method === "PUT") return send(response, 200, await service.setPolicy((await body<{ policy: InstallPolicy }>(request)).policy, UI));
  if (first === "migrations" && second === "provider-hosted-mcp" && segments.length === 4 && request.method === "POST") {
    const input = await body<{ name?: unknown; url?: unknown; enabled?: unknown; hasToken?: unknown }>(request);
    if ("authorizationToken" in input || "token" in input) throw new ExtensionManagementError("invalid_request", "Tokens are not migrated; they stay in the browser.");
    if (typeof input.name !== "string" || typeof input.url !== "string" || typeof input.enabled !== "boolean") throw new ExtensionManagementError("invalid_request", "name, url and enabled are required.");
    return send(response, 200, await service.recordProviderHostedMcp({ name: input.name, url: input.url, enabled: input.enabled, hasToken: input.hasToken === true }, UI));
  }
  if (first === "adopt-cli-mcp" && segments.length === 3 && request.method === "POST") {
    const input = await body<{ name?: unknown }>(request);
    if (typeof input.name !== "string") throw new ExtensionManagementError("invalid_request", "name is required.");
    return send(response, 200, await service.inspectAdoption(input.name, UI));
  }
  if (first === "inspect" && segments.length === 3 && request.method === "POST") return send(response, 200, await service.inspectSource(parseSourceRequest((await body<{ source: unknown }>(request)).source), UI));
  if (first === "uploads" && segments.length === 3 && request.method === "POST") {
    const filename = url.searchParams.get("filename") ?? "";
    return send(response, 200, await service.storeUpload(filename, await raw(request, EXTENSION_LIMITS.maxArchiveBytes)));
  }
  if (first === "plans" && segments.length === 3 && request.method === "POST") return send(response, 200, await service.planChange(planRequest(await body(request), service), UI));
  if (first === "operations") {
    if (segments.length === 3 && request.method === "GET") return send(response, 200, { operations: await service.listOperations() });
    if (segments.length === 3 && request.method === "POST") {
      const input = await body<{ planId: string; planDigest: string; key: string }>(request);
      return send(response, 200, await service.applyChange({ planId: input.planId, planDigest: input.planDigest, key: input.key }, UI));
    }
    if (segments.length === 4 && request.method === "GET") return send(response, 200, await service.operationStatus(second!, UI));
    if (segments.length === 5 && third === "approve" && request.method === "POST") return send(response, 200, await service.approve(second!, (await body<{ planDigest: string }>(request)).planDigest, UI));
    if (segments.length === 5 && third === "decline" && request.method === "POST") return send(response, 200, await service.decline(second!, UI));
  }
  if (first === "credentials" && segments.length === 3 && request.method === "POST") {
    const input = await body<{ target: string; name: string; value: string }>(request);
    if (typeof input.target !== "string" || typeof input.name !== "string" || typeof input.value !== "string") throw new ExtensionManagementError("invalid_request", "target, name and value are required.");
    const result = await service.submitCredential(input.target, input.name, input.value, UI);
    // The response confirms storage by name only.
    return send(response, 200, { stored: input.name, result });
  }
  if (first === "browse" && segments.length === 3 && request.method === "GET") return send(response, 200, await browse(url.searchParams.get("path")));
  if (first && segments.length === 4 && second === "test" && request.method === "POST") return send(response, 200, await service.test(first));
  if (first && segments.length === 4 && second === "sign-in" && request.method === "POST") return send(response, 200, await service.beginSignIn(first, UI));
  if (first && segments.length === 4 && second === "tool-filter-policy") {
    if (request.method === "GET") return send(response, 200, await service.extensionToolPolicy(first));
    if (request.method === "PUT") return send(response, 200, await service.setExtensionToolPolicy(first, (await body<{ policy: unknown }>(request)).policy, UI));
  }
  if (first && segments.length === 4 && second === "tool-policy") {
    if (request.method === "GET") return send(response, 200, { policy: await service.toolPolicy(first) });
    if (request.method === "PUT") return send(response, 200, { policy: await service.setToolPolicy(first, (await body<{ policy: string }>(request)).policy, UI) });
  }
  // POST (not DELETE): the control plane's CORS policy admits GET/POST/PUT only.
  if (first && segments.length === 5 && second === "credentials" && third === "revoke" && request.method === "POST") return send(response, 200, await service.revokeCredentials(first, UI));
  throw new ExtensionManagementError("not_found", "Unknown extensions endpoint.", 404);
}

/**
 * The OAuth redirect target. It is reached by the user's browser from the authorization server, so it
 * cannot carry the runner token: it accepts only a single-use state this Runner issued, and its page
 * shows no token or code.
 */
export async function handleOAuthCallback(response: ServerResponse, url: URL, service: ExtensionManagementService): Promise<void> {
  let title = "Signed in";
  let message = "You can close this tab and return to AI Board.";
  let status = 200;
  try {
    const error = url.searchParams.get("error");
    if (error) throw new ExtensionManagementError("sign_in_denied", "Sign-in was cancelled or denied.", 400);
    const result = await service.completeSignIn(url.searchParams.get("state") ?? "", url.searchParams.get("code") ?? "");
    if (result.readiness.state !== "ready") message = `Signed in, but the server is not ready yet (${result.readiness.state.replaceAll("_", " ")}). Check it in AI Board.`;
  } catch (error) {
    title = "Sign-in failed";
    message = error instanceof ExtensionManagementError ? error.message : "The sign-in could not be completed.";
    status = error instanceof ExtensionManagementError ? error.status : 500;
  }
  const escape = (text: string) => text.replace(/[&<>"']/g, (character) => `&#${character.charCodeAt(0)};`);
  response.statusCode = status;
  response.setHeader("content-type", "text/html; charset=utf-8");
  response.setHeader("cache-control", "no-store");
  response.setHeader("referrer-policy", "no-referrer");
  response.setHeader("content-security-policy", "default-src 'none'; style-src 'unsafe-inline'");
  response.end(`<!doctype html><meta charset="utf-8"><title>${escape(title)}</title><body style="font-family:system-ui;margin:3rem"><h1>${escape(title)}</h1><p>${escape(message)}</p></body>`);
}

function planRequest(input: Record<string, unknown>, service: ExtensionManagementService): PlanRequest {
  const action = input.action;
  if (action === "install" || action === "update") {
    if (typeof input.inspectionId !== "string") throw new ExtensionManagementError("invalid_request", "inspectionId is required.");
    if (input.componentIds !== undefined && (!Array.isArray(input.componentIds) || input.componentIds.some((id) => typeof id !== "string"))) throw new ExtensionManagementError("invalid_request", "componentIds must be strings.");
    return {
      action, inspectionId: input.inspectionId,
      ...(input.componentIds ? { componentIds: input.componentIds as string[] } : {}),
      scope: input.scope === "project" ? service.projectScope() : { kind: "user" },
      ...(typeof input.name === "string" ? { name: input.name } : {}),
    };
  }
  if (action === "enable" || action === "disable" || action === "remove" || action === "rollback") {
    if (typeof input.extensionId !== "string") throw new ExtensionManagementError("invalid_request", "extensionId is required.");
    return { action, extensionId: input.extensionId, ...(typeof input.versionId === "string" ? { versionId: input.versionId } : {}) };
  }
  throw new ExtensionManagementError("invalid_request", "action must be install, update, enable, disable, remove or rollback.");
}

/**
 * Native folder browsing for the Settings picker when the browser's directory picker cannot hand a
 * path to the Runner. Lists directory names only, never file contents.
 */
async function browse(path: string | null): Promise<{ path: string; parent?: string; directories: string[]; hasSkill: boolean; roots?: string[] }> {
  if (!path) {
    const roots = process.platform === "win32"
      ? (await Promise.all("CDEFGHIJKLMNOPQRSTUVWXYZ".split("").map(async (letter) => (await stat(`${letter}:\\`).catch(() => undefined)) ? `${letter}:\\` : undefined))).filter((entry): entry is string => entry !== undefined)
      : ["/"];
    const home = process.env.USERPROFILE ?? process.env.HOME;
    return { path: "", directories: [], hasSkill: false, roots: home ? [home, ...roots] : roots };
  }
  if (!isAbsolute(path)) throw new ExtensionManagementError("invalid_path", "Choose an absolute folder path.");
  let canonical: string;
  try {
    canonical = await realpath(path);
  } catch {
    throw new ExtensionManagementError("source_not_found", "That folder does not exist.", 404);
  }
  if (!(await stat(canonical)).isDirectory()) throw new ExtensionManagementError("source_not_directory", "That path is not a folder.");
  const entries = await readdir(canonical, { withFileTypes: true }).catch(() => []);
  const directories = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".")).map((entry) => entry.name).sort((a, b) => a.localeCompare(b)).slice(0, MAX_BROWSE_ENTRIES);
  const parent = dirname(canonical);
  return {
    path: canonical,
    ...(parent !== canonical ? { parent } : {}),
    directories,
    hasSkill: entries.some((entry) => entry.isFile() && entry.name === "SKILL.md"),
  };
}

async function body<T = Record<string, unknown>>(request: IncomingMessage): Promise<T> {
  const bytes = await raw(request, MAX_JSON_BYTES);
  try {
    const value = JSON.parse(bytes.toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("not an object");
    return value as T;
  } catch {
    throw new ExtensionManagementError("invalid_request", "Request body must be a JSON object.");
  }
}

async function raw(request: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const declared = Number(request.headers["content-length"] ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) {
    request.resume();
    throw new ExtensionManagementError("body_too_large", "Request body is too large.", 413);
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > maxBytes) {
      request.resume();
      throw new ExtensionManagementError("body_too_large", "Request body is too large.", 413);
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

function send(response: ServerResponse, status: number, value: unknown): true {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.end(JSON.stringify(value));
  return true;
}
