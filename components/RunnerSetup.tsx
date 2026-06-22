"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Download, Terminal, PanelsTopLeft } from "lucide-react";
import { checkRunner, DEFAULT_RUNNER_URL } from "@/lib/client/runner";

export interface RunnerSelection {
  url: string;
  token: string;
  access: "ask" | "full";
}

interface RunnerSetupProps {
  onChange?: (selection: RunnerSelection | null) => void;
  initialSelection?: RunnerSelection | null;
  disabled?: boolean;
  /** Name of the browser-picked project folder, to warn on a mismatch. */
  pickedFolderName?: string | null;
}

/**
 * The primary way to connect a project in Build mode: the user downloads
 * runner.mjs (served from /runner.mjs — copied from scripts/runner.mjs at
 * build time), starts `node runner.mjs <folder>` in their own terminal, and
 * pastes its URL + token here. Connecting is the opt-in — pasting the token
 * enables it, clearing the token disconnects. Grants file access to the
 * runner's folder, command execution (gated by the access level), and MCP
 * tools.
 */
export function RunnerSetup({
  onChange,
  initialSelection,
  disabled = false,
  pickedFolderName,
}: RunnerSetupProps) {
  const [url, setUrl] = useState(initialSelection?.url ?? DEFAULT_RUNNER_URL);
  const [token, setToken] = useState(initialSelection?.token ?? "");
  const [access, setAccess] = useState<"ask" | "full">(
    initialSelection?.access ?? "ask"
  );
  const [connectedDir, setConnectedDir] = useState<string | null>(null);
  const [status, setStatus] = useState<
    { state: "idle" | "ok" | "error"; message?: string }
  >({ state: "idle" });
  const [manifestVersion, setManifestVersion] = useState<number | null>(null);
  const [connectedVersion, setConnectedVersion] = useState<number | null>(null);

  // Latest runner version (from the build-time manifest) for the download label
  // and the "update available" nudge.
  useEffect(() => {
    fetch("/runner-manifest.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((m) => {
        if (m && typeof m.version === "number") setManifestVersion(m.version);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    setUrl(initialSelection?.url ?? DEFAULT_RUNNER_URL);
    setToken(initialSelection?.token ?? "");
    setAccess(initialSelection?.access ?? "ask");
    setConnectedDir(null);
    setConnectedVersion(null);
    setStatus({ state: "idle" });
  }, [initialSelection?.access, initialSelection?.token, initialSelection?.url]);

  const emit = (next: Partial<RunnerSelection>) => {
    if (disabled) return;
    const sel = {
      url: next.url ?? url,
      token: next.token ?? token,
      access: next.access ?? access,
    };
    onChange?.(sel.token.trim() ? sel : null);
  };

  const test = async () => {
    if (disabled) return;
    setStatus({ state: "idle", message: "Checking…" });
    const result = await checkRunner({ url, token });
    setConnectedDir(result.ok ? result.dir ?? null : null);
    setConnectedVersion(result.ok ? result.version ?? null : null);
    setStatus(
      result.ok
        ? { state: "ok", message: `Connected to folder "${result.dir}"` }
        : { state: "error", message: result.error }
    );
  };

  // Both disk paths configured but pointing at different folders is almost
  // always a mistake — files get written via the runner into ITS folder.
  const folderMismatch =
    !!pickedFolderName &&
    !!connectedDir &&
    pickedFolderName.toLowerCase() !== connectedDir.toLowerCase();

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <Label className="flex items-center gap-2">
        <Terminal className="h-4 w-4" />
        Connect your project — local runner (recommended)
      </Label>

      <p className="text-xs text-muted-foreground">
        The runner is a small script you start in your own terminal, pointed at
        a project folder — or a parent folder to browse from (the path is
        optional and just sets the root). Connecting it gives the AI team full
        access to{" "}
        <strong>the runner&apos;s folder</strong> (read, write, search), lets
        the Architect run commands like tests and installs, fetch public web
        pages (docs, references — local addresses are refused), and can bridge
        MCP tools — a real browser via Playwright, or up-to-date library docs
        via Context7 (add <code>--context7</code>), or free web search through
        SearXNG (add <code>--searxng</code>). Commands and tool calls
        are approval-gated unless you pick Full access. It needs{" "}
        <a
          href="https://nodejs.org"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          Node.js
        </a>{" "}
        18+ installed (free) — nothing else. Download it, run it, then paste
        the URL and token it prints to connect; leave the token empty to build
        in-app instead. Once connected, open the runner&apos;s{" "}
        <strong>control panel</strong> in your browser to pick the project
        folder and watch live activity.{" "}
        <a href="/runner-guide" className="underline underline-offset-2">
          Read the runner guide
        </a>
        .
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" asChild>
          <a href="/runner.mjs" download="runner.mjs">
            <Download className="mr-2 h-4 w-4" />
            Download runner.mjs{manifestVersion ? ` (v${manifestVersion})` : ""}
          </a>
        </Button>
        <span className="text-xs text-muted-foreground">
          then, in a terminal (the folder is optional — it sets the root):
        </span>
      </div>
      <pre className="overflow-x-auto rounded bg-background/70 p-2 text-xs">
        {"node runner.mjs                 # root = the folder you run it from\n"}
        {"node runner.mjs path/to/folder  # or pass a root folder\n"}
        {"node runner.mjs path/to/folder --context7\n"}
        {"node runner.mjs path/to/folder --searxng --searxng-url https://your-searxng.example\n"}
        {'node runner.mjs path/to/folder --mcp "playwright=npx @playwright/mcp@latest"'}
      </pre>
      <p className="text-xs text-muted-foreground">
        <code>--context7</code> bridges{" "}
        <a
          href="https://context7.com"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          Context7
        </a>{" "}
        so the AI team can pull current docs for the libraries it uses. Optional
        API key for higher rate limits:{" "}
        <code>--context7 --context7-key &lt;key&gt;</code> (or set{" "}
        <code>CONTEXT7_API_KEY</code>). The first start pauses briefly while{" "}
        <code>npx</code> fetches the server.
      </p>
      <p className="text-xs text-muted-foreground">
        <code>--searxng</code> bridges{" "}
        <a
          href="https://github.com/ihor-sokoliuk/mcp-searxng"
          target="_blank"
          rel="noreferrer"
          className="underline underline-offset-2"
        >
          mcp-searxng
        </a>{" "}
        as <code>search</code> so the AI team can search the web through your
        SearXNG instance. Provide the instance with{" "}
        <code>--searxng-url &lt;url&gt;</code> (or set{" "}
        <code>SEARXNG_URL</code>).
      </p>

      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor="runner-url" className="text-xs">
              Runner URL
            </Label>
            <Input
              id="runner-url"
              value={url}
              disabled={disabled}
              onChange={(e) => {
                setUrl(e.target.value);
                emit({ url: e.target.value });
              }}
              placeholder={DEFAULT_RUNNER_URL}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="runner-token" className="text-xs">
              Token (printed by the runner)
            </Label>
            <Input
              id="runner-token"
              value={token}
              disabled={disabled}
              onChange={(e) => {
                setToken(e.target.value);
                emit({ token: e.target.value });
              }}
              placeholder="paste the token to connect"
            />
          </div>
        </div>

        {token.trim() && (
          <div className="space-y-1.5">
            <Label className="text-xs">Access level</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  {
                    value: "ask",
                    title: "Ask permission",
                    desc: "Approve each shell command and MCP tool call before it runs. File reads/writes and safe read/search batches never prompt.",
                  },
                  {
                    value: "full",
                    title: "Full access",
                    desc: "Commands and safe tool batches run without asking. Risky actions are still constrained by the Build engine and typed repo workflow. Only for trusted projects.",
                  },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  disabled={disabled}
                  onClick={() => {
                    setAccess(opt.value);
                    emit({ access: opt.value });
                  }}
                  className={
                    access === opt.value
                      ? "rounded-lg border border-primary bg-primary/5 p-3 text-left ring-1 ring-primary"
                      : "rounded-lg border p-3 text-left transition-colors hover:bg-accent"
                  }
                >
                  <span className="text-sm font-medium">{opt.title}</span>
                  <span className="mt-0.5 block text-xs text-muted-foreground">
                    {opt.desc}
                  </span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={test}
            disabled={disabled || !token.trim()}
          >
            Test connection
          </Button>
          {status.state === "ok" && (
            <Badge variant="success">{status.message}</Badge>
          )}
          {status.state === "error" && (
            <span className="text-sm text-destructive">{status.message}</span>
          )}
          {status.message === "Checking…" && (
            <span className="text-sm text-muted-foreground">Checking…</span>
          )}
          {status.state === "ok" && token.trim() && (
            <Button type="button" variant="outline" size="sm" asChild>
              <a
                href={`${url.replace(/\/$/, "")}/#token=${encodeURIComponent(token.trim())}`}
                target="_blank"
                rel="noreferrer"
              >
                <PanelsTopLeft className="mr-2 h-4 w-4" />
                Open control panel
              </a>
            </Button>
          )}
        </div>

        {folderMismatch && (
          <p className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
            Heads up: the browser folder (&quot;{pickedFolderName}&quot;) and
            the runner&apos;s folder (&quot;{connectedDir}&quot;) look
            different. Files are written via the runner into{" "}
            <strong>&quot;{connectedDir}&quot;</strong> — clear the browser
            folder or restart the runner on the same project so they match.
          </p>
        )}

        {connectedVersion != null &&
          manifestVersion != null &&
          connectedVersion < manifestVersion && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              Your runner is v{connectedVersion}; v{manifestVersion} is
              available. Re-download <code>runner.mjs</code> and restart it to
              get the latest features and fixes.
            </p>
          )}
      </div>
    </div>
  );
}
