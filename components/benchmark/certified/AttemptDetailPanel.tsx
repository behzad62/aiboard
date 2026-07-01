"use client";

import { useMemo, type ReactNode } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { buildAttemptDetailViewModel } from "@/lib/benchmark/certified/attempt-detail";
import type { CertifiedRunSummary } from "@/lib/benchmark/certified/run-status";
import {
  getBenchmarkArtifacts,
  getBenchmarkAttemptsV2,
  getBenchmarkCaseV2,
  getBenchmarkFailures,
  getBenchmarkTeamCompositions,
  getBenchmarkToolCallTraces,
  getBenchmarkTraces,
  getBenchmarkVerifierResults,
} from "@/lib/client/store";
import { FireworksBenchmarkSummary } from "@/components/benchmark/fireworks/FireworksBenchmarkSummary";
import { formatScore } from "@/components/benchmark/format";
import { VerifierAssertionTable } from "./VerifierAssertionTable";

export function AttemptDetailPanel({
  summary,
}: {
  summary: CertifiedRunSummary | null;
}) {
  const detail = useMemo(
    () =>
      buildAttemptDetailViewModel({
        summary,
        cases: getBenchmarkCaseV2(),
        attempts: getBenchmarkAttemptsV2(),
        teams: getBenchmarkTeamCompositions(),
        verifiers: getBenchmarkVerifierResults(),
        traces: getBenchmarkTraces(),
        runEvents: [],
        toolCalls: getBenchmarkToolCallTraces(),
        artifacts: getBenchmarkArtifacts(),
        failures: getBenchmarkFailures(),
      }),
    [summary]
  );

  if (!summary || !detail) return null;
  const { attempt, caseRecord, team, verifier } = detail;
  const toolRel = detail.toolReliabilityDiagnostics;
  const visibleFailedCases = toolRel?.failedCases.slice(0, 8) ?? [];

  return (
    <Card>
      <CardHeader>
        <CardTitle>Latest certified run</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-2 sm:grid-cols-3">
          <Detail label="Run" value={summary.runId} />
          <Detail label="Attempt" value={attempt.id} />
          <Detail label="Outcome" value={detail.summary.outcomeLabel} />
          <Detail label="Score use" value={detail.summary.scoreUseLabel} />
          <Detail label="Verifier" value={detail.summary.verifierOutcomeLabel} />
          <Detail label="Model calls" value={String(detail.summary.modelCallCount)} />
          <Detail label="Tool calls" value={String(detail.summary.toolCallCount)} />
          <Detail label="Budget usage" value={detail.summary.budgetUsageLabel} />
          <Detail
            label="Verifier failures"
            value={String(detail.summary.assertionFailureCount)}
          />
          <Detail label="Failures" value={String(detail.summary.failureCount)} />
          <Detail label="Verified quality" value={formatScore(attempt.verifiedQuality)} />
          <Detail label="Cost" value={formatCost(attempt.costUsd)} />
          <Detail label="Time" value={formatDuration(attempt.durationMs)} />
        </div>
        <p className="rounded-md border bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
          {detail.summary.scoreUseExplanation}
        </p>

        <Section title="Case manifest">
          <div className="space-y-1">
            <p className="font-medium">{caseRecord?.title ?? attempt.caseId}</p>
            <p className="text-muted-foreground">{caseRecord?.description ?? "No case manifest found."}</p>
            {caseRecord && (
              <dl className="grid gap-1 text-xs text-muted-foreground">
                <Row label="Prompt" value={caseRecord.prompt.userRequest} />
                <Row label="Context" value={caseRecord.prompt.publicContext ?? "None"} />
                <Row label="Canary" value={caseRecord.contamination.canary} />
                <Row label="Verifier" value={caseRecord.verifier.command ?? caseRecord.verifier.scorer} />
              </dl>
            )}
          </div>
        </Section>

        <Section title="Team composition">
          <p className="font-medium">{team?.name ?? attempt.teamCompositionId}</p>
          <div className="mt-2 grid gap-2">
            {(team?.roles ?? []).map((role) => (
              <div key={`${role.slot}:${role.modelId}`} className="rounded-md border px-3 py-2">
                <div className="font-medium">{role.role} - {role.displayName}</div>
                <div className="text-xs text-muted-foreground">
                  {formatRoleModelId(role)}
                </div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Verifier assertions">
          <VerifierAssertionTable verifier={verifier} />
        </Section>

        {toolRel ? (
          <Section title="ToolReliability diagnosis">
            <div className="grid gap-2 md:grid-cols-4">
              {toolRel.accountabilityRows.map((row) => (
                <Detail key={row.accountability} label={row.label} value={String(row.count)} />
              ))}
            </div>
            <div className="grid gap-2 md:grid-cols-2">
              <TraceList
                title="Failure categories"
                rows={toolRel.categoryRows.map((row) => ({
                  id: row.category,
                  label: row.label,
                  meta: `${row.failed} failed of ${row.total}`,
                }))}
                empty="No category diagnostics."
              />
              <TraceList
                title="Top reasons"
                rows={toolRel.topReasons.slice(0, 6).map((row, index) => ({
                  id: `${index}:${row.reason}`,
                  label: row.reason,
                  meta: `${row.count} case${row.count === 1 ? "" : "s"}`,
                }))}
                empty="No repeated failure reasons."
              />
            </div>
            <div className="space-y-2">
              <div className="font-medium">Failed cases</div>
              {visibleFailedCases.length === 0 ? (
                <p className="text-xs text-muted-foreground">No failed case diagnostics.</p>
              ) : (
                <>
                  {visibleFailedCases.map((item) => (
                    <div key={item.caseId} className="rounded-md border px-3 py-2">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium">{item.caseId}</span>
                        <span className="text-xs text-muted-foreground">{item.categoryLabel}</span>
                        <span className="text-xs text-muted-foreground">{item.accountabilityLabel}</span>
                      </div>
                      <div className="mt-1 text-sm">{item.reason}</div>
                      <div className="mt-1 text-xs text-muted-foreground">{item.evidence}</div>
                      {item.modelResponses.length > 0 ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                            Model response ({item.modelResponses.length})
                          </summary>
                          <div className="mt-2 space-y-2">
                            {item.modelResponses.map((response) => (
                              <pre
                                key={response.id}
                                className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-xs"
                              >
                                {[
                                  response.meta,
                                  response.error ? `Error\n${response.error}` : "",
                                  response.rawResponsePreview
                                    ? `Raw response\n${response.rawResponsePreview}`
                                    : "",
                                  response.parsedResponsePreview
                                    ? `Parsed response\n${response.parsedResponsePreview}`
                                    : "",
                                ]
                                  .filter(Boolean)
                                  .join("\n\n")}
                              </pre>
                            ))}
                          </div>
                        </details>
                      ) : null}
                      {item.verifierEvents.length > 0 ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                            Verifier evidence ({item.verifierEvents.length})
                          </summary>
                          <div className="mt-2 space-y-2">
                            {item.verifierEvents.map((event) => (
                              <pre
                                key={event.id}
                                className="max-h-56 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-xs"
                              >
                                {[event.label, event.status, event.detail]
                                  .filter(Boolean)
                                  .join("\n\n")}
                              </pre>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  ))}
                  {toolRel.failedCases.length > visibleFailedCases.length ? (
                    <p className="text-xs text-muted-foreground">
                      Showing {visibleFailedCases.length} of {toolRel.failedCases.length} failed cases.
                    </p>
                  ) : null}
                </>
              )}
            </div>
          </Section>
        ) : null}

        {detail.artifacts.some((artifact) =>
          artifact.id.endsWith(":fireworks-summary")
        ) && (
          <Section title="Fireworks TeamIQ">
            <FireworksBenchmarkSummary
              attempt={attempt}
              artifacts={detail.artifacts}
            />
          </Section>
        )}

        {detail.patchArtifacts.length > 0 && (
          <Section title="Patch diff">
            <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/40 p-3 text-xs">
              {detail.patchArtifacts[0].content}
            </pre>
          </Section>
        )}

        <Section title="Artifacts and failures">
          <div className="grid gap-2 md:grid-cols-2">
            <TraceList
              title="Artifacts"
              rows={detail.artifacts.map((artifact) => ({
                id: artifact.id,
                label: artifact.label,
                meta: `${artifact.kind} - ${artifact.mimeType}`,
              }))}
            />
            <TraceList
              title="Failures"
              rows={detail.failures.map((failure) => ({
                id: failure.id,
                label: `${failure.source}:${failure.code}`,
                meta: failure.message,
              }))}
              empty="No classified failures."
            />
          </div>
        </Section>

        <Section title="Versions">
          <div className="grid gap-2 sm:grid-cols-3">
            <Detail label="Harness" value={detail.versions.harnessVersion} />
            <Detail label="Prompts" value={detail.versions.promptSetVersion} />
            <Detail label="Scoring" value={detail.versions.scoringVersion} />
          </div>
        </Section>
      </CardContent>
    </Card>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-2 border-t pt-3 first:border-t-0 first:pt-0">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 truncate font-medium">{value}</div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[90px_1fr]">
      <dt className="font-medium text-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </div>
  );
}

function TraceList({
  title,
  rows,
  empty = "No records.",
}: {
  title: string;
  rows: Array<{ id: string; label: string; meta: string; detail?: string }>;
  empty?: string;
}) {
  return (
    <div className="space-y-2">
      <div className="font-medium">{title}</div>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground">{empty}</p>
      ) : (
        rows.map((row) => (
          <div key={row.id} className="rounded-md border px-3 py-2">
            <div className="truncate font-medium">{row.label}</div>
            <div className="mt-1 break-words text-xs text-muted-foreground">{row.meta}</div>
            {row.detail ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
                  Response
                </summary>
                <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted/40 p-2 text-xs">
                  {row.detail}
                </pre>
              </details>
            ) : null}
          </div>
        ))
      )}
    </div>
  );
}

function formatCost(value: number | null): string {
  return value == null ? "Unknown" : `$${value.toFixed(4)}`;
}

function formatDuration(value: number): string {
  return `${(value / 1000).toFixed(1)}s`;
}

function formatRoleModelId(role: { providerId: string; modelId: string }): string {
  return role.modelId.startsWith(`${role.providerId}:`)
    ? role.modelId
    : `${role.providerId}:${role.modelId}`;
}
