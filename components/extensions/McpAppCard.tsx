"use client";

import { useEffect, useRef, useState } from "react";
import { AppBridge, PostMessageTransport } from "@modelcontextprotocol/ext-apps/app-bridge";
import { CallToolResultSchema } from "@modelcontextprotocol/core";
import { dismissRunnerMcpApp, getRunnerMcpApp, stageRunnerMcpAppCall, answerRunnerMcpAppCall, type McpAppCallTicketDto, type McpChatAppDto, type McpChatAppPayloadDto } from "@/lib/client/runner-extensions";
import type { NativeRunnerConnection } from "@/lib/client/runner-v2";
import { appResourceDomains } from "@/runner-v2/src/mcp-app-resource-policy";
import { appHeight, MCP_APP_PERMISSIONS, MCP_APP_SANDBOX, mcpAppSrcdoc } from "@/lib/client/mcp-app-sandbox";

function AppFrame({ payload, approvedDomains, onClose, connection, sessionId }: { payload: McpChatAppPayloadDto; approvedDomains: readonly string[]; onClose: () => void; connection: NativeRunnerConnection; sessionId: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(360);
  const [state, setState] = useState("Connecting to app?");
  const [expanded, setExpanded] = useState(false);
  const [ticket, setTicket] = useState<McpAppCallTicketDto>();
  const [calling, setCalling] = useState(false);
  const decision = useRef<((approve: boolean) => void) | undefined>(undefined);
  const answer = (approve: boolean) => decision.current?.(approve);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const iframe = frame.current;
    const target = iframe?.contentWindow;
    if (!iframe || !target) return;
    let disposed = false;
    let initialized = false;
    const result = CallToolResultSchema.safeParse(payload.result);
    if (!result.success) { setState("The server returned an incompatible app result."); return; }
    // No direct client or credentials enter the frame. All calls go through a
    // one-use Runner ticket and a trusted host-rendered confirmation.
    const bridge = new AppBridge(null, { name: "AIBoard", version: "2" }, payload.allowedTools?.length ? { serverTools: {} } : {}, {
      hostContext: { displayMode: "inline", availableDisplayModes: ["inline"], theme: window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light" },
    });
    const transport = new PostMessageTransport(target, target);
    let active = false;
    const denied = () => ({ content: [{ type: "text" as const, text: "App call declined or unavailable." }], isError: true });
    bridge.oncalltool = async (params) => {
      if (disposed || !initialized || active || !payload.allowedTools?.includes(params.name)) return denied();
      active = true;
      try {
        const staged = await stageRunnerMcpAppCall(connection, sessionId, payload.id, params.name, params.arguments ?? {});
        if (disposed) {
          await answerRunnerMcpAppCall(connection, sessionId, payload.id, staged.id, false).catch(() => undefined);
          return denied();
        }
        setTicket(staged);
        const approved = await new Promise<boolean>(resolve => {
          const expiry = window.setTimeout(() => finish(false), Math.max(0, staged.expiresAt - Date.now()));
          function finish(value: boolean) {
            window.clearTimeout(expiry);
            decision.current = undefined;
            resolve(value);
          }
          decision.current = finish;
        });
        if (!disposed) { setTicket(undefined); setCalling(approved); }
        const reply = await answerRunnerMcpAppCall(connection, sessionId, payload.id, staged.id, approved && !disposed);
        const parsed = CallToolResultSchema.safeParse(reply);
        return !disposed && parsed.success ? parsed.data : denied();
      } catch { return denied(); }
      finally { active = false; if (!disposed) { setTicket(undefined); setCalling(false); } }
    };
    bridge.onreadresource = async () => { throw new Error("App-initiated resource reads are not enabled."); };
    bridge.onmessage = async () => ({ isError: true });
    bridge.onopenlink = async () => ({ isError: true });
    bridge.ondownloadfile = async () => ({ isError: true });
    bridge.onupdatemodelcontext = async () => { throw new Error("Apps cannot change model context."); };
    bridge.onrequestdisplaymode = async () => ({ mode: "inline" });
    bridge.onrequestteardown = () => closeRef.current();
    bridge.onsizechange = value => { if (!disposed && initialized) setHeight(appHeight(value.height)); };
    bridge.oninitialized = () => {
      if (disposed || initialized) return;
      initialized = true;
      setState("");
      void (async () => {
        await bridge.sendToolInput({ arguments: payload.arguments });
        if (!disposed) await bridge.sendToolResult(result.data);
      })().catch(() => { if (!disposed) setState("Could not deliver the tool result to the app."); });
    };
    const timer = window.setTimeout(() => { if (!disposed && !initialized) setState("App did not initialize. It may need unsupported capabilities."); }, 10000);
    void bridge.connect(transport).then(() => {
      if (!disposed) iframe.srcdoc = mcpAppSrcdoc(payload.html, approvedDomains);
    }).catch(() => { if (!disposed) setState("Could not initialize the app bridge."); });
    return () => {
      disposed = true;
      decision.current?.(false);
      window.clearTimeout(timer);
      if (initialized) void bridge.teardownResource({}, { timeout: 500 }).catch(() => undefined).finally(() => void bridge.close().catch(() => undefined));
      else void bridge.close().catch(() => undefined);
    };
  }, [payload, approvedDomains, connection.url, connection.token, sessionId]);
  return (
    <div className={expanded ? "fixed inset-4 z-50 rounded-xl border bg-background p-4 shadow-lg flex flex-col gap-2" : "space-y-2"}>
      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
        <span>{state || "Interactive app ? isolated view"}</span>
        <div className="flex gap-2">
          <button type="button" className="rounded border px-2 py-1" onClick={() => setExpanded(v => !v)}>{expanded ? "Minimize" : "Expand"}</button>
          <button type="button" className="rounded border px-2 py-1" onClick={onClose}>Close</button>
        </div>
      </div>
      {ticket && <section role="alertdialog" aria-label="Confirm app tool call" className="rounded border border-amber-500 bg-background p-3 space-y-2">
        <div className="text-sm font-semibold">Allow this app to call {payload.server} / {ticket.name}?</div>
        <p className="text-xs text-muted-foreground">{ticket.risk === "read_only" ? "The server marks this tool as read-only and non-destructive. These are server claims." : ticket.risk === "write" ? "This operation can modify data or external state." : "This operation may be destructive, irreversible, or have unspecified effects."} Review the exact arguments before authorizing this one call.</p>
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all text-xs">{JSON.stringify(ticket.arguments, null, 2)}</pre>
        <div className="flex gap-2">
          <button type="button" className="rounded bg-primary text-primary-foreground px-3 py-2 text-sm" onClick={() => answer(true)}>{ticket.risk === "read_only" ? "Allow this call" : "Authorize change once"}</button>
          <button type="button" className="rounded border px-3 py-2 text-sm" onClick={() => answer(false)}>Deny</button>
        </div>
      </section>}
      {calling && <p role="status" className="text-xs text-muted-foreground">Running approved app call?</p>}
      <iframe ref={frame} title={"MCP app from " + payload.server} sandbox={MCP_APP_SANDBOX} allow={MCP_APP_PERMISSIONS}
        referrerPolicy="no-referrer" className="w-full rounded-md border bg-background" style={expanded ? { flex: 1, minHeight: 180 } : { height }} />
    </div>
  );
}

export function McpAppCard({ app, connection, sessionId, onChanged }: { app: McpChatAppDto; connection: NativeRunnerConnection; sessionId: string; onChanged: () => void }) {
  const [payload, setPayload] = useState<McpChatAppPayloadDto>();
  const [pending, setPending] = useState<McpChatAppPayloadDto>();
  const [approvedDomains,setApprovedDomains]=useState<readonly string[]>([]);
  const reset=()=>{setPayload(undefined);setPending(undefined);setApprovedDomains([]);};
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function open() {
    setBusy(true); setError("");
    try {
      const value = await getRunnerMcpApp(connection, sessionId, app.id);
      if (value.id !== app.id || value.uri !== app.uri || value.server !== app.server || value.expiresAt <= Date.now()) throw new Error("App is no longer available.");
      const domains=appResourceDomains(value.resourceDomains);
      if (!domains) throw new Error("App declared invalid external resource origins.");
      const normalized={...value,resourceDomains:domains};
      if(domains.length) setPending(normalized);
      else {setApprovedDomains([]);setPayload(normalized);}
    } catch (e) { setError(e instanceof Error ? e.message : "Could not open app."); }
    finally { setBusy(false); }
  }
  async function dismiss() {
    reset(); setBusy(true);
    try { await dismissRunnerMcpApp(connection, sessionId, app.id); onChanged(); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not dismiss app."); }
    finally { setBusy(false); }
  }
  useEffect(() => {
    const timer = window.setTimeout(() => { reset(); onChanged(); }, Math.max(0, Math.min(2147483647, app.expiresAt - Date.now())));
    return () => window.clearTimeout(timer);
  }, [app.expiresAt, onChanged]);
  return (
    <section className="rounded-lg border bg-card p-3 space-y-2">
      <div className="text-sm font-semibold">MCP App ? {app.server}</div>
      <div className="text-xs text-muted-foreground break-all">{app.tool} ? {app.uri}</div>
      {!payload && <p className="text-xs text-muted-foreground">Open only if you trust this server. Its code receives this tool's arguments and result, which may contain private data. Only reviewed tools may be requested. Write operations also require explicit tool permission in Settings. Each call requires your confirmation. Untrusted app code could still attempt to share data through browser navigation.</p>}
      {pending && <section role="alertdialog" aria-label="Allow external app resources" className="rounded border border-amber-500 bg-background p-3 space-y-2">
        <div className="text-sm font-semibold">This App requests external resources</div>
        <p className="text-xs text-muted-foreground">The following HTTPS origins can supply scripts, styles, images, fonts and media. Their code runs inside the isolated App and can access its tool data. Resource requests can reveal your IP address, browser information and data encoded into URLs. The browser may send applicable cookies. Only approve origins you trust.</p>
        <ul className="list-disc pl-5 text-xs break-all">{pending.resourceDomains?.map(domain=><li key={domain}>{domain}</li>)}</ul>
        <p className="text-xs text-muted-foreground">Direct API connections and nested frames remain blocked. Permission lasts only for this open view.</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="rounded bg-primary text-primary-foreground px-3 py-2 text-sm" onClick={()=>{
            if(pending.expiresAt<=Date.now()){reset();return;}
            setApprovedDomains(pending.resourceDomains??[]);setPayload(pending);setPending(undefined);
          }}>Allow external resources once</button>
          <button type="button" className="rounded border px-3 py-2 text-sm" onClick={()=>{
            if(pending.expiresAt<=Date.now()){reset();return;}
            setApprovedDomains([]);setPayload(pending);setPending(undefined);
          }}>Open offline</button>
          <button type="button" className="rounded border px-3 py-2 text-sm" onClick={reset}>Cancel</button>
        </div>
      </section>}
      {payload ? <AppFrame payload={payload} approvedDomains={approvedDomains} connection={connection} sessionId={sessionId} onClose={reset} /> : !pending &&
        <div className="flex gap-2">
          <button type="button" className="rounded bg-primary text-primary-foreground px-3 py-2 text-sm" disabled={busy} onClick={() => void open()}>Open app</button>
          <button type="button" className="rounded border px-3 py-2 text-sm" disabled={busy} onClick={() => void dismiss()}>Dismiss</button>
        </div>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
    </section>
  );
}
