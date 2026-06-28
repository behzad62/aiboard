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
        toolCalls: getBenchmarkToolCallTraces(),
        artifacts: getBenchmarkArtifacts(),
        failures: getBenchmarkFailures(),
      }),
    [summary]
  );

  if (!summary || !detail) return null;
  const { attempt, caseRecord, team, verifier } = detail;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Latest certified run</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4 text-sm">
        <div className="grid gap-2 sm:grid-cols-3">
          <Detail label="Run" value={summary.runId} />
          <Detail label="Attempt" value={attempt.id} />
          <Detail label="Status" value={attempt.status} />
          <Detail label="Verified quality" value={formatPercent(attempt.verifiedQuality)} />
          <Detail label="Cost" value={formatCost(attempt.costUsd)} />
          <Detail label="Time" value={formatDuration(attempt.durationMs)} />
        </div>

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
                <div className="text-xs text-muted-foreground">{role.providerId}:{role.modelId}</div>
              </div>
            ))}
          </div>
        </Section>

        <Section title="Verifier assertions">
          <VerifierAssertionTable verifier={verifier} />
        </Section>

        <Section title="Traces">
          <div className="grid gap-2 md:grid-cols-2">
            <TraceList
              title="Model calls"
              rows={detail.modelTraces.map((trace) => ({
                id: trace.id,
                label: trace.participantId ?? trace.modelId,
                meta: `${trace.providerId} - ${trace.inputTokens ?? 0}/${trace.outputTokens ?? 0} tokens`,
              }))}
            />
            <TraceList
              title="Tool calls"
              rows={detail.toolCalls.map((trace) => ({
                id: trace.id,
                label: trace.toolName,
                meta: `${trace.status}${trace.command ? ` - ${trace.command}` : ""}`,
              }))}
            />
          </div>
        </Section>

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
  rows: Array<{ id: string; label: string; meta: string }>;
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
          </div>
        ))
      )}
    </div>
  );
}

function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function formatCost(value: number | null): string {
  return value == null ? "Unknown" : `$${value.toFixed(4)}`;
}

function formatDuration(value: number): string {
  return `${(value / 1000).toFixed(1)}s`;
}
