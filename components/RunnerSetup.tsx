"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Terminal } from "lucide-react";
import { checkRunner, DEFAULT_RUNNER_URL } from "@/lib/client/runner";

export interface RunnerSelection {
  url: string;
  token: string;
  access: "ask" | "full";
}

interface RunnerSetupProps {
  onChange?: (selection: RunnerSelection | null) => void;
  /** Name of the browser-picked project folder, to warn on a mismatch. */
  pickedFolderName?: string | null;
}

/**
 * Opt-in local command runner for Build mode. The user starts
 * `node scripts/runner.mjs <folder>`, pastes its URL + token here, and picks an
 * access level. Connecting is the opt-in — without it the Architect can't run
 * anything.
 */
export function RunnerSetup({ onChange, pickedFolderName }: RunnerSetupProps) {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState(DEFAULT_RUNNER_URL);
  const [token, setToken] = useState("");
  const [access, setAccess] = useState<"ask" | "full">("ask");
  const [connectedDir, setConnectedDir] = useState<string | null>(null);
  const [status, setStatus] = useState<
    { state: "idle" | "ok" | "error"; message?: string }
  >({ state: "idle" });

  const emit = (next: Partial<RunnerSelection> & { on?: boolean }) => {
    const on = next.on ?? enabled;
    const sel = {
      url: next.url ?? url,
      token: next.token ?? token,
      access: next.access ?? access,
    };
    onChange?.(on && sel.token.trim() ? sel : null);
  };

  const test = async () => {
    setStatus({ state: "idle", message: "Checking…" });
    const result = await checkRunner({ url, token });
    setConnectedDir(result.ok ? result.dir ?? null : null);
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
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          Local runner — commands, files &amp; MCP tools (optional)
        </Label>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            onChange={(e) => {
              setEnabled(e.target.checked);
              emit({ on: e.target.checked });
            }}
          />
          Enable
        </label>
      </div>

      <p className="text-xs text-muted-foreground">
        The runner is a small process you start in your own terminal, pointed at
        your project. Connecting it gives the team full access to{" "}
        <strong>the runner&apos;s folder</strong> (read, write, search), lets the
        Architect run commands like tests and installs, and can bridge MCP tools
        (e.g. a real browser via Playwright). With a runner connected you
        don&apos;t need to pick a project folder above.
      </p>
      <pre className="overflow-x-auto rounded bg-background/70 p-2 text-xs">
        {"node scripts/runner.mjs ./your-project\n"}
        {'node scripts/runner.mjs ./your-project --mcp "playwright=npx @playwright/mcp@latest"'}
      </pre>

      {enabled && (
        <div className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="runner-url" className="text-xs">
                Runner URL
              </Label>
              <Input
                id="runner-url"
                value={url}
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
                onChange={(e) => {
                  setToken(e.target.value);
                  emit({ token: e.target.value });
                }}
                placeholder="paste the token"
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Access level</Label>
            <div className="grid gap-2 sm:grid-cols-2">
              {(
                [
                  {
                    value: "ask",
                    title: "Ask permission",
                    desc: "Approve each shell command and MCP tool call before it runs. File reads/writes never prompt.",
                  },
                  {
                    value: "full",
                    title: "Full access",
                    desc: "Commands and tool calls run without asking. Only for trusted projects.",
                  },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.value}
                  type="button"
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

          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={test}>
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
          </div>

          {folderMismatch && (
            <p className="rounded-md border border-amber-300 bg-amber-50 p-2.5 text-xs text-amber-900 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-100">
              Heads up: the folder picked above (&quot;{pickedFolderName}&quot;)
              and the runner&apos;s folder (&quot;{connectedDir}&quot;) look
              different. Files are written via the runner into{" "}
              <strong>&quot;{connectedDir}&quot;</strong> — clear the picked
              folder or restart the runner on the same project so they match.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
