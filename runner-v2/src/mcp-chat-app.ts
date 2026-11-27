import { appResourceDomains } from "./mcp-app-resource-policy.js";
import { randomUUID } from "node:crypto";

const MAX_HTML_BYTES = 512 * 1024;
const MAX_DATA_BYTES = 768 * 1024;
const MAX_TOTAL_BYTES = 12 * 1024 * 1024;
const TTL_MS = 30 * 60_000;
const MIME = "text/html;profile=mcp-app";
const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
export interface McpChatAppSummary { id: string; server: string; tool: string; uri: string; expiresAt: number }
export interface McpChatAppPayload extends McpChatAppSummary {
  resourceDomains?: readonly string[];
  allowedTools?: readonly string[]; html: string; arguments: Record<string, unknown>; result: { content: unknown[]; isError: boolean; structuredContent?: unknown; _meta?: Record<string, unknown> };
}
export type McpAppResult = McpChatAppPayload["result"];
export type McpAppCallRisk = "read_only" | "write" | "destructive";
export function appCallRisk(tool: {annotations?: Record<string, unknown>}): McpAppCallRisk {
  if (tool.annotations?.destructiveHint !== false) return "destructive";
  return tool.annotations.readOnlyHint === true ? "read_only" : "write";
}
export type McpAppAuthority = {
  readonly risks?: Readonly<Record<string, McpAppCallRisk>>;
  readonly tools: readonly string[];
  call(name: string, args: Record<string, unknown>, signal: AbortSignal, stillAllowed: () => boolean): Promise<McpAppResult>;
};
export type McpAppPublisher = (app: Omit<McpChatAppPayload, "id" | "expiresAt">, authority?: McpAppAuthority) => void;
export interface McpAppCallTicket { risk: McpAppCallRisk; id: string; name: string; arguments: Record<string, unknown>; expiresAt: number }
export class McpAppCallError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const MAX_CALL_BYTES = 16 * 1024;
const MAX_CALLS_PER_APP = 20;
const CALL_TTL = 60_000;
const refused = (): McpAppResult => ({ content: [{ type: "text", text: "App call declined or unavailable." }], isError: true });

export function appUri(raw: unknown): string | undefined {
  if (typeof raw !== "string" || raw.length > 1024 || !raw.startsWith("ui://") || /[\s\x00-\x1f]/u.test(raw)) return;
  try { const url = new URL(raw); if (url.protocol === "ui:" && url.hostname && !url.username && !url.password && !url.hash) return raw; } catch { /* invalid */ }
}
export function appToolMeta(raw: unknown): { resourceUri?: string; appOnly: boolean; modelOnly?: true } {
  const meta = obj(raw) ? raw : {};
  const ui = obj(meta.ui) ? meta.ui : {};
  const resourceUri = appUri(ui.resourceUri ?? meta["ui/resourceUri"]);
  const appOnly = Array.isArray(ui.visibility) && ui.visibility.includes("app") && !ui.visibility.includes("model");
  const modelOnly = Array.isArray(ui.visibility) && !ui.visibility.includes("app");
  return { resourceUri, appOnly, ...(modelOnly ? { modelOnly: true as const } : {}) };
}
export interface McpAppResourceDocument { html: string; resourceDomains: readonly string[] }
export function appResourceDocument(uri: string, raw: unknown): McpAppResourceDocument | undefined {
  if (!obj(raw) || !Array.isArray(raw.contents) || raw.contents.length !== 1) return;
  const c = raw.contents[0];
  if (!obj(c) || c.uri !== uri || c.mimeType !== MIME || typeof c.text !== "string" ||
      !c.text.trim() || Buffer.byteLength(c.text) > MAX_HTML_BYTES) return;
  // Static resource origins are opt-in in the trusted host. No connection, frame, base URI or device permission grants.
  const meta = obj(c._meta) ? c._meta : {};
  const ui = obj(meta.ui) ? meta.ui : {};
  if (ui.csp !== undefined && (!obj(ui.csp) || Object.entries(ui.csp).some(([key,v]) =>
    key !== "resourceDomains" && (!Array.isArray(v) || v.length)))) return;
  const domains = appResourceDomains(obj(ui.csp) ? ui.csp.resourceDomains : undefined);
  if (!domains) return;
  if (ui.permissions !== undefined && (!obj(ui.permissions) || Object.keys(ui.permissions).length)) return;
  return {html:c.text,resourceDomains:domains};
}
/** Compatibility helper for callers that require a self-contained document. */
export function appHtml(uri: string, raw: unknown): string | undefined {
  const document=appResourceDocument(uri,raw);
  return document && !document.resourceDomains.length ? document.html : undefined;
}
type Stored = { session: string; data: McpChatAppPayload; bytes: number; authority?: McpAppAuthority;
  pending?: McpAppCallTicket; active?: AbortController; calls: number };
/** Ephemeral per-chat results; never written to transcript, log, disk, or model context. */
export class McpChatApps {
  private readonly items = new Map<string, Stored>();
  private bytes = 0;
  private closed = false;
  private readonly activeCalls = new Set<Promise<McpAppResult>>();
  private remove(id: string) {
    const item = this.items.get(id);
    if (item) { item.active?.abort(); this.bytes -= item.bytes; this.items.delete(id); }
  }
  private prune(now = Date.now()) {
    for (const [id, item] of this.items) if (item.data.expiresAt <= now) this.remove(id);
  }
  publish(session: string, input: Omit<McpChatAppPayload, "id" | "expiresAt">, authority?: McpAppAuthority): void {
    if (this.closed) return;
    this.prune();
    const resourceDomains=appResourceDomains(input.resourceDomains);
    if (!resourceDomains) return;
    const dataBytes = Buffer.byteLength(JSON.stringify({ arguments: input.arguments, result: input.result, resourceDomains }));
    const bytes = dataBytes + Buffer.byteLength(input.html);
    if (!appUri(input.uri) || dataBytes > MAX_DATA_BYTES || Buffer.byteLength(input.html) > MAX_HTML_BYTES || bytes > MAX_TOTAL_BYTES) return;
    const own = [...this.items.entries()].filter(([, item]) => item.session === session);
    for (const [id] of own.slice(0, Math.max(0, own.length - 3))) this.remove(id);
    while (this.bytes + bytes > MAX_TOTAL_BYTES || this.items.size >= 32) {
      const first = this.items.keys().next().value;
      if (!first) return;
      this.remove(first);
    }
    const id = randomUUID();
    this.items.set(id, { session, data: structuredClone({ ...input, resourceDomains, allowedTools: authority?.tools ?? [], id, expiresAt: Date.now() + TTL_MS }), bytes, authority, calls: 0 });
    this.bytes += bytes;
  }
  list(session: string): McpChatAppSummary[] {
    this.prune();
    return [...this.items.values()].filter(item => item.session === session).map(({data: { id, server, tool, uri, expiresAt }}) => ({ id, server, tool, uri, expiresAt }));
  }
  get(session: string, id: string): McpChatAppPayload | undefined {
    this.prune();
    const item = this.items.get(id);
    return item?.session === session ? structuredClone(item.data) : undefined;
  }
  stage(session: string, id: string, raw: unknown): McpAppCallTicket {
    this.prune();
    const item = this.items.get(id);
    if (!item || item.session !== session) throw new McpAppCallError("App unavailable.", 404);
    if (!obj(raw) || typeof raw.name !== "string" || !obj(raw.arguments) ||
        !item.authority?.tools.includes(raw.name) || Object.keys(raw).some(key => key !== "name" && key !== "arguments"))
      throw new McpAppCallError("Tool is not available to this app.", 403);
    if (item.active || (item.pending && item.pending.expiresAt > Date.now()) || item.calls >= MAX_CALLS_PER_APP)
      throw new McpAppCallError("App call limit reached or another request is pending.", 409);
    const serialized = JSON.stringify(raw.arguments);
    if (Buffer.byteLength(serialized) > MAX_CALL_BYTES) throw new McpAppCallError("App arguments exceed the size limit.");
    const ticket = { risk: item.authority.risks?.[raw.name] ?? "destructive" as const, id: randomUUID(), name: raw.name, arguments: JSON.parse(serialized) as Record<string, unknown>, expiresAt: Math.min(item.data.expiresAt, Date.now() + CALL_TTL) };
    item.pending = ticket;
    item.calls++;
    return structuredClone(ticket);
  }
  async answer(session: string, id: string, ticketId: string, approve: boolean): Promise<McpAppResult> {
    this.prune();
    const item = this.items.get(id);
    if (!item || item.session !== session || !item.authority || !item.pending || item.pending.id !== ticketId ||
        item.pending.expiresAt <= Date.now() || item.active) throw new McpAppCallError("App request expired or unavailable.", 404);
    const ticket = item.pending;
    item.pending = undefined;
    if (!approve) return refused();
    const controller = new AbortController();
    item.active = controller;
    const timer = setTimeout(() => controller.abort(), Math.min(60_000, item.data.expiresAt - Date.now()));
    const allowed = () => !controller.signal.aborted && this.items.get(id) === item && item.data.expiresAt > Date.now();
    const call = Promise.resolve().then(() => allowed() ? item.authority!.call(ticket.name, ticket.arguments, controller.signal, allowed) : refused());
    this.activeCalls.add(call);
    try {
      const result = await call;
      if (!allowed()) return { content: [{ type: "text", text: "App call ended or was interrupted; do not assume the effect failed." }], isError: true };
      if (Buffer.byteLength(JSON.stringify(result)) > MAX_DATA_BYTES) return { content: [{ type: "text", text: "App result exceeds the display size limit." }], isError: true };
      return result;
    } catch {
      return { content: [{ type: "text", text: "App call unavailable or interrupted. It was not retried." }], isError: true };
    } finally { clearTimeout(timer); item.active = undefined; this.activeCalls.delete(call); }
  }
  async close(): Promise<void> {
    this.closed = true;
    for (const id of this.items.keys()) this.remove(id);
    await Promise.allSettled([...this.activeCalls]);
  }
  dismiss(session: string, id: string): boolean {
    const item = this.items.get(id);
    if (!item || item.session !== session) return false;
    this.remove(id);
    return true;
  }
}
