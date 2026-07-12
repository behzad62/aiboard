"use client";

import { useEffect, useState } from "react";
import { Terminal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  DEFAULT_RUNNER_V2_URL,
  getNativeRunnerHealth,
} from "@/lib/client/runner-v2";

export interface RunnerSelection {
  url: string;
  token: string;
  access: "ask" | "project" | "full";
}

interface RunnerSetupProps {
  onChange?: (selection: RunnerSelection | null) => void;
  initialSelection?: RunnerSelection | null;
  disabled?: boolean;
  pickedFolderName?: string | null;
  onUseBrowserFolder?: () => void;
}

export function RunnerSetup({
  onChange,
  initialSelection,
  disabled = false,
}: RunnerSetupProps) {
  const [url, setUrl] = useState(initialSelection?.url ?? DEFAULT_RUNNER_V2_URL);
  const [token, setToken] = useState(initialSelection?.token ?? "");
  const [access, setAccess] = useState<"ask" | "project" | "full">(
    initialSelection?.access ?? "ask"
  );
  const [status, setStatus] = useState<{
    state: "idle" | "checking" | "ok" | "error";
    message?: string;
  }>({ state: "idle" });

  useEffect(() => {
    setUrl(initialSelection?.url ?? DEFAULT_RUNNER_V2_URL);
    setToken(initialSelection?.token ?? "");
    setAccess(initialSelection?.access ?? "ask");
    setStatus({ state: "idle" });
  }, [initialSelection?.access, initialSelection?.token, initialSelection?.url]);

  const emit = (next: Partial<RunnerSelection>) => {
    if (disabled) return;
    const selection = {
      url: next.url ?? url,
      token: next.token ?? token,
      access: next.access ?? access,
    };
    onChange?.(selection.token.trim() ? selection : null);
  };

  const test = async () => {
    if (disabled || !token.trim()) return;
    setStatus({ state: "checking", message: "Checking Runner V2…" });
    try {
      const health = await getNativeRunnerHealth({ url, token });
      setStatus({
        state: "ok",
        message: `Connected to ${health.projectPath} · Node ${health.nodeVersion}`,
      });
    } catch (error) {
      setStatus({
        state: "error",
        message: error instanceof Error ? error.message : "Runner V2 is unreachable.",
      });
    }
  };

  return (
    <div className="space-y-3 rounded-lg border bg-muted/20 p-4">
      <Label className="flex items-center gap-2">
        <Terminal className="h-4 w-4" />
        Connect Runner V2 (required for Build mode)
      </Label>
      <p className="text-sm text-muted-foreground">
        The durable native agent kernel owns Git worktrees, tools, checkpoints,
        provider failover, and recovery. It requires Git and exactly Node.js
        24.18.0; missing prerequisites stop before any model call.
      </p>
      <pre className="overflow-x-auto rounded bg-background/70 p-2 text-xs">
        {"npm run runner:v2 -- --project C:\\path\\to\\project --state-dir C:\\path\\to\\aiboard-state --port 8787"}
      </pre>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <Label htmlFor="runner-v2-url" className="text-xs">Runner URL</Label>
          <Input
            id="runner-v2-url"
            value={url}
            disabled={disabled}
            onChange={(event) => {
              setUrl(event.target.value);
              emit({ url: event.target.value });
            }}
            placeholder={DEFAULT_RUNNER_V2_URL}
          />
        </div>
        <div className="space-y-1">
          <Label htmlFor="runner-v2-token" className="text-xs">Control token</Label>
          <Input
            id="runner-v2-token"
            type="password"
            value={token}
            disabled={disabled}
            onChange={(event) => {
              setToken(event.target.value);
              emit({ token: event.target.value });
            }}
            placeholder="Paste the token printed by Runner V2"
          />
        </div>
      </div>
      {token.trim() && (
        <div className="space-y-1.5">
          <Label className="text-xs">Access ceiling</Label>
          <div className="grid gap-2 sm:grid-cols-3">
            {([
              {
                value: "ask",
                title: "Guarded",
                description: "Every write, command, network call, and external action requires approval.",
              },
              {
                value: "project",
                title: "Project autonomous",
                description: "Project-contained work runs automatically; outside or external effects require approval.",
              },
              {
                value: "full",
                title: "Full access",
                description: "Trusted agents may perform destructive, external, credential, push, PR, and deployment actions without asking.",
              },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={disabled}
                onClick={() => {
                  setAccess(option.value);
                  emit({ access: option.value });
                }}
                className={`rounded-md border p-3 text-left text-sm ${
                  access === option.value ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                }`}
              >
                <span className="font-medium">{option.title}</span>
                <span className="mt-1 block text-xs text-muted-foreground">
                  {option.description}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" disabled={disabled || !token.trim()} onClick={test}>
          Test Runner V2
        </Button>
        {token.trim() && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled}
            onClick={() => {
              setToken("");
              setStatus({ state: "idle" });
              onChange?.(null);
            }}
          >
            Disconnect
          </Button>
        )}
        {status.state !== "idle" && (
          <Badge variant={status.state === "ok" ? "default" : status.state === "error" ? "destructive" : "secondary"}>
            {status.message}
          </Badge>
        )}
      </div>
    </div>
  );
}
