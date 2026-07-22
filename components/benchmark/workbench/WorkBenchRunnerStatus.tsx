"use client";

import { CheckCircle2, Download, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { BenchRunnerHealth } from "@/lib/client/bench-runner";

export function WorkBenchRunnerStatus({
  url,
  token,
  health,
  checking,
  onUrlChange,
  onTokenChange,
  onCheck,
}: {
  url: string;
  token: string;
  health: BenchRunnerHealth | null;
  checking: boolean;
  onUrlChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onCheck: () => void;
}) {
  const benchStatusText = health
    ? health.ok
      ? `Bench Runner ready${health.root ? `: ${health.root}` : ""}`
      : health.error ?? "Runner check failed"
    : "Bench Runner not checked";
  const managedReady = health?.ok && health.runnerV2?.ready === true;
  const managedStatusText = !health
    ? "Managed Runner V2 not checked"
    : managedReady
      ? `Managed Runner V2 ready${health.runnerV2?.source ? ` (${health.runnerV2.source})` : ""}`
      : health.runnerV2?.error ??
        "Managed Runner V2 unavailable. Restart bench-runner with --runner-v2-dir C:\\path\\to\\aiboard-runner-v2.";
  const BenchStatusIcon = health?.ok ? CheckCircle2 : health ? XCircle : RefreshCw;
  const ManagedStatusIcon = managedReady ? CheckCircle2 : health ? XCircle : RefreshCw;

  return (
    <div className="rounded-md border p-3">
      <div className="grid gap-3 md:grid-cols-[1fr_0.8fr_auto] md:items-end">
        <div className="space-y-2">
          <Label htmlFor="workbench-runner-url">Bench runner URL</Label>
          <Input
            id="workbench-runner-url"
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder="http://127.0.0.1:8797"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="workbench-runner-token">Runner token</Label>
          <Input
            id="workbench-runner-token"
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder="Token from bench-runner"
            type="password"
          />
        </div>
        <div className="flex flex-wrap gap-2 md:justify-end">
          <Button type="button" variant="outline" asChild>
            <a href="/bench-runner.mjs" download="bench-runner.mjs">
              <Download className="h-4 w-4" />
              Download bench runner
            </a>
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={onCheck}
            disabled={checking || !url.trim() || !token.trim()}
          >
            <RefreshCw className={checking ? "h-4 w-4 animate-spin" : "h-4 w-4"} />
            Check
          </Button>
        </div>
      </div>
      <div className="mt-3 space-y-2 text-sm text-muted-foreground">
        <div className="flex items-center gap-2">
          <BenchStatusIcon className={health?.ok ? "h-4 w-4 text-emerald-600" : health ? "h-4 w-4 text-destructive" : "h-4 w-4"} />
          <span className="min-w-0 break-words">{benchStatusText}</span>
        </div>
        <div className="flex items-center gap-2">
          <ManagedStatusIcon className={managedReady ? "h-4 w-4 text-emerald-600" : health ? "h-4 w-4 text-destructive" : "h-4 w-4"} />
          <span className="min-w-0 break-words">{managedStatusText}</span>
        </div>
      </div>
    </div>
  );
}
