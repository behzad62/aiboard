"use client";

import { useEffect, useRef } from "react";
import { X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatNormalizedScore,
  formatScore as formatPointScore
} from "@/components/benchmark/format";
import { wilsonInterval, type DecisionRow } from "@/lib/benchmark/certified/decision-dashboard";
import { benchmarkVariantLabel } from "@/lib/benchmark/model-effort";
import { sanitizeBenchmarkDisplayText } from "@/lib/benchmark/configuration-display";
import { VariantRosterBadges } from "./VariantRosterBadges";

export function ModelEvidenceProfile({
  id,
  row,
  onClose
}: {
  id: string;
  row: DecisionRow;
  onClose: () => void;
}) {
  const profileRef = useRef<HTMLDivElement>(null);
  const passed = derivedPasses(row);
  const interval = passed == null ? null : wilsonInterval(passed, row.attempts);
  const titleId = `${id}-title`;
  const failureMessages = certifiedFailureMessages(row);
  const failedAttempts = failedAttemptCount(row);

  useEffect(() => {
    const profile = profileRef.current;
    if (profile && profile.getClientRects().length > 0) profile.focus();
  }, []);

  return (
    <Card
      ref={profileRef}
      id={id}
      data-result-set-id={row.resultSetId}
      role="region"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="border-sky-500/30 bg-sky-500/[0.025] outline-none focus-visible:ring-2 focus-visible:ring-sky-500/50"
    >
      <CardHeader className="min-w-0 flex-row items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.12em] text-sky-600 dark:text-sky-400">
            Evidence profile
          </p>
          <CardTitle id={titleId} className="mt-1 min-w-0 break-words text-xl">
            {sanitizeBenchmarkDisplayText(row.label)}
          </CardTitle>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {row.isTeam && <Badge variant="secondary">Team</Badge>}
            {row.preliminary && <Badge variant="outline">Preliminary</Badge>}
            {(row.providerIds ?? []).map((provider) => (
              <Badge key={provider} variant="outline">
                {provider}
              </Badge>
            ))}
            {row.isTeam && (row.reasoningEffortDetails?.length ?? 0) > 0 ? (
              <VariantRosterBadges details={row.reasoningEffortDetails} />
            ) : (
              (row.reasoningEfforts ?? []).map((effort) => (
                <Badge key={effort} variant="outline">
                  {benchmarkVariantLabel("Reasoning", effort)}
                </Badge>
              ))
            )}
          </div>
          {row.completedAt && (
            <p className="mt-2 text-xs text-muted-foreground">
              Completed{" "}
              {new Intl.DateTimeFormat(undefined, {
                dateStyle: "medium",
                timeStyle: "short",
              }).format(new Date(row.completedAt))}
            </p>
          )}
        </div>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="shrink-0"
          onClick={onClose}
          aria-label="Close evidence profile"
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <ProfileMetric
            label="Overall index"
            value={formatMaybeScore(row.overallScore)}
          />
          <ProfileMetric
            label="Verified pass rate"
            value={formatPercent(row.passRate)}
            detail={
              interval
                ? `95% range ${formatPercent(interval.lower)}–${formatPercent(interval.upper)}`
                : "Not measured"
            }
          />
          <ProfileMetric
            label="Tool reliability"
            value={formatPointMetric(row.toolReliabilityScore)}
          />
          <ProfileMetric label="Efficiency" value={formatPointMetric(row.efficiencyScore)} />
          <ProfileMetric label="Tokens per pass" value={formatCount(row.tokensPerPass)} />
          <ProfileMetric label="Time per pass" value={formatDuration(row.speedPerPassMs)} />
        </div>

        <section>
          <div className="mb-2 flex items-baseline justify-between gap-3">
            <h4 className="text-sm font-semibold">Track coverage</h4>
            <span className="text-xs text-muted-foreground">
              {row.tracks.length} represented track
              {row.tracks.length === 1 ? "" : "s"} ·{" "}
              {failedAttempts == null
                ? "Failed attempts not measured"
                : `${failedAttempts} failed attempt${failedAttempts === 1 ? "" : "s"}`}
            </span>
          </div>
          <p className="mb-3 text-xs leading-relaxed text-muted-foreground">
            Certified Index v1.0 averages these per-track scores with equal weight. Missing tracks
            are not scored as zero.
          </p>
          <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
            {row.trackBreakdown.map((track) => {
              const budgetFailures = budgetFailureCount(row, track.track);
              return (
                <div key={track.track} className="rounded-lg border bg-background/80 p-3">
                  <div className="text-xs font-medium text-muted-foreground">
                    {trackLabel(track.track)}
                  </div>
                  <div className="mt-1 text-lg font-semibold tabular-nums">
                    {formatMaybeScore(track.averageVerifiedQuality)}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {track.passed == null && track.verifiedPassRate == null
                      ? `${track.attempts} attempt${track.attempts === 1 ? "" : "s"} \u00b7 Pass evidence unavailable`
                      : track.verifiedPassRate == null
                        ? `${track.passed} of ${track.attempts} passed`
                        : `${track.passed ?? Math.round(track.verifiedPassRate * track.attempts)} of ${track.attempts} passed · ${formatPercent(track.verifiedPassRate)}`}
                  </div>
                  <div className="mt-1 text-xs text-muted-foreground">
                    {budgetFailures} budget failure
                    {budgetFailures === 1 ? "" : "s"}
                  </div>
                </div>
              );
            })}
          </div>
          {failureMessages.length > 0 && (
            <div className="mt-3 border-l-2 border-red-500/50 bg-red-500/[0.04] px-3 py-2">
              <h5 className="text-xs font-semibold text-red-700 dark:text-red-300">
                Certified failures
              </h5>
              <ul className="mt-1 space-y-1 text-xs leading-relaxed text-muted-foreground">
                {failureMessages.map((message) => (
                  <li key={message}>{message}</li>
                ))}
              </ul>
            </div>
          )}
        </section>

        <section>
          <h4 className="text-sm font-semibold">Evaluated cases</h4>
          {row.caseTitles.length > 0 ? (
            <ul className="mt-2 grid gap-1.5 text-sm text-muted-foreground md:grid-cols-2">
              {row.caseTitles.map((title) => (
                <li key={title} className="rounded-md border bg-background/60 px-3 py-2">
                  {title}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-2 text-sm text-muted-foreground">
              Case titles are unavailable in this imported evidence.
            </p>
          )}
        </section>

        <p className="border-t pt-3 text-xs leading-relaxed text-muted-foreground">
          {row.preliminary
            ? "Treat this ranking as directional: it has fewer than three scored attempts and a wide evidence range is likely."
            : "This result meets the minimum evidence threshold. The 95% range still describes sampling uncertainty; inspect Audit evidence for verifier and failure details."}
        </p>
      </CardContent>
    </Card>
  );
}

function ProfileMetric({
  label,
  value,
  detail
}: {
  label: string;
  value: string;
  detail?: string;
}) {
  return (
    <div className="rounded-lg border bg-background/80 p-3">
      <div className="text-xs font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {detail && <div className="mt-0.5 text-[11px] text-muted-foreground">{detail}</div>}
    </div>
  );
}

function derivedPasses(row: DecisionRow): number | null {
  if (row.passed != null) return row.passed;
  if (row.passRate == null) return null;
  return Math.round(row.passRate * row.attempts);
}

function formatMaybeScore(value: number | null): string {
  return value == null ? "Unavailable" : formatNormalizedScore(value);
}

function formatPointMetric(value: number | null): string {
  return value == null ? "Unavailable" : formatPointScore(value);
}

function formatPercent(value: number | null): string {
  return value == null ? "Unavailable" : `${Math.round(value * 100)}%`;
}

function formatCount(value: number | null): string {
  return value == null ? "Unavailable" : Math.round(value).toLocaleString();
}

function formatDuration(milliseconds: number | null): string {
  if (milliseconds == null) return "Unavailable";
  const seconds = milliseconds / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}

function trackLabel(track: string): string {
  if (track === "gameiq") return "GameIQ";
  if (track === "teamiq") return "TeamIQ";
  if (track === "workbench") return "WorkBench";
  if (track === "toolreliability") return "Tool Reliability";
  if (track === "harnessbench") return "HarnessBench";
  return track;
}

function budgetFailureCount(row: DecisionRow, track: string): number {
  const attemptIds = new Set(
    row.failureDetails
      .filter((detail) => detail.track === track && detail.status === "failed_budget")
      .map((detail) => detail.attemptId)
  );
  const latest = row.latestAttemptsByTrack[track];
  if (latest?.status === "failed_budget") attemptIds.add(latest.id);
  return attemptIds.size;
}

function failedAttemptCount(row: DecisionRow): number | null {
  if (row.failedAttemptCount != null) {
    return Math.max(0, row.failedAttemptCount);
  }
  const passed = derivedPasses(row);
  const aggregateFailures =
    passed == null ? null : Math.max(0, row.attempts - passed);
  const attemptIds = new Set(
    row.failureDetails.map((detail) => detail.attemptId)
  );
  for (const latest of Object.values(row.latestAttemptsByTrack)) {
    if (latest.status !== "passed") attemptIds.add(latest.id);
  }
  if (aggregateFailures == null) {
    return attemptIds.size > 0 ? attemptIds.size : null;
  }
  return Math.max(aggregateFailures, attemptIds.size);
}

function certifiedFailureMessages(row: DecisionRow): string[] {
  const messages = new Set(
    row.failureDetails
      .map((detail) => detail.message.trim())
      .filter((message) => message.length > 0)
  );
  const hasPersistedBudgetMessage = row.failureDetails.some(
    (detail) =>
      detail.status === "failed_budget" &&
      detail.message.trim().length > 0 &&
      (!row.latestAttemptId || detail.attemptId === row.latestAttemptId)
  );
  if (row.latestAttemptStatus === "failed_budget" && !hasPersistedBudgetMessage) {
    messages.add("Certified budget exhausted before this track completed.");
  }
  return Array.from(messages);
}
