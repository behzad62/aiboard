"use client";

import { CheckCircle2, Download, RefreshCw, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  getTrustedBenchRunnerReadiness,
  type BenchRunnerHealth,
} from "@/lib/client/bench-runner";
import type { WorkBenchCase } from "@/lib/benchmark/workbench/types";

export function WorkBenchRunnerStatus({
  idPrefix,
  url,
  token,
  health,
  checking,
  onUrlChange,
  onTokenChange,
  onCheck,
  workBenchCase,
}: {
  idPrefix: string;
  url: string;
  token: string;
  health: BenchRunnerHealth | null;
  checking: boolean;
  onUrlChange: (value: string) => void;
  onTokenChange: (value: string) => void;
  onCheck: () => void;
  workBenchCase?: WorkBenchCase;
}) {
  const runnerUrlId = `${idPrefix}-runner-url`;
  const runnerTokenId = `${idPrefix}-runner-token`;
  const benchStatusText = health
    ? health.ok
      ? `Bench Runner ready${health.root ? `: ${health.root}` : ""}`
      : health.error ?? "Runner check failed"
    : "Bench Runner not checked";
  const managedReady = health?.ok && health.runnerV2?.ready === true;
  const managedStatusText = !health
    ? "Managed Runner V2 not checked"
    : managedReady
      ? `Managed Runner V2 source available${health.runnerV2?.source ? ` (${health.runnerV2.source})` : ""}`
      : health.runnerV2?.error ??
        "Managed Runner V2 unavailable. Restart bench-runner with --runner-v2-dir C:\\path\\to\\aiboard-runner-v2.";
  const BenchStatusIcon = health?.ok ? CheckCircle2 : health ? XCircle : RefreshCw;
  const ManagedStatusIcon = managedReady ? CheckCircle2 : health ? XCircle : RefreshCw;
  const trustedReadiness = workBenchCase?.trustedPolicy
    ? getTrustedBenchRunnerReadiness(health, workBenchCase)
    : null;
  const TrustedStatusIcon = trustedReadiness?.ready
    ? CheckCircle2
    : health
      ? XCircle
      : RefreshCw;
  const trustedStatusText = !health
    ? "Recoverable Job Service runtime not checked"
    : trustedReadiness?.ready
      ? `Recoverable Job Service runtime ready (${health.rjs?.profile ?? "profile unavailable"})`
      : trustedReadiness?.error;
  const recoverableJobService = workBenchCase?.trustedPolicy?.kind === "recoverable-job-service";
  const download = recoverableJobService
    ? {
        href: "/aiboard-rjs-workbench-runner.zip",
        filename: "aiboard-rjs-workbench-runner.zip",
        label: "Download Recoverable Job Service runner",
      }
    : {
        href: "/aiboard-workbench-runner.zip",
        filename: "aiboard-workbench-runner.zip",
        label: "Download WorkBench runner bundle",
      };

  return (
    <div className="@container rounded-md border p-3">
      <div className="grid gap-3 @[64rem]:grid-cols-[minmax(18rem,1fr)_minmax(16rem,0.8fr)_auto] @[64rem]:items-end">
        <div className="space-y-2">
          <Label htmlFor={runnerUrlId}>Bench runner URL</Label>
          <Input
            id={runnerUrlId}
            value={url}
            onChange={(event) => onUrlChange(event.target.value)}
            placeholder="http://127.0.0.1:8797"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor={runnerTokenId}>Runner token</Label>
          <Input
            id={runnerTokenId}
            value={token}
            onChange={(event) => onTokenChange(event.target.value)}
            placeholder="Token from bench-runner"
            type="password"
          />
        </div>
        <div className="space-y-2">
          <div className="flex flex-wrap gap-2 @[64rem]:justify-end">
            <Button
              type="button"
              variant="outline"
              className="h-auto w-full min-w-0 whitespace-normal break-words @[32rem]:h-10 @[32rem]:w-auto @[32rem]:whitespace-nowrap"
              asChild
            >
              <a
                href={download.href}
                download={download.filename}
              >
                <Download className="h-4 w-4 shrink-0" />
                {download.label}
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
          <p className="text-xs text-muted-foreground @[64rem]:text-right">
            {recoverableJobService ? (
              <>Requires Windows and Node.js 24.18.0. After extraction, run <code>npm ci</code> and{" "}
                <code>npm run setup:browser</code>.</>
            ) : (
              <>Includes Runner V2. After extraction, run <code>npm install</code> and{" "}
                <code>npm run setup:browser</code>.</>
            )}
          </p>
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
        {trustedReadiness ? (
          <div className="flex items-center gap-2">
            <TrustedStatusIcon className={trustedReadiness.ready ? "h-4 w-4 text-emerald-600" : health ? "h-4 w-4 text-destructive" : "h-4 w-4"} />
            <span className="min-w-0 break-words">
              {trustedStatusText}
            </span>
          </div>
        ) : null}
      </div>
    </div>
  );
}
