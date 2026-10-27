"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AccessSummary, OperationCard } from "@/components/extensions/OperationCard";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import type { NativeRunnerConnection } from "@/lib/client/runner-v2";
import {
  applyExtensionPlan,
  browseRunnerFolders,
  describeSource,
  beginExtensionSignIn,
  getExtensionInventory,
  getMcpToolPolicy,
  inspectCliMcpAdoption,
  inspectExtensionSource,
  planExtensionChange,
  READINESS_LABELS,
  recordProviderHostedMcp,
  revokeExtensionCredentials,
  saveInstallPolicy,
  setMcpToolPolicy,
  sourceFromText,
  submitExtensionCredential,
  testExtension,
  uploadExtensionFile,
  type BrowseResultDto,
  type ExtensionComponentDto,
  type ExtensionDependencyDto,
  type ExtensionInventoryDto,
  type ExtensionItemDto,
  type ExtensionKind,
  type ExtensionOperationDto,
  type InstallPolicyDto,
  type McpToolPolicy,
  type PlanRequestDto,
  type SourceInspectionDto,
  type SourceRequestDto,
} from "@/lib/client/runner-extensions";
import { getToolRuntimeRunner, getToolRuntimeSettings, TOOL_RUNTIME_CHANGED_EVENT } from "@/lib/client/tool-runtime";

/** A source to inspect that another part of the page asked for (adopt, move to Runner-hosted). */
type InspectRequest = { id: number } & ({ source: SourceRequestDto } | { adopt: string });

const KIND_LABELS: Record<ExtensionKind, string> = { skill: "Skills", mcp_server: "MCP servers", plugin: "Plugins" };
const POLL_MS = 1_500;

/**
 * Settings → Extensions. The Runner is authoritative for installed state; this view only renders it
 * and sends the user's own actions. Readiness, not a saved form, drives every success label.
 */
export function ExtensionsSettings() {
  const [connection, setConnection] = useState<NativeRunnerConnection | null>(() => runnerConnection());
  const [inventory, setInventory] = useState<ExtensionInventoryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<ExtensionKind>("skill");
  const [request, setRequest] = useState<InspectRequest | null>(null);
  const ask = useCallback((next: { source: SourceRequestDto } | { adopt: string }) => {
    setTab("mcp_server");
    setRequest({ id: Date.now(), ...next });
    window.scrollTo({ top: 0, behavior: "smooth" });
  }, []);

  useEffect(() => {
    const update = () => setConnection(runnerConnection());
    window.addEventListener(TOOL_RUNTIME_CHANGED_EVENT, update);
    return () => window.removeEventListener(TOOL_RUNTIME_CHANGED_EVENT, update);
  }, []);

  const load = useCallback(async () => {
    if (!connection) return;
    setLoading(true);
    try {
      // The single provider-hosted server from Settings → Tools is listed here too (idempotent). Its
      // token stays in this browser; only name, URL and enabled state are recorded.
      const remote = getToolRuntimeSettings().remoteMcpServer;
      if (remote?.url) {
        await recordProviderHostedMcp(connection, { name: remote.name || "remote", url: remote.url, enabled: remote.enabled, hasToken: Boolean(remote.authorizationToken) }).catch(() => undefined);
      }
      setInventory(await getExtensionInventory(connection));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [connection]);

  useEffect(() => { void load(); }, [load]);

  // Poll only while something is in progress; stops on its own.
  const busy = inventory?.pendingOperations.some((operation) => operation.outcome === "running") ?? false;
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [busy, load]);

  if (!connection) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Extensions</CardTitle>
          <CardDescription>Skills, MCP servers and plugins are installed and run by your local Runner.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-3 text-sm">
          <p>Connect a Runner first; nothing is installed from the browser.</p>
          <Button asChild variant="outline" size="sm"><Link href="/settings?tab=tools">Set up the Runner</Link></Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Extensions</CardTitle>
          <CardDescription>
            Add skills, MCP servers and plugins from a folder, an archive or a link. Your Runner installs them into its own store; your source files are never changed.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="flex flex-wrap items-center gap-3 rounded-md bg-destructive/10 p-3 text-sm" role="alert">
              <span>{error.includes("Failed to fetch") ? "The Runner is not reachable." : error}</span>
              <Button size="sm" variant="outline" onClick={() => void load()}>Retry</Button>
              <Button asChild size="sm" variant="ghost"><Link href="/settings?tab=tools">Runner connection</Link></Button>
            </div>
          )}
          {inventory?.pendingOperations.map((operation) => (
            <OperationCard key={operation.id} connection={connection} operation={operation} onChanged={() => void load()} />
          ))}
          <AddExtension connection={connection} kind={tab} request={request} onDone={() => void load()} />
        </CardContent>
      </Card>

      <Tabs value={tab} onValueChange={(value) => setTab(value as ExtensionKind)}>
        <TabsList className="grid w-full grid-cols-3">
          {(Object.keys(KIND_LABELS) as ExtensionKind[]).map((kind) => (
            <TabsTrigger key={kind} value={kind}>
              {KIND_LABELS[kind]}
              <span className="ml-1 text-xs text-muted-foreground">{inventory ? inventory.items.filter((item) => item.kind === kind).length : ""}</span>
            </TabsTrigger>
          ))}
        </TabsList>
        {(Object.keys(KIND_LABELS) as ExtensionKind[]).map((kind) => (
          <TabsContent key={kind} value={kind} className="space-y-3">
            {loading && !inventory && <p className="text-sm text-muted-foreground">Loading…</p>}
            {inventory && inventory.items.filter((item) => item.kind === kind).length === 0 && (
              <p className="text-sm text-muted-foreground">No {KIND_LABELS[kind].toLowerCase()} installed through AI Board yet.</p>
            )}
            {inventory?.items.filter((item) => item.kind === kind).map((item) => (
              <InstalledItem key={item.id} connection={connection} item={item} onChanged={() => void load()} onMoveToRunner={(source) => ask({ source })} />
            ))}
            {inventory && inventory.external.filter((item) => item.kind === kind).length > 0 && (
              <details className="rounded-lg border bg-background/40 p-3 text-sm">
                <summary className="cursor-pointer font-medium">
                  Found elsewhere ({inventory.external.filter((item) => item.kind === kind).length}) — listed, not managed here
                </summary>
                <ul className="mt-3 space-y-2">
                  {inventory.external.filter((item) => item.kind === kind).map((item) => (
                    <li key={`${item.provenance}:${item.name}:${describeSource(item.source)}`} className="flex flex-wrap items-baseline gap-2">
                      <span className="font-medium">{item.name}</span>
                      <Badge variant="outline">{item.provenance === "project" ? "Project file" : item.provenance === "cli" ? "Runner command line" : "Other tool"}</Badge>
                      <span className="text-xs text-muted-foreground">{item.detail}</span>
                      {item.adoptable && item.source.type === "cli_config" && (
                        <Button size="sm" variant="outline" onClick={() => ask({ adopt: item.name })}>Adopt…</Button>
                      )}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </TabsContent>
        ))}
      </Tabs>

      {inventory && <PolicyCard connection={connection} policy={inventory.policy} onSaved={() => void load()} />}
    </div>
  );
}

function AddExtension({ connection, kind, request, onDone }: { connection: NativeRunnerConnection; kind: ExtensionKind; request: InspectRequest | null; onDone: () => void }) {
  const [text, setText] = useState("");
  const [inspection, setInspection] = useState<SourceInspectionDto | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [scope, setScope] = useState<"project" | "user">("project");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [operation, setOperation] = useState<ExtensionOperationDto | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const inspect = useCallback(async (source: SourceRequestDto | { adopt: string }) => {
    setBusy(true);
    setError(null);
    setInspection(null);
    setOperation(null);
    try {
      const result = "adopt" in source ? await inspectCliMcpAdoption(connection, source.adopt) : await inspectExtensionSource(connection, source);
      setInspection(result);
      setSelected(result.components.length === 1 ? result.components[0].componentId : null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }, [connection]);

  const handled = useRef<number | null>(null);
  useEffect(() => {
    if (!request || handled.current === request.id) return;
    handled.current = request.id;
    void inspect("adopt" in request ? { adopt: request.adopt } : request.source);
  }, [request, inspect]);

  const install = async () => {
    if (!inspection) return;
    setBusy(true);
    setError(null);
    try {
      const plan = await planExtensionChange(connection, {
        action: "install", inspectionId: inspection.inspectionId, scope,
        ...(inspection.kind === "skill" && selected ? { componentIds: [selected] } : {}),
      });
      const result = await applyExtensionPlan(connection, plan, `ui-${crypto.randomUUID()}`);
      setOperation(result);
      if (result.outcome === "succeeded") {
        setInspection(null);
        setText("");
      }
      onDone();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const placeholder = kind === "skill"
    ? "Folder path or https://github.com/org/repo/tree/main/skills/name"
    : kind === "mcp_server"
      ? "@scope/server@1.2.3, pypi:name==1.0, https://server.example/mcp"
      : "Folder path or Git link containing aiboard-plugin.json";

  return (
    <div className="space-y-3">
      {kind === "mcp_server" && <McpSourceForm disabled={busy} onInspect={(source) => void inspect(source)} />}
      <form
        className={kind === "mcp_server" ? "hidden" : "flex flex-col gap-2 sm:flex-row"}
        onSubmit={(event) => {
          event.preventDefault();
          const source = sourceFromText(text);
          if (!source) setError("Enter an absolute folder path, a Git or https link, or a pinned package (name@version).");
          else void inspect(source);
        }}
      >
        <Label htmlFor="extension-source" className="sr-only">Source</Label>
        <Input id="extension-source" value={text} placeholder={placeholder} onChange={(event) => setText(event.target.value)} className="flex-1" />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy || !text.trim()}>Inspect</Button>
          <Button type="button" variant="outline" onClick={() => setBrowsing((value) => !value)} aria-expanded={browsing}>Browse…</Button>
          <Button type="button" variant="outline" onClick={() => fileInput.current?.click()}>Upload…</Button>
        </div>
        <input
          ref={fileInput}
          type="file"
          accept=".zip,.md"
          className="hidden"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            event.target.value = "";
            if (!file) return;
            setBusy(true);
            try {
              const upload = await uploadExtensionFile(connection, file);
              await inspect({ type: "upload", uploadId: upload.uploadId });
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
              setBusy(false);
            }
          }}
        />
      </form>
      {browsing && (
        <FolderBrowser
          connection={connection}
          onPick={(path) => {
            setBrowsing(false);
            setText(path);
            void inspect({ type: "local_directory", path });
          }}
        />
      )}
      {busy && <p className="text-sm text-muted-foreground" aria-live="polite">Working…</p>}
      {error && <p className="text-sm text-destructive" role="alert">{error}</p>}
      {inspection && (
        <div className="space-y-3 rounded-lg border bg-background/40 p-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{inspection.name ?? `${inspection.components.length} ${KIND_LABELS[inspection.kind].toLowerCase()}`}</span>
            <Badge variant="outline">{KIND_LABELS[inspection.kind].replace(/s$/, "")}</Badge>
            <span className="break-all text-xs text-muted-foreground">{describeSource(inspection.source)}</span>
          </div>
          {inspection.kind === "skill" && inspection.components.length > 1 && (
            <fieldset className="space-y-2">
              <legend className="text-xs text-muted-foreground">This source holds several skills. Choose one to install:</legend>
              {inspection.components.map((component) => component.kind === "skill" && (
                <label key={component.componentId} className="flex items-start gap-2">
                  <input type="radio" name="skill-choice" checked={selected === component.componentId} onChange={() => setSelected(component.componentId)} className="mt-1" />
                  <span><span className="font-medium">{component.skillName}</span> — {component.description}</span>
                </label>
              ))}
            </fieldset>
          )}
          {inspection.kind === "skill" && inspection.components.length === 1 && inspection.components[0].kind === "skill" && (
            <p>{inspection.components[0].description}</p>
          )}
          {inspection.kind === "plugin" && (
            <ul className="space-y-1 text-xs">
              {inspection.version && <li className="text-muted-foreground">Bundle version {inspection.version}; all parts install and update together.</li>}
              {inspection.components.map((component) => (
                <li key={component.componentId}><span className="font-medium">{componentLabel(component)}:</span> {componentSummary(component)}</li>
              ))}
              {inspection.dependencies?.length ? <li><span className="font-medium">Uses installed:</span> {inspection.dependencies.map(dependencyLabel).join(", ")}</li> : null}
            </ul>
          )}
          {[...inspection.warnings, ...inspection.components.flatMap((component) => component.kind === "skill" && (selected === null || component.componentId === selected) ? component.warnings : [])].length > 0 && (
            <ul className="list-disc space-y-1 pl-5 text-xs text-muted-foreground">
              {[...new Set([...inspection.warnings, ...inspection.components.flatMap((component) => component.kind === "skill" && (selected === null || component.componentId === selected) ? component.warnings : [])])].map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}
          {inspection.invalid.length > 0 && (
            <p className="text-xs text-destructive">Skipped invalid: {inspection.invalid.map((entry) => `${entry.path} (${entry.errors.join(" ")})`).join("; ")}</p>
          )}
          <AccessSummary access={inspection.access} />
          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-2 text-xs">
              <span>Available to</span>
              <select value={scope} onChange={(event) => setScope(event.target.value as "project" | "user")} className="rounded-md border bg-background px-2 py-1">
                <option value="project">This project</option>
                <option value="user">All my projects</option>
              </select>
            </label>
            <Button size="sm" disabled={busy || (inspection.kind === "skill" && !selected)} onClick={() => void install()}>
              Install
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setInspection(null)}>Cancel</Button>
          </div>
        </div>
      )}
      {operation && <OperationCard connection={connection} operation={operation} onChanged={(next) => { if (next) setOperation(next); onDone(); }} />}
    </div>
  );
}

/**
 * Structured MCP sources. Arguments are kept as a list (never a shell string), and secret variables
 * are listed by NAME only; their values are asked for in a secure field after the plan is made.
 */
function McpSourceForm({ disabled, onInspect }: { disabled: boolean; onInspect: (source: SourceRequestDto) => void }) {
  const [type, setType] = useState<"executable" | "npm" | "pypi" | "remote_http">("executable");
  const [main, setMain] = useState("");
  const [version, setVersion] = useState("");
  const [args, setArgs] = useState("");
  const [env, setEnv] = useState("");
  const [serverName, setServerName] = useState("");
  const [auth, setAuth] = useState<"none" | "bearer" | "oauth">("none");
  const launch = () => {
    const argv = args.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    const names = env.split(/[\s,]+/).map((name) => name.trim()).filter(Boolean);
    return { ...(argv.length ? { args: argv } : {}), ...(names.length ? { env: names } : {}), ...(serverName.trim() ? { serverName: serverName.trim() } : {}) };
  };
  const source = (): SourceRequestDto | undefined => {
    const value = main.trim();
    if (!value) return undefined;
    if (type === "executable") return { type, command: value, ...launch() };
    if (type === "npm") return { type, packageName: value, ...(version.trim() ? { version: version.trim() } : {}), ...launch() };
    if (type === "pypi") return { type, packageName: value, ...(version.trim() ? { version: version.trim() } : {}), ...launch() };
    return { type, url: value, auth, ...(serverName.trim() ? { serverName: serverName.trim() } : {}) };
  };
  const labels = { executable: "Program on this computer", npm: "npm package", pypi: "Python package", remote_http: "Remote server URL" } as const;
  return (
    <form
      className="grid gap-3 rounded-lg border bg-background/40 p-3 text-sm sm:grid-cols-2"
      onSubmit={(event) => { event.preventDefault(); const next = source(); if (next) onInspect(next); }}
    >
      <label className="space-y-1">
        <span className="text-xs font-medium">Kind</span>
        <select value={type} onChange={(event) => setType(event.target.value as typeof type)} className="w-full rounded-md border bg-background px-2 py-2">
          {(Object.keys(labels) as Array<keyof typeof labels>).map((key) => <option key={key} value={key}>{labels[key]}</option>)}
        </select>
      </label>
      <label className="space-y-1">
        <span className="text-xs font-medium">{type === "executable" ? "Program (path or name on PATH)" : type === "remote_http" ? "https:// URL (http only for localhost)" : "Package name"}</span>
        <Input value={main} onChange={(event) => setMain(event.target.value)} placeholder={type === "executable" ? "node" : type === "npm" ? "@modelcontextprotocol/server-everything" : type === "pypi" ? "mcp-server-fetch" : "https://mcp.example.com/mcp"} />
      </label>
      {(type === "npm" || type === "pypi") && (
        <label className="space-y-1">
          <span className="text-xs font-medium">Exact version (empty = current release, pinned)</span>
          <Input value={version} onChange={(event) => setVersion(event.target.value)} placeholder="1.2.3" />
        </label>
      )}
      {type !== "remote_http" ? (
        <>
          <label className="space-y-1 sm:col-span-2">
            <span className="text-xs font-medium">Arguments, one per line</span>
            <textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={2} className="w-full rounded-md border bg-background p-2 font-mono text-xs" placeholder={type === "executable" ? "C:\\tools\\server.mjs" : "--stdio"} />
          </label>
          <label className="space-y-1">
            <span className="text-xs font-medium">Secret variable names (values asked separately)</span>
            <Input value={env} onChange={(event) => setEnv(event.target.value)} placeholder="GITHUB_TOKEN" />
          </label>
        </>
      ) : (
        <label className="space-y-1">
          <span className="text-xs font-medium">Sign-in</span>
          <select value={auth} onChange={(event) => setAuth(event.target.value as typeof auth)} className="w-full rounded-md border bg-background px-2 py-2">
            <option value="none">None</option>
            <option value="bearer">API token (entered in a secure field)</option>
            <option value="oauth">Sign in with the service (OAuth)</option>
          </select>
        </label>
      )}
      <label className="space-y-1">
        <span className="text-xs font-medium">Server name (optional)</span>
        <Input value={serverName} onChange={(event) => setServerName(event.target.value)} placeholder="docs" />
      </label>
      <div className="flex items-end sm:col-span-2">
        <Button type="submit" disabled={disabled || !main.trim()}>Inspect</Button>
      </div>
    </form>
  );
}

/** Runner-side folder browsing: works when the browser's own directory picker cannot hand over a path. */
function FolderBrowser({ connection, onPick }: { connection: NativeRunnerConnection; onPick: (path: string) => void }) {
  const [listing, setListing] = useState<BrowseResultDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const open = useCallback(async (path?: string) => {
    try {
      setListing(await browseRunnerFolders(connection, path));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [connection]);
  useEffect(() => { void open(); }, [open]);
  return (
    <div className="max-h-72 overflow-auto rounded-lg border bg-background/40 p-3 text-sm" role="region" aria-label="Choose a folder on the Runner machine">
      {error && <p className="text-destructive">{error}</p>}
      {listing && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2">
            <span className="break-all font-mono text-xs">{listing.path || "Choose a starting point"}</span>
            {listing.parent && <Button size="sm" variant="ghost" onClick={() => void open(listing.parent)}>Up</Button>}
            {listing.path && <Button size="sm" onClick={() => onPick(listing.path)}>{listing.hasSkill ? "Use this skill folder" : "Use this folder"}</Button>}
          </div>
          <ul className="grid gap-1 sm:grid-cols-2">
            {(listing.roots ?? []).map((root) => (
              <li key={root}><button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => void open(root)}>{root}</button></li>
            ))}
            {listing.directories.map((directory) => (
              <li key={directory}>
                <button type="button" className="text-left underline-offset-2 hover:underline" onClick={() => void open(`${listing.path.replace(/[\\/]$/, "")}${listing.path.includes("\\") ? "\\" : "/"}${directory}`)}>
                  {directory}/
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function componentLabel(component: ExtensionComponentDto): string {
  return component.kind === "skill" ? "Skill" : component.kind === "mcp_server" ? "Server" : "Runner extension";
}

function componentSummary(component: ExtensionComponentDto): string {
  if (component.kind === "skill") return `${component.skillName} — ${component.files} file(s)`;
  if (component.kind === "mcp_server") return `${component.serverName} (${component.transport}${component.route === "provider_hosted" ? ", provider-hosted" : ""})${component.toolNames?.length ? ` · ${component.toolNames.join(", ")}` : ""}`;
  return `${component.extensionId} (loads at a Runner restart with no Build running)`;
}

function dependencyLabel(dependency: ExtensionDependencyDto): string {
  return `${dependency.kind === "skill" ? "skill" : "MCP server"} "${dependency.name}"`;
}

function InstalledItem({ connection, item, onChanged, onMoveToRunner }: { connection: NativeRunnerConnection; item: ExtensionItemDto; onChanged: () => void; onMoveToRunner: (source: SourceRequestDto) => void }) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [secretName, setSecretName] = useState("");
  const [secretValue, setSecretValue] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const readiness = item.readiness;
  const tone = readiness.state === "ready" ? "success" : ["failed", "needs_auth", "restart_required"].includes(readiness.state) ? "destructive" : readiness.state === "disabled" ? "secondary" : "warning";
  const declaredCredentials = useMemo(
    () => (item.currentVersion?.components ?? []).flatMap((component) => component.kind === "mcp_server" ? component.environment.map((entry) => entry.name) : []),
    [item.currentVersion],
  );
  const server = item.currentVersion?.components.find((component) => component.kind === "mcp_server");
  const migrated = item.provenance === "migrated";
  const runnerMcp = server?.kind === "mcp_server" && server.route === "runner";
  const [toolPolicy, setToolPolicy] = useState<McpToolPolicy | undefined>(undefined);
  useEffect(() => {
    if (!runnerMcp) return;
    let live = true;
    void getMcpToolPolicy(connection, item.id).then((result) => { if (live) setToolPolicy(result.policy); }).catch(() => undefined);
    return () => { live = false; };
  }, [connection, item.id, runnerMcp]);

  const lifecycle = async (plan: PlanRequestDto) => {
    setBusy(true);
    setMessage(null);
    try {
      const planned = await planExtensionChange(connection, plan);
      const operation = await applyExtensionPlan(connection, planned, `ui-${crypto.randomUUID()}`);
      if (operation.outcome !== "succeeded") setMessage(operation.diagnostics.at(-1) ?? `Operation ${operation.outcome.replaceAll("_", " ")}.`);
      onChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  const update = async () => {
    // Re-resolve the same source; a new revision installs as an update and keeps the old one for rollback.
    const source = sourceForUpdate(item);
    if (!source) return setMessage("This source cannot be re-resolved automatically; add it again.");
    setBusy(true);
    try {
      const inspection = await inspectExtensionSource(connection, source);
      const component = inspection.components.find((entry) => entry.kind === "skill" && entry.skillName === item.name);
      const plan = await planExtensionChange(connection, { action: "install", inspectionId: inspection.inspectionId, scope: item.scope.kind, ...(component ? { componentIds: [component.componentId] } : {}) });
      const operation = await applyExtensionPlan(connection, plan, `ui-${crypto.randomUUID()}`);
      setMessage(operation.outcome === "succeeded" ? "Up to date." : operation.diagnostics.at(-1) ?? operation.outcome);
      onChanged();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <details className="rounded-lg border bg-background/40 p-4 text-sm">
      <summary className="flex cursor-pointer flex-wrap items-center gap-2">
        <span className="font-medium">{item.name}</span>
        <Badge variant={tone}>{READINESS_LABELS[readiness.state]}</Badge>
        <Badge variant="outline">{item.scope.kind === "project" ? "This project" : "All projects"}</Badge>
        {item.provenance === "migrated" && <Badge variant="outline">Migrated setting</Badge>}
        <span className="break-all text-xs text-muted-foreground">{describeSource(item.currentVersion?.source ?? item.source)}</span>
      </summary>
      <div className="mt-4 space-y-4">
        {readiness.lastError && <p className="text-destructive">{readiness.lastError.message}</p>}
        {readiness.detail && <p className="text-muted-foreground">{readiness.detail}</p>}
        {migrated && server?.kind === "mcp_server" && (
          <div className="space-y-2 rounded-md bg-muted/60 p-3 text-xs">
            <p>Your model provider calls this server directly with the token saved in this browser. To have the Runner call it instead (so any model with tools can use it, and the token is kept by the Runner), add it as a Runner-hosted server and enter the token again in the secure field. Nothing moves automatically.</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="outline" onClick={() => onMoveToRunner({ type: "remote_http", url: server.url ?? "", serverName: server.serverName, auth: server.auth === "bearer" ? "bearer" : "none" })}>Add as Runner-hosted…</Button>
              <Button asChild size="sm" variant="ghost"><Link href="/settings?tab=tools">Edit provider-hosted setting</Link></Button>
            </div>
          </div>
        )}
        {runnerMcp && readiness.state === "needs_auth" && server?.kind === "mcp_server" && server.auth === "oauth" && (
          <Button size="sm" disabled={busy} onClick={async () => {
            setBusy(true);
            try {
              const { url } = await beginExtensionSignIn(connection, item.id);
              window.open(url, "_blank", "noopener");
              setMessage("Finish signing in in the new tab, then press Test.");
            } catch (cause) {
              setMessage(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}>Sign in to {server.serverName}</Button>
        )}
        {runnerMcp && toolPolicy && (
          <label className="flex items-center gap-3">
            <Switch checked={toolPolicy === "all"} disabled={busy} aria-label="Allow every tool without asking" onCheckedChange={async (checked) => {
              try {
                setToolPolicy((await setMcpToolPolicy(connection, item.id, checked ? "all" : "non_destructive")).policy);
              } catch (cause) {
                setMessage(cause instanceof Error ? cause.message : String(cause));
              }
            }} />
            <span>{toolPolicy === "all" ? "The assistant may call every tool of this server." : "The assistant may call only tools the server marks as non-destructive (hints, not guarantees)."}</span>
          </label>
        )}
        <div className={migrated ? "hidden" : "flex flex-wrap items-center gap-3"}>
          <label className="flex items-center gap-2">
            <Switch checked={item.enabled} disabled={busy} onCheckedChange={(checked) => void lifecycle({ action: checked ? "enable" : "disable", extensionId: item.id })} aria-label={`${item.enabled ? "Disable" : "Enable"} ${item.name}`} />
            <span>{item.enabled ? "Enabled" : "Disabled"}</span>
          </label>
          <Button size="sm" variant="outline" disabled={busy} onClick={async () => { setBusy(true); try { const result = await testExtension(connection, item.id); setMessage(`Check: ${READINESS_LABELS[result.state]}${result.lastError ? ` — ${result.lastError.message}` : ""}`); onChanged(); } catch (cause) { setMessage(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); } }}>
            Test
          </Button>
          {sourceForUpdate(item) && <Button size="sm" variant="outline" disabled={busy} onClick={() => void update()}>Check for update</Button>}
          {item.previousVersions.length > 0 && (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => void lifecycle({ action: "rollback", extensionId: item.id })}>
              Roll back
            </Button>
          )}
          {confirmRemove ? (
            <span className="flex items-center gap-2">
              <span className="text-xs">Remove the installed copy? Your source is not touched.</span>
              <Button size="sm" variant="destructive" disabled={busy} onClick={() => void lifecycle({ action: "remove", extensionId: item.id })}>Remove</Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(false)}>Keep</Button>
            </span>
          ) : (
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>Uninstall…</Button>
          )}
        </div>
        {message && <p className="text-xs text-muted-foreground" role="status">{message}</p>}
        <dl className="grid gap-1 text-xs sm:grid-cols-[auto,1fr] sm:gap-x-3">
          <dt className="font-medium">Version</dt>
          <dd>{item.currentVersion?.version ?? item.currentVersion?.versionId ?? "—"} {item.currentVersion?.packageDigest ? <span className="font-mono text-muted-foreground">({item.currentVersion.packageDigest.slice(0, 12)})</span> : null}</dd>
          <dt className="font-medium">Installed</dt>
          <dd>{new Date(item.installedAt).toLocaleString()}</dd>
          <dt className="font-medium">Active in</dt>
          <dd>{item.activeGeneration !== undefined ? `capability generation ${item.activeGeneration}` : "not yet active"}</dd>
          {item.currentVersion?.components.map((component) => (
            <FragmentRow key={component.componentId} label={componentLabel(component)}>
              {componentSummary(component)}
              {item.kind === "plugin" && readiness.components?.[component.componentId] ? <span className="text-muted-foreground"> · {READINESS_LABELS[readiness.components[component.componentId]!]}</span> : null}
            </FragmentRow>
          ))}
          {item.currentVersion?.dependencies?.length ? <FragmentRow label="Uses">{item.currentVersion.dependencies.map(dependencyLabel).join(", ")}</FragmentRow> : null}
          {item.referencedBy.length > 0 && <FragmentRow label="Used by">{item.referencedBy.join(", ")}</FragmentRow>}
        </dl>
        {(declaredCredentials.length > 0 || item.credentials.length > 0) && (
          <div className="space-y-2 rounded-md bg-muted/60 p-3">
            <p className="text-xs font-medium">Credentials (stored on the Runner)</p>
            <ul className="text-xs">
              {declaredCredentials.map((name) => (
                <li key={name}>{name}: {item.credentials.some((credential) => credential.name === name) ? "set" : "missing"}</li>
              ))}
            </ul>
            <form
              className="flex flex-wrap items-end gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                if (!secretName || !secretValue) return;
                setBusy(true);
                try {
                  await submitExtensionCredential(connection, item.id, secretName, secretValue);
                  setSecretValue("");
                  setMessage(`${secretName} saved.`);
                  onChanged();
                } catch (cause) {
                  setMessage(cause instanceof Error ? cause.message : String(cause));
                } finally {
                  setBusy(false);
                }
              }}
            >
              <select aria-label="Credential name" value={secretName} onChange={(event) => setSecretName(event.target.value)} className="rounded-md border bg-background px-2 py-2 text-xs">
                <option value="">Credential…</option>
                {declaredCredentials.map((name) => <option key={name} value={name}>{name}</option>)}
              </select>
              <Input aria-label="Secret value" type="password" autoComplete="off" value={secretValue} onChange={(event) => setSecretValue(event.target.value)} className="h-9 w-56" />
              <Button size="sm" type="submit" disabled={busy || !secretName || !secretValue}>Save</Button>
              {item.credentials.length > 0 && (
                <Button size="sm" type="button" variant="ghost" disabled={busy} onClick={async () => { setBusy(true); try { const result = await revokeExtensionCredentials(connection, item.id); setMessage(`Revoked ${result.revoked} stored credential(s).`); onChanged(); } finally { setBusy(false); } }}>
                  Revoke stored credentials
                </Button>
              )}
            </form>
          </div>
        )}
      </div>
    </details>
  );
}

function FragmentRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="font-medium">{label}</dt>
      <dd className="break-words">{children}</dd>
    </>
  );
}

function PolicyCard({ connection, policy, onSaved }: { connection: NativeRunnerConnection; policy: InstallPolicyDto; onSaved: () => void }) {
  const [draft, setDraft] = useState(policy);
  const [trusted, setTrusted] = useState(policy.trustedSources.join("\n"));
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => { setDraft(policy); setTrusted(policy.trustedSources.join("\n")); }, [policy]);
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">When an AI agent installs something you asked for</CardTitle>
        <CardDescription>
          Agents never approve on your behalf. These rules decide when your own request in a chat or Build is enough, so you are not asked twice.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <label className="flex items-center gap-3">
          <Switch checked={draft.humanRequestedSkills === "auto"} onCheckedChange={(checked) => setDraft({ ...draft, humanRequestedSkills: checked ? "auto" : "ask" })} />
          <span>Install skills I name in my message without asking again (skills are instructions; installing runs nothing)</span>
        </label>
        <label className="flex items-center gap-3">
          <Switch checked={draft.humanRequestedExecutable === "trusted_sources"} onCheckedChange={(checked) => setDraft({ ...draft, humanRequestedExecutable: checked ? "trusted_sources" : "ask" })} />
          <span>Install software I name (MCP servers, plugins) without asking again, but only from the trusted sources below</span>
        </label>
        <div className="space-y-1">
          <Label htmlFor="trusted-sources">Trusted sources (one per line)</Label>
          <textarea
            id="trusted-sources"
            value={trusted}
            onChange={(event) => setTrusted(event.target.value)}
            rows={3}
            placeholder={"npm:@modelcontextprotocol/*\ngit:https://github.com/your-org/*"}
            className="w-full rounded-md border bg-background p-2 font-mono text-xs"
          />
        </div>
        <div className="flex items-center gap-3">
          <Button
            size="sm"
            onClick={async () => {
              try {
                await saveInstallPolicy(connection, { ...draft, trustedSources: trusted.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) });
                setMessage("Saved.");
                onSaved();
              } catch (cause) {
                setMessage(cause instanceof Error ? cause.message : String(cause));
              }
            }}
          >
            Save rules
          </Button>
          {message && <span className="text-xs text-muted-foreground" role="status">{message}</span>}
        </div>
      </CardContent>
    </Card>
  );
}

function sourceForUpdate(item: ExtensionItemDto): SourceRequestDto | undefined {
  const source = item.currentVersion?.source ?? item.source;
  if (source.type === "git") return { type: "git", url: source.url, ...(source.requestedRef && source.requestedRef !== "HEAD" ? { ref: source.requestedRef } : {}), ...(source.subdirectory ? { subdirectory: source.subdirectory } : {}) };
  if (source.type === "local_directory") return { type: "local_directory", path: source.path };
  return undefined;
}

function runnerConnection(): NativeRunnerConnection | null {
  const runner = getToolRuntimeRunner();
  return runner?.url && runner.token ? { url: runner.url, token: runner.token } : null;
}
