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
import {
  getLauncherConnection,
  revokeLauncherSession,
  type LauncherConnection,
} from "@/lib/client/local-runner-handoff";
import {
  NATIVE_RUNNER_NODE_POLICY_DESCRIPTION,
  supportsNativeRunnerNodeVersion,
} from "@/lib/client/native-build-policy";
import { RunnerInstallCommands } from "@/components/runner/RunnerInstallCommands";
import { RUNNER_START_COMMAND } from "@/lib/runner-install";

export interface RunnerSelection {
  url: string;
  token: string;
  access: "ask" | "project" | "full";
  source?: "manual" | "launcher";
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
  const [launcher, setLauncher] = useState<LauncherConnection | null>(null);
  const [disconnecting, setDisconnecting] = useState(false);

  useEffect(() => {
    setUrl(initialSelection?.url ?? DEFAULT_RUNNER_V2_URL);
    setToken(initialSelection?.source === "launcher" ? "" : initialSelection?.token ?? "");
    setAccess(initialSelection?.access ?? "ask");
    setStatus({ state: "idle" });
  }, [initialSelection?.access, initialSelection?.source, initialSelection?.token, initialSelection?.url]);

  // A launcher session (from `aiboard` via /connect) wins over a pasted token.
  useEffect(() => {
    const connection = getLauncherConnection();
    if (!connection) return;
    setLauncher(connection);
    setUrl(connection.url);
    onChange?.({
      url: connection.url,
      token: connection.token,
      access: initialSelection?.access ?? "ask",
      source: "launcher",
    });
    // Only on mount: the parent owns the selection afterwards.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const disconnectLauncher = async () => {
    if (disconnecting) return;
    setDisconnecting(true);
    try {
      await revokeLauncherSession();
    } finally {
      setLauncher(null);
      setDisconnecting(false);
      setStatus({ state: "idle" });
      onChange?.(null);
    }
  };

  const emit = (next: Partial<RunnerSelection>) => {
    if (disabled) return;
    const selection = {
      url: next.url ?? url,
      token: next.token ?? token,
      access: next.access ?? access,
    };
    onChange?.(selection.token.trim() ? { ...selection, source: "manual" as const } : null);
  };

  const test = async () => {
    if (disabled || !token.trim()) return;
    setStatus({ state: "checking", message: "Checking Runner V2…" });
    try {
      const health = await getNativeRunnerHealth({ url, token });
      if (!supportsNativeRunnerNodeVersion(health.nodeVersion)) {
        throw new Error(
          `Runner V2 supports ${NATIVE_RUNNER_NODE_POLICY_DESCRIPTION}; connected runner uses ${health.nodeVersion}.`
        );
      }
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
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Label className="flex items-center gap-2">
          <Terminal className="h-4 w-4" aria-hidden="true" />
          Runner V2
        </Label>
        <span className="text-xs text-muted-foreground">
          Builds run on your machine, never in the browser.
        </span>
      </div>
      {launcher && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border bg-muted/40 px-3 py-2 text-sm">
          <Badge>Connected via aiboard (session)</Badge>
          <span className="text-xs text-muted-foreground">{launcher.url}</span>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={disabled || disconnecting}
            onClick={() => void disconnectLauncher()}
          >
            {disconnecting ? "Disconnecting…" : "Disconnect"}
          </Button>
        </div>
      )}
      <details
        className="group rounded-lg border bg-muted/40 px-3 py-2 text-sm"
        open={!initialSelection?.token}
      >
        <summary className="cursor-pointer select-none text-sm font-medium">
          Set up Runner V2
        </summary>
        <div className="mt-2 space-y-2 pb-1">
          <p className="text-muted-foreground">
            The native agent kernel owns Git worktrees, tools, checkpoints,
            provider failover, and recovery. Builds need Git on your computer;
            the installer includes Node.js.
          </p>
          <p className="text-xs text-muted-foreground">
            Install it once, in a terminal:
          </p>
          <RunnerInstallCommands compact />
          <p className="text-xs text-muted-foreground">
            Then, in your project folder, run:
          </p>
          <pre className="overflow-x-auto rounded-md bg-background/70 p-2 text-xs">
            {RUNNER_START_COMMAND}
          </pre>
          <p className="text-xs text-muted-foreground">
            It opens AI Board connected to this computer; nothing to paste. A
            Runner started another way prints a URL and control token: paste
            those below. See the <a className="underline" href="/runner-guide">Runner guide</a> for
            updates and options. Contributors can run{" "}
            <code>npm run runner:v2 -- --project ...</code> from an AI Board
            checkout instead.
          </p>
        </div>
      </details>
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
                description: "Native project file and Git operations run automatically; arbitrary processes and external effects require approval.",
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
                aria-pressed={access === option.value}
                className={`rounded-md border p-3 text-left text-sm transition-colors ${
                  access === option.value
                    ? "border-primary bg-accent text-accent-foreground"
                    : "hover:bg-accent/60"
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
