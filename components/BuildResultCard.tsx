"use client";

import { useMemo, useState } from "react";
import { extractArtifacts } from "@/lib/artifacts/extract";
import { Markdown } from "@/components/Markdown";
import { ArtifactPanel } from "@/components/ArtifactPanel";
import { ConfidenceRing } from "@/components/ConfidenceRing";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Check, Copy, Hammer } from "lucide-react";

interface BuildResultCardProps {
  answer: string;
  confidence: number;
  dissent: string[];
  topic: string;
}

export function BuildResultCard({
  answer,
  confidence,
  dissent,
}: BuildResultCardProps) {
  const { files, prose } = useMemo(() => extractArtifacts(answer), [answer]);
  const [copied, setCopied] = useState(false);

  const copySummary = async () => {
    await navigator.clipboard.writeText(prose || answer);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div className="space-y-5">
      <section className="relative scroll-mt-6 overflow-hidden rounded-2xl border border-indigo-300/60 bg-gradient-to-br from-indigo-50/80 via-card to-card shadow-md dark:border-indigo-900/60 dark:from-indigo-950/30">
        <div
          className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-indigo-400/15 blur-3xl"
          aria-hidden
        />

        <div className="relative flex flex-wrap items-start justify-between gap-4 border-b border-indigo-200/60 p-6 dark:border-indigo-900/50">
          <div className="flex items-start gap-4">
            <ConfidenceRing value={confidence} />
            <div>
              <p className="font-mono text-[0.7rem] font-semibold uppercase tracking-[0.2em] text-indigo-700 dark:text-indigo-400">
                Build complete
              </p>
              <h2 className="mt-1 flex items-center gap-2 font-display text-2xl font-semibold tracking-tight">
                <Hammer className="h-5 w-5 text-indigo-600 dark:text-indigo-400" />
                Project
              </h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {files.length > 0
                  ? `${files.length} file${files.length === 1 ? "" : "s"} assembled by the integrator.`
                  : "Integrator summary from the collaborative build."}
              </p>
            </div>
          </div>
          <Button variant="outline" size="sm" onClick={copySummary}>
            {copied ? (
              <Check className="mr-1 h-4 w-4 text-emerald-600" />
            ) : (
              <Copy className="mr-1 h-4 w-4" />
            )}
            {copied ? "Copied" : "Copy notes"}
          </Button>
        </div>

        {prose.trim() && (
          <div className="relative p-6">
            <Markdown content={prose} />

            {dissent.length > 0 && (
              <div className="mt-6 rounded-xl border border-amber-200/70 bg-amber-50/60 p-4 dark:border-amber-900/50 dark:bg-amber-950/20">
                <h3 className="flex items-center gap-2 font-display text-sm font-semibold text-amber-900 dark:text-amber-200">
                  <AlertTriangle className="h-4 w-4" />
                  Open questions
                </h3>
                <ul className="mt-2 space-y-1.5 text-sm text-amber-900/90 dark:text-amber-100/80">
                  {dissent.map((item, i) => (
                    <li key={i} className="flex gap-2">
                      <span className="mt-[0.45rem] h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </section>

      <ArtifactPanel files={files} />

      {files.length === 0 && (
        <p className="rounded-lg border border-dashed bg-card/50 px-4 py-3 text-sm text-muted-foreground">
          No files were detected in the final output. The models may have
          described the project without emitting file blocks — try Build mode
          again, or a higher effort level, for a complete file set.
        </p>
      )}
    </div>
  );
}
