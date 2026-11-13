"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  getNativeBrowserInstall,
  startNativeBrowserInstall,
  type NativeBrowserInstallState,
  type NativeRunnerConnection,
} from "@/lib/client/runner-v2";
import { getToolRuntimeRunner, TOOL_RUNTIME_CHANGED_EVENT } from "@/lib/client/tool-runtime";

const POLL_MS = 1_500;
const BROWSER_LABELS: Record<string, string> = { chrome: "Google Chrome", msedge: "Microsoft Edge", chromium: "Playwright Chromium" };

function runnerConnection(): NativeRunnerConnection | null {
  const runner = getToolRuntimeRunner();
  return runner?.url && runner.token ? { url: runner.url, token: runner.token } : null;
}

/**
 * Settings → Tools → Browser for Builds (VF7b). Builds browse with the Playwright CLI the Runner ships, using an
 * installed Chrome first, then Edge, then Playwright's Chromium. The install button is the owner's own action; a
 * Build never downloads a browser.
 */
export function BrowserInstallSettings() {
  const [connection, setConnection] = useState<NativeRunnerConnection | null>(() => runnerConnection());
  const [state, setState] = useState<NativeBrowserInstallState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    const update = () => setConnection(runnerConnection());
    window.addEventListener(TOOL_RUNTIME_CHANGED_EVENT, update);
    return () => window.removeEventListener(TOOL_RUNTIME_CHANGED_EVENT, update);
  }, []);

  const load = useCallback(async () => {
    if (!connection) return;
    try {
      setState(await getNativeBrowserInstall(connection));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [connection]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (state?.status !== "running") return;
    const timer = setInterval(() => { void load(); }, POLL_MS);
    return () => clearInterval(timer);
  }, [state?.status, load]);

  const install = async () => {
    if (!connection) return;
    setStarting(true);
    try {
      setState(await startNativeBrowserInstall(connection));
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStarting(false);
    }
  };

  const chosen = state?.browsers.find((browser) => browser.installed);
  const running = state?.status === "running";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Browser for Builds</CardTitle>
        <CardDescription>
          Builds open and check web pages with the Playwright CLI the Runner ships. They use an installed Google Chrome
          first, then Microsoft Edge, then Playwright&apos;s Chromium. A Build never downloads a browser: you install one
          here, or with <code>aiboard browser install</code>.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!connection ? (
          <p className="text-muted-foreground">Connect the Runner to see and install browsers.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {(state?.browsers ?? []).map((browser) => (
                <Badge key={browser.id} variant={browser.installed ? "default" : "outline"} title={browser.path}>
                  {BROWSER_LABELS[browser.id] ?? browser.id}: {browser.installed ? "installed" : "not installed"}
                </Badge>
              ))}
            </div>
            <p className="text-muted-foreground">
              {chosen ? `Builds use ${BROWSER_LABELS[chosen.id] ?? chosen.id}.` : "No browser is installed, so Builds cannot browse yet."}
            </p>
            <div className="flex flex-wrap items-center gap-3">
              <Button onClick={() => void install()} disabled={starting || running} variant={chosen ? "outline" : "default"}>
                {running ? "Installing…" : "Install Playwright's Chromium"}
              </Button>
              {state?.status === "succeeded" && <span className="text-green-600 dark:text-green-400">Installed.</span>}
              {state?.status === "failed" && (
                <span className="text-destructive">
                  The install failed{typeof state.exitCode === "number" ? ` (exit ${state.exitCode})` : ""}.
                </span>
              )}
            </div>
            {state && state.output.length > 0 && (
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap rounded-md bg-muted p-2 text-xs" aria-live="polite">
                {state.output.slice(-12).join("\n")}
              </pre>
            )}
            {state?.linuxLibraries && (
              <p className="text-muted-foreground">
                {state.linuxLibraries.note} <code className="break-all">{state.linuxLibraries.command}</code>
              </p>
            )}
          </>
        )}
        {error && <p className="text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}
