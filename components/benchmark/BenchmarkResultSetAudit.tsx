"use client";

import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { redactAbsoluteLocalPaths, redactKnownSecrets } from "@/lib/benchmark/redaction";
import type { BenchmarkAttemptV2, BenchmarkResultSet } from "@/lib/benchmark/types";

export type BenchmarkResultSetAuditStatus =
  | "Published"
  | "Running"
  | "Provider failed"
  | "Cancelled"
  | "Interrupted"
  | "Deleting"
  | "Legacy evidence";

export interface BenchmarkResultSetAuditRow {
  id: string;
  resultSet: BenchmarkResultSet | null;
  statusLabel: BenchmarkResultSetAuditStatus;
  subject: string;
  configuration: string;
  tracks: string[];
  createdAt: string | null;
  terminalAt: string | null;
  physicalCalls: number;
  totalTokens: number;
  failureMessage: string;
  canDelete: boolean;
}

export function buildBenchmarkResultSetAuditRows(
  resultSets: readonly BenchmarkResultSet[],
  attempts: readonly BenchmarkAttemptV2[]
): BenchmarkResultSetAuditRow[] {
  const attemptsByResultSet = new Map<string, BenchmarkAttemptV2[]>();
  const legacyAttempts: BenchmarkAttemptV2[] = [];
  for (const attempt of attempts) {
    if (!attempt.resultSetId) {
      if (attempt.mode === "certified") legacyAttempts.push(attempt);
      continue;
    }
    const owned = attemptsByResultSet.get(attempt.resultSetId) ?? [];
    owned.push(attempt);
    attemptsByResultSet.set(attempt.resultSetId, owned);
  }
  const rows = resultSets.map((resultSet): BenchmarkResultSetAuditRow => {
    const owned = attemptsByResultSet.get(resultSet.id) ?? [];
    return {
      id: resultSet.id,
      resultSet,
      statusLabel: auditStatus(resultSet),
      subject: resultSet.configuration.displayName,
      configuration: configurationLabel(resultSet),
      tracks: resultSet.configuration.tracks.map((track) => trackLabel(track.track)),
      createdAt: resultSet.createdAt,
      terminalAt:
        resultSet.completedAt ?? resultSet.terminalAt ?? null,
      physicalCalls: owned.reduce((sum, attempt) => sum + attempt.modelCalls, 0),
      totalTokens:
        owned.length > 0
          ? owned.reduce(
              (sum, attempt) => sum + attempt.inputTokens + attempt.outputTokens,
              0
            )
          : resultSet.metrics?.totalTokens ?? 0,
      failureMessage: sanitizeAuditText(resultSet.failure?.message ?? ""),
      canDelete: resultSet.status !== "deleting",
    };
  });
  if (legacyAttempts.length > 0) {
    rows.push({
      id: "legacy-evidence",
      resultSet: null,
      statusLabel: "Legacy evidence",
      subject: `${legacyAttempts.length} unmanifested certified attempt${
        legacyAttempts.length === 1 ? "" : "s"
      }`,
      configuration: "No trustworthy snapshot boundary",
      tracks: Array.from(new Set(legacyAttempts.map((attempt) => trackLabel(attempt.track)))),
      createdAt: minDate(legacyAttempts.map((attempt) => attempt.startedAt)),
      terminalAt: maxDate(
        legacyAttempts.flatMap((attempt) =>
          attempt.completedAt ? [attempt.completedAt] : []
        )
      ),
      physicalCalls: legacyAttempts.reduce(
        (sum, attempt) => sum + attempt.modelCalls,
        0
      ),
      totalTokens: legacyAttempts.reduce(
        (sum, attempt) => sum + attempt.inputTokens + attempt.outputTokens,
        0
      ),
      failureMessage: "",
      canDelete: false,
    });
  }
  return rows;
}

export function latestCompletedResultSetIds(
  rows: readonly BenchmarkResultSetAuditRow[]
): ReadonlySet<string> {
  const latestByConfiguration = new Map<string, BenchmarkResultSet>();
  for (const row of rows) {
    const resultSet = row.resultSet;
    if (resultSet?.status !== "completed" || !resultSet.completedAt) continue;
    const current = latestByConfiguration.get(resultSet.configurationKey);
    if (
      !current ||
      Date.parse(resultSet.completedAt) > Date.parse(current.completedAt ?? "") ||
      (resultSet.completedAt === current.completedAt &&
        resultSet.id.localeCompare(current.id) > 0)
    ) {
      latestByConfiguration.set(resultSet.configurationKey, resultSet);
    }
  }
  return new Set(
    [...latestByConfiguration.values()].map((resultSet) => resultSet.id)
  );
}

export function BenchmarkResultSetAudit({
  rows,
  deletingIds,
  deleteInFlight,
  onDelete,
}: {
  rows: readonly BenchmarkResultSetAuditRow[];
  deletingIds: ReadonlySet<string>;
  deleteInFlight: boolean;
  onDelete: (resultSet: BenchmarkResultSet, label: string) => void;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Result-set audit</CardTitle>
        <CardDescription>
          Published and incomplete snapshots stay separate. Usage includes physical provider calls, including retries.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">No result-set evidence is stored.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {rows.map((row) => (
              <li key={row.id} className="grid gap-3 p-4 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_auto]">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="rounded-sm border px-2 py-0.5 text-xs font-medium">
                      {row.statusLabel}
                    </span>
                    <span className="break-words font-medium">{row.subject}</span>
                  </div>
                  <p className="mt-1 break-words text-xs text-muted-foreground">
                    {row.configuration}
                  </p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Promised tracks: {row.tracks.join(", ") || "Unavailable"}
                  </p>
                  {row.failureMessage && (
                    <p className="mt-2 break-words text-xs text-rose-700 dark:text-rose-300">
                      {row.failureMessage}
                    </p>
                  )}
                </div>
                <dl className="grid grid-cols-2 gap-2 text-xs">
                  <AuditMetric label="Created" value={formatAuditDate(row.createdAt)} />
                  <AuditMetric label="Terminal" value={formatAuditDate(row.terminalAt)} />
                  <AuditMetric label="Physical calls" value={row.physicalCalls.toLocaleString()} />
                  <AuditMetric label="Tokens" value={row.totalTokens.toLocaleString()} />
                </dl>
                <div className="self-center">
                  {row.canDelete && row.resultSet ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={deleteInFlight || deletingIds.has(row.resultSet.id)}
                      data-focus-return={`audit:${row.resultSet.configurationKey}`}
                      onClick={() => onDelete(row.resultSet!, row.subject)}
                    >
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                      Delete snapshot
                    </Button>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {row.statusLabel === "Legacy evidence"
                        ? "Use clear all to remove"
                        : "Deletion in progress"}
                    </span>
                  )}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function AuditMetric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-words font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function auditStatus(resultSet: BenchmarkResultSet): BenchmarkResultSetAuditStatus {
  if (resultSet.status === "completed") return "Published";
  if (resultSet.status === "pending") return "Running";
  if (resultSet.status === "cancelled") return "Cancelled";
  if (resultSet.status === "deleting") return "Deleting";
  const kind = resultSet.failure?.kind.toLowerCase() ?? "";
  const code = resultSet.failure?.code.toLowerCase() ?? "";
  if (
    kind === "interrupted" ||
    kind === "stale_pending" ||
    code === "interrupted" ||
    code === "stale_pending"
  ) {
    return "Interrupted";
  }
  return "Provider failed";
}

function configurationLabel(resultSet: BenchmarkResultSet): string {
  const configuration = resultSet.configuration;
  const identity =
    configuration.subjectKind === "team"
      ? `${configuration.strategy ?? "team"} · ${configuration.roles
          .map((role) => `${role.role}: ${role.modelId} · ${role.reasoningEffort}`)
          .join(", ")}`
      : `${configuration.providerId ?? "provider"} · ${
          configuration.modelId ?? configuration.displayName
        } · ${configuration.reasoningEffort ?? "default"} reasoning`;
  return sanitizeAuditText(identity);
}

function sanitizeAuditText(value: string): string {
  return redactAbsoluteLocalPaths(redactKnownSecrets(value));
}

function trackLabel(track: string): string {
  if (track === "gameiq") return "GameIQ";
  if (track === "teamiq") return "TeamIQ";
  if (track === "workbench") return "WorkBench";
  if (track === "toolreliability") return "Tool Reliability";
  if (track === "harnessbench") return "HarnessBench";
  return track;
}

function formatAuditDate(value: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "—";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function minDate(values: string[]): string | null {
  return values
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
}

function maxDate(values: string[]): string | null {
  return values
    .filter((value) => Number.isFinite(Date.parse(value)))
    .sort((left, right) => Date.parse(right) - Date.parse(left))[0] ?? null;
}
