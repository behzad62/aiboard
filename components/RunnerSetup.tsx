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
}

/**
 * Opt-in local command runner for Build mode. The user starts
 * `node scripts/runner.mjs <folder>`, pastes its URL + token here, and picks an
 * access level. Connecting is the opt-in — without it the Architect can't run
 * anything.
 */
export function RunnerSetup({ onChange }: RunnerSetupProps) {
  const [enabled, setEnabled] = useState(false);
  const [url, setUrl] = useState(DEFAULT_RUNNER_URL);
  const [token, setToken] = useState("");
  const [access, setAccess] = useState<"ask" | "full">("ask");
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
    setStatus(
      result.ok
        ? { state: "ok", message: `Connected to folder "${result.dir}"` }
        : { state: "error", message: result.error }
    );
  };

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-2">
          <Terminal className="h-4 w-4" />
          Let the Architect run commands (optional)
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
        The Architect can run tests, builds, and installs in your project to
        verify its work — but a browser can&apos;t reach a terminal on its own.
        Start the bundled runner in a terminal and connect it here:
      </p>
      <pre className="overflow-x-auto rounded bg-background/70 p-2 text-xs">
        node scripts/runner.mjs ./your-project
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
                    desc: "Approve each command before it runs.",
                  },
                  {
                    value: "full",
                    title: "Full access",
                    desc: "Run commands without asking. Only on trusted projects.",
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
        </div>
      )}
    </div>
  );
}
