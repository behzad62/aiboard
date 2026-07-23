"use client";

import {
  Feather,
  Gauge,
  ShieldCheck,
  Sparkles,
  Timer,
  Users,
  type LucideIcon,
} from "lucide-react";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  formatNormalizedScore,
  formatScore,
} from "@/components/benchmark/format";
import {
  buildDecisionVerdicts,
  type DecisionRow,
  type DecisionVerdict,
  type DecisionVerdictKey,
} from "@/lib/benchmark/certified/decision-dashboard";

const CARD_META: Record<
  DecisionVerdictKey,
  { label: string; icon: LucideIcon; accent: string; bar: string }
> = {
  overall: {
    label: "Best overall model",
    icon: Sparkles,
    accent: "text-emerald-600 dark:text-emerald-400",
    bar: "bg-emerald-500",
  },
  workbench: {
    label: "Best WorkBench model",
    icon: Gauge,
    accent: "text-violet-600 dark:text-violet-400",
    bar: "bg-violet-500",
  },
  reliability: {
    label: "Most reliable",
    icon: ShieldCheck,
    accent: "text-sky-600 dark:text-sky-400",
    bar: "bg-sky-500",
  },
  leanest: {
    label: "Leanest successful model",
    icon: Feather,
    accent: "text-cyan-600 dark:text-cyan-400",
    bar: "bg-cyan-500",
  },
  fastest: {
    label: "Fastest successful model",
    icon: Timer,
    accent: "text-amber-600 dark:text-amber-400",
    bar: "bg-amber-500",
  },
  teamLift: {
    label: "Best team lift",
    icon: Users,
    accent: "text-rose-600 dark:text-rose-400",
    bar: "bg-rose-500",
  },
};

export function DecisionVerdicts({ rows }: { rows: DecisionRow[] }) {
  const verdicts = buildDecisionVerdicts(rows);
  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
      {verdicts.map((verdict) => (
        <VerdictCard key={verdict.key} verdict={verdict} />
      ))}
    </div>
  );
}

function VerdictCard({ verdict }: { verdict: DecisionVerdict }) {
  const meta = CARD_META[verdict.key];
  const Icon = meta.icon;
  return (
    <Card className="relative overflow-hidden">
      <div
        className={`absolute inset-y-0 left-0 w-1 ${meta.bar}`}
        aria-hidden="true"
      />
      <CardHeader className="flex-row items-center justify-between gap-3 pb-2">
        <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">
          {meta.label}
        </p>
        <Icon className={`h-4 w-4 ${meta.accent}`} aria-hidden="true" />
      </CardHeader>
      <CardContent className="space-y-1.5">
        <div className="truncate text-lg font-semibold">
          {verdict.winner?.label ?? "Not measured yet"}
        </div>
        {verdict.winner ? (
          <p className="text-xs leading-relaxed text-muted-foreground">
            <span className={`font-semibold ${meta.accent}`}>
              {formatVerdictMetric(verdict)}
            </span>
            {" · "}
            {formatEvidence(verdict)}
            {verdict.preliminary ? " · preliminary evidence" : ""}
          </p>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {verdict.emptyHint}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function formatEvidence(verdict: DecisionVerdict): string {
  if (verdict.evidenceCount == null) {
    return "supporting sample count unavailable";
  }
  return `${verdict.evidenceCount} ${verdict.evidenceLabel}${
    verdict.evidenceCount === 1 ? "" : "s"
  }`;
}

function formatVerdictMetric(verdict: DecisionVerdict): string {
  if (verdict.metric == null) return "Unavailable";
  if (verdict.key === "overall" || verdict.key === "workbench") {
    return `${formatNormalizedScore(verdict.metric)} quality`;
  }
  if (verdict.key === "reliability") {
    return `${formatScore(verdict.metric)} reliability`;
  }
  if (verdict.key === "leanest") {
    return `${Math.round(verdict.metric).toLocaleString()} tokens/pass`;
  }
  if (verdict.key === "fastest") {
    return `${formatSeconds(verdict.metric)} per pass`;
  }
  return `${verdict.metric >= 0 ? "+" : ""}${verdict.metric.toFixed(1)} lift`;
}

function formatSeconds(milliseconds: number): string {
  const seconds = milliseconds / 1000;
  return `${seconds >= 10 ? seconds.toFixed(0) : seconds.toFixed(1)}s`;
}
